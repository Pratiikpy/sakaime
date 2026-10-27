import { hashOf } from "../util/canonical.ts";
import type { DocumentText, PageText } from "./types.ts";
import { PAGE_SEPARATOR } from "./types.ts";

/**
 * Chunk iteration for long documents, for a reader that carries bounded state from one chunk to the next (the
 * Markovian reader in src/engines consumes these; nothing here reads or reasons).
 *
 * A chunk is a window of DocumentText.text. It keeps the mapping back to physical pages, so a limitation found in
 * chunk 7 is cited with the page it sits on. Chunking is deterministic: the same document and the same parameters
 * give the same chunks with the same ids.
 */
export interface ChunkPageSpan {
  page: number;
  /** Offsets into the chunk text. */
  chunkStart: number;
  chunkEnd: number;
  /** Offsets into the page text. */
  pageStart: number;
  pageEnd: number;
}

export interface Chunk {
  id: string;
  index: number;
  /** Offsets into DocumentText.text. */
  start: number;
  end: number;
  text: string;
  firstPage: number;
  lastPage: number;
  pages: ChunkPageSpan[];
}

function makeChunk(doc: DocumentText, index: number, start: number, end: number): Chunk {
  const text = doc.text.slice(start, end);
  const pages: ChunkPageSpan[] = [];
  for (const p of doc.pages) {
    const lo = Math.max(start, p.start);
    const hi = Math.min(end, p.end);
    if (hi > lo) pages.push({ page: p.page, chunkStart: lo - start, chunkEnd: hi - start, pageStart: lo - p.start, pageEnd: hi - p.start });
  }
  const first = pages[0]?.page ?? 0;
  const last = pages[pages.length - 1]?.page ?? first;
  return { id: `chk_${hashOf({ r: doc.recordId, h: doc.textHash, s: start, e: end }).slice(0, 16)}`, index, start, end, text, firstPage: first, lastPage: last, pages };
}

/**
 * Whole pages per chunk. `overlapPages` repeats the last pages of a chunk at the start of the next, so a statement
 * that runs over a page break is seen whole at least once.
 */
export function* chunkByPages(doc: DocumentText, pagesPerChunk: number, overlapPages = 0): Generator<Chunk> {
  if (!Number.isInteger(pagesPerChunk) || pagesPerChunk < 1) throw new RangeError("pagesPerChunk must be a positive integer");
  if (!Number.isInteger(overlapPages) || overlapPages < 0 || overlapPages >= pagesPerChunk) throw new RangeError("overlapPages must be between 0 and pagesPerChunk - 1");
  const step = pagesPerChunk - overlapPages;
  let index = 0;
  for (let i = 0; i < doc.pages.length; i += step) {
    const first = doc.pages[i] as PageText;
    const last = doc.pages[Math.min(i + pagesPerChunk, doc.pages.length) - 1] as PageText;
    yield makeChunk(doc, index++, first.start, last.end);
    if (i + pagesPerChunk >= doc.pages.length) break;
  }
}

/**
 * Fixed-size chunks that end at a paragraph or sentence break when one lies in the last 30% of the window, so a
 * sentence is not cut in half. A hard cut is the fallback. `overlapChars` repeats the tail of one chunk at the head of
 * the next.
 */
export function* chunkBySize(doc: DocumentText, maxChars: number, overlapChars = 0): Generator<Chunk> {
  if (!Number.isInteger(maxChars) || maxChars < 200) throw new RangeError("maxChars must be an integer of at least 200");
  if (!Number.isInteger(overlapChars) || overlapChars < 0 || overlapChars >= maxChars / 2) throw new RangeError("overlapChars must be below half of maxChars");
  const total = doc.text.length;
  let start = 0;
  let index = 0;
  while (start < total) {
    let end = Math.min(total, start + maxChars);
    if (end < total) {
      const window = doc.text.slice(start + Math.floor(maxChars * 0.7), end);
      const para = Math.max(window.lastIndexOf(PAGE_SEPARATOR), window.lastIndexOf("\n\n"));
      if (para >= 0) end = start + Math.floor(maxChars * 0.7) + para + 1;
      else {
        const sentence = [...window.matchAll(/[.!?]\s/g)].pop();
        if (sentence?.index !== undefined) end = start + Math.floor(maxChars * 0.7) + sentence.index + 1;
      }
    }
    yield makeChunk(doc, index++, start, end);
    if (end >= total) break;
    start = Math.max(start + 1, end - overlapChars);
  }
}

/** Map an offset inside a chunk's text to its page and the offset in that page's text. */
export function chunkOffsetToPage(chunk: Chunk, offset: number): { page: number; pageOffset: number } | undefined {
  const span = chunk.pages.find((p) => offset >= p.chunkStart && offset < p.chunkEnd);
  return span ? { page: span.page, pageOffset: span.pageStart + (offset - span.chunkStart) } : undefined;
}
