/**
 * Typed casting for Zetaris results.
 *
 * Zetaris returns every value as a string (or JSON null). The wire response carries column names only; the
 * live engine gives no column types (observed 2026-10-16: `{"headers":["1"],"data":[["1"]],"total":1,"timeUsed":808}`).
 * Types therefore come from a declared schema keyed by output column name. A column with no declaration stays a
 * string and is typed "string": the port never infers a type from the look of a value, because a text id such as
 * "00123" or a version such as "1.10" would be silently corrupted by guessing.
 *
 * A value that does not parse as its declared type is a DRIFTED failure (the response no longer matches what
 * the caller was told to expect), never a silent null.
 */
import { PortError, type FederationColumn } from "../ports/index.ts";

export const COLUMN_TYPES = ["string", "integer", "bigint", "double", "decimal", "boolean", "date", "timestamp"] as const;
export type ColumnType = (typeof COLUMN_TYPES)[number];

/** Declared types by output column name (matched case-insensitively). Values are canonical names or engine type names. */
export type DeclaredSchema = Readonly<Record<string, string>>;

export interface CastOptions {
  /**
   * What an empty string means in a non-string column. "null" (default) reads it as unknown, which is safe: unknown
   * is never false and never zero. "error" treats it as drift.
   */
  emptyAs?: "null" | "error";
  /** Integers beyond 2^53-1: "string" (default) keeps the exact decimal digits and stays JSON-safe; "bigint" returns a BigInt. */
  bigint?: "string" | "bigint";
  /** Zone designator appended to timestamps that carry none, for example "Z". Default none: the engine session zone is not known. */
  timestampZone?: string;
}

const TYPE_ALIASES: Record<string, ColumnType> = {
  string: "string", varchar: "string", char: "string", text: "string", "character varying": "string", uuid: "string",
  int: "integer", integer: "integer", int4: "integer", int2: "integer", int1: "integer", smallint: "integer", tinyint: "integer",
  short: "integer", byte: "integer", utinyint: "integer", usmallint: "integer",
  bigint: "bigint", long: "bigint", int8: "bigint", uinteger: "bigint",
  hugeint: "decimal", uhugeint: "decimal", ubigint: "decimal",
  double: "double", float: "double", float4: "double", float8: "double", real: "double",
  decimal: "decimal", numeric: "decimal", dec: "decimal",
  boolean: "boolean", bool: "boolean",
  date: "date",
  timestamp: "timestamp", datetime: "timestamp", timestamp_ntz: "timestamp", timestamp_ltz: "timestamp", timestamptz: "timestamp",
  "timestamp with time zone": "timestamp", "timestamp without time zone": "timestamp",
};

/** Map a Spark or DuckDB type name (`varchar(200)`, `DECIMAL(18,3)`, `BIGINT`) to a canonical type. Unknown names return undefined. */
export function parseTypeName(raw: string): ColumnType | undefined {
  const base = raw.trim().toLowerCase().replace(/\s*\(.*\)\s*$/, "");
  return TYPE_ALIASES[base];
}

/** Validate a declared schema once. An unknown type name is a configuration error and fails loudly. */
export function resolveSchema(declared: DeclaredSchema | undefined): ReadonlyMap<string, ColumnType> {
  const out = new Map<string, ColumnType>();
  for (const [name, type] of Object.entries(declared ?? {})) {
    const parsed = parseTypeName(type);
    if (!parsed) throw new PortError("INVALID", `declared schema: column "${name}" has unsupported type "${type}"`, { column: name, type });
    out.set(name.toLowerCase(), parsed);
  }
  return out;
}

const INT_RE = /^[+-]?\d+$/;
const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const SPECIAL_FLOAT_RE = /^([+-]?)(nan|inf|infinity)$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TS_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?\s*(Z|[+-]\d{2}(?::?\d{2})?)?$/i;

const INT32 = { min: -(2n ** 31n), max: 2n ** 31n - 1n };
const INT64 = { min: -(2n ** 63n), max: 2n ** 63n - 1n };

export function isRealDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= (days[month - 1] ?? 0);
}

interface CellContext {
  column: string;
  row: number;
}

function drift(ctx: CellContext, type: ColumnType, raw: string, why: string): PortError {
  const shown = raw.length > 60 ? `${raw.slice(0, 60)}...` : raw;
  return new PortError("DRIFTED", `column "${ctx.column}" row ${ctx.row}: cannot read ${JSON.stringify(shown)} as ${type} (${why})`, {
    column: ctx.column,
    row: ctx.row,
    type,
    reason: "CAST_FAILED",
  });
}

/**
 * Plain decimal form: no exponent, no leading or trailing zeros. Used to decide whether a decimal survives a
 * round trip through a JS double. Returns undefined for text that is not a decimal or whose exponent is absurd.
 */
export function plainDecimal(s: string): string | undefined {
  const m = /^([+-]?)(\d*)\.?(\d*)(?:[eE]([+-]?\d+))?$/.exec(s);
  if (!m) return undefined;
  const whole = m[2] ?? "";
  const frac = m[3] ?? "";
  if (whole.length + frac.length === 0) return undefined;
  const exp = m[4] === undefined ? 0 : Number(m[4]);
  if (!Number.isFinite(exp) || Math.abs(exp) > 1000) return undefined;
  let digits = whole + frac;
  let point = whole.length + exp;
  const lead = /^0*/.exec(digits)![0].length;
  digits = digits.slice(lead).replace(/0+$/, "");
  point -= lead;
  if (digits === "") return "0";
  let intPart: string;
  let fracPart: string;
  if (point <= 0) {
    intPart = "0";
    fracPart = "0".repeat(-point) + digits;
  } else if (point >= digits.length) {
    intPart = digits + "0".repeat(point - digits.length);
    fracPart = "";
  } else {
    intPart = digits.slice(0, point);
    fracPart = digits.slice(point);
  }
  return `${m[1] === "-" ? "-" : ""}${intPart}${fracPart ? `.${fracPart}` : ""}`;
}

function castInteger(raw: string, type: "integer" | "bigint", ctx: CellContext, opts: CastOptions): number | bigint | string {
  if (!INT_RE.test(raw)) throw drift(ctx, type, raw, "not an integer");
  const value = BigInt(raw);
  const range = type === "integer" ? INT32 : INT64;
  if (value < range.min || value > range.max) throw drift(ctx, type, raw, "out of range");
  if (value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  return opts.bigint === "bigint" ? value : value.toString();
}

function castDouble(raw: string, ctx: CellContext): number {
  const special = SPECIAL_FLOAT_RE.exec(raw);
  if (special) {
    if (special[2]!.toLowerCase() === "nan") return Number.NaN;
    return special[1] === "-" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }
  if (!NUM_RE.test(raw)) throw drift(ctx, "double", raw, "not a number");
  const value = Number(raw);
  if (!Number.isFinite(value)) throw drift(ctx, "double", raw, "out of range");
  return value;
}

/** A decimal becomes a number only when that loses nothing; otherwise the exact digits are kept as a string. */
function castDecimal(raw: string, ctx: CellContext): number | string {
  if (!NUM_RE.test(raw)) throw drift(ctx, "decimal", raw, "not a decimal");
  const exact = plainDecimal(raw);
  if (exact === undefined) throw drift(ctx, "decimal", raw, "exponent out of range");
  const value = Number(raw);
  if (Number.isFinite(value) && plainDecimal(String(value)) === exact) return value;
  return exact;
}

function castBoolean(raw: string, ctx: CellContext): boolean {
  const lower = raw.toLowerCase();
  if (lower === "true") return true;
  if (lower === "false") return false;
  throw drift(ctx, "boolean", raw, "expected true or false");
}

function castDate(raw: string, ctx: CellContext): string {
  const m = DATE_RE.exec(raw);
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) throw drift(ctx, "date", raw, "expected a real YYYY-MM-DD date");
  return raw;
}

/** Spark prints `2026-08-31 11:22:21.0`, DuckDB `2026-08-31 11:22:21`; both normalise to `2026-08-31T11:22:21`. */
function castTimestamp(raw: string, ctx: CellContext, opts: CastOptions): string {
  const m = TS_RE.exec(raw);
  if (!m) throw drift(ctx, "timestamp", raw, "expected YYYY-MM-DD HH:MM:SS[.fraction][zone]");
  const [, y, mo, d, h, mi, s, fraction, zone] = m;
  if (!isRealDate(Number(y), Number(mo), Number(d)) || Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
    throw drift(ctx, "timestamp", raw, "not a real instant");
  }
  const frac = (fraction ?? "").replace(/0+$/, "");
  let out = `${y}-${mo}-${d}T${h}:${mi}:${s}${frac ? `.${frac}` : ""}`;
  if (zone) {
    const z = zone.toUpperCase();
    out += z === "Z" ? "Z" : `${z.slice(0, 3)}:${z.length > 3 ? z.slice(-2) : "00"}`;
  } else if (opts.timestampZone) {
    out += opts.timestampZone;
  }
  return out;
}

export function castValue(raw: string | null, type: ColumnType, ctx: CellContext, opts: CastOptions = {}): unknown {
  if (raw === null) return null;
  if (type === "string") return raw;
  if (raw === "") {
    if (opts.emptyAs === "error") throw drift(ctx, type, raw, "empty value");
    return null;
  }
  switch (type) {
    case "integer":
    case "bigint":
      return castInteger(raw, type, ctx, opts);
    case "double":
      return castDouble(raw, ctx);
    case "decimal":
      return castDecimal(raw, ctx);
    case "boolean":
      return castBoolean(raw, ctx);
    case "date":
      return castDate(raw, ctx);
    case "timestamp":
      return castTimestamp(raw, ctx, opts);
  }
}

export type RawRow = readonly (string | null)[];

/**
 * Cast raw rows to typed records. `types` is positional (one per column). Duplicate output names are refused:
 * a record keyed by name would silently keep only one of them.
 */
export function castRowsWithTypes(
  columns: readonly string[],
  rawRows: readonly RawRow[],
  types: readonly ColumnType[],
  opts: CastOptions = {},
): { columns: FederationColumn[]; rows: Record<string, unknown>[] } {
  const seen = new Set<string>();
  for (const name of columns) {
    if (seen.has(name)) {
      throw new PortError("INVALID", `result has two columns named "${name}"; alias every selected column so no value is lost`, {
        column: name,
        reason: "DUPLICATE_COLUMN",
      });
    }
    seen.add(name);
  }
  const rows = rawRows.map((raw, rowIndex) => {
    if (raw.length !== columns.length) {
      throw new PortError("DRIFTED", `row ${rowIndex} has ${raw.length} values for ${columns.length} columns`, { row: rowIndex, reason: "ROW_WIDTH" });
    }
    const record: Record<string, unknown> = {};
    columns.forEach((name, i) => {
      record[name] = castValue(raw[i] ?? null, types[i] ?? "string", { column: name, row: rowIndex }, opts);
    });
    return record;
  });
  return { columns: columns.map((name, i) => ({ name, type: types[i] ?? "string" })), rows };
}

/** Cast with a declared schema keyed by column name; undeclared columns stay strings. */
export function castRows(
  columns: readonly string[],
  rawRows: readonly RawRow[],
  schema: ReadonlyMap<string, ColumnType>,
  opts: CastOptions = {},
): { columns: FederationColumn[]; rows: Record<string, unknown>[] } {
  const types = columns.map((name) => schema.get(name.toLowerCase()) ?? "string");
  return castRowsWithTypes(columns, rawRows, types, opts);
}
