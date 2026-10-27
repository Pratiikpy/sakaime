/**
 * Sakaime World Model: an event-sourced, bi-temporal store of entities, contexts, relationships and
 * facts. Built from the specification and conformance runner of the Meterless World Model
 * (third_party/meterless/world-model); no reference source is copied. Differences from the
 * reference, each with a test in tests/engines/world-model:
 *
 *  - Every durable thing is an event in an append-only SQLite log. Fact resolution, edge
 *    supersession and staleness are pure functions of the folded log, so a restart and replay
 *    reproduces the same winners (the reference writes the winning value into entity state at assert
 *    time, which a replay of its log loses).
 *  - Relationship cardinality is configured per type. A `many` type keeps every target open (the
 *    reference closes the earlier edge of any `(from, type, context)` pair, which drops a device's
 *    second study). A `one` type closes by validity order, not by arrival order.
 *  - Two times. Valid time is what the source says (`validFrom`, `validTo`, provenance `at`); record
 *    time is when this store learned it. `asOf(date)` answers "what did we know on date D".
 *  - Entity resolution is an injected `IdentityResolver`, called from every path that creates a
 *    name-keyed entity, including `ingest`. The default never merges on name similarity alone.
 *  - Findings declare the fact and edge ids they used; a later event marks exactly the findings that
 *    depend on what changed as stale (`staleFindings`, `staleDependents`).
 *  - Writes take an idempotency key; a resumed run that repeats a write gets the original result.
 *
 * Not built: the reference's news-stream clustering (stories, velocity, trend direction), its
 * enrichment queue, schema migrations, operator permissions and browser control plane. Sakaime does
 * not use them, and they are not part of the conformance runner.
 */
import { canonicalJson } from "../../util/canonical.ts";
import { WorldState, type FoldConfig } from "./fold.ts";
import { EventLog } from "./log.ts";
import { WorldReader, type FactVersion } from "./reader.ts";
import { type FactRecord, type PolicyConfig, type SlotResolution } from "./resolution.ts";
import { type BandResolverOptions, type IdentityResolver, createBandResolver } from "./resolve.ts";
import { contextIdFromAttrs, entityIdFromName, externalId, factId, relationshipId, sha256Hex } from "./ids.ts";
import { toIso } from "./time.ts";
import {
  type AuditEntry,
  type Context,
  DEFAULT_RELATIONSHIP_TYPES,
  type Entity,
  type EventKind,
  type FindingDependencies,
  type IngestObservation,
  type IngestReport,
  type ISODate,
  type MergeProposal,
  type Provenance,
  type Relationship,
  type StoredProvenance,
  type WorldEvent,
  WorldModelError,
  type WorldModelOptions,
} from "./types.ts";

export * from "./types.ts";
export { EventLog } from "./log.ts";
export { WorldReader, GraphView, FactsView, SnapshotView, type FactVersion } from "./reader.ts";
export { resolveSlot, effectiveSingleValued, policyFor, type FactRecord, type SlotResolution, type PolicyConfig } from "./resolution.ts";
export { WorldState } from "./fold.ts";
export { decide, levenshtein, nameSimilarity, createBandResolver, type IdentityResolver, type IdentityOutcome, type IdentityCandidate, type BandResolverOptions } from "./resolve.ts";
export { canonicalJson, contextIdFromAttrs, entityIdFromName, externalId, factId, normalizeName, relationshipId, sha256Hex } from "./ids.ts";

type ExternalKey = { system: string; id: string };
interface Idem {
  idempotencyKey?: string;
}

export interface UpsertEntityInput extends Idem {
  type: string;
  externalKey?: ExternalKey;
  name?: string;
  attrs?: Record<string, unknown>;
  source: Provenance;
  state?: Entity["state"];
}
export interface UpsertContextInput extends Idem {
  type: string;
  externalKey?: ExternalKey;
  attrs?: Record<string, unknown>;
  parent?: string;
  source: Provenance;
}
export interface RelateInput extends Idem {
  from: string;
  type: string;
  to: string;
  context?: string;
  attrs?: Record<string, unknown>;
  validFrom?: string;
  validTo?: string;
  source: Provenance;
}
export interface AssertFactInput extends Idem {
  about: string;
  predicate: string;
  value: unknown;
  confidence?: number;
  context?: string;
  validFrom?: string;
  validTo?: string;
  source: Provenance;
}

export class WorldModel {
  private log: EventLog;
  private events: WorldEvent[] = [];
  private state!: WorldState;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly foldConfig: FoldConfig;
  private readonly resolver: IdentityResolver;
  private readonly clock: () => Date;
  private readonly allowDangling: boolean;
  private lastRecorded = "";
  private subscribers = new Set<(e: WorldEvent) => void>();
  private pendingNotify: WorldEvent[] = [];
  private customViews = new Map<string, { events: string[]; initialState: unknown; reducer: (s: any, e: WorldEvent) => any }>();
  private closed = false;

  constructor(private readonly opts: WorldModelOptions) {
    if (!opts.namespace) throw new WorldModelError("INVALID_INPUT", "namespace is required");
    this.clock = opts.clock ?? (() => new Date());
    this.allowDangling = opts.allowDanglingEdges ?? false;
    const relationshipTypes = { ...DEFAULT_RELATIONSHIP_TYPES, ...(opts.relationshipTypes ?? {}) };
    if (relationshipTypes["mentions"]?.cardinality !== "many") {
      throw new WorldModelError("INVALID_INPUT", "`mentions` must be many-valued: ingest writes one mention edge per entity an observation names");
    }
    const policy: PolicyConfig = { policy: opts.conflictPolicy ?? "most-recent-wins", sourcePriority: opts.sourcePriority ?? [] };
    this.foldConfig = { policy, relationshipTypes };
    const r = opts.resolver;
    this.resolver = r && "resolve" in r && typeof r.resolve === "function" ? (r as IdentityResolver) : createBandResolver((r ?? {}) as BandResolverOptions);
    this.log = new EventLog({ storage: opts.storage ?? "memory", namespace: opts.namespace, ...(opts.directory ? { directory: opts.directory } : {}) });
    this.reload();
  }

  /** Rebuilds every in-memory structure from the log. Used on open and after a failed write. */
  private reload(): void {
    this.events = this.log.all();
    this.state = WorldState.fromEvents(this.events, this.foldConfig);
    this.lastRecorded = this.events.at(-1)?.recordedAt ?? "";
  }

  close(): void {
    this.closed = true;
    this.log.close();
  }

  /* ------------------------------------------------------------------ write plumbing */

  private enqueue<T>(fn: () => T): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.closed) throw new WorldModelError("CLOSED", "the store is closed");
      this.pendingNotify = [];
      try {
        const out = this.log.transaction(fn);
        for (const e of this.pendingNotify) for (const sub of this.subscribers) sub(e);
        return out;
      } catch (err) {
        this.reload();
        throw err;
      } finally {
        this.pendingNotify = [];
      }
    };
    const next = this.queue.then(run);
    this.queue = next.catch(() => undefined);
    return next;
  }

  /** Appends one event to the log and applies it to the folded state. Called only inside `enqueue`. */
  private emit(kind: EventKind, payload: object, meta: { at: ISODate; actor: string; summary: string; runId?: string }): WorldEvent {
    const stamp = this.clock().toISOString();
    const recordedAt = stamp > this.lastRecorded ? stamp : this.lastRecorded;
    const seq = this.state.lastSeq + 1;
    const ev: WorldEvent = {
      id: `evt_${seq}`,
      seq,
      kind,
      payload: JSON.parse(canonicalJson(payload)),
      schemaVersion: 1,
      at: meta.at,
      recordedAt,
      actor: meta.actor,
      summary: meta.summary,
      ...(meta.runId ? { runId: meta.runId } : {}),
    };
    this.log.append(ev);
    this.events.push(ev);
    this.lastRecorded = recordedAt;
    this.state.apply(ev);
    this.pendingNotify.push(ev);
    return ev;
  }

  /**
   * Runs a write once per idempotency key. A repeat with the same key and payload returns the
   * original result without appending anything; the same key with a different payload is refused.
   */
  private once<T>(key: string | undefined, op: string, payload: unknown, run: () => T, save: (r: T) => unknown, load: (saved: any) => T): T {
    if (!key) return run();
    const hash = sha256Hex(canonicalJson({ op, payload }));
    const prior = this.log.getIdempotent(key);
    if (prior) {
      if (prior.payloadHash !== hash) throw new WorldModelError("IDEMPOTENCY_CONFLICT", `idempotency key ${JSON.stringify(key)} was already used for a different ${prior.op} request`);
      return load(JSON.parse(prior.result));
    }
    const out = run();
    this.log.putIdempotent({ key, op, payloadHash: hash, result: JSON.stringify(save(out)) });
    return out;
  }

  private provenance(source: Provenance | undefined): StoredProvenance {
    if (!source || typeof source.kind !== "string" || source.kind === "" || source.at === undefined || source.at === null) {
      throw new WorldModelError("PROVENANCE_REQUIRED", "every write carries provenance (kind and at). No provenance, no write.");
    }
    return { ...source, at: toIso(source.at, "source.at") };
  }

  private requireText(value: unknown, label: string): string {
    if (typeof value !== "string" || value.trim() === "") throw new WorldModelError("INVALID_INPUT", `${label} must be a non-empty string`);
    return value;
  }

  /* ------------------------------------------------------------------ entities */

  upsertEntity(input: UpsertEntityInput): Promise<Entity> {
    return this.enqueue(() =>
      this.once(
        input.idempotencyKey,
        "upsertEntity",
        { ...input, idempotencyKey: undefined },
        () => this.writeEntity(input, this.provenance(input.source)),
        (e) => ({ id: e.id }),
        (saved) => this.state.entities.get(this.state.canon(saved.id))!,
      ),
    );
  }

  private writeEntity(input: UpsertEntityInput, source: StoredProvenance): Entity {
    this.requireText(input.type, "type");
    const name = input.name ?? (typeof input.attrs?.["name"] === "string" ? (input.attrs["name"] as string) : undefined);
    if (input.externalKey) {
      this.requireText(input.externalKey.system, "externalKey.system");
      this.requireText(input.externalKey.id, "externalKey.id");
    } else if (name === undefined || name.trim() === "") {
      throw new WorldModelError("INVALID_INPUT", "a name-keyed entity needs a name (or provide an externalKey)");
    }
    const id = input.externalKey ? externalId(input.type, input.externalKey.system, input.externalKey.id) : entityIdFromName(input.type, name!);
    let target = this.state.canon(id);
    if (!input.externalKey && !this.state.entities.has(id) && target === id) target = this.resolveIdentity(input.type, name!, id, source);
    const entity: Entity = {
      type: input.type,
      id: target,
      attrs: { ...(input.attrs ?? {}) },
      schemaVersion: 1,
      source,
      createdAt: source.at,
      updatedAt: source.at,
      ...(name !== undefined ? { name } : {}),
      aliases: name !== undefined ? [name] : [],
      state: input.state ?? "active",
    };
    this.emit("upsertEntity", entity, { at: source.at, actor: source.by ?? "system", summary: `${target} (${input.type})`, ...(source.runId ? { runId: source.runId } : {}) });
    return this.state.entities.get(target)!;
  }

  /** The one path every name-keyed entity takes, so ingest cannot skip resolution. */
  private resolveIdentity(type: string, name: string, id: string, source: StoredProvenance): string {
    const existing = [...this.state.entities.values()]
      .filter((e) => e.type === type && !e.mergedInto && e.name !== undefined)
      .map((e) => ({ id: e.id, type: e.type, name: e.name!, aliases: e.aliases }));
    const outcome = this.resolver.resolve({ type, name }, existing);
    if (outcome.action === "match") {
      this.emit(
        "alias",
        { aliasId: id, primaryId: outcome.entityId, mergedAt: source.at, mergedBy: "resolver", reason: outcome.reason },
        { at: source.at, actor: "resolver", summary: `${name} -> ${outcome.entityId} (${outcome.similarity.toFixed(3)})` },
      );
      return this.state.canon(outcome.entityId);
    }
    if (outcome.action === "review") {
      for (const c of outcome.candidates) {
        if (this.state.hasPair(id, c.entityId)) continue;
        const other = this.state.entities.get(c.entityId)!;
        const proposal: MergeProposal = {
          id: `merge_${this.state.proposals.size + 1}`,
          leftId: id,
          rightId: c.entityId,
          leftName: name,
          rightName: other.name ?? other.id,
          similarity: c.similarity,
          reason: c.reason,
          status: "pending",
          proposedAt: source.at,
        };
        this.emit("mergeProposed", proposal, { at: source.at, actor: "resolver", summary: `${name} ~ ${proposal.rightName} (${c.similarity.toFixed(3)}) queued for review` });
      }
    }
    return id;
  }

  upsertContext(input: UpsertContextInput): Promise<Context> {
    return this.enqueue(() =>
      this.once(
        input.idempotencyKey,
        "upsertContext",
        { ...input, idempotencyKey: undefined },
        () => {
          const source = this.provenance(input.source);
          this.requireText(input.type, "type");
          const id = input.externalKey ? externalId(input.type, input.externalKey.system, input.externalKey.id) : contextIdFromAttrs(input.type, input.attrs ?? {}, input.parent);
          const context: Context = {
            type: input.type,
            id,
            attrs: { ...(input.attrs ?? {}) },
            ...(input.parent ? { parent: input.parent } : {}),
            schemaVersion: 1,
            source,
            createdAt: source.at,
            updatedAt: source.at,
          };
          this.emit("upsertContext", context, { at: source.at, actor: source.by ?? "system", summary: `${id} (${input.type})` });
          return this.state.contexts.get(id)!;
        },
        (c) => ({ id: c.id }),
        (saved) => this.state.contexts.get(saved.id)!,
      ),
    );
  }

  /* ------------------------------------------------------------------ relationships */

  relate(input: RelateInput): Promise<Relationship> {
    return this.enqueue(() =>
      this.once(
        input.idempotencyKey,
        "relate",
        { ...input, idempotencyKey: undefined },
        () => this.writeRelationship(input, this.provenance(input.source)),
        (r) => ({ id: r.id }),
        (saved) => this.edge(saved.id)!,
      ),
    );
  }

  private edge(id: string): Relationship | undefined {
    return this.state.edges().find((e) => e.id === id);
  }

  private writeRelationship(input: RelateInput, source: StoredProvenance): Relationship {
    this.requireText(input.type, "type");
    const from = this.state.canon(this.requireText(input.from, "from"));
    const to = this.state.canon(this.requireText(input.to, "to"));
    if (!this.allowDangling) {
      for (const [label, id] of [["from", from], ["to", to]] as const) {
        if (!this.state.entities.has(id)) throw new WorldModelError("UNKNOWN_ENTITY", `relate: ${label} entity ${id} has not been upserted`);
      }
      if (input.context !== undefined && !this.state.contexts.has(input.context)) throw new WorldModelError("UNKNOWN_ENTITY", `relate: context ${input.context} has not been upserted`);
    }
    const validFrom = input.validFrom !== undefined ? toIso(input.validFrom, "validFrom") : source.at;
    const validTo = input.validTo !== undefined ? toIso(input.validTo, "validTo") : undefined;
    if (validTo !== undefined && validTo < validFrom) throw new WorldModelError("INVALID_INPUT", `relate: validTo ${validTo} precedes validFrom ${validFrom}`);
    const id = relationshipId(from, input.type, to, input.context, input.validFrom !== undefined ? validFrom : undefined);
    if (!this.state.rels.has(id)) {
      const rel: Relationship = {
        id,
        from,
        type: input.type,
        to,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.attrs ? { attrs: input.attrs } : {}),
        validFrom,
        ...(validTo !== undefined ? { validTo } : {}),
        schemaVersion: 1,
        source,
        createdAt: source.at,
      };
      this.emit("relate", rel, { at: source.at, actor: source.by ?? "system", summary: `${from} -[${input.type}]-> ${to}` });
    }
    return this.edge(id)!;
  }

  /** Closes an edge at a valid time. The edge stays in the log and in `asOf` views from before. */
  endRelationship(input: { id: string; validTo: string; source: Provenance; reason?: string; idempotencyKey?: string }): Promise<void> {
    return this.enqueue(() =>
      this.once(
        input.idempotencyKey,
        "endRelationship",
        { ...input, idempotencyKey: undefined },
        () => {
          const source = this.provenance(input.source);
          const rel = this.state.rels.get(input.id);
          if (!rel) throw new WorldModelError("NOT_FOUND", `no relationship ${input.id}`);
          const validTo = toIso(input.validTo, "validTo");
          if (validTo < rel.validFrom) throw new WorldModelError("INVALID_INPUT", `endRelationship: validTo ${validTo} precedes validFrom ${rel.validFrom}`);
          if (rel.validTo !== undefined && rel.validTo <= validTo) return;
          this.emit("endRelationship", { id: input.id, validTo, ...(input.reason ? { reason: input.reason } : {}) }, { at: source.at, actor: source.by ?? "system", summary: `end ${input.id} at ${validTo}` });
        },
        () => ({}),
        () => undefined,
      ),
    );
  }

  /* ------------------------------------------------------------------ facts */

  assertFact(input: AssertFactInput): Promise<FactRecord> {
    return this.enqueue(() =>
      this.once(
        input.idempotencyKey,
        "assertFact",
        { ...input, idempotencyKey: undefined },
        () => this.writeFact(input, this.provenance(input.source)),
        (f) => ({ id: f.id }),
        (saved) => this.state.facts.get(saved.id)!,
      ),
    );
  }

  private writeFact(input: AssertFactInput, source: StoredProvenance): FactRecord {
    const about = this.state.canon(this.requireText(input.about, "about"));
    const predicate = this.requireText(input.predicate, "predicate");
    if (input.value === undefined) throw new WorldModelError("INVALID_INPUT", "a fact needs a value; use retractFact to withdraw one");
    const confidence = input.confidence ?? 0.5;
    if (typeof confidence !== "number" || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
      throw new WorldModelError("INVALID_INPUT", `confidence must be a number from 0 to 1, got ${String(confidence)}`);
    }
    try {
      canonicalJson(input.value);
    } catch (err) {
      throw new WorldModelError("INVALID_INPUT", `fact value cannot be stored: ${(err as Error).message}`);
    }
    const validFrom = input.validFrom !== undefined ? toIso(input.validFrom, "validFrom") : undefined;
    const validTo = input.validTo !== undefined ? toIso(input.validTo, "validTo") : undefined;
    if (validTo !== undefined && validTo < (validFrom ?? source.at)) throw new WorldModelError("INVALID_INPUT", "fact validTo precedes its start");
    const id = factId(about, predicate, input.value, source.at, source.kind, source.url);
    if (this.state.facts.has(id)) return this.state.facts.get(id)!;
    if (!this.state.entities.has(about)) {
      const inferred = about.includes(":") ? about.split(":")[0]! : "entity";
      const stub: Entity = { type: inferred, id: about, attrs: {}, schemaVersion: 1, source, createdAt: source.at, updatedAt: source.at, aliases: [], state: "emerging" };
      this.emit("upsertEntity", stub, { at: source.at, actor: source.by ?? "system", summary: `${about} (${inferred}, created by a fact)` });
    }
    const fact = {
      id,
      about,
      predicate,
      value: input.value,
      confidence,
      ...(input.context !== undefined ? { context: input.context } : {}),
      source,
      assertedAt: source.at,
      ...(validFrom !== undefined ? { validFrom } : {}),
      ...(validTo !== undefined ? { validTo } : {}),
    };
    this.emit("assertFact", fact, { at: source.at, actor: source.by ?? "system", summary: `${about}.${predicate} = ${JSON.stringify(input.value)}`, ...(source.runId ? { runId: source.runId } : {}) });
    return this.state.facts.get(id)!;
  }

  /** Withdraws a fact (a source corrected itself). The fact stays in history; dependents go stale. */
  retractFact(input: { factId: string; source: Provenance; reason?: string; idempotencyKey?: string }): Promise<void> {
    return this.enqueue(() =>
      this.once(
        input.idempotencyKey,
        "retractFact",
        { ...input, idempotencyKey: undefined },
        () => {
          const source = this.provenance(input.source);
          const fact = this.state.facts.get(input.factId);
          if (!fact) throw new WorldModelError("NOT_FOUND", `no fact ${input.factId}`);
          if (fact.retracted) return;
          this.emit("retractFact", { factId: input.factId, by: source.by ?? "system", ...(input.reason ? { reason: input.reason } : {}) }, { at: source.at, actor: source.by ?? "system", summary: `retract ${input.factId}` });
        },
        () => ({}),
        () => undefined,
      ),
    );
  }

  /** A reviewer's decision for a slot. It outranks the policy until the fact is retracted. */
  chooseFact(input: { about: string; predicate: string; factId: string; by: string; reason?: string; idempotencyKey?: string }): Promise<SlotResolution> {
    return this.enqueue(() =>
      this.once(
        input.idempotencyKey,
        "chooseFact",
        { ...input, idempotencyKey: undefined },
        () => {
          this.requireText(input.by, "by");
          const about = this.state.canon(input.about);
          const fact = this.state.facts.get(input.factId);
          if (!fact || this.state.canon(fact.about) !== about || fact.predicate !== input.predicate) {
            throw new WorldModelError("NOT_FOUND", `fact ${input.factId} is not a fact about ${about}.${input.predicate}`);
          }
          if (fact.retracted) throw new WorldModelError("INVALID_INPUT", `fact ${input.factId} is retracted`);
          const now = this.clock().toISOString();
          this.emit("chooseFact", { about, predicate: input.predicate, factId: input.factId, by: input.by, ...(input.reason ? { reason: input.reason } : {}) }, { at: now, actor: input.by, summary: `${input.by} chose ${input.factId} for ${about}.${input.predicate}` });
          return this.state.resolve(about, input.predicate);
        },
        () => ({ about: input.about, predicate: input.predicate }),
        (saved) => this.state.resolve(saved.about, saved.predicate),
      ),
    );
  }

  /* ------------------------------------------------------------------ dependencies and staleness */

  /**
   * Records which facts and edges a finding was computed from. Declaring again replaces the set and
   * clears the stale flag, which is how a recomputed finding says it is current.
   */
  declareDependencies(input: { findingId: string; refs: readonly string[]; by?: string; idempotencyKey?: string }): Promise<FindingDependencies> {
    return this.enqueue(() =>
      this.once(
        input.idempotencyKey,
        "declareDependencies",
        { ...input, idempotencyKey: undefined },
        () => {
          this.requireText(input.findingId, "findingId");
          if (!Array.isArray(input.refs)) throw new WorldModelError("INVALID_INPUT", "refs must be an array of fact or relationship ids");
          const unknown = input.refs.filter((r) => !this.state.facts.has(r) && !this.state.rels.has(r));
          if (unknown.length > 0) throw new WorldModelError("UNKNOWN_REF", `unknown fact or relationship ids: ${unknown.join(", ")}`);
          const now = this.clock().toISOString();
          this.emit("declareDependencies", { findingId: input.findingId, refs: [...input.refs] }, { at: now, actor: input.by ?? "system", summary: `${input.findingId} depends on ${input.refs.length} item(s)` });
          return this.state.findings.get(input.findingId)!;
        },
        () => ({ findingId: input.findingId }),
        (saved) => this.state.findings.get(saved.findingId)!,
      ),
    );
  }

  finding(findingId: string): FindingDependencies | undefined {
    return this.state.findings.get(findingId);
  }

  /** Findings that used any of the given facts or edges. Static: says nothing about whether they are stale. */
  dependentsOf(refs: readonly string[]): string[] {
    return this.state.dependentsOf(refs);
  }

  /** Every finding marked stale and not yet re-declared. */
  staleFindings(): string[] {
    return [...this.state.findings.values()].filter((f) => f.stale).map((f) => f.findingId).sort();
  }

  /** The dependents of the given facts or edges that are currently stale. */
  staleDependents(factIds: readonly string[]): string[] {
    return this.state.dependentsOf(factIds).filter((id) => this.state.findings.get(id)?.stale);
  }

  /* ------------------------------------------------------------------ ingest */

  ingest(observations: IngestObservation[], opts: { idempotencyKey?: string } = {}): Promise<IngestReport> {
    return this.enqueue(() =>
      this.once(
        opts.idempotencyKey,
        "ingest",
        observations,
        () => this.runIngest(observations),
        (r) => r,
        (saved) => ({ ...saved, replayed: true }),
      ),
    );
  }

  private runIngest(observations: IngestObservation[]): IngestReport {
    if (!Array.isArray(observations)) throw new WorldModelError("INVALID_INPUT", "ingest takes an array of observations");
    const prepared = observations.map((obs, i) => {
      const where = `observation ${i}`;
      this.requireText(obs?.externalId, `${where}: externalId`);
      this.requireText(obs.title, `${where}: title`);
      const at = toIso(obs.at, `${where}: at`);
      const source = this.provenance({ ...obs.source, at });
      const mentions = (obs.entities ?? []).map((m, j) => {
        this.requireText(m?.type, `${where}: entities[${j}].type`);
        this.requireText(m?.name, `${where}: entities[${j}].name`);
        return { type: m.type, name: m.name };
      });
      const checksum = sha256Hex(
        canonicalJson({ externalId: obs.externalId, type: obs.type ?? "item", title: obs.title, text: obs.text ?? "", at, mentions: [...mentions].sort((a, b) => `${a.type}|${a.name}`.localeCompare(`${b.type}|${b.name}`)) }),
      );
      return { obs, at, source, mentions, checksum };
    });
    const runId = `run_${sha256Hex(canonicalJson(observations.map((o) => o.externalId))).slice(0, 12)}`;
    const before = canonicalJson(this.state.shape());
    const eventsBefore = this.state.lastSeq;
    let processed = 0;
    let skipped = 0;
    for (const p of prepared) {
      const prior = this.state.observations.get(p.obs.externalId);
      if (prior && prior.checksum === p.checksum) {
        skipped++;
        continue;
      }
      processed++;
      const type = p.obs.type ?? "item";
      const runSource = { ...p.source, runId };
      const item = this.writeEntity(
        { type, externalKey: { system: "ingest", id: p.obs.externalId }, name: p.obs.title, attrs: { title: p.obs.title, text: p.obs.text }, source: runSource },
        runSource,
      );
      const mentionIds: string[] = [];
      for (const m of p.mentions) {
        const mentioned = this.writeEntity({ type: m.type, name: m.name, source: runSource }, runSource);
        if (!mentionIds.includes(mentioned.id)) mentionIds.push(mentioned.id);
      }
      mentionIds.sort();
      const previous = prior?.mentionIds ?? [];
      for (const id of mentionIds.filter((x) => !previous.includes(x))) {
        this.writeRelationship({ from: item.id, type: "mentions", to: id, validFrom: p.at, source: runSource }, runSource);
      }
      for (const id of previous.filter((x) => !mentionIds.includes(x))) {
        const open = this.state.edges().filter((e) => e.from === item.id && e.to === id && e.type === "mentions" && e.validTo === undefined);
        for (const e of open) this.emit("endRelationship", { id: e.id, validTo: p.at, reason: "no longer mentioned by the edited observation" }, { at: p.at, actor: p.source.by ?? "system", summary: `end ${e.id}`, runId });
      }
      this.emit("observe", { externalId: p.obs.externalId, entityId: item.id, checksum: p.checksum, at: p.at, mentionIds }, { at: p.at, actor: p.source.by ?? "system", summary: `observed ${p.obs.externalId}`, runId });
    }
    if (processed > 0) this.emit("ingestRun", { runId, processed, skipped }, { at: prepared.at(-1)!.at, actor: "pipeline", summary: `run ${runId}: ${processed} processed, ${skipped} skipped`, runId });
    return { runId, processed, skippedUnchanged: skipped, eventsAppended: this.state.lastSeq - eventsBefore, changed: before !== canonicalJson(this.state.shape()) };
  }

  /* ------------------------------------------------------------------ merge queue */

  mergeQueue(): MergeProposal[] {
    return [...this.state.proposals.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
  }

  approveMerge(proposalId: string, by: string): Promise<void> {
    return this.enqueue(() => {
      this.requireText(by, "by");
      const p = this.state.proposals.get(proposalId);
      if (!p || p.status !== "pending") throw new WorldModelError("NOT_FOUND", `no pending merge proposal ${proposalId}`);
      const at = this.clock().toISOString();
      this.emit("mergeResolved", { id: proposalId, status: "approved", by, at }, { at, actor: by, summary: `${by} approved ${proposalId}` });
      this.emit("alias", { aliasId: p.leftId, primaryId: p.rightId, mergedAt: at, mergedBy: by, reason: p.reason }, { at, actor: by, summary: `${p.leftName} -> ${p.rightName}` });
    });
  }

  rejectMerge(proposalId: string, by: string): Promise<void> {
    return this.enqueue(() => {
      this.requireText(by, "by");
      const p = this.state.proposals.get(proposalId);
      if (!p || p.status !== "pending") throw new WorldModelError("NOT_FOUND", `no pending merge proposal ${proposalId}`);
      const at = this.clock().toISOString();
      this.emit("mergeResolved", { id: proposalId, status: "rejected", by, at }, { at, actor: by, summary: `${by} kept ${p.leftName} separate from ${p.rightName}` });
    });
  }

  /* ------------------------------------------------------------------ reads */

  private reader(): WorldReader {
    return new WorldReader(this.state, this.events, (fn) => this.subscribeEvents(fn));
  }

  view(name: "graph"): WorldReader["graph"];
  view(name: "facts"): WorldReader["facts"];
  view(name: "snapshot"): WorldReader["snapshot"];
  view(name: "timeline"): WorldReader["timeline"];
  view(name: string): { get(): unknown };
  view(name: string): unknown {
    const r = this.reader();
    if (name === "graph") return r.graph;
    if (name === "facts") return r.facts;
    if (name === "snapshot") return r.snapshot;
    if (name === "timeline") return r.timeline;
    const custom = this.customViews.get(name);
    if (!custom) throw new WorldModelError("NOT_FOUND", `unknown view "${name}"`);
    return {
      get: () => {
        let s = structuredClone(custom.initialState);
        for (const e of this.events) if (custom.events.includes(e.kind)) s = custom.reducer(s, e);
        return s;
      },
    };
  }

  registerView<S>(name: string, spec: { events: string[]; initialState: S; reducer: (state: S, event: WorldEvent) => S }): void {
    this.customViews.set(name, spec);
  }

  /**
   * What the store knew by the end of `date` (record time). A fact or edge recorded after that
   * moment is absent, even if its valid time is earlier: that is the difference between "what was
   * true then" and "what did we know then".
   */
  asOf(date: string | Date): WorldReader {
    const cutoff = toIso(date, "asOf", { endOfDay: true });
    const known = this.events.filter((e) => e.recordedAt <= cutoff);
    return new WorldReader(WorldState.fromEvents(known, this.foldConfig), known, () => () => undefined);
  }

  /** The resolution of one slot (winner, rivals with their status, conflict flag, reason). */
  resolve(about: string, predicate: string, opts: { at?: string | Date; asOf?: string | Date } = {}): SlotResolution {
    const reader = opts.asOf !== undefined ? this.asOf(opts.asOf) : this.reader();
    return reader.facts.resolve(about, predicate, opts.at !== undefined ? { at: opts.at } : {});
  }

  audit(): readonly AuditEntry[] {
    return this.events.map((e) => ({ seq: e.seq, at: e.at, recordedAt: e.recordedAt, kind: e.kind, actor: e.actor, summary: e.summary, eventId: e.id, ...(e.runId ? { runId: e.runId } : {}) }));
  }

  eventLog(): readonly WorldEvent[] {
    return this.events;
  }

  stateShape(): unknown {
    return this.state.shape();
  }

  stateShapeCanonical(): string {
    return canonicalJson(this.state.shape());
  }

  subscribeEvents(fn: (e: WorldEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }
}
