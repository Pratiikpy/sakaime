/**
 * Matching keys for quote verification.
 *
 * A quote that a model or a parser reports is compared with the stored page text through a key: a reduced form of
 * both strings that ignores layout and encoding noise (line breaks, runs of spaces, hyphenation at line ends,
 * typographic dashes and quotes, ligature glyphs). The key is only used to FIND the passage. The anchor always
 * stores the original characters of the page, so "verbatim" stays literally true.
 *
 * Invariant (property-tested): a key never adds, removes, reorders or rewrites a digit, a decimal point or a
 * numeric sign. Hyphens are removed only between two letters. Case is never folded.
 */

export type MatchTier = "verbatim" | "normalized" | "damage_tolerant";

export interface MatchKey {
  key: string;
  /** For each key character, the index in the original string of the character it came from. */
  start: number[];
  /** For each key character, the index just after the last original character it covers. */
  end: number[];
}

const LIGATURES: Record<string, string> = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
  "\uFB05": "st",
  "\uFB06": "st",
};

const HYPHENS = new Set(["-", "\u2010", "\u2011", "\u2012", "\u2013", "\u2014", "\u2212", "\uFE63", "\uFF0D"]);
const SOFT_HYPHEN = "\u00AD";
/** Glyph damage seen in the FDA summaries: replacement characters, private-use bullets, registered marks. */
const DAMAGE = /[\uFFFD\uE000-\uF8FF\u00AE\u2122\u00A9\u2020\u2021\u00B6]/;

function isLetter(c: string | undefined): boolean {
  return c !== undefined && /\p{L}/u.test(c);
}
function isDigit(c: string | undefined): boolean {
  return c !== undefined && c >= "0" && c <= "9";
}
function isSpace(c: string): boolean {
  return /[\s\u00A0\u2000-\u200B\u202F\u205F\u3000\uFEFF]/.test(c);
}

function mapQuote(c: string): string {
  if ("\u2018\u2019\u201A\u201B\u2032`\u00B4".includes(c)) return "'";
  if ("\u201C\u201D\u201E\u201F\u2033\u00AB\u00BB".includes(c)) return '"';
  return c;
}

/**
 * Build the key. `tier` "damage_tolerant" additionally drops damage glyphs, and an "@" that is glued to the end of
 * a word (the registered mark read as "Transpara@"). Digits, signs and decimal points are never touched.
 */
export function buildKey(text: string, tier: Exclude<MatchTier, "verbatim"> = "normalized"): MatchKey {
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  const push = (c: string, s: number, e: number) => {
    chars.push(c);
    start.push(s);
    end.push(e);
  };

  let i = 0;
  while (i < text.length) {
    const c = text[i] as string;

    if (isSpace(c)) {
      let j = i;
      while (j < text.length && isSpace(text[j] as string)) j++;
      if (chars.length > 0 && chars[chars.length - 1] !== " ") push(" ", i, j);
      i = j;
      continue;
    }

    if (c === SOFT_HYPHEN) {
      i++;
      continue;
    }

    if (HYPHENS.has(c)) {
      // Look at the nearest non-space characters on both sides. A hyphen between two letters is either a line-end
      // break ("non-\nproliferative") or an ordinary compound; both reduce to the joined word.
      let k = i - 1;
      while (k >= 0 && isSpace(text[k] as string)) k--;
      let n = i + 1;
      let newlineAfter = false;
      while (n < text.length && isSpace(text[n] as string)) {
        if (text[n] === "\n" || text[n] === "\r" || text[n] === "\f") newlineAfter = true;
        n++;
      }
      const prev = k >= 0 ? text[k] : undefined;
      const next = n < text.length ? text[n] : undefined;
      const glued = k === i - 1; // no space before the hyphen
      const joinsLetters = glued && isLetter(prev) && isLetter(next) && (n === i + 1 || newlineAfter);
      if (joinsLetters) {
        i = n; // drop the hyphen and the break that follows it
        continue;
      }
      // A hyphen at the end of a line between digits keeps the hyphen and drops only the break after it.
      push("-", i, i + 1);
      if (newlineAfter && n > i + 1) i = n;
      else i++;
      continue;
    }

    const lig = LIGATURES[c];
    if (lig !== undefined) {
      for (const ch of lig) push(ch, i, i + 1);
      i++;
      continue;
    }

    if (tier === "damage_tolerant") {
      // A damage glyph beside a digit or a decimal point is kept, not dropped: dropping it could join "1" and "2" into
      // "12" or turn "0." and "0" into "0.0", which would change a number. Everywhere else it is noise.
      const numericNeighbour = /[\d.,%]/.test(text[i - 1] ?? "") || /[\d.,]/.test(text[i + 1] ?? "");
      if (DAMAGE.test(c) && !numericNeighbour) {
        i++;
        continue;
      }
      if (c === "@" && isLetter(text[i - 1]) && !isLetter(text[i + 1])) {
        i++;
        continue;
      }
    }

    push(mapQuote(c), i, i + 1);
    i++;
  }

  return compactRangeSpaces({ key: chars.join(""), start, end });
}

/**
 * "81.2 - 92.5" and "81.2-92.5" are the same range. A space beside a hyphen is removed only when the hyphen sits
 * between a number (digit, percent sign or closing bracket) and a digit, so no sign is changed: "was -3" keeps its
 * space and its sign.
 */
function compactRangeSpaces(k: MatchKey): MatchKey {
  const { key } = k;
  const numericEnd = (c: string | undefined) => isDigit(c) || c === "%" || c === ")" || c === "]";
  const chars: string[] = [];
  const start: number[] = [];
  const end: number[] = [];
  for (let i = 0; i < key.length; i++) {
    const c = key[i] as string;
    if (c === " ") {
      const prev = key[i - 1];
      const next = key[i + 1];
      if (next === "-" && numericEnd(prev)) {
        const after = key[i + 2] === " " ? key[i + 3] : key[i + 2];
        if (isDigit(after)) continue;
      }
      if (prev === "-" && isDigit(next)) {
        const before = key[i - 2] === " " ? key[i - 3] : key[i - 2];
        if (numericEnd(before)) continue;
      }
    }
    chars.push(c);
    start.push(k.start[i] as number);
    end.push(k.end[i] as number);
  }
  return { key: chars.join(""), start, end };
}

export interface KeyMatch {
  /** Offsets into the ORIGINAL haystack. */
  start: number;
  end: number;
}

/** All non-overlapping occurrences of `needleKey` in `hay`, mapped back to the original characters. */
export function findAll(hay: MatchKey, needleKey: string, limit = 100): KeyMatch[] {
  const out: KeyMatch[] = [];
  if (needleKey.length === 0) return out;
  let from = 0;
  for (;;) {
    const at = hay.key.indexOf(needleKey, from);
    if (at < 0 || out.length >= limit) break;
    const last = at + needleKey.length - 1;
    out.push({ start: hay.start[at] as number, end: hay.end[last] as number });
    from = at + needleKey.length;
  }
  return out;
}

/** The numeric tokens of a string, in order: "81.2", "92.5", "0,5". Used as the digit guard around every match. */
export function numericTokens(text: string): string[] {
  // ".91" is a number too: reports often drop the leading zero of a proportion
  return text.match(/\d+(?:[.,]\d+)*|(?<!\d)\.\d+/g) ?? [];
}
