import fs from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SAKAIME_RELATIONSHIP_TYPES, WorldModel } from "../../../src/engines/world-model/index.ts";
import { T, device, memoryWorld, study, tempDir } from "./helpers.ts";

const D = "device:fda:K1";

async function seeded() {
  const w = memoryWorld({ relationshipTypes: SAKAIME_RELATIONSHIP_TYPES });
  await device(w, "K1");
  await device(w, "K2");
  const version = await w.assertFact({ about: D, predicate: "software", value: "v1", confidence: 0.9, source: { kind: "registry", at: "2026-01-01T00:00:00.000Z" } });
  const population = await w.assertFact({ about: D, predicate: "population", value: "adult", source: T("2026-01-01T00:00:00.000Z") });
  const other = await w.assertFact({ about: "device:fda:K2", predicate: "software", value: "k2-v1", source: T("2026-01-01T00:00:00.000Z") });
  await w.declareDependencies({ findingId: "finding-version", refs: [version.id] });
  await w.declareDependencies({ findingId: "finding-population", refs: [population.id] });
  await w.declareDependencies({ findingId: "finding-both", refs: [version.id, population.id] });
  await w.declareDependencies({ findingId: "finding-k2", refs: [other.id] });
  return { w, version, population, other };
}

describe("a finding stores the ids it used; a change marks exactly its dependents stale", () => {
  it("a new fact that changes the winner marks only the findings that used that slot", async () => {
    const { w } = await seeded();
    expect(w.staleFindings()).toEqual([]);
    await w.assertFact({ about: D, predicate: "software", value: "v2", confidence: 0.95, source: { kind: "registry", at: "2026-03-01T00:00:00.000Z" } });
    expect(w.staleFindings()).toEqual(["finding-both", "finding-version"]);
    expect(w.finding("finding-version")?.stale?.causes[0]).toMatchObject({ reason: "winner-changed" });
  });

  it("a new fact that loses changes nothing", async () => {
    const { w } = await seeded();
    // Under most-recent-wins an older observation loses to v1 (2026-01-01).
    await w.assertFact({ about: D, predicate: "software", value: "v0", source: T("2025-06-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual([]);
  });

  it("a fact about another entity or another predicate marks nothing", async () => {
    const { w } = await seeded();
    await w.assertFact({ about: "device:fda:K2", predicate: "software", value: "k2-v2", source: T("2026-04-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual(["finding-k2"]);
    await w.assertFact({ about: D, predicate: "intended-use", value: "triage", source: T("2026-04-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual(["finding-k2"]);
  });

  it("retracting a fact marks its dependents stale even when it was not the winner", async () => {
    const w = memoryWorld();
    await device(w, "K1");
    const loser = await w.assertFact({ about: D, predicate: "p", value: "old", source: T("2026-01-01T00:00:00.000Z") });
    await w.assertFact({ about: D, predicate: "p", value: "new", source: T("2026-02-01T00:00:00.000Z") });
    await w.declareDependencies({ findingId: "f-loser", refs: [loser.id] });
    await w.retractFact({ factId: loser.id, source: T("2026-03-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual(["f-loser"]);
    expect(w.finding("f-loser")?.stale?.causes.map((c) => c.reason)).toContain("fact-retracted");
  });

  it("a closed relationship marks the findings that used it", async () => {
    const w = memoryWorld({ relationshipTypes: SAKAIME_RELATIONSHIP_TYPES });
    await device(w, "K1");
    await study(w, "V1");
    await study(w, "V2");
    const link = await w.relate({ from: D, type: "describes-version", to: "study:nct:V1", validFrom: "2026-01-01T00:00:00.000Z", source: T("2026-01-01T00:00:00.000Z") });
    await w.declareDependencies({ findingId: "f-link", refs: [link.id] });
    await w.declareDependencies({ findingId: "f-unrelated", refs: [] });
    await w.relate({ from: D, type: "describes-version", to: "study:nct:V2", validFrom: "2026-05-01T00:00:00.000Z", source: T("2026-05-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual(["f-link"]);
    expect(w.finding("f-link")?.stale?.causes[0]).toMatchObject({ reason: "relationship-closed", ref: link.id });
  });

  it("adding a second study to a many-valued type does not make findings about the first stale", async () => {
    const w = memoryWorld({ relationshipTypes: SAKAIME_RELATIONSHIP_TYPES });
    await device(w, "K1");
    await study(w, "NCT1");
    await study(w, "NCT2");
    const link = await w.relate({ from: D, type: "evaluated-in", to: "study:nct:NCT1", source: T("2026-01-01T00:00:00.000Z") });
    await w.declareDependencies({ findingId: "f", refs: [link.id] });
    await w.relate({ from: D, type: "evaluated-in", to: "study:nct:NCT2", source: T("2026-02-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual([]);
  });

  it("an explicitly ended relationship marks its dependents", async () => {
    const w = memoryWorld({ relationshipTypes: SAKAIME_RELATIONSHIP_TYPES });
    await device(w, "K1");
    await study(w, "NCT1");
    const link = await w.relate({ from: D, type: "evaluated-in", to: "study:nct:NCT1", source: T("2026-01-01T00:00:00.000Z") });
    await w.declareDependencies({ findingId: "f", refs: [link.id] });
    await w.endRelationship({ id: link.id, validTo: "2026-06-01T00:00:00.000Z", source: T("2026-06-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual(["f"]);
  });

  it("re-declaring the dependencies of a recomputed finding clears its stale flag and nothing else", async () => {
    const { w, version } = await seeded();
    await w.assertFact({ about: D, predicate: "software", value: "v2", confidence: 0.95, source: { kind: "registry", at: "2026-03-01T00:00:00.000Z" } });
    const fresh = w.resolve(D, "software").winner!;
    await w.declareDependencies({ findingId: "finding-version", refs: [fresh.id] });
    expect(w.staleFindings()).toEqual(["finding-both"]);
    expect(w.finding("finding-version")?.refs).toEqual([fresh.id]);
    expect(w.dependentsOf([version.id])).toEqual(["finding-both"]);
  });

  it("staleDependents(factIds) returns the stale findings among those that used the given facts", async () => {
    const { w, version, population } = await seeded();
    expect(w.dependentsOf([version.id])).toEqual(["finding-both", "finding-version"]);
    expect(w.staleDependents([version.id])).toEqual([]);
    await w.assertFact({ about: D, predicate: "software", value: "v2", confidence: 0.95, source: { kind: "registry", at: "2026-03-01T00:00:00.000Z" } });
    expect(w.staleDependents([version.id])).toEqual(["finding-both", "finding-version"]);
    expect(w.staleDependents([population.id])).toEqual(["finding-both"]);
    expect(w.staleDependents([])).toEqual([]);
  });

  it("a reviewer's decision that a newer fact has outdated marks its dependents", async () => {
    const w = memoryWorld();
    await device(w, "K1");
    const a = await w.assertFact({ about: D, predicate: "p", value: "a", source: T("2026-01-01T00:00:00.000Z") });
    await w.assertFact({ about: D, predicate: "p", value: "b", source: T("2026-02-01T00:00:00.000Z") });
    await w.chooseFact({ about: D, predicate: "p", factId: a.id, by: "reviewer-1" });
    await w.declareDependencies({ findingId: "f", refs: [a.id] });
    expect(w.staleFindings()).toEqual([]);
    await w.assertFact({ about: D, predicate: "p", value: "c", source: T("2026-03-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual(["f"]);
    expect(w.finding("f")?.stale?.causes[0]).toMatchObject({ reason: "decision-outdated" });
  });

  it("refuses dependencies on ids that are not facts or relationships, and tolerates a finding with none", async () => {
    const { w } = await seeded();
    await expect(w.declareDependencies({ findingId: "x", refs: ["fact_nope"] })).rejects.toMatchObject({ code: "UNKNOWN_REF" });
    await expect(w.declareDependencies({ findingId: "", refs: [] })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.declareDependencies({ findingId: "x", refs: "fact_a" as never })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await w.declareDependencies({ findingId: "no-deps", refs: [] });
    expect(w.finding("no-deps")?.refs).toEqual([]);
  });

  it("merging two entities that disagree on a slot marks the findings that used either side", async () => {
    const w = memoryWorld();
    const a = await w.upsertEntity({ type: "device", name: "Aidoc BriefCase CSpine", source: T("2026-01-01T00:00:00.000Z") });
    const b = await w.upsertEntity({ type: "device", name: "Aidoc BriefCase CSpine v2", source: T("2026-01-01T00:00:00.000Z") });
    const fa = await w.assertFact({ about: a.id, predicate: "software", value: "v1", source: T("2026-01-01T00:00:00.000Z") });
    const fb = await w.assertFact({ about: b.id, predicate: "software", value: "v2", source: T("2026-06-01T00:00:00.000Z") });
    await w.declareDependencies({ findingId: "on-a", refs: [fa.id] });
    await w.declareDependencies({ findingId: "on-b", refs: [fb.id] });
    await w.approveMerge(w.mergeQueue()[0]!.id, "reviewer-1");
    // The merged slot resolves to the later fact (b's), so the finding that used a's fact is stale and b's is not.
    expect(w.resolve(a.id, "software").winner?.id).toBe(fb.id);
    expect(w.staleFindings()).toEqual(["on-a"]);
  });

  it("staleness survives a restart because it is part of the fold", async () => {
    const dir = tempDir();
    const opts = { storage: "local" as const, namespace: "stale", directory: dir };
    const w = new WorldModel(opts);
    await device(w, "K1");
    const f = await w.assertFact({ about: D, predicate: "p", value: "a", source: T("2026-01-01T00:00:00.000Z") });
    await w.declareDependencies({ findingId: "f1", refs: [f.id] });
    await w.assertFact({ about: D, predicate: "p", value: "b", source: T("2026-02-01T00:00:00.000Z") });
    expect(w.staleFindings()).toEqual(["f1"]);
    w.close();
    const again = new WorldModel(opts);
    expect(again.staleFindings()).toEqual(["f1"]);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Change-impact exactness against an independent oracle. The oracle shares the stated rule (a
 * finding is stale from the first event that changes the winner of a slot it used or retracts a fact
 * it used) but none of the code: it keeps plain arrays and recomputes the winner of a slot from
 * scratch after every operation. The property: the engine's stale set equals the oracle's after any
 * sequence of operations, so nothing that should be recomputed is missed and nothing else is flagged.
 */
describe("change impact is exact (stale set equals dependent set)", () => {
  type Op =
    | { kind: "assert"; slot: number; time: number }
    | { kind: "retract"; pick: number }
    | { kind: "declare"; id: number; picks: number[] };

  const opArb: fc.Arbitrary<Op> = fc.oneof(
    { weight: 5, arbitrary: fc.record({ kind: fc.constant("assert" as const), slot: fc.integer({ min: 0, max: 3 }), time: fc.integer({ min: 0, max: 1000 }) }) },
    { weight: 1, arbitrary: fc.record({ kind: fc.constant("retract" as const), pick: fc.nat(1000) }) },
    { weight: 2, arbitrary: fc.record({ kind: fc.constant("declare" as const), id: fc.integer({ min: 0, max: 4 }), picks: fc.array(fc.nat(1000), { minLength: 1, maxLength: 3 }) }) },
  );

  it("holds for random sequences of assertions, retractions and declarations", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(opArb, { minLength: 1, maxLength: 40 }), async (ops) => {
        const w = memoryWorld();
        await device(w, "K1");
        await device(w, "K2");
        const slots = [
          [D, "a"],
          [D, "b"],
          ["device:fda:K2", "a"],
          ["device:fda:K2", "b"],
        ] as const;
        const facts: { id: string; slot: number; time: number; seq: number; retracted: boolean }[] = [];
        const findings = new Map<string, { refs: string[]; stale: boolean }>();
        const usedTimes = new Set<number>();
        const winner = (slot: number) =>
          facts
            .filter((f) => f.slot === slot && !f.retracted)
            .sort((x, y) => y.time - x.time || y.seq - x.seq)[0]?.id ?? null;
        const winners = () => slots.map((_, i) => winner(i));
        let counter = 0;

        for (const op of ops) {
          if (op.kind === "assert") {
            let time = op.time;
            // Distinct observation times, so that "the same fact" is never asserted twice and the oracle needs no tie rule.
            while (usedTimes.has(time)) time++;
            usedTimes.add(time);
            const before = winners();
            const [about, predicate] = slots[op.slot]!;
            const fact = await w.assertFact({ about, predicate, value: `v${counter++}`, source: T(new Date(Date.UTC(2026, 0, 1) + time * 3_600_000).toISOString()) });
            facts.push({ id: fact.id, slot: op.slot, time, seq: facts.length, retracted: false });
            const after = winners();
            slots.forEach((_, s) => {
              if (before[s] === after[s]) return;
              for (const f of findings.values()) if (f.refs.some((r) => facts.find((x) => x.id === r)?.slot === s)) f.stale = true;
            });
          } else if (op.kind === "retract") {
            const live = facts.filter((f) => !f.retracted);
            if (live.length === 0) continue;
            const target = live[op.pick % live.length]!;
            const before = winners();
            await w.retractFact({ factId: target.id, source: T("2027-01-01T00:00:00.000Z") });
            target.retracted = true;
            const after = winners();
            for (const f of findings.values()) {
              if (f.refs.includes(target.id)) f.stale = true;
              if (f.refs.some((r) => { const slot = facts.find((x) => x.id === r)!.slot; return before[slot] !== after[slot]; })) f.stale = true;
            }
          } else {
            if (facts.length === 0) continue;
            const refs = [...new Set(op.picks.map((p) => facts[p % facts.length]!.id))];
            await w.declareDependencies({ findingId: `finding-${op.id}`, refs });
            findings.set(`finding-${op.id}`, { refs, stale: false });
          }
        }
        const expected = [...findings.entries()].filter(([, f]) => f.stale).map(([id]) => id).sort();
        expect(w.staleFindings()).toEqual(expected);
        // Precision: every finding the engine flags depends on something that changed.
        for (const id of w.staleFindings()) expect(w.dependentsOf(w.finding(id)!.refs)).toContain(id);
        w.close();
      }),
      { numRuns: 150 },
    );
  });
});
