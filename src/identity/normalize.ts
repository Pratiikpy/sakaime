/**
 * Text, device-name and manufacturer normalisation.
 *
 * The inputs are real: the FDA AI list carries double-encoded registered marks ("MammoScreenÂ® (3)"), company
 * names in several spellings ("Viz.Al, Inc.", "Viz. ai, Inc."), cells that pack several devices, and summary
 * PDFs whose registered mark degrades to "@" or a replacement character. Every function here is total: any
 * string in gives a string out and nothing throws.
 */

/** Windows-1252 code points above 0x7F that are not also Latin-1, mapped back to their byte. */
const CP1252_TO_BYTE: ReadonlyMap<string, number> = new Map(
  Object.entries({
    "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87,
    "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91,
    "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98,
    "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f,
  }),
);

const MOJIBAKE_LEAD = /[ÂÃâ][\u0080-¿ŒœŠšŸŽžƒˆ˜–-›€™]/;

/**
 * Reverses UTF-8 text that was decoded as Windows-1252. Returns the input unchanged when it does not look
 * damaged or when the reverse decoding is not valid UTF-8, so correct text is never altered.
 */
export function repairMojibake(input: string): string {
  if (!MOJIBAKE_LEAD.test(input)) return input;
  const bytes: number[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0xff) bytes.push(cp);
    else {
      const b = CP1252_TO_BYTE.get(ch);
      if (b === undefined) return input;
      bytes.push(b);
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    return input;
  }
}

const MARKS = /[™®©℠\u0080-\u009f�]/g;
/** A registered mark that survived PDF extraction as "@" right after a word. */
const DEGRADED_MARK = /(?<=[A-Za-z0-9])@(?=[\s)\],;:]|$)/g;
/** A lone lead byte left behind when the mojibake could not be reversed. */
const STRAY_LEAD = /Â(?![A-Za-z0-9])/g;

/** Removes trademark and registered marks and the artefacts they leave. Case and spelling are untouched. */
export function stripMarks(input: string): string {
  return repairMojibake(input).replace(MARKS, "").replace(STRAY_LEAD, "").replace(DEGRADED_MARK, "");
}

/** Lower-case, diacritics and ligatures folded, marks stripped. Idempotent. */
export function foldText(input: string): string {
  return stripMarks(input)
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/\+(?=\s|$|[,;)])/g, " plus ");
}

/** Splits folded text on anything that is not a letter or digit. */
export function tokenize(folded: string): string[] {
  return folded.split(/[^\p{L}\p{N}]+/u).filter((t) => t.length > 0);
}

// ------------------------------------------------------------------------------------------ device names

/** Words that carry no identity: dropping them lets "HeartFlow Analysis Software" meet "HeartFlow Analysis". */
const NAME_STOPWORDS = new Set(["the", "a", "an", "of", "for", "with", "and", "software"]);

/** Version-like tokens inside a name, in the order they are removed. Each pattern has exactly one capture group. */
const VERSION_PATTERNS: { re: RegExp; render: (captured: string) => string }[] = [
  { re: /\(\s*v?\.?\s*(\d+(?:\.\d+)+(?:\.[xyz*])?)\s*\)/gi, render: (c) => c },
  { re: /\bversion\s+([a-z0-9]+(?:\.[a-z0-9]+)*)\b/gi, render: (c) => c },
  { re: /\bv\.?\s*(\d+(?:\.\d+)*(?:\.[xyz*])?)(?=\W|$)/gi, render: (c) => c },
  { re: /(?<![\w.])(\d+\.\d+(?:\.\d+){0,2}(?:\.[xyz*])?)(?![\w]|\.\w)/gi, render: (c) => c },
  { re: /\(\s*(\d{1,2})\s*\)/g, render: (c) => `(${c})` },
  { re: /\(\s*(\d{4})\s*\)/g, render: (c) => `alg:${c}` },
  { re: /(?<=\s)(alpha|beta)\s*$/gi, render: (c) => c.toLowerCase() },
];

export interface NormalisedName {
  raw: string;
  /** Identity tokens joined by a single space: marks, version tokens and filler words removed. */
  key: string;
  tokens: string[];
  /** Version-like tokens that were removed from the name, in textual form. */
  versions: string[];
}

export function normaliseName(raw: string): NormalisedName {
  let s = foldText(raw);
  const versions: string[] = [];
  for (const { re, render } of VERSION_PATTERNS) {
    s = s.replace(re, (_match: string, captured: string) => {
      versions.push(render(captured));
      return " ";
    });
  }
  const tokens = tokenize(s).filter((t) => !NAME_STOPWORDS.has(t));
  return { raw, key: tokens.join(" "), tokens, versions };
}

/**
 * Splits a list cell that packs several devices ("A; B", "A, B"). Semicolons always split; commas split only
 * outside parentheses. Empty parts are dropped. A cell with one device returns one element.
 */
export function splitDeviceCell(cell: string): string[] {
  const text = repairMojibake(cell);
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "(") depth++;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    const digitComma = ch === "," && /\d/.test(text[i - 1] ?? "") && /\d/.test(text[i + 1] ?? "");
    if (ch === ";" || (ch === "," && depth === 0 && !digitComma)) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  parts.push(current);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

// ------------------------------------------------------------------------------------------ manufacturers

/** Corporate suffixes and filler dropped before comparing company names. */
const CORPORATE_TOKENS = new Set([
  "inc", "incorporated", "llc", "ltd", "limited", "lp", "llp", "co", "corp", "corporation", "company", "plc", "gmbh", "ag",
  "sa", "sas", "srl", "spa", "bv", "nv", "oy", "ab", "pty", "kk", "pte",
]);
/** Generic words that appear in some spellings of a company name and not in others. */
const COMPANY_GENERIC = new Set(["medical", "the", "and", "of"]);

/** Spelling variants that fold to one key. The OCR confusion between "ai" and "al" is the documented one. */
const COMPANY_VARIANTS: ReadonlyMap<string, string> = new Map([["vizal", "vizai"]]);

export interface NormalisedManufacturer {
  raw: string;
  /** Compact key: suffixes removed, spelling variants folded, separators removed. */
  key: string;
}

export function normaliseManufacturer(raw: string): NormalisedManufacturer {
  const folded = foldText(raw)
    // "B.V." and "S.r.l." lose their dots before tokenising so they are recognised as one suffix.
    .replace(/\b([a-z])\.([a-z])\.(?:([a-z])\.)?/g, (_m, a: string, b: string, c?: string) => a + b + (c ?? ""));
  const tokens = tokenize(folded).filter((t) => !CORPORATE_TOKENS.has(t) && !COMPANY_GENERIC.has(t));
  const compact = tokens.join("");
  return { raw, key: COMPANY_VARIANTS.get(compact) ?? compact };
}

/**
 * Owner and name drift documented in the feasibility report (section 6). Each group lists names that denote
 * one lineage of company. Membership is evidence of drift to show a reviewer, never of identity by itself.
 */
export interface AliasGroup {
  id: string;
  names: string[];
  citation: string;
}

export const MANUFACTURER_ALIAS_GROUPS: readonly AliasGroup[] = [
  {
    id: "idx-digital-diagnostics",
    names: ["IDx, LLC", "Digital Diagnostics Inc."],
    citation: "feasibility report s6: IDx, LLC became Digital Diagnostics; product renamed LumineticsCore",
  },
  {
    id: "baylabs-caption-ge",
    names: ["Bay Labs, Inc.", "Caption Health, Inc.", "GE Medical Systems, Ultrasound & Primary Care Diagnostics LLC"],
    citation: "feasibility report s6: Bay Labs became Caption Health became GE; GUDID labeller is the GE ultrasound unit",
  },
  {
    id: "cosmo-covidien-medtronic",
    names: ["Cosmo Artificial Intelligence - AI Ltd", "Covidien LP", "Linkverse SRL", "Medtronic"],
    citation: "feasibility report s6: GI Genius applicant Cosmo, GUDID labeller Covidien LP or Linkverse SRL, trials say Medtronic",
  },
];

/**
 * Product names that denote one product under different names, documented in the feasibility report. Used to
 * show a "product-name-drift" flag; a shared group is never evidence of identity by itself.
 */
export const PRODUCT_ALIAS_GROUPS: readonly AliasGroup[] = [
  {
    id: "idx-dr-luminetics",
    names: ["IDx-DR", "LumineticsCore"],
    citation: "feasibility report s4 and s6: FDA name IDx-DR, registry name 'LumineticsCore (formerly IDX-DR)'",
  },
  {
    id: "caption-echogps",
    names: ["Caption Guidance", "EchoGPS"],
    citation: "feasibility report s4 and s6: the pre-clearance trial name of Bay Labs' product is EchoGPS",
  },
  {
    id: "contact-viz-lvo",
    names: ["ContaCT", "Viz LVO"],
    citation: "feasibility report s4: ContaCT / Viz LVO; the FDA list names K223042 'Viz LVO ContaCT'",
  },
];

const aliasIndex = (groups: readonly AliasGroup[]): Map<string, string> => {
  const index = new Map<string, string>();
  for (const g of groups) for (const n of g.names) index.set(normaliseManufacturer(n).key, g.id);
  return index;
};
const DEFAULT_ALIAS_INDEX = aliasIndex(MANUFACTURER_ALIAS_GROUPS);

export function aliasGroupOf(manufacturerKey: string, groups?: readonly AliasGroup[]): string | undefined {
  return (groups ? aliasIndex(groups) : DEFAULT_ALIAS_INDEX).get(manufacturerKey);
}

// ------------------------------------------------------------------------------------------ string similarity

/** Jaro-Winkler similarity in [0, 1]. Symmetric. */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return a.length === 0 ? 0 : 1;
  if (a.length === 0 || b.length === 0) return 0;
  const window = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);
  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - window);
    const hi = Math.min(b.length - 1, i + window);
    for (let j = lo; j <= hi; j++) {
      if (!bMatched[j] && a[i] === b[j]) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  const jaro = (matches / a.length + matches / b.length + (matches - transpositions / 2) / matches) / 3;
  let prefix = 0;
  while (prefix < Math.min(4, a.length, b.length) && a[prefix] === b[prefix]) prefix++;
  return jaro + prefix * 0.1 * (1 - jaro);
}

/** True when `needle` occurs as a contiguous run of whole tokens inside `haystack`. */
export function containsTokenRun(haystack: readonly string[], needle: readonly string[]): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}
