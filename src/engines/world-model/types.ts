import type { IdentityResolver, BandResolverOptions } from "./resolve.ts";

export type ISODate = string;

/** Every write carries provenance. No provenance, no write. */
export interface Provenance {
  kind: string;
  by?: string;
  /** When the source made the observation (valid time of the observation), never the wall clock. */
  at: ISODate | Date;
  url?: string;
  checksum?: string;
  runId?: string;
}

export interface StoredProvenance extends Omit<Provenance, "at"> {
  at: ISODate;
}

export interface Entity {
  type: string;
  id: string;
  attrs: Record<string, unknown>;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: ISODate;
  updatedAt: ISODate;
  name?: string;
  aliases: string[];
  state: "emerging" | "active" | "archived";
  /** Set when a merge made this entity an alias of another; reads resolve to the survivor. */
  mergedInto?: string;
}

export interface Context {
  type: string;
  id: string;
  attrs: Record<string, unknown>;
  parent?: string;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: ISODate;
  updatedAt: ISODate;
}

export interface Relationship {
  id: string;
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  /** Valid time: when the link started to hold in the world. */
  validFrom: ISODate;
  /** Valid time: explicit end. For single-valued types the effective end can come earlier from a later edge. */
  validTo?: ISODate;
  schemaVersion: number;
  source: StoredProvenance;
  createdAt: ISODate;
  /** Set on read when a later edge of a single-valued type closed this one. */
  supersededBy?: string;
}

export interface Fact {
  id: string;
  about: string;
  predicate: string;
  value: unknown;
  confidence: number;
  context?: string;
  source: StoredProvenance;
  /** The source's observation time. */
  assertedAt: ISODate;
  /** Valid time start; defaults to `assertedAt`. */
  validFrom?: ISODate;
  validTo?: ISODate;
}

export type ConflictPolicy = "most-recent-wins" | "highest-confidence-wins" | "source-priority" | "manual";
export type PolicySetting = ConflictPolicy | { default: ConflictPolicy; byPredicate?: Record<string, ConflictPolicy> };

export type Cardinality = "one" | "many";
export interface RelationshipTypeConfig {
  /** `one`: a later edge with a different target closes the earlier one. `many`: edges coexist. */
  cardinality: Cardinality;
}

export type EventKind =
  | "upsertEntity"
  | "upsertContext"
  | "relate"
  | "endRelationship"
  | "assertFact"
  | "retractFact"
  | "chooseFact"
  | "alias"
  | "mergeProposed"
  | "mergeResolved"
  | "observe"
  | "declareDependencies"
  | "ingestRun";

/** Append-only log row. `recordedAt` is record time (when we learned it); valid time lives in the payload. */
export interface WorldEvent {
  id: string;
  seq: number;
  kind: EventKind;
  payload: Record<string, unknown>;
  schemaVersion: number;
  /** The source's observation time. */
  at: ISODate;
  recordedAt: ISODate;
  actor: string;
  summary: string;
  runId?: string;
}

export interface AuditEntry {
  seq: number;
  at: ISODate;
  recordedAt: ISODate;
  kind: string;
  actor: string;
  summary: string;
  eventId: string;
  runId?: string;
}

export interface MergeProposal {
  id: string;
  leftId: string;
  rightId: string;
  leftName: string;
  rightName: string;
  similarity: number;
  reason: string;
  status: "pending" | "approved" | "rejected";
  proposedAt: ISODate;
  resolvedAt?: ISODate;
  resolvedBy?: string;
}

export interface ObservationRecord {
  externalId: string;
  entityId: string;
  checksum: string;
  at: ISODate;
  mentionIds: string[];
}

export type StaleReason =
  | "winner-changed"
  | "fact-retracted"
  | "decision-outdated"
  | "relationship-closed"
  | "relationship-ended";

export interface StaleInfo {
  sinceSeq: number;
  causes: { ref: string; reason: StaleReason; seq: number; eventId: string }[];
}

export interface FindingDependencies {
  findingId: string;
  /** Fact ids and relationship ids the finding used. */
  refs: string[];
  declaredSeq: number;
  stale?: StaleInfo;
}

export interface WorldModelOptions {
  /** "memory" keeps the SQLite database in process; "local" persists to `<directory>/<namespace>.sqlite`. */
  storage?: "memory" | "local";
  namespace: string;
  directory?: string;
  /** Record-time clock. Valid times always come from provenance, never from this clock. */
  clock?: () => Date;
  /** An injected resolver, or the sponsor-style band options (which never auto-merge unless `autoMergeTypes` says so). */
  resolver?: IdentityResolver | BandResolverOptions;
  conflictPolicy?: PolicySetting;
  /** Highest priority first; used by the `source-priority` policy on provenance `kind`. */
  sourcePriority?: string[];
  /** Per-type cardinality. Unlisted types are single-valued, which is the sponsor's behaviour. */
  relationshipTypes?: Record<string, RelationshipTypeConfig>;
  /** Permit edges whose endpoints were never upserted. Off by default: a dangling edge is a defect. */
  allowDanglingEdges?: boolean;
}

export interface IngestObservation {
  externalId: string;
  type?: string;
  title: string;
  text?: string;
  at: ISODate;
  source: Provenance;
  entities?: { type: string; name: string }[];
}

export interface IngestReport {
  runId: string;
  processed: number;
  skippedUnchanged: number;
  eventsAppended: number;
  changed: boolean;
  /** True when this report was returned for an idempotency key that had already been used. */
  replayed?: boolean;
}

export type WorldModelErrorCode =
  | "PROVENANCE_REQUIRED"
  | "INVALID_INPUT"
  | "UNKNOWN_ENTITY"
  | "UNKNOWN_REF"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "SCHEMA_VERSION"
  | "CLOSED";

export class WorldModelError extends Error {
  readonly code: WorldModelErrorCode;
  constructor(code: WorldModelErrorCode, message: string) {
    super(`World Model: ${message}`);
    this.name = "WorldModelError";
    this.code = code;
  }
}

export const DEFAULT_RELATIONSHIP_TYPES: Record<string, RelationshipTypeConfig> = {
  mentions: { cardinality: "many" },
};

/** Cardinalities Sakaime declares for its own link types. */
export const SAKAIME_RELATIONSHIP_TYPES: Record<string, RelationshipTypeConfig> = {
  ...DEFAULT_RELATIONSHIP_TYPES,
  "authorized-as": { cardinality: "many" },
  "evaluated-in": { cardinality: "many" },
  cites: { cardinality: "many" },
  supersedes: { cardinality: "many" },
  "describes-version": { cardinality: "one" },
};
