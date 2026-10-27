import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SAKAIME_RELATIONSHIP_TYPES, WorldModel } from "../../../src/engines/world-model/index.ts";
import { T, device, memoryWorld, steppedClock, study } from "./helpers.ts";

const world = () => memoryWorld({ relationshipTypes: SAKAIME_RELATIONSHIP_TYPES });
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("relationship cardinality is a per-type setting", () => {
  it("a many-valued type keeps every target open (a device with two studies)", async () => {
    const w = world();
    await device(w, "K1");
    await study(w, "NCT1");
    await study(w, "NCT2");
    await w.relate({ from: "device:fda:K1", type: "evaluated-in", to: "study:nct:NCT1", validFrom: "2026-01-01T00:00:00.000Z", source: T("2026-01-01T00:00:00.000Z") });
    await w.relate({ from: "device:fda:K1", type: "evaluated-in", to: "study:nct:NCT2", validFrom: "2026-02-01T00:00:00.000Z", source: T("2026-02-01T00:00:00.000Z") });
    expect(ids(w.view("graph").neighborsOf("device:fda:K1", { via: "evaluated-in" }))).toEqual(["study:nct:NCT1", "study:nct:NCT2"]);
    expect(ids(w.view("graph").neighborsOf("device:fda:K1", { via: "evaluated-in", at: "2026-01-15" }))).toEqual(["study:nct:NCT1"]);
  });

  it("a single-valued type closes the earlier edge when a different target starts later", async () => {
    const w = world();
    await device(w, "K1");
    await study(w, "V1");
    await study(w, "V2");
    const first = await w.relate({ from: "device:fda:K1", type: "describes-version", to: "study:nct:V1", validFrom: "2026-01-01T00:00:00.000Z", source: T("2026-01-01T00:00:00.000Z") });
    const second = await w.relate({ from: "device:fda:K1", type: "describes-version", to: "study:nct:V2", validFrom: "2026-03-01T00:00:00.000Z", source: T("2026-03-01T00:00:00.000Z") });
    const g = w.view("graph");
    expect(ids(g.neighborsOf("device:fda:K1", { via: "describes-version" }))).toEqual(["study:nct:V2"]);
    expect(ids(g.neighborsOf("device:fda:K1", { via: "describes-version", at: "2026-02-01" }))).toEqual(["study:nct:V1"]);
    const closed = g.edgesOf("device:fda:K1", { via: "describes-version", at: "2026-02-01" })[0]!;
    expect(closed.id).toBe(first.id);
    expect(closed.validTo).toBe("2026-03-01T00:00:00.000Z");
    expect(closed.supersededBy).toBe(second.id);
  });

  it("types that were never declared are single-valued, as the sponsor's runner expects", async () => {
    const w = memoryWorld();
    await device(w, "K1");
    await study(w, "A");
    await study(w, "B");
    await w.relate({ from: "device:fda:K1", type: "undeclared", to: "study:nct:A", validFrom: "2026-01-01T00:00:00.000Z", source: T("2026-01-01T00:00:00.000Z") });
    await w.relate({ from: "device:fda:K1", type: "undeclared", to: "study:nct:B", validFrom: "2026-02-01T00:00:00.000Z", source: T("2026-02-01T00:00:00.000Z") });
    expect(ids(w.view("graph").neighborsOf("device:fda:K1", { via: "undeclared" }))).toEqual(["study:nct:B"]);
  });

  it("history that arrives late is closed by the later edge instead of closing it", async () => {
    const w = world();
    await device(w, "K1");
    await study(w, "V1");
    await study(w, "V2");
    await w.relate({ from: "device:fda:K1", type: "describes-version", to: "study:nct:V2", validFrom: "2026-03-01T00:00:00.000Z", source: T("2026-03-01T00:00:00.000Z") });
    await w.relate({ from: "device:fda:K1", type: "describes-version", to: "study:nct:V1", validFrom: "2026-01-01T00:00:00.000Z", source: T("2026-03-05T00:00:00.000Z") });
    const g = w.view("graph");
    expect(ids(g.neighborsOf("device:fda:K1", { via: "describes-version" }))).toEqual(["study:nct:V2"]);
    expect(ids(g.neighborsOf("device:fda:K1", { via: "describes-version", at: "2026-02-01" }))).toEqual(["study:nct:V1"]);
    for (const e of g.edgesOf("device:fda:K1", { via: "describes-version", at: "2026-02-01" })) expect(e.validTo! >= e.validFrom).toBe(true);
  });

  it("the effective validity of a single-valued group does not depend on arrival order", async () => {
    const targets = ["A", "B", "C", "D"];
    const starts = ["2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", "2026-04-01T00:00:00.000Z"];
    const outcome = async (order: number[]) => {
      const w = world();
      await device(w, "K1");
      for (const t of targets) await study(w, t);
      for (const i of order) {
        await w.relate({ from: "device:fda:K1", type: "describes-version", to: `study:nct:${targets[i]}`, validFrom: starts[i]!, source: T(starts[i]!) });
      }
      return JSON.stringify(
        w
          .view("graph")
          .edgesOf("device:fda:K1", { via: "describes-version", at: "2026-02-15" })
          .map((e) => [e.to, e.validFrom, e.validTo ?? null]),
      ) + JSON.stringify(ids(w.view("graph").neighborsOf("device:fda:K1", { via: "describes-version" })));
    };
    const reference = await outcome([0, 1, 2, 3]);
    await fc.assert(
      fc.asyncProperty(fc.shuffledSubarray([0, 1, 2, 3], { minLength: 4, maxLength: 4 }), async (order) => {
        expect(await outcome(order)).toBe(reference);
      }),
      { numRuns: 30 },
    );
  });

  it("re-observing the same link is a no-op and does not extend or duplicate it", async () => {
    const w = world();
    await device(w, "K1");
    await study(w, "NCT1");
    const a = await w.relate({ from: "device:fda:K1", type: "evaluated-in", to: "study:nct:NCT1", source: T("2026-01-01T00:00:00.000Z") });
    const events = w.eventLog().length;
    const b = await w.relate({ from: "device:fda:K1", type: "evaluated-in", to: "study:nct:NCT1", source: T("2026-01-01T00:00:00.000Z") });
    expect(b.id).toBe(a.id);
    expect(w.eventLog().length).toBe(events);
  });

  it("endRelationship closes a link at a valid time and the link stays in earlier views", async () => {
    const w = world();
    await device(w, "K1");
    await study(w, "NCT1");
    const rel = await w.relate({ from: "device:fda:K1", type: "evaluated-in", to: "study:nct:NCT1", validFrom: "2026-01-01T00:00:00.000Z", source: T("2026-01-01T00:00:00.000Z") });
    await w.endRelationship({ id: rel.id, validTo: "2026-06-01T00:00:00.000Z", source: T("2026-06-02T00:00:00.000Z"), reason: "link retracted by the vendor" });
    const g = w.view("graph");
    expect(g.neighborsOf("device:fda:K1", { via: "evaluated-in" })).toHaveLength(0);
    expect(ids(g.neighborsOf("device:fda:K1", { via: "evaluated-in", at: "2026-03-01" }))).toEqual(["study:nct:NCT1"]);
    await expect(w.endRelationship({ id: "rel_missing", validTo: "2026-06-01T00:00:00.000Z", source: T("2026-06-02T00:00:00.000Z") })).rejects.toThrow(/no relationship/);
  });

  it("refuses an edge that ends before it starts, an edge to an entity that does not exist, and a missing context", async () => {
    const w = world();
    await device(w, "K1");
    await study(w, "NCT1");
    const base = { from: "device:fda:K1", type: "evaluated-in", to: "study:nct:NCT1", source: T("2026-01-01T00:00:00.000Z") };
    await expect(w.relate({ ...base, validFrom: "2026-03-01T00:00:00.000Z", validTo: "2026-02-01T00:00:00.000Z" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.relate({ ...base, to: "study:nct:GHOST" })).rejects.toMatchObject({ code: "UNKNOWN_ENTITY" });
    await expect(w.relate({ ...base, context: "season:x:1" })).rejects.toMatchObject({ code: "UNKNOWN_ENTITY" });
  });

  it("edges follow a merge: the survivor sees the links of the entity merged into it", async () => {
    const w = world();
    await study(w, "NCT1");
    // Two name-keyed records of one product; the resolver queues them for review instead of merging.
    const a = await w.upsertEntity({ type: "device", name: "Aidoc BriefCase CSpine", source: T("2026-01-01T00:00:00.000Z") });
    const b = await w.upsertEntity({ type: "device", name: "Aidoc BriefCase CSpine v2", source: T("2026-01-01T00:00:00.000Z") });
    const proposal = w.mergeQueue()[0]!;
    await w.relate({ from: b.id, type: "evaluated-in", to: "study:nct:NCT1", source: T("2026-01-02T00:00:00.000Z") });
    await w.approveMerge(proposal.id, "reviewer-1");
    expect(ids(w.view("graph").neighborsOf(a.id, { via: "evaluated-in" }))).toEqual(["study:nct:NCT1"]);
    expect(w.view("graph").entity(b.id)?.id).toBe(a.id);
  });
});

describe("valid time and record time", () => {
  it("asOf answers what the store knew, which differs from what was true", async () => {
    const t = steppedClock("2026-02-01T00:00:00.000Z");
    const w = new WorldModel({ storage: "memory", namespace: "t", clock: t.clock });
    await w.upsertEntity({ type: "device", externalKey: { system: "fda", id: "K1" }, name: "K1", source: T("2026-01-01T00:00:00.000Z") });
    // Recorded 1 Feb about a state that was true from 1 Jan.
    await w.assertFact({ about: "device:fda:K1", predicate: "software", value: "v1", source: T("2026-01-01T00:00:00.000Z") });
    t.set("2026-04-01T00:00:00.000Z");
    // Recorded on 1 April, a correction saying that v1 had in fact been replaced on 15 Feb.
    await w.assertFact({ about: "device:fda:K1", predicate: "software", value: "v2", validFrom: "2026-02-15T00:00:00.000Z", source: T("2026-04-01T00:00:00.000Z") });

    // What was true on 1 March, as we know it now: v2.
    expect(w.view("snapshot").entityAt("device:fda:K1", "2026-03-01")?.attrs["software"]).toBe("v2");
    // What we knew on 1 March (before the correction was recorded), about 1 March: v1.
    expect(w.asOf("2026-03-01").snapshot.entityAt("device:fda:K1", "2026-03-01")?.attrs["software"]).toBe("v1");
    // What we knew on 2 April about 1 March: v2.
    expect(w.asOf("2026-04-02").snapshot.entityAt("device:fda:K1", "2026-03-01")?.attrs["software"]).toBe("v2");
    // What was true on 1 Feb is v1 whichever moment we ask from.
    expect(w.view("snapshot").entityAt("device:fda:K1", "2026-02-01")?.attrs["software"]).toBe("v1");
  });

  it("a date-only asOf includes everything recorded that day", async () => {
    const t = steppedClock("2026-03-01T17:30:00.000Z");
    const w = new WorldModel({ storage: "memory", namespace: "t", clock: t.clock });
    await w.upsertEntity({ type: "device", externalKey: { system: "fda", id: "K1" }, name: "K1", source: T("2026-03-01T00:00:00.000Z") });
    expect(w.asOf("2026-03-01").graph.entity("device:fda:K1")).toBeDefined();
    expect(w.asOf("2026-02-28").graph.entity("device:fda:K1")).toBeUndefined();
  });

  it("record time never goes backwards even if the injected clock does", async () => {
    const t = steppedClock("2026-05-01T00:00:00.000Z");
    const w = new WorldModel({ storage: "memory", namespace: "t", clock: t.clock });
    await w.upsertEntity({ type: "x", name: "one", source: T("2026-05-01T00:00:00.000Z") });
    t.set("2026-01-01T00:00:00.000Z");
    await w.upsertEntity({ type: "x", name: "two", source: T("2026-05-01T00:00:00.000Z") });
    const stamps = w.audit().map((a) => a.recordedAt);
    expect([...stamps].sort()).toEqual(stamps);
  });

  it("entity attributes keep their own valid-time history", async () => {
    const w = memoryWorld();
    await w.upsertEntity({ type: "player", externalKey: { system: "g", id: "p1" }, attrs: { name: "P One", overall: 87 }, source: T("2087-08-01T12:00:00.000Z") });
    await w.upsertEntity({ type: "player", externalKey: { system: "g", id: "p1" }, attrs: { overall: 94, tier: "all-pro" }, source: T("2088-01-20T12:00:00.000Z") });
    const s = w.view("snapshot");
    expect(s.entityAt("player:g:p1", "2087-08-15")?.attrs).toMatchObject({ overall: 87 });
    expect(s.entityAt("player:g:p1", "2087-08-15")?.attrs["tier"]).toBeUndefined();
    expect(s.entityAt("player:g:p1", "2088-02-01")?.attrs).toMatchObject({ overall: 94, tier: "all-pro" });
    expect(s.entityAt("player:g:p1", "2087-01-01")).toBeUndefined();
  });

  it("rejects a timestamp with no UTC offset and a date that does not exist", async () => {
    const w = memoryWorld();
    await expect(w.upsertEntity({ type: "x", name: "n", source: { kind: "manual", at: "2026-05-17T14:00:00" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.upsertEntity({ type: "x", name: "n", source: { kind: "manual", at: "2026-13-45" } })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(() => w.asOf("not a date")).toThrow(/asOf/);
  });
});
