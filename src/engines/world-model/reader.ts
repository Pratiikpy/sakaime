import type { WorldState } from "./fold.ts";
import { type FactRecord, type RivalStatus, type SlotResolution, isValidAt } from "./resolution.ts";
import { toIso } from "./time.ts";
import type { Entity, ISODate, Relationship, WorldEvent } from "./types.ts";

const at = (v: string | Date | undefined): ISODate | undefined => (v === undefined ? undefined : toIso(v, "at", { endOfDay: true }));

export interface FactVersion extends FactRecord {
  status: "current" | RivalStatus;
  supersededBy?: string;
}

/**
 * Read surface over one folded state. `WorldModel.view()` reads the latest state; `WorldModel.asOf()`
 * reads the state as it was recorded by a past moment. Both use the same code.
 */
export class WorldReader {
  readonly graph: GraphView;
  readonly facts: FactsView;
  readonly snapshot: SnapshotView;
  readonly timeline: TimelineView;

  constructor(
    readonly state: WorldState,
    events: readonly WorldEvent[],
    subscribe: (fn: (e: WorldEvent) => void) => () => void,
  ) {
    this.graph = new GraphView(state);
    this.facts = new FactsView(state);
    this.snapshot = new SnapshotView(this.graph);
    this.timeline = new TimelineView(events, subscribe);
  }
}

export class GraphView {
  constructor(private s: WorldState) {}

  /** The entity with each fact slot's winning value laid over its base attributes. */
  entity(id: string, atTime?: string | Date): Entity | undefined {
    const when = at(atTime);
    const e = when !== undefined ? this.s.entityAtTime(id, when) : this.s.entities.get(this.s.canon(id));
    if (!e) return undefined;
    const attrs = { ...e.attrs };
    for (const { about, predicate } of this.s.slotKeys()) {
      if (about !== e.id) continue;
      const winner = this.s.resolve(about, predicate, when).winner;
      if (winner) attrs[predicate] = winner.value;
    }
    return { ...e, attrs, aliases: [...e.aliases] };
  }

  /** Edges incident to the entity. Without `at`, edges that have not ended; with `at`, edges valid then. */
  edgesOf(id: string, opts: { via?: string; inContext?: string; at?: string | Date; direction?: "out" | "in" | "both" } = {}): Relationship[] {
    const rid = this.s.canon(id);
    const when = at(opts.at);
    const dir = opts.direction ?? "both";
    return this.s
      .edges()
      .filter((r) => {
        if (opts.via && r.type !== opts.via) return false;
        if (opts.inContext && r.context !== opts.inContext) return false;
        if (when !== undefined ? !isValidAt(r, when) : r.validTo !== undefined) return false;
        const out = r.from === rid;
        const inn = r.to === rid;
        return dir === "out" ? out : dir === "in" ? inn : out || inn;
      })
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  neighborsOf(id: string, opts: { via?: string; inContext?: string; at?: string | Date } = {}): Entity[] {
    const rid = this.s.canon(id);
    const seen = new Map<string, Entity>();
    for (const r of this.edgesOf(id, opts)) {
      const other = r.from === rid ? r.to : r.from;
      const entity = this.entity(other, opts.at);
      if (entity) seen.set(entity.id, entity);
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  incoming(id: string, opts: { via?: string; at?: string | Date } = {}): Entity[] {
    const seen = new Map<string, Entity>();
    for (const r of this.edgesOf(id, { ...opts, direction: "in" })) {
      const entity = this.entity(r.from, opts.at);
      if (entity) seen.set(entity.id, entity);
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  outgoing(id: string, opts: { via?: string; at?: string | Date } = {}): Entity[] {
    const seen = new Map<string, Entity>();
    for (const r of this.edgesOf(id, { ...opts, direction: "out" })) {
      const entity = this.entity(r.to, opts.at);
      if (entity) seen.set(entity.id, entity);
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  entitiesInContext(contextId: string, opts: { type?: string } = {}): Entity[] {
    const seen = new Map<string, Entity>();
    for (const r of this.s.edges()) {
      if (r.context !== contextId) continue;
      for (const id of [r.from, r.to]) {
        const entity = this.entity(id);
        if (entity && (!opts.type || entity.type === opts.type)) seen.set(entity.id, entity);
      }
    }
    return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  traverse(startId: string, opts: { via: string; direction: "ancestors" | "descendants"; maxDepth?: number }): Entity[] {
    const maxDepth = opts.maxDepth ?? 5;
    const out: Entity[] = [];
    const visited = new Set<string>([this.s.canon(startId)]);
    let frontier = [this.s.canon(startId)];
    const edges = this.s.edges().filter((r) => r.type === opts.via && r.validTo === undefined);
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
      const next: string[] = [];
      for (const id of frontier) {
        for (const r of edges) {
          const target = opts.direction === "ancestors" ? (r.from === id ? r.to : undefined) : r.to === id ? r.from : undefined;
          if (target && !visited.has(target)) {
            visited.add(target);
            const entity = this.entity(target);
            if (entity) out.push(entity);
            next.push(target);
          }
        }
      }
      frontier = next;
    }
    return out;
  }

  query(opts: { type?: string; where?: (e: Entity) => boolean } = {}): Entity[] {
    return [...this.s.entities.values()]
      .filter((e) => !e.mergedInto)
      .map((e) => this.entity(e.id)!)
      .filter((e) => (!opts.type || e.type === opts.type) && (!opts.where || opts.where(e)))
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}

export class FactsView {
  constructor(private s: WorldState) {}

  /** Every version of every fact about the entity, with whether it currently wins, lost or was retracted. */
  about(id: string, opts: { at?: string | Date } = {}): FactVersion[] {
    const rid = this.s.canon(id);
    const when = at(opts.at);
    const out: FactVersion[] = [];
    for (const { about, predicate } of this.s.slotKeys()) {
      if (about !== rid) continue;
      const res = this.s.resolve(about, predicate, when);
      if (res.winner) out.push({ ...res.winner, status: "current" });
      for (const r of res.rivals) out.push({ ...r.fact, status: r.status, ...(r.supersededBy ? { supersededBy: r.supersededBy } : {}) });
    }
    return out.sort((a, b) => a.assertedAt.localeCompare(b.assertedAt) || a.seq - b.seq);
  }

  resolve(about: string, predicate: string, opts: { at?: string | Date } = {}): SlotResolution {
    return this.s.resolve(about, predicate, at(opts.at));
  }

  /** Slots whose candidate facts disagree, or that a reviewer must settle. */
  conflicts(opts: { at?: string | Date } = {}): SlotResolution[] {
    const when = at(opts.at);
    return this.s
      .slotKeys()
      .map(({ about, predicate }) => this.s.resolve(about, predicate, when))
      .filter((r) => r.conflict || r.status === "unresolved")
      .sort((a, b) => `${a.about}|${a.predicate}`.localeCompare(`${b.about}|${b.predicate}`));
  }
}

export class SnapshotView {
  constructor(private g: GraphView) {}
  /** The entity as it stood in the world at valid time `atTime`, given what is known in this state. */
  entityAt(id: string, atTime: string | Date): Entity | undefined {
    return this.g.entity(id, atTime);
  }
}

export class TimelineView {
  constructor(
    private events: readonly WorldEvent[],
    private sub: (fn: (e: WorldEvent) => void) => () => void,
  ) {}
  get(): WorldEvent[] {
    return [...this.events];
  }
  subscribe(fn: (e: WorldEvent) => void): () => void {
    return this.sub(fn);
  }
}
