import { describe, expect, it } from "vitest";
import { T, tempDir } from "./helpers.ts";
import { WorldModel } from "../../../src/engines/world-model/index.ts";
import * as Ref from "../../../third_party/meterless/world-model/reference/src/index.ts";

/**
 * Characterisation of the vendored sponsor reference. The engineering brief listed three of its
 * behaviours as "inferred from reading the source". These tests run the reference and our engine on
 * the same scenario, so each claim is either confirmed by an observation or reported as wrong.
 * They exercise the unmodified reference; they do not assert that the reference is badly built, only
 * what it does in the situations Sakaime depends on.
 */
const clock = () => new Date("2026-05-18T00:00:00.000Z");

describe("reference gap 4: fact resolution is lost on replay", () => {
  const scenario = async (W: any, dir: string) => {
    const open = () => new W({ storage: "local", namespace: "g4", directory: dir, conflictPolicy: "highest-confidence-wins", clock });
    const w = open();
    await w.upsertEntity({ type: "device", externalKey: { system: "fda", id: "K1" }, attrs: {}, source: T("2026-01-01T00:00:00.000Z") });
    await w.assertFact({ about: "device:fda:K1", predicate: "version", value: "v1", confidence: 0.9, source: T("2026-01-02T00:00:00.000Z") });
    await w.assertFact({ about: "device:fda:K1", predicate: "version", value: "v2", confidence: 0.5, source: T("2026-01-03T00:00:00.000Z") });
    const live = w.view("graph").entity("device:fda:K1")?.attrs?.version;
    return { live, reopen: () => open().view("graph").entity("device:fda:K1")?.attrs?.version, close: () => (w as any).close?.() };
  };

  it("the reference shows the winning value live but not after a restart", async () => {
    const run = await scenario(Ref.WorldModel, tempDir());
    expect(run.live).toBe("v1");
    expect(run.reopen()).toBeUndefined();
  });

  it("this engine returns the same winner before and after a restart", async () => {
    const run = await scenario(WorldModel, tempDir());
    run.close();
    expect(run.live).toBe("v1");
    expect(run.reopen()).toBe("v1");
  });
});

describe("reference gap 5: a many-valued relationship loses its earlier targets", () => {
  const scenario = async (W: any) => {
    const w = new W({ storage: "memory", namespace: "g5", clock, relationshipTypes: { "evaluated-in": { cardinality: "many" } } });
    for (const [type, system, id] of [["device", "fda", "K1"], ["study", "nct", "NCT1"], ["study", "nct", "NCT2"]]) {
      await w.upsertEntity({ type, externalKey: { system, id }, attrs: {}, source: T("2026-01-01T00:00:00.000Z") });
    }
    await w.relate({ from: "device:fda:K1", type: "evaluated-in", to: "study:nct:NCT1", validFrom: "2026-01-01T00:00:00.000Z", source: T("2026-01-01T00:00:00.000Z") });
    await w.relate({ from: "device:fda:K1", type: "evaluated-in", to: "study:nct:NCT2", validFrom: "2026-02-01T00:00:00.000Z", source: T("2026-02-01T00:00:00.000Z") });
    return w.view("graph").neighborsOf("device:fda:K1", { via: "evaluated-in" }).map((e: any) => e.id);
  };

  it("the reference closes the first study when the second is linked", async () => {
    expect(await scenario(Ref.WorldModel)).toEqual(["study:nct:NCT2"]);
  });

  it("this engine keeps both studies open for a many-valued type", async () => {
    expect(await scenario(WorldModel)).toEqual(["study:nct:NCT1", "study:nct:NCT2"]);
  });
});

describe("reference gap 6: ingest skips entity resolution", () => {
  const observations = [
    { externalId: "a1", title: "Fed holds rates", at: "2026-05-17T14:00:00.000Z", source: { kind: "rss", at: "2026-05-17T14:00:00.000Z" }, entities: [{ type: "person", name: "Jerome Powell" }] },
    { externalId: "a2", title: "Powell signals patience", at: "2026-05-17T16:30:00.000Z", source: { kind: "rss", at: "2026-05-17T16:30:00.000Z" }, entities: [{ type: "person", name: "Jerome Powel" }] },
  ];

  it("the reference creates two people and queues nothing for review", async () => {
    const w = new Ref.WorldModel({ storage: "memory", namespace: "g6", clock });
    await w.ingest(observations as any);
    expect(w.view("graph").query({ type: "person" })).toHaveLength(2);
    expect(w.mergeQueue()).toHaveLength(0);
  });

  it("this engine routes ingest through the resolver: two people, one pending review, no merge", async () => {
    const w = new WorldModel({ storage: "memory", namespace: "g6", clock });
    await w.ingest(observations as any);
    expect(w.view("graph").query({ type: "person" })).toHaveLength(2);
    expect(w.mergeQueue()).toHaveLength(1);
    expect(w.mergeQueue()[0]).toMatchObject({ status: "pending" });
  });
});
