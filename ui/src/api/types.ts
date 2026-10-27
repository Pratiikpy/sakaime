/**
 * Types for the web app. They come from the shared HTTP contract and the shared schemas, never from copies,
 * so a change to either is a compile error here.
 */
import type { z } from "zod";
import type {
  CaseDetailSchema,
  DrillResponseSchema,
  GuardResponseSchema,
  HealthResponseSchema,
  MissingEvidenceItemSchema,
  RecomputeResponseSchema,
  TimelineEventSchema,
  VerifyResponseSchema,
  MatrixRowSchema,
} from "@contract";
import type {
  DimensionSchema,
  LabelSchema,
  LinkStateSchema,
  LinkTypeSchema,
  RelationSchema,
  SourceHealthSchema,
  Finding as FindingT,
  Scope as ScopeT,
  Link as LinkT,
} from "@schemas";

export type { RunMode, SourceRow, OnboardingResult, CaseSummary, AnchorView, DimensionView, EvidenceMatrix, TraceEvent, UslResponse } from "@contract";

export type Label = z.infer<typeof LabelSchema>;
export type Dimension = z.infer<typeof DimensionSchema>;
export type Relation = z.infer<typeof RelationSchema>;
export type SourceHealth = z.infer<typeof SourceHealthSchema>;
export type LinkState = z.infer<typeof LinkStateSchema>;
export type LinkType = z.infer<typeof LinkTypeSchema>;
export type Finding = FindingT;
export type Scope = ScopeT;
export type Link = LinkT;

export type CaseDetail = z.infer<typeof CaseDetailSchema>;
export type Health = z.infer<typeof HealthResponseSchema>;
export type RecomputeResponse = z.infer<typeof RecomputeResponseSchema>;
export type DrillResponse = z.infer<typeof DrillResponseSchema>;
export type GuardResponse = z.infer<typeof GuardResponseSchema>;
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type MissingEvidenceItem = z.infer<typeof MissingEvidenceItemSchema>;
export type MatrixRow = z.infer<typeof MatrixRowSchema>;
