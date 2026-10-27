/**
 * Conversion of source cells into the canonical representation, and the normalised table that is landed for Zetaris.
 *
 * Conversions are the ones the validator recorded for each field and nothing else: a date family it determined, a
 * percent scale a reviewer accepted, the numeric missing-value codes a reviewer accepted, lexical clean-up of an
 * identifier. A cell that cannot be converted becomes empty and is counted, never guessed.
 */
import { canonicalField, type FieldType } from "./canonical.ts";
import { canonicalise, idFamily } from "./identifiers.ts";
import type { ProbeTable } from "./tabular.ts";
import { isNullToken, isSentinel, normaliseDate, parseAgeYears, parseNumber, text, type Cell, type DateFamily } from "./values.ts";

export type Conversion =
  | { kind: "percent_to_fraction" }
  | { kind: "null_codes"; tokens: (string | number)[] }
  | { kind: "date"; family: DateFamily }
  | { kind: "identifier"; family: string }
  | { kind: "enum_case" }
  | { kind: "age_units" };

export interface AppliedField {
  sourceField: string;
  canonicalField: string;
  conversions: readonly Conversion[];
}

const ROMAN: Record<string, string> = { I: "1", II: "2", III: "3" };

/** Upper case, spaces and hyphens to underscores; device classes may be written "Class II". */
export function normaliseEnum(canonicalId: string, raw: string): string {
  let s = raw.trim().toUpperCase();
  if (canonicalId === "device_class") {
    s = s.replace(/^CLASS\s*/, "");
    return ROMAN[s] ?? s;
  }
  return s.replace(/[\s-]+/g, "_");
}

const round6 = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/** The canonical text of one cell, or null when it is missing or cannot be converted. */
export function convertCell(cell: Cell, field: AppliedField, type: FieldType): string | null {
  if (isNullToken(cell)) return null;
  const nullCodes = new Set<number>();
  let percent = false;
  let dateFamily: DateFamily = "iso";
  for (const c of field.conversions) {
    if (c.kind === "null_codes") for (const t of c.tokens) if (typeof t === "number") nullCodes.add(t);
    if (c.kind === "percent_to_fraction") percent = true;
    if (c.kind === "date") dateFamily = c.family;
  }
  switch (type) {
    case "identifier":
    case "code": {
      const family = idFamily(field.canonicalField);
      return family ? canonicalise(family, text(cell)) : text(cell);
    }
    case "proportion": {
      const n = parseNumber(cell);
      if (!n || nullCodes.has(n.value) || isSentinel(n.value)) return null;
      return round6(percent ? n.value / 100 : n.value);
    }
    case "count":
    case "year": {
      const n = parseNumber(cell);
      if (!n || nullCodes.has(n.value) || isSentinel(n.value) || !Number.isInteger(n.value)) return null;
      return String(n.value);
    }
    case "age_years": {
      const n = parseAgeYears(cell);
      if (n === null || nullCodes.has(n) || isSentinel(n)) return null;
      return String(n);
    }
    case "date":
      return normaliseDate(text(cell), dateFamily, false);
    case "enum":
      return normaliseEnum(field.canonicalField, text(cell));
    default:
      return text(cell).replace(/\s+/g, " ");
  }
}

export interface CanonicalTable {
  columns: string[];
  rows: (string | null)[][];
  /** 1-based position in the source of each kept row. */
  sourceRows: number[];
  exactDuplicatesDropped: number;
  /** Cells that were present but could not be converted. */
  unconvertible: number;
}

/** Builds the table of canonical columns from a probe. Exact duplicate records are kept once. */
export function canonicalTable(table: ProbeTable, fields: readonly AppliedField[]): CanonicalTable {
  const defs = fields.map((f) => ({ f, type: canonicalField(f.canonicalField)?.type ?? ("text" as FieldType) }));
  const seen = new Set<string>();
  const rows: (string | null)[][] = [];
  const sourceRows: number[] = [];
  let dropped = 0;
  let unconvertible = 0;
  table.rows.forEach((row, index) => {
    const out = defs.map(({ f, type }) => {
      const cell = row[f.sourceField] ?? null;
      const v = convertCell(cell, f, type);
      if (v === null && !isNullToken(cell) && !isNumericNullCode(cell, f)) unconvertible += 1;
      return v;
    });
    const key = JSON.stringify(out);
    if (seen.has(key)) {
      dropped += 1;
      return;
    }
    seen.add(key);
    rows.push(out);
    sourceRows.push(index + 1);
  });
  return { columns: defs.map(({ f }) => f.canonicalField), rows, sourceRows, exactDuplicatesDropped: dropped, unconvertible };
}

function isNumericNullCode(cell: Cell, field: AppliedField): boolean {
  const n = parseNumber(cell) ?? (typeof cell === "string" ? { value: parseAgeYears(cell) ?? NaN } : null);
  if (!n || Number.isNaN(n.value)) return false;
  return field.conversions.some((c) => c.kind === "null_codes" && c.tokens.includes(n.value)) || isSentinel(n.value);
}

/** CSV text with every field quoted when it needs to be; `\n` line ends and a trailing newline. */
export function toCsv(columns: readonly string[], rows: readonly (readonly (string | null)[])[]): string {
  const q = (v: string | null): string => {
    if (v === null) return "";
    return /[",\r\n]/.test(v) || v !== v.trim() ? `"${v.replace(/"/g, '""')}"` : v;
  };
  return [columns.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n") + "\n";
}
