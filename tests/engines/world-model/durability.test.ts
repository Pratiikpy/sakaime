import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { type GraphView, WorldModel, entityIdFromName, normalizeName, factId, relationshipId, contextIdFromAttrs } from "../../../src/engines/world-model/index.ts";
import * as Ref from "../../../third_party/meterless/world-model/reference/src/index.ts";
import * as RefIds from "../../../third_party/meterless/world-model/reference/src/stableIds.ts";
import { T, device, memoryWorld, steppedClock, tempDir } from "./helpers.ts";

const at = "2026-01-01T00:00:00.000Z";
const obs = (externalId: string, over: Record<string, unknown> = {}) => ({
  externalId,
  title: `Item ${externalId}`,
  at,
  source: { kind: "rss", at },
  entities: [{ type: "person", name: "Jerome Powell" }],
  ...over,
});

describe("idempotency keys on writes: a resumed run never repeats a write", () => {
  it("the same key and payload returns the original result and appends nothing", async () => {
    const w = memoryWorld();
    await device(w, "K1");
    const input = { about: "device:fda:K1", predicate: "p", value: 1, source: T(at), idempotencyKey: "run-7/step-3" };
    const first = await w.assertFact(input);
    const count = w.eventLog().length;
    const again = await w.assertFact(input);
    expect(again.id).toBe(first.id);
    expect(w.eventLog().length).toBe(count);
  });

  it("covers entities, relationships, retraction, dependencies and merge-free writes", async () => {
    const w = memoryWorld();
    const make = () => w.upsertEntity({ type: "device", name: "Aidoc", source: T(at), idempotencyKey: "k-entity" });
    const e1 = await make();
    const n = w.eventLog().length;
    expect((await make()).id).toBe(e1.id);
    expect(w.eventLog().length).toBe(n);

    await device(w, "K1");
    const fact = await w.assertFact({ about: "device:fda:K1", predicate: "p", value: 1, source: T(at) });
    const retract = () => w.retractFact({ factId: fact.id, source: T("2026-02-01T00:00:00.000Z"), idempotencyKey: "k-retract" });
    await retract();
    const m = w.eventLog().length;
    await retract();
    expect(w.eventLog().length).toBe(m);

    const dep = () => w.declareDependencies({ findingId: "f", refs: [fact.id], idempotencyKey: "k-dep" });
    await dep();
    const k = w.eventLog().length;
    await dep();
    expect(w.eventLog().length).toBe(k);
  });

  it("the same key with a different payload is refused, not silently accepted", async () => {
    const w = memoryWorld();
    await device(w, "K1");
    const base = { about: "device:fda:K1", predicate: "p", source: T(at), idempotencyKey: "reused" };
    await w.assertFact({ ...base, value: 1 });
    await expect(w.assertFact({ ...base, value: 2 })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(w.upsertEntity({ type: "x", name: "n", source: T(at), idempotencyKey: "reused" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  it("a key is remembered across a restart, and a replayed ingest is labelled as replayed", async () => {
    const dir = tempDir();
    const opts = { storage: "local" as const, namespace: "idem", directory: dir };
    const w = new WorldModel(opts);
    const first = await w.ingest([obs("a1")], { idempotencyKey: "ingest-1" });
    expect(first.replayed).toBeUndefined();
    const count = w.eventLog().length;
    w.close();
    const again = new WorldModel(opts);
    const replay = await again.ingest([obs("a1")], { idempotencyKey: "ingest-1" });
    expect(replay).toMatchObject({ runId: first.runId, processed: 1, replayed: true });
    expect(again.eventLog().length).toBe(count);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a failed write does not consume its key", async () => {
    const w = memoryWorld();
    await expect(w.assertFact({ about: "device:fda:K1", predicate: "p", value: undefined as never, source: T(at), idempotencyKey: "retry-me" })).rejects.toBeDefined();
    const ok = await w.assertFact({ about: "device:fda:K1", predicate: "p", value: 1, source: T(at), idempotencyKey: "retry-me" });
    expect(ok.value).toBe(1);
  });
});

describe("ingest", () => {
  it("is idempotent and reports what it did", async () => {
    const w = memoryWorld();
    const first = await w.ingest([obs("a1"), obs("a2")]);
    expect(first).toMatchObject({ processed: 2, skippedUnchanged: 0, changed: true });
    const shape = w.stateShapeCanonical();
    const second = await w.ingest([obs("a1"), obs("a2")]);
    expect(second).toMatchObject({ processed: 0, skippedUnchanged: 2, changed: false, eventsAppended: 0 });
    expect(w.stateShapeCanonical()).toBe(shape);
  });

  it("an edited observation is reprocessed and the shape changes", async () => {
    const w = memoryWorld();
    await w.ingest([obs("a1")]);
    const shape = w.stateShapeCanonical();
    const run = await w.ingest([obs("a1", { title: "Item a1 (edited)" })]);
    expect(run).toMatchObject({ processed: 1, changed: true });
    expect(w.stateShapeCanonical()).not.toBe(shape);
  });

  it("an edit that drops an entity ends the mention edge; one that adds an entity adds an edge; the earlier state stays readable with asOf", async () => {
    const t = steppedClock("2026-01-10T00:00:00.000Z");
    const w = new WorldModel({ storage: "memory", namespace: "t", clock: t.clock });
    await w.ingest([obs("a1", { entities: [{ type: "person", name: "Jerome Powell" }, { type: "org", name: "Federal Reserve" }] })]);
    const item = "item:ingest:a1";
    expect(w.view("graph").outgoing(item, { via: "mentions" })).toHaveLength(2);
    t.set("2026-02-10T00:00:00.000Z");
    await w.ingest([obs("a1", { entities: [{ type: "org", name: "Federal Reserve" }, { type: "org", name: "Treasury" }] })]);
    const names = (g: GraphView) => g.outgoing(item, { via: "mentions" }).map((e) => e.name).sort();
    expect(names(w.view("graph"))).toEqual(["Federal Reserve", "Treasury"]);
    expect(names(w.asOf("2026-01-20").graph)).toEqual(["Federal Reserve", "Jerome Powell"]);
  });

  it("an article that mentions several entities keeps every mention edge open", async () => {
    const w = memoryWorld();
    await w.ingest([obs("a1", { entities: [{ type: "person", name: "A Person" }, { type: "person", name: "Other Human" }, { type: "org", name: "Some Org" }] })]);
    expect(w.view("graph").outgoing("item:ingest:a1", { via: "mentions" })).toHaveLength(3);
  });

  it("validates the whole batch before writing anything", async () => {
    const w = memoryWorld();
    const before = w.eventLog().length;
    await expect(w.ingest([obs("ok"), obs("bad", { at: "yesterday" })])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.ingest([obs("ok"), obs("bad", { title: "" })])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.ingest([obs("ok"), obs("bad", { entities: [{ type: "person" }] })])).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.ingest([obs("ok"), obs("bad", { source: undefined })])).rejects.toMatchObject({ code: "PROVENANCE_REQUIRED" });
    await expect(w.ingest("nope" as never)).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(w.eventLog().length).toBe(before);
  });

  it("is atomic: a failure part way through leaves nothing behind and the store usable", async () => {
    let calls = 0;
    const w = memoryWorld({
      resolver: {
        resolve() {
          if (++calls === 3) throw new Error("resolver unavailable");
          return { action: "new" as const };
        },
      },
    });
    await device(w, "K1");
    const events = w.eventLog().length;
    const shape = w.stateShapeCanonical();
    const batch = [obs("a1", { entities: [{ type: "person", name: "One Name" }] }), obs("a2", { entities: [{ type: "person", name: "Two Name" }, { type: "person", name: "Three Name" }] })];
    await expect(w.ingest(batch)).rejects.toThrow(/resolver unavailable/);
    expect(w.eventLog().length).toBe(events);
    expect(w.stateShapeCanonical()).toBe(shape);
    // The same batch now succeeds, so the failed attempt left no half-written observation to skip.
    const run = await w.ingest(batch);
    expect(run.processed).toBe(2);
    expect(w.view("graph").outgoing("item:ingest:a2", { via: "mentions" })).toHaveLength(2);
  });

  it("a write that fails inside the transaction leaves the log as it was after a reopen too", async () => {
    const dir = tempDir();
    const opts = { storage: "local" as const, namespace: "atomic", directory: dir };
    let fail = false;
    const w = new WorldModel({ ...opts, resolver: { resolve: () => (fail ? (() => { throw new Error("boom"); })() : { action: "new" as const }) } });
    await w.ingest([obs("a1")]);
    fail = true;
    await expect(w.ingest([obs("a2", { entities: [{ type: "person", name: "Someone New" }] })])).rejects.toThrow(/boom/);
    const shape = w.stateShapeCanonical();
    w.close();
    const reopened = new WorldModel({ ...opts });
    expect(reopened.stateShapeCanonical()).toBe(shape);
    reopened.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("the log is append-only and is the only truth", () => {
  it("the database refuses UPDATE and DELETE on events, even from another connection", async () => {
    const dir = tempDir();
    const w = new WorldModel({ storage: "local", namespace: "append", directory: dir });
    await device(w, "K1");
    w.close();
    const raw = new DatabaseSync(path.join(dir, ".world", "append.sqlite"));
    expect(() => raw.exec("UPDATE events SET summary = 'tampered'")).toThrow(/append-only/);
    expect(() => raw.exec("DELETE FROM events")).toThrow(/append-only/);
    expect((raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n).toBeGreaterThan(0);
    raw.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("state is rebuilt from events alone: wiping nothing but reopening reproduces the shape", async () => {
    const dir = tempDir();
    const opts = { storage: "local" as const, namespace: "rebuild", directory: dir };
    const w = new WorldModel(opts);
    await w.ingest([obs("a1"), obs("a2", { entities: [{ type: "person", name: "Jerome Powel" }] })]);
    await device(w, "K1");
    await w.assertFact({ about: "device:fda:K1", predicate: "p", value: 1, source: T(at) });
    await w.approveMerge(w.mergeQueue()[0]!.id, "reviewer-1");
    const shape = w.stateShapeCanonical();
    const audit = w.audit().map((a) => `${a.seq}:${a.kind}:${a.summary}`);
    w.close();
    const again = new WorldModel(opts);
    expect(again.stateShapeCanonical()).toBe(shape);
    expect(again.audit().map((a) => `${a.seq}:${a.kind}:${a.summary}`)).toEqual(audit);
    again.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("refuses a store written by a newer schema", () => {
    const dir = tempDir();
    const w = new WorldModel({ storage: "local", namespace: "future", directory: dir });
    w.close();
    const raw = new DatabaseSync(path.join(dir, ".world", "future.sqlite"));
    raw.exec("UPDATE meta SET value = '99' WHERE key = 'schema_version'");
    raw.close();
    expect(() => new WorldModel({ storage: "local", namespace: "future", directory: dir })).toThrow(/schema 99/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("a closed store refuses writes with a typed error", async () => {
    const w = memoryWorld();
    w.close();
    await expect(w.upsertEntity({ type: "x", name: "n", source: T(at) })).rejects.toMatchObject({ code: "CLOSED" });
  });
});

describe("ordering and audit", () => {
  it("un-awaited concurrent writes serialise in call order", async () => {
    const w = memoryWorld();
    const names = ["Alpha One", "Bravo Two", "Delta Four", "Zulu Nine", "Kilo Eleven"];
    await Promise.all(names.map((n) => w.upsertEntity({ type: "x", name: n, source: T(at) })));
    const audit = w.audit();
    expect(audit.map((a) => a.seq)).toEqual([...audit.map((a) => a.seq)].sort((x, y) => x - y));
    expect(audit.slice(-5).map((a) => a.summary.split(" ")[0])).toEqual(names.map((n) => entityIdFromName("x", n)));
  });

  it("every mutation is audited with its kind, actor and event id", async () => {
    const w = memoryWorld();
    await w.upsertEntity({ type: "x", name: "Audit One", source: { kind: "manual", at, by: "reviewer-1" } });
    const [entry] = w.audit();
    expect(entry).toMatchObject({ seq: 1, kind: "upsertEntity", actor: "reviewer-1", eventId: "evt_1" });
  });

  it("subscribers receive each event once, after the write committed, and not for a rolled-back write", async () => {
    const w = memoryWorld();
    const seen: string[] = [];
    const off = w.subscribeEvents((e) => seen.push(e.kind));
    await device(w, "K1");
    await expect(w.assertFact({ about: "device:fda:K1", predicate: "p", value: undefined as never, source: T(at) })).rejects.toBeDefined();
    expect(seen).toEqual(["upsertEntity"]);
    off();
    await device(w, "K2");
    expect(seen).toEqual(["upsertEntity"]);
  });

  it("custom views fold over matching events", async () => {
    const w = memoryWorld();
    w.registerView("entity-count", { events: ["upsertEntity"], initialState: { n: 0 }, reducer: (s: { n: number }) => ({ n: s.n + 1 }) });
    await device(w, "K1");
    await device(w, "K2");
    expect(w.view("entity-count").get()).toEqual({ n: 2 });
    expect(() => w.view("missing")).toThrow(/unknown view/);
  });
});

describe("failure-first inputs", () => {
  it("rejects writes without provenance, with an unusable name, or without a type", async () => {
    const w = memoryWorld();
    await expect(w.upsertEntity({ type: "person", name: "x", source: undefined as never })).rejects.toMatchObject({ code: "PROVENANCE_REQUIRED" });
    await expect(w.upsertEntity({ type: "person", name: "x", source: { kind: "", at } })).rejects.toMatchObject({ code: "PROVENANCE_REQUIRED" });
    await expect(w.upsertEntity({ type: "person", name: "x", source: { kind: "manual" } as never })).rejects.toMatchObject({ code: "PROVENANCE_REQUIRED" });
    await expect(w.upsertEntity({ type: "person", name: "  ", source: T(at) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.upsertEntity({ type: "person", source: T(at) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.upsertEntity({ type: "", name: "x", source: T(at) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await expect(w.upsertEntity({ type: "p", externalKey: { system: "", id: "1" }, source: T(at) })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(w.eventLog()).toHaveLength(0);
  });

  it("a constructor without a namespace, or with a single-valued mentions type, is refused", () => {
    expect(() => new WorldModel({ namespace: "" })).toThrow(/namespace/);
    expect(() => new WorldModel({ namespace: "n", relationshipTypes: { mentions: { cardinality: "one" } } })).toThrow(/mentions/);
  });
});

describe("identifiers agree with the reference where the specification pins them", () => {
  const names = ["Jerome Powell", "José  García", "Acme Corp", "Acme Corporation", "ＡＢＣ Ｃorp", "Ünïcödé Nâme", "zero​width", " padded  name ", ""];
  it("normaliseName and entityIdFromName produce the reference's values", () => {
    for (const n of names) {
      expect(normalizeName(n)).toBe(Ref.normalizeName(n));
      expect(entityIdFromName("org", n)).toBe(Ref.entityIdFromName("org", n));
    }
  });

  it("relationship, fact and context identifiers produce the reference's values", () => {
    expect(relationshipId("a", "t", "b", "c", "2026-01-01T00:00:00.000Z")).toBe(RefIds.relationshipId("a", "t", "b", "c", "2026-01-01T00:00:00.000Z"));
    expect(relationshipId("a", "t", "b")).toBe(RefIds.relationshipId("a", "t", "b"));
    expect(factId("a", "p", { z: 1, a: [1, 2] }, at, "rss", "https://x")).toBe(RefIds.factId("a", "p", { z: 1, a: [1, 2] }, at, "rss", "https://x"));
    expect(contextIdFromAttrs("week", { n: 14 }, "season:g:145")).toBe(RefIds.contextIdFromAttrs("week", { n: 14 }, "season:g:145"));
  });
});
