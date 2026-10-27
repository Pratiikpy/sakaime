/**
 * Identifier canonicalisation and the reading of a cited identifier's role.
 *
 * An identifier proves that two records are connected; it does not say how. The role matters: the DEN200055
 * summary cites NCT01694966 as the origin of its training videos and NCT04079478 as the study that tested the
 * device, and a string match cannot tell them apart. `classifyMentionContext` reads the passage around a text
 * mention with a small, fixed cue list and says only what the cues support.
 */

const SUBMISSION = /\b(K\d{6}|DEN\d{6}|P\d{6}(?:\/S\d{3})?)\b/gi;
const NCT = /\bNCT\d{8}\b/gi;

/** K, DEN and P numbers in canonical upper case; supplement S000 means the original submission. */
export function canonicalSubmissionId(raw: string): string | undefined {
  const m = /^\s*(K\d{6}|DEN\d{6}|P\d{6})(?:\s*\/\s*S(\d{1,3}))?\s*$/i.exec(raw);
  if (!m) return undefined;
  const base = m[1]!.toUpperCase();
  const supplement = m[2] === undefined ? 0 : Number(m[2]);
  return supplement === 0 ? base : `${base}/S${String(supplement).padStart(3, "0")}`;
}

export function extractSubmissionIds(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(SUBMISSION)) {
    const id = canonicalSubmissionId(m[1]!);
    if (id) found.add(id);
  }
  return [...found];
}

export function canonicalNct(raw: string): string | undefined {
  const m = /^\s*(NCT\d{8})\s*$/i.exec(raw);
  return m ? m[1]!.toUpperCase() : undefined;
}

export function extractNctIds(text: string): string[] {
  return [...new Set([...text.matchAll(NCT)].map((m) => m[0].toUpperCase()))];
}

export function canonicalPmid(raw: string): string | undefined {
  const m = /^\s*(\d{1,9})\s*$/.exec(raw);
  return m ? String(Number(m[1])) : undefined;
}

export function canonicalDoi(raw: string): string | undefined {
  const m = /^\s*(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)?(10\.\d{4,9}\/\S+?)\s*$/i.exec(raw);
  return m ? m[1]!.toLowerCase().replace(/[.,;]+$/, "") : undefined;
}

export function canonicalUdiDi(raw: string): string | undefined {
  // A GS1 element string starts with the application identifier (01) in front of the 14-digit GTIN.
  const digits = raw.replace(/^\s*\(01\)/, "").replace(/[\s()-]/g, "");
  return /^\d{8,14}$/.test(digits) ? digits.padStart(14, "0") : undefined;
}

export type CanonicalIdKind = "submission" | "nct" | "pmid" | "doi" | "udiDi";

export function canonicalId(kind: CanonicalIdKind, raw: string): string | undefined {
  switch (kind) {
    case "submission":
      return canonicalSubmissionId(raw);
    case "nct":
      return canonicalNct(raw);
    case "pmid":
      return canonicalPmid(raw);
    case "doi":
      return canonicalDoi(raw);
    case "udiDi":
      return canonicalUdiDi(raw);
  }
}

export function canonicalSet(kind: CanonicalIdKind, values: readonly string[]): string[] {
  const out = new Set<string>();
  for (const v of values) {
    const c = canonicalId(kind, v);
    if (c) out.add(c);
  }
  return [...out].sort();
}

// ------------------------------------------------------------------------------------------ mention roles

export type MentionPurpose = "evaluation" | "report";
export type RoleVerdict = "ESTABLISHED" | "CONTRADICTED" | "UNKNOWN";

export interface RoleReading {
  verdict: RoleVerdict;
  /** The cue phrases that decided it, for the audit trail. */
  cues: string[];
}

/** Phrases showing the cited study supplied data or background rather than being tested or reported. */
const ORIGIN_CUES: RegExp[] = [
  /\boriginally from\b/i,
  /\btraining\b/i,
  /\bdevelopment (?:data|set|dataset|cohort)\b/i,
  /\bpreviously (?:published|reported)\b/i,
  /\bas (?:described|reported) (?:in|by)\b/i,
  /\bbackground (?:reference|literature)\b/i,
];

const EVALUATION_CUES: RegExp[] = [
  /\bvalidat(?:ed|ion)\b/i,
  /\bpivotal\b/i,
  /\bprospective(?:ly)?\b/i,
  /\bmulti-?cent(?:er|re)\b/i,
  /\bclinical (?:study|trial|validation|evaluation)\b/i,
  /\b(?:study|trial) (?:was )?(?:conducted|performed)\b/i,
  /\bperformed (?:in|at)\b/i,
  /\bcompared the performance/i,
];

const REPORT_CUES: RegExp[] = [
  /\btrial registration\b/i,
  /\bregistered\b/i,
  /\bclinicaltrials\.gov (?:identifier|id|number|registration)\b/i,
  /\bprotocol\b/i,
];

function matchedCues(patterns: RegExp[], text: string): string[] {
  const hits: string[] = [];
  for (const p of patterns) {
    const m = p.exec(text);
    if (m) hits.push(m[0].toLowerCase());
  }
  return hits;
}

/**
 * Reads a passage around a free-text mention. ESTABLISHED needs a cue that the cited study was run on or
 * reported for the thing at hand and no cue that it was only a data source. Both kinds of cue together, or
 * neither, leave the role UNKNOWN: the identifier is real but its meaning is not established.
 */
export function classifyMentionContext(context: string | undefined, purpose: MentionPurpose): RoleReading {
  const text = context ?? "";
  const origin = matchedCues(ORIGIN_CUES, text);
  const positive = matchedCues(purpose === "evaluation" ? EVALUATION_CUES : [...REPORT_CUES, ...EVALUATION_CUES], text);
  if (origin.length > 0 && positive.length === 0) return { verdict: "CONTRADICTED", cues: origin };
  if (origin.length === 0 && positive.length > 0) return { verdict: "ESTABLISHED", cues: positive };
  return { verdict: "UNKNOWN", cues: [...positive, ...origin] };
}
