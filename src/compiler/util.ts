import type { Relation } from "../schemas/index.ts";

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** Free text compared case-insensitively with collapsed whitespace. */
export const normText = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ");

/** Taxonomy keys: lower case, words joined by underscores. */
export const normKey = (s: string): string => s.trim().toLowerCase().replace(/[\s-]+/g, "_");

/** "V2.1.0" and "2.1.0" name the same release label. No other equivalence is assumed (no standard defines one). */
export const normVersion = (s: string): string => normText(s).replace(/^v(?=\d)/, "");

export const sortedUnique = (xs: Iterable<string>): string[] => [...new Set(xs)].sort(cmp);

export function setOf(xs: readonly string[] | undefined, norm: (s: string) => string): Set<string> | undefined {
  if (!xs || xs.length === 0) return undefined;
  return new Set(xs.map(norm));
}

export const list = (xs: Iterable<string>): string => sortedUnique(xs).join(", ");

/** Severity order used wherever several partial results are combined: the worst one speaks for the whole. */
export const SEVERITY: Record<Relation, number> = { CONTAINED: 0, PARTIAL: 1, UNKNOWN: 2, DISJOINT: 3 };

export function worst(relations: readonly Relation[]): Relation {
  let out: Relation = "CONTAINED";
  for (const r of relations) if (SEVERITY[r] > SEVERITY[out]) out = r;
  return out;
}

export function isCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

export function dayNumber(s: string): number {
  const [y, mo, d] = s.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(y, mo - 1, d) / 86_400_000);
}

export function formatDay(n: number): string {
  return new Date(n * 86_400_000).toISOString().slice(0, 10);
}

export function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

export const subsetOf = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean => {
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

export const intersectSets = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> => new Set([...a].filter((x) => b.has(x)));
export const unionSets = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> => new Set([...a, ...b]);
export const diffSets = <T>(a: ReadonlySet<T>, b: ReadonlySet<T>): Set<T> => new Set([...a].filter((x) => !b.has(x)));

export function fmtNumber(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Number(n.toFixed(4)));
}
