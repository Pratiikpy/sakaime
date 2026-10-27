/**
 * Turns the bytes of a bounded probe into a flat table: one row per record, one column per field path.
 *
 * Supported shapes: CSV and other delimited text, a JSON array of objects, a JSON object holding such an array
 * (openFDA `results`, ClinicalTrials.gov `studies`, and similar), and newline-delimited JSON. Nested objects are
 * flattened to dotted paths and arrays of scalars are joined, so a column is always one scalar per record.
 *
 * A response cut off mid-record is reported as TRUNCATED and never returned as a smaller table: a table that
 * silently lost its tail would pass every value check.
 */
import { parse as parseCsv } from "csv-parse/sync";
import { PortError } from "../ports/index.ts";
import { sha256Hex } from "../util/canonical.ts";
import { isNullToken, type Cell } from "./values.ts";

export type SourceFormat = "csv" | "json" | "ndjson";

export interface ProbeTable {
  format: SourceFormat;
  /** Field paths in first-seen order. */
  columns: string[];
  rows: Record<string, Cell>[];
  /** Total record count the source declares (openFDA meta.results.total, ctgov totalCount), when it declares one. */
  declaredTotal?: number;
  /** Where the records sit in a JSON document, for the report. */
  container?: string;
  bytes: number;
  sha256: string;
  notes: string[];
  /** Delimited text: the last record ends with a line break, as a complete export does. A cut-off file usually does not. */
  terminated?: boolean;
}

const CONTAINER_KEYS = ["results", "studies", "data", "records", "items", "rows", "entries", "hits", "docs", "content", "features", "response"];
const TOTAL_PATHS = [
  ["meta", "results", "total"],
  ["totalCount"],
  ["total_count"],
  ["total"],
  ["count"],
  ["hitCount"],
  ["recordsTotal"],
  ["numFound"],
  ["meta", "total"],
  ["meta", "total_count"],
  ["response", "numFound"],
];
const MAX_COLUMNS = 300;
const MAX_DEPTH = 6;
const MAX_CELL = 20_000;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function decode(bytes: Uint8Array): string {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new PortError("INVALID", "the response is not valid UTF-8 text; a lossy decode would alter values, so it is refused", { reason: "ENCODING" });
  }
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

function scalar(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v.length > MAX_CELL ? v.slice(0, MAX_CELL) : v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  return JSON.stringify(v).slice(0, MAX_CELL);
}

/** Flattens one record into path -> scalar. Arrays of objects contribute `path[].key` columns joined with " | ". */
export function flatten(record: Record<string, unknown>): Record<string, Cell> {
  const out: Record<string, Cell> = {};
  const put = (path: string, value: Cell): void => {
    if (path in out) {
      const prior = out[path];
      out[path] = prior === null || prior === undefined ? value : value === null ? prior : `${prior} | ${value}`;
    } else out[path] = value;
  };
  const visit = (node: unknown, path: string, depth: number): void => {
    if (Array.isArray(node)) {
      if (node.every((x) => x === null || typeof x !== "object")) {
        put(path, node.length === 0 ? null : node.map((x) => (x === null ? "" : String(x))).join(" | "));
        return;
      }
      for (const item of node) {
        if (isRecord(item)) visit(item, `${path}[]`, depth + 1);
        else put(`${path}[]`, scalar(item));
      }
      return;
    }
    if (isRecord(node)) {
      if (depth >= MAX_DEPTH) {
        put(path, JSON.stringify(node).slice(0, MAX_CELL));
        return;
      }
      for (const [k, v] of Object.entries(node)) visit(v, path === "" ? k : `${path}.${k}`, depth + 1);
      return;
    }
    put(path, scalar(node));
  };
  visit(record, "", 0);
  return out;
}

function declaredTotalOf(root: unknown): number | undefined {
  if (!isRecord(root)) return undefined;
  for (const p of TOTAL_PATHS) {
    let node: unknown = root;
    for (const k of p) node = isRecord(node) ? node[k] : undefined;
    if (typeof node === "number" && Number.isInteger(node) && node >= 0) return node;
  }
  return undefined;
}

/** The array of record objects in a JSON document, and where it was found. */
function findRecords(root: unknown): { records: Record<string, unknown>[]; container: string } | undefined {
  if (Array.isArray(root)) {
    const objs = root.filter(isRecord);
    return objs.length > 0 && objs.length === root.length ? { records: objs, container: "$" } : undefined;
  }
  if (!isRecord(root)) return undefined;
  for (const key of CONTAINER_KEYS) {
    const v = root[key];
    if (Array.isArray(v) && v.length > 0 && v.every(isRecord)) return { records: v as Record<string, unknown>[], container: key };
    if (isRecord(v)) {
      const inner = findRecords(v);
      if (inner) return { records: inner.records, container: `${key}.${inner.container}` };
    }
  }
  // Otherwise the largest array of objects at depth one or two.
  let best: { records: Record<string, unknown>[]; container: string } | undefined;
  for (const [k, v] of Object.entries(root)) {
    if (Array.isArray(v) && v.length > 0 && v.every(isRecord) && (!best || v.length > best.records.length)) best = { records: v as Record<string, unknown>[], container: k };
    else if (isRecord(v)) {
      for (const [k2, v2] of Object.entries(v)) {
        if (Array.isArray(v2) && v2.length > 0 && v2.every(isRecord) && (!best || v2.length > best.records.length)) best = { records: v2 as Record<string, unknown>[], container: `${k}.${k2}` };
      }
    }
  }
  return best;
}

function tableFrom(format: SourceFormat, records: Record<string, Cell>[], extra: Partial<ProbeTable>, bytes: Uint8Array, notes: string[]): ProbeTable {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r)) {
      if (!seen.has(k)) {
        seen.add(k);
        columns.push(k);
      }
    }
  }
  if (columns.length > MAX_COLUMNS) {
    throw new PortError("INVALID", `the records have ${columns.length} distinct fields; a bounded probe accepts at most ${MAX_COLUMNS}`, { reason: "TOO_WIDE" });
  }
  const rows = records.map((r) => {
    const full: Record<string, Cell> = {};
    for (const c of columns) full[c] = c in r ? (r[c] as Cell) : null;
    return full;
  });
  return { format, columns, rows, bytes: bytes.length, sha256: sha256Hex(bytes), notes, ...extra };
}

function detectDelimiter(text: string): string {
  const head = text.split(/\r?\n/, 1)[0] ?? "";
  const counts = [",", ";", "\t", "|"].map((d) => ({ d, n: head.split(d).length - 1 }));
  counts.sort((a, b) => b.n - a.n);
  return counts[0]!.n > 0 ? counts[0]!.d : ",";
}

function parseCsvText(text: string, bytes: Uint8Array): ProbeTable {
  const delimiter = detectDelimiter(text);
  let rows: string[][];
  try {
    rows = parseCsv(text, { delimiter, relax_column_count: true, skip_empty_lines: true, bom: true, relax_quotes: false }) as string[][];
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === "CSV_QUOTE_NOT_CLOSED") {
      throw new PortError("TRUNCATED", "the response ends inside a quoted value; the file was cut off", { reason: "CSV_CUT_IN_QUOTE" });
    }
    throw new PortError("INVALID", `the text is not valid delimited data: ${(e as Error).message.slice(0, 160)}`, { reason: "CSV_PARSE", code });
  }
  if (rows.length === 0) throw new PortError("INVALID", "the response holds no rows", { reason: "NO_ROWS" });
  const header = rows[0]!.map((h) => h.trim());
  if (header.some((h) => h === "")) throw new PortError("INVALID", "the header row has an empty column name", { reason: "EMPTY_HEADER" });
  const dup = header.find((h, i) => header.indexOf(h) !== i);
  if (dup !== undefined) throw new PortError("INVALID", `the header names the column "${dup}" twice`, { reason: "DUPLICATE_HEADER" });
  const body = rows.slice(1);
  const last = body.length - 1;
  const ragged = body.findIndex((r) => r.length !== header.length);
  if (ragged >= 0) {
    const endsWithNewline = /\r?\n$/.test(text);
    if (ragged === last && !endsWithNewline) {
      throw new PortError("TRUNCATED", `the last row has ${body[ragged]!.length} of ${header.length} fields and the file does not end with a line break; it was cut off`, { reason: "CSV_CUT_IN_ROW", row: ragged + 2 });
    }
    throw new PortError("INVALID", `row ${ragged + 2} has ${body[ragged]!.length} fields; the header has ${header.length}`, { reason: "RAGGED_ROW", row: ragged + 2 });
  }
  const records = body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])) as Record<string, Cell>);
  return tableFrom("csv", records, { terminated: text.endsWith("\n") }, bytes, delimiter === "," ? [] : [`delimiter ${JSON.stringify(delimiter)}`]);
}

function jsonErrorKind(text: string): PortError {
  const t = text.trimEnd();
  const last = t[t.length - 1];
  const opens = (t.match(/[{[]/g) ?? []).length;
  const closes = (t.match(/[}\]]/g) ?? []).length;
  if ((last !== "}" && last !== "]") || opens > closes) {
    return new PortError("TRUNCATED", "the JSON ends before it closes; the response was cut off", { reason: "JSON_CUT" });
  }
  return new PortError("INVALID", "the response is not valid JSON", { reason: "JSON_PARSE" });
}

export function parseProbe(bytes: Uint8Array, contentType?: string): ProbeTable {
  if (bytes.length === 0) throw new PortError("INVALID", "the response body is empty", { reason: "EMPTY_BODY" });
  const text = decode(bytes);
  const trimmed = text.trimStart();
  const ct = (contentType ?? "").toLowerCase();
  const looksJson = trimmed.startsWith("{") || trimmed.startsWith("[");
  if (ct.includes("html") && !looksJson) throw new PortError("INVALID", "the response is an HTML page, not data", { reason: "HTML" });

  if (looksJson) {
    let root: unknown;
    try {
      root = JSON.parse(text);
    } catch {
      // Newline-delimited JSON is several documents, not one.
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      const parsed: unknown[] = [];
      let ok = lines.length > 1;
      for (const l of lines) {
        try {
          parsed.push(JSON.parse(l));
        } catch {
          ok = false;
          break;
        }
      }
      if (ok && parsed.every(isRecord)) return tableFrom("ndjson", parsed.map((r) => flatten(r as Record<string, unknown>)), {}, bytes, []);
      throw jsonErrorKind(text);
    }
    const found = findRecords(root);
    if (!found) throw new PortError("INVALID", "the JSON holds no array of records to map", { reason: "NO_RECORDS" });
    const declared = declaredTotalOf(root);
    return tableFrom("json", found.records.map(flatten), { container: found.container, ...(declared !== undefined ? { declaredTotal: declared } : {}) }, bytes, []);
  }
  return parseCsvText(text, bytes);
}

/** Cells of one column, with missing-value codes removed. */
export function presentValues(table: ProbeTable, column: string): Cell[] {
  return table.rows.map((r) => r[column] ?? null).filter((v) => !isNullToken(v));
}
