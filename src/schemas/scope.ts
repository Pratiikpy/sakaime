import { z } from "zod";
import { AssertionTypeSchema } from "./common.ts";

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const AgeRangeSchema = z
  .object({
    /** Years. An absent bound is open. */
    min: z.number().nonnegative().optional(),
    max: z.number().nonnegative().optional(),
  })
  .refine((a) => a.min === undefined || a.max === undefined || a.min <= a.max, "min must not exceed max");
export type AgeRange = z.infer<typeof AgeRangeSchema>;

export const PopulationSchema = z.object({
  age: AgeRangeSchema.optional(),
  /** Target conditions the population has (claim) or was enrolled for (evidence). */
  conditions: z.array(z.string().min(1)).optional(),
  /** Groups the evidence excluded. For a claim this is groups the buyer does not intend to include. */
  exclusions: z.array(z.string().min(1)).optional(),
});
export type Population = z.infer<typeof PopulationSchema>;

export const TimingSchema = z.object({
  /** Claim: the date the use begins. Authorization: effective from. Study: the date the evidence existed. */
  from: IsoDate.optional(),
  /** Authorization: superseded or withdrawn on. Not used for studies. */
  to: IsoDate.optional(),
});
export type Timing = z.infer<typeof TimingSchema>;

/**
 * A scope is what a claim wants to rely on, or what a piece of evidence establishes.
 * Every field is optional: an absent field is UNSPECIFIED, which is never read as "everything".
 */
export const ScopeSchema = z.object({
  /** Canonical product identity, for example "device:fda:K200667". */
  product: z.string().min(1).optional(),
  /** Software release labels. A claim names one; evidence may name several. */
  versions: z.array(z.string().min(1)).optional(),
  population: PopulationSchema.optional(),
  /** Care settings, as keys of the setting hierarchy. */
  settings: z.array(z.string().min(1)).optional(),
  /** Intended purpose class, for example "triage_notification". */
  purpose: z.string().min(1).optional(),
  timing: TimingSchema.optional(),
  /** Threshold or operating point the performance was reported at. */
  operatingPoint: z.string().min(1).optional(),
});
export type Scope = z.infer<typeof ScopeSchema>;

export const ClaimedPerformanceSchema = z.object({
  metric: z.string().min(1),
  /** The claim: the metric is at least this value (same unit as the evidence results). */
  atLeast: z.number(),
});
export type ClaimedPerformance = z.infer<typeof ClaimedPerformanceSchema>;

export const SourceDependenciesSchema = z.object({
  /** Evidence types the claim cannot be supported without. */
  required: z.array(AssertionTypeSchema),
  /** Evidence types that strengthen the explanation; losing one never changes the label. */
  corroborating: z.array(AssertionTypeSchema).default([]),
});
export type SourceDependencies = z.infer<typeof SourceDependenciesSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().optional(),
  use: ScopeSchema,
  performance: ClaimedPerformanceSchema.optional(),
  dependencies: SourceDependenciesSchema.optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const EvidenceResultSchema = z.object({
  metric: z.string().min(1),
  value: z.number(),
  /** Confidence interval, same unit as value. */
  ci: z.tuple([z.number(), z.number()]).optional(),
  n: z.number().int().nonnegative().optional(),
  operatingPoint: z.string().optional(),
  anchorId: z.string().optional(),
});
export type EvidenceResult = z.infer<typeof EvidenceResultSchema>;

export const EvidenceItemSchema = z.object({
  id: z.string().min(1),
  assertionType: AssertionTypeSchema,
  scope: ScopeSchema,
  results: z.array(EvidenceResultSchema).default([]),
  /** Whether the study is adequate to contradict a claim. Unknown (absent) needs a reviewer. */
  adequate: z.boolean().optional(),
  /** For a requirement item: whether the hospital's own requirement is met. */
  satisfied: z.boolean().optional(),
  /** Free-text limitations stated by the source. */
  limitations: z.array(z.string()).default([]),
  anchorIds: z.array(z.string()).default([]),
});
export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;
