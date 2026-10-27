/**
 * Number tracing (FR-2): every number shown in a finding must appear in a passage the finding cites.
 *
 * Numbers are compared as numbers, not as strings, so "0.912" traces to "91.2%" and "1,284" traces to "1284".
 * Dates are the one place a renderer legitimately reformats (2023-05-01 may come from "May 1, 2023"), so an ISO date
 * in a rendered value is traced by its year only. This is a deliberate, narrow leniency and is stated in the report.
 */

const ISO_DATE = /\b(\d{4})-\d{2}-\d{2}\b/g;
const THOUSANDS = /\d{1,3}(?:,\d{3})+(?!\d)/g;
const NUMBER = /\d+(?:\.\d+)?/g;

function stripThousands(text: string): string {
  return text.replace(THOUSANDS, (m) => m.replace(/,/g, ""));
}

/** Numbers a reader would see in a haystack passage. Dates stay as their parts so any rendering of them can match. */
export function numbersInPassage(text: string): number[] {
  return (stripThousands(text).match(NUMBER) ?? []).map(Number).filter(Number.isFinite);
}

/** Numbers a rendered finding value asserts. ISO dates contribute their year only. */
export function numbersInRendered(text: string): { token: string; value: number }[] {
  const years: { token: string; value: number }[] = [];
  const withoutDates = text.replace(ISO_DATE, (_m, year: string) => {
    years.push({ token: year, value: Number(year) });
    return " ";
  });
  const tokens = stripThousands(withoutDates).match(NUMBER) ?? [];
  return [...tokens.map((token) => ({ token, value: Number(token) })), ...years].filter((n) => Number.isFinite(n.value));
}

function close(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-7 * scale;
}

/**
 * True when `value` equals a passage number directly, or is the fraction/percent form of it (0.912 against 91.2).
 * The percent conversion applies only to values in [0, 1] so a count such as 5 is never matched by 500.
 */
export function traces(value: number, passageNumbers: readonly number[]): boolean {
  const asPercent = value >= 0 && value <= 1;
  return passageNumbers.some((p) => close(value, p) || (asPercent && close(value * 100, p)) || (p >= 0 && p <= 1 && close(value, p * 100)));
}

/** Leaf strings and numbers of an arbitrary JSON value, as rendered text. */
export function leafTexts(value: unknown, out: string[] = []): string[] {
  if (value === null || value === undefined) return out;
  if (typeof value === "number") out.push(String(value));
  else if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) leafTexts(v, out);
  else if (typeof value === "object") for (const v of Object.values(value as Record<string, unknown>)) leafTexts(v, out);
  return out;
}
