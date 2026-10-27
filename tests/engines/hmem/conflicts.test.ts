import { describe, expect, it } from "vitest";
import { HMEM, type Resolution } from "../../../src/engines/hmem/index.ts";
import { T0, actions, memory, rm, tempDir } from "./helpers.ts";

const ALWAYS = "always enable telemetry uploads for diagnostics";
const NEVER = "never enable telemetry uploads for diagnostics";

function opposed(hmem: HMEM, a = { confidence: 0.95 }, b = { confidence: 0.2 }) {
  const x = hmem.add({ content: ALWAYS, source: "t", ...a });
  const y = hmem.add({ content: NEVER, source: "t", ...b });
  return { x, y };
}

describe("detection", () => {
  it("finds opposing phrase pairs on similar content and numeric disagreements on near-identical content", () => {
    const { hmem } = memory();
    opposed(hmem);
    hmem.add({ content: "the review board approves at most 12 studies per quarter", source: "t" });
    hmem.add({ content: "the review board approves at most 20 studies per quarter", source: "t" });
    const found = hmem.conflicts.scan();
    expect(found.map((c) => c.reason).sort()).toEqual(["high-similarity conflicting numeric values", "opposing phrase pair on similar content"]);
  });

  it("finds the policy contradictions Sakaime meets: requires against does not require, accepts against rejects", () => {
    const { hmem } = memory();
    hmem.add({ content: "Triage devices require prospective validation before deployment", source: "policy" });
    hmem.add({ content: "Triage devices do not require prospective validation before deployment", source: "policy" });
    hmem.add({ content: "The board accepts vendor summaries as primary evidence for cleared devices", source: "policy" });
    hmem.add({ content: "The board rejects vendor summaries as primary evidence for cleared devices", source: "policy" });
    expect(hmem.conflicts.scan()).toHaveLength(2);
  });

  it("does not flag unrelated records or dissimilar records that merely contain opposing words", () => {
    const { hmem } = memory();
    hmem.add({ content: "always lock the server room door", source: "t" });
    hmem.add({ content: "never forget the quarterly budget review with finance", source: "t" });
    expect(hmem.conflicts.scan()).toEqual([]);
  });

  it("scanning again finds nothing new and does not duplicate the conflict or its ledger entry", () => {
    const { hmem } = memory();
    const { x } = opposed(hmem);
    expect(hmem.conflicts.scan()).toHaveLength(1);
    expect(hmem.conflicts.scan()).toHaveLength(0);
    expect(hmem.conflicts.list()).toHaveLength(1);
    expect(actions(hmem, x.id).filter((a) => a === "conflict_detected")).toHaveLength(1);
  });

  it("records of different organizations are never compared: two hospitals may hold opposite policies", () => {
    const { hmem } = memory();
    hmem.add({ content: "Triage devices require prospective validation before deployment", source: "a", organizationId: "hospital-a" });
    hmem.add({ content: "Triage devices do not require prospective validation before deployment", source: "b", organizationId: "hospital-b" });
    expect(hmem.conflicts.scan()).toEqual([]);
    hmem.add({ content: "Triage devices do not require prospective validation before deployment", source: "a2", organizationId: "hospital-a" });
    expect(hmem.conflicts.scan()).toHaveLength(1);
  });

  it("a declared replacement, or a pair already settled, is not a conflict", () => {
    const { hmem } = memory();
    const a = hmem.add({ content: ALWAYS, source: "t" });
    hmem.add({ content: NEVER, source: "t", supersedes: a.id });
    expect(hmem.conflicts.scan()).toEqual([]);
  });
});

describe("the 0.70 auto-resolve gate", () => {
  it("resolves only at or above the gate; the loser is marked superseded and nothing is deleted", () => {
    const { hmem } = memory();
    const { x, y } = opposed(hmem);
    const [c] = hmem.conflicts.scan();
    const a = hmem.conflicts.assess(c!);
    expect(a.winnerId).toBe(x.id);
    expect(hmem.conflicts.autoResolve(c!, { gate: a.decisionConfidence + 1e-6 })).toBe("queued");
    expect([x.supersededBy, y.supersededBy]).toEqual([undefined, undefined]);
    expect(hmem.conflicts.queue()).toHaveLength(1);
    expect(hmem.conflicts.autoResolve(c!, { gate: a.decisionConfidence })).toBe("resolved");
    expect(y.supersededBy).toBe(x.id);
    expect(x.supersededBy).toBeUndefined();
    expect(hmem.store.get(x.id)).toBeDefined();
    expect(hmem.store.get(y.id)).toBeDefined();
    expect(hmem.conflicts.queue()).toHaveLength(0);
    expect(hmem.conflicts.get(c!.id)).toMatchObject({ resolved: true, resolution: "keep_a", resolvedBy: "auto" });
  });

  it("the default gate is 0.70: a lopsided pair resolves by itself, an even pair waits for a person", () => {
    const lopsided = memory().hmem;
    opposed(lopsided, { confidence: 0.95 }, { confidence: 0.1 });
    const [c1] = lopsided.conflicts.scan();
    expect(lopsided.conflicts.assess(c1!).decisionConfidence).toBeGreaterThanOrEqual(0.7);
    expect(lopsided.conflicts.autoResolve(c1!)).toBe("resolved");

    const even = memory().hmem;
    const { x, y } = opposed(even, { confidence: 0.6 }, { confidence: 0.6 });
    const [c2] = even.conflicts.scan();
    expect(even.conflicts.assess(c2!).decisionConfidence).toBeLessThan(0.7);
    expect(even.conflicts.autoResolve(c2!)).toBe("queued");
    expect(even.conflicts.queue()).toHaveLength(1);
    expect([x.supersededBy, y.supersededBy]).toEqual([undefined, undefined]);
    expect(even.conflicts.get(c2!.id)?.decisionConfidence).toBeLessThan(0.7);
  });

  it("authority outranks recency: an older regulator record beats a newer vendor one", () => {
    const { hmem, time } = memory();
    const reg = hmem.add({ content: "Triage devices require prospective validation before deployment", source: "fda", sourceTier: "regulator" });
    time.advanceDays(30);
    const vendor = hmem.add({ content: "Triage devices not required to have prospective validation before deployment", source: "brochure", sourceTier: "vendor" });
    const [c] = hmem.conflicts.scan();
    expect(c).toBeDefined();
    expect(hmem.conflicts.assess(c!).winnerId).toBe(reg.id);
    expect(vendor.supersededBy).toBeUndefined();
  });

  it("triage scans and resolves what is clear, and returns what is left for a reviewer", () => {
    const { hmem } = memory();
    opposed(hmem, { confidence: 0.95 }, { confidence: 0.1 });
    hmem.add({ content: "the review board approves at most 12 studies per quarter", source: "t", confidence: 0.6 });
    hmem.add({ content: "the review board approves at most 20 studies per quarter", source: "t", confidence: 0.6 });
    const left = hmem.conflicts.triage();
    expect(left).toHaveLength(1);
    expect(left[0]!.reason).toBe("high-similarity conflicting numeric values");
  });

  it("a supersession candidate is never resolved by the heuristic, only by a person", () => {
    const { hmem } = memory();
    const old = hmem.add({ content: "The board meets on fridays at noon in the main room", source: "t", confidence: 0.2 });
    const fresh = hmem.add({ content: "Actually the board meets on fridays at noon in the main room now", source: "t", confidence: 0.95 });
    const [c] = hmem.conflicts.queue();
    expect(c).toMatchObject({ kind: "supersession_candidate", memoryA: old.id, memoryB: fresh.id });
    expect(fresh.supersedes).toBeUndefined();
    expect(old.supersededBy).toBeUndefined();
    expect(hmem.conflicts.autoResolve(c!)).toBe("queued");
    hmem.conflicts.resolve(c!.id, "keep_b", { by: "reviewer-1" });
    expect(old.supersededBy).toBe(fresh.id);
  });
});

describe("manual resolution, every strategy the specification lists", () => {
  const setup = () => {
    const { hmem } = memory();
    const { x, y } = opposed(hmem, { confidence: 0.6 }, { confidence: 0.6 });
    const [c] = hmem.conflicts.scan();
    return { hmem, x, y, c: c! };
  };

  it("keep_a and keep_b supersede the other side, ledger the change with the reviewer, and keep both records", () => {
    for (const [strategy, winner, loser] of [["keep_a", "x", "y"], ["keep_b", "y", "x"]] as const) {
      const { hmem, x, y, c } = setup();
      const rec = { x, y };
      hmem.conflicts.resolve(c.id, strategy, { by: "reviewer-1", note: "checked the FDA text" });
      expect(rec[loser].supersededBy).toBe(rec[winner].id);
      const entry = hmem.ledger.history(rec[loser].id).at(-1)!;
      expect(entry).toMatchObject({ action: "conflict_resolved", actor: "reviewer-1", details: { strategy, note: "checked the FDA text" } });
      expect(entry.previousState?.supersededBy).toBeUndefined();
      expect(entry.newState?.supersededBy).toBe(rec[winner].id);
      expect(hmem.store.all()).toHaveLength(2);
    }
  });

  it("keep_both changes neither record and closes the conflict so it is not raised again", () => {
    const { hmem, x, y, c } = setup();
    hmem.conflicts.resolve(c.id, "keep_both", { by: "reviewer-1" });
    expect([x.supersededBy, y.supersededBy]).toEqual([undefined, undefined]);
    expect(hmem.conflicts.scan()).toEqual([]);
    expect(hmem.conflicts.queue()).toHaveLength(0);
    expect(actions(hmem, x.id)).toContain("conflict_resolved");
  });

  it("merge creates a derived record in the lower trust of the two and supersedes both sources", () => {
    const { hmem, x, y, c } = setup();
    hmem.conflicts.resolve(c.id, "merge", { by: "reviewer-1" });
    const merged = hmem.store.all().find((m) => m.derivedFrom?.includes(x.id))!;
    expect(merged.derivedFrom).toEqual([x.id, y.id]);
    expect(merged.confidence).toBe(0.6);
    expect(merged.provenance).toMatchObject({ origin: "reviewer", reviewer: "reviewer-1" });
    expect([x.supersededBy, y.supersededBy]).toEqual([merged.id, merged.id]);
  });

  it("delete_both removes both with the full previous state in the ledger", () => {
    const { hmem, x, y, c } = setup();
    hmem.conflicts.resolve(c.id, "delete_both", { by: "reviewer-1" });
    expect(hmem.store.all()).toHaveLength(0);
    const entry = hmem.ledger.history(x.id).at(-1)!;
    expect(entry).toMatchObject({ action: "delete", actor: "reviewer-1" });
    expect(entry.previousState?.content).toBe(ALWAYS);
    expect(hmem.ledger.history(y.id).at(-1)!.action).toBe("delete");
    expect(hmem.conflicts.queue()).toHaveLength(0);
  });

  it("needs a named reviewer, refuses an unknown or already resolved conflict and an unknown strategy", () => {
    const { hmem, c } = setup();
    expect(() => hmem.conflicts.resolve(c.id, "keep_a", { by: "" })).toThrowError(/reviewer/);
    expect(() => hmem.conflicts.resolve("conflict-404", "keep_a", { by: "r" })).toThrowError(/no conflict/);
    expect(() => hmem.conflicts.resolve(c.id, "shrug" as Resolution, { by: "r" })).toThrowError(/unknown strategy/);
    expect(hmem.conflicts.queue()).toHaveLength(1);
    hmem.conflicts.resolve(c.id, "keep_a", { by: "r" });
    expect(() => hmem.conflicts.resolve(c.id, "keep_b", { by: "r" })).toThrowError(/already resolved/);
  });

  it("a repeated resolution with the same idempotency key does not write twice", () => {
    const { hmem, y, c } = setup();
    hmem.conflicts.resolve(c.id, "keep_a", { by: "r", idempotencyKey: "res-1" });
    const n = hmem.ledger.all().length;
    hmem.conflicts.resolve(c.id, "keep_a", { by: "r", idempotencyKey: "res-1" });
    expect(hmem.ledger.all()).toHaveLength(n);
    expect(y.supersededBy).toBeDefined();
  });
});

describe("supersession is a real relationship", () => {
  it("declaring supersedes marks the replaced record supersededBy, with a ledger entry showing both states", () => {
    const { hmem } = memory();
    const old = hmem.add({ content: "Policy: retrospective studies are enough", source: "t", confidence: 0.8 });
    const fresh = hmem.add({ content: "Policy: prospective studies are required", source: "t", supersedes: old.id });
    expect(fresh.supersedes).toBe(old.id);
    expect(old.supersededBy).toBe(fresh.id);
    const entry = hmem.ledger.history(old.id).at(-1)!;
    expect(entry).toMatchObject({ action: "update", details: { reason: "supersession declared", by: fresh.id } });
    expect(entry.previousState?.supersededBy).toBeUndefined();
    expect(entry.newState?.supersededBy).toBe(fresh.id);
  });

  it("refuses to supersede an unknown record or one that is already superseded; the refused write leaves no trace", () => {
    const { hmem } = memory();
    const old = hmem.add({ content: "Policy one", source: "t" });
    hmem.add({ content: "Policy two", source: "t", supersedes: old.id });
    const before = hmem.ledger.all().length;
    expect(() => hmem.add({ content: "Policy three", source: "t", supersedes: old.id })).toThrowError(/already superseded/);
    expect(() => hmem.add({ content: "Policy four", source: "t", supersedes: "mem-404" })).toThrowError(/unknown memory id/);
    expect(hmem.ledger.all()).toHaveLength(before);
    expect(hmem.store.all()).toHaveLength(2);
  });
});

describe("the queue survives a restart", () => {
  it("open conflicts, resolved ones and their decisions are all still there", () => {
    const dir = tempDir();
    const a = new HMEM({ persistDir: dir, clock: () => T0 });
    opposed(a, { confidence: 0.6 }, { confidence: 0.6 });
    a.add({ content: "the review board approves at most 12 studies per quarter", source: "t" });
    a.add({ content: "the review board approves at most 20 studies per quarter", source: "t" });
    const [first, second] = a.conflicts.scan();
    a.conflicts.resolve(first!.id, "keep_both", { by: "r" });
    expect(a.conflicts.autoResolve(second!)).toBe("queued");
    a.close();
    const b = new HMEM({ persistDir: dir, clock: () => T0 });
    expect(b.conflicts.list()).toHaveLength(2);
    expect(b.conflicts.get(first!.id)).toMatchObject({ resolved: true, resolution: "keep_both" });
    expect(b.conflicts.queue().map((c) => c.id)).toEqual([second!.id]);
    expect(b.conflicts.scan()).toEqual([]);
    b.close();
    rm(dir);
  });
});
