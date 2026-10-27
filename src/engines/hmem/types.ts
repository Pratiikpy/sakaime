export type MemoryType = "personal" | "factual" | "preference" | "general";
export type MemoryLayer = "short_term" | "working" | "long_term";

/** The reference's origin names and the specification's prose names are both accepted. */
export type ProvenanceOrigin =
  | "chat_message" | "user_correction" | "file_save" | "file_open" | "file_edit" | "model_response" | "plan_completion"
  | "document" | "manual" | "dream" | "sleep_synthesis"
  | "chat" | "import" | "web" | "decision" | "curiosity" | "goal_run" | "user_explicit" | "inference" | "plan_run"
  | "mission" | "swarm_run" | "tool" | "brain" | "reviewer";

export interface Provenance {
  origin: ProvenanceOrigin;
  learnedAt: number;
  label: string;
  refs?: string[];
  /** Who confirmed this record, when a person did. */
  reviewer?: string;
  /** Source tier the confidence was seeded from, when one was given. */
  tier?: SourceTier;
}

/**
 * Where a claim came from, in descending order of the trust it starts with. The numbers are a
 * Sakaime design choice (the specification only says confidence is mandatory and must move with
 * feedback); they are configurable and are only a starting point that reviewer feedback moves.
 */
export type SourceTier = "regulator" | "reviewer" | "registry" | "publication" | "vendor" | "model";

export const DEFAULT_TIER_CONFIDENCE: Record<SourceTier, number> = {
  regulator: 0.9,
  reviewer: 0.85,
  registry: 0.8,
  publication: 0.75,
  vendor: 0.5,
  model: 0.4,
};

export interface MemoryRecord {
  id: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  timestamp: number;
  lastAccessed: number;
  accessCount: number;
  tags: string[];
  /** Deterministic lexical vector used by the synchronous path. */
  embedding: number[];
  score?: number;
  confidence: number;
  source: string;
  provenance: Provenance;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  /** Institution that owns this record. A record with an organization is invisible to every other organization. */
  organizationId?: string;
  /** Narrows an organization's record to one case. Requires `organizationId`. */
  caseId?: string;
  /** What kind of thing this is in Sakaime terms: reviewer_confirmed_link, schema_mapping, precedent, source_note. */
  kind?: string;
  domain: string;
  namespace: string;
  entities: string[];
  entityTypes?: Record<string, string>;
  relatedTo: string[];
  supersedes?: string;
  supersededBy?: string;
  derivedFrom?: string[];
}

export type LedgerAction =
  | "create" | "read" | "update" | "delete" | "feedback" | "promote" | "demote" | "merge"
  | "conflict_detected" | "conflict_resolved"
  | "sleep_consolidate" | "sleep_archive" | "sleep_synthesize"
  | "dream_proposed" | "dream_approved" | "dream_rejected" | "restore";

export interface LedgerEntry {
  id: string;
  seq: number;
  memoryId: string;
  action: LedgerAction;
  actor: string;
  timestamp: number;
  previousState?: Partial<MemoryRecord>;
  newState?: Partial<MemoryRecord>;
  details?: Record<string, unknown>;
}

export type MiningEventType = "chat_message" | "user_correction" | "file_save" | "file_open" | "file_edit" | "model_response" | "plan_completion";

export interface Scope {
  organizationId?: string;
  caseId?: string;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
}

export interface QueryOptions extends Scope {
  topN?: number;
  threshold?: number;
  /** Include records without the given chat/mission/goal-run scope. Default true. */
  includeUnscoped?: boolean;
  /** Audit/debug strategy: include records tagged `review` or `wrong`. Default false. */
  includeReview?: boolean;
  /** Record the access (accessCount, lastAccessed, a `read` ledger entry). Default true. */
  touch?: boolean;
  /** Who is asking; recorded on the `read` ledger entries. */
  actor?: string;
}

export interface ScoreBreakdown {
  semantic: number;
  keyword: number;
  tag: number;
  domain: number;
  entity: number;
  layer: number;
  recency: number;
  superseded: number;
  raw: number;
  confidence: number;
  score: number;
}

export interface RetrievedMemory {
  memory: MemoryRecord;
  relevance: number;
  breakdown: ScoreBreakdown;
}

export interface QueryTrace {
  traceId: string;
  retrievalReason: string;
  strategy: "minimal" | "personal" | "comprehensive";
  weightProfile: string;
  queryDomain: string;
  queryEntities: string[];
  scores: Record<string, number>;
  /** Where the semantic term came from: the lexical hash, or the injected embedder. */
  semanticSource: string;
  /** Set when the embedder was asked for and failed, and the lexical path answered instead. */
  degraded?: string;
  /** Superseded records that were returned but left out of the prompt context because their replacement is present. */
  suppressedSuperseded: string[];
  /** Records excluded from retrieval because they are tagged `review` or `wrong`. */
  excludedReview: number;
  /** Records dropped from the prompt context by the privacy filter. */
  omittedSensitive: string[];
  redactions: number;
}

export interface QueryResult {
  memories: RetrievedMemory[];
  context: string;
  trace: QueryTrace;
}

export interface Embedder {
  /** Identifies the model and version; vectors from different ids are never mixed. */
  readonly id: string;
  embed(texts: string[]): Promise<number[][]>;
}

export interface HMEMOptions {
  clock?: () => number;
  /** Directory for `hmem.sqlite`. Without it the store lives in memory. */
  persistDir?: string;
  actor?: string;
  minerFn?: (prompt: string) => Promise<string>;
  embedder?: Embedder;
  /** What to do when the embedder fails during `queryAsync`. Default `degrade`: answer lexically and say so. */
  onEmbedderError?: "degrade" | "throw";
  /** Dream approval and manual conflict resolution need a named reviewer. */
  requireReviewer?: boolean;
  tierConfidence?: Partial<Record<SourceTier, number>>;
  redactor?: import("./privacy.ts").Redactor;
  /** What synthesis does with its sources: keep them marked as superseded, or delete them. Default `supersede`. */
  sourceDisposition?: "supersede" | "delete";
  /** Records at or above this confidence are never archived by sleep. Default 0.85. */
  protectConfidence?: number;
}

export const FEEDBACK_DELTAS = { helpful: 0.05, not_helpful: -0.03, wrong: -0.2 } as const;
export type FeedbackKind = keyof typeof FEEDBACK_DELTAS;

export const DEFAULTS = {
  retrievalTopN: 5,
  retrievalThreshold: 0.35,
  consolidationDays: 7,
  archiveMinDays: 30,
  archiveMaxAccess: 2,
  synthesisCosine: 0.82,
  dreamClusterMinSize: 2,
  dreamRelatedness: 0.35,
  maxDreamProposalsPerType: 8,
  conflictAutoResolveGate: 0.7,
  entityCap: 10,
  relatedCap: 5,
  recencyDays: 14,
  hubThreshold: 3,
} as const;

export const WEIGHT_PROFILE = "canonical-8-signal@1";

export const clamp01 = (x: number): number => Math.min(1, Math.max(0, x));
export const DAY_MS = 86_400_000;

export type HMemErrorCode = "NO_SOURCE" | "INVALID_INPUT" | "UNKNOWN_ID" | "SCOPE" | "REVIEWER_REQUIRED" | "IDEMPOTENCY_CONFLICT" | "NOT_FOUND" | "CLOSED";

export class HMemError extends Error {
  readonly code: HMemErrorCode;
  constructor(code: HMemErrorCode, message: string) {
    super(`H-MEM: ${message}`);
    this.name = "HMemError";
    this.code = code;
  }
}
