/** Small text utilities shared by the parsers and the support rules. Pure functions, no state. */

export interface Span {
  start: number;
  end: number;
}

const ABBREVIATIONS = new Set([
  "e.g",
  "i.e",
  "vs",
  "approx",
  "fig",
  "figs",
  "no",
  "nos",
  "dr",
  "inc",
  "ltd",
  "co",
  "corp",
  "al",
  "etc",
  "u.s",
  "ph.d",
  "m.d",
  "st",
  "mr",
  "ms",
  "cf",
  "ca",
  "resp",
  "sec",
  "ref",
  "eq",
  "ver",
]);

/** "Sensitivity - 87%": a short label, a separator and one number. */
const KEY_VALUE_ROW = /^\s{0,8}[A-Za-z][\w ()/&-]{1,45}\s*[:=\uFFFD\u2013\u2014]\s*[<>~]?\s*\d[\d.,]*\s*%?\s*$/;

const SMALL_WORDS = new Set(["of", "and", "the", "for", "to", "in", "a", "on", "with", "or", "&", "/", "-", "by", "at", "vs"]);

/** A short title-cased or upper-case line with no sentence punctuation. */
export function looksLikeHeading(raw: string): boolean {
  const t = raw.trim();
  if (t.length < 3 || t.length > 60) return false;
  if (/[.,;]$/.test(t) || /\d{2,}%/.test(t)) return false;
  const words = t.replace(/:$/, "").split(/\s+/);
  if (words.length > 8) return false;
  return words.every((w) => SMALL_WORDS.has(w.toLowerCase()) || /^[A-Z0-9(\[]/.test(w));
}

/**
 * Sentence-like spans of a page. A table row (a line holding a wide gap) is its own span, so a number is judged
 * against its row and not against a neighbouring row. Prose lines are joined across line breaks and split at
 * sentence ends that are not abbreviations or decimals. Offsets are into `text`.
 */
/** No real sentence or table row is longer than this; a longer run is a text-layer fault, not prose. */
export const MAX_SPAN = 4000;

/** Split an over-long span at the last whitespace before each MAX_SPAN boundary, so every rule works on bounded text. */
function capSpan(text: string, span: Span): Span[] {
  if (span.end - span.start <= MAX_SPAN) return [span];
  const out: Span[] = [];
  let from = span.start;
  while (span.end - from > MAX_SPAN) {
    let cut = from + MAX_SPAN;
    const ws = text.lastIndexOf(" ", cut);
    if (ws > from + MAX_SPAN / 2) cut = ws;
    out.push(trimSpan(text, from, cut));
    from = cut;
  }
  out.push(trimSpan(text, from, span.end));
  return out.filter((x) => x.end > x.start);
}

export function sentenceSpans(text: string): Span[] {
  const spans: Span[] = [];
  // paragraphs: runs of non-blank lines, with table-like lines split out
  const lines: { start: number; end: number; raw: string }[] = [];
  let pos = 0;
  for (const raw of text.split("\n")) {
    lines.push({ start: pos, end: pos + raw.length, raw });
    pos += raw.length + 1;
  }
  const standalone = (idx: number): boolean => {
    const raw = (lines[idx] as { raw: string }).raw;
    if (/\S {3,}\S/.test(raw)) return true; // a table row
    if (KEY_VALUE_ROW.test(raw)) return true; // "Sensitivity - 87%"
    const prev = idx > 0 ? (lines[idx - 1] as { raw: string }).raw.trim() : "";
    const next = idx + 1 < lines.length ? (lines[idx + 1] as { raw: string }).raw.trim() : "";
    // a heading begins a block (after a blank line or a sentence end) and is followed by a capitalised start
    return looksLikeHeading(raw) && (prev === "" || /[.:;)]$/.test(prev)) && (next === "" || /^[A-Z0-9(]/.test(next));
  };
  let i = 0;
  while (i < lines.length) {
    const ln = lines[i] as { start: number; end: number; raw: string };
    if (ln.raw.trim() === "") {
      i++;
      continue;
    }
    if (standalone(i)) {
      spans.push(trimSpan(text, ln.start, ln.end));
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < lines.length) {
      const nxt = lines[j + 1] as { raw: string };
      if (nxt.raw.trim() === "" || standalone(j + 1)) break;
      j++;
    }
    const startOff = ln.start;
    const endOff = (lines[j] as { end: number }).end;
    for (const s of splitSentences(text, startOff, endOff)) spans.push(s);
    i = j + 1;
  }
  return spans.filter((s) => s.end > s.start).flatMap((s) => capSpan(text, s));
}

function trimSpan(text: string, start: number, end: number): Span {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s] as string)) s++;
  while (e > s && /\s/.test(text[e - 1] as string)) e--;
  return { start: s, end: e };
}

function splitSentences(text: string, start: number, end: number): Span[] {
  const out: Span[] = [];
  let from = start;
  const re = /[.!?]["')\]]?\s+(?=[A-Z0-9(\[])/g;
  const slice = text.slice(start, end);
  for (const m of slice.matchAll(re)) {
    const at = start + (m.index as number) + 1; // just after the terminator
    const before = text.slice(from, at - 1);
    const rawWord = /([A-Za-z.]+)$/.exec(before)?.[1]?.replace(/\.$/, "") ?? "";
    // "Dr." is an abbreviation; "IDx-DR." ends a sentence, so an all-capitals word is never one
    const allCaps = rawWord.length >= 2 && rawWord === rawWord.toUpperCase() && !rawWord.includes(".");
    const word = allCaps ? "" : rawWord.toLowerCase();
    const prevChar = text[at - 2];
    const isDecimal = prevChar !== undefined && /\d/.test(prevChar) && /\d/.test(text[at + (m[0].length - 1)] ?? "");
    if (ABBREVIATIONS.has(word) || (word.length === 1 && /[A-Za-z]/.test(word)) || isDecimal) continue;
    out.push(trimSpan(text, from, at));
    from = start + (m.index as number) + m[0].length;
  }
  out.push(trimSpan(text, from, end));
  return out;
}

export function spanAt(spans: Span[], offset: number): Span | undefined {
  return spans.find((s) => offset >= s.start && offset < s.end);
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
};

/** "three" -> 3, "12" -> 12, "1,385" -> 1385. Undefined for anything else; never guesses. */
export function parseCount(token: string): number | undefined {
  const t = token.trim().toLowerCase();
  if (t in WORD_NUMBERS) return WORD_NUMBERS[t];
  if (/^\d{1,3}(,\d{3})+$/.test(t)) return Number(t.replace(/,/g, ""));
  if (/^\d+$/.test(t)) return Number(t);
  return undefined;
}

export const COUNT_WORD_PATTERN = Object.keys(WORD_NUMBERS).join("|");

export function collapseSpace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
