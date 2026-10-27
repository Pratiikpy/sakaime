import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { PortError } from "../../src/ports/index.ts";
import { zetarisConfigFromEnv, ZetarisPort } from "../../src/federation/zetaris-port.ts";
import { KEY_DEFAULT, KEY_REVIEWER, livePort, portConfig, startStub, wire, type Stub } from "./helpers/zetaris-stub.ts";

let stub: Stub;
beforeAll(async () => {
  stub = await startStub();
});
afterAll(() => stub.close());
afterEach(() => stub.reset());

async function failureOf(p: Promise<unknown>): Promise<PortError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}

const ONE = wire(["n"], [["1"]]);

describe("request shape (the verified wire contract)", () => {
  it("posts exactly {queryId, sql, source, limit} with bearer key, org id and a request id", async () => {
    stub.handler = () => ({ body: ONE });
    const { port } = livePort(stub);
    await port.sql("SELECT 1 AS n", { limit: 10 });
    const req = stub.requests[0]!;
    expect(req.method).toBe("POST");
    expect(req.url).toBe("/api/v1.0/sql-editor/sqls/run");
    expect(req.headers["authorization"]).toBe(`Bearer ${KEY_DEFAULT}`);
    expect(req.headers["x-org-id"]).toBe("1");
    expect(req.headers["x-request-id"]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(Object.keys(req.json!).sort()).toEqual(["limit", "queryId", "source", "sql"]);
    expect(req.json!["source"]).toBe("SqlEditor");
    expect(req.json!["sql"]).toBe("SELECT 1 AS n");
    expect(req.json!["queryId"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("asks the engine for one row more than the limit, so a capped answer can be detected", async () => {
    stub.handler = () => ({ body: ONE });
    await livePort(stub).port.sql("SELECT 1", { limit: 10 });
    expect(stub.requests[0]!.json!["limit"]).toBe(11);
  });

  it("strips a trailing semicolon before sending", async () => {
    stub.handler = () => ({ body: ONE });
    await livePort(stub).port.sql("SELECT 1 AS n ;\n");
    expect(stub.requests[0]!.json!["sql"]).toBe("SELECT 1 AS n");
  });

  it("uses a fresh request id and query id on every attempt", async () => {
    let n = 0;
    stub.handler = () => (++n < 3 ? { status: 503, text: "" } : { body: ONE });
    await livePort(stub).port.sql("SELECT 1");
    const ids = stub.requests.map((r) => r.headers["x-request-id"]);
    const queryIds = stub.requests.map((r) => r.json!["queryId"]);
    expect(new Set(ids).size).toBe(3);
    expect(new Set(queryIds).size).toBe(3);
  });

  it("reports the query id of the attempt that succeeded", async () => {
    stub.handler = () => ({ body: ONE });
    const r = await livePort(stub).port.sql("SELECT 1");
    expect(r.queryId).toBe(stub.requests[0]!.json!["queryId"]);
    expect(r.servedFrom).toBe("live");
  });
});

describe("results", () => {
  it("returns strings for undeclared columns and typed values for declared ones", async () => {
    stub.handler = () => ({ body: wire(["team", "n", "ok", "at", "code"], [["payments", "3", "true", "2026-08-31 11:22:21.0", "00123"], ["growth", null, "false", "2026-09-01 00:00:00.0", ""]]) });
    const { port } = livePort(stub, { schema: { n: "bigint", ok: "boolean", at: "timestamp" } });
    const r = await port.sql("SELECT team, n, ok, at, code FROM t");
    expect(r.rows).toEqual([
      { team: "payments", n: 3, ok: true, at: "2026-08-31T11:22:21", code: "00123" },
      { team: "growth", n: null, ok: false, at: "2026-09-01T00:00:00", code: "" },
    ]);
    expect(r.columns.map((c) => c.type)).toEqual(["string", "bigint", "boolean", "timestamp", "string"]);
    expect(r.total).toBe(2);
  });

  it("takes a per-call schema over the port's", async () => {
    stub.handler = () => ({ body: wire(["n"], [["7"]]) });
    const { port } = livePort(stub, { schema: { n: "string" } });
    expect((await port.sql("SELECT n FROM t", { schema: { n: "integer" } })).rows).toEqual([{ n: 7 }]);
  });

  it("gives the same hash for the same wire data whatever the casting", async () => {
    stub.handler = () => ({ body: wire(["n"], [["7"]]) });
    const a = await livePort(stub).port.sql("SELECT n FROM t");
    const b = await livePort(stub, { schema: { n: "integer" } }).port.sql("SELECT n FROM t");
    expect(a.respHash).toBe(b.respHash);
    expect(a.respHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns an empty result as empty, not as a failure", async () => {
    stub.handler = () => ({ body: wire(["n"], []) });
    const r = await livePort(stub).port.sql("SELECT n FROM t WHERE 1 = 0");
    expect(r.rows).toEqual([]);
    expect(r.columns).toEqual([{ name: "n", type: "string" }]);
  });

  it("refuses a result that has two columns of one name", async () => {
    stub.handler = () => ({ body: wire(["id", "id"], [["1", "2"]]) });
    expect((await failureOf(livePort(stub).port.sql("SELECT a.id, b.id FROM a JOIN b"))).failure).toBe("INVALID");
  });
});

describe("identities", () => {
  it("sends the key of the identity asked for, so two reviewers can see different columns", async () => {
    stub.handler = (req) =>
      req.headers["authorization"] === `Bearer ${KEY_REVIEWER}` ? { body: wire(["name", "secret"], [["x", "(masked)"]]) } : { body: wire(["name", "secret"], [["x", "hunter2"]]) };
    const { port } = livePort(stub);
    const admin = await port.sql("SELECT name, secret FROM t");
    const reviewer = await port.sql("SELECT name, secret FROM t", { identity: "reviewer" });
    expect(admin.rows[0]!["secret"]).toBe("hunter2");
    expect(reviewer.rows[0]!["secret"]).toBe("(masked)");
    expect(stub.requests.map((r) => r.headers["authorization"])).toEqual([`Bearer ${KEY_DEFAULT}`, `Bearer ${KEY_REVIEWER}`]);
  });

  it("can give an identity its own organisation id", async () => {
    stub.handler = () => ({ body: ONE });
    const { port } = livePort(stub, { identities: { default: { apiKey: KEY_DEFAULT }, other: { apiKey: KEY_REVIEWER, orgId: "42" } } });
    await port.sql("SELECT 1", { identity: "other" });
    expect(stub.requests[0]!.headers["x-org-id"]).toBe("42");
  });

  it("refuses an unknown identity without contacting the engine", async () => {
    const e = await failureOf(livePort(stub).port.sql("SELECT 1", { identity: "nobody" }));
    expect(e.failure).toBe("REFUSED");
    expect(stub.requests).toHaveLength(0);
  });

  it("builds identities from the environment", () => {
    expect(zetarisConfigFromEnv({})).toBeNull();
    expect(zetarisConfigFromEnv({ ZETARIS_REST_URL: "http://x/api/v1.0", ZETARIS_API_KEY: "k" })).toBeNull();
    const cfg = zetarisConfigFromEnv({ ZETARIS_REST_URL: "http://x/api/v1.0", ZETARIS_API_KEY: "kkkk", ZETARIS_ORG_ID: "1", ZETARIS_API_KEY__REVIEWER_A: "aaaa" })!;
    expect(Object.keys(cfg.identities).sort()).toEqual(["default", "reviewer_a"]);
    expect(cfg.defaultIdentity).toBe("default");
  });
});

describe("error classes", () => {
  it("HTTP 401 with a plain-text body is FORBIDDEN and not retried", async () => {
    stub.handler = () => ({ status: 401, text: "Invalid value for: header Authorization (missing)" });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1"));
    expect(e.failure).toBe("FORBIDDEN");
    expect(e.detail?.["reason"]).toBe("BAD_CREDENTIAL");
    expect(stub.requests).toHaveLength(1);
  });

  it("a wrong key arrives as HTTP 400 Not Allowed and is FORBIDDEN, not INVALID", async () => {
    stub.handler = () => ({ status: 400, body: { msg: "Not Allowed" } });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1"));
    expect(e.failure).toBe("FORBIDDEN");
    expect(stub.requests).toHaveLength(1);
  });

  it("'does not have access to USL' is FORBIDDEN and not retried", async () => {
    stub.handler = () => ({ status: 400, body: { msg: "User does not have access to USL lightning.metastore.n.u" } });
    const e = await failureOf(livePort(stub).port.sql("SELECT * FROM lightning.metastore.n.u.t"));
    expect(e.failure).toBe("FORBIDDEN");
    expect(e.detail?.["reason"]).toBe("NO_USL_ACCESS");
    expect(stub.requests).toHaveLength(1);
  });

  it("malformed SQL is INVALID and not retried", async () => {
    stub.handler = () => ({ status: 400, body: { msg: "ParseException: mismatched input 'FORM' expecting" } });
    const e = await failureOf(livePort(stub).port.sql("SELECT a FORM t"));
    expect(e.failure).toBe("INVALID");
    expect(stub.requests).toHaveLength(1);
  });

  it.each([
    ["stopped SparkContext", 400, { msg: "Cannot call methods on a stopped SparkContext." }],
    ["ResultSet null", 400, { msg: "Could not create ResultSet: null" }],
    ["thrift transport", 400, { msg: "org.apache.thrift.transport.TTransportException" }],
    ["HTTP 500", 500, { msg: "internal" }],
    ["HTTP 502", 502, { msg: "bad gateway" }],
    ["HTTP 503", 503, { msg: "unavailable" }],
  ])("%s is UNAVAILABLE and retried up to the cap", async (_n, status, body) => {
    stub.handler = () => ({ status, body });
    const { port, sleeps } = livePort(stub);
    const e = await failureOf(port.sql("SELECT 1"));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(stub.requests).toHaveLength(3);
    expect(e.detail?.["attempts"]).toBe(3);
    expect(e.message).toContain("after 3 attempts");
    expect(sleeps).toEqual([250, 500]);
  });

  it("connection refused is UNAVAILABLE", async () => {
    // A port with nothing listening: bind, read the port, close.
    const probe = createServer();
    await new Promise<void>((r) => probe.listen(0, "127.0.0.1", r));
    const { port: number } = probe.address() as { port: number };
    await new Promise<void>((r) => probe.close(() => r()));
    const dead = new ZetarisPort({ ...portConfig(stub), restUrl: `http://127.0.0.1:${number}/api/v1.0` });
    const e = await failureOf(dead.sql("SELECT 1"));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(e.detail?.["reason"]).toBe("CONNECTION_REFUSED");
    expect(e.detail?.["attempts"]).toBe(3);
  });

  it("a socket closed mid-request is UNAVAILABLE", async () => {
    stub.handler = () => ({ destroy: true });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1"));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(stub.requests).toHaveLength(3);
  });

  it("an engine that does not answer in time is UNAVAILABLE, with the timeout enforced below the engine's own 60 s", async () => {
    stub.handler = () => ({ body: ONE, delayMs: 400 });
    const { port } = livePort(stub, { attemptTimeoutMs: 80, maxAttempts: 2 });
    const started = Date.now();
    const e = await failureOf(port.sql("SELECT 1"));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(e.detail?.["reason"]).toBe("TIMEOUT");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  it("caps any requested timeout at 55 s, under the engine's own 60 s limit", async () => {
    vi.useFakeTimers();
    try {
      const hanging: typeof fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        });
      const port = new ZetarisPort({ ...portConfig(stub), fetch: hanging, attemptTimeoutMs: 600_000, maxAttempts: 1 });
      let settled: PortError | undefined;
      const call = port.sql("SELECT 1", { timeoutMs: 600_000 }).catch((e: PortError) => (settled = e));
      await vi.advanceTimersByTimeAsync(54_999);
      expect(settled).toBeUndefined();
      await vi.advanceTimersByTimeAsync(1);
      await call;
      expect(settled?.failure).toBe("UNAVAILABLE");
      expect(settled?.detail?.["reason"]).toBe("TIMEOUT");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not follow a redirect, which would carry the bearer key elsewhere", async () => {
    stub.handler = (_req, i) => (i === 0 ? { status: 302, text: "", headers: { Location: `${stub.url}/elsewhere` } } : { body: ONE });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1"));
    expect(e.failure).toBe("INVALID");
    expect(e.detail?.["status"]).toBe(302);
    expect(stub.requests).toHaveLength(1);
  });

  it("a 200 that is not JSON is treated as an outage, not as an answer", async () => {
    stub.handler = () => ({ text: "<html>gateway</html>" });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1"));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(e.detail?.["reason"]).toBe("NOT_JSON");
  });

  it("a 200 without headers and data is DRIFTED and not retried", async () => {
    stub.handler = () => ({ body: { rows: [[1]] } });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1"));
    expect(e.failure).toBe("DRIFTED");
    expect(stub.requests).toHaveLength(1);
  });

  it("a row of the wrong width, or a value that is not text, is DRIFTED", async () => {
    stub.handler = () => ({ body: { headers: ["a", "b"], data: [["1"]], total: 1 } });
    expect((await failureOf(livePort(stub).port.sql("SELECT 1"))).failure).toBe("DRIFTED");
    stub.handler = () => ({ body: { headers: ["a"], data: [[{ nested: true }]], total: 1 } });
    expect((await failureOf(livePort(stub).port.sql("SELECT 1"))).failure).toBe("DRIFTED");
  });

  it("a value that no longer fits its declared type is DRIFTED", async () => {
    stub.handler = () => ({ body: wire(["n"], [["not a number"]]) });
    const e = await failureOf(livePort(stub, { schema: { n: "bigint" } }).port.sql("SELECT n FROM t"));
    expect(e.failure).toBe("DRIFTED");
  });
});

describe("retries", () => {
  it("recovers when a later attempt succeeds and returns that attempt's data", async () => {
    let n = 0;
    stub.handler = () => (++n < 3 ? { status: 400, body: { msg: "Could not create ResultSet: null" } } : { body: wire(["n"], [["9"]]) });
    const { port, sleeps } = livePort(stub);
    const r = await port.sql("SELECT n FROM t");
    expect(r.rows).toEqual([{ n: "9" }]);
    expect(stub.requests).toHaveLength(3);
    expect(sleeps).toEqual([250, 500]);
  });

  it("makes exactly one attempt when maxAttempts is 1", async () => {
    stub.handler = () => ({ status: 503, text: "" });
    const { port, sleeps } = livePort(stub, { maxAttempts: 1 });
    await failureOf(port.sql("SELECT 1"));
    expect(stub.requests).toHaveLength(1);
    expect(sleeps).toEqual([]);
  });

  it("caps the backoff", async () => {
    stub.handler = () => ({ status: 503, text: "" });
    const { port, sleeps } = livePort(stub, { maxAttempts: 6, backoffBaseMs: 1_000, backoffMaxMs: 3_000 });
    await failureOf(port.sql("SELECT 1"));
    expect(sleeps).toEqual([1_000, 2_000, 3_000, 3_000, 3_000]);
  });

  it("honours Retry-After up to the backoff cap", async () => {
    let n = 0;
    stub.handler = () => (++n < 2 ? { status: 429, text: "", headers: { "Retry-After": "2" } } : { body: ONE });
    const { port, sleeps } = livePort(stub, { backoffMaxMs: 4_000 });
    await port.sql("SELECT 1");
    expect(sleeps).toEqual([2_000]);
    stub.reset();
    stub.handler = () => (stub.requests.length < 2 ? { status: 429, text: "", headers: { "Retry-After": "600" } } : { body: ONE });
    const again = livePort(stub, { backoffMaxMs: 4_000 });
    await again.port.sql("SELECT 1");
    expect(again.sleeps).toEqual([4_000]);
  });

  it("stops retrying when the next attempt could not finish inside the total budget", async () => {
    stub.handler = () => ({ status: 503, text: "" });
    let t = 0;
    const { port } = livePort(stub, { maxAttempts: 5, totalBudgetMs: 3_000, attemptTimeoutMs: 1_500, now: () => (t += 1_000) });
    const e = await failureOf(port.sql("SELECT 1"));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(e.message).toContain("retry budget spent");
    expect(stub.requests.length).toBeLessThan(5);
  });

  it("does not retry a truncated result", async () => {
    stub.handler = () => ({ body: wire(["n"], [["1"], ["2"]], 50) });
    await failureOf(livePort(stub).port.sql("SELECT n FROM t"));
    expect(stub.requests).toHaveLength(1);
  });
});

describe("truncation", () => {
  it("refuses a result whose total exceeds the rows returned", async () => {
    stub.handler = () => ({ body: wire(["n"], [["1"], ["2"]], 792) });
    const e = await failureOf(livePort(stub).port.sql("SELECT n FROM t"));
    expect(e.failure).toBe("TRUNCATED");
    expect(e.detail).toMatchObject({ received: 2, total: 792 });
  });

  it("refuses a result that reaches the sentinel row even when total is wrong", async () => {
    stub.handler = () => ({ body: wire(["n"], [["1"], ["2"], ["3"]], 3) }); // limit 2, three rows came back
    const e = await failureOf(livePort(stub).port.sql("SELECT n FROM t", { limit: 2 }));
    expect(e.failure).toBe("TRUNCATED");
  });

  it("accepts a result that exactly fills the limit", async () => {
    stub.handler = () => ({ body: wire(["n"], [["1"], ["2"]], 2) });
    const r = await livePort(stub).port.sql("SELECT n FROM t", { limit: 2 });
    expect(r.rows).toHaveLength(2);
  });

  it("rejects a bad limit before any request", async () => {
    for (const limit of [0, -1, 1.5, 1_000_000, Number.NaN]) {
      expect((await failureOf(livePort(stub).port.sql("SELECT 1", { limit }))).failure, String(limit)).toBe("INVALID");
    }
    expect(stub.requests).toHaveLength(0);
  });
});

describe("statements", () => {
  it("refuses more than one statement before any request", async () => {
    const e = await failureOf(livePort(stub).port.sql("SELECT 1; SELECT 2"));
    expect(e.failure).toBe("INVALID");
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses an empty statement before any request", async () => {
    expect((await failureOf(livePort(stub).port.sql(" ; "))).failure).toBe("INVALID");
    expect(stub.requests).toHaveLength(0);
  });

  it("refuses statements that could change data under the default read-only policy", async () => {
    for (const s of ["DROP TABLE hospital.requirements", "INSERT INTO hospital.requirements VALUES (1)", "ACTIVATE USL TABLE a.b.c.d AS SELECT 1"]) {
      expect((await failureOf(livePort(stub).port.sql(s))).failure, s).toBe("REFUSED");
    }
    expect(stub.requests).toHaveLength(0);
  });

  it("sends a COMPILE USL as one request, semicolons and line breaks intact, under the admin policy only", async () => {
    stub.handler = () => ({ body: wire(["result"], [["ok"]]) });
    const ddl = "COMPILE USL u DEPLOY NAMESPACE lightning.metastore.n DDL\nCREATE TABLE a (\n  id int\n);\nCREATE TABLE b (\n  id int\n)";
    const { port } = livePort(stub);
    expect((await failureOf(port.sql(ddl))).failure).toBe("REFUSED");
    expect(stub.requests).toHaveLength(0);
    await port.sql(ddl, { statementPolicy: "admin" });
    expect(stub.requests).toHaveLength(1);
    const sent = stub.requests[0]!.json!["sql"] as string;
    expect(sent.split("\n").filter((l) => l.startsWith("CREATE TABLE"))).toHaveLength(2);
    expect(sent).toContain(";\nCREATE TABLE b");
  });

  it("still refuses a smuggled second statement under the admin policy", async () => {
    const { port } = livePort(stub);
    const e = await failureOf(port.sql("SELECT 1; DROP TABLE hospital.requirements", { statementPolicy: "admin" }));
    expect(e.failure).toBe("INVALID");
    expect(stub.requests).toHaveLength(0);
  });
});

describe("keys never leak", () => {
  const everyString = (e: PortError): string => `${e.message}\n${JSON.stringify(e.detail ?? {})}\n${e.stack ?? ""}`;

  it("scrubs a key the engine echoes back in an error body", async () => {
    stub.handler = () => ({ status: 500, text: `upstream rejected token ${KEY_DEFAULT} for org 1` });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1"));
    expect(everyString(e)).not.toContain(KEY_DEFAULT);
  });

  it("scrubs a bearer header echoed in a 400", async () => {
    stub.handler = (req) => ({ status: 400, text: `bad request, header was ${req.headers["authorization"]}` });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1"));
    expect(everyString(e)).not.toContain(KEY_DEFAULT);
  });

  it("does not put a key in a connection error or a check result", async () => {
    const dead = new ZetarisPort({ ...portConfig(stub), restUrl: "http://127.0.0.1:1/api/v1.0" });
    const e = await failureOf(dead.sql("SELECT 1"));
    expect(everyString(e)).not.toContain(KEY_DEFAULT);
    const c = await dead.check();
    expect(JSON.stringify(c)).not.toContain(KEY_DEFAULT);
  });

  it("does not let the key appear when the other identity's key is echoed", async () => {
    stub.handler = () => ({ status: 500, text: `${KEY_REVIEWER} ${KEY_DEFAULT}` });
    const e = await failureOf(livePort(stub).port.sql("SELECT 1", { identity: "reviewer" }));
    expect(everyString(e)).not.toContain(KEY_REVIEWER);
    expect(everyString(e)).not.toContain(KEY_DEFAULT);
  });
});

describe("check()", () => {
  it("runs a real SELECT 1 through the engine", async () => {
    stub.handler = () => ({ body: wire(["1"], [["1"]]) });
    const { port } = livePort(stub);
    const c = await port.check();
    expect(c.health).toBe("OK");
    expect(stub.requests).toHaveLength(1);
    expect(stub.requests[0]!.json!["sql"]).toBe("SELECT 1");
    expect(c.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("reports an engine whose Spark context has stopped as UNAVAILABLE even though a container healthcheck would be green", async () => {
    stub.handler = () => ({ status: 400, body: { msg: "Cannot call methods on a stopped SparkContext." } });
    const c = await livePort(stub).port.check();
    expect(c.health).toBe("UNAVAILABLE");
    expect(c.detail).toContain("UNAVAILABLE");
    expect(stub.requests).toHaveLength(1); // one probe, no retry loop
  });

  it("reports a refused key as FORBIDDEN, a wrong answer as DRIFTED, a dead engine as UNAVAILABLE", async () => {
    stub.handler = () => ({ status: 400, body: { msg: "Not Allowed" } });
    expect((await livePort(stub).port.check()).health).toBe("FORBIDDEN");
    stub.handler = () => ({ body: wire(["1"], [["2"]]) });
    expect((await livePort(stub).port.check()).health).toBe("DRIFTED");
    stub.handler = () => ({ body: { nothing: true } });
    expect((await livePort(stub).port.check()).health).toBe("DRIFTED");
    const dead = new ZetarisPort({ ...portConfig(stub), restUrl: "http://127.0.0.1:1/api/v1.0" });
    expect((await dead.check()).health).toBe("UNAVAILABLE");
  });

  it("probes as the identity asked for", async () => {
    stub.handler = () => ({ body: wire(["1"], [["1"]]) });
    await livePort(stub).port.check("reviewer");
    expect(stub.requests[0]!.headers["authorization"]).toBe(`Bearer ${KEY_REVIEWER}`);
  });

  it("measures latency with the injected clock", async () => {
    stub.handler = () => ({ body: wire(["1"], [["1"]]) });
    let t = 0;
    const c = await livePort(stub, { now: () => (t += 50) }).port.check();
    expect(c.latencyMs).toBeGreaterThan(0);
  });
});

describe("construction", () => {
  const base = (): ReturnType<typeof portConfig> => portConfig(stub);
  it("rejects bad configuration immediately", () => {
    expect(() => new ZetarisPort({ ...base(), restUrl: "not a url" })).toThrow(PortError);
    expect(() => new ZetarisPort({ ...base(), restUrl: "ftp://x/y" })).toThrow(PortError);
    expect(() => new ZetarisPort({ ...base(), defaultIdentity: "missing" })).toThrow(PortError);
    expect(() => new ZetarisPort({ ...base(), identities: { default: { apiKey: "" } } })).toThrow(PortError);
    expect(() => new ZetarisPort({ ...base(), schema: { a: "array<int>" } })).toThrow(PortError);
  });
  it("lists the identity names it holds, never the keys", () => {
    expect(new ZetarisPort(base()).identityNames().sort()).toEqual(["default", "reviewer"]);
  });
});
