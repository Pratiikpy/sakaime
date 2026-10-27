import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HMEM, HMemError } from "../../../src/engines/hmem/index.ts";
import { T0, actions, memory, rm, tempDir } from "./helpers.ts";

describe("every record carries provenance", () => {
  it("rejects a record with no source, an empty source or a blank one, and writes nothing", () => {
    const { hmem } = memory();
    for (const source of ["", "   ", undefined as never, 7 as never]) {
      expect(() => hmem.add({ content: "valid content here", source })).toThrowError(/no source/);
    }
    expect(() => hmem.add({ content: "valid content here", source: "" })).toThrowError(HMemError);
    expect(hmem.store.all()).toHaveLength(0);
    expect(hmem.ledger.all()).toHaveLength(0);
  });

  it("rejects junk: empty content, a bad confidence, an unknown type, a case with no organization", () => {
    const { hmem } = memory();
    const ok = { content: "valid content here", source: "test" };
    expect(() => hmem.add({ ...ok, content: "  " })).toThrowError(/content/);
    for (const confidence of [-0.1, 1.1, Number.NaN, Number.POSITIVE_INFINITY, "0.5" as never]) expect(() => hmem.add({ ...ok, confidence })).toThrowError(/confidence/);
    expect(() => hmem.add({ ...ok, type: "rumour" as never })).toThrowError(/type/);
    expect(() => hmem.add({ ...ok, layer: "deep" as never })).toThrowError(/layer/);
    expect(() => hmem.add({ ...ok, caseId: "case-1" })).toThrowError(/organizationId/);
    expect(() => hmem.add({ ...ok, tags: [1] as never })).toThrowError(/tags/);
    expect(() => hmem.add({ ...ok, sourceTier: "oracle" as never })).toThrowError(/tier/);
    expect(hmem.store.all()).toHaveLength(0);
  });

  it("does not dedupe identical content at add time", () => {
    const { hmem } = memory();
    hmem.add({ content: "same words", source: "a" });
    hmem.add({ content: "same words", source: "b" });
    expect(hmem.store.all()).toHaveLength(2);
  });
});

describe("the ledger records every mutation exactly once", () => {
  it("create then feedback gives exactly two entries, with before and after confidence", () => {
    const { hmem } = memory();
    const m = hmem.add({ content: "audited record", confidence: 0.7, source: "test" });
    hmem.feedback(m.id, "wrong");
    const h = hmem.ledger.history(m.id);
    expect(h.map((e) => e.action)).toEqual(["create", "feedback"]);
    expect(h[1]).toMatchObject({ previousState: { confidence: 0.7 }, newState: { confidence: 0.5 }, details: { kind: "wrong", delta: -0.2 } });
    expect(h[0]!.newState).not.toHaveProperty("embedding");
  });

  it("a relatedTo backlink written to another record is ledgered on that record", () => {
    const { hmem } = memory();
    const a = hmem.add({ content: "Postgres holds the registry data", source: "t", entities: ["postgres"], tags: ["tech:db"] });
    const b = hmem.add({ content: "We run Postgres on managed hosting", source: "t", entities: ["postgres"], tags: ["tech:db"] });
    expect(b.relatedTo).toEqual([a.id]);
    expect(a.relatedTo).toEqual([b.id]);
    const entry = hmem.ledger.history(a.id).find((e) => e.action === "update");
    expect(entry?.details).toMatchObject({ reason: "relatedTo backlink", from: b.id });
    expect(entry?.previousState?.relatedTo).toEqual([]);
    expect(entry?.newState?.relatedTo).toEqual([b.id]);
  });

  it("a change made to a record object outside the API is ledgered at the next operation, by actor external", () => {
    const { hmem } = memory();
    const a = hmem.add({ content: "first record", source: "t" });
    const b = hmem.add({ content: "second record", source: "t" });
    a.supersededBy = b.id;
    a.confidence = 0.1;
    expect(actions(hmem, a.id)).toEqual(["create", "update"]);
    const entry = hmem.ledger.history(a.id).at(-1)!;
    expect(entry.actor).toBe("external");
    expect(entry.previousState?.confidence).toBe(0.7);
    expect(entry.newState).toMatchObject({ confidence: 0.1, supersededBy: b.id });
    // Noticed once, not again.
    hmem.query("record");
    expect(actions(hmem, a.id).filter((x) => x === "update")).toHaveLength(1);
  });

  it("the ledger is append-only: the database refuses to update or delete entries", () => {
    const dir = tempDir();
    const hmem = new HMEM({ persistDir: dir, clock: () => T0 });
    hmem.add({ content: "persisted record", source: "t" });
    hmem.close();
    const raw = new DatabaseSync(path.join(dir, "hmem.sqlite"));
    expect(() => raw.exec("UPDATE ledger SET actor = 'x'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM ledger")).toThrow(/append-only/);
    raw.close();
    rm(dir);
  });

  it("entries have ids and sequence numbers, and can be filtered, counted and exported", () => {
    const { hmem, time } = memory();
    const m = hmem.add({ content: "audited record", source: "t" });
    time.advanceDays(1);
    hmem.feedback(m.id, "helpful", { by: "reviewer-1" });
    const all = hmem.ledger.all();
    expect(all.map((e) => e.seq)).toEqual([...all.map((e) => e.seq)].sort((a, b) => a - b));
    expect(new Set(all.map((e) => e.id)).size).toBe(all.length);
    expect(hmem.ledger.filter({ actor: "reviewer-1" })).toHaveLength(1);
    expect(hmem.ledger.filter({ action: "create" })).toHaveLength(1);
    expect(hmem.ledger.filter({ from: T0 + 1 })).toHaveLength(1);
    expect(hmem.ledger.stats()).toEqual({ create: 1, feedback: 1 });
    expect(hmem.ledger.export().split("\n").map((l) => JSON.parse(l).action)).toEqual(["create", "feedback"]);
  });
});

describe("trust is seeded from the source tier and moved by reviewer feedback", () => {
  it("a regulator record starts higher than a vendor claim, and a model proposal lower still", () => {
    const { hmem } = memory();
    const r = hmem.add({ content: "FDA clearance K123456 lists adult chest CT", source: "fda", sourceTier: "regulator" });
    const v = hmem.add({ content: "The brochure says it works on children", source: "brochure", sourceTier: "vendor" });
    const m = hmem.add({ content: "A model guessed the cohort size", source: "nemotron", sourceTier: "model" });
    expect([r.confidence, v.confidence, m.confidence]).toEqual([0.9, 0.5, 0.4]);
    expect(r.provenance.tier).toBe("regulator");
  });

  it("an explicit confidence wins over the tier, and the tiers can be reconfigured", () => {
    const { hmem } = memory({ tierConfidence: { vendor: 0.3 } });
    expect(hmem.add({ content: "explicit wins", source: "t", sourceTier: "vendor", confidence: 0.66 }).confidence).toBe(0.66);
    expect(hmem.add({ content: "reconfigured tier", source: "t", sourceTier: "vendor" }).confidence).toBe(0.3);
    expect(hmem.add({ content: "default tier untouched", source: "t", sourceTier: "regulator" }).confidence).toBe(0.9);
  });

  it("repeated helpful and wrong feedback moves confidence by the exact deltas and no float residue", () => {
    const { hmem } = memory();
    const m = hmem.add({ content: "feedback target", source: "t", confidence: 0.7 });
    for (let i = 0; i < 3; i++) hmem.feedback(m.id, "not_helpful");
    expect(m.confidence).toBe(0.61);
    hmem.feedback(m.id, "helpful");
    expect(m.confidence).toBe(0.66);
    expect(m.accessCount).toBe(1);
    expect(() => hmem.feedback("mem-404", "helpful")).toThrowError(/unknown memory id/);
    expect(() => hmem.feedback(m.id, "meh" as never)).toThrowError(/feedback kind/);
  });

  it("a record marked wrong is demoted, tagged review, never retrieved or injected, until a reviewer clears it", () => {
    const { hmem } = memory();
    const m = hmem.add({ content: "tools used for triage need prospective validation", source: "policy", confidence: 0.9, layer: "long_term" });
    const before = hmem.query("triage prospective validation", { touch: false });
    expect(before.memories.map((x) => x.memory.id)).toEqual([m.id]);
    hmem.feedback(m.id, "wrong", { by: "reviewer-1" });
    expect(m.tags).toContain("review");
    expect(m.confidence).toBe(0.7);
    const after = hmem.query("triage prospective validation", { threshold: 0, touch: false });
    expect(after.memories).toHaveLength(0);
    expect(after.context).toBe("");
    expect(after.trace.excludedReview).toBe(1);
    const audit = hmem.query("triage prospective validation", { threshold: 0, touch: false, includeReview: true });
    expect(audit.memories.map((x) => x.memory.id)).toEqual([m.id]);
    expect(() => hmem.retrieval.clearReview(m.id, "")).toThrowError(/reviewer/);
    hmem.retrieval.clearReview(m.id, "reviewer-1", "re-checked against the FDA summary");
    expect(m.tags).not.toContain("review");
    expect(hmem.query("triage prospective validation", { touch: false }).memories).toHaveLength(1);
    expect(actions(hmem, m.id)).toEqual(["create", "feedback", "update"]);
  });
});

describe("state survives a restart", () => {
  it("records, the ledger, ids and external-change detection all come back", () => {
    const dir = tempDir();
    const a = new HMEM({ persistDir: dir, clock: () => T0 });
    const x = a.add({ content: "first persisted record", source: "t", sourceTier: "registry", organizationId: "org-a" });
    a.feedback(x.id, "helpful");
    a.close();
    const b = new HMEM({ persistDir: dir, clock: () => T0 });
    const again = b.store.get(x.id)!;
    expect(again).toMatchObject({ content: "first persisted record", confidence: 0.85, accessCount: 1, organizationId: "org-a", provenance: { tier: "registry" } });
    expect(b.ledger.history(x.id).map((e) => e.action)).toEqual(["create", "feedback"]);
    const y = b.add({ content: "second record after restart", source: "t" });
    expect(y.id).toBe("mem-2");
    again.confidence = 0.2;
    b.query("anything");
    expect(b.ledger.history(x.id).at(-1)).toMatchObject({ action: "update", actor: "external" });
    b.close();
    rm(dir);
  });

  it("a failed operation rolls back the database and the live records", () => {
    const { hmem } = memory();
    hmem.add({ content: "existing record", source: "t" });
    const ledgerBefore = hmem.ledger.all().length;
    expect(() => hmem.add({ content: "refused record", source: "t", supersedes: "mem-404" })).toThrowError(/unknown memory id/);
    expect(hmem.store.all()).toHaveLength(1);
    expect(hmem.ledger.all()).toHaveLength(ledgerBefore);
    expect(hmem.add({ content: "next record", source: "t" }).id).toBe("mem-2"); // the id the refused write used was rolled back with it
  });
});

describe("idempotency keys: a resumed run never repeats a write", () => {
  it("add, feedback and approve return the original result and write nothing the second time", () => {
    const { hmem } = memory();
    const add = () => hmem.add({ content: "resumable write", source: "t", idempotencyKey: "run-1/add" });
    const first = add();
    const ledger = hmem.ledger.all().length;
    expect(add().id).toBe(first.id);
    expect(hmem.store.all()).toHaveLength(1);
    expect(hmem.ledger.all()).toHaveLength(ledger);

    hmem.feedback(first.id, "wrong", { idempotencyKey: "run-1/fb" });
    hmem.feedback(first.id, "wrong", { idempotencyKey: "run-1/fb" });
    expect(first.confidence).toBe(0.5);
    expect(actions(hmem, first.id)).toEqual(["create", "feedback"]);
  });

  it("a key reused for a different request is refused", () => {
    const { hmem } = memory();
    hmem.add({ content: "one", source: "t", idempotencyKey: "k" });
    expect(() => hmem.add({ content: "two", source: "t", idempotencyKey: "k" })).toThrowError(/different add request/);
    try {
      hmem.add({ content: "two", source: "t", idempotencyKey: "k" });
    } catch (e) {
      expect((e as HMemError).code).toBe("IDEMPOTENCY_CONFLICT");
    }
  });

  it("keys survive a restart, and a write that failed does not consume its key", () => {
    const dir = tempDir();
    const a = new HMEM({ persistDir: dir, clock: () => T0 });
    expect(() => a.add({ content: "x", source: "", idempotencyKey: "retry" })).toThrow();
    const first = a.add({ content: "keyed record", source: "t", idempotencyKey: "retry" });
    a.close();
    const b = new HMEM({ persistDir: dir, clock: () => T0 });
    expect(b.add({ content: "keyed record", source: "t", idempotencyKey: "retry" }).id).toBe(first.id);
    expect(b.store.all()).toHaveLength(1);
    b.close();
    rm(dir);
  });
});
