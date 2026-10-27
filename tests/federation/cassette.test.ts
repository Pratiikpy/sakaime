import { existsSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CassettePort, CassetteStore, RecordingPort } from "../../src/federation/cassette.ts";
import { PortError } from "../../src/ports/index.ts";
import { livePort, startStub, wire, type Stub } from "./helpers/zetaris-stub.ts";

let stub: Stub;
let dir: string;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "sakaime-cassette-"));
});
afterEach(() => {
  stub.reset();
  rmSync(dir, { recursive: true, force: true });
});

async function failureOf(p: Promise<unknown>): Promise<PortError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}

const TABLE = wire(["team", "n"], [["payments", "3"], ["growth", null]]);
const STATEMENT = "SELECT team, n FROM ci_silo.pull_requests ORDER BY team";

/** Record one statement against the stub and return the store, the live result and the file written. */
async function record(statement = STATEMENT, identity?: string) {
  stub.handler = () => ({ body: TABLE });
  const store = new CassetteStore(dir);
  const { port } = livePort(stub);
  const recorder = new RecordingPort(port, store, { clock: { now: () => new Date("2026-10-27T05:00:00.000Z") } });
  const live = await recorder.sql(statement, identity ? { identity } : {});
  return { store, live, recorder, file: recorder.recorded[0]!.file };
}

describe("recording", () => {
  it("writes the wire form of a live response and returns the live result unchanged", async () => {
    const { live, file, recorder } = await record();
    expect(live.servedFrom).toBe("live");
    expect(existsSync(file)).toBe(true);
    const saved = JSON.parse(readFileSync(file, "utf8"));
    expect(saved).toMatchObject({ format: "sakaime.federation-cassette/1", statement: STATEMENT, identity: "default", recordedAt: "2026-10-27T05:00:00.000Z", columns: ["team", "n"], total: 2 });
    expect(saved.rawRows).toEqual([["payments", "3"], ["growth", null]]);
    expect(saved.respHash).toBe(live.respHash);
    expect(recorder.mode).toBe("live");
  });

  it("leaves no temporary file behind", async () => {
    await record();
    expect(readdirSync(dir).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(readdirSync(dir)).toHaveLength(1);
  });

  it("does not record a failure or a refused partial result", async () => {
    const store = new CassetteStore(dir);
    const { port } = livePort(stub, { maxAttempts: 1 });
    const recorder = new RecordingPort(port, store);
    stub.handler = () => ({ status: 503, text: "" });
    await failureOf(recorder.sql(STATEMENT));
    stub.handler = () => ({ body: wire(["n"], [["1"]], 99) });
    await failureOf(recorder.sql(STATEMENT));
    expect(recorder.recorded).toEqual([]);
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
  });

  it("keeps recordings of different identities apart", async () => {
    await record(STATEMENT, "default");
    const { file } = await record(STATEMENT, "reviewer");
    expect(readdirSync(dir)).toHaveLength(2);
    expect(JSON.parse(readFileSync(file, "utf8")).identity).toBe("reviewer");
  });
});

describe("replay", () => {
  it("serves the recorded response labelled cassette, with the hash and typing of the live one", async () => {
    const { store, live } = await record();
    const replay = new CassettePort({ store, schema: { n: "bigint" } });
    const r = await replay.sql(STATEMENT);
    expect(r.servedFrom).toBe("cassette");
    expect(r.respHash).toBe(live.respHash);
    expect(r.rows).toEqual([{ team: "payments", n: 3 }, { team: "growth", n: null }]);
    expect(r.recordedAt).toBe("2026-10-27T05:00:00.000Z");
    expect(r.queryId).toBe(live.queryId);
    expect(r.total).toBe(2);
  });

  it("does not contact any engine", async () => {
    const { store } = await record();
    const before = stub.requests.length;
    await new CassettePort({ store }).sql(STATEMENT);
    expect(stub.requests.length).toBe(before);
  });

  it("finds the recording whatever the formatting of the statement", async () => {
    const { store } = await record();
    const replay = new CassettePort({ store });
    for (const variant of [`${STATEMENT};`, "SELECT   team,\n   n\nFROM ci_silo.pull_requests   ORDER BY team ;", `${STATEMENT} -- note`]) {
      expect((await replay.sql(variant)).servedFrom, variant).toBe("cassette");
    }
  });

  it("finds a recording only for the identity that recorded it", async () => {
    const { store } = await record(STATEMENT, "reviewer");
    const replay = new CassettePort({ store });
    const e = await failureOf(replay.sql(STATEMENT)); // default identity was never recorded
    expect(e.detail?.["reason"]).toBe("CASSETTE_MISS");
    expect((await replay.sql(STATEMENT, { identity: "reviewer" })).servedFrom).toBe("cassette");
  });

  it("is an explicit error, not an invented answer, for a statement that was never recorded", async () => {
    const { store } = await record();
    const e = await failureOf(new CassettePort({ store }).sql("SELECT team FROM ci_silo.pull_requests"));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(e.detail).toMatchObject({ reason: "CASSETTE_MISS", retryable: false });
    expect(e.message).toContain("no recorded response");
  });

  it("is an explicit error when there is no recording directory at all", async () => {
    const e = await failureOf(new CassettePort({ store: new CassetteStore(join(dir, "nowhere")) }).sql("SELECT 1"));
    expect(e.detail?.["reason"]).toBe("CASSETTE_MISS");
  });

  it("applies the caller's limit to a replayed result", async () => {
    const { store } = await record();
    const e = await failureOf(new CassettePort({ store }).sql(STATEMENT, { limit: 1 }));
    expect(e.failure).toBe("TRUNCATED");
  });

  it("holds replay to the same refusals as the live port", async () => {
    const { store } = await record();
    const replay = new CassettePort({ store });
    expect((await failureOf(replay.sql("DROP TABLE ci_silo.pull_requests"))).failure).toBe("REFUSED");
    expect((await failureOf(replay.sql("SELECT 1; SELECT 2"))).failure).toBe("INVALID");
  });
});

describe("tamper detection", () => {
  async function tamper(edit: (saved: Record<string, unknown>) => void): Promise<PortError> {
    const { store, file } = await record();
    const saved = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    edit(saved);
    writeFileSync(file, JSON.stringify(saved, null, 2));
    return failureOf(new CassettePort({ store }).sql(STATEMENT));
  }

  it("refuses a recording whose row values were edited", async () => {
    const e = await tamper((s) => ((s["rawRows"] as string[][])[0]![1] = "3000"));
    expect(e.failure).toBe("INVALID");
    expect(e.detail?.["reason"]).toBe("CASSETTE_TAMPERED");
    expect(e.message).toContain("response hash");
  });

  it("refuses a recording with a row added or removed", async () => {
    expect((await tamper((s) => (s["rawRows"] as unknown[]).push(["x", "1"]))).detail?.["reason"]).toBe("CASSETTE_TAMPERED");
    expect((await tamper((s) => (s["rawRows"] as unknown[]).pop())).detail?.["reason"]).toBe("CASSETTE_TAMPERED");
  });

  it("refuses a recording whose columns were renamed", async () => {
    expect((await tamper((s) => ((s["columns"] as string[])[1] = "m"))).detail?.["reason"]).toBe("CASSETTE_TAMPERED");
  });

  it("refuses a recording whose statement was swapped for another", async () => {
    // The key covers the statement and the identity, so swapping either breaks it even if the rows are untouched.
    const e = await tamper((s) => {
      s["statement"] = "SELECT team, n FROM ci_silo.other ORDER BY team";
    });
    expect(e.detail?.["reason"]).toBe("CASSETTE_TAMPERED");
  });

  it("refuses an identity change", async () => {
    expect((await tamper((s) => (s["identity"] = "admin"))).detail?.["reason"]).toBe("CASSETTE_TAMPERED");
  });

  it("refuses a file renamed to the name of another statement's recording", async () => {
    const a = await record(STATEMENT);
    const other = "SELECT team FROM ci_silo.pull_requests";
    const b = await record(other);
    // Put statement A's content where statement B's lookup will find it.
    renameSync(a.file, b.file);
    const e = await failureOf(new CassettePort({ store: b.store }).sql(other));
    expect(e.detail?.["reason"]).toBe("CASSETTE_TAMPERED");
    expect(e.message).toContain("different statement");
  });

  it("refuses a file that is not JSON, or has extra or missing fields", async () => {
    const { store, file } = await record();
    writeFileSync(file, "{ not json");
    expect((await failureOf(new CassettePort({ store }).sql(STATEMENT))).detail?.["reason"]).toBe("CASSETTE_MALFORMED");
    const good = await record();
    const saved = JSON.parse(readFileSync(good.file, "utf8")) as Record<string, unknown>;
    writeFileSync(good.file, JSON.stringify({ ...saved, extra: 1 }));
    expect((await failureOf(new CassettePort({ store: good.store }).sql(STATEMENT))).detail?.["reason"]).toBe("CASSETTE_MALFORMED");
    delete saved["respHash"];
    writeFileSync(good.file, JSON.stringify(saved));
    expect((await failureOf(new CassettePort({ store: good.store }).sql(STATEMENT))).detail?.["reason"]).toBe("CASSETTE_MALFORMED");
  });

  it("refuses a row whose width no longer matches the columns", async () => {
    const e = await tamper((s) => ((s["rawRows"] as unknown[][])[0] = ["only-one"]));
    expect(e.failure).toBe("INVALID");
  });
});

describe("check()", () => {
  it("reports intact recordings as STALE: replayed data, not a live engine", async () => {
    const { store } = await record();
    const c = await new CassettePort({ store }).check();
    expect(c.health).toBe("STALE");
    expect(c.detail).toContain("not a live engine");
  });

  it("reports a directory with no recordings as UNAVAILABLE", async () => {
    expect((await new CassettePort({ store: new CassetteStore(join(dir, "empty")) }).check()).health).toBe("UNAVAILABLE");
  });

  it("reports any broken recording as DRIFTED and names the file", async () => {
    const { store, file } = await record();
    const saved = JSON.parse(readFileSync(file, "utf8")) as { rawRows: string[][] };
    saved.rawRows[0]![0] = "edited";
    writeFileSync(file, JSON.stringify(saved));
    const c = await new CassettePort({ store }).check();
    expect(c.health).toBe("DRIFTED");
    expect(c.detail).toContain(file.split(/[\\/]/).pop()!);
  });

  it("verifyAll separates intact from broken files and ignores unrelated files", async () => {
    const { store, file } = await record();
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(store.verifyAll()).toEqual({ intact: [file.split(/[\\/]/).pop()], broken: [] });
  });
});
