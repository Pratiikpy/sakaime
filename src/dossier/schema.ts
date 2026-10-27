/**
 * The dossier bundle format (version 1.0.0).
 *
 * A bundle is { format, formatVersion, manifest, signature, body }. The body is split into named sections.
 * The manifest lists a content hash for every section (singletons) and for every item of every list section,
 * plus a root hash over that listing, and carries the signing key's public half. The signature covers the
 * canonical JSON of the whole manifest, so changing any byte of any section changes an item hash, which changes
 * the manifest, which breaks the signature, and the verifier can say which item moved.
 *
 * Two histories are kept in separate sections and are never merged:
 *   evidenceHistory - what the sources said and when (records retrieved, facts recorded and superseded, source health);
 *   decisionHistory - what reviewers did about findings (an append-only, hash-chained log).
 */
import { z } from "zod";
import {
  ClaimSchema,
  DataClassSchema,
  DimensionSchema,
  EvidenceAnchorSchema,
  EvidenceAssertionSchema,
  EvidenceItemSchema,
  EvidenceRecordSchema,
  FactSchema,
  FindingSchema,
  LinkSchema,
  ScopeSchema,
  SourceHealthSchema,
  SourceSchema,
} from "../schemas/index.ts";
import { IsoDateTime, Sha256 } from "../schemas/evidence.ts";
import type { ComputeReceipt } from "../ports/index.ts";
import { LineageEventSchema, lineageEventId } from "./lineage.ts";

export const DOSSIER_FORMAT = "sakaime.dossier";
export const DOSSIER_VERSION = "1.0.0";

/** Printed in the manifest and by the verifier. Wording is deliberate: integrity, never clinical truth. */
export const SIGNATURE_STATEMENT =
  "The signature shows that this bundle has not changed since the holder of the listed key signed it. " +
  "It does not show that any finding is clinically correct, and a demo key does not identify who signed.";

export const GENESIS_HASH = "0".repeat(64);

const NonEmpty = z.string().min(1);

// ---------------------------------------------------------------- how a reply or result was served

/** live: produced by the real system in this run. recorded: replayed from a cassette. fallback: a degraded substitute. */
export const SERVED_LABELS = ["live", "recorded", "fallback"] as const;
export const ServedLabelSchema = z.enum(SERVED_LABELS);
export type ServedLabel = z.infer<typeof ServedLabelSchema>;

// ---------------------------------------------------------------- run, rules

export const RunInfoSchema = z.object({
  mode: z.enum(["sample", "live"]),
  /** Free text from the operator, for example which case set this dossier covers. */
  note: z.string().optional(),
});
export type RunInfo = z.infer<typeof RunInfoSchema>;

export const RulesInfoSchema = z.object({
  /** Version of the rule registry the compiler ran against. */
  registryVersion: NonEmpty,
  registryHash: Sha256.optional(),
  /** Every rule version some finding in this bundle was computed under. */
  versionsUsed: z.array(NonEmpty).min(1),
});
export type RulesInfo = z.infer<typeof RulesInfoSchema>;

// ---------------------------------------------------------------- evidence side

/** An evidence record as stored, with the text the anchors quote from. */
export const SnapshotSchema = EvidenceRecordSchema.omit({ payload: true, contentRef: true }).extend({
  /** text: `text` is the stored content. extracted: `text` was extracted from content with a different hash (a PDF, say). */
  contentKind: z.enum(["text", "extracted"]),
  text: z.string(),
  textHash: Sha256,
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Which evidence items went into computing one finding. Recompute reads exactly these. */
export const CompilerRunSchema = z.object({
  findingId: NonEmpty,
  evidenceItemIds: z.array(NonEmpty),
});
export type CompilerRun = z.infer<typeof CompilerRunSchema>;

export const RequirementSchema = z.object({
  id: NonEmpty,
  claimId: NonEmpty,
  description: NonEmpty,
  /** The evidence item (assertionType "requirement") that carries the hospital's own requirement. */
  evidenceItemId: NonEmpty,
  anchorIds: z.array(NonEmpty).default([]),
});
export type Requirement = z.infer<typeof RequirementSchema>;

export const CounterexampleSchema = z.object({
  findingId: NonEmpty,
  claimId: NonEmpty,
  dimensions: z.array(DimensionSchema),
  mismatches: FindingSchema.shape.mismatches,
});
export type Counterexample = z.infer<typeof CounterexampleSchema>;

// ---------------------------------------------------------------- federation, models, egress

export const FederationQuerySchema = z.object({
  queryId: NonEmpty,
  statement: NonEmpty,
  identity: z.string().optional(),
  at: IsoDateTime,
  servedFrom: z.enum(["live", "cassette", "fallback"]),
  /** Derived from servedFrom: cassette is recorded. Stored so the label is part of the signed content. */
  label: ServedLabelSchema,
  total: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  columns: z.array(z.object({ name: NonEmpty, type: z.string() })),
  /** The hash the federation port returned for the result. */
  respHash: Sha256,
  /** Silos the statement read, by source id. */
  sourceIds: z.array(NonEmpty).default([]),
  /** The result itself, when kept. Hashed as canonical JSON of { columns, rows } into resultDigest. */
  result: z.object({ columns: z.array(z.object({ name: NonEmpty, type: z.string() })), rows: z.array(z.record(z.string(), z.unknown())) }).optional(),
  resultDigest: Sha256.optional(),
});
export type FederationQuery = z.infer<typeof FederationQuerySchema>;

export const ComputeReceiptSchema = z.object({
  receiptId: NonEmpty,
  decisionId: z.string().optional(),
  routedModel: NonEmpty,
  provider: z.string().optional(),
  latencyMs: z.number().optional(),
  hmem: z.number().optional(),
  signature: z.string().optional(),
  keyId: z.string().optional(),
  requestHash: z.string().optional(),
  responseHash: z.string().optional(),
  raw: z.record(z.string(), z.unknown()),
});
// Compile-time guard: the stored receipt must stay assignable to the port's ComputeReceipt. Fails the build if they drift.
type ReceiptMatchesPort = z.infer<typeof ComputeReceiptSchema> extends ComputeReceipt ? true : never;
export const RECEIPT_MATCHES_PORT: ReceiptMatchesPort = true;

export const ModelReplySchema = z.object({
  id: NonEmpty,
  at: IsoDateTime,
  role: NonEmpty,
  requestedModel: NonEmpty,
  routedModel: NonEmpty,
  provider: z.enum(["nightshift", "nvidia", "recorded"]),
  recorded: z.boolean(),
  label: ServedLabelSchema,
  dataClass: DataClassSchema,
  /** sha256 of the reply text as kept. The text itself is not stored here. */
  textHash: Sha256,
  usage: z.object({ promptTokens: z.number().optional(), completionTokens: z.number().optional(), measured: z.boolean() }),
  /** Absent means the reply is unreceipted and is reported as such. */
  receipt: ComputeReceiptSchema.optional(),
  /** Ids of the fields (assertions, extracted values) this reply produced. */
  derives: z.array(NonEmpty).default([]),
  /** Records the prompt was built from. */
  inputRecordIds: z.array(NonEmpty).default([]),
});
export type ModelReply = z.infer<typeof ModelReplySchema>;

export const ReceiptCoverageSchema = z.object({
  replies: z.object({
    total: z.number().int().nonnegative(),
    receipted: z.number().int().nonnegative(),
    unreceipted: z.number().int().nonnegative(),
    live: z.number().int().nonnegative(),
    recorded: z.number().int().nonnegative(),
    fallback: z.number().int().nonnegative(),
  }),
  fields: z.object({
    total: z.number().int().nonnegative(),
    receipted: z.number().int().nonnegative(),
    unreceipted: z.number().int().nonnegative(),
    /** Model-derived fields that no recorded reply accounts for. Counted as unreceipted and reported as a failure. */
    withoutReply: z.number().int().nonnegative(),
  }),
  /** receipted fields / total fields, four decimals. null when there are no model-derived fields: not 100%. */
  coverage: z.number().min(0).max(1).nullable(),
  unreceiptedReplyIds: z.array(z.string()),
  unreceiptedFieldIds: z.array(z.string()),
});
export type ReceiptCoverage = z.infer<typeof ReceiptCoverageSchema>;

export const EgressDecisionSchema = z.object({
  id: NonEmpty,
  at: IsoDateTime,
  subjectKind: z.enum(["model", "federation", "connector", "export"]),
  subjectId: NonEmpty,
  dataClass: DataClassSchema,
  route: z.enum(["remote", "local", "none"]),
  decision: z.enum(["allowed", "blocked", "local_lane", "consented"]),
  reason: NonEmpty,
  /** Required when decision is consented. */
  consentRef: z.string().optional(),
});
export type EgressDecision = z.infer<typeof EgressDecisionSchema>;

// ---------------------------------------------------------------- the two histories

export const EvidenceHistoryEntrySchema = z.object({
  id: NonEmpty,
  history: z.literal("evidence"),
  seq: z.number().int().positive(),
  at: IsoDateTime,
  kind: z.enum(["record_retrieved", "fact_recorded", "fact_superseded", "source_health_observed"]),
  /** Record id, fact id or source id, depending on kind. */
  refId: NonEmpty,
  contentHash: Sha256.optional(),
  /** The record or fact this one replaces. The replaced one is kept. */
  supersedes: z.string().optional(),
  health: SourceHealthSchema.optional(),
  note: z.string().optional(),
});
export type EvidenceHistoryEntry = z.infer<typeof EvidenceHistoryEntrySchema>;

export const DECISION_ACTIONS = ["accept", "narrow", "request_evidence", "escalate"] as const;
export const DecisionActionSchema = z.enum(DECISION_ACTIONS);
export type DecisionAction = z.infer<typeof DecisionActionSchema>;

export const DECISION_STATES = ["accepted", "narrowed", "evidence_requested", "escalated"] as const;
export const DecisionStateSchema = z.enum(DECISION_STATES);

export const DecisionEntrySchema = z.object({
  id: NonEmpty,
  history: z.literal("decision"),
  seq: z.number().int().positive(),
  idempotencyKey: NonEmpty,
  /** Hash of the decision's content without key, time or chain fields. Equal keys must carry equal request hashes. */
  requestHash: Sha256,
  claimId: NonEmpty,
  findingId: NonEmpty,
  action: DecisionActionSchema,
  resultingState: DecisionStateSchema,
  reviewer: NonEmpty,
  at: IsoDateTime,
  note: z.string().optional(),
  narrowedScope: ScopeSchema.optional(),
  requestedDimensions: z.array(DimensionSchema).optional(),
  escalateTo: z.string().optional(),
  prevHash: Sha256,
  hash: Sha256,
});
export type DecisionEntry = z.infer<typeof DecisionEntrySchema>;

// ---------------------------------------------------------------- body

export const BodySchema = z
  .object({
    run: RunInfoSchema,
    rules: RulesInfoSchema,
    sources: z.array(SourceSchema),
    claims: z.array(ClaimSchema),
    findings: z.array(FindingSchema),
    compilerRuns: z.array(CompilerRunSchema),
    counterexamples: z.array(CounterexampleSchema),
    requirements: z.array(RequirementSchema),
    evidenceItems: z.array(EvidenceItemSchema),
    anchors: z.array(EvidenceAnchorSchema),
    assertions: z.array(EvidenceAssertionSchema),
    links: z.array(LinkSchema),
    facts: z.array(FactSchema),
    snapshots: z.array(SnapshotSchema),
    federation: z.array(FederationQuerySchema),
    models: z.array(ModelReplySchema),
    receiptCoverage: ReceiptCoverageSchema,
    egress: z.array(EgressDecisionSchema),
    evidenceHistory: z.array(EvidenceHistoryEntrySchema),
    decisionHistory: z.array(DecisionEntrySchema),
    lineage: z.array(LineageEventSchema),
  })
  .strict();
export type DossierBody = z.infer<typeof BodySchema>;

// ---------------------------------------------------------------- sections

export type SectionName = keyof DossierBody;

export interface SectionSpec {
  name: SectionName;
  kind: "list" | "singleton";
  /** Identity of a list item inside its section. Undefined means the item is malformed. */
  idOf?: (item: unknown) => string | undefined;
}

function field(key: string): (item: unknown) => string | undefined {
  return (item) => {
    if (item === null || typeof item !== "object") return undefined;
    const v = (item as Record<string, unknown>)[key];
    return typeof v === "string" && v.length > 0 ? v : undefined;
  };
}

function lineageId(item: unknown): string | undefined {
  if (item === null || typeof item !== "object") return undefined;
  const e = item as { run?: { runId?: unknown }; eventType?: unknown };
  if (typeof e.run?.runId !== "string" || typeof e.eventType !== "string") return undefined;
  return lineageEventId({ run: { runId: e.run.runId }, eventType: e.eventType as never });
}

/** Fixed order. The order is part of the format: it is the order sections are listed in a rendered result. */
export const SECTIONS: readonly SectionSpec[] = [
  { name: "run", kind: "singleton" },
  { name: "rules", kind: "singleton" },
  { name: "sources", kind: "list", idOf: field("id") },
  { name: "claims", kind: "list", idOf: field("id") },
  { name: "findings", kind: "list", idOf: field("id") },
  { name: "compilerRuns", kind: "list", idOf: field("findingId") },
  { name: "counterexamples", kind: "list", idOf: field("findingId") },
  { name: "requirements", kind: "list", idOf: field("id") },
  { name: "evidenceItems", kind: "list", idOf: field("id") },
  { name: "anchors", kind: "list", idOf: field("id") },
  { name: "assertions", kind: "list", idOf: field("id") },
  { name: "links", kind: "list", idOf: field("id") },
  { name: "facts", kind: "list", idOf: field("id") },
  { name: "snapshots", kind: "list", idOf: field("id") },
  { name: "federation", kind: "list", idOf: field("queryId") },
  { name: "models", kind: "list", idOf: field("id") },
  { name: "receiptCoverage", kind: "singleton" },
  { name: "egress", kind: "list", idOf: field("id") },
  { name: "evidenceHistory", kind: "list", idOf: field("id") },
  { name: "decisionHistory", kind: "list", idOf: field("id") },
  { name: "lineage", kind: "list", idOf: lineageId },
];

export const SECTION_NAMES: readonly string[] = SECTIONS.map((s) => s.name);

// ---------------------------------------------------------------- manifest and bundle

export const SectionEntrySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("singleton"), sha256: Sha256 }),
  z.object({ kind: z.literal("list"), items: z.array(z.object({ id: NonEmpty, sha256: Sha256 })) }),
]);
export type SectionEntry = z.infer<typeof SectionEntrySchema>;

export const KEY_STATUSES = ["demo", "pinned"] as const;

export const ManifestSchema = z.object({
  format: z.literal(DOSSIER_FORMAT),
  formatVersion: NonEmpty,
  dossierId: NonEmpty,
  createdAt: IsoDateTime,
  sections: z.record(z.string(), SectionEntrySchema),
  /** sha256 of the canonical JSON of `sections`. */
  root: Sha256,
  signing: z.object({
    algorithm: z.literal("Ed25519"),
    /** sha256 of the raw 32-byte public key, hex. */
    keyId: Sha256,
    /**
     * demo: an ephemeral or published example key; it shows integrity only, not who signed.
     * pinned: a key the operator keeps and distributes out of band; a verifier given its id can tell who signed.
     */
    keyStatus: z.enum(KEY_STATUSES),
    /** Base64 of the raw 32-byte public key. */
    publicKey: NonEmpty,
    statement: NonEmpty,
  }),
});
export type Manifest = z.infer<typeof ManifestSchema>;

export const SignatureSchema = z.object({
  algorithm: z.literal("Ed25519"),
  /** Base64 Ed25519 signature over the canonical JSON of the manifest. */
  value: NonEmpty,
});

export const DossierBundleSchema = z.object({
  format: z.literal(DOSSIER_FORMAT),
  formatVersion: NonEmpty,
  manifest: ManifestSchema,
  signature: SignatureSchema,
  body: BodySchema,
});
export type DossierBundle = z.infer<typeof DossierBundleSchema>;
