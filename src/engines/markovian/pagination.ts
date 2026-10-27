import type { StepInput } from "./types.ts";

export interface Page {
  page: number;
  text: string;
}

export class PageInputError extends Error {
  constructor(message: string) {
    super(`Markovian reader: ${message}`);
    this.name = "PageInputError";
  }
}

/** Pages with fewer than this many non-space characters are reported as having no extractable text. */
export const MIN_TEXT_CHARS = 20;

/**
 * Validate and order the pages. Duplicate or non-positive page numbers are refused: a page anchor that can
 * point at two different texts would make every later quote check meaningless.
 */
export function normalisePages(pages: ReadonlyArray<Page>): Page[] {
  const seen = new Set<number>();
  const out: Page[] = [];
  for (const p of pages) {
    if (!p || !Number.isInteger(p.page) || p.page < 1) throw new PageInputError(`page number ${String(p?.page)} is not a positive integer`);
    if (typeof p.text !== "string") throw new PageInputError(`page ${p.page} has no text field`);
    if (seen.has(p.page)) throw new PageInputError(`page ${p.page} appears twice`);
    seen.add(p.page);
    out.push({ page: p.page, text: stripControl(p.text) });
  }
  return out.sort((a, b) => a.page - b.page);
}

/** Remove control characters other than tab and line breaks; a text layer sometimes carries NULs and escapes. */
export function stripControl(text: string): string {
  let out = "";
  for (const c of text) {
    const code = c.codePointAt(0) as number;
    if (code === 9 || code === 10 || code === 13 || (code >= 32 && code !== 127)) out += c;
  }
  return out.replace(/\r\n?/g, "\n");
}

export function hasText(p: Page): boolean {
  return p.text.replace(/\s+/g, "").length >= MIN_TEXT_CHARS;
}

export interface Piece {
  page: number;
  part: number;
  of: number;
  text: string;
}

export interface PlannedChunk {
  input: StepInput;
  pages: number[];
  pieces: Piece[];
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");
const header = (p: { page: number; part: number; of: number }): string => (p.of > 1 ? `[PAGE ${p.page}, part ${p.part}/${p.of}]` : `[PAGE ${p.page}]`);

/** Split text into pieces of at most maxBytes, preferring paragraph, then sentence, then word boundaries. */
function splitText(text: string, maxBytes: number): string[] {
  if (bytes(text) <= maxBytes) return [text];
  const out: string[] = [];
  let rest = text;
  while (bytes(rest) > maxBytes) {
    let cut = largestPrefix(rest, maxBytes);
    const window = rest.slice(0, cut);
    const para = window.lastIndexOf("\n\n");
    const sentence = Math.max(window.lastIndexOf(". "), window.lastIndexOf(".\n"), window.lastIndexOf("; "));
    const word = Math.max(window.lastIndexOf(" "), window.lastIndexOf("\n"));
    if (para > cut * 0.4) cut = para + 2;
    else if (sentence > cut * 0.4) cut = sentence + 2;
    else if (word > cut * 0.4) cut = word + 1;
    out.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out;
}

/** The longest prefix, in UTF-16 units, whose UTF-8 size does not exceed maxBytes (never splitting a surrogate pair). */
function largestPrefix(text: string, maxBytes: number): number {
  let lo = 1;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (bytes(text.slice(0, mid)) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  const code = text.charCodeAt(lo - 1);
  return code >= 0xd800 && code <= 0xdbff ? lo - 1 : lo;
}

/**
 * Pack pages into chunks whose material fits maxBytes. A page larger than a chunk is split at natural
 * boundaries into parts that keep the page number. The plan is made before any model call, so a document
 * that cannot fit the configured chain is refused up front instead of being read partway.
 */
export function planChunks(pages: ReadonlyArray<Page>, maxBytes: number): PlannedChunk[] {
  if (maxBytes < 512) throw new PageInputError(`material budget of ${maxBytes} bytes is too small to read a document`);
  const pieces: Piece[] = [];
  for (const p of pages) {
    const body = hasText(p) ? p.text.trim() : "(no extractable text on this page)";
    const overhead = bytes(header({ page: p.page, part: 99, of: 99 })) + 2;
    const parts = splitText(body, Math.max(256, maxBytes - overhead));
    parts.forEach((t, i) => pieces.push({ page: p.page, part: i + 1, of: parts.length, text: t }));
  }
  const chunks: PlannedChunk[] = [];
  let cur: Piece[] = [];
  let size = 0;
  const flush = (): void => {
    if (cur.length === 0) return;
    const first = cur[0] as Piece;
    const last = cur[cur.length - 1] as Piece;
    const pageList = [...new Set(cur.map((c) => c.page))];
    const text = cur.map((c) => `${header(c)}\n${c.text}`).join("\n\n");
    chunks.push({ input: { label: first.page === last.page ? `page ${first.page}` : `pages ${first.page}-${last.page}`, text }, pages: pageList, pieces: cur });
    cur = [];
    size = 0;
  };
  for (const piece of pieces) {
    const cost = bytes(header(piece)) + bytes(piece.text) + 4;
    if (size + cost > maxBytes) flush();
    cur.push(piece);
    size += cost;
  }
  flush();
  return chunks;
}

/** "1-5, 9, 12-14" from a list of page numbers. */
export function pageRanges(pages: Iterable<number>): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b);
  if (sorted.length === 0) return "none";
  const parts: string[] = [];
  let start = sorted[0] as number;
  let prev = start;
  for (const n of sorted.slice(1)) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = prev = n;
  }
  parts.push(start === prev ? `${start}` : `${start}-${prev}`);
  return parts.join(", ");
}
