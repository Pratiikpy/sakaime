/**
 * The canonical fields a newly discovered source can be mapped onto.
 *
 * Each entry says what the field means, which unit or representation it is stored in, what values are plausible,
 * and where the data we already hold for it lives (so an identifier can be checked by joining it). The semantic
 * validator reads these expectations; the model reads only the id, type and description. A field that can be
 * confused with another meaning (study population versus target population, study set versus development set)
 * carries cues for both readings so a swap can be told from a rename.
 */

export type RecordKind = "authorization" | "device_version" | "study" | "publication" | "performance";

export type FieldType =
  | "identifier"
  | "code"
  | "text"
  | "meaning_text"
  | "enum"
  | "date"
  | "year"
  | "count"
  | "age_years"
  | "proportion"
  | "version";

export interface MeaningCues {
  /** Words in a column name, path or nearby description that say this meaning. */
  header: RegExp;
  /** Words that say the competing meaning. */
  contrary: RegExp;
  /** For text fields: wording in the values themselves. `contrary` values contradict this field. */
  valueSelf?: RegExp;
  valueContrary?: RegExp;
  /** The canonical field this one is confused with. */
  confusableWith: string;
  /** The contrary words are qualifiers of the same noun ("planned", "estimated"): one of them in the name settles it. */
  contraryIsQualifier?: boolean;
}

export interface CanonicalField {
  id: string;
  home: RecordKind;
  type: FieldType;
  /** Shown to the model: meaning and unit in one sentence. */
  description: string;
  /** Normalised column names that map here without further evidence. */
  synonyms: string[];
  /** Stored representation, for the report. */
  unit?: string;
  range?: { min: number; max: number };
  /** Allowed values of an enum, upper case. */
  values?: string[];
  /** Earliest and latest plausible date, as years relative to the clock for the latest. */
  dateWindow?: { from: string; futureYears: number };
  meaning?: MeaningCues;
  /**
   * A head noun that, in a table of this field's record kind, identifies the field by itself: the only title column of a
   * study source is the study title. Applied after the table's kind is known, and only to a name that contains the noun.
   */
  contextHead?: string;
}

const f = (x: CanonicalField): CanonicalField => x;

export const CANONICAL_FIELDS: readonly CanonicalField[] = [
  // -------------------------------------------------------------- authorization
  f({
    id: "submission_number",
    home: "authorization",
    type: "identifier",
    description: "FDA premarket submission number: K followed by 6 digits (510(k)), DEN followed by 6 digits (De Novo) or P followed by 6 digits (PMA).",
    synonyms: ["k number", "k_number", "510k number", "510 k number", "510(k) number", "submission number", "submission id", "clearance number", "premarket notification number", "pma number", "den number", "fda submission", "fda number", "regulatory id", "regulator id", "authorization id", "device id", "device identifier", "clearance id", "k numbers", "knumber"],
  }),
  f({
    id: "device_name",
    home: "authorization",
    type: "text",
    description: "Trade or product name of the device as listed by the regulator.",
    synonyms: ["device name", "product name", "trade name", "brand name", "product", "device", "device title", "name of device", "product title", "item name", "tradename"],
  }),
  f({
    id: "applicant",
    home: "authorization",
    type: "text",
    description: "Company that submitted the application (the manufacturer or sponsor).",
    synonyms: ["applicant", "manufacturer", "company", "vendor", "submitter", "firm", "sponsor company", "maker", "applicant name", "company name", "vendor name"],
  }),
  f({
    id: "product_code",
    home: "authorization",
    type: "code",
    description: "FDA product classification code: three capital letters such as PIB.",
    synonyms: ["product code", "procode", "classification code", "fda product code", "pro code"],
  }),
  f({
    id: "decision_date",
    home: "authorization",
    type: "date",
    description: "Date the regulator issued its decision on the submission.",
    synonyms: ["decision date", "cleared on", "clearance date", "date cleared", "approval date", "authorization date", "authorised date", "authorized date", "granted on", "date of decision", "clearance dt", "decided on"],
    dateWindow: { from: "1976-01-01", futureYears: 0 },
  }),
  f({
    id: "device_class",
    home: "authorization",
    type: "enum",
    description: "FDA device class: 1, 2 or 3.",
    synonyms: ["device class", "class", "risk class", "regulatory class", "fda class"],
    values: ["1", "2", "3", "U", "N", "F"],
  }),
  // -------------------------------------------------------------- device version
  f({
    id: "udi_di",
    home: "device_version",
    type: "identifier",
    description: "Unique Device Identification device identifier (GTIN): 8, 12, 13 or 14 digits with a valid GS1 check digit.",
    synonyms: ["udi di", "udi", "device identifier", "gtin", "primary di", "udi device identifier", "di"],
  }),
  f({
    id: "brand_name",
    home: "device_version",
    type: "text",
    description: "Brand name printed on the device label.",
    synonyms: ["brand name", "brand", "label name", "marketing name"],
  }),
  f({
    id: "software_version",
    home: "device_version",
    type: "version",
    description: "Software or model version of the device, for example 2.1.0.",
    synonyms: ["software version", "version", "version or model number", "release", "sw version", "model version", "firmware version", "release number"],
  }),
  // -------------------------------------------------------------- study
  f({
    id: "nct_id",
    home: "study",
    type: "identifier",
    description: "ClinicalTrials.gov registration number: NCT followed by 8 digits.",
    synonyms: ["nct id", "nct number", "nctid", "nct", "trial id", "registry id", "clinicaltrials.gov id", "clinicaltrials id", "study id", "trial registration", "trial registration number", "trial number"],
  }),
  f({
    id: "study_title",
    home: "study",
    type: "text",
    description: "Title of the registered study.",
    contextHead: "title",
    synonyms: ["study title", "brief title", "official title", "trial title", "study name", "trial name"],
  }),
  f({
    id: "enrollment",
    home: "study",
    type: "count",
    description: "Number of participants actually enrolled in the study (a count, not an estimate or a target).",
    synonyms: ["enrollment", "enrolment", "enrollment count", "enrolled", "participants enrolled", "number enrolled", "n enrolled", "actual enrollment", "enrollment actual", "enrolled participants"],
    range: { min: 0, max: 10_000_000 },
    unit: "participants",
    meaning: { header: /enrol|actual|participants|subjects/i, contrary: /plan|target|estimat|anticipat|expect|projected|goal|intended/i, confusableWith: "planned enrollment", contraryIsQualifier: true },
  }),
  f({
    id: "overall_status",
    home: "study",
    type: "enum",
    description: "Recruitment status of the study such as RECRUITING or COMPLETED.",
    synonyms: ["overall status", "status", "study status", "trial status", "recruitment status"],
    values: ["NOT_YET_RECRUITING", "RECRUITING", "ENROLLING_BY_INVITATION", "ACTIVE_NOT_RECRUITING", "COMPLETED", "SUSPENDED", "TERMINATED", "WITHDRAWN", "UNKNOWN", "AVAILABLE", "NO_LONGER_AVAILABLE", "TEMPORARILY_NOT_AVAILABLE", "APPROVED_FOR_MARKETING", "WITHHELD"],
  }),
  f({
    id: "study_start_date",
    home: "study",
    type: "date",
    description: "Date the study started (year-month is allowed).",
    synonyms: ["start date", "study start", "study start date", "started on", "trial start date", "begin date", "date started"],
    dateWindow: { from: "1980-01-01", futureYears: 20 },
  }),
  f({
    id: "min_age_years",
    home: "study",
    type: "age_years",
    description: "Minimum participant age in years that the study admitted.",
    synonyms: ["minimum age", "min age", "min age years", "minimum age years", "lowest age", "age min", "age from", "min_age"],
    range: { min: 0, max: 120 },
    unit: "years",
  }),
  f({
    id: "study_population",
    home: "study",
    type: "meaning_text",
    description: "Who was actually enrolled and analysed in the study (the participants), not who the device is meant for.",
    synonyms: ["study population", "enrolled population", "study cohort", "participants", "enrolled cohort", "study participants", "analysed population", "analyzed population", "cohort"],
    meaning: {
      header: /enrol|participant|cohort|analy[sz]ed|study|recruit|subjects?|sample/i,
      contrary: /target|intended|indicat|eligib|inclusion|exclusion|criteria|label|use population|intended[- ]use/i,
      valueSelf: /\b(enrolled|recruited|analy[sz]ed|participants?|n\s*=\s*\d+|\d[\d,]*\s+(patients|participants|subjects|eyes|cases))\b/i,
      valueContrary: /\b(inclusion criteria|exclusion criteria|eligible|eligibility|must (be|have)|willing to|able to (provide|consent|give))\b/i,
      confusableWith: "target_population",
    },
  }),
  f({
    id: "target_population",
    home: "study",
    type: "meaning_text",
    description: "Who the device or study is intended for (eligibility or intended-use population), not who was actually enrolled.",
    synonyms: ["target population", "intended population", "intended use population", "eligible population", "indicated population", "eligibility", "eligibility criteria", "eligibility summary", "inclusion criteria", "indicated for"],
    meaning: {
      header: /target|intended|indicat|eligib|inclusion|exclusion|criteria|label|intended[- ]use/i,
      contrary: /enrol|participant|cohort|analy[sz]ed|recruit|subjects?|sample/i,
      valueSelf: /\b(inclusion criteria|exclusion criteria|eligible|eligibility|must (be|have)|willing to|able to (provide|consent|give)|aged?\s*\d+)\b/i,
      valueContrary: /\b(were enrolled|was enrolled|enrolled at|were recruited|n\s*=\s*\d+|\d[\d,]*\s+(patients|participants|subjects) (were|was))\b/i,
      confusableWith: "study_population",
    },
  }),
  // -------------------------------------------------------------- publication
  f({
    id: "pmid",
    home: "publication",
    type: "identifier",
    description: "PubMed identifier: a positive integer of up to nine digits.",
    synonyms: ["pmid", "pubmed id", "pubmed identifier", "pubmed", "medline id", "pm id", "pubmed_id", "pubmedid"],
  }),
  f({
    id: "doi",
    home: "publication",
    type: "identifier",
    description: "Digital Object Identifier of a publication: 10.NNNN/suffix.",
    synonyms: ["doi", "digital object identifier", "article doi", "doi url"],
  }),
  f({
    id: "publication_year",
    home: "publication",
    type: "year",
    description: "Four-digit year the article was published.",
    synonyms: ["publication year", "pub year", "year published", "year", "published year", "pubyear"],
  }),
  f({
    id: "article_title",
    home: "publication",
    type: "text",
    description: "Title of the article.",
    contextHead: "title",
    synonyms: ["article title", "paper title", "publication title", "headline"],
  }),
  // -------------------------------------------------------------- performance
  f({
    id: "sensitivity",
    home: "performance",
    type: "proportion",
    description: "Reported sensitivity (true positive rate) as a fraction between 0 and 1.",
    synonyms: ["sensitivity", "sens", "true positive rate", "tpr", "recall", "detection rate", "reported sensitivity"],
    unit: "fraction 0..1",
  }),
  f({
    id: "specificity",
    home: "performance",
    type: "proportion",
    description: "Reported specificity (true negative rate) as a fraction between 0 and 1.",
    synonyms: ["specificity", "spec", "true negative rate", "tnr", "reported specificity"],
    unit: "fraction 0..1",
  }),
  f({
    id: "auc",
    home: "performance",
    type: "proportion",
    description: "Area under the ROC curve as a fraction between 0 and 1.",
    synonyms: ["auc", "area under curve", "area under the curve", "auroc", "roc auc", "c statistic", "c-statistic"],
    unit: "fraction 0..1",
  }),
  f({
    id: "ppv",
    home: "performance",
    type: "proportion",
    description: "Positive predictive value as a fraction between 0 and 1.",
    synonyms: ["ppv", "positive predictive value", "precision"],
    unit: "fraction 0..1",
  }),
  f({
    id: "npv",
    home: "performance",
    type: "proportion",
    description: "Negative predictive value as a fraction between 0 and 1.",
    synonyms: ["npv", "negative predictive value"],
    unit: "fraction 0..1",
  }),
  f({
    id: "study_sample_size",
    home: "performance",
    type: "count",
    description: "Number of cases in the evaluation or validation set the performance was measured on (not the development set).",
    synonyms: ["study sample size", "sample size", "test set size", "validation set size", "evaluation set size", "n evaluated", "n test", "n validation", "cases evaluated", "test n"],
    range: { min: 0, max: 100_000_000 },
    unit: "cases",
    meaning: { header: /study|test|valid|evaluat|holdout|hold-out|enrol|analy[sz]ed|participants/i, contrary: /develop|train|derivation|tuning|calibrat/i, confusableWith: "development_set_size" },
  }),
  f({
    id: "development_set_size",
    home: "performance",
    type: "count",
    description: "Number of cases used to develop or train the algorithm (not the set the performance was measured on).",
    synonyms: ["development set size", "training set size", "train set size", "n train", "n training", "derivation set size", "training n", "dev set size"],
    range: { min: 0, max: 1_000_000_000 },
    unit: "cases",
    meaning: { header: /develop|train|derivation|tuning|calibrat/i, contrary: /study|test|valid|evaluat|holdout|hold-out|enrol|analy[sz]ed|participants/i, confusableWith: "study_sample_size" },
  }),
];

const BY_ID = new Map(CANONICAL_FIELDS.map((c) => [c.id, c]));
export const canonicalField = (id: string): CanonicalField | undefined => BY_ID.get(id);
export const isCanonicalId = (id: string): boolean => BY_ID.has(id);

/** Identifier fields that can key a record, per record kind. A source needs at least one to join anything. */
export const KEY_FIELDS: Record<RecordKind, readonly string[]> = {
  authorization: ["submission_number"],
  device_version: ["udi_di"],
  study: ["nct_id"],
  publication: ["pmid", "doi"],
  performance: ["pmid", "nct_id", "submission_number", "doi"],
};

export const ALL_KEY_FIELDS: readonly string[] = [...new Set(Object.values(KEY_FIELDS).flat())];

// ---------------------------------------------------------------- name handling

/** `protocolSection.identificationModule.nctId` -> ["protocol","section","identification","module","nct","id"]. */
export function nameTokens(name: string): string[] {
  return name
    .replace(/\[\]/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** Lower-case tokens joined by one space. */
export const normalName = (name: string): string => nameTokens(name).join(" ");

/** The last path segment of a flattened field, which is the name a human gave the column. */
export function leafName(path: string): string {
  const segments = path.replace(/\[\]/g, "").split(".");
  return segments[segments.length - 1] ?? path;
}

/** Tokens joined with nothing between them, so "PubMed ID", "pubmed_id" and "pubmedid" are one name. */
const compact = (name: string): string => nameTokens(name).join("");

const normalisedSynonyms = new Map<string, string>();
for (const c of CANONICAL_FIELDS) {
  normalisedSynonyms.set(compact(c.id), c.id);
  for (const s of c.synonyms) {
    const n = compact(s);
    // The first claim wins; a name two fields both list is ambiguous and is dropped.
    const prior = normalisedSynonyms.get(n);
    if (prior === undefined) normalisedSynonyms.set(n, c.id);
    else if (prior !== c.id) normalisedSynonyms.set(n, "");
  }
}

/** The canonical field a column name denotes outright, if exactly one does. */
export function synonymTarget(name: string): string | undefined {
  const hit = normalisedSynonyms.get(compact(leafName(name)));
  return hit ? hit : undefined;
}
