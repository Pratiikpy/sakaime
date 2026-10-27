import type { Label, Dimension, Relation, SourceHealth, LinkState, LinkType } from "../api/types";

export type IconName =
  | "check" | "check-partial" | "cross" | "gap" | "person" | "empty" | "unplugged" | "drift"
  | "lock" | "clock" | "block" | "warn" | "info" | "copy" | "chevron" | "sun" | "moon" | "menu"
  | "close" | "play" | "arrow" | "file" | "link" | "database" | "bolt" | "shield" | "recorded" | "constructed";

/** The five labels, in plain language. The token is never hidden: it is the title and the screen-reader suffix. */
export interface LabelMeta {
  words: string;
  /** One sentence a hospital reviewer understands without our jargon. */
  gloss: string;
  icon: IconName;
  tone: "good" | "partial" | "bad" | "unknown" | "review";
}

export const LABEL_META: Record<Label, LabelMeta> = {
  SUPPORTED_FOR_SCOPE: {
    words: "Supported for this use",
    gloss: "The cited evidence covers every part of the use you described.",
    icon: "check",
    tone: "good",
  },
  SUPPORTED_ONLY_FOR_NARROWER_SCOPE: {
    words: "Supported only for a narrower use",
    gloss: "The evidence covers part of the use you described, not all of it.",
    icon: "check-partial",
    tone: "partial",
  },
  CONTRADICTED_BY_SPECIFIED_EVIDENCE: {
    words: "Contradicted by specified evidence",
    gloss: "Named evidence limits or disagrees with the claim for this use.",
    icon: "cross",
    tone: "bad",
  },
  INSUFFICIENT_EVIDENCE: {
    words: "Not enough evidence",
    gloss: "A needed source or fact is missing, so nothing can be said either way.",
    icon: "gap",
    tone: "unknown",
  },
  REQUIRES_DOMAIN_REVIEW: {
    words: "Needs domain review",
    gloss: "The evidence leaves a judgement that a clinical or domain reviewer must make.",
    icon: "person",
    tone: "review",
  },
};

export interface RelationMeta {
  words: string;
  gloss: string;
  icon: IconName;
  tone: "good" | "partial" | "bad" | "unknown";
}

export const RELATION_META: Record<Relation, RelationMeta> = {
  CONTAINED: { words: "Contained", gloss: "The use sits inside what the evidence covers.", icon: "check", tone: "good" },
  PARTIAL: { words: "Partial", gloss: "The evidence covers only part of the use.", icon: "check-partial", tone: "partial" },
  DISJOINT: { words: "Disjoint", gloss: "The evidence is about a different use.", icon: "cross", tone: "bad" },
  UNKNOWN: { words: "Unknown", gloss: "One side does not say, so nothing can be concluded. Unknown is never read as covered.", icon: "gap", tone: "unknown" },
};

export const DIMENSION_NAME: Record<Dimension, string> = {
  product: "Product",
  version: "Software version",
  population: "Population",
  setting: "Care setting",
  purpose: "Purpose",
  timing: "Timing",
  metric: "Performance",
};

export const DIMENSION_QUESTION: Record<Dimension, string> = {
  product: "Which product?",
  version: "Which release?",
  population: "Which patients?",
  setting: "Where is it used?",
  purpose: "What for?",
  timing: "From when?",
  metric: "How well does it perform?",
};

export interface HealthMeta {
  words: string;
  gloss: string;
  icon: IconName;
  tone: "good" | "bad" | "warn" | "neutral";
}

/** EMPTY, UNAVAILABLE and the rest read differently on purpose: only EMPTY can support "none found". */
export const HEALTH_META: Record<SourceHealth, HealthMeta> = {
  OK: { words: "Answering", gloss: "The source answered and returned records.", icon: "check", tone: "good" },
  EMPTY: { words: "Answered, nothing found", gloss: "The source answered and holds no matching records. This is the only state that can support “none found”.", icon: "empty", tone: "neutral" },
  UNAVAILABLE: { words: "Could not be reached", gloss: "No answer, so nothing can be said about what it holds. This is never read as “none exist”.", icon: "unplugged", tone: "bad" },
  DRIFTED: { words: "Answer changed shape", gloss: "The source replied, but not in the shape we expect. Its data is not read until the mapping is reviewed.", icon: "drift", tone: "bad" },
  FORBIDDEN: { words: "Refused by policy", gloss: "A rule or identity refused this request. It is not an outage.", icon: "lock", tone: "bad" },
  STALE: { words: "Out of date", gloss: "Records exist but are older than the freshness window.", icon: "clock", tone: "warn" },
  BLOCKED: { words: "Blocked for scripts", gloss: "The provider refuses automated access. A pinned snapshot may stand in, labelled as such.", icon: "block", tone: "warn" },
};

export const ASSERTION_NAME: Record<string, string> = {
  authorization: "Regulatory authorization",
  study: "Study result",
  requirement: "Hospital requirement",
  vendor: "Vendor statement",
};

export const KIND_NAME: Record<string, string> = {
  regulator: "Regulator",
  registry: "Registry",
  literature: "Literature",
  vendor: "Vendor",
  hospital: "Hospital",
  other: "Other",
};

export const ACCESS_NAME: Record<string, string> = {
  zetaris: "Zetaris federation",
  connector: "Direct connector",
  file: "File snapshot",
};

export const LINK_TYPE_NAME: Record<LinkType, { words: string; gloss: string }> = {
  SAME_SUBMISSION: { words: "Same regulatory submission", gloss: "Both records name the same FDA submission number." },
  SAME_PRODUCT: { words: "Same product", gloss: "Both records describe the same named product." },
  SAME_MARKETED_VERSION: { words: "Same marketed version", gloss: "Both records name the same software release. A shared submission does not imply this." },
  STUDY_EVALUATES: { words: "Study evaluates it", gloss: "The study tested this product." },
  PUBLICATION_REPORTS: { words: "Paper reports the study", gloss: "The publication reports results of that study." },
  SUPERSEDES: { words: "Supersedes", gloss: "The newer record replaces the older one." },
};

export const LINK_STATE_META: Record<LinkState, { words: string; gloss: string; icon: IconName; tone: "good" | "partial" | "bad" | "unknown" }> = {
  CONFIRMED: { words: "Confirmed", gloss: "Established by a shared identifier or a reviewer.", icon: "check", tone: "good" },
  CANDIDATE: { words: "Candidate", gloss: "Probably the same, not yet confirmed. Not used as fact.", icon: "check-partial", tone: "partial" },
  AMBIGUOUS: { words: "Ambiguous", gloss: "The evidence does not separate two readings. Left open on purpose.", icon: "gap", tone: "unknown" },
  REJECTED: { words: "Rejected", gloss: "Shown not to be the same.", icon: "cross", tone: "bad" },
};

export const CANDIDATE_CLASS_NAME: Record<string, string> = {
  EXACT_IDENTIFIER: "Exact identifier",
  STRONG_TEXT: "Strong text match",
  WEAK_NAME_ONLY: "Weak: name only",
  NONE: "No match",
};

export const ROLE_META: Record<string, { name: string; does: string }> = {
  guard: { name: "Guard", does: "Screens text for instructions aimed at the system" },
  planner: { name: "Planner", does: "Decides which sources the question needs" },
  discoverer: { name: "Discoverer", does: "Finds and registers sources" },
  retriever: { name: "Retriever", does: "Fetches records and runs the federated query" },
  resolver: { name: "Resolver", does: "Decides which records describe the same thing" },
  extractor: { name: "Extractor", does: "Reads quotes and numbers from documents" },
  critic: { name: "Critic", does: "Looks for contrary evidence" },
  compiler: { name: "Compiler", does: "Compares the claim with the evidence, by rule" },
  reporter: { name: "Reporter", does: "Writes only what findings support" },
  system: { name: "System", does: "Run control" },
};

export const DECISION_ACTIONS = [
  { action: "accept", words: "Accept", gloss: "Record that you accept this finding as it stands." },
  { action: "narrow", words: "Narrow the use", gloss: "Record that the use will be limited to what the evidence supports." },
  { action: "request_evidence", words: "Request evidence", gloss: "Record that you are asking the vendor for the missing evidence." },
  { action: "escalate", words: "Escalate", gloss: "Record that a clinical or domain reviewer must decide." },
] as const;

export const DRILL_META: Record<string, { name: string; does: string; needsTarget: boolean }> = {
  source_off: { name: "A source goes offline", does: "One named source stops answering. The label may fall, never rise.", needsTarget: true },
  source_empty: { name: "A source answers with no rows", does: "One source answers but returns nothing. Reads differently from an outage.", needsTarget: true },
  zetaris_off: { name: "The federation engine stops", does: "Zetaris is switched off. Sources reached through it are lost.", needsTarget: false },
  truncated_result: { name: "A federated result is cut short", does: "The result is incomplete. It is refused, never used as a partial answer.", needsTarget: false },
  model_off: { name: "The model route fails", does: "No model can be called. Labels come from rules, so they should not move.", needsTarget: false },
  registry_changed: { name: "A registry record changes", does: "A fact changes after a finding was made. Only dependent findings go stale.", needsTarget: false },
  injection_in_document: { name: "A vendor document gives orders", does: "A document tells the system to mark the claim supported. It must not work.", needsTarget: false },
};

export const FINDING_TYPES = {
  authorization: { words: "Regulatory authorization", gloss: "What the regulator authorized: product, version, indication, setting, date." },
  reporting: { words: "Reporting completeness", gloss: "Whether the evidence reports what is needed to judge this use." },
  performance: { words: "Empirical performance", gloss: "What a measured study found, and whether it applies here." },
  policy: { words: "Institutional policy", gloss: "What this hospital requires, regardless of the evidence." },
  judgement: { words: "Unresolved clinical judgement", gloss: "A call the system will not make for a human reviewer." },
} as const;
export type FindingTypeKey = keyof typeof FINDING_TYPES;

export const SETTING_SUGGESTIONS = [
  "primary_care", "eye_care", "emergency_department", "inpatient_ward", "intensive_care_unit",
  "outpatient_care", "urgent_care", "specialty_clinic", "imaging_centre", "home_or_remote",
];
export const PURPOSE_SUGGESTIONS = [
  "dr_screening_detection", "detection_aid", "triage_notification", "diagnosis", "screening",
  "prognosis", "monitoring", "treatment_planning", "acquisition_guidance",
];
