import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  buildActivateUslTableSql,
  buildCompileUslSql,
  buildCreateNamespaceSql,
  buildListDqSql,
  buildLoadUslSql,
  buildRegisterCompletenessRuleSql,
  buildRegisterDqSql,
  buildRunCompletenessSql,
  buildRunDqSql,
  checkCollectionCompleteness,
  COMPLETENESS_MANIFEST,
  completenessExpression,
  completenessFromDq,
  dqAnd,
  dqNotNull,
  parseRunDq,
  requireCompleteCollection,
} from "../../src/federation/dq.ts";
import { DuckDbFallbackPort } from "../../src/federation/fallback.ts";
import { assertReadOnly, prepareStatement } from "../../src/federation/sql.ts";
import { PortError, type FederationResult } from "../../src/ports/index.ts";
import { livePort, startStub, wire, type Stub } from "./helpers/zetaris-stub.ts";

const failure = (fn: () => unknown): PortError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected a PortError");
};

const dqResult = (headers: string[], rows: (string | number | null)[][]): FederationResult => ({
  columns: headers.map((name) => ({ name, type: "string" })),
  rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i]]))),
  total: rows.length,
  queryId: "q",
  servedFrom: "live",
  respHash: "h",
  elapsedMs: 0,
});

describe("USL statement builders", () => {
  it("creates the parent namespace before the package namespace, which the engine requires", () => {
    expect(buildCreateNamespaceSql("sakaime")).toEqual(["CREATE NAMESPACE IF NOT EXISTS lightning.metastore", "CREATE NAMESPACE IF NOT EXISTS lightning.metastore.sakaime"]);
  });

  it("writes the whole COMPILE USL as one statement with each CREATE TABLE starting a line", () => {
    const sql = buildCompileUslSql({
      usl: "evidence",
      namespace: "sakaime",
      ifNotExists: true,
      tables: [
        { name: "device", columns: [{ name: "device_id", type: "varchar(40)", primaryKey: true }, { name: "name", type: "varchar(200)" }] },
        { name: "study", columns: [{ name: "nct_id", type: "varchar(20)", primaryKey: true }, { name: "device_id", type: "varchar(40)", references: { table: "device", column: "device_id" } }, { name: "enrollment", type: "bigint" }] },
      ],
    });
    expect(sql).toBe(
      [
        "COMPILE USL IF NOT EXISTS evidence DEPLOY NAMESPACE lightning.metastore.sakaime DDL",
        "CREATE TABLE device (",
        "  device_id varchar(40) NOT NULL PRIMARY KEY,",
        "  name varchar(200)",
        ");",
        "CREATE TABLE study (",
        "  nct_id varchar(20) NOT NULL PRIMARY KEY,",
        "  device_id varchar(40) FOREIGN KEY REFERENCES device(device_id),",
        "  enrollment bigint",
        ")",
      ].join("\n"),
    );
    const prepared = prepareStatement(sql);
    expect(prepared.multiDdl).toBe(true);
    expect(prepared.text.split("\n").filter((l) => l.startsWith("CREATE TABLE"))).toHaveLength(2);
  });

  it("compiles without deploying when asked", () => {
    expect(buildCompileUslSql({ usl: "u", namespace: "n", deploy: false, tables: [{ name: "t", columns: [{ name: "a", type: "int" }] }] })).toContain("COMPILE USL u NAMESPACE lightning.metastore.n DDL");
  });

  it("is not a read-only statement, so the agent identity cannot send it", () => {
    const sql = buildCompileUslSql({ usl: "u", namespace: "n", tables: [{ name: "t", columns: [{ name: "a", type: "int" }] }] });
    expect(failure(() => assertReadOnly(prepareStatement(sql))).failure).toBe("REFUSED");
  });

  it("refuses names and types that could carry SQL", () => {
    const table = (name: string, type = "int") => ({ usl: "u", namespace: "n", tables: [{ name, columns: [{ name: "a", type }] }] });
    expect(failure(() => buildCompileUslSql(table("t); DROP TABLE x; --"))).failure).toBe("INVALID");
    expect(failure(() => buildCompileUslSql(table("t", "int); DROP TABLE x; --"))).detail?.["reason"]).toBe("BAD_TYPE");
    expect(failure(() => buildCompileUslSql(table("t", "array<int>"))).detail?.["reason"]).toBe("BAD_TYPE");
    expect(failure(() => buildCompileUslSql({ usl: "u v", namespace: "n", tables: table("t").tables })).failure).toBe("INVALID");
    expect(failure(() => buildCompileUslSql({ usl: "u", namespace: "n.x", tables: table("t").tables })).failure).toBe("INVALID");
    expect(failure(() => buildCompileUslSql({ usl: "u", namespace: "n", tables: [] })).detail?.["reason"]).toBe("EMPTY_USL");
    expect(failure(() => buildCompileUslSql({ usl: "u", namespace: "n", tables: [{ name: "t", columns: [] }] })).detail?.["reason"]).toBe("EMPTY_TABLE");
  });

  it("activates a table with an explicit cast on every column and never filters rows", () => {
    const sql = buildActivateUslTableSql({
      namespace: "sakaime",
      usl: "evidence",
      table: "study",
      source: ["registry", "studies"],
      columns: [
        { name: "nct_id", type: "varchar(20)", nullSentinel: "UNKNOWN" },
        { name: "enrollment", type: "bigint", nullSentinel: -1 },
        { name: "started", type: "date", from: "start_date" },
      ],
    });
    expect(sql).toBe(
      "ACTIVATE USL TABLE lightning.metastore.sakaime.evidence.study AS SELECT CAST(COALESCE(nct_id, 'UNKNOWN') AS varchar(20)) AS nct_id, CAST(COALESCE(enrollment, -1) AS bigint) AS enrollment, CAST(start_date AS date) AS started FROM registry.studies",
    );
    expect(sql).not.toMatch(/\bWHERE\b/i);
  });

  it("builds the data-quality statements in the documented forms", () => {
    const ref = { namespace: "sakaime", usl: "evidence", table: "study" };
    expect(buildRunDqSql(ref)).toBe("RUN DQ TABLE lightning.metastore.sakaime.evidence.study");
    expect(buildRunDqSql({ ...ref, rule: "has_enrollment" })).toBe("RUN DQ has_enrollment TABLE lightning.metastore.sakaime.evidence.study");
    expect(buildListDqSql("sakaime", "evidence")).toBe("LIST DQ USL lightning.metastore.sakaime.evidence");
    expect(buildLoadUslSql("sakaime", "evidence")).toBe("LOAD USL evidence NAMESPACE lightning.metastore.sakaime");
    expect(buildRegisterDqSql({ ...ref, rule: "has_enrollment", expression: dqAnd(dqNotNull("enrollment")) })).toBe(
      "REGISTER DQ has_enrollment TABLE lightning.metastore.sakaime.evidence.study AS enrollment IS NOT NULL",
    );
  });

  it("keeps the read statements read-only and the rule registration admin-only", () => {
    const ref = { namespace: "n", usl: "u", table: "t" };
    for (const sql of [buildRunDqSql(ref), buildListDqSql("n", "u"), buildLoadUslSql("n", "u")]) expect(() => assertReadOnly(prepareStatement(sql))).not.toThrow();
    expect(failure(() => assertReadOnly(prepareStatement(buildRegisterDqSql({ ...ref, rule: "r", expression: dqNotNull("a") })))).failure).toBe("REFUSED");
  });

  it("will not take a rule name or column from text that is not a plain name", () => {
    const ref = { namespace: "n", usl: "u", table: "t" };
    expect(failure(() => buildRunDqSql({ ...ref, rule: "r TABLE x; DROP" })).failure).toBe("INVALID");
    expect(failure(() => dqNotNull("a OR 1=1")).failure).toBe("INVALID");
    expect(failure(() => dqAnd()).failure).toBe("INVALID");
  });
});

describe("the completeness rule as a data-quality rule", () => {
  it("is valid only when the source gave a total, all of it arrived and nothing was flagged cut short", () => {
    expect(completenessExpression().sql).toBe("expected_total IS NOT NULL AND retrieved_total IS NOT NULL AND retrieved_total >= expected_total AND truncated = FALSE");
  });
  it("registers and runs against the manifest table", () => {
    expect(buildRegisterCompletenessRuleSql("sakaime", "evidence")).toBe(
      "REGISTER DQ collection_complete TABLE lightning.metastore.sakaime.evidence.collection_manifest AS expected_total IS NOT NULL AND retrieved_total IS NOT NULL AND retrieved_total >= expected_total AND truncated = FALSE",
    );
    expect(buildRunCompletenessSql("sakaime", "evidence")).toBe("RUN DQ collection_complete TABLE lightning.metastore.sakaime.evidence.collection_manifest");
  });
  it("is declarable as a USL table", () => {
    const sql = buildCompileUslSql({ usl: "evidence", namespace: "sakaime", tables: [COMPLETENESS_MANIFEST] });
    expect(sql).toContain("collection_id varchar(200) NOT NULL PRIMARY KEY");
    expect(() => prepareStatement(sql)).not.toThrow();
  });

  // The same expression, evaluated by a real engine over rows that should pass and rows that should not.
  it("passes exactly the manifest rows that are complete (evaluated on DuckDB)", async () => {
    const port = await DuckDbFallbackPort.create();
    await port.registerTable(
      "dq.manifest",
      [
        { name: "collection_id", type: "string" },
        { name: "expected_total", type: "bigint" },
        { name: "retrieved_total", type: "bigint" },
        { name: "truncated", type: "boolean" },
      ],
      [
        ["complete", 100, 100, false],
        ["more-than-expected", 100, 101, false],
        ["cut-short", 100, 40, false],
        ["flagged", 100, 100, true],
        ["no-total", null, 100, false],
        ["nothing-arrived", 100, null, false],
        ["flag-unknown", 100, 100, null],
      ],
    );
    const valid = await port.sql(`SELECT collection_id FROM dq.manifest WHERE ${completenessExpression().sql} ORDER BY collection_id`);
    expect(valid.rows.map((r) => r["collection_id"])).toEqual(["complete", "more-than-expected"]);
    port.close();
  });
});

describe("parseRunDq", () => {
  it("reads the documented count columns", () => {
    expect(parseRunDq(dqResult(["total_records", "valid_records", "invalid_records"], [["7", "6", "1"]]))).toEqual([{ total: 7, valid: 6, invalid: 1 }]);
  });
  it("reads one row per rule when the rule is named, and short column names", () => {
    expect(parseRunDq(dqResult(["rule", "total", "valid", "invalid"], [["pk", 3, 3, 0], ["fk", 3, 2, 1]]))).toEqual([
      { rule: "pk", total: 3, valid: 3, invalid: 0 },
      { rule: "fk", total: 3, valid: 2, invalid: 1 },
    ]);
  });
  it("is DRIFTED, never zero, when the counts are missing or are not counts", () => {
    expect(failure(() => parseRunDq(dqResult(["a", "b"], [["1", "2"]]))).failure).toBe("DRIFTED");
    expect(failure(() => parseRunDq(dqResult(["total_records", "valid_records", "invalid_records"], [["x", "1", "1"]]))).failure).toBe("DRIFTED");
    expect(failure(() => parseRunDq(dqResult(["total_records", "valid_records", "invalid_records"], [["-1", "1", "1"]]))).failure).toBe("DRIFTED");
    expect(failure(() => parseRunDq(dqResult(["total_records", "valid_records", "invalid_records"], [[null, "1", "1"]]))).failure).toBe("DRIFTED");
  });
  it("returns no results for an empty answer", () => {
    expect(parseRunDq(dqResult(["total_records", "valid_records", "invalid_records"], []))).toEqual([]);
  });
});

describe("completenessFromDq", () => {
  it("is complete only when rows exist and none failed", () => {
    expect(completenessFromDq([{ rule: "collection_complete", total: 5, valid: 5, invalid: 0 }])).toEqual({ status: "COMPLETE" });
  });
  it("is truncated when any collection failed the rule", () => {
    expect(completenessFromDq([{ total: 5, valid: 4, invalid: 1 }])).toMatchObject({ status: "TRUNCATED" });
  });
  it("cannot tell, and says so, when there are no results or an empty manifest", () => {
    expect(completenessFromDq([])).toMatchObject({ status: "UNVERIFIABLE" });
    expect(completenessFromDq([{ total: 0, valid: 0, invalid: 0 }])).toMatchObject({ status: "UNVERIFIABLE" });
  });
  it("ignores results for other rules", () => {
    expect(completenessFromDq([{ rule: "pk", total: 5, valid: 5, invalid: 0 }])).toMatchObject({ status: "UNVERIFIABLE" });
    expect(completenessFromDq([{ rule: "pk", total: 5, valid: 0, invalid: 5 }, { rule: "collection_complete", total: 2, valid: 2, invalid: 0 }])).toEqual({ status: "COMPLETE" });
  });
});

describe("the completeness rule as a code check", () => {
  it("accepts a collection that arrived whole", () => {
    expect(checkCollectionCompleteness({ retrieved: 100, expectedTotal: 100 })).toEqual({ status: "COMPLETE" });
    expect(checkCollectionCompleteness({ retrieved: 101, expectedTotal: 100, truncated: false }).status).toBe("COMPLETE");
    expect(checkCollectionCompleteness({ retrieved: 0, expectedTotal: 0 }).status).toBe("COMPLETE");
  });
  it("refuses a collection that is known to be cut short", () => {
    expect(checkCollectionCompleteness({ retrieved: 40, expectedTotal: 100 })).toMatchObject({ status: "TRUNCATED", reason: "40 of 100 records arrived" });
    expect(checkCollectionCompleteness({ retrieved: 100, expectedTotal: 100, truncated: true }).status).toBe("TRUNCATED");
    expect(checkCollectionCompleteness({ retrieved: 5, truncated: true }).status).toBe("TRUNCATED");
  });
  it("does not call a collection complete when it cannot tell", () => {
    expect(checkCollectionCompleteness({ retrieved: 100 }).status).toBe("UNVERIFIABLE");
    expect(checkCollectionCompleteness({ retrieved: 100, expectedTotal: null, truncated: null }).status).toBe("UNVERIFIABLE");
  });
  it("accepts a connector's own statement that it reached the end when the source gave no total, and says that is what it rests on", () => {
    expect(checkCollectionCompleteness({ retrieved: 100, truncated: false })).toMatchObject({ status: "COMPLETE", note: expect.stringContaining("reaching the end") });
  });
  it("throws TRUNCATED for a known cut and REFUSED for 'cannot tell'; returns for a whole collection", () => {
    expect(() => requireCompleteCollection({ retrieved: 100, expectedTotal: 100 })).not.toThrow();
    const cut = failure(() => requireCompleteCollection({ retrieved: 1, expectedTotal: 100 }));
    expect(cut.failure).toBe("TRUNCATED");
    const unknown = failure(() => requireCompleteCollection({ retrieved: 1 }));
    expect(unknown.failure).toBe("REFUSED");
    expect(unknown.detail?.["reason"]).toBe("UNVERIFIABLE");
  });
  it("rejects counts that are not counts", () => {
    for (const facts of [{ retrieved: -1 }, { retrieved: 1.5 }, { retrieved: Number.NaN }, { retrieved: 1, expectedTotal: -3 }, { retrieved: 1, expectedTotal: 2.5 }]) {
      expect(failure(() => checkCollectionCompleteness(facts)).failure, JSON.stringify(facts)).toBe("INVALID");
    }
  });
});

describe("sent through the live port", () => {
  let stub: Stub;
  beforeAll(async () => {
    stub = await startStub();
  });
  afterAll(() => stub.close());
  afterEach(() => stub.reset());

  it("a COMPILE USL goes out as one request under the admin policy, and the read-only agent cannot send it", async () => {
    stub.handler = () => ({ body: wire(["result"], [["ok"]]) });
    const sql = buildCompileUslSql({ usl: "evidence", namespace: "sakaime", tables: [COMPLETENESS_MANIFEST, { name: "other", columns: [{ name: "id", type: "int" }] }] });
    const { port } = livePort(stub);
    await expect(port.sql(sql)).rejects.toMatchObject({ failure: "REFUSED" });
    expect(stub.requests).toHaveLength(0);
    await port.sql(sql, { statementPolicy: "admin" });
    expect(stub.requests).toHaveLength(1);
    expect((stub.requests[0]!.json!["sql"] as string).match(/CREATE TABLE/g)).toHaveLength(2);
  });

  it("RUN DQ runs as the read-only identity and its counts decide completeness", async () => {
    stub.handler = () => ({ body: wire(["total_records", "valid_records", "invalid_records"], [["3", "2", "1"]]) });
    const { port } = livePort(stub);
    const result = await port.sql(buildRunCompletenessSql("sakaime", "evidence"));
    expect(completenessFromDq(parseRunDq(result))).toMatchObject({ status: "TRUNCATED" });
    expect(stub.requests[0]!.json!["sql"]).toBe("RUN DQ collection_complete TABLE lightning.metastore.sakaime.evidence.collection_manifest");
  });

  it("a DQ result with unexpected columns is DRIFTED end to end", async () => {
    stub.handler = () => ({ body: wire(["something", "else"], [["1", "2"]]) });
    const result = await livePort(stub).port.sql("RUN DQ TABLE lightning.metastore.n.u.t");
    expect(failure(() => parseRunDq(result)).failure).toBe("DRIFTED");
  });
});
