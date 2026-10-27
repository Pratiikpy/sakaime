import { z } from "zod";

/** The only five verdicts the product can emit. There is deliberately no "safe", "cleared" or "compliant". */
export const LABELS = [
  "SUPPORTED_FOR_SCOPE",
  "SUPPORTED_ONLY_FOR_NARROWER_SCOPE",
  "CONTRADICTED_BY_SPECIFIED_EVIDENCE",
  "INSUFFICIENT_EVIDENCE",
  "REQUIRES_DOMAIN_REVIEW",
] as const;
export const LabelSchema = z.enum(LABELS);
export type Label = z.infer<typeof LabelSchema>;

/** The dimensions on which a claimed use is compared with what the evidence establishes. */
export const DIMENSIONS = ["product", "version", "population", "setting", "purpose", "timing", "metric"] as const;
export const DimensionSchema = z.enum(DIMENSIONS);
export type Dimension = z.infer<typeof DimensionSchema>;

/**
 * How the claimed scope on one dimension relates to the scope the evidence establishes.
 * CONTAINED: claimed is inside what the evidence covers.
 * PARTIAL: the evidence covers only part of the claimed scope (a narrower scope is supported).
 * DISJOINT: the evidence concerns a different scope.
 * UNKNOWN: one side is unspecified, so nothing can be concluded. Unknown is never treated as contained.
 */
export const RELATIONS = ["CONTAINED", "PARTIAL", "DISJOINT", "UNKNOWN"] as const;
export const RelationSchema = z.enum(RELATIONS);
export type Relation = z.infer<typeof RelationSchema>;

/** What kind of statement a piece of evidence is. Authority depends on this, never on one global ranking. */
export const ASSERTION_TYPES = ["authorization", "study", "requirement", "vendor"] as const;
export const AssertionTypeSchema = z.enum(ASSERTION_TYPES);
export type AssertionType = z.infer<typeof AssertionTypeSchema>;

export const SOURCE_HEALTH = ["OK", "EMPTY", "UNAVAILABLE", "FORBIDDEN", "DRIFTED", "STALE", "BLOCKED"] as const;
export const SourceHealthSchema = z.enum(SOURCE_HEALTH);
export type SourceHealth = z.infer<typeof SourceHealthSchema>;

export const LINK_TYPES = [
  "SAME_SUBMISSION",
  "SAME_PRODUCT",
  "SAME_MARKETED_VERSION",
  "STUDY_EVALUATES",
  "PUBLICATION_REPORTS",
  "SUPERSEDES",
] as const;
export const LinkTypeSchema = z.enum(LINK_TYPES);
export type LinkType = z.infer<typeof LinkTypeSchema>;

export const LINK_STATES = ["CONFIRMED", "CANDIDATE", "AMBIGUOUS", "REJECTED"] as const;
export const LinkStateSchema = z.enum(LINK_STATES);
export type LinkState = z.infer<typeof LinkStateSchema>;

/** Data classes control what may leave the machine (see docs/02-architecture.md, section 12). */
export const DATA_CLASSES = ["public", "vendor-confidential", "phi"] as const;
export const DataClassSchema = z.enum(DATA_CLASSES);
export type DataClass = z.infer<typeof DataClassSchema>;
