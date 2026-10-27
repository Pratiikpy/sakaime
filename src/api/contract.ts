/**
 * HTTP contract between the Sakaime service (src/api, src/service) and the web app (ui/).
 * Everything the UI shows comes from these shapes. All endpoints are JSON under /api unless noted.
 * The UI never recomputes a label: labels come from the compiler through the service.
 */
import { z } from "zod";
import {
  ClaimSchema,
  DimensionSchema,
  FindingSchema,
  LabelSchema,
  LinkSchema,
  ScopeSchema,
  SourceHealthSchema,
  SourceSchema,
  EvidenceAnchorSchema,
  DataClassSchema,
} from "../schemas/index.ts";

/** How each layer of the system is currently being served. Shown on every screen so nothing live is faked. */
export const RunModeSchema = z.object({
  /** True when the whole run replays recorded real responses (SAMPLE_MODE). */
  sample: z.boolean(),
  federation: z.enum(["live", "cassette", "fallback", "off"]),
  model: z.enum(["nightshift", "nvidia", "recorded", "off"]),
  sources: z.enum(["live", "cassette"]),
  zetarisReachable: z.boolean(),
  nightshiftReachable: z.boolean(),
  /** Anything running degraded, in plain words, for the banner. */
  degradedNotes: z.array(z.string()),
});
export type RunMode = z.infer<typeof RunModeSchema>;

export const HealthResponseSchema = z.object({
  ok: z.boolean(),
  version: z.string(),
  mode: RunModeSchema,
  /** Rule registry version the compiler runs. */
  ruleVersion: z.string(),
});

// ---------------------------------------------------------------- Source Console

export const SourceRowSchema = z.object({
  source: SourceSchema,
  /** Plain-language state, for example "answered, no rows found on 2026-10-27". */
  healthDetail: z.string(),
  /** Zetaris table or database this source is exposed as, if registered. */
  zetarisName: z.string().optional(),
  rowCount: z.number().int().nonnegative().optional(),
  authorityNotes: z.string().optional(),
});
export type SourceRow = z.infer<typeof SourceRowSchema>;

export const ProposeSourceRequestSchema = z.object({
  /** One line describing what the source holds. */
  description: z.string().min(3).max(500),
  /** Must resolve inside the allowlist or the request is refused with the reason. */
  url: z.string().url().max(2000),
  /** Run again a request that was declined as retryable. Without it a repeated request returns the stored answer unchanged. */
  retry: z.boolean().optional(),
});

export const ONBOARDING_STAGES = [
  "authorization",
  "capability_discovery",
  "bounded_probe",
  "mapping_proposal",
  "semantic_validation",
  "human_review",
  "registration",
  "monitoring",
] as const;
export const StageStatusSchema = z.enum(["passed", "failed", "held", "skipped", "pending"]);

export const OnboardingStageSchema = z.object({
  stage: z.enum(ONBOARDING_STAGES),
  status: StageStatusSchema,
  /** What happened, in a sentence a reviewer can read. */
  summary: z.string(),
  /** Machine detail: resolved addresses, fingerprints, validator checks. */
  detail: z.record(z.string(), z.unknown()).optional(),
});

export const MappingFieldSchema = z.object({
  sourceField: z.string(),
  canonicalField: z.string(),
  unit: z.string().optional(),
  confidence: z.number().min(0).max(1).optional(),
  /** Validator verdict for this field. */
  check: z.enum(["ok", "renamed", "rejected", "needs_review"]),
  reason: z.string().optional(),
});

export const OnboardingResultSchema = z.object({
  /** Idempotency key: submitting the same description and URL twice never registers twice. */
  id: z.string(),
  outcome: z.enum(["registered", "held_for_review", "declined"]),
  /** Why it was declined or held, stated plainly. */
  reason: z.string().optional(),
  stages: z.array(OnboardingStageSchema),
  mapping: z.array(MappingFieldSchema).default([]),
  sourceId: z.string().optional(),
  schemaHash: z.string().optional(),
  zetarisName: z.string().optional(),
  /** True when the mapping came from a recorded model reply rather than a live call. */
  recorded: z.boolean(),
});
export type OnboardingResult = z.infer<typeof OnboardingResultSchema>;

// ---------------------------------------------------------------- cases

export const CaseSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  productLabel: z.string(),
  /** Always true for the vendor claim in the demo; shown as a badge. */
  claimConstructed: z.boolean(),
  headlineLabel: LabelSchema.optional(),
  openQuestions: z.number().int().nonnegative(),
  staleFindings: z.number().int().nonnegative(),
  reviewerState: z.string(),
  updatedAt: z.string(),
});
export type CaseSummary = z.infer<typeof CaseSummarySchema>;

/** A claim sentence and its compiled finding, with everything the Claim X-Ray screen needs. */
export const AnchorViewSchema = EvidenceAnchorSchema.extend({
  sourceId: z.string(),
  sourceLabel: z.string(),
  retrievedAt: z.string(),
  sourcePublishedAt: z.string().optional(),
  /** Which kind of statement this is: regulatory authorization, study result, requirement, vendor claim. */
  assertionType: z.string(),
  /** Rule ids that used this anchor. */
  ruleIds: z.array(z.string()).default([]),
});
export type AnchorView = z.infer<typeof AnchorViewSchema>;

export const DimensionViewSchema = z.object({
  dimension: DimensionSchema,
  relation: z.enum(["CONTAINED", "PARTIAL", "DISJOINT", "UNKNOWN"]),
  claimed: z.string().optional(),
  established: z.string().optional(),
  /** Plain-language reason from the compiler. */
  reason: z.string(),
  anchorIds: z.array(z.string()),
});
export type DimensionView = z.infer<typeof DimensionViewSchema>;

export const LinkViewSchema = LinkSchema.extend({
  fromLabel: z.string(),
  toLabel: z.string(),
  candidateClass: z.enum(["EXACT_IDENTIFIER", "STRONG_TEXT", "WEAK_NAME_ONLY", "NONE"]).optional(),
});

export const MatrixRowSchema = z.object({
  /** Which silo each column came from, so the Matrix keeps provenance instead of collapsing it. */
  cells: z.record(z.string(), z.object({ value: z.unknown(), sourceId: z.string(), sourceLabel: z.string() })),
});

export const EvidenceMatrixSchema = z.object({
  statement: z.string(),
  queryId: z.string(),
  servedFrom: z.enum(["live", "cassette", "fallback"]),
  respHash: z.string(),
  elapsedMs: z.number(),
  perSourceRowCounts: z.record(z.string(), z.number().int().nonnegative()),
  columns: z.array(z.object({ name: z.string(), sourceId: z.string(), sourceLabel: z.string() })),
  rows: z.array(MatrixRowSchema),
});
export type EvidenceMatrix = z.infer<typeof EvidenceMatrixSchema>;

export const TimelineEventSchema = z.object({
  at: z.string(),
  kind: z.enum(["fact_asserted", "fact_superseded", "source_changed", "link_confirmed", "decision", "finding_stale", "finding_recomputed"]),
  summary: z.string(),
  factIds: z.array(z.string()).default([]),
  findingIds: z.array(z.string()).default([]),
});

export const MissingEvidenceItemSchema = z.object({
  findingId: z.string(),
  dimension: DimensionSchema,
  request: z.string(),
  /** Copyable draft to send to the vendor. Never sent automatically. */
  draft: z.string(),
});

export const CaseDetailSchema = z.object({
  summary: CaseSummarySchema,
  claim: ClaimSchema,
  claimText: z.string(),
  /** Every claim of the case, the reviewer's own question first, each with its sentence in `text`. A finding names its claim by id. */
  claims: z.array(ClaimSchema).default([]),
  findings: z.array(FindingSchema),
  dimensions: z.record(z.string(), z.array(DimensionViewSchema)),
  anchors: z.array(AnchorViewSchema),
  links: z.array(LinkViewSchema),
  matrix: EvidenceMatrixSchema.optional(),
  timeline: z.array(TimelineEventSchema),
  missingEvidence: z.array(MissingEvidenceItemSchema),
  sources: z.array(SourceRowSchema),
  mode: RunModeSchema,
});
export type CaseDetail = z.infer<typeof CaseDetailSchema>;

// ---------------------------------------------------------------- Applicability Lab (no model call)

export const RecomputeRequestSchema = z.object({
  /** A partial ClaimedUse. Only the keys present are changed. */
  patch: ScopeSchema.partial(),
  /** Optional date the evidence is read as of (time travel). */
  asOf: z.string().optional(),
});
export const RecomputeResponseSchema = z.object({
  before: FindingSchema,
  after: FindingSchema,
  /** Dimensions whose relation changed, with before and after. */
  changed: z.array(z.object({ dimension: DimensionSchema, before: z.string(), after: z.string() })),
  labelChanged: z.boolean(),
  reasons: z.array(DimensionViewSchema),
  /** Always false: the Lab never calls a model. Shown in the UI. */
  modelCalled: z.literal(false),
  elapsedMs: z.number(),
});

// ---------------------------------------------------------------- drills (failure behaviour)

export const DRILLS = [
  "source_off", // a named source becomes UNAVAILABLE
  "source_empty", // a named source answers with no rows
  "zetaris_off", // the federation engine is stopped
  "truncated_result", // a federated result comes back cut short
  "model_off", // the model route fails
  "registry_changed", // a registry record changes after a finding
  "injection_in_document", // a vendor document tells the system to mark the claim supported
] as const;
export const DrillRequestSchema = z.object({
  drill: z.enum(DRILLS),
  /** For source_off and source_empty: which assertion type or source id. */
  target: z.string().optional(),
});
export const DrillResponseSchema = z.object({
  drill: z.enum(DRILLS),
  before: z.array(FindingSchema),
  after: z.array(FindingSchema),
  /** Findings marked stale by a change event, and only those. */
  staleFindingIds: z.array(z.string()),
  /** What the system says happened, in plain words. */
  narrative: z.string(),
  /** The drill never lets a label become SUPPORTED_FOR_SCOPE because something was lost. */
  invariantHeld: z.boolean(),
  mode: RunModeSchema,
});

// ---------------------------------------------------------------- investigation (streamed)

/** Server-sent events on GET /api/cases/:id/investigate. One TraceEvent per `data:` line. */
export const TraceEventSchema = z.object({
  runId: z.string(),
  seq: z.number().int().nonnegative(),
  at: z.string(),
  role: z.enum(["guard", "planner", "discoverer", "retriever", "resolver", "extractor", "critic", "compiler", "reporter", "system"]),
  /** What the role decided and why, one sentence. */
  decision: z.string(),
  detail: z.record(z.string(), z.unknown()).optional(),
  /** Model-derived events say whether the reply was recorded and carry the receipt id. */
  model: z.object({ routedModel: z.string(), recorded: z.boolean(), receiptId: z.string().optional() }).optional(),
  federation: z.object({ queryId: z.string(), servedFrom: z.string() }).optional(),
  done: z.boolean().default(false),
});
export type TraceEvent = z.infer<typeof TraceEventSchema>;

// ---------------------------------------------------------------- review decisions

export const DecisionRequestSchema = z.object({
  findingId: z.string(),
  action: z.enum(["accept", "narrow", "request_evidence", "escalate"]),
  note: z.string().max(2000).optional(),
  /** A repeated key never records a second decision. */
  idempotencyKey: z.string().min(8),
});

// ---------------------------------------------------------------- guard and dossier

export const GuardRequestSchema = z.object({ text: z.string().min(1).max(20000), origin: z.enum(["reviewer", "document"]) });
export const GuardResponseSchema = z.object({
  allowed: z.boolean(),
  intent: z.string(),
  /** Which guard layer fired, and the matched span, for the quarantine view. */
  findings: z.array(z.object({ layer: z.string(), span: z.string().optional(), reason: z.string() })),
  message: z.string(),
});

export const VerifyResponseSchema = z.object({
  ok: z.boolean(),
  checks: z.array(z.object({ name: z.string(), ok: z.boolean(), detail: z.string().optional() })),
  failures: z.array(z.object({ item: z.string(), reason: z.string() })),
  /** The signature note: integrity only, never clinical truth. */
  signatureNote: z.string(),
  keyKind: z.enum(["demo", "pinned"]),
});

export const ErrorBodySchema = z.object({
  error: z.object({
    /** Maps to the failure taxonomy: UNAVAILABLE, FORBIDDEN, INVALID, REFUSED, ... */
    failure: z.string(),
    message: z.string(),
    detail: z.record(z.string(), z.unknown()).optional(),
  }),
});

/** Route table, for the server and the UI client to share. */
export const ROUTES = {
  health: "GET /api/health",
  sources: "GET /api/sources",
  proposeSource: "POST /api/sources/propose",
  cases: "GET /api/cases",
  caseDetail: "GET /api/cases/:id",
  recompute: "POST /api/cases/:id/recompute",
  drill: "POST /api/cases/:id/drill",
  investigate: "GET /api/cases/:id/investigate (text/event-stream)",
  timeline: "GET /api/cases/:id/timeline?asOf=YYYY-MM-DD",
  decision: "POST /api/cases/:id/decision",
  dossier: "GET /api/cases/:id/dossier",
  verify: "POST /api/dossier/verify",
  guard: "POST /api/guard",
  trace: "GET /api/runs/:runId/trace (application/jsonl)",
} as const;

export { SourceHealthSchema, DataClassSchema };
