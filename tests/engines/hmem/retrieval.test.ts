import { describe, expect, it } from "vitest";
import { type Embedder, HMEM, cosine, embed } from "../../../src/engines/hmem/index.ts";
import { DAY, T0, actions, manualClock, memory, rm, tempDir } from "./helpers.ts";

const LAYER = { long_term: 1, working: 0.8, short_term: 0.6 } as const;

describe("the ranking formula, term by term", () => {
  it("matches the hand-computed score for a known record to 1e-9", () => {
    const { hmem } = memory();
    const m = hmem.add({ content: "deploy window monday", source: "t", confidence: 0.8, layer: "working" });
    const b = hmem.retrieval.explain(m.id, "deploy window");
    const semantic = cosine(embed("deploy window"), embed("deploy window monday"));
    const raw = 0.35 * semantic + 0.2 * (2 / 3) + 0.1 * 0 + 0.1 * 1 + 0.15 * 0 + 0.05 * LAYER.working + 0.05 * 1 - 0;
    expect(b.keyword).toBeCloseTo(2 / 3, 12);
    expect(b.domain).toBe(1);
    expect(b.raw).toBeCloseTo(raw, 12);
    expect(b.score).toBeCloseTo(raw * 0.8, 12);
    expect(hmem.query("deploy window", { touch: false }).trace.scores[m.id]).toBeCloseTo(raw * 0.8, 4);
  });

  it("layer weights are 1.0, 0.8 and 0.6", () => {
    const { hmem } = memory();
    const recs = (["long_term", "working", "short_term"] as const).map((layer) => hmem.add({ content: "the review board meets weekly", source: "t", layer }));
    const [lt, wk, st] = recs.map((r) => hmem.retrieval.explain(r.id, "review board").raw) as [number, number, number];
    expect(lt - wk).toBeCloseTo(0.05 * 0.2, 12);
    expect(wk - st).toBeCloseTo(0.05 * 0.2, 12);
  });

  it("recency decays exponentially on lastAccessed with a 14-day constant", () => {
    const { hmem, time } = memory();
    const m = hmem.add({ content: "the review board meets weekly", source: "t" });
    time.advanceDays(14);
    expect(hmem.retrieval.explain(m.id, "review board").recency).toBeCloseTo(Math.exp(-1), 12);
    time.advanceDays(14);
    expect(hmem.retrieval.explain(m.id, "review board").recency).toBeCloseTo(Math.exp(-2), 12);
  });

  it("a superseded record is penalised by 0.20 and never filtered out", () => {
    const { hmem } = memory();
    const old = hmem.add({ content: "the review board meets on fridays", source: "t", confidence: 0.9 });
    const fresh = hmem.add({ content: "the review board meets on mondays", source: "t", confidence: 0.9, supersedes: old.id });
    expect(old.supersededBy).toBe(fresh.id);
    const a = hmem.retrieval.explain(old.id, "review board meets");
    expect(a.superseded).toBe(1);
    expect(a.raw).toBeCloseTo(a.semantic * 0.35 + a.keyword * 0.2 + a.tag * 0.1 + a.domain * 0.1 + a.entity * 0.15 + a.layer * 0.05 + a.recency * 0.05 - 0.2, 12);
    const ids = hmem.query("review board meets", { threshold: 0, touch: false }).memories.map((x) => x.memory.id);
    expect(ids).toEqual([fresh.id, old.id]);
  });

  it("confidence multiplies the whole score, so feedback moves the ranking", () => {
    const { hmem } = memory();
    const a = hmem.add({ content: "the deploy window is monday morning", source: "t", confidence: 0.7 });
    const b = hmem.add({ content: "the deploy window is monday morning", source: "t", confidence: 0.7 });
    hmem.feedback(a.id, "wrong");
    hmem.retrieval.clearReview(a.id, "r");
    const ranked = hmem.query("deploy window", { threshold: 0, touch: false }).memories.map((x) => x.memory.id);
    expect(ranked).toEqual([b.id, a.id]);
  });

  it("defaults: threshold 0.35 on the final score and top 5", () => {
    const { hmem } = memory();
    for (let i = 0; i < 8; i++) hmem.add({ content: `the deploy window is monday morning number ${i}`, source: "t", confidence: 0.95, layer: "long_term" });
    hmem.add({ content: "completely unrelated gardening advice", source: "t" });
    const r = hmem.query("deploy window monday morning", { touch: false });
    expect(r.memories).toHaveLength(5);
    expect(r.memories.every((x) => x.relevance >= 0.35)).toBe(true);
    expect(hmem.query("deploy window monday morning", { touch: false, topN: 8 }).memories).toHaveLength(8);
    expect(hmem.query("zebra quantum", { touch: false }).memories).toHaveLength(0);
  });

  it("ties are broken by id in numeric order, so ranking is deterministic", () => {
    const { hmem } = memory();
    const ids = Array.from({ length: 11 }, () => hmem.add({ content: "identical words here", source: "t" }).id);
    const ranked = hmem.query("identical words", { threshold: 0, topN: 11, touch: false }).memories.map((x) => x.memory.id);
    expect(ranked).toEqual(ids);
  });
});

describe("a query is a read unless it says otherwise", () => {
  it("touching records counts the access and ledgers a read; touch:false changes nothing", () => {
    const { hmem, time } = memory();
    const m = hmem.add({ content: "the review board meets weekly", source: "t" });
    time.advanceDays(3);
    const ledger = hmem.ledger.all().length;
    hmem.query("review board", { touch: false });
    expect(m.accessCount).toBe(0);
    expect(hmem.ledger.all()).toHaveLength(ledger);
    const r = hmem.query("review board", { threshold: 0 });
    expect(m.accessCount).toBe(1);
    expect(m.lastAccessed).toBe(T0 + 3 * DAY);
    expect(actions(hmem, m.id)).toEqual(["create", "read"]);
    expect(hmem.ledger.history(m.id)[1]!.details).toMatchObject({ query: "review board", traceId: r.trace.traceId });
  });

  it("an empty or non-string query is refused rather than returning an empty result", () => {
    const { hmem } = memory();
    expect(() => hmem.query("")).toThrowError(/needs text/);
    expect(() => hmem.query("   ")).toThrowError(/needs text/);
    expect(() => hmem.query(undefined as never)).toThrowError(/needs text/);
  });

  it("the trace names the weight profile, strategy, scores, domain and entities", () => {
    const { hmem } = memory();
    const m = hmem.add({ content: "Clearance K123456 covers adult chest CT", source: "fda", layer: "long_term", confidence: 0.9 });
    const r = hmem.query("what does K123456 cover", { touch: false, threshold: 0 });
    expect(r.trace).toMatchObject({ weightProfile: "canonical-8-signal@1", semanticSource: "lexical-hash", strategy: "minimal" });
    expect(r.trace.queryEntities).toContain("k123456");
    expect(r.trace.scores[m.id]).toBeGreaterThan(0.35);
    expect(r.trace.traceId).toMatch(/^trace_[0-9a-f]{12}$/);
  });
});

describe("scoping: one organization's precedent never appears in another's case", () => {
  function twoOrgs() {
    const { hmem } = memory();
    const a = hmem.add({ content: "Triage tools require prospective validation before use", source: "policy-a", organizationId: "hospital-a", kind: "precedent", sourceTier: "reviewer", layer: "long_term" });
    const b = hmem.add({ content: "Triage tools require prospective validation before use", source: "policy-b", organizationId: "hospital-b", kind: "precedent", sourceTier: "reviewer", layer: "long_term" });
    const open = hmem.add({ content: "Triage tools are intended to prioritise worklists", source: "fda", sourceTier: "regulator", layer: "long_term" });
    return { hmem, a, b, open };
  }
  const ids = (r: ReturnType<HMEM["query"]>) => r.memories.map((m) => m.memory.id).sort();

  it("a query for organization A sees A's records and unscoped ones, never B's", () => {
    const { hmem, a, b, open } = twoOrgs();
    const r = hmem.query("triage tools prospective validation", { organizationId: "hospital-a", touch: false, threshold: 0 });
    expect(ids(r)).toEqual([a.id, open.id].sort());
    expect(ids(r)).not.toContain(b.id);
    expect(ids(hmem.query("triage tools prospective validation", { organizationId: "hospital-b", touch: false, threshold: 0 }))).toEqual([b.id, open.id].sort());
  });

  it("a query that names no organization sees no organization's records", () => {
    const { hmem, open } = twoOrgs();
    expect(ids(hmem.query("triage tools prospective validation", { touch: false, threshold: 0 }))).toEqual([open.id]);
    expect(ids(hmem.query("triage tools prospective validation", { organizationId: "hospital-c", touch: false, threshold: 0 }))).toEqual([open.id]);
  });

  it("the same holds on the asynchronous path and for the prompt text", async () => {
    const { hmem } = twoOrgs();
    const r = await hmem.queryAsync("triage tools prospective validation", { organizationId: "hospital-b", touch: false, threshold: 0 });
    expect(r.memories.every((m) => m.memory.organizationId !== "hospital-a")).toBe(true);
    expect(r.context).not.toContain("source=policy-a");
    expect(r.context).toContain("institutional precedent, not general guidance");
  });

  it("a case-scoped record is visible only to that case", () => {
    const { hmem } = memory();
    const c1 = hmem.add({ content: "Case one note about the reader study", source: "t", organizationId: "h", caseId: "case-1" });
    const org = hmem.add({ content: "Organization note about the reader study", source: "t", organizationId: "h" });
    const seen = (caseId?: string) => hmem.query("note about the reader study", { organizationId: "h", ...(caseId ? { caseId } : {}), touch: false, threshold: 0 }).memories.map((m) => m.memory.id).sort();
    expect(seen("case-1")).toEqual([c1.id, org.id].sort());
    expect(seen("case-2")).toEqual([org.id]);
    expect(seen()).toEqual([org.id]);
  });

  it("chat and goal-run scoping follow the specification, and includeUnscoped can be turned off", () => {
    const { hmem } = memory();
    const chat1 = hmem.add({ content: "scoped note alpha", source: "t", chatId: "c1" });
    const chat2 = hmem.add({ content: "scoped note beta", source: "t", chatId: "c2" });
    const loose = hmem.add({ content: "scoped note gamma", source: "t" });
    const run1 = hmem.add({ content: "scoped note delta", source: "t", goalRunId: "g1" });
    const seen = (o: object) => hmem.query("scoped note", { ...o, touch: false, threshold: 0 }).memories.map((m) => m.memory.id).sort();
    expect(seen({ chatId: "c1" })).toEqual([chat1.id, loose.id, run1.id].sort());
    expect(seen({ chatId: "c1", includeUnscoped: false })).toEqual([chat1.id]);
    expect(seen({ goalRunId: "g1", includeUnscoped: false })).toEqual([run1.id]);
    expect(seen({ goalRunId: "g2" })).toEqual([chat1.id, chat2.id, loose.id].sort());
  });

  it("an organization cannot supersede another organization's record", () => {
    const { hmem, a } = twoOrgs();
    expect(() => hmem.add({ content: "Triage tools never require validation", source: "t", organizationId: "hospital-b", supersedes: a.id })).toThrowError(/different organization/);
    expect(a.supersededBy).toBeUndefined();
  });

  it("records of different organizations are never linked as related", () => {
    const { hmem } = memory();
    const a = hmem.add({ content: "Postgres holds our evidence", source: "t", entities: ["postgres"], organizationId: "a" });
    const b = hmem.add({ content: "Postgres holds our evidence too", source: "t", entities: ["postgres"], organizationId: "b" });
    expect(a.relatedTo).toEqual([]);
    expect(b.relatedTo).toEqual([]);
  });
});

describe("a privacy filter sits between retrieval and the prompt", () => {
  it("masks identifier-shaped text in the context but leaves the stored record alone", () => {
    const { hmem } = memory();
    const m = hmem.add({ content: "Contact reviewer@hospital.example about MRN 8841123 and call 555-123-4567", source: "t", layer: "long_term", confidence: 0.95 });
    const r = hmem.query("contact reviewer about MRN", { touch: false });
    expect(r.context).not.toMatch(/reviewer@hospital\.example|8841123|555-123-4567/);
    expect(r.context).toContain("[REDACTED:email]");
    expect(r.context).toContain("[REDACTED:mrn]");
    expect(r.context).toContain("[REDACTED:phone]");
    expect(r.trace.redactions).toBeGreaterThanOrEqual(3);
    expect(r.memories[0]!.memory.content).toContain("reviewer@hospital.example");
    expect(m.content).toContain("8841123");
  });

  it("omits records tagged private, secret, pii, health, financial or work-confidential from the prompt, and says so", () => {
    const { hmem } = memory();
    const ok = hmem.add({ content: "Shared note about the vendor submission", source: "t", layer: "long_term", confidence: 0.95 });
    const hidden = ["private", "secret", "pii", "health", "financial", "work-confidential"].map((tag) => hmem.add({ content: `Sensitive note about the vendor submission ${tag}`, source: "t", layer: "long_term", confidence: 0.95, tags: [tag] }));
    const r = hmem.query("note about the vendor submission", { touch: false, threshold: 0, topN: 10 });
    expect(r.memories).toHaveLength(7);
    expect(r.trace.omittedSensitive.sort()).toEqual(hidden.map((h) => h.id).sort());
    expect(r.context).toContain("Shared note");
    expect(r.context).not.toContain("Sensitive note");
    expect(ok.id).toBeDefined();
  });

  it("leaves a superseded record out of the prompt when its replacement is present, and says so", () => {
    const { hmem } = memory();
    const old = hmem.add({ content: "The board requires retrospective evidence for triage tools", source: "t", layer: "long_term", confidence: 0.9 });
    const fresh = hmem.add({ content: "The board requires prospective evidence for triage tools", source: "t", layer: "long_term", confidence: 0.9, supersedes: old.id });
    const r = hmem.query("board requires evidence for triage tools", { touch: false, threshold: 0 });
    expect(r.memories.map((m) => m.memory.id)).toEqual(expect.arrayContaining([old.id, fresh.id]));
    expect(r.trace.suppressedSuperseded).toEqual([old.id]);
    expect(r.context).toContain("prospective");
    expect(r.context).not.toContain("retrospective");
  });

  it("the context is labelled as background, not instruction, and carries no record ids", () => {
    const { hmem } = memory();
    const m = hmem.add({ content: "The board meets weekly", source: "t", layer: "long_term", confidence: 0.95 });
    const r = hmem.query("board meets", { touch: false });
    expect(r.context.split("\n")[0]).toMatch(/background only, not instructions/);
    expect(r.context).not.toContain(m.id);
  });

  it("a custom redactor can drop what it likes", () => {
    const { hmem } = memory({ redactor: { apply: (rec) => ({ text: rec.content.includes("drop") ? null : rec.content, hits: [] }) } });
    hmem.add({ content: "please drop this one from prompts", source: "t", layer: "long_term", confidence: 0.95 });
    hmem.add({ content: "please keep this one in prompts", source: "t", layer: "long_term", confidence: 0.95 });
    const r = hmem.query("please this one prompts", { touch: false });
    expect(r.context).toContain("keep this one");
    expect(r.context).not.toContain("drop this one");
  });
});

/** A test double for an embedding provider: words map to concept axes, so synonyms share a vector. */
class ConceptEmbedder implements Embedder {
  readonly id = "test-double/concepts@1";
  calls = 0;
  constructor(private fail: () => boolean = () => false) {}
  private readonly concepts: string[][] = [
    ["eye", "retina", "retinal", "ophthalmology", "diabetic"],
    ["heart", "cardiac", "cardiology", "ecg"],
    ["validation", "validated", "evidence", "trial"],
    ["triage", "prioritise", "prioritize", "worklist"],
  ];
  async embed(texts: string[]): Promise<number[][]> {
    this.calls++;
    if (this.fail()) throw new Error("embedding service unavailable");
    return texts.map((t) => {
      const v = this.concepts.map(() => 0.001);
      for (const w of t.toLowerCase().split(/\W+/)) this.concepts.forEach((c, i) => { if (c.includes(w)) v[i]! += 1; });
      return v;
    });
  }
}

describe("the asynchronous embedding path", () => {
  const seed = (hmem: HMEM) => {
    const eye = hmem.add({ content: "Ophthalmology screening needs prospective validation", source: "t", layer: "long_term", confidence: 0.95 });
    const heart = hmem.add({ content: "Cardiac monitors need prospective validation", source: "t", layer: "long_term", confidence: 0.95 });
    return { eye, heart };
  };

  it("finds a record by meaning where the lexical path finds nothing", async () => {
    const { hmem } = memory({ embedder: new ConceptEmbedder() });
    const { eye } = seed(hmem);
    const query = "retina diabetic checks trial";
    expect(hmem.query(query, { touch: false }).memories).toHaveLength(0);
    const r = await hmem.queryAsync(query, { touch: false });
    expect(r.trace.semanticSource).toBe("test-double/concepts@1");
    expect(r.trace.degraded).toBeUndefined();
    expect(r.memories[0]!.memory.id).toBe(eye.id);
    expect(r.memories[0]!.breakdown.semantic).toBeGreaterThan(0.9);
  });

  it("embeds each record once and keeps the vectors across a restart", async () => {
    const dir = tempDir();
    const emb = new ConceptEmbedder();
    const a = new HMEM({ persistDir: dir, clock: () => T0, embedder: emb });
    seed(a);
    await a.queryAsync("retina checks", { touch: false });
    expect(emb.calls).toBe(2); // one call for the records, one for the query
    await a.queryAsync("retina checks", { touch: false });
    expect(emb.calls).toBe(3); // the query only
    a.close();
    const emb2 = new ConceptEmbedder();
    const b = new HMEM({ persistDir: dir, clock: () => T0, embedder: emb2 });
    await b.queryAsync("retina checks", { touch: false });
    expect(emb2.calls).toBe(1);
    expect(await b.backfillEmbeddings()).toBe(0);
    b.close();
    rm(dir);
  });

  it("re-embeds a record whose content changed", async () => {
    const emb = new ConceptEmbedder();
    const { hmem } = memory({ embedder: emb });
    const { eye } = seed(hmem);
    await hmem.backfillEmbeddings();
    hmem.store.update(eye.id, { content: "Cardiac rhythm software needs trial evidence" }, {});
    expect(await hmem.backfillEmbeddings()).toBe(1);
  });

  it("degrades to the lexical answer and says why when the embedder is down; it never reports an empty result as success", async () => {
    let down = false;
    const { hmem } = memory({ embedder: new ConceptEmbedder(() => down) });
    seed(hmem);
    down = true;
    const r = await hmem.queryAsync("prospective validation", { touch: false });
    expect(r.trace.degraded).toMatch(/embedding service unavailable/);
    expect(r.trace.semanticSource).toBe("lexical-hash");
    expect(r.memories.length).toBeGreaterThan(0);
  });

  it("throws instead of degrading when asked to", async () => {
    const { hmem } = memory({ embedder: new ConceptEmbedder(() => true), onEmbedderError: "throw" });
    seed(hmem);
    await expect(hmem.queryAsync("prospective validation")).rejects.toThrow(/embedding service unavailable/);
  });

  it("rejects an embedder that returns the wrong number of vectors, a zero vector or NaN, and degrades", async () => {
    const broken: Embedder[] = [
      { id: "bad/count", embed: async () => [[1, 0]] },
      { id: "bad/zero", embed: async (t) => t.map(() => [0, 0]) },
      { id: "bad/nan", embed: async (t) => t.map(() => [Number.NaN, 1]) },
    ];
    for (const embedder of broken) {
      const { hmem } = memory({ embedder });
      seed(hmem);
      const r = await hmem.queryAsync("prospective validation", { touch: false });
      expect(r.trace.degraded, embedder.id).toMatch(/embedder|unusable|vectors/);
    }
  });

  it("says so when no embedder is configured", async () => {
    const { hmem } = memory();
    seed(hmem);
    const r = await hmem.queryAsync("prospective validation", { touch: false });
    expect(r.trace.degraded).toBe("no embedder is configured");
    await expect(hmem.backfillEmbeddings()).rejects.toThrow(/no embedder/);
  });

  it("applies the same review exclusion and touch rules as the synchronous path", async () => {
    const { hmem } = memory({ embedder: new ConceptEmbedder() });
    const { eye, heart } = seed(hmem);
    hmem.feedback(heart.id, "wrong");
    const r = await hmem.queryAsync("prospective validation", { threshold: 0 });
    expect(r.memories.map((m) => m.memory.id)).toEqual([eye.id]);
    expect(eye.accessCount).toBe(1);
    expect(actions(hmem, eye.id)).toEqual(["create", "read"]);
  });
});

describe("a clock-injected store is deterministic", () => {
  it("two stores given the same operations give the same ranking and scores", () => {
    const run = () => {
      const t = manualClock();
      const hmem = new HMEM({ clock: t.clock });
      for (const c of ["alpha beta gamma", "beta gamma delta", "gamma delta epsilon"]) hmem.add({ content: c, source: "t" });
      return JSON.stringify(hmem.query("beta gamma", { threshold: 0, touch: false }).trace.scores);
    };
    expect(run()).toBe(run());
  });
});
