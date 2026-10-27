import { canonicalJson, sha256Hex } from "../../util/canonical.ts";
import type { HMemDb } from "./db.ts";
import { CORRECTION, DEFAULT_VOCABULARY, type Vocabulary, classifyDomain, extractEntities, namespaceFor } from "./enrich.ts";
import { cosine, embed } from "./lexical.ts";
import {
  DEFAULTS,
  DEFAULT_TIER_CONFIDENCE,
  HMemError,
  type LedgerAction,
  type LedgerEntry,
  type MemoryLayer,
  type MemoryRecord,
  type MemoryType,
  type Provenance,
  type SourceTier,
  clamp01,
} from "./types.ts";

export interface AddInput {
  content: string;
  source: string;
  type?: MemoryType;
  layer?: MemoryLayer;
  tags?: string[];
  confidence?: number;
  /** Seeds `confidence` when none is given. */
  sourceTier?: SourceTier;
  provenance?: Provenance;
  chatId?: string;
  missionId?: string;
  goalRunId?: string;
  organizationId?: string;
  caseId?: string;
  kind?: string;
  /** Typed entities are stored by name; the type is kept beside it. */
  entities?: (string | { name: string; type: string })[];
  supersedes?: string;
  derivedFrom?: string[];
  actor?: string;
  idempotencyKey?: string;
}

const TYPES: readonly MemoryType[] = ["personal", "factual", "preference", "general"];
const LAYERS: readonly MemoryLayer[] = ["short_term", "working", "long_term"];

/**
 * What "unchanged" means for change detection: the record's JSON without its embedding, which is a
 * pure function of the content. Insertion order is stable for one object, so plain `stringify` is
 * enough and far cheaper than canonical form on every operation.
 */
function fingerprint(r: MemoryRecord): string {
  return JSON.stringify(r, (k, v) => (k === "embedding" ? undefined : v));
}

export interface StoreHooks {
  /** A new record reads like a correction of an older, similar one. Resolved by a reviewer, not here. */
  supersessionCandidate?: (newer: MemoryRecord, older: MemoryRecord, similarity: number) => void;
  /** The in-memory state was rebuilt from the database after a failure. */
  reloaded: (() => void)[];
}

/**
 * The live record store. Records are held as identity-mapped objects because callers (and the
 * sponsor's conformance runner) keep the object `add` returned and read it later; the database is
 * written at every flush point. Anything that changes a record outside this API (the runner assigns
 * `supersededBy` directly) is detected by comparing each record with its last persisted form and
 * is written to the ledger as an `update` by actor `external`, so no mutation is ever unrecorded.
 */
export class MemoryStore {
  private records = new Map<string, MemoryRecord>();
  private baseline = new Map<string, string>();
  private depth = 0;
  readonly hooks: StoreHooks = { reloaded: [] };

  constructor(
    readonly db: HMemDb,
    readonly clock: () => number,
    readonly actor: string,
    readonly tierConfidence: Record<SourceTier, number> = DEFAULT_TIER_CONFIDENCE,
    readonly vocabulary: Vocabulary = DEFAULT_VOCABULARY,
  ) {
    this.load();
  }

  private load(): void {
    this.records = new Map();
    this.baseline = new Map();
    for (const r of this.db.loadRecords()) {
      this.records.set(r.id, r);
      this.baseline.set(r.id, fingerprint(r));
    }
  }

  /** Rebuilds memory from the database. Used after a failed operation rolled the database back. */
  reload(): void {
    this.load();
    for (const fn of this.hooks.reloaded) fn();
  }

  /* ------------------------------------------------------------------ reads */

  get(id: string): MemoryRecord | undefined {
    return this.records.get(id);
  }

  all(): MemoryRecord[] {
    return [...this.records.values()];
  }

  /** A deep copy of every record and the id counter, for comparison and export. */
  snapshotAll(): { records: MemoryRecord[]; seq: number } {
    return { records: structuredClone(this.all()), seq: this.db.counter("memory") };
  }

  must(id: string): MemoryRecord {
    const r = this.records.get(id);
    if (!r) throw new HMemError("UNKNOWN_ID", `unknown memory id ${id}`);
    return r;
  }

  /* ------------------------------------------------------------------ operation plumbing */

  /** One transaction per public operation, preceded by the external-mutation check; rolls memory back on failure. */
  run<T>(fn: () => T): T {
    const top = this.depth === 0;
    this.depth++;
    try {
      return this.db.tx(() => {
        if (top) this.sync();
        return fn();
      });
    } catch (err) {
      if (top) this.reload();
      throw err;
    } finally {
      this.depth--;
    }
  }

  once<T>(key: string | undefined, op: string, payload: unknown, run: () => T, save: (r: T) => unknown, load: (saved: any) => T): T {
    if (!key) return run();
    const hash = sha256Hex(canonicalJson({ op, payload }));
    const prior = this.db.getIdempotent(key);
    if (prior) {
      if (prior.payloadHash !== hash) throw new HMemError("IDEMPOTENCY_CONFLICT", `idempotency key ${JSON.stringify(key)} was already used for a different ${prior.op} request`);
      return load(JSON.parse(prior.result));
    }
    const out = run();
    this.db.putIdempotent({ key, op, payloadHash: hash, result: JSON.stringify(save(out)) });
    return out;
  }

  log(memoryId: string, action: LedgerAction, extra?: { previousState?: Partial<MemoryRecord>; newState?: Partial<MemoryRecord>; details?: Record<string, unknown> }, actor?: string): LedgerEntry {
    return this.db.appendLedger({ memoryId, action, actor: actor ?? this.actor, timestamp: this.clock(), ...extra });
  }

  snapshot(r: MemoryRecord): Partial<MemoryRecord> {
    const { embedding: _e, ...rest } = structuredClone(r);
    return rest;
  }

  persist(r: MemoryRecord): void {
    this.db.saveRecord(r);
    this.baseline.set(r.id, fingerprint(r));
  }

  /** Detects records changed outside this API and ledgers each change. */
  sync(): number {
    let changed = 0;
    for (const [id, rec] of this.records) {
      const now = fingerprint(rec);
      const was = this.baseline.get(id);
      if (now === was) continue;
      changed++;
      const previous = was ? (JSON.parse(was) as Partial<MemoryRecord>) : undefined;
      this.log(id, "update", { ...(previous ? { previousState: previous } : {}), newState: this.snapshot(rec), details: { reason: "changed outside the H-MEM API" } }, "external");
      this.persist(rec);
    }
    return changed;
  }

  /* ------------------------------------------------------------------ writes */

  add(input: AddInput): MemoryRecord {
    // Validation happens before the transaction so that a refused write never touches the store.
    if (typeof input?.source !== "string" || input.source.trim() === "") {
      throw new HMemError("NO_SOURCE", "a memory record with no source is rejected by construction: every record needs provenance");
    }
    if (typeof input.content !== "string" || input.content.trim() === "") throw new HMemError("INVALID_INPUT", "content must be a non-empty string");
    if (input.type !== undefined && !TYPES.includes(input.type)) throw new HMemError("INVALID_INPUT", `unknown type ${String(input.type)}`);
    if (input.layer !== undefined && !LAYERS.includes(input.layer)) throw new HMemError("INVALID_INPUT", `unknown layer ${String(input.layer)}`);
    if (input.confidence !== undefined && !(typeof input.confidence === "number" && Number.isFinite(input.confidence) && input.confidence >= 0 && input.confidence <= 1)) {
      throw new HMemError("INVALID_INPUT", `confidence must be a number from 0 to 1, got ${String(input.confidence)}`);
    }
    if (input.tags !== undefined && !(Array.isArray(input.tags) && input.tags.every((t) => typeof t === "string"))) throw new HMemError("INVALID_INPUT", "tags must be an array of strings");
    if (input.caseId !== undefined && input.organizationId === undefined) throw new HMemError("SCOPE", "a caseId needs an organizationId: a case belongs to an organization");
    if (input.sourceTier !== undefined && !(input.sourceTier in this.tierConfidence)) throw new HMemError("INVALID_INPUT", `unknown source tier ${String(input.sourceTier)}`);
    const { idempotencyKey, ...payload } = input;
    return this.run(() =>
      this.once(idempotencyKey, "add", payload, () => this.addInner(input), (r) => ({ id: r.id }), (saved) => this.must(saved.id)),
    );
  }

  private addInner(input: AddInput): MemoryRecord {
    const now = this.clock();
    const actor = input.actor ?? this.actor;
    const type = input.type ?? "general";
    const tags = [...(input.tags ?? [])];
    const domain = classifyDomain(this.vocabulary, input.content, tags, type);
    const named = (input.entities ?? []).map((e) => (typeof e === "string" ? { name: e.toLowerCase().trim(), type: undefined } : { name: e.name.toLowerCase().trim(), type: e.type }));
    const entities = [...new Set([...named.map((e) => e.name), ...extractEntities(this.vocabulary, input.content)])].filter(Boolean).slice(0, DEFAULTS.entityCap);
    const entityTypes = Object.fromEntries(named.filter((e) => e.type && entities.includes(e.name)).map((e) => [e.name, e.type!]));
    const seed = input.confidence ?? (input.sourceTier ? this.tierConfidence[input.sourceTier] : 0.7);
    const id = `mem-${this.db.next("memory")}`;

    let replaced: MemoryRecord | undefined;
    if (input.supersedes !== undefined) {
      replaced = this.must(input.supersedes);
      if ((replaced.organizationId ?? "") !== (input.organizationId ?? "")) throw new HMemError("SCOPE", `cannot supersede ${replaced.id}: it belongs to a different organization`);
      if (replaced.supersededBy !== undefined) throw new HMemError("INVALID_INPUT", `${replaced.id} is already superseded by ${replaced.supersededBy}; supersede the current record instead`);
    }

    const record: MemoryRecord = {
      id,
      content: input.content,
      type,
      layer: input.layer ?? "working",
      timestamp: now,
      lastAccessed: now,
      accessCount: 0,
      tags,
      embedding: embed(input.content),
      confidence: clamp01(seed),
      source: input.source,
      provenance: input.provenance
        ? { ...input.provenance, ...(input.sourceTier && !input.provenance.tier ? { tier: input.sourceTier } : {}) }
        : { origin: "manual", learnedAt: now, label: input.source, ...(input.sourceTier ? { tier: input.sourceTier } : {}) },
      domain,
      namespace: namespaceFor(domain, type),
      entities,
      relatedTo: [],
      ...(Object.keys(entityTypes).length ? { entityTypes } : {}),
      ...(input.chatId !== undefined ? { chatId: input.chatId } : {}),
      ...(input.missionId !== undefined ? { missionId: input.missionId } : {}),
      ...(input.goalRunId !== undefined ? { goalRunId: input.goalRunId } : {}),
      ...(input.organizationId !== undefined ? { organizationId: input.organizationId } : {}),
      ...(input.caseId !== undefined ? { caseId: input.caseId } : {}),
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.derivedFrom !== undefined ? { derivedFrom: input.derivedFrom } : {}),
    };

    const linked = this.discoverRelationships(record);
    this.records.set(id, record);
    this.persist(record);
    this.log(id, "create", { newState: this.snapshot(record) }, actor);

    // Everything below writes to other records, and each such write is ledgered like any other.
    for (const other of linked.related) {
      if (other.relatedTo.length >= DEFAULTS.relatedCap || other.relatedTo.includes(id)) continue;
      const previous = this.snapshot(other);
      other.relatedTo.push(id);
      this.log(other.id, "update", { previousState: previous, newState: this.snapshot(other), details: { reason: "relatedTo backlink", from: id } }, actor);
      this.persist(other);
    }
    if (replaced) {
      const previous = this.snapshot(replaced);
      replaced.supersededBy = id;
      this.log(replaced.id, "update", { previousState: previous, newState: this.snapshot(replaced), details: { reason: "supersession declared", by: id } }, actor);
      this.persist(replaced);
    }
    for (const { other, similarity } of linked.candidates) this.hooks.supersessionCandidate?.(record, other, similarity);
    return record;
  }

  private discoverRelationships(record: MemoryRecord): { related: MemoryRecord[]; candidates: { other: MemoryRecord; similarity: number }[] } {
    const related: MemoryRecord[] = [];
    const candidates: { other: MemoryRecord; similarity: number }[] = [];
    for (const other of this.records.values()) {
      // Records of different organizations are never related to each other.
      if ((other.organizationId ?? "") !== (record.organizationId ?? "")) continue;
      const similarity = cosine(record.embedding, other.embedding);
      if (record.supersedes === undefined && !other.supersededBy && similarity > 0.85 && CORRECTION.test(record.content)) {
        candidates.push({ other, similarity });
        continue;
      }
      if (record.relatedTo.length >= DEFAULTS.relatedCap) continue;
      if (other.domain === record.domain && other.entities.some((e) => record.entities.includes(e))) {
        record.relatedTo.push(other.id);
        related.push(other);
      }
    }
    return { related, candidates };
  }

  /** Patch with a ledger entry. The ledger action is `update` unless the caller names another. */
  update(id: string, patch: Partial<MemoryRecord>, details: Record<string, unknown> = {}, action: LedgerAction = "update", actor?: string): MemoryRecord {
    const rec = this.must(id);
    const previous = this.snapshot(rec);
    Object.assign(rec, patch);
    this.log(id, action, { previousState: previous, newState: this.snapshot(rec), details }, actor);
    this.persist(rec);
    return rec;
  }

  /** Removes a record. The ledger entry (with the full previous state) is written first. */
  remove(id: string, action: LedgerAction, details: Record<string, unknown>, actor?: string): void {
    const rec = this.must(id);
    this.log(id, action, { previousState: this.snapshot(rec), details }, actor);
    this.records.delete(id);
    this.baseline.delete(id);
    this.db.deleteRecord(id);
  }

  touch(id: string): void {
    const rec = this.must(id);
    rec.lastAccessed = this.clock();
    rec.accessCount += 1;
    this.persist(rec);
  }

  /** Replaces the whole record set (restore). Ids already issued stay issued. */
  replaceAll(records: MemoryRecord[]): void {
    for (const id of [...this.records.keys()]) this.db.deleteRecord(id);
    this.records = new Map();
    this.baseline = new Map();
    for (const r of records) {
      const copy = structuredClone(r);
      this.records.set(copy.id, copy);
      this.persist(copy);
    }
  }
}
