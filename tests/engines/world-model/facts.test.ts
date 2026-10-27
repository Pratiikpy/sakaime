import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { WorldModel, type PolicySetting } from "../../../src/engines/world-model/index.ts";
import { T, device, memoryWorld, tempDir } from "./helpers.ts";

const D = "device:fda:K1";
const open = (conflictPolicy: PolicySetting, extra: object = {}) => memoryWorld({ conflictPolicy, ...extra });

async function twoFacts(w: WorldModel, a: { value: unknown; confidence: number; kind: string; at: string }, b: { value: unknown; confidence: number; kind: string; at: string }) {
  await device(w, "K1");
  const fa = await w.assertFact({ about: D, predicate: "software", value: a.value, confidence: a.confidence, source: { kind: a.kind, at: a.at } });
  const fb = await w.assertFact({ about: D, predicate: "software", value: b.value, confidence: b.confidence, source: { kind: b.kind, at: b.at } });
  return { fa, fb };
}

const older = { value: "v1", confidence: 0.9, kind: "registry", at: "2026-01-01T00:00:00.000Z" };
const newer = { value: "v2", confidence: 0.4, kind: "vendor", at: "2026-02-01T00:00:00.000Z" };

describe("fact resolution policies", () => {
  it("most-recent-wins prefers the later observation", async () => {
    const w = open("most-recent-wins");
    const { fb } = await twoFacts(w, older, newer);
    expect(w.resolve(D, "software").winner?.id).toBe(fb.id);
    expect(w.view("graph").entity(D)?.attrs["software"]).toBe("v2");
  });

  it("highest-confidence-wins prefers the more confident fact even when it is older", async () => {
    const w = open("highest-confidence-wins");
    const { fa } = await twoFacts(w, older, newer);
    expect(w.resolve(D, "software").winner?.id).toBe(fa.id);
  });

  it("source-priority prefers the source kind ranked first", async () => {
    const w = open("source-priority", { sourcePriority: ["registry", "vendor"] });
    const { fa } = await twoFacts(w, older, newer);
    const res = w.resolve(D, "software");
    expect(res.winner?.id).toBe(fa.id);
    expect(res.reason).toMatch(/source registry/);
  });

  it("a source kind that is not ranked loses to every ranked one", async () => {
    const w = open("source-priority", { sourcePriority: ["registry"] });
    const { fa } = await twoFacts(w, { ...older, kind: "registry" }, { ...newer, kind: "blog" });
    expect(w.resolve(D, "software").winner?.id).toBe(fa.id);
  });

  it("the policy can differ per predicate", async () => {
    const w = open({ default: "most-recent-wins", byPredicate: { software: "highest-confidence-wins" } });
    await twoFacts(w, older, newer);
    await w.assertFact({ about: D, predicate: "name", value: "Old name", confidence: 0.9, source: T("2026-01-01T00:00:00.000Z") });
    await w.assertFact({ about: D, predicate: "name", value: "New name", confidence: 0.1, source: T("2026-02-01T00:00:00.000Z") });
    expect(w.resolve(D, "software").winner?.value).toBe("v1");
    expect(w.resolve(D, "name").winner?.value).toBe("New name");
  });

  it("exact ties are broken by record order, so the result is always the same", async () => {
    const w = open("highest-confidence-wins");
    await device(w, "K1");
    const x = await w.assertFact({ about: D, predicate: "p", value: "a", confidence: 0.5, source: { kind: "s1", at: "2026-01-01T00:00:00.000Z" } });
    const y = await w.assertFact({ about: D, predicate: "p", value: "b", confidence: 0.5, source: { kind: "s2", at: "2026-01-01T00:00:00.000Z" } });
    expect(w.resolve(D, "p").winner?.id).toBe(y.id);
    expect(x.id).not.toBe(y.id);
  });

  it("agreement is not a conflict; disagreement is", async () => {
    const w = open("most-recent-wins");
    await device(w, "K1");
    await w.assertFact({ about: D, predicate: "p", value: "same", source: { kind: "a", at: "2026-01-01T00:00:00.000Z" } });
    await w.assertFact({ about: D, predicate: "p", value: "same", source: { kind: "b", at: "2026-01-02T00:00:00.000Z" } });
    expect(w.resolve(D, "p").conflict).toBe(false);
    await w.assertFact({ about: D, predicate: "p", value: "different", source: { kind: "c", at: "2026-01-03T00:00:00.000Z" } });
    expect(w.resolve(D, "p").conflict).toBe(true);
    expect(w.view("facts").conflicts().map((c) => c.predicate)).toEqual(["p"]);
  });
});

describe("supersession keeps history", () => {
  it("every version stays visible with its status; nothing is deleted", async () => {
    const w = open("most-recent-wins");
    const { fa, fb } = await twoFacts(w, older, newer);
    const versions = w.view("facts").about(D);
    expect(versions.map((v) => [v.id, v.status])).toEqual([[fa.id, "superseded"], [fb.id, "current"]]);
    expect(versions.find((v) => v.id === fa.id)?.supersededBy).toBe(fb.id);
  });

  it("a fact outside its validity window is a rival, not a winner, at that time", async () => {
    const w = open("most-recent-wins");
    await device(w, "K1");
    await w.assertFact({ about: D, predicate: "p", value: "early", validTo: "2026-02-01T00:00:00.000Z", source: T("2026-01-01T00:00:00.000Z") });
    await w.assertFact({ about: D, predicate: "p", value: "late", validFrom: "2026-02-01T00:00:00.000Z", source: T("2026-01-15T00:00:00.000Z") });
    expect(w.resolve(D, "p", { at: "2026-01-20" }).winner?.value).toBe("early");
    expect(w.resolve(D, "p", { at: "2026-03-01" }).winner?.value).toBe("late");
    const res = w.resolve(D, "p", { at: "2026-03-01" });
    expect(res.rivals.find((r) => r.fact.value === "early")?.status).toBe("outside-validity");
  });

  it("retracting the winner promotes the runner-up and keeps the retracted fact in history", async () => {
    const w = open("most-recent-wins");
    const { fa, fb } = await twoFacts(w, older, newer);
    await w.retractFact({ factId: fb.id, source: T("2026-03-01T00:00:00.000Z", ), reason: "vendor withdrew the notice" });
    const res = w.resolve(D, "software");
    expect(res.winner?.id).toBe(fa.id);
    expect(res.rivals.find((r) => r.fact.id === fb.id)?.status).toBe("retracted");
    expect(w.view("facts").about(D).map((v) => v.status).sort()).toEqual(["current", "retracted"]);
  });

  it("retracting every fact leaves the slot empty, not stuck on a stale value", async () => {
    const w = open("most-recent-wins");
    const { fa, fb } = await twoFacts(w, older, newer);
    await w.retractFact({ factId: fa.id, source: T("2026-03-01T00:00:00.000Z") });
    await w.retractFact({ factId: fb.id, source: T("2026-03-01T00:00:00.000Z") });
    expect(w.resolve(D, "software").status).toBe("none");
    expect(w.view("graph").entity(D)?.attrs["software"]).toBeUndefined();
  });

  it("history before a retraction can still be read with asOf", async () => {
    const w = open("most-recent-wins", { clock: () => new Date("2026-03-10T00:00:00.000Z") });
    const { fb } = await twoFacts(w, older, newer);
    await w.retractFact({ factId: fb.id, source: T("2026-03-01T00:00:00.000Z") });
    // The injected clock is fixed, so everything shares one record time: asOf before it sees nothing.
    expect(w.asOf("2026-03-09").facts.about(D)).toHaveLength(0);
    expect(w.asOf("2026-03-10").facts.about(D).some((v) => v.status === "retracted")).toBe(true);
  });
});

describe("manual policy and reviewer decisions", () => {
  it("disagreeing candidates stay unresolved until a reviewer chooses", async () => {
    const w = open("manual");
    const { fa, fb } = await twoFacts(w, older, newer);
    const before = w.resolve(D, "software");
    expect(before.status).toBe("unresolved");
    expect(before.winner).toBeUndefined();
    expect(before.rivals.map((r) => r.status)).toEqual(["undecided", "undecided"]);
    const after = await w.chooseFact({ about: D, predicate: "software", factId: fa.id, by: "reviewer-1" });
    expect(after.winner?.id).toBe(fa.id);
    expect(after.decidedBy).toBe("reviewer");
    expect(fb.id).not.toBe(fa.id);
  });

  it("a single candidate under the manual policy needs no decision", async () => {
    const w = open("manual");
    await device(w, "K1");
    await w.assertFact({ about: D, predicate: "p", value: 1, source: T("2026-01-01T00:00:00.000Z") });
    expect(w.resolve(D, "p").status).toBe("resolved");
  });

  it("a reviewer's choice outranks the policy, and is flagged outdated when a newer fact arrives", async () => {
    const w = open("most-recent-wins");
    const { fa } = await twoFacts(w, older, newer);
    await w.chooseFact({ about: D, predicate: "software", factId: fa.id, by: "reviewer-1" });
    expect(w.resolve(D, "software").winner?.id).toBe(fa.id);
    expect(w.resolve(D, "software").decisionOutdated).toBe(false);
    await w.assertFact({ about: D, predicate: "software", value: "v3", source: T("2026-04-01T00:00:00.000Z") });
    const res = w.resolve(D, "software");
    expect(res.winner?.id).toBe(fa.id);
    expect(res.decisionOutdated).toBe(true);
  });

  it("refuses a choice that is not a fact about that slot, or is retracted, or has no reviewer", async () => {
    const w = open("manual");
    const { fa } = await twoFacts(w, older, newer);
    await w.assertFact({ about: D, predicate: "other", value: 1, source: T("2026-01-01T00:00:00.000Z") });
    const other = w.resolve(D, "other").winner!;
    await expect(w.chooseFact({ about: D, predicate: "software", factId: other.id, by: "r" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(w.chooseFact({ about: D, predicate: "software", factId: fa.id, by: " " })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await w.retractFact({ factId: fa.id, source: T("2026-03-01T00:00:00.000Z") });
    await expect(w.chooseFact({ about: D, predicate: "software", factId: fa.id, by: "r" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});

describe("resolution is a pure function of the event fold (restart and replay)", () => {
  it("the same winners, history and canonical state come back after a restart", async () => {
    const dir = tempDir();
    const opts = { storage: "local" as const, namespace: "replay", directory: dir, conflictPolicy: { default: "highest-confidence-wins" as const, byPredicate: { name: "most-recent-wins" as const } } };
    const w = new WorldModel(opts);
    await device(w, "K1");
    const f1 = await w.assertFact({ about: D, predicate: "software", value: "v1", confidence: 0.9, source: { kind: "registry", at: "2026-01-01T00:00:00.000Z" } });
    await w.assertFact({ about: D, predicate: "software", value: "v2", confidence: 0.5, source: { kind: "vendor", at: "2026-02-01T00:00:00.000Z" } });
    const f3 = await w.assertFact({ about: D, predicate: "software", value: "v3", confidence: 0.7, source: { kind: "paper", at: "2026-03-01T00:00:00.000Z" } });
    await w.assertFact({ about: D, predicate: "name", value: "A", source: T("2026-01-01T00:00:00.000Z") });
    await w.assertFact({ about: D, predicate: "name", value: "B", source: T("2026-02-01T00:00:00.000Z") });
    await w.retractFact({ factId: f1.id, source: T("2026-03-02T00:00:00.000Z") });
    await w.chooseFact({ about: D, predicate: "software", factId: f3.id, by: "reviewer-1" });
    const summarise = (m: WorldModel) => ({
      shape: m.stateShapeCanonical(),
      software: m.resolve(D, "software").winner?.id,
      name: m.resolve(D, "name").winner?.value,
      attrs: m.view("graph").entity(D)?.attrs,
      versions: m.view("facts").about(D).map((v) => `${v.id}:${v.status}`),
    });
    const before = summarise(w);
    w.close();
    const reopened = new WorldModel(opts);
    expect(summarise(reopened)).toEqual(before);
    expect(before.software).toBe(f3.id);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the winner is a function of the policy as well as the log: the same log under another policy resolves differently", async () => {
    const dir = tempDir();
    const base = { storage: "local" as const, namespace: "policy", directory: dir };
    const w = new WorldModel({ ...base, conflictPolicy: "highest-confidence-wins" });
    await twoFacts(w, older, newer);
    expect(w.resolve(D, "software").winner?.value).toBe("v1");
    w.close();
    const other = new WorldModel({ ...base, conflictPolicy: "most-recent-wins" });
    expect(other.resolve(D, "software").winner?.value).toBe("v2");
    other.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("asserting the same fact twice is a no-op", async () => {
    const w = open("most-recent-wins");
    await device(w, "K1");
    const input = { about: D, predicate: "p", value: { n: 1 }, source: { kind: "a", at: "2026-01-01T00:00:00.000Z", url: "https://example.org/x" } };
    const first = await w.assertFact(input);
    const count = w.eventLog().length;
    const second = await w.assertFact(input);
    expect(second.id).toBe(first.id);
    expect(w.eventLog().length).toBe(count);
  });

  it("asserting a fact about an entity that was never upserted creates it as emerging", async () => {
    const w = open("most-recent-wins");
    await w.assertFact({ about: "device:fda:K9", predicate: "p", value: 1, source: T("2026-01-01T00:00:00.000Z") });
    expect(w.view("graph").entity("device:fda:K9")).toMatchObject({ type: "device", state: "emerging" });
  });
});

describe("fact input is checked", () => {
  it("rejects an undefined value, an out-of-range confidence, a non-finite number and an empty predicate", async () => {
    const w = open("most-recent-wins");
    await device(w, "K1");
    const ok = { about: D, predicate: "p", value: 1, source: T("2026-01-01T00:00:00.000Z") };
    await expect(w.assertFact({ ...ok, value: undefined })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.assertFact({ ...ok, confidence: 1.2 })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.assertFact({ ...ok, confidence: Number.NaN })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.assertFact({ ...ok, value: Number.POSITIVE_INFINITY })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.assertFact({ ...ok, predicate: "" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.assertFact({ ...ok, source: undefined as never })).rejects.toMatchObject({ code: "PROVENANCE_REQUIRED" });
    await expect(w.assertFact({ ...ok, validFrom: "2026-03-01T00:00:00.000Z", validTo: "2026-02-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
  });
});
