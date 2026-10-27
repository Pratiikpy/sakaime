import { cosine } from "./lexical.ts";
import { comparable } from "./scope.ts";
import type { MemoryStore } from "./store.ts";
import { DAY_MS, DEFAULTS, DEFAULT_TIER_CONFIDENCE, HMemError, type MemoryRecord, clamp01 } from "./types.ts";

export type ConflictKind = "contradiction" | "supersession_candidate";
export type Resolution = "keep_a" | "keep_b" | "keep_both" | "merge" | "delete_both";

export interface ConflictRecord {
  id: string;
  /** For a supersession candidate, `memoryA` is the older record and `memoryB` the newer. */
  memoryA: string;
  memoryB: string;
  kind: ConflictKind;
  reason: string;
  confidence: number;
  resolved: boolean;
  resolution?: Resolution;
  resolvedBy?: string;
  /** Set when an auto-decision was attempted and fell below the gate. */
  decisionConfidence?: number;
}

export interface Assessment {
  winnerId: string;
  loserId: string;
  scoreA: number;
  scoreB: number;
  margin: number;
  decisionConfidence: number;
}

const OPPOSING: [RegExp, RegExp][] = [
  [/\balways\b/i, /\bnever\b/i],
  [/\benable[ds]?\b/i, /\bdisable[ds]?\b/i],
  [/\bprefer(?:s|red)?\b/i, /\b(?:avoid(?:s|ed)?|dislike[sd]?)\b/i],
  [/\brequire[sd]?\b/i, /\b(?:waive[sd]?|exempt(?:s|ed)?|no longer require[sd]?|does not require|do not require|not required)\b/i],
  [/\ballow(?:s|ed)?\b/i, /\b(?:prohibit(?:s|ed)?|forbid(?:s|den)?|disallow(?:s|ed)?)\b/i],
  [/\baccept(?:s|ed)?\b/i, /\breject(?:s|ed)?\b/i],
  [/\bon\b/i, /\boff\b/i],
  [/\byes\b/i, /\bno\b/i],
];

/**
 * Conflict detection and resolution. Differences from the reference, each tested: re-scanning does
 * not append duplicates; the open queue and its decisions survive a restart; pairs from different
 * organizations are never compared; every resolution strategy the specification lists exists;
 * a manual resolution names a reviewer; and the recency signal is a real decay (the reference's
 * is `lastAccessed / now`, which is about 1 for every record).
 *
 * Auto-resolution happens only at decision confidence of 0.70 or more. Below that the conflict
 * stays in the queue for a person and both records are untouched. The losing record is marked
 * `supersededBy` and kept; nothing is deleted by an automatic decision.
 */
export class Conflicts {
  private items = new Map<string, ConflictRecord>();

  constructor(private store: MemoryStore) {
    this.load();
    store.hooks.reloaded.push(() => this.load());
    store.hooks.supersessionCandidate = (newer, older, similarity) => this.raiseCandidate(newer, older, similarity);
  }

  private load(): void {
    this.items = new Map(this.store.db.loadAll<ConflictRecord>("conflicts").map((c) => [c.id, c]));
  }

  private save(c: ConflictRecord): void {
    this.items.set(c.id, c);
    this.store.db.save("conflicts", c.id, c);
  }

  private pairKey(a: string, b: string): string {
    return [a, b].sort().join("|");
  }

  private known(a: string, b: string): boolean {
    const key = this.pairKey(a, b);
    for (const c of this.items.values()) if (this.pairKey(c.memoryA, c.memoryB) === key) return true;
    return false;
  }

  list(filter: { open?: boolean } = {}): ConflictRecord[] {
    return [...this.items.values()].filter((c) => filter.open === undefined || c.resolved !== filter.open);
  }

  /** Conflicts still waiting for a decision (a conflict whose records were removed by a restore is not waiting). */
  queue(): ConflictRecord[] {
    return this.list({ open: true }).filter((c) => this.store.get(c.memoryA) && this.store.get(c.memoryB));
  }

  get(id: string): ConflictRecord | undefined {
    return this.items.get(id);
  }

  /** Finds pairs not seen before and records them. Returns only the new ones. */
  scan(): ConflictRecord[] {
    return this.store.run(() => {
      const found: ConflictRecord[] = [];
      const all = this.store.all();
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const a = all[i]!;
          const b = all[j]!;
          if (this.known(a.id, b.id)) continue;
          const c = this.check(a, b);
          if (!c) continue;
          this.save(c);
          found.push(c);
          this.store.log(c.memoryA, "conflict_detected", { details: { conflictId: c.id, with: c.memoryB, reason: c.reason, confidence: c.confidence } });
        }
      }
      return found;
    });
  }

  private check(a: MemoryRecord, b: MemoryRecord): ConflictRecord | undefined {
    if (!comparable(a, b)) return undefined;
    // A declared replacement, or a pair already settled by supersession, is not a conflict.
    if (a.supersedes === b.id || b.supersedes === a.id || a.supersededBy === b.id || b.supersededBy === a.id) return undefined;
    if (a.supersededBy || b.supersededBy) return undefined;
    const sim = cosine(a.embedding, b.embedding);
    let reason = "";
    let confidence = 0;
    for (const [p, q] of OPPOSING) {
      if (((p.test(a.content) && q.test(b.content)) || (q.test(a.content) && p.test(b.content))) && sim > 0.5) {
        reason = "opposing phrase pair on similar content";
        confidence = 0.5 + 0.3 * sim;
        break;
      }
    }
    if (!reason && sim > 0.8) {
      const na = a.content.match(/\d+(?:\.\d+)?/g) ?? [];
      const nb = b.content.match(/\d+(?:\.\d+)?/g) ?? [];
      if (na.length && nb.length && na.join() !== nb.join()) {
        reason = "high-similarity conflicting numeric values";
        confidence = 0.55 + 0.25 * sim;
      }
    }
    if (!reason) return undefined;
    if (a.entities.some((e) => b.entities.includes(e))) confidence += 0.1;
    if (a.domain === b.domain) confidence += 0.05;
    if (a.relatedTo.includes(b.id)) confidence -= 0.1;
    return { id: `conflict-${this.store.db.next("conflict")}`, memoryA: a.id, memoryB: b.id, kind: "contradiction", reason, confidence: clamp01(confidence), resolved: false };
  }

  private raiseCandidate(newer: MemoryRecord, older: MemoryRecord, similarity: number): void {
    if (this.known(older.id, newer.id)) return;
    const c: ConflictRecord = {
      id: `conflict-${this.store.db.next("conflict")}`,
      memoryA: older.id,
      memoryB: newer.id,
      kind: "supersession_candidate",
      reason: `the new record reads as a correction of ${older.id} (similarity ${similarity.toFixed(2)}); a reviewer decides whether it replaces it`,
      confidence: clamp01(similarity),
      resolved: false,
    };
    this.save(c);
    this.store.log(older.id, "conflict_detected", { details: { conflictId: c.id, with: newer.id, reason: c.reason, confidence: c.confidence, kind: c.kind } });
  }

  /* ------------------------------------------------------------------ auto-decision */

  private authority(m: MemoryRecord): number {
    if (m.provenance.origin === "user_correction") return 1;
    const tier = m.provenance.tier;
    return tier ? DEFAULT_TIER_CONFIDENCE[tier] : 0.5;
  }

  private strength(m: MemoryRecord): number {
    const ageDays = Math.max(0, this.store.clock() - m.lastAccessed) / DAY_MS;
    return (
      0.3 * this.authority(m) + // authority before recency: a regulator record outweighs a newer vendor one
      0.15 * Math.exp(-ageDays / DEFAULTS.recencyDays) +
      0.15 * Math.min(1, m.accessCount / 10) +
      0.25 * m.confidence +
      0.05 * Math.min(1, m.content.length / 200)
    );
  }

  /** Who would win and how sure the heuristic is. Pure: no state is changed. */
  assess(conflict: ConflictRecord): Assessment {
    const a = this.store.must(conflict.memoryA);
    const b = this.store.must(conflict.memoryB);
    const sa = this.strength(a);
    const sb = this.strength(b);
    const margin = Math.abs(sa - sb) / Math.max(sa, sb, 1e-9);
    const decisionConfidence = clamp01(conflict.confidence * 0.6 + margin * 0.8);
    const aWins = sa >= sb;
    return { winnerId: aWins ? a.id : b.id, loserId: aWins ? b.id : a.id, scoreA: sa, scoreB: sb, margin, decisionConfidence };
  }

  autoResolve(conflict: ConflictRecord, opts: { gate?: number } = {}): "resolved" | "queued" {
    return this.store.run(() => {
      const current = this.items.get(conflict.id) ?? conflict;
      if (current.resolved) return "resolved";
      const gate = opts.gate ?? DEFAULTS.conflictAutoResolveGate;
      const a = this.assess(current);
      current.decisionConfidence = Number(a.decisionConfidence.toFixed(3));
      if (a.decisionConfidence < gate) {
        this.save(current);
        return "queued";
      }
      // A supersession candidate is resolved in the newer record's favour only by a person.
      if (current.kind === "supersession_candidate") {
        this.save(current);
        return "queued";
      }
      this.settle(current, a.winnerId === current.memoryA ? "keep_a" : "keep_b", "auto", { decisionConfidence: current.decisionConfidence });
      return "resolved";
    });
  }

  /** Scans, then auto-resolves what is clear enough; returns what is left for a reviewer. */
  triage(): ConflictRecord[] {
    for (const c of this.scan()) this.autoResolve(c);
    return this.queue();
  }

  /* ------------------------------------------------------------------ manual resolution */

  resolve(conflictId: string, strategy: Resolution, opts: { by: string; note?: string; idempotencyKey?: string }): void {
    if (typeof opts?.by !== "string" || opts.by.trim() === "") throw new HMemError("REVIEWER_REQUIRED", "resolving a conflict by hand needs a named reviewer");
    this.store.run(() =>
      this.store.once(
        opts.idempotencyKey,
        "resolveConflict",
        { conflictId, strategy, by: opts.by },
        () => {
          const c = this.items.get(conflictId);
          if (!c) throw new HMemError("NOT_FOUND", `no conflict ${conflictId}`);
          if (c.resolved) throw new HMemError("INVALID_INPUT", `conflict ${conflictId} is already resolved`);
          this.settle(c, strategy, opts.by, opts.note ? { note: opts.note } : {});
        },
        () => ({}),
        () => undefined,
      ),
    );
  }

  private settle(c: ConflictRecord, strategy: Resolution, by: string, details: Record<string, unknown>): void {
    const a = this.store.must(c.memoryA);
    const b = this.store.must(c.memoryB);
    const supersede = (loser: MemoryRecord, winner: MemoryRecord) => {
      this.store.update(loser.id, { supersededBy: winner.id }, { conflictId: c.id, winner: winner.id, strategy, ...details }, "conflict_resolved", by);
    };
    switch (strategy) {
      case "keep_a":
        supersede(b, a);
        break;
      case "keep_b":
        supersede(a, b);
        break;
      case "keep_both":
        this.store.log(a.id, "conflict_resolved", { details: { conflictId: c.id, strategy, ...details } }, by);
        this.store.log(b.id, "conflict_resolved", { details: { conflictId: c.id, strategy, ...details } }, by);
        break;
      case "merge": {
        const merged = this.store.add({
          content: `${a.content} | ${b.content}`,
          source: `merge:${c.id}`,
          type: a.type,
          layer: a.layer === "long_term" || b.layer === "long_term" ? "long_term" : "working",
          confidence: Math.min(a.confidence, b.confidence),
          derivedFrom: [a.id, b.id],
          ...(a.organizationId ? { organizationId: a.organizationId } : {}),
          ...(a.caseId ? { caseId: a.caseId } : {}),
          provenance: { origin: "reviewer", learnedAt: this.store.clock(), label: `merged by ${by} to resolve ${c.id}`, reviewer: by },
          actor: by,
        });
        for (const m of [a, b]) this.store.update(m.id, { supersededBy: merged.id }, { conflictId: c.id, strategy, mergedInto: merged.id, ...details }, "conflict_resolved", by);
        break;
      }
      case "delete_both":
        for (const m of [a, b]) this.store.remove(m.id, "delete", { conflictId: c.id, strategy, reason: "reviewer deleted both sides of a conflict", ...details }, by);
        break;
      default:
        throw new HMemError("INVALID_INPUT", `unknown strategy ${String(strategy)}`);
    }
    c.resolved = true;
    c.resolution = strategy;
    c.resolvedBy = by;
    this.save(c);
  }
}
