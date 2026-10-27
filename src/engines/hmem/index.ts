/**
 * Sakaime H-MEM: hierarchical memory with a trust ledger, built from the specification and the
 * conformance runner of the Meterless H-MEM (third_party/meterless/hmem). No reference source is
 * copied. The synchronous API (`add`, `query`, `feedback`, `store`, `ledger`, `sleep`, `conflicts`,
 * `dreaming`) is what the runner calls and works with no network and no model; the asynchronous
 * additions (`queryAsync`, `backfillEmbeddings`, `mine`, `dreaming.dreamWithModel`) are the only
 * places that wait on anything external.
 *
 * Differences from the reference, each with a test in tests/engines/hmem:
 *
 *  - Persistence is SQLite. Records, the ledger, conflicts, dream proposals and sleep backups all
 *    survive a restart (the reference keeps backups, proposals and conflicts in memory only).
 *  - The ledger is append-only by trigger and written once per mutation, including the mutations the
 *    reference skips (relatedTo backlinks) and a change made to a record object outside this API.
 *  - Declaring `supersedes` marks the replaced record `supersededBy`, ledgered. A record that only
 *    reads like a correction becomes a queued candidate for a reviewer instead of acting alone.
 *  - Records tagged `review` or `wrong` are not retrieved or injected unless an audit strategy asks.
 *  - Confidence is seeded from a source tier and moved by reviewer feedback; authority outranks
 *    recency when two records conflict.
 *  - Records belong to an organization and optionally a case; no query sees another organization's
 *    records, and dreaming, conflict detection and synthesis never combine records across scopes.
 *  - A privacy filter sits between retrieval and the prompt text.
 *  - Sleep executes only what a fresh preview also contains, and keeps its sources by default.
 *  - Writes take idempotency keys; a repeat returns the original result and appends nothing.
 *
 * Not built: tier-specific physical stores and the forgetting curve (one table holds all three
 * layers), per-event mining prompts (one generic prompt), entity typing beyond what the caller
 * supplies, and ledger rotation (the ledger is never trimmed, so rotation is not needed).
 */
import { HMemDb } from "./db.ts";
import { Conflicts } from "./conflicts.ts";
import { Dreaming } from "./dreaming.ts";
import { Mining } from "./mining.ts";
import { type Redactor, createRedactor } from "./privacy.ts";
import { Retrieval } from "./retrieval.ts";
import { Sleep } from "./sleep.ts";
import { type AddInput, MemoryStore } from "./store.ts";
import {
  DEFAULT_TIER_CONFIDENCE,
  type FeedbackKind,
  type HMEMOptions,
  type LedgerAction,
  type LedgerEntry,
  type MemoryRecord,
  type MiningEventType,
  type QueryOptions,
  type QueryResult,
} from "./types.ts";

export * from "./types.ts";
export { type AddInput, MemoryStore } from "./store.ts";
export { Retrieval } from "./retrieval.ts";
export { Conflicts, type ConflictRecord, type Resolution, type Assessment } from "./conflicts.ts";
export { Sleep, type SleepPreview, type SleepReport, type PreviewAction } from "./sleep.ts";
export { Dreaming, type DreamProposal, type Proposer } from "./dreaming.ts";
export { Mining, parseStrictJsonArray } from "./mining.ts";
export { createRedactor, type Redactor } from "./privacy.ts";
export { embed, cosine, tokenize, jaccard } from "./lexical.ts";
export { visibleTo, comparable, scopeKey } from "./scope.ts";
export { DEFAULT_VOCABULARY, identifiersAgree, identifiersIn, type Vocabulary } from "./enrich.ts";

/** Read-only view of the append-only ledger. */
export class Ledger {
  constructor(private store: MemoryStore) {}
  /** Reading first records any change made to a record object outside the API, so the history is complete. */
  history(memoryId: string): LedgerEntry[] {
    return this.store.run(() => this.store.db.ledger({ memoryId }));
  }
  all(): LedgerEntry[] {
    return this.store.run(() => this.store.db.ledger());
  }
  filter(f: { action?: LedgerAction; actor?: string; from?: number; to?: number }): LedgerEntry[] {
    return this.all().filter((e) => (!f.action || e.action === f.action) && (!f.actor || e.actor === f.actor) && (f.from === undefined || e.timestamp >= f.from) && (f.to === undefined || e.timestamp <= f.to));
  }
  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const e of this.all()) out[e.action] = (out[e.action] ?? 0) + 1;
    return out;
  }
  /** One JSON object per line, in ledger order, for audit export. */
  export(): string {
    return this.all().map((e) => JSON.stringify(e)).join("\n");
  }
}

export class HMEM {
  readonly clock: () => number;
  readonly store: MemoryStore;
  readonly ledger: Ledger;
  readonly retrieval: Retrieval;
  readonly conflicts: Conflicts;
  readonly sleep: Sleep;
  readonly dreaming: Dreaming;
  readonly mining: Mining;
  private readonly db: HMemDb;

  constructor(opts: HMEMOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.db = new HMemDb(opts.persistDir);
    const tiers = { ...DEFAULT_TIER_CONFIDENCE, ...(opts.tierConfidence ?? {}) };
    this.store = new MemoryStore(this.db, this.clock, opts.actor ?? "system", tiers);
    this.ledger = new Ledger(this.store);
    const redactor: Redactor = opts.redactor ?? createRedactor();
    this.retrieval = new Retrieval(this.store, opts.embedder, opts.onEmbedderError ?? "degrade", redactor);
    this.conflicts = new Conflicts(this.store);
    this.sleep = new Sleep(this.store, this.conflicts, { protectConfidence: opts.protectConfidence ?? 0.85, sourceDisposition: opts.sourceDisposition ?? "supersede" });
    this.dreaming = new Dreaming(this.store, opts.requireReviewer ?? false);
    this.mining = new Mining(this.store, opts.minerFn);
  }

  add(input: AddInput): MemoryRecord {
    return this.store.add(input);
  }

  query(text: string, opts?: QueryOptions): QueryResult {
    return this.retrieval.query(text, opts);
  }

  queryAsync(text: string, opts?: QueryOptions): Promise<QueryResult> {
    return this.retrieval.queryAsync(text, opts);
  }

  backfillEmbeddings(): Promise<number> {
    return this.retrieval.backfillEmbeddings();
  }

  feedback(memoryId: string, kind: FeedbackKind, opts?: { by?: string; idempotencyKey?: string }): void {
    this.retrieval.feedback(memoryId, kind, opts);
  }

  mine(event: MiningEventType, text: string, opts?: Parameters<Mining["mineInteraction"]>[2]): Promise<MemoryRecord[]> {
    return this.mining.mineInteraction(event, text, opts);
  }

  close(): void {
    this.db.close();
  }
}
