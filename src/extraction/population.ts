/**
 * Population conditions, exclusions and explicit purpose limits as written in an FDA decision summary.
 *
 * What it reads, and nothing else:
 *   - the condition a population has ("adults diagnosed with diabetes", "adults at risk for heart failure", "the population of
 *     women undergoing screening mammography", "findings (pleural effusion and/or pneumothorax)", "a suspected large vessel
 *     occlusion has been identified");
 *   - the groups the indications exclude ("who have not been previously diagnosed with ...", "should not be used on ECGs with a
 *     paced rhythm");
 *   - a sentence that excludes a purpose, the diagnostic one ("is not intended to be used as a diagnostic device").
 *
 * Every value is a stretch of the quoted sentence, copied as written, so the quote check and the support check can both hold it
 * to the page. A phrase the patterns do not match is not extracted and not guessed: an absent condition stays absent.
 * A phrase must end at a terminator (a full stop, a comma, a clause word). A phrase that runs to the end of the text is where the
 * sentence splitter cut a sentence in two, not where the phrase ends, so it is dropped rather than kept truncated.
 * The patterns are templates found in the development documents; each says which text it was written from.
 */

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();

export interface PhraseHit {
  predicate: "population.condition" | "population.exclusion_criterion";
  value: string;
  /** The template that matched, kept as a qualifier so a reader can see why the phrase was taken. */
  pattern: string;
}

const NOUN = String.raw`(?:adults?|patients?|people|persons?|individuals?|subjects?|women|men|children|infants?|eyes)`;
/** A noun phrase inside a sentence: stops at punctuation, a relative clause or a purpose clause. */
const NP = String.raw`([A-Za-z][A-Za-z0-9 /-]{2,90}?)`;
const NP_END = String.raw`(?=\s+(?:who|whose|that|which|and\s+(?:who|have|are|is)|in\s+(?:both|primary|eye|the)|for\s+(?:use|the)|using|with\s+(?:the|an?)|by|at|on|from)\b|\s*[.;,:)])`;

interface Template {
  id: string;
  /** Where the text this template was written from came from. */
  source: string;
  re: RegExp;
  hits: (m: RegExpExecArray) => PhraseHit[];
}

const clean = (s: string): string => collapse(s).replace(/[\s,;:.]+$/, "");
const condition = (value: string, pattern: string): PhraseHit => ({ predicate: "population.condition", value: clean(value), pattern });
const exclusion = (value: string, pattern: string): PhraseHit => ({ predicate: "population.exclusion_criterion", value: clean(value), pattern });

/** Split "pleural effusion and/or pneumothorax" into the listed findings. */
function listed(s: string): string[] {
  return s
    .split(/\s*(?:,\s*(?:and\/or|and|or)?|\band\/or\b|\band\b|\bor\b)\s*/i)
    .map(clean)
    .filter((x) => x.length >= 3);
}

const TEMPLATES: Template[] = [
  {
    id: "diagnosed-with",
    source: "FDA K200667, K223357 and DEN180001 indications: 'adults diagnosed with diabetes who have not been previously diagnosed with ...'",
    re: new RegExp(String.raw`\b${NOUN}\s+(?:who\s+(?:have\s+been|are)\s+)?diagnosed\s+with\s+${NP}${NP_END}`, "gi"),
    hits: (m) => (m[1] ? [condition(m[1], "diagnosed-with")] : []),
  },
  {
    id: "for-patients-with",
    source: "FDA K213857 indications: 'previously acquired Computed Tomography DICOM data for patients with suspected coronary artery disease'",
    re: new RegExp(String.raw`\bfor\s+patients\s+with\s+${NP}(?=\s*[.;:)]|\s+(?:It|This|who)\b)`, "gi"),
    hits: (m) => (m[1] ? [condition(`patients with ${m[1]}`, "for-patients-with")] : []),
  },
  {
    id: "undergoing",
    source: "FDA DEN200055 indications: 'of patients undergoing screening and surveillance endoscopic mucosal evaluations'",
    re: /\b((?:adults|patients|women|men)\s+undergoing\s+[A-Za-z][A-Za-z0-9 /-]{2,90}?)(?=\s*[.;:)]|\s+(?:The|This|It|who)\b)/gi,
    hits: (m) => (m[1] ? [condition(m[1], "undergoing")] : []),
  },
  {
    id: "not-previously-diagnosed",
    source: "FDA K200667, K223357 and DEN180001 indications: 'who have not been previously diagnosed with more than mild diabetic retinopathy'",
    re: new RegExp(String.raw`\bwho\s+(?:have|has)\s+not\s+been\s+(previously\s+diagnosed\s+with\s+[A-Za-z][A-Za-z0-9 /-]{2,90}?)(?=\s*[.;,:)])`, "gi"),
    hits: (m) => (m[1] ? [exclusion(m[1], "not-previously-diagnosed")] : []),
  },
  {
    id: "at-risk-for",
    source: "FDA K232699 indications: 'in adults at risk for heart failure'",
    re: new RegExp(String.raw`\b(${NOUN}\s+at\s+(?:high\s+)?risk\s+(?:for|of)\s+[A-Za-z][A-Za-z -]{2,60}?)(?=\s*[.;,:)]|\s+(?:This|who|and)\b)`, "gi"),
    hits: (m) => (m[1] ? [condition(m[1], "at-risk-for")] : []),
  },
  {
    id: "population-of",
    source: "FDA K221347 summary, 'Intended patient population': 'intended to be used in the population of women undergoing screening mammography and digital breast tomosynthesis'",
    re: new RegExp(String.raw`\b(?:intended|indicated)\s+(?:to\s+be\s+used\s+|for\s+use\s+)?in\s+(?:the\s+)?(?:patient\s+)?population\s+of\s+${NP}(?=\s*[.;:)])`, "gi"),
    hits: (m) => (m[1] ? [condition(m[1], "population-of")] : []),
  },
  {
    id: "findings-list",
    source: "FDA K211733 indications: 'for the presence of pre-specified suspected critical findings (pleural effusion and/or pneumothorax)'",
    re: /\bfindings?\s*\(([A-Za-z][A-Za-z0-9 ,/-]{3,120}?)\)/gi,
    hits: (m) => (m[1] ? listed(m[1]).map((v) => condition(v, "findings-list")) : []),
  },
  {
    id: "findings-of",
    source: "FDA K253265 indications: 'suspected positive findings of Intra-abdominal free gas (IFG) pathologies'",
    re: /\bfindings?\s+of\s+([A-Za-z][A-Za-z -]{3,60}?)(?:\s*\([A-Za-z0-9-]{2,8}\))?(?=\s+pathologies\b|\s*[.;,:])/gi,
    hits: (m) => (m[1] ? [condition(m[1], "findings-of")] : []),
  },
  {
    id: "suspected-identified",
    source: "FDA DEN170073 indications: 'a suspected large vessel occlusion has been identified'",
    re: /\b(suspected\s+[A-Za-z][A-Za-z -]{3,60}?)\s+(?:has|have)\s+been\s+(?:identified|detected|found)\b/gi,
    hits: (m) => (m[1] ? [condition(m[1], "suspected-identified")] : []),
  },
  {
    id: "should-not-be-used-on",
    source: "FDA K232699 indications: 'should not be used on ECGs with a paced rhythm'",
    // "for" is left out on purpose: "should not be used for monitoring" excludes a purpose, not a group of people
    re: /\b(?:should|must)\s+not\s+be\s+(?:used|applied)\s+(?:on|in|with)\s+(?:[A-Za-z]+s?\s+(?:with|having|from)\s+(?:an?\s+)?)?([A-Za-z][A-Za-z0-9 -]{2,60}?)(?=\s*[.;,:)])/gi,
    hits: (m) => (m[1] && !/\d/.test(m[1]) && !/^(?:in-?lieu|as\b|alone|stand)/i.test(m[1]) ? [exclusion(m[1], "should-not-be-used-on")] : []),
  },
];

/** Population phrases in one sentence. `only` limits the templates tried, by id. */
export function populationPhrases(sentence: string, only?: readonly string[]): PhraseHit[] {
  const out: PhraseHit[] = [];
  const seen = new Set<string>();
  const text = collapse(sentence);
  for (const t of TEMPLATES) {
    if (only && !only.includes(t.id)) continue;
    t.re.lastIndex = 0;
    for (const m of text.matchAll(t.re)) {
      for (const h of t.hits(m)) {
        const key = `${h.predicate}|${h.value.toLowerCase()}`;
        if (h.value.length < 3 || seen.has(key)) continue;
        seen.add(key);
        out.push(h);
      }
    }
  }
  return out;
}

/** The templates and the documents they were written from, for the measurement notes and the tests. */
export const POPULATION_TEMPLATES: readonly { id: string; source: string }[] = TEMPLATES.map(({ id, source }) => ({ id, source }));

/* ---------------------------------------------------------------------------------------- purpose limits */

export type NegationStrength = "absolute" | "qualified";

const NEGATION = /\b(?:not|never|cannot|can\s?not|do(?:es)?\s+not|should\s+not|must\s+not|no\s+longer)\b/i;
const DIAGNOSTIC = /\bdiagnos(?:is|e|tic|ing)\b/i;
/**
 * The plain labelled exclusions. Only these can be "absolute": "is not intended to be used as a diagnostic device",
 * "not indicated for diagnostic use", "not for diagnostic use".
 */
const PLAIN_EXCLUSION = /\bnot\s+(?:(?:intended|indicated|designed)\s+(?:to\s+be\s+used\s+)?(?:as|for)\s+(?:an?\s+)?diagnostic\s+(?:device|tool|system|use|purposes?)|for\s+diagnostic\s+(?:use|purposes?))\b/i;
/** Words that put a reservation on the exclusion: it excludes diagnosis only alone, as the main basis, beyond something else, or merely describes the output. */
const RESERVATION = /\b(?:stand-?alone|alone|primary|sole(?:ly)?|only|beyond|in-?\s?lieu|replace|adjunct\w*|aid|supplement\w*|rely|relied|reliance|confirm|make\s+or|in\s+addition|provides?|generates?|gives?)\b/i;

/**
 * A sentence that excludes diagnostic use. "absolute" is a plain labelled exclusion with no reservation; any other sentence that
 * negates something within reach of the word diagnosis is "qualified": the code does not interpret it, a reviewer does.
 * Returns undefined when the sentence does not both negate and mention diagnosis within the same clause.
 */
export function diagnosticExclusion(sentence: string): NegationStrength | undefined {
  const s = collapse(sentence);
  const neg = NEGATION.exec(s);
  if (!neg) return undefined;
  const after = s.slice(neg.index);
  const diag = DIAGNOSTIC.exec(after);
  if (!diag || diag.index > 90) return undefined;
  // a negation about something else, then a later clause that mentions diagnosis
  if (/[;]/.test(after.slice(0, diag.index))) return undefined;
  return PLAIN_EXCLUSION.test(s) && !RESERVATION.test(s) ? "absolute" : "qualified";
}
