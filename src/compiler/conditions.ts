/*
 * Condition and exclusion phrases: how two free-text population terms are compared.
 *
 * Population conditions arrive as the words of a document ("adults diagnosed with diabetes", "Pleural Effusion;") and as the
 * words of a claim ("diabetes mellitus"). Comparing them as exact strings refused every claim that named a condition. This
 * module places two phrases against each other in four steps and stops at the first that decides:
 *
 *   1. normal form    case, punctuation, plural endings, filler words and parenthesised abbreviations are removed.
 *   2. synonyms       a small curated table; every entry names the text it was derived from.
 *   3. narrowing      "type 2 diabetes mellitus" lies inside "diabetes mellitus": only modifiers from a closed list narrow, and a closed
 *                     table of subtypes with its source ("diabetic retinopathy" lies inside "diabetes mellitus").
 *   4. relatedness    two phrases that share a content word but were not placed above cannot be placed by code. The compiler
 *                     never guesses: they go to a reviewer (REQUIRES_DOMAIN_REVIEW), they are never CONTAINED.
 *
 * Phrases that share nothing but generic words ("adults ...") are unrelated, and an unrelated phrase is simply not covered.
 * Nothing here consults a medical ontology. A relation that needs one is "related", and "related" is never support.
 */

export interface SynonymEntry {
  /** The preferred wording. Every variant is rewritten to it before phrases are compared. */
  canonical: string;
  variants: readonly string[];
  /** A variant is not rewritten when the word after it is in this list ("diabetes insipidus" is a different condition). */
  notBefore?: readonly string[];
  /** The text the equivalence was read from: where one document uses both forms. */
  source: string;
}

/**
 * Equivalences only: both directions are true. A looser relation (a symptom of, a cause of, a usual reason for) does not belong here.
 * Each entry was added because a development document uses both forms for the same thing; the source says where. An entry that
 * could not be tied to a document's own text was left out (for example "cardiac failure" for "heart failure": NOT VERIFIED here).
 */
export const CONDITION_SYNONYMS: readonly SynonymEntry[] = [
  {
    canonical: "diabetes mellitus",
    variants: ["diabetes"],
    notBefore: ["insipidus", "mellitus"],
    source:
      "FDA DEN180001 summary: 'adults diagnosed with diabetes' (indications, line 35) and 'only for use in people already diagnosed with diabetes mellitus' (line 71 to 72) name one population; FDA K223357 summary: 'known diagnosis of diabetes mellitus'. NLM MeSH does not list the bare word 'diabetes' as an entry term of Diabetes Mellitus (D003920) and has a separate Diabetes Insipidus, which is why 'diabetes insipidus' is never rewritten.",
  },
  {
    canonical: "large vessel occlusion",
    variants: ["lvo"],
    source: "FDA DEN170073 summary: 'Vessel Occlusion (LVO)' (line 91) and '(LVO)' (line 303).",
  },
  {
    canonical: "intra-abdominal free gas",
    variants: ["ifg"],
    source: "FDA K253265 summary: 'Intra-abdominal free gas (IFG) pathologies' (indications).",
  },
  {
    canonical: "left ventricular ejection fraction",
    variants: ["lvef"],
    source: "FDA K232699 summary: 'Left Ventricular Ejection Fraction (LVEF)' (indications).",
  },
  {
    canonical: "diabetic retinopathy",
    variants: ["dr"],
    source: "FDA K200667 summary: 'diabetic retinopathy (DR)' (lines 243 and 260); FDA DEN180001 summary: 'retinopathy (DR)' (line 186).",
  },
];

/**
 * Words that narrow a condition they precede: the phrase with the modifier is a subset of the phrase without it.
 * Closed on purpose. Negating or shifting words ("pre", "non", "no", "suspected", "at risk", "history") are not here, because
 * "suspected stroke" is not a kind of stroke and "pre-diabetes" is not a kind of diabetes.
 */
export const NARROWING_MODIFIERS: readonly string[] = ["mild", "moderate", "severe", "early", "advanced", "acute", "chronic", "primary", "secondary", "unilateral", "bilateral"];

export interface SubtypeEntry {
  /** The narrower condition: everyone who has it also has the broader one. */
  narrow: string;
  broad: string;
  source: string;
}

/**
 * Subtype facts that hold by definition, so a claim for the narrower condition lies inside evidence for the broader one. Closed and
 * small on purpose: an entry is added only when a terminology source places the narrower term below the broader one.
 */
export const CONDITION_SUBTYPES: readonly SubtypeEntry[] = [
  {
    narrow: "diabetic retinopathy",
    broad: "diabetes mellitus",
    source: "NLM MeSH D003930 Diabetic Retinopathy, tree number C19.246.099.500.382, which lies below Diabetes Mellitus (D003920, C19.246.099).",
  },
];

/** A "type 2" designator also narrows (type 1 and type 2 are kinds of the condition). */
const TYPE_DESIGNATOR = /^type$/;
const TYPE_NUMBER = /^(?:1|2|i|ii|one|two)$/;

const FILLER = new Set(["a", "an", "the", "of_the"]);

/** Words that, on their own, do not make two phrases about the same thing. */
const GENERIC = new Set([
  "patient", "adult", "woman", "women", "man", "men", "subject", "people", "individual", "person", "child", "children", "adolescent", "infant",
  "participant", "case", "population", "group", "with", "without", "who", "whom", "have", "has", "had", "having", "been", "being", "be", "is", "are", "was", "were",
  "for", "in", "on", "at", "by", "to", "from", "or", "and", "of", "as", "than", "more", "less", "other", "any", "all", "not", "no", "per", "that", "this", "these", "those",
  "history", "previously", "prior", "diagnosed", "diagnosis", "undergoing", "aged", "age", "older", "younger", "year", "old", "exam", "image", "study", "condition", "disease",
  "scan", "ecg", "record", "result", "finding", "risk", "suspected", "known", "unknown", "presence", "absence", "current", "currently", "receiving", "treated", "treatment",
]);

const PROTECTED_PLURALS = new Set(["diabetes", "series", "species", "news", "mellitus", "gas", "status", "lens", "iris", "bias", "analysis", "diagnosis", "stenosis", "fibrosis", "hepatitis", "arthritis", "sepsis", "emphysema", "pneumonia", "women", "men", "children", "people"]);

function singular(w: string): string {
  if (PROTECTED_PLURALS.has(w) || w.length <= 3) return w;
  if (/ies$/.test(w) && w.length > 4) return `${w.slice(0, -3)}y`;
  if (/(?:ss|us|is|as|os|ous)$/.test(w)) return w;
  if (/(?:sses|xes|zes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}

/** "Pleural Effusion;" and "pleural effusions" are one phrase. Parenthesised short abbreviations are dropped: they repeat the words before them. */
function tokensOf(raw: string): string[] {
  const s = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\(\s*[a-z0-9][a-z0-9/-]{0,7}\s*\)/g, " ")
    .replace(/[‐-―-]/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s === "") return [];
  return s
    .split(" ")
    .filter((w) => !FILLER.has(w))
    .map(singular);
}

/**
 * A phrase that opens with a marker of past diagnosis names a history, however it is worded: "previously diagnosed with X", "prior
 * diagnosis of X", "a history of X", "prior X". All become "history of X", so an exclusion worded one way and a claim worded
 * another compare on X. Source: the indications of FDA K200667 ("previously diagnosed with more than mild diabetic retinopathy") and
 * K223357 ("previously diagnosed with diabetic retinopathy"), and the wording of a claim written against them ("a prior diagnosis of
 * mild diabetic retinopathy"). A bare "diagnosed with X" is a current diagnosis and is not rewritten.
 */
const HISTORY_MARKERS: readonly (readonly string[])[] = [
  ["previously", "diagnosed", "with"],
  ["previous", "diagnosis", "of"],
  ["prior", "diagnosis", "of"],
  ["history", "of"],
  ["previously"],
  ["previous"],
  ["prior"],
].sort((a, b) => b.length - a.length);

function withHistoryMarker(tokens: string[]): string[] {
  for (const m of HISTORY_MARKERS) {
    if (tokens.length > m.length && m.every((t, i) => tokens[i] === t)) return ["history", "of", ...tokens.slice(m.length)];
  }
  return tokens;
}

const PHRASE_VARIANTS:readonly { variant: string[]; canonical: string[]; notBefore: readonly string[] }[] = CONDITION_SYNONYMS.flatMap((e) =>
  e.variants.map((v) => ({ variant: tokensOf(v), canonical: tokensOf(e.canonical), notBefore: e.notBefore ?? [] })),
).sort((a, b) => b.variant.length - a.variant.length);

function applySynonyms(tokens: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < tokens.length; ) {
    const hit = PHRASE_VARIANTS.find((p) => p.variant.length > 0 && p.variant.every((t, k) => tokens[i + k] === t) && !p.notBefore.includes(tokens[i + p.variant.length] ?? ""));
    if (hit) {
      out.push(...hit.canonical);
      i += hit.variant.length;
    } else {
      out.push(tokens[i] as string);
      i++;
    }
  }
  return out;
}

/**
 * The normal form of a condition or exclusion phrase. Idempotent: normalising a normal form returns it unchanged,
 * which is what lets the compiler canonicalise a phrase once at the input and again inside an operation.
 */
export function normCondition(raw: string): string {
  const once = withHistoryMarker(applySynonyms(tokensOf(raw)));
  // a second pass settles a synonym whose canonical form itself contains a variant ("diabetic" inside "diabetic retinopathy")
  const twice = applySynonyms(once);
  return (twice.length ? twice : tokensOf(raw)).join(" ");
}

export type ConditionRelation =
  /** the same phrase after normalisation and synonyms */
  | "equal"
  /** the first phrase is a stated subtype of the second (modifiers from the closed list) */
  | "narrower"
  /** they share a content word and the code cannot place them: a reviewer must */
  | "related"
  /** nothing in common but generic words */
  | "unrelated";

/**
 * A crude stem for deciding that two words are about the same thing ("diabetes" and "diabetic"). It is used only to detect that two
 * phrases are related, which sends them to a reviewer; it never makes one phrase cover another.
 */
function stem(w: string): string {
  let s = w;
  for (const suffix of ["ation", "ition", "ing", "ics", "ic", "ous", "ed", "es", "s", "al", "e", "y"]) {
    if (s.length - suffix.length >= 5 && s.endsWith(suffix)) {
      s = s.slice(0, -suffix.length);
      break;
    }
  }
  return s;
}

function contentWords(tokens: readonly string[]): string[] {
  return tokens.filter((t) => !GENERIC.has(t) && !/^\d+$/.test(t)).map(stem);
}

/** True when the leading words are all narrowing modifiers (including "type 2"). */
function onlyNarrowing(lead: readonly string[]): boolean {
  if (lead.length === 0) return false;
  for (let i = 0; i < lead.length; i++) {
    const w = lead[i] as string;
    if (NARROWING_MODIFIERS.includes(w)) continue;
    if (TYPE_DESIGNATOR.test(w) && TYPE_NUMBER.test(lead[i + 1] ?? "")) {
      i++;
      continue;
    }
    return false;
  }
  return true;
}

const SUBTYPE_PARENTS: ReadonlyMap<string, readonly string[]> = new Map(
  [...new Set(CONDITION_SUBTYPES.map((e) => normCondition(e.narrow)))].map((n) => [n, CONDITION_SUBTYPES.filter((e) => normCondition(e.narrow) === n).map((e) => normCondition(e.broad))]),
);

/** Every phrase the given one is a subtype of: by dropping leading narrowing modifiers and by the closed subtype table, transitively. */
function generalisations(phrase: string): Set<string> {
  const out = new Set<string>();
  const todo = [phrase];
  while (todo.length) {
    const p = todo.pop() as string;
    const t = p.split(" ");
    for (let k = 1; k < t.length; k++) {
      if (!onlyNarrowing(t.slice(0, k))) continue;
      const rest = t.slice(k).join(" ");
      if (!out.has(rest)) {
        out.add(rest);
        todo.push(rest);
      }
    }
    for (const parent of SUBTYPE_PARENTS.get(p) ?? []) {
      if (!out.has(parent)) {
        out.add(parent);
        todo.push(parent);
      }
    }
  }
  out.delete(phrase);
  return out;
}

/**
 * Place the phrase `a` against the phrase `b`, both already in normal form (`normCondition`).
 * "narrower" means every case `a` describes is also a case `b` describes.
 */
export function relateCondition(a: string, b: string): ConditionRelation {
  if (a === b) return "equal";
  const ta = a.split(" ");
  const tb = b.split(" ");
  // two histories compare on what they are histories of; a history never compares with a current condition
  if (ta[0] === "history" && ta[1] === "of" && tb[0] === "history" && tb[1] === "of") return relateCondition(ta.slice(2).join(" "), tb.slice(2).join(" "));
  if (generalisations(a).has(b)) return "narrower";
  const ca = new Set(contentWords(ta));
  for (const w of contentWords(tb)) if (ca.has(w)) return "related";
  return "unrelated";
}

/** The strongest relation of `a` to any phrase in `set`: equal beats narrower beats related beats unrelated. */
export function relateToSet(a: string, set: Iterable<string>): { relation: ConditionRelation; with?: string } {
  let best: { relation: ConditionRelation; with?: string } = { relation: "unrelated" };
  const rank: Record<ConditionRelation, number> = { equal: 3, narrower: 2, related: 1, unrelated: 0 };
  for (const b of set) {
    const r = relateCondition(a, b);
    if (rank[r] > rank[best.relation]) best = { relation: r, with: b };
    if (best.relation === "equal") break;
  }
  return best;
}
