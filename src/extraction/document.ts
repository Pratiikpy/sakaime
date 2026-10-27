import type { EvidenceAnchor } from "../schemas/evidence.ts";
import { hashOf, sha256Hex } from "../util/canonical.ts";
import { buildKey, findAll, numericTokens, type MatchKey, type MatchTier } from "./normalize.ts";
import { sentenceSpans, type Span } from "./text.ts";
import {
  PAGE_SEPARATOR,
  type DocumentText,
  type NumberClaim,
  type PageText,
  type QuoteCheck,
  type TextLine,
} from "./types.ts";

export interface PageInput {
  text: string;
  lines?: TextLine[];
  textLayer?: "present" | "absent";
}

const PRINTED_LABEL = /\bPage\s+(\d+)\s+of\s+(\d+)\b/i;

function linesOf(text: string): TextLine[] {
  const out: TextLine[] = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    if (raw.trim().length > 0) out.push({ start: pos, end: pos + raw.length });
    pos += raw.length + 1;
  }
  return out;
}

/**
 * Build the document model from page texts. Page numbers are the 1-based physical order of `pages`, so they are
 * stable for a given file. A page with no text keeps its number and is marked as having no text layer.
 */
export function documentFromPages(recordId: string, pages: PageInput[], origin: DocumentText["origin"]): DocumentText {
  const built: PageText[] = [];
  const warnings: string[] = [];
  let cursor = 0;
  pages.forEach((p, i) => {
    // Line endings are normalised once, here, so every offset in the model refers to the same characters.
    const text = p.lines ? p.text : p.text.replace(/\r\n?/g, "\n");
    const present = (p.textLayer ?? (text.trim().length > 0 ? "present" : "absent")) === "present";
    const label = PRINTED_LABEL.exec(text);
    const page: PageText = {
      page: i + 1,
      text,
      start: cursor,
      end: cursor + text.length,
      lines: p.lines ?? linesOf(text),
      textLayer: present ? "present" : "absent",
      ...(label ? { printedLabel: label[0] } : {}),
    };
    if (!present) warnings.push(`page ${i + 1} has no text layer; it was not read and nothing was inferred from it`);
    built.push(page);
    cursor += text.length + PAGE_SEPARATOR.length;
  });
  const text = built.map((p) => p.text).join(PAGE_SEPARATOR);
  return {
    recordId,
    pages: built,
    text,
    textHash: sha256Hex(text),
    origin,
    warnings,
  };
}

export interface FieldInput {
  /** JSON path of the field in the stored record, for example $.protocolSection.eligibilityModule.minimumAge. */
  path: string;
  /** The field's text exactly as the record holds it. */
  text: string;
  label?: string;
}

/**
 * A structured record seen as text: one "page" per field. Quote checks and anchors then work exactly as they do for
 * a PDF, and an anchor names the field by JSON path. Empty fields are dropped, not invented.
 */
export function documentFromFields(recordId: string, fields: FieldInput[]): DocumentText {
  const kept = fields.filter((f) => f.text.trim().length > 0);
  const doc = documentFromPages(
    recordId,
    kept.map((f) => ({ text: f.text, lines: [{ start: 0, end: f.text.length }] })),
    "text",
  );
  return { ...doc, origin: "fields", fieldPaths: kept.map((f) => f.path), fieldLabels: kept.map((f) => f.label ?? "") };
}

/** Text extracted elsewhere (for example `pdftotext -layout`), with pages separated by form feeds. */
export function documentFromText(recordId: string, text: string): DocumentText {
  const parts = text.split("\f");
  if (parts.length > 1 && (parts[parts.length - 1] as string).trim() === "") parts.pop();
  return documentFromPages(
    recordId,
    parts.map((t) => ({ text: t })),
    "text",
  );
}

export function pageByNumber(doc: DocumentText, page: number): PageText | undefined {
  return doc.pages[page - 1];
}

/** Map an offset in DocumentText.text to its page and the offset inside that page. */
export function locateOffset(doc: DocumentText, offset: number): { page: number; local: number } | undefined {
  if (offset < 0 || offset > doc.text.length) return undefined;
  let lo = 0;
  let hi = doc.pages.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const p = doc.pages[mid] as PageText;
    if (offset < p.start) hi = mid - 1;
    else if (offset > p.end) lo = mid + 1;
    else return { page: p.page, local: offset - p.start };
  }
  return undefined;
}

// ----------------------------------------------------------------------------------------------- anchors

export function makeAnchor(doc: DocumentText, page: number, start: number, end: number): EvidenceAnchor {
  const p = pageByNumber(doc, page);
  if (!p) throw new RangeError(`page ${page} does not exist in ${doc.recordId}`);
  if (start < 0 || end > p.text.length || end <= start) throw new RangeError(`range ${start}-${end} is outside page ${page}`);
  const text = p.text.slice(start, end);
  if (text.trim().length === 0) throw new RangeError("an anchor cannot be blank");
  const textHash = sha256Hex(text);
  const boxes = p.lines.filter((l) => l.bbox && l.end > start && l.start < end).map((l) => l.bbox as [number, number, number, number]);
  const region: [number, number, number, number] | undefined = boxes.length
    ? [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ]
    : undefined;
  const jsonPath = doc.fieldPaths?.[page - 1];
  return {
    id: `anc_${hashOf({ r: doc.recordId, p: jsonPath ?? page, s: start, h: textHash }).slice(0, 20)}`,
    recordId: doc.recordId,
    ...(jsonPath !== undefined ? { jsonPath } : { page }),
    text,
    textHash,
    ...(region ? { region } : {}),
  };
}

// --------------------------------------------------------------------------------------------- quote check

interface PageKeys {
  normalized?: MatchKey;
  damage?: MatchKey;
}
const keyCache = new WeakMap<object, PageKeys>();

function keyFor(owner: object, text: string, tier: Exclude<MatchTier, "verbatim">): MatchKey {
  let entry = keyCache.get(owner);
  if (!entry) {
    entry = {};
    keyCache.set(owner, entry);
  }
  if (tier === "normalized") return (entry.normalized ??= buildKey(text, "normalized"));
  return (entry.damage ??= buildKey(text, "damage_tolerant"));
}

function findOnPage(page: PageText, quote: string): { start: number; end: number; tier: MatchTier; occurrences: number } | undefined {
  const exact = page.text.indexOf(quote);
  if (exact >= 0) {
    let count = 0;
    // the count only flags an ambiguous anchor, so it stops at 100
    for (let at = page.text.indexOf(quote); at >= 0 && count < 100; at = page.text.indexOf(quote, at + quote.length)) count++;
    return { start: exact, end: exact + quote.length, tier: "verbatim", occurrences: count };
  }
  for (const tier of ["normalized", "damage_tolerant"] as const) {
    const needle = buildKey(quote, tier).key.trim();
    if (needle.length === 0) continue;
    const hits = findAll(keyFor(page, page.text, tier), needle);
    if (hits.length > 0) {
      const first = hits[0] as { start: number; end: number };
      return { start: first.start, end: first.end, tier, occurrences: hits.length };
    }
  }
  return undefined;
}

/** Numeric value of a token as printed: "1,234" is a thousand separator, "0,5" a decimal comma. */
export function parseNumberToken(token: string): number {
  if (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(token)) return Number(token.replace(/,/g, ""));
  return Number(token.replace(",", "."));
}

function claimAppears(passage: string, claim: NumberClaim): boolean {
  const target = claim.form === "percent" ? claim.value * 100 : claim.value;
  const tol = 1e-9 * Math.max(1, Math.abs(target));
  if (numericTokens(passage).some((t) => Math.abs(parseNumberToken(t) - target) <= tol)) return true;
  // a count may be written as a word: "three medical centers"
  if (claim.form === "count" && Number.isInteger(target) && target >= 1 && target <= 20) {
    const words = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
    return new RegExp(String.raw`\b${words[target - 1]}\b`, "i").test(passage);
  }
  return false;
}

/**
 * Check 1 of 2: does the quoted passage exist verbatim in the stored page text?
 *
 * Matching tolerates whitespace, line-end hyphenation, typographic dashes and ligature glyphs, and records which tier
 * was needed. It never tolerates a different digit, sign or decimal point: the matched text must carry exactly the
 * numeric tokens the quote carries. Each number the assertion states must also appear in the passage.
 */
export function checkQuoteExists(
  doc: DocumentText,
  input: { quote?: string; page?: number; numbers?: NumberClaim[] },
): QuoteCheck {
  const quote = input.quote;
  if (quote === undefined) return { exists: false, reason: "UNQUOTED" };
  if (quote.trim().length === 0) return { exists: false, reason: "EMPTY_QUOTE" };
  const wanted = quote.trim();

  const order: PageText[] = [];
  if (input.page !== undefined) {
    const named = pageByNumber(doc, input.page);
    if (named) order.push(named);
  } else {
    order.push(...doc.pages);
  }

  for (const page of order) {
    if (page.textLayer === "absent") continue;
    const hit = findOnPage(page, wanted);
    if (!hit) continue;
    const verbatim = page.text.slice(hit.start, hit.end);
    const a = numericTokens(wanted);
    const b = numericTokens(verbatim);
    if (a.length !== b.length || a.some((t, i) => t !== b[i])) {
      return { exists: false, reason: "DIGIT_GUARD", detail: `quote numbers [${a.join(", ")}] vs page numbers [${b.join(", ")}]` };
    }
    for (const claim of input.numbers ?? []) {
      if (!claimAppears(verbatim, claim)) {
        return { exists: false, reason: "NUMBER_NOT_IN_QUOTE", detail: `${claim.value} (${claim.form}) is not shown in the passage` };
      }
    }
    return { exists: true, page: page.page, start: hit.start, end: hit.end, verbatim, tier: hit.tier, occurrences: hit.occurrences };
  }

  if (input.page !== undefined) {
    for (const page of doc.pages) {
      if (page.page === input.page || page.textLayer === "absent") continue;
      if (findOnPage(page, wanted)) {
        return { exists: false, reason: "PAGE_MISMATCH", detail: `the passage is on page ${page.page}, not page ${input.page}` };
      }
    }
  }

  // Not on any single page. A passage that continues across a page break is a different, named failure.
  const needle = buildKey(wanted, "normalized").key.trim();
  if (needle.length > 0 && findAll(keyFor(doc, doc.text, "normalized"), needle).length > 0) {
    return { exists: false, reason: "SPANS_PAGES", detail: "the passage crosses a page break; quote one page" };
  }
  return { exists: false, reason: "NOT_FOUND" };
}

// ------------------------------------------------------------------------------------------ OCR damage

export interface DamageHit {
  kind: "replacement_char" | "private_use" | "glued_symbol" | "digit_in_word";
  text: string;
  index: number;
}

/**
 * Flags text that looks damaged by OCR or font mapping. A flag lowers trust in the passage; it never edits it.
 * Seen in the FDA summaries: "Transpara@", "meti\uFFFDic", "repo1ts", "Ground Trnth" (letters lost, not detectable by pattern).
 */
export function detectOcrDamage(text: string): DamageHit[] {
  const hits: DamageHit[] = [];
  const add = (kind: DamageHit["kind"], re: RegExp) => {
    for (const m of text.matchAll(re)) hits.push({ kind, text: m[0], index: m.index ?? 0 });
  };
  add("replacement_char", /\uFFFD/g);
  add("private_use", /[\uE000-\uF8FF]/g);
  // anchored at a word start: an unanchored \p{L}{3,} rescans a long word from every position (quadratic)
  add("glued_symbol", /(?<!\p{L})\p{L}{3,}@(?!\p{L})/gu);
  // a single digit inside a lowercase word: "repo1ts". Identifiers such as K200667 or COVID19 are not lowercase words.
  add("digit_in_word", /\b[a-z]{3,}[01][a-z]{2,}\b/g);
  return hits;
}

/**
 * Some PDF fonts map the "ti" and "ft" ligatures to unrelated letters, so "patient" reads "pa\u019Fent" and "after"
 * reads "a\u014Cer". Both glyphs are repaired only when they sit between two lowercase letters, which a real
 * "\u019F" or "\u014C" almost never does. Returns how many were replaced; the caller records that in the document
 * warnings, so a repaired text is never mistaken for the raw one.
 */
export function repairGlyphs(text: string): { text: string; replaced: number } {
  let replaced = 0;
  const out = text
    .replace(/(?<=\p{Ll})\u019F(?=\p{Ll})/gu, () => (replaced++, "ti"))
    .replace(/(?<=\p{Ll})\u014C(?=\p{Ll})/gu, () => (replaced++, "ft"));
  return { text: out, replaced };
}

const spanCache = new WeakMap<PageText, Span[]>();

/** Sentence spans of a page, computed once per page object. */
export function pageSpans(page: PageText): Span[] {
  let spans = spanCache.get(page);
  if (!spans) {
    spans = sentenceSpans(page.text);
    spanCache.set(page, spans);
  }
  return spans;
}
