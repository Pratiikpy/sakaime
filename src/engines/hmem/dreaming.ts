import { cosine, jaccard } from "./lexical.ts";
import { classifyDomain } from "./enrich.ts";
import { scopeKey } from "./scope.ts";
import type { MemoryStore } from "./store.ts";
import { DEFAULTS, HMemError, type MemoryRecord } from "./types.ts";

export type DreamType = "insight" | "domain" | "invariant";

export interface DreamProposal {
  id: string;
  type: DreamType;
  content: string;
  derivedFrom: string[];
  suggestedDomain?: string;
  status: "proposed" | "approved" | "rejected";
  /** How well the cluster holds together, scaled by the trust of its members. Not a probability. */
  confidence: number;
  organizationId?: string;
  caseId?: string;
  origin: "deterministic" | "model";
  proposedAt: number;
  decidedBy?: string;
  decidedAt?: number;
  /** The memory created by approval. */
  createdRecord?: string;
}

type Draft = Omit<DreamProposal, "id" | "status" | "proposedAt">;

export type Proposer = (members: MemoryRecord[], draft: { type: DreamType; content: string }) => Promise<string | undefined>;

/**
 * Dreaming proposes consolidated records from clusters of related ones. Nothing it produces is
 * stored as memory until a reviewer approves it; approval, rejection and the original proposal are
 * ledgered, and a rejected proposal is not proposed again. Differences from the reference, each
 * tested: clusters never cross an organization or case; review-tagged, superseded and already
 * derived records are not inputs; proposals are persisted (the reference keeps them in memory);
 * they carry a confidence; approval can require a named reviewer; the approved record inherits the
 * proposal's scope; and an optional model hook can write the text of a proposal, with the
 * deterministic text as the fallback.
 */
export class Dreaming {
  private items = new Map<string, DreamProposal>();

  constructor(private store: MemoryStore, private requireReviewer: boolean) {
    this.load();
    store.hooks.reloaded.push(() => this.load());
  }

  private load(): void {
    this.items = new Map(this.store.db.loadAll<DreamProposal>("proposals").map((p) => [p.id, p]));
  }

  private save(p: DreamProposal): void {
    this.items.set(p.id, p);
    this.store.db.save("proposals", p.id, p);
  }

  list(): DreamProposal[] {
    return [...this.items.values()];
  }

  pending(): DreamProposal[] {
    return this.list().filter((p) => p.status === "proposed");
  }

  /* ------------------------------------------------------------------ proposing */

  private eligible(): MemoryRecord[] {
    return this.store.all().filter((m) => !m.supersededBy && !(m.derivedFrom?.length) && !m.tags.includes("review") && !m.tags.includes("wrong"));
  }

  private relatedness(a: MemoryRecord, b: MemoryRecord): number {
    return 0.5 * Math.max(0, cosine(a.embedding, b.embedding)) + 0.2 * jaccard(a.tags, b.tags) + 0.1 * (a.domain === b.domain ? 1 : 0) + 0.2 * jaccard(a.entities, b.entities);
  }

  private draftConfidence(members: MemoryRecord[], cohesion: number): number {
    const trust = members.reduce((s, m) => s + m.confidence, 0) / members.length;
    return Math.round(Math.min(1, cohesion) * trust * 100) / 100;
  }

  private scopeOf(members: MemoryRecord[]): Pick<Draft, "organizationId" | "caseId"> {
    const first = members[0]!;
    return { ...(first.organizationId ? { organizationId: first.organizationId } : {}), ...(first.caseId ? { caseId: first.caseId } : {}) };
  }

  private plan(): Draft[] {
    const drafts: Draft[] = [];
    const pool = this.eligible();
    const groups = new Map<string, MemoryRecord[]>();
    for (const m of pool) {
      const list = groups.get(scopeKey(m)) ?? [];
      list.push(m);
      groups.set(scopeKey(m), list);
    }

    let insights = 0;
    let domains = 0;
    let invariants = 0;
    for (const members of groups.values()) {
      const used = new Set<string>();
      for (const seed of members) {
        if (used.has(seed.id) || insights >= DEFAULTS.maxDreamProposalsPerType) continue;
        const cluster = [seed, ...members.filter((o) => o.id !== seed.id && !used.has(o.id) && this.relatedness(seed, o) >= DEFAULTS.dreamRelatedness)];
        if (cluster.length < DEFAULTS.dreamClusterMinSize) continue;
        for (const c of cluster) used.add(c.id);
        const cohesion = cluster.slice(1).reduce((s, o) => s + this.relatedness(seed, o), 0) / (cluster.length - 1);
        const unique = [...new Set(cluster.map((m) => m.content.trim()))];
        drafts.push({
          type: "insight",
          content: unique.length === 1 ? unique[0]! : `Across ${cluster.length} related records (${[...new Set(cluster.map((m) => m.domain))].join("/")}): ${unique.join(" + ")}`,
          derivedFrom: cluster.map((m) => m.id),
          confidence: this.draftConfidence(cluster, cohesion),
          origin: "deterministic",
          ...this.scopeOf(cluster),
        });
        insights++;
      }

      for (const m of members) {
        if (domains >= DEFAULTS.maxDreamProposalsPerType) break;
        if (m.domain !== "general") continue;
        const suggested = classifyDomain(this.store.vocabulary, m.content, m.tags, m.type);
        if (suggested !== "general") {
          drafts.push({ type: "domain", content: `Reclassify "${m.content.slice(0, 60)}" as ${suggested}`, derivedFrom: [m.id], suggestedDomain: suggested, confidence: 0.5, origin: "deterministic", ...this.scopeOf([m]) });
          domains++;
        }
      }

      const byDomain = new Map<string, MemoryRecord[]>();
      for (const m of members.filter((x) => x.type === "preference" || x.type === "personal" || x.tags.includes("event:user_correction"))) {
        const list = byDomain.get(m.domain) ?? [];
        list.push(m);
        byDomain.set(m.domain, list);
      }
      for (const [domain, list] of byDomain) {
        if (invariants >= DEFAULTS.maxDreamProposalsPerType) break;
        if (list.length < 2) continue;
        drafts.push({ type: "invariant", content: `Stable pattern in ${domain}: ${list.map((m) => m.content).join("; ")}`, derivedFrom: list.map((m) => m.id), confidence: this.draftConfidence(list, 0.6), origin: "deterministic", ...this.scopeOf(list) });
        invariants++;
      }
    }
    // A pair already proposed, whatever became of it, is not proposed again.
    const seen = new Set(this.list().map((p) => `${p.type}|${[...p.derivedFrom].sort().join(",")}`));
    return drafts.filter((d) => !seen.has(`${d.type}|${[...d.derivedFrom].sort().join(",")}`));
  }

  private commit(drafts: Draft[]): DreamProposal[] {
    return this.store.run(() =>
      drafts.map((d) => {
        const p: DreamProposal = { ...d, id: `dream-${this.store.db.next("dream")}`, status: "proposed", proposedAt: this.store.clock() };
        this.save(p);
        this.store.log(p.id, "dream_proposed", { details: { type: p.type, derivedFrom: p.derivedFrom, confidence: p.confidence, origin: p.origin } });
        return p;
      }),
    );
  }

  dream(): DreamProposal[] {
    return this.commit(this.plan());
  }

  /** As `dream`, with a model writing the text of insight and invariant proposals; any failure keeps the deterministic text. */
  async dreamWithModel(proposer: Proposer): Promise<DreamProposal[]> {
    const drafts = this.plan();
    for (const d of drafts) {
      if (d.type === "domain") continue;
      const members = d.derivedFrom.map((id) => this.store.get(id)).filter((m): m is MemoryRecord => !!m);
      try {
        const text = await proposer(members, { type: d.type, content: d.content });
        if (typeof text === "string" && text.trim().length >= 10 && text.length <= 600) {
          d.content = text.trim();
          d.origin = "model";
        }
      } catch {
        // The deterministic text stands; a proposer that is down must not stop dreaming.
      }
    }
    return this.commit(drafts);
  }

  /* ------------------------------------------------------------------ decisions */

  private reviewer(by: string | undefined): string | undefined {
    if (this.requireReviewer && (typeof by !== "string" || by.trim() === "")) throw new HMemError("REVIEWER_REQUIRED", "approving or rejecting a proposal needs a named reviewer");
    return by;
  }

  approve(proposalId: string, by?: string, opts: { idempotencyKey?: string } = {}): MemoryRecord | undefined {
    const reviewer = this.reviewer(by);
    return this.store.run(() =>
      this.store.once(
        opts.idempotencyKey,
        "dream.approve",
        { proposalId, by },
        () => {
          const p = this.items.get(proposalId);
          if (!p || p.status !== "proposed") throw new HMemError("NOT_FOUND", `no pending proposal ${proposalId}`);
          const now = this.store.clock();
          let created: MemoryRecord | undefined;
          if (p.type === "domain") {
            for (const id of p.derivedFrom) {
              if (this.store.get(id) && p.suggestedDomain) this.store.update(id, { domain: p.suggestedDomain }, { reason: "dream domain proposal approved", proposal: p.id }, "update", reviewer);
            }
          } else {
            created = this.store.add({
              content: p.content,
              source: "dreaming",
              type: p.type === "insight" ? "factual" : "preference",
              layer: "long_term",
              tags: [`dream:${p.type}`],
              confidence: 0.75,
              kind: "precedent",
              derivedFrom: p.derivedFrom,
              provenance: { origin: "dream", learnedAt: now, label: `approved ${p.type} proposal`, refs: [p.id], ...(reviewer ? { reviewer } : {}) },
              ...(p.organizationId ? { organizationId: p.organizationId } : {}),
              ...(p.caseId ? { caseId: p.caseId } : {}),
              ...(reviewer ? { actor: reviewer } : {}),
            });
          }
          const next: DreamProposal = { ...p, status: "approved", decidedAt: now, ...(reviewer ? { decidedBy: reviewer } : {}), ...(created ? { createdRecord: created.id } : {}) };
          this.save(next);
          this.store.log(p.id, "dream_approved", { details: { type: p.type, ...(created ? { createdRecord: created.id } : {}) } }, reviewer);
          return created;
        },
        (r) => ({ id: r?.id ?? null }),
        (saved) => (saved.id ? this.store.get(saved.id) : undefined),
      ),
    );
  }

  reject(proposalId: string, by?: string, reason?: string): void {
    const reviewer = this.reviewer(by);
    this.store.run(() => {
      const p = this.items.get(proposalId);
      if (!p || p.status !== "proposed") throw new HMemError("NOT_FOUND", `no pending proposal ${proposalId}`);
      this.save({ ...p, status: "rejected", decidedAt: this.store.clock(), ...(reviewer ? { decidedBy: reviewer } : {}) });
      this.store.log(p.id, "dream_rejected", { details: { type: p.type, ...(reason ? { reason } : {}) } }, reviewer);
    });
  }
}
