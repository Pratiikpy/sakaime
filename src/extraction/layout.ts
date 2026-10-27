/**
 * Reading order for one PDF page, from positioned text items.
 *
 * Content-stream order is not reading order once a page has columns, side-by-side comparison tables or text boxes
 * added late. This module groups items into lines by baseline, orders lines top to bottom, keeps wide gaps inside a
 * line visible (three spaces, so a table row stays one row and a downstream rule can tell it from prose), and splits
 * a page into two reading columns only when the evidence for columns is strong: a clear gutter, long text runs on
 * both sides, and almost no line crossing it. Short cells on either side of a gap are a table, not columns.
 *
 * The idea of keeping layout information next to the text (so a value can be traced to a place on a page) follows
 * Docling's provenance model (MIT). Nothing is copied from it.
 */

export interface PositionedItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface LayoutLine {
  text: string;
  bbox: [number, number, number, number];
  /** True when the line contains a gap wide enough to be a table column gap. */
  hasColumnGap: boolean;
  /** Blank line (paragraph break) precedes this line. */
  paragraphBreak: boolean;
}

interface Row {
  items: PositionedItem[];
  y: number;
  height: number;
}

const COLUMN_GAP_EM = 1.5;
const SPACE_GAP_EM = 0.18;

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

function groupRows(items: PositionedItem[]): Row[] {
  const meaningful = items.filter((it) => it.str.length > 0 && (it.str.trim().length > 0 || it.width > 0));
  const sorted = [...meaningful].sort((a, b) => b.y - a.y || a.x - b.x);
  const rows: Row[] = [];
  for (const it of sorted) {
    const h = it.height > 0 ? it.height : 10;
    const last = rows[rows.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(1.5, 0.4 * Math.min(last.height, h))) {
      last.items.push(it);
      last.height = Math.max(last.height, h);
    } else {
      rows.push({ items: [it], y: it.y, height: h });
    }
  }
  for (const r of rows) r.items.sort((a, b) => a.x - b.x);
  return rows;
}

function renderRow(row: Row): { text: string; hasGap: boolean; bbox: [number, number, number, number] } {
  let text = "";
  let hasGap = false;
  let prev: PositionedItem | undefined;
  let x0 = Infinity;
  let x1 = -Infinity;
  for (const it of row.items) {
    if (prev) {
      const em = Math.max(prev.height, it.height, 6);
      const gap = it.x - (prev.x + prev.width);
      const needsSpace = !/\s$/.test(text) && !/^\s/.test(it.str);
      if (gap > COLUMN_GAP_EM * em && needsSpace) {
        text += "   ";
        hasGap = true;
      } else if (gap > SPACE_GAP_EM * em && needsSpace) {
        text += " ";
      }
    }
    text += it.str;
    x0 = Math.min(x0, it.x);
    x1 = Math.max(x1, it.x + it.width);
    prev = it;
  }
  const bottom = row.y - 0.2 * row.height;
  const top = row.y + row.height;
  return { text: text.replace(/\s+$/g, ""), hasGap, bbox: [x0, bottom, x1, top] };
}

interface Gutter {
  x: number;
}

/**
 * A gutter is accepted only with strong evidence. Returns undefined for single-column pages and tables.
 */
function findGutter(rows: Row[], pageWidth: number): Gutter | undefined {
  if (rows.length < 10 || pageWidth <= 0) return undefined;
  let best: { x: number; crossing: number } | undefined;
  for (let gx = pageWidth * 0.35; gx <= pageWidth * 0.65; gx += 2) {
    let crossing = 0;
    for (const r of rows) {
      if (r.items.some((it) => it.x < gx && it.x + it.width > gx && it.str.trim().length > 0)) crossing++;
    }
    if (!best || crossing < best.crossing) best = { x: gx, crossing };
  }
  if (!best) return undefined;
  const gx = best.x;
  const left: number[] = [];
  const right: number[] = [];
  let twoSided = 0;
  for (const r of rows) {
    const l = r.items.filter((it) => it.x + it.width <= gx && it.str.trim());
    const rt = r.items.filter((it) => it.x >= gx && it.str.trim());
    if (l.length && rt.length) twoSided++;
    if (l.length) left.push(Math.max(...l.map((i) => i.x + i.width)) - Math.min(...l.map((i) => i.x)));
    if (rt.length) right.push(Math.max(...rt.map((i) => i.x + i.width)) - Math.min(...rt.map((i) => i.x)));
  }
  const minRun = pageWidth * 0.3;
  const enough = left.length >= 6 && right.length >= 6;
  const longRuns = medianOf(left) >= minRun * 0.6 && medianOf(right) >= minRun * 0.6;
  const fewCrossing = best.crossing <= rows.length * 0.15;
  // Columns have many rows with text on both sides. A table also does, but its cells are short, which longRuns rejects.
  if (enough && longRuns && fewCrossing && twoSided >= 4) return { x: gx };
  return undefined;
}

export interface OrderedPage {
  lines: LayoutLine[];
  columns: boolean;
}

export function orderPageItems(items: PositionedItem[], pageWidth: number): OrderedPage {
  const rows = groupRows(items);
  if (rows.length === 0) return { lines: [], columns: false };
  const gutter = findGutter(rows, pageWidth);

  const lines: LayoutLine[] = [];
  const pushRow = (row: Row, prevRow: Row | undefined) => {
    const r = renderRow(row);
    if (!r.text.trim()) return;
    const gapAbove = prevRow ? prevRow.y - row.y : 0;
    lines.push({
      text: r.text,
      bbox: r.bbox,
      hasColumnGap: r.hasGap,
      paragraphBreak: prevRow ? gapAbove > 1.7 * Math.max(row.height, prevRow.height) : false,
    });
  };

  if (!gutter) {
    let prev: Row | undefined;
    for (const row of rows) {
      pushRow(row, prev);
      prev = row;
    }
    return { lines, columns: false };
  }

  const leftBuf: Row[] = [];
  const rightBuf: Row[] = [];
  let prevEmitted: Row | undefined;
  const flush = () => {
    for (const buf of [leftBuf, rightBuf]) {
      let prev: Row | undefined;
      for (const row of buf) {
        pushRow(row, prev ?? prevEmitted);
        prev = row;
      }
      if (buf.length) prevEmitted = buf[buf.length - 1];
      buf.length = 0;
    }
  };
  for (const row of rows) {
    const crosses = row.items.some((it) => it.x < gutter.x && it.x + it.width > gutter.x && it.str.trim());
    if (crosses) {
      flush();
      pushRow(row, prevEmitted);
      prevEmitted = row;
      continue;
    }
    const l = row.items.filter((it) => it.x + it.width <= gutter.x);
    const r = row.items.filter((it) => it.x >= gutter.x);
    if (l.length) leftBuf.push({ items: l, y: row.y, height: row.height });
    if (r.length) rightBuf.push({ items: r, y: row.y, height: row.height });
  }
  flush();
  return { lines, columns: true };
}
