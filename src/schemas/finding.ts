import { z } from "zod";
import { DimensionSchema, LabelSchema, RelationSchema } from "./common.ts";
import { IsoDateTime } from "./evidence.ts";

export const DimensionAssessmentSchema = z.object({
  dimension: DimensionSchema,
  relation: RelationSchema,
  /** Rendered value the claim asks for on this dimension. */
  claimed: z.string().optional(),
  /** Rendered value the evidence establishes on this dimension. */
  established: z.string().optional(),
  /** Anchors that decided the relation. */
  anchorIds: z.array(z.string()).default([]),
  /** Evidence item ids the relation was computed from. */
  evidenceIds: z.array(z.string()).default([]),
});
export type DimensionAssessment = z.infer<typeof DimensionAssessmentSchema>;

/** The smallest set of disagreeing dimensions, with both sides shown. */
export const MismatchSchema = z.object({
  dimension: DimensionSchema,
  relation: RelationSchema,
  claimed: z.string().optional(),
  established: z.string().optional(),
  anchorIds: z.array(z.string()).default([]),
});
export type Mismatch = z.infer<typeof MismatchSchema>;

/** What would settle an UNKNOWN or NOT_CONTAINED dimension, specific enough to send to a vendor. */
export const RequiredEvidenceSchema = z.object({
  dimension: DimensionSchema,
  request: z.string().min(1),
});
export type RequiredEvidence = z.infer<typeof RequiredEvidenceSchema>;

/** A judgement the code refuses to make. Never silently dropped. */
export const ExpertFlagSchema = z.object({
  ruleId: z.string().min(1),
  reason: z.string().min(1),
  dimension: DimensionSchema.optional(),
});
export type ExpertFlag = z.infer<typeof ExpertFlagSchema>;

export const ContraryDispositionSchema = z.object({
  evidenceId: z.string().min(1),
  /** relevant: same version and population; weak: low quality; off_scope: different use. */
  relevance: z.enum(["relevant", "weak", "off_scope"]),
  adequate: z.boolean().optional(),
  note: z.string().optional(),
});
export type ContraryDisposition = z.infer<typeof ContraryDispositionSchema>;

export const REVIEWER_STATES = ["unreviewed", "accepted", "narrowed", "evidence_requested", "escalated"] as const;

export const FindingSchema = z.object({
  id: z.string().min(1),
  claimId: z.string().min(1),
  label: LabelSchema,
  /** The narrower scope that is supported, present only for SUPPORTED_ONLY_FOR_NARROWER_SCOPE. */
  supportedScope: z.record(z.string(), z.unknown()).optional(),
  /** Mechanical coverage: computed by code, per dimension. */
  mechanicalCoverage: z.array(DimensionAssessmentSchema),
  /** Expert applicability: flagged, never computed. */
  expertReviewFlags: z.array(ExpertFlagSchema).default([]),
  mismatches: z.array(MismatchSchema).default([]),
  requiredEvidence: z.array(RequiredEvidenceSchema).default([]),
  contraryDispositions: z.array(ContraryDispositionSchema).default([]),
  /** Fact ids the finding depends on, used for change impact. */
  dependsOnFacts: z.array(z.string()).default([]),
  /** Sources lost while computing, by dependency class. */
  degraded: z
    .array(z.object({ sourceType: z.string(), dependency: z.enum(["required", "corroborating", "optional"]), reason: z.string() }))
    .default([]),
  ruleVersion: z.string().min(1),
  traceId: z.string().optional(),
  reviewerState: z.enum(REVIEWER_STATES).default("unreviewed"),
  /** A newer finding records the one it replaces and why; the old one is never rewritten. */
  supersedes: z.string().optional(),
  supersedesReason: z.string().optional(),
  computedAt: IsoDateTime.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;
