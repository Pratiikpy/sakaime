import type { Claim, Dimension, Label } from "../../src/schemas/index.ts";

export type { Claim, Dimension, Label };

/** Class tags that every reported number carries (docs/06 section 2). */
export type ResultClass = "consistency" | "domain-validity" | "builder-labelled";

export const SUPPORT_LABELS: readonly Label[] = ["SUPPORTED_FOR_SCOPE", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE"];
export const WITHHOLDING_LABELS: readonly Label[] = ["CONTRADICTED_BY_SPECIFIED_EVIDENCE", "INSUFFICIENT_EVIDENCE", "REQUIRES_DOMAIN_REVIEW"];
export const ABSTAIN_LABELS: readonly Label[] = ["INSUFFICIENT_EVIDENCE", "REQUIRES_DOMAIN_REVIEW"];

export interface KeyMismatch {
  dimension: Dimension;
  claimed: string;
  established: string;
}

export interface CaseKey {
  expectedLabel: Label;
  /** Other labels that also withhold support. Never contains a SUPPORTED label. */
  acceptableLabels: Label[];
  keyConfidence: "clear" | "contestable";
  mismatches: KeyMismatch[];
  supportedNarrowerScope?: string;
  note?: string;
}

/** One case of a suite: the input every arm receives plus, kept apart, the key it is scored against. */
export interface EvalCase {
  id: string;
  /** The unit of independence: a device or product family. Cases of one cluster are correlated. */
  cluster: string;
  /** Canonical product id, for example device:fda:K200667. */
  product: string;
  kind: "positive control" | "mismatch";
  /** Whether the case belongs to the development set or to the sealed held-out set. */
  partition: "development" | "held-out" | "controlled";
  text: string;
  claim: Claim;
  /** Hospital policy passed with the case (a staleness window is a hospital choice, not a standard). */
  policy?: { stalenessWindowDays?: number };
  key: CaseKey;
}

/** What an arm hands back for one case. `label` is null when the arm emitted no verdict (NONE) or the call failed (UNAVAILABLE). */
export interface ArmOutput {
  label: Label | null;
  status: "ok" | "none" | "unavailable";
  mismatches: { dimension: string; claimed?: string; established?: string; anchored: boolean }[];
  /** Free-text reason for UNAVAILABLE or NONE. */
  detail?: string;
  /** Evidence ids or quotes the arm cited, for the soundness check. */
  citations?: string[];
}

export function isSupportLabel(l: Label | null): boolean {
  return l !== null && SUPPORT_LABELS.includes(l);
}
