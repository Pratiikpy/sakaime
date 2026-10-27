import { describe, expect, it } from "vitest";
import {
  type IdentityResolver,
  WorldModel,
  createBandResolver,
  decide,
  entityIdFromName,
  nameSimilarity,
} from "../../../src/engines/world-model/index.ts";
import { T, memoryWorld } from "./helpers.ts";

const at = "2026-01-01T00:00:00.000Z";
const obs = (externalId: string, name: string, type = "person") => ({
  externalId,
  title: `Item ${externalId}`,
  at,
  source: { kind: "rss", at },
  entities: [{ type, name }],
});

describe("merge bands", () => {
  it("decide() keeps the sponsor's boundaries and accepts the thresholds as options", () => {
    expect([decide(0.85), decide(0.84), decide(0.82), decide(0.81)]).toEqual(["auto-merge", "review", "review", "new"]);
    expect(decide(0.9, 0.95, 0.9)).toBe("review");
    expect(decide(0.95, 0.95, 0.9)).toBe("auto-merge");
  });

  it("similarity is computed on normalised names", () => {
    expect(nameSimilarity("José  García", "jose garcia")).toBe(1);
    expect(nameSimilarity("Jerome Powell", "Jerome Powel")).toBeCloseTo(12 / 13, 10);
    expect(nameSimilarity("", "")).toBe(1);
  });
});

describe("device auto-merge is disabled: everything in the band goes to review", () => {
  it("a name at 0.92 similarity, above the auto-merge threshold, is queued and not merged", async () => {
    const w = memoryWorld();
    const a = await w.upsertEntity({ type: "device", name: "Jerome Powell", source: T(at) });
    expect(nameSimilarity("Jerome Powell", "Jerome Powel")).toBeGreaterThanOrEqual(0.85);
    const b = await w.upsertEntity({ type: "device", name: "Jerome Powel", source: T(at) });
    expect(b.id).not.toBe(a.id);
    expect(w.view("graph").query({ type: "device" })).toHaveLength(2);
    const [p] = w.mergeQueue();
    expect(p).toMatchObject({ status: "pending", leftId: b.id, rightId: a.id });
    expect(p!.reason).toMatch(/never merged without review/);
  });

  it("a name in the 0.82 to 0.85 band is queued with the band named in the reason", async () => {
    const w = memoryWorld();
    await w.upsertEntity({ type: "device", name: "abcdefghijklmnopqrst", source: T(at) });
    // 20 characters, 3 edits: similarity 0.85 exactly is auto band; 3.5 edits are not possible, so use 17/20 = 0.85 and 16/20 = 0.8.
    await w.upsertEntity({ type: "device", name: "abcdefghijklmnopqXYZ", source: T(at) });
    expect(nameSimilarity("abcdefghijklmnopqrst", "abcdefghijklmnopqXYZ")).toBeCloseTo(0.85, 10);
    expect(w.mergeQueue()).toHaveLength(1);
  });

  it("names below the review band never create a proposal", async () => {
    const w = memoryWorld();
    await w.upsertEntity({ type: "device", name: "Aidoc BriefCase", source: T(at) });
    await w.upsertEntity({ type: "device", name: "Viz LVO", source: T(at) });
    expect(w.mergeQueue()).toHaveLength(0);
  });

  it("the same name in a different type is a different entity and is not compared", async () => {
    const w = memoryWorld();
    await w.upsertEntity({ type: "device", name: "Aidoc BriefCase", source: T(at) });
    await w.upsertEntity({ type: "org", name: "Aidoc BriefCase", source: T(at) });
    expect(w.mergeQueue()).toHaveLength(0);
  });

  it("spelling variants that normalise to the same name are the same entity, with no proposal", async () => {
    const w = memoryWorld();
    const a = await w.upsertEntity({ type: "person", name: "José García", source: T(at) });
    const b = await w.upsertEntity({ type: "person", name: "jose  garcia", source: T(at) });
    expect(b.id).toBe(a.id);
    expect(w.mergeQueue()).toHaveLength(0);
  });

  it("types listed in autoMergeTypes may merge at or above the threshold; others still go to review", async () => {
    const w = memoryWorld({ resolver: { autoMergeTypes: ["org"] } });
    const o1 = await w.upsertEntity({ type: "org", name: "Federal Reserve Board", source: T(at) });
    const o2 = await w.upsertEntity({ type: "org", name: "Federal Reserve Boad", source: T(at) });
    expect(o2.id).toBe(o1.id);
    expect(w.mergeQueue()).toHaveLength(0);
    expect(w.audit().some((a) => a.kind === "alias" && a.actor === "resolver")).toBe(true);
    const d1 = await w.upsertEntity({ type: "device", name: "Federal Reserve Board", source: T(at) });
    const d2 = await w.upsertEntity({ type: "device", name: "Federal Reserve Boad", source: T(at) });
    expect(d2.id).not.toBe(d1.id);
    expect(w.mergeQueue()).toHaveLength(1);
  });

  it("the review band can be moved, and a band that makes no sense is refused", async () => {
    const w = memoryWorld({ resolver: { autoMergeAt: 0.97, reviewLower: 0.95 } });
    await w.upsertEntity({ type: "person", name: "Jerome Powell", source: T(at) });
    await w.upsertEntity({ type: "person", name: "Jerome Powel", source: T(at) });
    expect(nameSimilarity("Jerome Powell", "Jerome Powel")).toBeLessThan(0.95);
    expect(w.mergeQueue()).toHaveLength(0);
    expect(() => createBandResolver({ autoMergeAt: 0.8, reviewLower: 0.9 })).toThrow(RangeError);
    expect(() => createBandResolver({ reviewLower: Number.NaN })).toThrow(RangeError);
  });
});

describe("ingestion goes through the injected resolver", () => {
  it("near-duplicate mentions arriving by ingest are queued, not skipped and not merged", async () => {
    const w = memoryWorld();
    await w.ingest([obs("a1", "Jerome Powell"), obs("a2", "Jerome Powel")]);
    expect(w.view("graph").query({ type: "person" })).toHaveLength(2);
    expect(w.mergeQueue()).toHaveLength(1);
  });

  it("an injected resolver decides, and sees the existing entities of the same type with their aliases", async () => {
    const seen: string[][] = [];
    const resolver: IdentityResolver = {
      resolve(query, existing) {
        seen.push(existing.map((e) => e.name));
        const hit = existing.find((e) => e.name.toLowerCase() === "powell, jerome" && query.name === "Jerome Powell");
        return hit ? { action: "match", entityId: hit.id, similarity: 1, reason: "authoritative alias table" } : { action: "new" };
      },
    };
    const w = memoryWorld({ resolver });
    const first = await w.upsertEntity({ type: "person", name: "Powell, Jerome", source: T(at) });
    await w.ingest([obs("a1", "Jerome Powell")]);
    expect(seen.at(-1)).toContain("Powell, Jerome");
    const people = w.view("graph").query({ type: "person" });
    expect(people.map((p) => p.id)).toEqual([first.id]);
    expect(w.view("graph").entity(entityIdFromName("person", "Jerome Powell"))?.id).toBe(first.id);
    // The mention edge points at the survivor.
    expect(w.view("graph").incoming(first.id, { via: "mentions" }).map((e) => e.type)).toEqual(["item"]);
  });

  it("externally keyed entities are never passed to the resolver", async () => {
    let calls = 0;
    const w = memoryWorld({ resolver: { resolve: () => (calls++, { action: "new" as const }) } });
    await w.upsertEntity({ type: "device", externalKey: { system: "fda", id: "K1" }, name: "Aidoc", source: T(at) });
    await w.upsertEntity({ type: "device", externalKey: { system: "fda", id: "K2" }, name: "Aidoc", source: T(at) });
    expect(calls).toBe(0);
  });
});

describe("the merge queue", () => {
  async function queued() {
    const w = memoryWorld();
    const a = await w.upsertEntity({ type: "person", name: "Jerome Powell", source: T(at) });
    const b = await w.upsertEntity({ type: "person", name: "Jerome Powel", source: T(at) });
    return { w, a, b, id: w.mergeQueue()[0]!.id };
  }

  it("approving a proposal merges: the left id resolves to the right and the survivor gains the names", async () => {
    const { w, a, b, id } = await queued();
    await w.approveMerge(id, "reviewer-1");
    expect(w.view("graph").entity(b.id)?.id).toBe(a.id);
    expect(w.view("graph").entity(a.id)?.aliases).toEqual(expect.arrayContaining(["Jerome Powell", "Jerome Powel"]));
    expect(w.view("graph").query({ type: "person" })).toHaveLength(1);
    expect(w.mergeQueue()[0]).toMatchObject({ status: "approved", resolvedBy: "reviewer-1" });
  });

  it("rejecting keeps both, records the decision and never asks again", async () => {
    const { w, id } = await queued();
    await w.rejectMerge(id, "reviewer-1");
    expect(w.view("graph").query({ type: "person" })).toHaveLength(2);
    await w.upsertEntity({ type: "person", name: "Jerome Powel", source: T(at) });
    await w.ingest([obs("a1", "Jerome Powel")]);
    expect(w.mergeQueue()).toHaveLength(1);
    expect(w.mergeQueue()[0]).toMatchObject({ status: "rejected" });
  });

  it("a proposal can be decided once, needs a reviewer, and an unknown id is refused", async () => {
    const { w, id } = await queued();
    await expect(w.approveMerge(id, "")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await w.approveMerge(id, "reviewer-1");
    await expect(w.approveMerge(id, "reviewer-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(w.rejectMerge("merge_99", "reviewer-1")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("the same pair is not proposed twice however often the name is seen", async () => {
    const { w } = await queued();
    for (let i = 0; i < 3; i++) await w.upsertEntity({ type: "person", name: "Jerome Powel", source: T(at) });
    expect(w.mergeQueue()).toHaveLength(1);
  });

  it("the band resolver is usable on its own", () => {
    const resolver = createBandResolver();
    const out = resolver.resolve({ type: "device", name: "Aidoc BriefCase CSpine" }, [{ id: "d1", type: "device", name: "Aidoc BriefCase CSpine v2", aliases: [] }]);
    expect(out.action).toBe("review");
    expect(resolver.resolve({ type: "device", name: "Something else entirely" }, [{ id: "d1", type: "device", name: "Aidoc BriefCase", aliases: [] }])).toEqual({ action: "new" });
  });
});
