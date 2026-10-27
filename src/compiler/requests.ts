import type { Dimension, Relation } from "../schemas/index.ts";

export const DIMENSION_NOUN: Record<Dimension, string> = {
  product: "product",
  version: "software version",
  population: "patient population",
  setting: "care setting",
  purpose: "intended purpose",
  timing: "date",
  metric: "performance result",
};

export const UNSPECIFIED_EVIDENCE_RULE: Record<Dimension, string> = {
  product: "SAK-EVIDENCE-UNSPECIFIED",
  version: "R02-VER-UNRECORDED",
  population: "R11-POP-UNDESCRIBED",
  setting: "R15-SETTING-NOT-STUDIED",
  purpose: "SAK-EVIDENCE-UNSPECIFIED",
  timing: "R19-DATES-MISSING",
  metric: "R32-METRIC-ABSENT",
};

export interface RequestContext {
  dimension: Dimension;
  relation: Relation;
  /** Why the relation is not decided, when it is UNKNOWN. */
  cause?: "claim" | "evidence" | "pending";
  claimed?: string;
  established?: string;
  gap?: string;
  narrower?: string;
  term?: string;
}

/**
 * What would settle a dimension that is not CONTAINED, written so it can be sent to a vendor as it stands.
 * Dimension-specific requests for timing and metric are built where their facts are known.
 */
export function genericRequest(c: RequestContext): string {
  const noun = DIMENSION_NOUN[c.dimension];
  if (c.relation === "UNKNOWN") {
    if (c.cause === "claim") {
      return `State the ${noun} the claim covers. The claim as written leaves it open, and an open ${noun} is never read as covering everything.`;
    }
    if (c.cause === "pending") {
      return `A reviewer must place ${c.term ? `"${c.term}"` : "the term"} in the ${noun} taxonomy. No document from the vendor settles that.`;
    }
    switch (c.dimension) {
      case "product":
        return "From the vendor: the exact product name and FDA submission number (K, DEN or P number) that the authorization record and the study cover.";
      case "version":
        return "From the vendor: the software version evaluated in the study and the version the authorization covers, quoted from the study report or the authorization letter.";
      case "population":
        return "From the vendor: the study's inclusion and exclusion criteria and a table of the evaluated participants by age and condition, or the authorization's wording on the patient population.";
      case "setting":
        return "From the vendor: the care settings and the number of sites in which the study was run, quoted from the study report.";
      case "purpose":
        return "From the vendor: the intended-use statement, quoted from the authorization letter or the indications-for-use form.";
      case "timing":
        return "From the vendor: the date the authorization took effect and any date it was superseded or withdrawn, and the dates over which the study data were collected.";
      case "metric":
        return "From the vendor: the study result for the claimed metric, with its confidence interval and the operating point it was measured at.";
    }
  }
  const claimed = c.claimed ?? "the claimed scope";
  const established = c.established ?? "the evidenced scope";
  switch (c.dimension) {
    case "product":
      return `From the vendor: written confirmation that the evidence for ${established} describes ${claimed}, or evidence for ${claimed} itself.`;
    case "version":
      return c.relation === "PARTIAL"
        ? `From the vendor: results for ${c.gap ?? "the remaining versions"}, or restate the claim for ${c.narrower ?? "the evaluated versions"}.`
        : `From the vendor: study results for software version ${claimed}, or a written change-control statement saying whether ${claimed} differs from the evaluated version (${established}) in the model or only in the build, with performance data for ${claimed}.`;
    case "population":
      return c.relation === "PARTIAL"
        ? `From the vendor: performance results for ${c.gap ?? "the uncovered part of the population"}, or restate the claim to cover only ${c.narrower ?? "the evidenced population"}.`
        : `From the vendor: a study or authorization covering ${claimed}, or restate the claim for a population the evidence covers (${established}).`;
    case "setting":
      return c.relation === "PARTIAL"
        ? `From the vendor: study results from ${c.gap ?? "the remaining settings"}, or restate the claim to cover only ${c.narrower ?? "the settings studied"}.`
        : `From the vendor: study results from ${claimed}, or restate the claim for the settings studied (${established}).`;
    case "purpose":
      return c.relation === "PARTIAL"
        ? `From the vendor: an authorization or study covering ${c.gap ?? "the claimed purpose"}, or restate the claim to the evidenced purpose (${c.narrower ?? established}).`
        : `From the vendor: an authorization or study covering ${claimed}, or restate the claim. The evidence concerns ${established}.`;
    case "timing":
      return `From the vendor: an authorization record in force for ${claimed}.`;
    case "metric":
      return `From the vendor: a result for ${claimed} with its confidence interval.`;
  }
}
