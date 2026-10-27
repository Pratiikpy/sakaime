/**
 * Age statements in indications and eligibility text, reduced to bounds on the age of the population.
 *
 * The direction of a phrase decides which bound it sets, and a negation flips it: "not intended for patients under
 * 22" excludes people younger than 22, so it sets a MINIMUM of 22; "under 22" on its own would be a maximum.
 * A bound is returned only when a phrase states it. An absent bound stays absent (open), never zero or infinity.
 *
 * A number counts as an age only with an age cue ("years", "age", "aged"): "over 5 sites" is not an age.
 */

export interface AgeBound {
  kind: "min" | "max";
  /** Age in years, as the phrase states it. */
  years: number;
  /** True when the phrase means strictly more or less than the number ("older than 22"). */
  exclusive: boolean;
  /** The phrase that stated it, as it appears in the text. */
  phrase: string;
  index: number;
  /** True when the bound comes from a negated or excluding phrase ("not intended for ... under 22"). */
  fromExclusion: boolean;
}

const NUM = String.raw`(\d{1,3})`;
const YEARS = String.raw`\s*(?:years?|yrs?|y\.?o\.?)(?:\s+of\s+age|\s+old)?`;
const NEG = String.raw`(?:not\s+(?:intended|indicated|for|to\s+be\s+used|recommended)|exclu(?:de[ds]?|ding|sion)|should\s+not\s+be\s+used|must\s+not|contraindicated)`;

interface Rule {
  re: RegExp;
  build: (m: RegExpExecArray) => { kind: "min" | "max"; years: number; exclusive: boolean }[];
}

const RULES: Rule[] = [
  // symbols: "age >= 18", "(\u2265 18 years old)". A symbol whose glyph was lost in extraction matches nothing: the
  // direction is then unknown and no bound is returned.
  {
    re: new RegExp(String.raw`\bage[sd]?\s*(?:\u2265|>=|=>)\s*${NUM}|(?:\u2265|>=|=>)\s*${NUM}${YEARS}`, "gi"),
    build: (m) => [{ kind: "min", years: Number(m[1] ?? m[2]), exclusive: false }],
  },
  {
    re: new RegExp(String.raw`\bage[sd]?\s*(?:\u2264|<=|=<)\s*${NUM}|(?:\u2264|<=|=<)\s*${NUM}${YEARS}`, "gi"),
    build: (m) => [{ kind: "max", years: Number(m[1] ?? m[2]), exclusive: false }],
  },
  {
    re: new RegExp(String.raw`\bage[sd]?\s*>\s*${NUM}|>\s*${NUM}${YEARS}`, "gi"),
    build: (m) => [{ kind: "min", years: Number(m[1] ?? m[2]), exclusive: true }],
  },
  {
    re: new RegExp(String.raw`\bage[sd]?\s*<\s*${NUM}|<\s*${NUM}${YEARS}`, "gi"),
    build: (m) => [{ kind: "max", years: Number(m[1] ?? m[2]), exclusive: true }],
  },
  // "ages 22 and above", "aged 18 and older", "22 years or older"
  {
    re: new RegExp(String.raw`\b(?:ages?|aged)\s*${NUM}(?:${YEARS})?\s*(?:and|or)\s+(?:above|older|over|up|more)`, "gi"),
    build: (m) => [{ kind: "min", years: Number(m[1]), exclusive: false }],
  },
  {
    re: new RegExp(String.raw`\b${NUM}${YEARS}\s*(?:and|or)\s+(?:above|older|over|up|more)`, "gi"),
    build: (m) => [{ kind: "min", years: Number(m[1]), exclusive: false }],
  },
  {
    re: new RegExp(String.raw`\b(?:ages?|aged)\s*${NUM}\s*\+`, "gi"),
    build: (m) => [{ kind: "min", years: Number(m[1]), exclusive: false }],
  },
  // "older than 22 years", "over 22 years", "greater than 21 years"
  {
    re: new RegExp(String.raw`\b(?:older\s+than|over|greater\s+than|more\s+than|above)\s+${NUM}${YEARS}`, "gi"),
    build: (m) => [{ kind: "min", years: Number(m[1]), exclusive: true }],
  },
  // "at least 18 years", "minimum age 18"
  {
    re: new RegExp(String.raw`\b(?:at\s+least|no\s+younger\s+than)\s+${NUM}${YEARS}`, "gi"),
    build: (m) => [{ kind: "min", years: Number(m[1]), exclusive: false }],
  },
  {
    re: new RegExp(String.raw`\bminimum\s+age(?:\s+of)?\s+${NUM}`, "gi"),
    build: (m) => [{ kind: "min", years: Number(m[1]), exclusive: false }],
  },
  // "under 22 years", "younger than 22 years", "below the age of 18", "less than 18 years"
  {
    re: new RegExp(String.raw`\b(?:under|younger\s+than|below|less\s+than|fewer\s+than)\s+(?:(?:the\s+)?age\s+of\s+${NUM}|${NUM}${YEARS})`, "gi"),
    build: (m) => [{ kind: "max", years: Number(m[1] ?? m[2]), exclusive: true }],
  },
  // "up to 75 years", "no older than 75 years", "maximum age 75", "75 years or younger"
  {
    re: new RegExp(String.raw`\b(?:up\s+to|no\s+older\s+than|through)\s+${NUM}${YEARS}`, "gi"),
    build: (m) => [{ kind: "max", years: Number(m[1]), exclusive: false }],
  },
  {
    re: new RegExp(String.raw`\bmaximum\s+age(?:\s+of)?\s+${NUM}`, "gi"),
    build: (m) => [{ kind: "max", years: Number(m[1]), exclusive: false }],
  },
  {
    re: new RegExp(String.raw`\b${NUM}${YEARS}\s*(?:and|or)\s+(?:younger|under|below|less)`, "gi"),
    build: (m) => [{ kind: "max", years: Number(m[1]), exclusive: false }],
  },
  // "40 to 74 years", "ages 40-74 years", "between 40 and 74 years"
  {
    re: new RegExp(String.raw`\b(?:ages?|aged|between)?\s*${NUM}\s*(?:-|\u2013|to|and)\s*${NUM}${YEARS}`, "gi"),
    build: (m) => {
      const a = Number(m[1]);
      const b = Number(m[2]);
      return a <= b
        ? [
            { kind: "min", years: a, exclusive: false },
            { kind: "max", years: b, exclusive: false },
          ]
        : [];
    },
  },
];

const NEGATION_WINDOW = 140;

export function parseAgeBounds(text: string): AgeBound[] {
  const out: AgeBound[] = [];
  const seen = new Set<string>();
  const negRe = new RegExp(NEG, "i");
  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    for (const m of text.matchAll(rule.re)) {
      const index = m.index as number;
      const phrase = m[0].trim();
      // a negation or exclusion cue shortly before the phrase, in the same clause
      const lead = text.slice(Math.max(0, index - NEGATION_WINDOW), index);
      const clause = lead.split(/[.;]\s/).pop() ?? lead;
      const negated = negRe.test(clause);
      const built = rule.build(m as RegExpExecArray);
      if (negated && built.length > 1) continue; // an excluded range does not give a usable bound
      for (const b of built) {
        // "not intended for patients under 22": the excluded group is below 22, so the population starts at 22.
        // The strictness flips with the direction: excluding "75 and older" leaves ages below 75, not up to 75.
        const bound: AgeBound = negated
          ? { kind: b.kind === "min" ? "max" : "min", years: b.years, exclusive: !b.exclusive, phrase, index, fromExclusion: true }
          : { kind: b.kind, years: b.years, exclusive: b.exclusive, phrase, index, fromExclusion: false };
        const key = `${bound.kind}:${bound.years}:${index}`;
        if (!seen.has(key)) {
          seen.add(key);
          out.push(bound);
        }
      }
    }
  }
  return out.sort((a, b) => a.index - b.index);
}

/**
 * The tightest minimum and maximum the text states, in whole years. A strict bound ("older than 22") moves one year
 * inward (23), so the stated scope is never wider than the text supports. An open side is left absent.
 */
export function summariseAge(bounds: AgeBound[]): { min?: number; max?: number } {
  const mins = bounds.filter((b) => b.kind === "min").map((b) => (b.exclusive ? b.years + 1 : b.years));
  const maxs = bounds.filter((b) => b.kind === "max").map((b) => (b.exclusive ? b.years - 1 : b.years));
  const out: { min?: number; max?: number } = {};
  if (mins.length) out.min = Math.max(...mins);
  if (maxs.length) out.max = Math.min(...maxs);
  return out;
}

const REGISTRY_UNITS: Record<string, number> = {
  year: 1,
  years: 1,
  month: 1 / 12,
  months: 1 / 12,
  week: 1 / 52,
  weeks: 1 / 52,
  day: 1 / 365,
  days: 1 / 365,
  hour: 1 / 8760,
  hours: 1 / 8760,
  minute: 1 / 525600,
  minutes: 1 / 525600,
};

/**
 * ClinicalTrials.gov age fields ("18 Years", "6 Months", "N/A") in years. "N/A" and anything unrecognised return
 * undefined: an unstated limit is open, not zero.
 */
export function parseRegistryAge(text: string | undefined): number | undefined {
  if (text === undefined) return undefined;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(years?|months?|weeks?|days?|hours?|minutes?)\s*$/i.exec(text);
  if (!m) return undefined;
  const years = Number(m[1]) * (REGISTRY_UNITS[(m[2] as string).toLowerCase()] as number);
  return Number(years.toFixed(4));
}
