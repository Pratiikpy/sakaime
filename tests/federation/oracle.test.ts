import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CassettePort, CassetteStore, RecordingPort } from "../../src/federation/cassette.ts";
import { buildEvidenceMatrixSql, EVIDENCE_MATRIX_SCHEMA } from "../../src/federation/evidence-matrix.ts";
import type { DuckDbFallbackPort } from "../../src/federation/fallback.ts";
import { compareResults, OracleDisagreement, OracleHarness } from "../../src/federation/oracle.ts";
import { PortError, type FederationColumn, type FederationResult } from "../../src/ports/index.ts";
import { engineHandler } from "./helpers/engine-stub.ts";
import { fixturePort, FIXTURE_DATA } from "./helpers/fixtures.ts";
import { livePort, startStub, type Stub } from "./helpers/zetaris-stub.ts";

function result(columns: FederationColumn[], rows: Record<string, unknown>[]): FederationResult {
  return { columns, rows, total: rows.length, queryId: "q", servedFrom: "live", respHash: "h", elapsedMs: 0 };
}
const s = (name: string): FederationColumn => ({ name, type: "string" });
const n = (name: string): FederationColumn => ({ name, type: "double" });

describe("compareResults", () => {
  it("ignores row order", () => {
    const a = result([s("k"), n("v")], [{ k: "a", v: 1 }, { k: "b", v: 2 }, { k: "c", v: 3 }]);
    const b = result([s("k"), n("v")], [{ k: "c", v: 3 }, { k: "a", v: 1 }, { k: "b", v: 2 }]);
    expect(compareResults(a, b).agree).toBe(true);
  });

  it("ignores column order and the case of column names", () => {
    const a = result([s("K"), n("v")], [{ K: "a", v: 1 }]);
    const b = result([n("v"), s("k")], [{ v: 1, k: "a" }]);
    expect(compareResults(a, b).agree).toBe(true);
  });

  it("counts duplicates: a row present twice is not the same as present once", () => {
    const once = result([s("k")], [{ k: "a" }, { k: "b" }]);
    const twice = result([s("k")], [{ k: "a" }, { k: "a" }, { k: "b" }]);
    const d = compareResults(twice, once);
    expect(d.agree).toBe(false);
    expect(d.onlyInPrimary).toEqual([{ k: "a" }]);
    expect(d.primaryRows).toBe(3);
    expect(d.oracleRows).toBe(2);
  });

  it("allows numeric noise inside the tolerance and reports it outside", () => {
    const exact = result([s("k"), n("v")], [{ k: "a", v: 0.3 }]);
    expect(compareResults(result([s("k"), n("v")], [{ k: "a", v: 0.1 + 0.2 }]), exact).agree).toBe(true);
    const off = compareResults(result([s("k"), n("v")], [{ k: "a", v: 0.31 }]), exact);
    expect(off.agree).toBe(false);
    expect(off.mismatched).toHaveLength(1);
    expect(off.mismatched[0]!.differences).toEqual([{ column: "v", primary: 0.31, oracle: 0.3, absoluteDifference: expect.closeTo(0.01, 12) }]);
    expect(off.onlyInPrimary).toEqual([]);
  });

  it("uses relative tolerance for large values and absolute tolerance near zero", () => {
    const tol = { relative: 1e-6, absolute: 1e-12 };
    expect(compareResults(result([n("v")], [{ v: 1_000_000_000.5 }]), result([n("v")], [{ v: 1_000_000_000 }]), { tolerance: tol }).agree).toBe(true);
    expect(compareResults(result([n("v")], [{ v: 1e-9 }]), result([n("v")], [{ v: 0 }]), { tolerance: tol }).agree).toBe(false);
  });

  it("finds the matching when a first-fit pairing would strand a row", () => {
    const tol = { relative: 0, absolute: 1 };
    const a = result([n("v")], [{ v: 2.5 }, { v: 1.5 }]);
    const b = result([n("v")], [{ v: 2.5 }, { v: 3.5 }]);
    expect(compareResults(a, b, { tolerance: tol }).agree).toBe(true);
  });

  it("treats NaN as equal to NaN, and null as different from zero and from NaN", () => {
    expect(compareResults(result([n("v")], [{ v: Number.NaN }]), result([n("v")], [{ v: Number.NaN }])).agree).toBe(true);
    expect(compareResults(result([n("v")], [{ v: null }]), result([n("v")], [{ v: null }])).agree).toBe(true);
    expect(compareResults(result([n("v")], [{ v: null }]), result([n("v")], [{ v: 0 }])).agree).toBe(false);
    expect(compareResults(result([n("v")], [{ v: Number.NaN }]), result([n("v")], [{ v: null }])).agree).toBe(false);
  });

  it("compares text exactly, including case and whitespace", () => {
    expect(compareResults(result([s("k")], [{ k: "a" }]), result([s("k")], [{ k: "A" }])).agree).toBe(false);
    expect(compareResults(result([s("k")], [{ k: "a" }]), result([s("k")], [{ k: "a " }])).agree).toBe(false);
    expect(compareResults(result([s("k")], [{ k: "" }]), result([s("k")], [{ k: null }])).agree).toBe(false);
  });

  it("names the column and values of a row that differs in text", () => {
    const d = compareResults(result([s("k"), s("t")], [{ k: "a", t: "x" }]), result([s("k"), s("t")], [{ k: "a", t: "y" }]));
    expect(d.agree).toBe(false);
    expect(d.mismatched[0]!.differences).toEqual([{ column: "t", primary: "x", oracle: "y" }]);
  });

  it("reports a column present on one side only", () => {
    const d = compareResults(result([s("k"), s("extra")], [{ k: "a", extra: "x" }]), result([s("k")], [{ k: "a" }]));
    expect(d.agree).toBe(false);
    expect(d.columnsOnlyInPrimary).toEqual(["extra"]);
    expect(d.columnsOnlyInOracle).toEqual([]);
  });

  it("reads text '3' against number 3 as the same number and says it had to coerce", () => {
    const d = compareResults(result([s("v")], [{ v: "3" }]), result([{ name: "v", type: "bigint" }], [{ v: 3 }]));
    expect(d.agree).toBe(true);
    expect(d.coercedColumns).toEqual(["v"]);
  });

  it("does not read text that is not a number as a number", () => {
    expect(compareResults(result([s("v")], [{ v: "three" }]), result([{ name: "v", type: "bigint" }], [{ v: 3 }])).agree).toBe(false);
  });

  it("compares exact big-integer text exactly even where doubles would be equal", () => {
    const big = (v: string): FederationResult => result([{ name: "v", type: "bigint" }], [{ v }]);
    expect(compareResults(big("9007199254740993"), big("9007199254740993")).agree).toBe(true);
    // equal as doubles, different integers: tolerance may not hide it only when the relative tolerance is zero
    expect(compareResults(big("9007199254740993"), big("9007199254740992"), { tolerance: { relative: 0, absolute: 0 } }).agree).toBe(false);
  });

  it("agrees on two empty results and disagrees when one is empty", () => {
    expect(compareResults(result([s("k")], []), result([s("k")], [])).agree).toBe(true);
    const d = compareResults(result([s("k")], []), result([s("k")], [{ k: "a" }]));
    expect(d.agree).toBe(false);
    expect(d.onlyInOracle).toEqual([{ k: "a" }]);
  });

  it("caps the rows it lists and says so", () => {
    const many = result([s("k")], Array.from({ length: 80 }, (_, i) => ({ k: `r${i}` })));
    const d = compareResults(many, result([s("k")], []), { maxListed: 10 });
    expect(d.onlyInPrimary).toHaveLength(10);
    expect(d.listsTruncated).toBe(true);
    expect(d.primaryRows).toBe(80);
  });
});

describe("OracleHarness over a live-style port and the DuckDB fallback", () => {
  let stub: Stub;
  let engine: DuckDbFallbackPort;
  let oracle: DuckDbFallbackPort;
  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(() => stub.close());
  beforeEach(async () => {
    engine = await fixturePort();
    oracle = await fixturePort();
    stub.handler = engineHandler(engine);
  });
  afterEach(() => {
    engine.close();
    oracle.close();
    stub.reset();
  });

  const harness = (over = {}) => new OracleHarness(livePort(stub, { schema: EVIDENCE_MATRIX_SCHEMA, ...over }).port, oracle);
  const MATRIX = buildEvidenceMatrixSql({ submissionId: "S1", intendedUse: { setting: "emergency department", purpose: "triage support" } });

  it("agrees on the Evidence Matrix across two separate engines when both read the declared schema", async () => {
    const outcome = await harness().run(MATRIX, { schema: EVIDENCE_MATRIX_SCHEMA });
    expect(outcome.status).toBe("AGREE");
    expect(outcome.primary?.servedFrom).toBe("live");
    expect(outcome.oracle?.servedFrom).toBe("fallback");
    expect(outcome.diff?.agree).toBe(true);
    expect(outcome.primary?.rows[0]).toMatchObject({ regulator_confirmed: 2, registry_confirmed_enrollment: 650 });
  });

  it("agrees on a join across the silos and on a whole table", async () => {
    const h = harness();
    await h.assertAgree("SELECT l.from_id AS s, COUNT(*) AS n FROM hospital.identity_links l JOIN regulator.authorizations a ON a.authorization_id = l.to_id GROUP BY l.from_id");
    await h.assertAgree("SELECT * FROM registry.studies");
  });

  it("catches a changed value on one side", async () => {
    const changed = structuredClone(FIXTURE_DATA.studies);
    changed[0]!["enrollment"] = 4000; // the "live" engine now disagrees about one study
    await engine.close();
    engine = await fixturePort({ studies: changed });
    stub.handler = engineHandler(engine);
    const outcome = await harness().run(MATRIX, { schema: EVIDENCE_MATRIX_SCHEMA });
    expect(outcome.status).toBe("DISAGREE");
    expect(outcome.diff?.mismatched[0]!.differences).toEqual([{ column: "registry_confirmed_enrollment", primary: 4250, oracle: 650, absoluteDifference: 3600 }]);
  });

  it("catches a row that one side is missing", async () => {
    const fewer = FIXTURE_DATA.studies.slice(1);
    engine.close();
    engine = await fixturePort({ studies: fewer });
    stub.handler = engineHandler(engine);
    const outcome = await harness().run("SELECT nct_id FROM registry.studies");
    expect(outcome.status).toBe("DISAGREE");
    expect(outcome.diff?.onlyInOracle).toEqual([{ nct_id: "N1" }]);
    await expect(harness().assertAgree("SELECT nct_id FROM registry.studies")).rejects.toBeInstanceOf(OracleDisagreement);
  });

  it("catches a duplicated row", async () => {
    engine.close();
    engine = await fixturePort({ studies: [...FIXTURE_DATA.studies, FIXTURE_DATA.studies[0]!] });
    stub.handler = engineHandler(engine);
    const outcome = await harness().run("SELECT nct_id FROM registry.studies");
    expect(outcome.status).toBe("DISAGREE");
    expect(outcome.diff?.onlyInPrimary).toEqual([{ nct_id: "N1" }]);
  });

  it("carries the diff on the thrown disagreement", async () => {
    engine.close();
    engine = await fixturePort({ studies: FIXTURE_DATA.studies.slice(1) });
    stub.handler = engineHandler(engine);
    const e = await harness().assertAgree("SELECT nct_id FROM registry.studies").catch((x: unknown) => x);
    expect(e).toBeInstanceOf(OracleDisagreement);
    expect((e as OracleDisagreement).outcome.status).toBe("DISAGREE");
    expect((e as OracleDisagreement).message).toContain("SELECT nct_id");
  });

  it("without the declared schema the engines' timestamp renderings differ and the harness says so rather than guessing", async () => {
    const outcome = await new OracleHarness(livePort(stub).port, oracle).run("SELECT start_date, enrollment FROM registry.studies WHERE nct_id = 'N1'");
    // dates and integers are rendered identically by both engines, so this agrees even undeclared
    expect(outcome.status).toBe("AGREE");
    expect(outcome.diff?.coercedColumns).toContain("enrollment");
  });

  it("reports the division-by-zero divergence between Spark and DuckDB as a disagreement, not as agreement", async () => {
    stub.handler = () => ({ body: { headers: ["v"], data: [[null]], total: 1 } }); // Spark: 1 / 0 is NULL
    const outcome = await harness().run("SELECT 1 / 0 AS v");
    expect(outcome.status).toBe("DISAGREE");
    expect(outcome.oracle?.rows[0]).toEqual({ v: Number.POSITIVE_INFINITY });
  });

  it("is never AGREE when the live side fails", async () => {
    stub.handler = () => ({ status: 400, body: { msg: "Cannot call methods on a stopped SparkContext." } });
    const outcome = await new OracleHarness(livePort(stub, { maxAttempts: 1 }).port, oracle).run("SELECT 1 AS v");
    expect(outcome.status).toBe("PRIMARY_FAILED");
    expect(outcome.primaryError?.failure).toBe("UNAVAILABLE");
    expect(outcome.oracle?.rows).toEqual([{ v: 1 }]);
    expect(outcome.diff).toBeUndefined();
  });

  it("is never AGREE when the oracle cannot translate the statement", async () => {
    stub.handler = () => ({ body: { headers: ["v"], data: [["ab"]], total: 1 } });
    const outcome = await harness().run("SELECT concat('a', 'b') AS v");
    expect(outcome.status).toBe("ORACLE_FAILED");
    expect(outcome.oracleError?.detail?.["reason"]).toBe("UNTRANSLATABLE");
    expect(outcome.primary?.rows).toEqual([{ v: "ab" }]);
  });

  it("reports when both sides fail", async () => {
    stub.handler = () => ({ status: 400, body: { msg: "ParseException" } });
    const outcome = await harness().run("SELECT nope FROM nowhere");
    expect(outcome.status).toBe("BOTH_FAILED");
    expect(outcome.primaryError?.failure).toBe("INVALID");
    expect(outcome.oracleError?.failure).toBe("INVALID");
  });

  it("rethrows an error that is not a port failure instead of hiding it", async () => {
    const broken = { mode: "live" as const, sql: () => Promise.reject(new TypeError("bug in the caller")), check: () => Promise.reject(new Error("x")) };
    await expect(new OracleHarness(broken, oracle).run("SELECT 1")).rejects.toBeInstanceOf(TypeError);
  });

  it("compares a recorded cassette against the oracle, which is how a judge without Docker re-checks the data", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sakaime-oracle-"));
    try {
      const store = new CassetteStore(dir);
      await new RecordingPort(livePort(stub).port, store).sql(MATRIX, { schema: EVIDENCE_MATRIX_SCHEMA });
      stub.handler = () => ({ status: 500, text: "engine is gone" });
      const replay = new CassettePort({ store, schema: EVIDENCE_MATRIX_SCHEMA });
      const outcome = await new OracleHarness(replay, oracle).run(MATRIX);
      expect(outcome.status).toBe("AGREE");
      expect(outcome.primary?.servedFrom).toBe("cassette");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("OracleHarness construction", () => {
  it("refuses an oracle that is not the fallback and a primary that is", async () => {
    const stub = await startStub();
    const oracle = await fixturePort();
    const live = livePort(stub).port;
    expect(() => new OracleHarness(oracle, oracle)).toThrow(PortError);
    expect(() => new OracleHarness(live, live)).toThrow(PortError);
    expect(() => new OracleHarness(live, oracle)).not.toThrow();
    oracle.close();
    await stub.close();
  });
});
