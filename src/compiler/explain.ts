import type { DimensionAssessment, Finding } from "../schemas/index.ts";
import { DIMENSION_NOUN } from "./requests.ts";

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * A plain-language sentence for one assessed dimension, built from the Finding alone, so a finding loaded from storage
 * can be explained without recomputing it. No clinical advice and no verdict words: it states how two scopes relate.
 */
export function describeAssessment(a: Pick<DimensionAssessment, "dimension" | "relation" | "claimed" | "established">): string {
  const noun = cap(DIMENSION_NOUN[a.dimension]);
  const claimed = a.claimed ?? "not stated";
  const established = a.established ?? "not stated";
  switch (a.relation) {
    case "CONTAINED":
      return `${noun}: the claim (${claimed}) lies inside what the evidence establishes (${established}).`;
    case "PARTIAL":
      return `${noun}: the evidence establishes ${established}, which covers only part of the claim (${claimed}).`;
    case "DISJOINT":
      return `${noun}: the claim asks for ${claimed}, but the evidence establishes ${established}.`;
    case "UNKNOWN": {
      const why = [a.claimed === undefined ? "The claim does not state it." : "", a.established === undefined ? "No evidence record in use states it." : ""].filter(Boolean).join(" ");
      return `${noun}: this cannot be decided from what was supplied.${why ? ` ${why}` : ""}`;
    }
  }
}

/** One short paragraph on what the label means for this claim. It restates the finding; it adds no judgement. */
export function summarise(finding: Finding): string {
  const open = finding.mismatches.map((m) => DIMENSION_NOUN[m.dimension]).join(", ");
  switch (finding.label) {
    case "SUPPORTED_FOR_SCOPE":
      return "On every dimension the claim needs, the evidence supplied covers the claimed use. This describes evidence coverage only.";
    case "SUPPORTED_ONLY_FOR_NARROWER_SCOPE":
      return `The evidence supplied covers a narrower use than the one claimed. The part it covers is stated as the supported scope. Not covered: ${open}.`;
    case "CONTRADICTED_BY_SPECIFIED_EVIDENCE":
      return `Specified evidence stands against the claim as stated. See the mismatches${open ? ` (${open})` : ""} for both sides.`;
    case "INSUFFICIENT_EVIDENCE": {
      const lost = finding.degraded.filter((d) => d.dependency === "required").map((d) => d.sourceType);
      const parts = [open ? `not established: ${open}` : "", lost.length ? `required evidence unavailable: ${lost.join(", ")}` : ""].filter(Boolean);
      return `The evidence supplied does not settle the claim (${parts.join("; ")}). The missing-evidence list says what would.`;
    }
    case "REQUIRES_DOMAIN_REVIEW":
      return `A reviewer must decide before this claim can be treated as supported (${finding.expertReviewFlags.length} item${finding.expertReviewFlags.length === 1 ? "" : "s"} flagged).`;
  }
}
