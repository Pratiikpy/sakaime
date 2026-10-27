import { canonicalJson } from "../../util/canonical.ts";
import {
  type EffectiveEdge,
  type FactRecord,
  type PolicyConfig,
  type SlotResolution,
  effectiveSingleValued,
  resolveSlot,
} from "./resolution.ts";
import type {
  Context,
  Entity,
  FindingDependencies,
  ISODate,
  MergeProposal,
  ObservationRecord,
  Relationship,
  RelationshipTypeConfig,
  StaleReason,
  WorldEvent,
} from "./types.ts";

export interface FoldConfig {
  policy: PolicyConfig;
  relationshipTypes: Record<string, RelationshipTypeConfig>;
}

export interface RelRecord extends Relationship {
  seq: number;
  recordedAt: ISODate;
}

const SEP = "\u0000";
const slotKey = (about: string, predicate: string): string => `${about}${SEP}${predicate}`;

interface Affected {
  ref: string;
  reason: StaleReason;
}

/**
 * The folded state of an event log. `apply` is the only way state changes, and everything derived
 * from facts and edges (winners, effective validity, staleness) is either computed here from the log
 * order or computed on read by the pure functions in resolution.ts. Nothing is written back to the
 * log as a side effect, so replaying the same events under the same configuration reproduces this
 * object exactly. (The reference writes the winning value into the entity at assert time, which a
 * replay of its log cannot reproduce.)
 */
export class WorldState {
  readonly entities = new Map<string, Entity>();
  readonly contexts = new Map<string, Context>();
  readonly rels = new Map<string, RelRecord>();
  readonly facts = new Map<string, FactRecord>();
  readonly manual = new Map<string, { factId: string; seq: number; by: string }>();
  readonly aliases = new Map<string, string>();
  readonly observations = new Map<string, ObservationRecord>();
  readonly proposals = new Map<string, MergeProposal>();
  readonly findings = new Map<string, FindingDependencies>();
  private readonly pairs = new Set<string>();
  /** Every upsert of an entity, in log order, so the entity can be read as it stood at an earlier valid time. */
  private readonly entityHistory = new Map<string, { at: ISODate; seq: number; entity: Entity }[]>();
  private readonly slots = new Map<string, string[]>();
  private readonly dependents = new Map<string, Set<string>>();
  private effCache?: { version: number; map: Map<string, EffectiveEdge> };
  version = 0;
  lastSeq = 0;

  constructor(readonly config: FoldConfig) {}

  static fromEvents(events: Iterable<WorldEvent>, config: FoldConfig): WorldState {
    const state = new WorldState(config);
    for (const e of events) state.apply(e);
    return state;
  }

  canon(id: string): string {
    let cur = id;
    const seen = new Set<string>();
    while (this.aliases.has(cur) && !seen.has(cur)) {
      seen.add(cur);
      cur = this.aliases.get(cur)!;
    }
    return cur;
  }

  /* ------------------------------------------------------------------ reads */

  slotFacts(about: string, predicate: string): FactRecord[] {
    return (this.slots.get(slotKey(this.canon(about), predicate)) ?? []).map((id) => this.facts.get(id)!);
  }

  resolve(about: string, predicate: string, at?: ISODate): SlotResolution {
    const a = this.canon(about);
    const choice = this.manual.get(slotKey(a, predicate));
    return resolveSlot(a, predicate, this.slotFacts(a, predicate), {
      config: this.config.policy,
      ...(at !== undefined ? { at } : {}),
      ...(choice ? { manualChoice: { factId: choice.factId, seq: choice.seq } } : {}),
    });
  }

  /**
   * The entity as the world stood at valid time `when`, from the upserts whose source time is not
   * later than `when`. Undefined if no source had observed it by then.
   */
  entityAtTime(id: string, when: ISODate): Entity | undefined {
    const target = this.canon(id);
    const upserts: { at: ISODate; seq: number; entity: Entity }[] = [];
    for (const [stored, list] of this.entityHistory) if (this.canon(stored) === target) upserts.push(...list.filter((u) => u.at <= when));
    if (upserts.length === 0) return undefined;
    upserts.sort((a, b) => a.at.localeCompare(b.at) || a.seq - b.seq);
    let out: Entity | undefined;
    for (const u of upserts) {
      if (!out) {
        out = structuredClone(u.entity);
        out.id = target;
        continue;
      }
      out.attrs = { ...out.attrs, ...u.entity.attrs };
      out.updatedAt = u.entity.updatedAt;
      out.source = u.entity.source;
      if (u.entity.name) {
        out.name = u.entity.name;
        if (!out.aliases.includes(u.entity.name)) out.aliases.push(u.entity.name);
      }
    }
    return out;
  }

  /** Every (about, predicate) slot that holds at least one fact. */
  slotKeys(): { about: string; predicate: string }[] {
    return [...this.slots.keys()].map((k) => {
      const [about, predicate] = k.split(SEP) as [string, string];
      return { about, predicate };
    });
  }

  effective(): Map<string, EffectiveEdge> {
    if (this.effCache?.version === this.version) return this.effCache.map;
    const groups = new Map<string, RelRecord[]>();
    for (const r of this.rels.values()) {
      if (this.cardinalityOf(r.type) !== "one") continue;
      const key = [this.canon(r.from), r.type, r.context ?? ""].join(SEP);
      const resolved = { ...r, from: this.canon(r.from), to: this.canon(r.to) };
      const list = groups.get(key);
      if (list) list.push(resolved);
      else groups.set(key, [resolved]);
    }
    const map = new Map<string, EffectiveEdge>();
    for (const list of groups.values()) for (const [id, eff] of effectiveSingleValued(list)) map.set(id, eff);
    this.effCache = { version: this.version, map };
    return map;
  }

  /** Edges with endpoints resolved through merges and the effective end of validity applied. */
  edges(): RelRecord[] {
    const eff = this.effective();
    return [...this.rels.values()].map((r) => {
      const { validTo: _v, supersededBy: _s, ...rest } = r;
      const e = eff.get(r.id);
      const validTo = e ? e.validTo : r.validTo;
      return {
        ...rest,
        from: this.canon(r.from),
        to: this.canon(r.to),
        ...(validTo !== undefined ? { validTo } : {}),
        ...(e?.supersededBy ? { supersededBy: e.supersededBy } : {}),
      };
    });
  }

  cardinalityOf(type: string): "one" | "many" {
    return this.config.relationshipTypes[type]?.cardinality ?? "one";
  }

  hasPair(a: string, b: string): boolean {
    return this.pairs.has([a, b].sort().join(SEP));
  }

  dependentsOf(refs: readonly string[]): string[] {
    const out = new Set<string>();
    for (const ref of refs) for (const f of this.dependents.get(ref) ?? []) out.add(f);
    return [...out].sort();
  }

  /* ------------------------------------------------------------------ writes */

  apply(ev: WorldEvent): void {
    const impact: Affected[] = [];
    const p = ev.payload as any;
    switch (ev.kind) {
      case "upsertEntity": {
        this.foldEntity(p as Entity);
        const list = this.entityHistory.get(p.id) ?? [];
        list.push({ at: (p as Entity).updatedAt, seq: ev.seq, entity: structuredClone(p as Entity) });
        this.entityHistory.set(p.id, list);
        break;
      }
      case "upsertContext":
        this.foldContext(p as Context);
        break;
      case "relate":
        this.foldRelate(p as Relationship, ev, impact);
        break;
      case "endRelationship": {
        const rel = this.rels.get(p.id);
        if (rel) {
          rel.validTo = rel.validTo === undefined || p.validTo < rel.validTo ? p.validTo : rel.validTo;
          impact.push({ ref: rel.id, reason: "relationship-ended" });
        }
        break;
      }
      case "assertFact":
        this.foldAssert(p, ev, impact);
        break;
      case "retractFact":
        this.foldRetract(p, ev, impact);
        break;
      case "chooseFact": {
        const key = slotKey(this.canon(p.about), p.predicate);
        const before = this.winnerId(key);
        this.manual.set(key, { factId: p.factId, seq: ev.seq, by: p.by });
        this.pushWinnerChange(key, before, impact);
        break;
      }
      case "alias":
        this.foldAlias(p, impact);
        break;
      case "mergeProposed":
        this.proposals.set(p.id, { ...(p as MergeProposal) });
        this.pairs.add([p.leftId, p.rightId].sort().join(SEP));
        break;
      case "mergeResolved": {
        const proposal = this.proposals.get(p.id);
        if (proposal) {
          proposal.status = p.status;
          proposal.resolvedAt = p.at;
          proposal.resolvedBy = p.by;
        }
        break;
      }
      case "observe":
        this.observations.set(p.externalId, { ...(p as ObservationRecord) });
        break;
      case "declareDependencies":
        this.foldDependencies(p, ev);
        break;
      case "ingestRun":
        break;
    }
    this.lastSeq = ev.seq;
    this.version++;
    this.markStale(impact, ev);
  }

  private foldEntity(e: Entity): void {
    const existing = this.entities.get(e.id);
    if (!existing) {
      this.entities.set(e.id, structuredClone(e));
      return;
    }
    existing.attrs = { ...existing.attrs, ...e.attrs };
    existing.updatedAt = e.updatedAt;
    existing.source = e.source;
    if (e.name) {
      existing.name = e.name;
      if (!existing.aliases.includes(e.name)) existing.aliases.push(e.name);
    }
    if (existing.state === "emerging" && e.state !== "emerging") existing.state = e.state;
  }

  private foldContext(c: Context): void {
    const existing = this.contexts.get(c.id);
    if (!existing) {
      this.contexts.set(c.id, structuredClone(c));
      return;
    }
    existing.attrs = { ...existing.attrs, ...c.attrs };
    existing.updatedAt = c.updatedAt;
  }

  private foldRelate(r: Relationship, ev: WorldEvent, impact: Affected[]): void {
    if (this.rels.has(r.id)) return;
    const single = this.cardinalityOf(r.type) === "one";
    const groupEffective = () => {
      const list = [...this.rels.values()]
        .filter((x) => this.canon(x.from) === this.canon(r.from) && x.type === r.type && (x.context ?? "") === (r.context ?? ""))
        .map((x) => ({ ...x, from: this.canon(x.from), to: this.canon(x.to) }));
      return effectiveSingleValued(list);
    };
    const before = single ? groupEffective() : undefined;
    this.rels.set(r.id, { ...structuredClone(r), seq: ev.seq, recordedAt: ev.recordedAt });
    if (before) {
      const after = groupEffective();
      for (const [id, eff] of before) {
        const now = after.get(id);
        if (now?.validTo !== eff.validTo || now?.supersededBy !== eff.supersededBy) impact.push({ ref: id, reason: "relationship-closed" });
      }
    }
  }

  private foldAssert(f: any, ev: WorldEvent, impact: Affected[]): void {
    if (this.facts.has(f.id)) return;
    const key = slotKey(this.canon(f.about), f.predicate);
    const before = this.winnerId(key);
    const hadChoice = this.manual.has(key);
    this.facts.set(f.id, { ...structuredClone(f), seq: ev.seq, recordedAt: ev.recordedAt });
    const list = this.slots.get(key) ?? [];
    list.push(f.id);
    this.slots.set(key, list);
    if (hadChoice) {
      for (const id of list) if (id !== f.id) impact.push({ ref: id, reason: "decision-outdated" });
    } else {
      this.pushWinnerChange(key, before, impact, f.id);
    }
  }

  private foldRetract(p: any, ev: WorldEvent, impact: Affected[]): void {
    const fact = this.facts.get(p.factId);
    if (!fact || fact.retracted) return;
    const key = slotKey(this.canon(fact.about), fact.predicate);
    const before = this.winnerId(key);
    fact.retracted = { by: p.by, ...(p.reason ? { reason: p.reason } : {}), seq: ev.seq };
    impact.push({ ref: fact.id, reason: "fact-retracted" });
    this.pushWinnerChange(key, before, impact, fact.id);
  }

  private foldAlias(p: any, impact: Affected[]): void {
    const aliasId: string = p.aliasId;
    const primaryId: string = this.canon(p.primaryId);
    const aliasCanon = this.canon(aliasId);
    if (aliasCanon === primaryId) return;

    const predicates = new Set<string>();
    for (const k of this.slots.keys()) {
      const [about, predicate] = k.split(SEP) as [string, string];
      if (about === aliasCanon || about === primaryId) predicates.add(predicate);
    }
    const sides = new Map<string, { aliasWinner: string | null; primaryWinner: string | null; aliasIds: string[]; primaryIds: string[] }>();
    for (const pr of predicates) {
      const ak = slotKey(aliasCanon, pr);
      const pk = slotKey(primaryId, pr);
      sides.set(pr, { aliasWinner: this.winnerId(ak), primaryWinner: this.winnerId(pk), aliasIds: [...(this.slots.get(ak) ?? [])], primaryIds: [...(this.slots.get(pk) ?? [])] });
    }
    const edgesBefore = new Map(this.effective());

    this.aliases.set(aliasId, primaryId);
    const survivor = this.entities.get(primaryId);
    const loser = this.entities.get(aliasId);
    if (loser) {
      loser.mergedInto = primaryId;
      if (survivor) {
        for (const n of [...(loser.name ? [loser.name] : []), ...loser.aliases]) if (!survivor.aliases.includes(n)) survivor.aliases.push(n);
        for (const [k, v] of Object.entries(loser.attrs)) if (!(k in survivor.attrs)) survivor.attrs[k] = v;
      }
    }
    for (const k of [...this.slots.keys()]) {
      const [about, predicate] = k.split(SEP) as [string, string];
      if (about !== aliasCanon) continue;
      const target = slotKey(primaryId, predicate);
      const merged = [...(this.slots.get(target) ?? []), ...this.slots.get(k)!].sort((a, b) => this.facts.get(a)!.seq - this.facts.get(b)!.seq);
      this.slots.delete(k);
      this.slots.set(target, merged);
      const choice = this.manual.get(k);
      if (choice) {
        this.manual.delete(k);
        if (!this.manual.has(target)) this.manual.set(target, choice);
      }
    }
    this.version++;
    for (const [pr, side] of sides) {
      const after = this.winnerId(slotKey(primaryId, pr));
      if (after !== side.aliasWinner) for (const id of side.aliasIds) impact.push({ ref: id, reason: "winner-changed" });
      if (after !== side.primaryWinner) for (const id of side.primaryIds) impact.push({ ref: id, reason: "winner-changed" });
    }
    const edgesAfter = this.effective();
    for (const [id, eff] of edgesBefore) {
      const now = edgesAfter.get(id);
      if (now?.validTo !== eff.validTo || now?.supersededBy !== eff.supersededBy) impact.push({ ref: id, reason: "relationship-closed" });
    }
  }

  private foldDependencies(p: any, ev: WorldEvent): void {
    const previous = this.findings.get(p.findingId);
    if (previous) for (const ref of previous.refs) this.dependents.get(ref)?.delete(p.findingId);
    const refs: string[] = [...new Set<string>(p.refs)].sort();
    this.findings.set(p.findingId, { findingId: p.findingId, refs, declaredSeq: ev.seq });
    for (const ref of refs) {
      const set = this.dependents.get(ref) ?? new Set<string>();
      set.add(p.findingId);
      this.dependents.set(ref, set);
    }
  }

  /* ------------------------------------------------------------------ staleness */

  private winnerId(key: string): string | null {
    const [about, predicate] = key.split(SEP) as [string, string];
    return this.resolve(about, predicate).winner?.id ?? null;
  }

  /** If the slot's winner differs from `before`, every fact in the slot (except `exclude`) is affected. */
  private pushWinnerChange(key: string, before: string | null, impact: Affected[], exclude?: string): void {
    if (this.winnerId(key) === before) return;
    for (const id of this.slots.get(key) ?? []) if (id !== exclude) impact.push({ ref: id, reason: "winner-changed" });
  }

  private markStale(impact: Affected[], ev: WorldEvent): void {
    for (const { ref, reason } of impact) {
      for (const findingId of this.dependents.get(ref) ?? []) {
        const finding = this.findings.get(findingId)!;
        const stale = finding.stale ?? { sinceSeq: ev.seq, causes: [] };
        if (!stale.causes.some((c) => c.ref === ref && c.reason === reason && c.seq === ev.seq)) {
          stale.causes.push({ ref, reason, seq: ev.seq, eventId: ev.id });
        }
        finding.stale = stale;
      }
    }
  }

  /** The canonical form the idempotency check compares. Record time and log position are excluded. */
  shape(): unknown {
    const byId = <T extends { id: string }>(a: T, b: T) => a.id.localeCompare(b.id);
    const slim = <T extends { seq?: number; recordedAt?: string }>(o: T) => {
      const { seq: _s, recordedAt: _r, ...rest } = o;
      return rest;
    };
    return JSON.parse(
      canonicalJson({
        entities: [...this.entities.values()].sort(byId),
        contexts: [...this.contexts.values()].sort(byId),
        relationships: this.edges().map(slim).sort(byId),
        facts: [...this.facts.values()]
          .map((f) => slim({ ...f, retracted: f.retracted ? { by: f.retracted.by, reason: f.retracted.reason } : undefined }))
          .sort(byId),
        resolutions: this.slotKeys()
          .map(({ about, predicate }) => {
            const r = this.resolve(about, predicate);
            return { about, predicate, status: r.status, winner: r.winner?.id ?? null, decidedBy: r.decidedBy ?? null };
          })
          .sort((a, b) => `${a.about}|${a.predicate}`.localeCompare(`${b.about}|${b.predicate}`)),
        aliases: [...this.aliases.entries()].sort(),
        observations: [...this.observations.values()].sort((a, b) => a.externalId.localeCompare(b.externalId)),
        proposals: [...this.proposals.values()].sort(byId),
        findings: [...this.findings.values()]
          .map((f) => ({ findingId: f.findingId, refs: f.refs, stale: f.stale ? f.stale.causes.map((c) => `${c.ref}:${c.reason}`).sort() : null }))
          .sort((a, b) => a.findingId.localeCompare(b.findingId)),
      }),
    );
  }
}
