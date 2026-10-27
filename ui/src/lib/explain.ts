import type { AnchorView, CaseDetail, DimensionView, Finding } from "../api/types";
import { DIMENSION_NAME } from "./vocab";

/** The dimension views for one finding. If the service sent none, fall back to the mechanical coverage so the facts still show. */
export function dimensionsOf(c: CaseDetail, f: Finding): DimensionView[] {
  const given = c.dimensions[f.id];
  if (given && given.length > 0) return given;
  return f.mechanicalCoverage.map((m) => ({
    dimension: m.dimension,
    relation: m.relation,
    claimed: m.claimed,
    established: m.established,
    reason: "The service did not send a plain-language reason for this dimension.",
    anchorIds: m.anchorIds,
  }));
}

/** The dimensions the evidence does not cover, in the order the compiler lists them. */
export const openDimensions = (c: CaseDetail, f: Finding): DimensionView[] => dimensionsOf(c, f).filter((d) => d.relation !== "CONTAINED");

/**
 * The finding that answers the reviewer's own question (the claim the case is about). The other findings are the vendor's
 * individual claims, checked against the same evidence. A case with one finding has only this one.
 */
export function headlineFinding(c: CaseDetail): Finding | undefined {
  return c.findings.find((f) => f.claimId === c.claim.id) ?? c.findings[0];
}

export const otherFindings = (c: CaseDetail): Finding[] => {
  const head = headlineFinding(c);
  return c.findings.filter((f) => f !== head);
};

/** A short, readable name for a finding's claim: the id the service gave it, never invented wording. */
export function claimName(c: CaseDetail, f: Finding): string {
  return f.claimId === c.claim.id ? "Your intended use" : `Vendor claim ${f.claimId.replace(/^CLM-/, "")}`;
}

/**
 * What a vendor claim says, read from the dimensions where it differs from the evidence: "version 3.0, care setting emergency
 * department". The contract carries no claim sentence for a vendor claim, so this is built from the compared values only.
 */
export function claimSummary(c: CaseDetail, f: Finding): string {
  const open = dimensionsOf(c, f).filter((d) => d.relation !== "CONTAINED" && d.claimed);
  if (open.length === 0) return "Every part of this claim matches the evidence read.";
  return open.map((d) => `${DIMENSION_NAME[d.dimension].toLowerCase()}: ${firstClause(d.claimed!)}`).join("; ");
}

/** The first clause of a long value, so a one-line summary does not carry a whole exclusion list. */
export function firstClause(s: string, max = 90): string {
  const head = s.split(/;\s/)[0] ?? s;
  return head.length > max ? `${head.slice(0, max).trimEnd()}…` : head;
}

/** Anchors worth reading first: those a rule used, then by page. The rest stay one click away. */
export function rankAnchors(anchors: AnchorView[]): AnchorView[] {
  return [...anchors].sort((a, b) => {
    const ra = a.ruleIds.length > 0 ? 0 : 1;
    const rb = b.ruleIds.length > 0 ? 0 : 1;
    if (ra !== rb) return ra - rb;
    if (a.sourceLabel !== b.sourceLabel) return a.sourceLabel < b.sourceLabel ? -1 : 1;
    return (a.page ?? 1e9) - (b.page ?? 1e9);
  });
}
