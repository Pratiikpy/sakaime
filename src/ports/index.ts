/**
 * Ports: the interfaces every module is built against. Implementations live in their own directories
 * (src/federation, src/models, src/sources). Tests and judge mode swap implementations; the contracts stay.
 */
import type { DataClass, SourceHealth } from "../schemas/common.ts";
import type { EvidenceRecord, Source } from "../schemas/evidence.ts";

// ---------------------------------------------------------------- failure taxonomy

/**
 * EMPTY, UNAVAILABLE and DRIFTED are different outcomes and must never be collapsed.
 * Only EMPTY may be read as "none found in source X on date D".
 */
export type FailureClass =
  | "UNAVAILABLE" // timeout, 5xx, 429, stopped engine, transport error: retry then degrade
  | "FORBIDDEN" // policy refused the identity or the URL
  | "DRIFTED" // the response shape changed
  | "TRUNCATED" // the result is known to be incomplete
  | "BLOCKED" // scripted access refused by the provider
  | "INVALID" // the request or response is malformed
  | "REFUSED"; // our own guard declined (allowlist, SSRF, egress policy)

export class PortError extends Error {
  constructor(
    public readonly failure: FailureClass,
    message: string,
    public readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "PortError";
  }
}

export interface CheckResult {
  health: SourceHealth;
  detail: string;
  latencyMs: number;
  checkedAt: string;
}

// ---------------------------------------------------------------- federation (Zetaris)

export type FederationMode = "live" | "cassette" | "fallback";

export interface FederationColumn {
  name: string;
  /** Zetaris returns every value as a string; the port casts when the type is known. */
  type: string;
}

export interface FederationResult {
  columns: FederationColumn[];
  rows: Record<string, unknown>[];
  /** Total rows the engine reports. If it exceeds rows.length the port throws TRUNCATED instead of returning. */
  total: number;
  queryId: string;
  servedFrom: FederationMode;
  /** sha256 of the canonical result, for the dossier. */
  respHash: string;
  elapsedMs: number;
}

export interface FederationQueryOptions {
  limit?: number;
  /** Which Zetaris identity runs it. Reviewers see different columns for the same statement. */
  identity?: string;
  timeoutMs?: number;
}

export interface FederationPort {
  readonly mode: FederationMode;
  /** One statement per request, no trailing semicolon. Throws PortError on any failure. */
  sql(statement: string, options?: FederationQueryOptions): Promise<FederationResult>;
  /** A real probe (SELECT 1 through the engine), never a container healthcheck. */
  check(): Promise<CheckResult>;
}

// ---------------------------------------------------------------- model (Nemotron via Nightshift or NVIDIA)

export interface ModelRequest {
  /** Which agent role is asking; the role map picks the model. */
  role: string;
  system: string;
  user: string;
  /** If set, the reply must parse as JSON matching this JSON Schema, or the call fails with INVALID. */
  jsonSchema?: Record<string, unknown>;
  maxTokens?: number;
  /** The highest data class present in the prompt. The egress policy decides whether it may leave. */
  dataClass: DataClass;
  /** Unique per call so Nightshift memory cannot leak between evaluation cases. */
  memoryScope: string;
  timeoutMs?: number;
}

export interface ComputeReceipt {
  receiptId: string;
  decisionId?: string;
  routedModel: string;
  provider?: string;
  latencyMs?: number;
  hmem?: number;
  signature?: string;
  keyId?: string;
  requestHash?: string;
  responseHash?: string;
  raw: Record<string, unknown>;
}

export interface ModelResponse {
  text: string;
  json?: unknown;
  requestedModel: string;
  /** The model that actually answered. */
  routedModel: string;
  provider: "nightshift" | "nvidia" | "recorded";
  usage: { promptTokens?: number; completionTokens?: number; measured: boolean };
  /** Present only when served by Nightshift. A reply without one is labelled unreceipted. */
  receipt?: ComputeReceipt;
  /** True when replayed from a cassette. Recorded replies are labelled recorded everywhere they are shown. */
  recorded: boolean;
}

export interface ModelPort {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

// ---------------------------------------------------------------- connector (describe, check, discover, read)

/** Airbyte-style contract. Every outcome is typed; none is a bare boolean. */
export interface SourceCard {
  id: string;
  kind: Source["kind"];
  baseUrl: string;
  auth: "none" | "key";
  rateLimit?: { requests: number; perSeconds: number; perDay?: number };
  identifierFields: string[];
  /** Predicates the source can apply itself; everything else is a residual applied in code and recorded. */
  supportedPredicates: string[];
  cadenceHours?: number;
  license: string;
  dataClass: DataClass;
}

export interface ReadRequest {
  /** Source-specific query, already validated. */
  query: Record<string, string | number>;
  limit?: number;
}

export interface ReadResult {
  health: Extract<SourceHealth, "OK" | "EMPTY">;
  records: EvidenceRecord[];
  /** Opaque cursor for resumption. */
  state?: string;
}

export interface Connector {
  readonly card: SourceCard;
  describe(): SourceCard;
  check(): Promise<CheckResult>;
  /** Bounded probe returning a few rows and the schema fingerprint. */
  discover(): Promise<{ sample: unknown[]; schemaHash: string }>;
  /** Throws PortError for UNAVAILABLE, DRIFTED, BLOCKED, FORBIDDEN, INVALID. EMPTY is a normal result. */
  read(request: ReadRequest): Promise<ReadResult>;
}

// ---------------------------------------------------------------- clock and ids (so tests are deterministic)

export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
