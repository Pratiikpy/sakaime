/**
 * Parsing of raw cell values: missing-value codes, numbers with percent signs and separators, ages with units,
 * and dates in the formats real exports use. These functions only read; they never guess. Where a value could
 * mean two things (12/03/2020, 1,5) they say so and the validator decides what to do about it.
 */
import { isRealDate } from "../federation/cast.ts";

export type Cell = string | number | boolean | null;

// ---------------------------------------------------------------- missing-value codes

const NULL_TOKENS: ReadonlySet<string> = new Set([
  "", "na", "n/a", "n.a.", "n.a", "null", "none", "nil", "nan", "-", "--", "---", ".", "?", "unknown", "unk", "not reported",
  "not available", "not applicable", "nr", "missing", "#n/a", "tbd", "undefined", "n/d", "nd",
]);

/** True for an empty cell or a text code that says "no value". Numeric sentinels (9999, -1) are NOT here: see `sentinelOf`. */
export function isNullToken(cell: Cell | undefined): boolean {
  if (cell === null || cell === undefined) return true;
  if (typeof cell === "string") return NULL_TOKENS.has(cell.trim().toLowerCase());
  return false;
}

export const text = (cell: Cell | undefined): string => (cell === null || cell === undefined ? "" : String(cell).trim());

/**
 * Numbers some exports use to mean "missing". They are legitimate-looking values, so a column holding one is held for
 * a reviewer instead of being read as data or silently dropped. 99 and 999 are excluded for fields where they are valid.
 */
const SENTINELS: ReadonlySet<number> = new Set([-1, -9, -99, -999, -9999, -99999, 9999, 99999, 999999, 9999999, 99999999]);
export const isSentinel = (n: number): boolean => SENTINELS.has(n);
export const SENTINEL_LIST: readonly number[] = [...SENTINELS];

// ---------------------------------------------------------------- numbers

export interface ParsedNumber {
  value: number;
  /** The text carried a percent sign. */
  percent: boolean;
  /** The text used a decimal comma, which is a locale difference a reviewer should see. */
  decimalComma: boolean;
}

/** Parses a number from a cell. Returns null when the cell is not a plain number (a range, a sentence, a code). */
export function parseNumber(cell: Cell | undefined): ParsedNumber | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? { value: cell, percent: false, decimalComma: false } : null;
  if (typeof cell === "boolean" || cell === null || cell === undefined) return null;
  let s = cell.trim();
  if (s === "") return null;
  let percent = false;
  if (s.endsWith("%")) {
    percent = true;
    s = s.slice(0, -1).trim();
  }
  let decimalComma = false;
  if (/^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) s = s.replace(/,/g, "");
  else if (/^[+-]?\d+,\d{1,2}$/.test(s)) {
    s = s.replace(",", ".");
    decimalComma = true;
  }
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return null;
  const value = Number(s);
  return Number.isFinite(value) ? { value, percent, decimalComma } : null;
}

/** "18 Years", "6 Months", "30 days", "45" -> years. Returns null for anything else. */
export function parseAgeYears(cell: Cell | undefined): number | null {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : null;
  if (typeof cell !== "string") return null;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(years?|yrs?|y|months?|mos?|weeks?|wks?|days?)?\s*(?:and (?:older|over|above)|\+)?\s*$/i.exec(cell);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "").toLowerCase();
  if (unit.startsWith("mo")) return Math.round((n / 12) * 1000) / 1000;
  if (unit.startsWith("w")) return Math.round((n / 52.1775) * 1000) / 1000;
  if (unit.startsWith("d")) return Math.round((n / 365.25) * 1000) / 1000;
  return n;
}

// ---------------------------------------------------------------- dates

/** The interpretation families a date string can belong to. A column must agree on one. */
export type DateFamily = "iso" | "ymd-compact" | "ymd-slash" | "dmy" | "mdy" | "text" | "epoch-s" | "epoch-ms";

export interface DateReading {
  /** Families that read this value as a real calendar date. */
  families: DateFamily[];
  /** The value matched a date pattern but names a day that does not exist in any reading. */
  impossible: boolean;
  /** Not a date pattern at all. */
  unparseable: boolean;
  /** The value carried a time zone offset. */
  zoned: boolean;
  /** Date at each family, ISO form, with the precision the source gave (YYYY, YYYY-MM or YYYY-MM-DD). */
  iso: Partial<Record<DateFamily, string>>;
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
const real = (y: number, m: number, d: number): boolean => y >= 1000 && y <= 2999 && isRealDate(y, m, d);

export function readDate(cell: Cell | undefined, allowYearOnly: boolean): DateReading {
  const out: DateReading = { families: [], impossible: false, unparseable: false, zoned: false, iso: {} };
  const add = (family: DateFamily, iso: string): void => {
    out.families.push(family);
    out.iso[family] = iso;
  };
  if (typeof cell === "number" && Number.isInteger(cell)) cell = String(cell);
  if (typeof cell !== "string") {
    out.unparseable = true;
    return out;
  }
  const s = cell.trim();
  let m: RegExpExecArray | null;
  let sawPattern = false;

  if ((m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s))) {
    sawPattern = true;
    if (real(+m[1]!, +m[2]!, +m[3]!)) add("iso", s);
  } else if ((m = /^(\d{4})-(\d{2})-(\d{2})[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/.exec(s))) {
    sawPattern = true;
    if (m[4] !== undefined) out.zoned = true;
    if (real(+m[1]!, +m[2]!, +m[3]!)) add("iso", `${m[1]}-${m[2]}-${m[3]}`);
  } else if ((m = /^(\d{4})-(\d{2})$/.exec(s))) {
    sawPattern = true;
    if (+m[2]! >= 1 && +m[2]! <= 12) add("iso", s);
  } else if (allowYearOnly && (m = /^(\d{4})$/.exec(s))) {
    sawPattern = true;
    if (+m[1]! >= 1000) add("iso", s);
  } else if ((m = /^(\d{4})(\d{2})(\d{2})$/.exec(s))) {
    sawPattern = true;
    if (real(+m[1]!, +m[2]!, +m[3]!)) add("ymd-compact", `${m[1]}-${m[2]}-${m[3]}`);
  } else if ((m = /^(\d{4})[/.](\d{1,2})[/.](\d{1,2})$/.exec(s))) {
    sawPattern = true;
    if (real(+m[1]!, +m[2]!, +m[3]!)) add("ymd-slash", `${m[1]}-${pad(+m[2]!)}-${pad(+m[3]!)}`);
  } else if ((m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s))) {
    sawPattern = true;
    const a = +m[1]!;
    const b = +m[2]!;
    const y = +m[3]!;
    if (real(y, b, a)) add("dmy", `${y}-${pad(b)}-${pad(a)}`);
    if (real(y, a, b)) add("mdy", `${y}-${pad(a)}-${pad(b)}`);
  } else if ((m = /^(\d{1,2})[ -]([A-Za-z]{3})[a-z]*[ -,]*(\d{4})$/.exec(s)) && MONTHS[m[2]!.toLowerCase()]) {
    sawPattern = true;
    const mo = MONTHS[m[2]!.toLowerCase()]!;
    if (real(+m[3]!, mo, +m[1]!)) add("text", `${m[3]}-${pad(mo)}-${pad(+m[1]!)}`);
  } else if ((m = /^([A-Za-z]{3})[a-z]*\.? (\d{1,2}),? (\d{4})$/.exec(s)) && MONTHS[m[1]!.toLowerCase()]) {
    sawPattern = true;
    const mo = MONTHS[m[1]!.toLowerCase()]!;
    if (real(+m[3]!, mo, +m[2]!)) add("text", `${m[3]}-${pad(mo)}-${pad(+m[2]!)}`);
  } else if (/^\d{9,10}$/.test(s)) {
    sawPattern = true;
    const d = new Date(Number(s) * 1000);
    add("epoch-s", d.toISOString().slice(0, 10));
  } else if (/^\d{12,13}$/.test(s)) {
    sawPattern = true;
    const d = new Date(Number(s));
    add("epoch-ms", d.toISOString().slice(0, 10));
  }
  if (!sawPattern) out.unparseable = true;
  else if (out.families.length === 0) out.impossible = true;
  return out;
}

export interface DateColumn {
  /** The family every value agrees on, when exactly one does. */
  family?: DateFamily;
  /** Both day-first and month-first read every value. */
  ambiguous: boolean;
  /** The values use incompatible formats. */
  mixed: boolean;
  impossible: string[];
  unparseable: string[];
  zoned: number;
  /** ISO dates by input value, for the family chosen. */
  normalised: Map<string, string>;
  checked: number;
}

export function readDateColumn(values: readonly string[], allowYearOnly: boolean): DateColumn {
  const out: DateColumn = { ambiguous: false, mixed: false, impossible: [], unparseable: [], zoned: 0, normalised: new Map(), checked: values.length };
  let common: Set<DateFamily> | undefined;
  const readings = new Map<string, DateReading>();
  for (const v of values) {
    if (readings.has(v)) continue;
    const r = readDate(v, allowYearOnly);
    readings.set(v, r);
    if (r.zoned) out.zoned += 1;
    if (r.unparseable) {
      out.unparseable.push(v);
      continue;
    }
    if (r.impossible) {
      out.impossible.push(v);
      continue;
    }
    const set = new Set(r.families);
    if (!common) common = set;
    else common = new Set([...common].filter((x) => set.has(x)));
  }
  if (out.unparseable.length > 0 || out.impossible.length > 0 || !common) return out;
  if (common.size === 0) {
    out.mixed = true;
    return out;
  }
  if (common.size > 1) {
    // dmy and mdy are the only pair that overlaps; anything else here would be a bug in the readings above.
    out.ambiguous = common.has("dmy") && common.has("mdy");
    out.mixed = !out.ambiguous;
    return out;
  }
  out.family = [...common][0];
  for (const [value, r] of readings) {
    const iso = r.iso[out.family!];
    if (iso !== undefined) out.normalised.set(value, iso);
  }
  return out;
}

/** Normalise one value under a chosen family; null when it does not parse there. */
export function normaliseDate(value: string, family: DateFamily, allowYearOnly: boolean): string | null {
  return readDate(value, allowYearOnly).iso[family] ?? null;
}
