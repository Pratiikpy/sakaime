import { fmtNumber } from "./util.ts";

/** A closed interval on the real line. Unbounded ends use +/-Infinity. */
export interface Interval {
  lo: number;
  hi: number;
}

export function intersect(a: Interval, b: Interval): Interval | undefined {
  const lo = Math.max(a.lo, b.lo);
  const hi = Math.min(a.hi, b.hi);
  return lo <= hi ? { lo, hi } : undefined;
}

/** Sorted, with overlapping or touching pieces merged. Pieces that leave a gap stay separate. */
export function mergeIntervals(list: readonly Interval[]): Interval[] {
  const sorted = [...list].sort((a, b) => a.lo - b.lo || a.hi - b.hi);
  const out: Interval[] = [];
  for (const piece of sorted) {
    const last = out[out.length - 1];
    if (last && piece.lo <= last.hi) last.hi = Math.max(last.hi, piece.hi);
    else out.push({ ...piece });
  }
  return out;
}

export function intersectLists(a: readonly Interval[], b: readonly Interval[]): Interval[] {
  const out: Interval[] = [];
  for (const x of a) for (const y of b) {
    const i = intersect(x, y);
    if (i) out.push(i);
  }
  return mergeIntervals(out);
}

export const listContains = (list: readonly Interval[], c: Interval): boolean => list.some((p) => p.lo <= c.lo && c.hi <= p.hi);

/** The parts of `c` that no piece of `list` covers, with whether each end of the gap is open. */
export interface Gap {
  lo: number;
  hi: number;
  loOpen: boolean;
  hiOpen: boolean;
}

export function gapsOf(c: Interval, list: readonly Interval[]): Gap[] {
  const gaps: Gap[] = [];
  let cursor = c.lo;
  let cursorOpen = false;
  for (const p of mergeIntervals(list)) {
    if (p.hi < cursor || (p.hi === cursor && cursorOpen)) continue;
    if (p.lo > c.hi) break;
    if (p.lo > cursor || (p.lo === cursor && cursorOpen)) {
      gaps.push({ lo: cursor, hi: p.lo, loOpen: cursorOpen, hiOpen: true });
    }
    cursor = p.hi;
    cursorOpen = true;
    if (cursor >= c.hi) return gaps;
  }
  if (cursor < c.hi) gaps.push({ lo: cursor, hi: c.hi, loOpen: cursorOpen, hiOpen: false });
  return gaps;
}

/** Age rendering. Ages are years; a lower bound of 0 is the same as no lower bound. */
export function renderAge(i: Interval): string {
  const lowOpen = i.lo <= 0;
  const highOpen = i.hi === Infinity;
  if (lowOpen && highOpen) return "all ages";
  if (highOpen) return `ages ${fmtNumber(i.lo)} and above`;
  if (lowOpen) return `ages up to ${fmtNumber(i.hi)}`;
  return `ages ${fmtNumber(i.lo)} to ${fmtNumber(i.hi)}`;
}

export const renderAges = (list: readonly Interval[]): string => list.map(renderAge).join(" or ");

export function renderGap(g: Gap): string {
  if (!g.loOpen && g.lo <= 0 && Number.isFinite(g.hi)) return g.hiOpen ? `ages below ${fmtNumber(g.hi)}` : `ages up to ${fmtNumber(g.hi)}`;
  if (!g.loOpen && Number.isFinite(g.hi)) return g.hiOpen ? `ages ${fmtNumber(g.lo)} to below ${fmtNumber(g.hi)}` : `ages ${fmtNumber(g.lo)} to ${fmtNumber(g.hi)}`;
  if (g.loOpen && g.hi === Infinity) return `ages above ${fmtNumber(g.lo)}`;
  if (g.loOpen && Number.isFinite(g.hi)) return `ages above ${fmtNumber(g.lo)} up to ${fmtNumber(g.hi)}`;
  return `ages ${fmtNumber(g.lo)} and above`;
}
