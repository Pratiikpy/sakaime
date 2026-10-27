/**
 * Text preparation for the guard. Matching runs on normalised views of the text, and every match is mapped
 * back to the span of the ORIGINAL text, so a finding can show the reviewer exactly what a document said.
 *
 * Views:
 *   primary   NFKC, invisible characters removed, look-alike letters folded to Latin, lower case, whitespace collapsed
 *   folded    primary with digit/symbol substitutions undone inside words and spaced-out letters joined
 *   decoded   text recovered from base64, percent-encoding, HTML entities and \u escapes found in the original
 * An attack that only matches after normalisation is itself evidence, and is flagged as obfuscation.
 */

export interface Mapped {
  text: string;
  /** start[i]: index in the original text of the character that produced text[i]. */
  start: number[];
  /** end[i]: index just after that original character. */
  end: number[];
}

export interface View {
  label: "primary" | "folded" | `decoded:${string}`;
  m: Mapped;
  /** For a decoded view, the span of the original that held the encoded form. */
  encodedSpan?: [number, number];
}

export interface Analysis {
  raw: string;
  views: View[];
  /** Character-level evidence that the text was disguised or hides content. */
  flags: string[];
  /** Spans of the original that sit in comments or invisible markup. */
  hiddenSpans: [number, number][];
}

const cp = (...c: number[]): string => String.fromCodePoint(...c);

/** Characters that render as nothing or change direction. */
const INVISIBLE = new RegExp(`[${cp(0xad)}${cp(0x200b)}-${cp(0x200f)}${cp(0x202a)}-${cp(0x202e)}${cp(0x2060)}-${cp(0x2064)}${cp(0x2066)}-${cp(0x2069)}${cp(0xfeff)}${cp(0x180e)}]`);
const BIDI = new RegExp(`[${cp(0x202a)}-${cp(0x202e)}${cp(0x2066)}-${cp(0x2069)}]`);

/** Cyrillic and Greek letters that are drawn like Latin ones. */
const HOMOGLYPHS: Record<number, string> = {
  0x0430: "a", 0x0435: "e", 0x043e: "o", 0x0440: "p", 0x0441: "c", 0x0445: "x", 0x0443: "y", 0x0456: "i", 0x0458: "j", 0x0455: "s", 0x0501: "d", 0x04bb: "h",
  0x0406: "i", 0x0408: "j", 0x0405: "s", 0x0404: "e", 0x0410: "a", 0x0412: "b", 0x0415: "e", 0x041a: "k", 0x041c: "m", 0x041d: "h", 0x041e: "o", 0x0420: "p", 0x0421: "c", 0x0422: "t", 0x0425: "x", 0x0423: "y",
  0x03bf: "o", 0x03b1: "a", 0x03b5: "e", 0x03b9: "i", 0x03bd: "v", 0x03c1: "p", 0x03c4: "t", 0x03c5: "u", 0x039f: "o", 0x0391: "a", 0x0395: "e", 0x0399: "i", 0x039a: "k", 0x039c: "m", 0x039d: "n", 0x03a1: "p", 0x03a4: "t",
};

/** Typographic quotes and dashes, folded so that patterns written with plain ones match. */
const PUNCT: Record<number, string> = { 0x2018: "'", 0x2019: "'", 0x02bc: "'", 0x201c: '"', 0x201d: '"', 0x2010: "-", 0x2011: "-", 0x2012: "-", 0x2013: "-", 0x2014: "-", 0x2015: "-", 0x2212: "-" };

export function mapped(text: string): Mapped {
  return { text, start: Array.from({ length: text.length }, (_, i) => i), end: Array.from({ length: text.length }, (_, i) => i + 1) };
}

const isBreak = (c: string): boolean => c === "\n" || c === "\r";

/** Build the primary view. Returns the flags it noticed along the way. */
export function primaryView(raw: string): { m: Mapped; flags: string[] } {
  const flags = new Set<string>();
  const text: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  let at = 0;
  for (const ch of raw) {
    const s = at;
    const e = at + ch.length;
    at = e;
    if (INVISIBLE.test(ch)) {
      flags.add("hidden-characters");
      if (BIDI.test(ch)) flags.add("bidi-control");
      continue;
    }
    for (const c0 of ch.normalize("NFKC")) {
      const code = c0.codePointAt(0) as number;
      const fold = HOMOGLYPHS[code];
      if (fold !== undefined) flags.add("homoglyphs");
      const lowered = (fold ?? PUNCT[code] ?? c0).toLowerCase();
      for (const c of lowered) {
        const space = /\s/.test(c);
        const last = text[text.length - 1];
        if (space && (last === " " || last === "\n")) {
          // A run of whitespace becomes one character; a run that contains a line break stays a line break.
          if (isBreak(c)) text[text.length - 1] = "\n";
          end[end.length - 1] = e;
          continue;
        }
        text.push(space ? (isBreak(c) ? "\n" : " ") : c);
        start.push(s);
        end.push(e);
      }
    }
  }
  while (text.length && /\s/.test(text[0] as string)) {
    text.shift();
    start.shift();
    end.shift();
  }
  while (text.length && /\s/.test(text[text.length - 1] as string)) {
    text.pop();
    start.pop();
    end.pop();
  }
  return { m: { text: text.join(""), start, end }, flags: [...flags] };
}

const LEET: Record<string, string> = { "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t" };

/** Undo digit and symbol substitutions inside words, and join letters spaced apart ("i g n o r e"). */
export function foldedView(p: Mapped): { m: Mapped; changed: boolean; flags: string[] } {
  const flags: string[] = [];
  const t = p.text.split("");
  let changed = false;
  // Only tokens that are mostly letters are read as disguised words; identifiers such as K200667 are left alone.
  for (const m of p.text.matchAll(/[a-z0-9]+/g)) {
    const tok = m[0];
    const letters = (tok.match(/[a-z]/g) ?? []).length;
    const subs = (tok.match(/[013457]/g) ?? []).length;
    if (letters >= 2 && letters >= tok.length / 2 && subs >= 1 && /[a-z][013457]|[013457][a-z]/.test(tok)) {
      for (let i = 0; i < tok.length; i++) {
        const sub = LEET[tok[i] as string];
        if (sub) {
          t[(m.index as number) + i] = sub;
          changed = true;
        }
      }
    }
  }
  if (changed) flags.push("leetspeak");
  let text = t.join("");
  let start = p.start;
  let end = p.end;
  const drop = new Set<number>();
  for (const m of text.matchAll(/(?<![a-z])(?:[a-z][ ._-]){3,}[a-z](?![a-z])/g)) {
    const idx = m.index as number;
    for (let i = 0; i < m[0].length; i++) if (!/[a-z]/.test(m[0][i] as string)) drop.add(idx + i);
  }
  if (drop.size > 0) {
    flags.push("spaced-letters");
    changed = true;
    const chars = [...text];
    const keep = chars.map((_, i) => !drop.has(i));
    text = chars.filter((_, i) => keep[i]).join("");
    start = start.filter((_, i) => keep[i]);
    end = end.filter((_, i) => keep[i]);
  }
  return { m: { text, start, end }, changed, flags };
}

// ---------------------------------------------------------------- decoded payloads

const NAMED: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'", nbsp: " " };

function printableShare(s: string): number {
  if (s.length === 0) return 0;
  let ok = 0;
  for (const c of s) {
    const n = c.codePointAt(0) as number;
    if ((n >= 32 && n < 127) || n === 10 || n === 13 || n === 9) ok++;
  }
  return ok / s.length;
}

function safeCp(n: number, fallback: string): string {
  return Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : fallback;
}

/** Text hidden in an encoding, each with the span of the original that held it. */
export function decodedViews(raw: string): { label: string; text: string; span: [number, number] }[] {
  const out: { label: string; text: string; span: [number, number] }[] = [];
  for (const m of raw.matchAll(/[A-Za-z0-9+/]{24,}={0,2}/g)) {
    const blob = m[0];
    if (blob.length % 4 !== 0 && !blob.endsWith("=")) continue;
    const dec = Buffer.from(blob, "base64").toString("utf8");
    if (dec.length >= 12 && printableShare(dec) >= 0.9 && /[a-z]{3,}\s+[a-z]{3,}/i.test(dec)) {
      out.push({ label: "decoded:base64", text: dec, span: [m.index as number, (m.index as number) + blob.length] });
    }
  }
  if ((raw.match(/%[0-9a-fA-F]{2}/g) ?? []).length >= 3) {
    try {
      const dec = decodeURIComponent(raw);
      if (dec !== raw) out.push({ label: "decoded:percent", text: dec, span: [0, raw.length] });
    } catch {
      /* malformed escapes are not a payload */
    }
  }
  if (/&(?:#x?[0-9a-fA-F]+|[a-z]+);/.test(raw)) {
    const dec = raw.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|([a-z]+));/g, (all: string, d?: string, h?: string, n?: string) => {
      if (d) return safeCp(Number(d), all);
      if (h) return safeCp(parseInt(h, 16), all);
      return (n && NAMED[n]) || all;
    });
    if (dec !== raw) out.push({ label: "decoded:entities", text: dec, span: [0, raw.length] });
  }
  if (/\\u[0-9a-fA-F]{4}|\\x[0-9a-fA-F]{2}/.test(raw)) {
    const dec = raw.replace(/\\u([0-9a-fA-F]{4})|\\x([0-9a-fA-F]{2})/g, (all: string, u?: string, x?: string) => safeCp(parseInt((u ?? x) as string, 16), all));
    if (dec !== raw) out.push({ label: "decoded:escapes", text: dec, span: [0, raw.length] });
  }
  return out;
}

const HIDDEN_MARKUP: RegExp[] = [
  /<!--[\s\S]*?-->/g,
  /<[a-z]+[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0|color\s*:\s*(?:#fff(?:fff)?|white))[^"']*["'][^>]*>[\s\S]*?<\/[a-z]+>/gi,
  /<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi,
];

export function analyse(raw: string, maxLength = 200_000): Analysis {
  const text = raw.length > maxLength ? raw.slice(0, maxLength) : raw;
  const { m: primary, flags } = primaryView(text);
  const views: View[] = [{ label: "primary", m: primary }];
  const folded = foldedView(primary);
  if (folded.changed) {
    views.push({ label: "folded", m: folded.m });
    flags.push(...folded.flags);
  }
  for (const d of decodedViews(text)) {
    const dp = primaryView(d.text);
    views.push({ label: d.label as View["label"], m: dp.m, encodedSpan: d.span });
    const df = foldedView(dp.m);
    if (df.changed) views.push({ label: d.label as View["label"], m: df.m, encodedSpan: d.span });
    flags.push("encoded-payload");
  }
  const hiddenSpans: [number, number][] = [];
  for (const re of HIDDEN_MARKUP) for (const m of text.matchAll(re)) hiddenSpans.push([m.index as number, (m.index as number) + m[0].length]);
  if (hiddenSpans.length) flags.push("hidden-markup");
  return { raw: text, views, flags: [...new Set(flags)], hiddenSpans };
}

/** The span of the original text that a match in a view corresponds to. */
export function originalSpan(v: View, s: number, e: number): [number, number] {
  if (v.encodedSpan) return v.encodedSpan;
  const a = v.m.start[s] ?? 0;
  const b = v.m.end[Math.max(s, e - 1)] ?? a;
  return [a, Math.max(b, a + 1)];
}

/** Common words, left out when comparing a request with an intent. */
export const STOPWORDS = new Set(
  "a an the and or but if then of to in on for with at by from as is are was were be been being this that these those it its i me my we our you your they their he she him her do does did can could should would will shall may might must not no yes so than too very just also please about into over under after before between through during each any all some".split(" "),
);

export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9][a-z0-9.'-]*/g) ?? [];
}

/** A light stemmer, enough to make "reviewing", "reviewed" and "reviews" the same feature. */
export function stem(w: string): string {
  let s = w.replace(/'s$/, "");
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ied")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  else if (s.length > 4 && s.endsWith("ies")) s = `${s.slice(0, -3)}y`;
  else if (s.length > 4 && s.endsWith("es")) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  return s;
}

export function contentStems(text: string): string[] {
  return tokens(text)
    .filter((t) => !STOPWORDS.has(t))
    .map(stem)
    .filter((t) => t.length > 1);
}
