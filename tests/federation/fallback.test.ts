import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DuckDbFallbackPort } from "../../src/federation/fallback.ts";
import { translateSparkToDuckDb } from "../../src/federation/translate.ts";
import { PortError } from "../../src/ports/index.ts";
import { fixturePort } from "./helpers/fixtures.ts";

async function failureOf(p: Promise<unknown>): Promise<PortError> {
  try {
    await p;
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
}
const refusal = (sql: string): PortError => {
  try {
    translateSparkToDuckDb(sql);
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error(`expected a refusal for: ${sql}`);
};

describe("translation: what is carried across", () => {
  it("rewrites backquoted names to double-quoted names", () => {
    expect(translateSparkToDuckDb("SELECT `order` FROM hospital.`table`")).toBe('SELECT "order" FROM hospital."table"');
    expect(translateSparkToDuckDb("SELECT `we``ird` FROM t")).toBe('SELECT "we`ird" FROM t');
  });
  it("reads Spark's double-quoted text as a string and re-quotes it for DuckDB", () => {
    expect(translateSparkToDuckDb('SELECT "abc" AS a')).toBe("SELECT 'abc' AS a");
    expect(translateSparkToDuckDb(`SELECT "it's" AS a`)).toBe("SELECT 'it''s' AS a");
  });
  it("renames the three functions that differ", () => {
    expect(translateSparkToDuckDb("SELECT collect_list(a) FROM t")).toBe("SELECT list(a) FROM t");
    expect(translateSparkToDuckDb("SELECT array_join(collect_list(a), ',') FROM t")).toBe("SELECT array_to_string(list(a), ',') FROM t");
    expect(translateSparkToDuckDb("SELECT nvl(a, 0) FROM t")).toBe("SELECT coalesce(a, 0) FROM t");
  });
  it("drops optimiser hints", () => {
    expect(translateSparkToDuckDb("SELECT /*+ BROADCAST(t) */ a FROM t")).toBe("SELECT a FROM t");
  });
  it("passes through the constructs the Evidence Matrix uses", () => {
    const sql = "SELECT a, COUNT(*) AS n, SUM(CASE WHEN s IN ('x', 'y') THEN 1 ELSE 0 END) AS k FROM d.t LEFT JOIN (SELECT b FROM d.u GROUP BY b) x ON x.b = a WHERE e <= DATE '2026-01-01' GROUP BY a ORDER BY a";
    expect(translateSparkToDuckDb(sql)).toBe(sql);
  });
});

describe("translation: what is refused", () => {
  it.each([
    ["concat", "SELECT concat(a, b) FROM t"],
    ["null-safe equality", "SELECT a FROM t WHERE a <=> b"],
    ["XOR", "SELECT a ^ b FROM t"],
    ["bare negation", "SELECT !a FROM t"],
    ["lateral view", "SELECT x FROM t LATERAL VIEW explode(arr) e AS x"],
    ["explode", "SELECT explode(arr) FROM t"],
    ["rlike", "SELECT a FROM t WHERE a RLIKE 'x'"],
    ["regexp", "SELECT a FROM t WHERE a REGEXP 'x'"],
    ["tablesample", "SELECT a FROM t TABLESAMPLE (10 PERCENT)"],
    ["cluster by", "SELECT a FROM t CLUSTER BY a"],
    ["interval", "SELECT a FROM t WHERE d > d2 + INTERVAL 1 DAY"],
    ["engine suffix", "SELECT a FROM t USING Presto"],
    ["current_date", "SELECT a FROM t WHERE d < current_date"],
    ["unlisted function", "SELECT reflect('java.lang.System', 'getenv') FROM t"],
    ["adjacent literals", "SELECT 'a' 'b' AS a"],
    ["doubled quote", "SELECT 'it''s' AS a"],
    ["long literal", "SELECT 5L AS a"],
    ["double literal", "SELECT 1.5D AS a"],
    ["backslash in text", "SELECT 'a\\nb' AS a"],
    ["not a query", "SHOW LIGHTNING DATABASES"],
  ])("%s", (_n, sql) => {
    const e = refusal(sql);
    expect(e.failure).toBe("REFUSED");
    expect(e.detail?.["reason"]).toBe("UNTRANSLATABLE");
  });
  it("names the construct it refused", () => {
    expect(refusal("SELECT concat(a, b) FROM t").message).toMatch(/concat.*NULL/);
    expect(refusal("SELECT foo(a) FROM t").message).toContain("foo()");
  });
  it("still allows JOIN ... USING (column)", () => {
    expect(() => translateSparkToDuckDb("SELECT * FROM a JOIN b USING (id)")).not.toThrow();
  });
});

describe("DuckDbFallbackPort", () => {
  let port: DuckDbFallbackPort;
  beforeEach(async () => {
    port = await fixturePort();
  });
  afterEach(() => port.close());

  it("labels every result fallback and reports itself as a local snapshot, not live", async () => {
    const r = await port.sql("SELECT requirement_id FROM hospital.requirements ORDER BY requirement_id");
    expect(r.servedFrom).toBe("fallback");
    expect(port.mode).toBe("fallback");
    expect(r.rows).toEqual([{ requirement_id: "R1" }, { requirement_id: "R2" }]);
    const c = await port.check();
    expect(c.health).toBe("STALE");
    expect(c.detail).toContain("not Zetaris");
  });

  it("returns typed values from the native column types", async () => {
    const r = await port.sql("SELECT nct_id, enrollment, start_date, completion_date FROM registry.studies WHERE nct_id IN ('N1', 'N3') ORDER BY nct_id");
    expect(r.rows).toEqual([
      { nct_id: "N1", enrollment: 400, start_date: "2024-01-01", completion_date: "2025-01-01" },
      { nct_id: "N3", enrollment: 100, start_date: "2025-09-01", completion_date: null },
    ]);
    expect(r.columns.map((c) => c.type)).toEqual(["string", "bigint", "date", "date"]);
  });

  it("applies a declared schema over native types, the same way the live port does", async () => {
    const r = await port.sql("SELECT enrollment FROM registry.studies WHERE nct_id = 'N1'", { schema: { enrollment: "string" } });
    expect(r.rows).toEqual([{ enrollment: "400" }]);
  });

  it("renders the same values as the live port for the same data (booleans, decimals, big integers)", async () => {
    const r = await port.sql("SELECT CAST(9007199254740993 AS BIGINT) AS big, TRUE AS flag, CAST(1.250 AS DECIMAL(10,3)) AS dec, CAST(NULL AS STRING) AS nothing");
    expect(r.rows).toEqual([{ big: "9007199254740993", flag: true, dec: 1.25, nothing: null }]);
  });

  it("is read-only", async () => {
    for (const s of ["DROP TABLE hospital.requirements", "INSERT INTO hospital.requirements SELECT * FROM hospital.requirements", "DELETE FROM hospital.requirements", "CREATE TABLE x AS SELECT 1"]) {
      expect((await failureOf(port.sql(s))).failure, s).toBe("REFUSED");
    }
    expect((await port.sql("SELECT count(*) AS n FROM hospital.requirements")).rows).toEqual([{ n: 2 }]);
  });

  it("cannot read files through SQL, and cannot be given tables once it has answered", async () => {
    // Two layers refuse it: the read-only policy names the function, and the translator, were the policy ever relaxed, still cannot render it.
    expect((await failureOf(port.sql("SELECT * FROM read_csv('x.csv')"))).detail?.["reason"]).toBe("DENIED_FUNCTION");
    expect(() => translateSparkToDuckDb("SELECT * FROM read_csv('x.csv')")).toThrowError(expect.objectContaining({ detail: expect.objectContaining({ reason: "UNTRANSLATABLE" }) }));
    // DuckDB's file-as-table form passes the translator, so the engine's own switch must stop it.
    const direct = await failureOf(port.sql("SELECT * FROM 'x.csv'"));
    expect(direct.failure).toBe("INVALID");
    expect(direct.message).toMatch(/disabled|permission/i);
    await port.sql("SELECT 1");
    const e = await failureOf(port.registerTable("late.t", [{ name: "a", type: "int" }], [[1]]));
    expect(e.detail?.["reason"]).toBe("SEALED");
  });

  it("refuses more than one statement and an empty statement", async () => {
    expect((await failureOf(port.sql("SELECT 1; SELECT 2"))).failure).toBe("INVALID");
    expect((await failureOf(port.sql(" "))).failure).toBe("INVALID");
  });

  it("refuses a partial result like the live port", async () => {
    expect((await failureOf(port.sql("SELECT nct_id FROM registry.studies", { limit: 2 }))).failure).toBe("TRUNCATED");
    expect((await port.sql("SELECT nct_id FROM registry.studies", { limit: 4 })).rows).toHaveLength(4);
  });

  it("refuses two columns of one name", async () => {
    expect((await failureOf(port.sql("SELECT a.submission_id, b.submission_id FROM hospital.submissions a JOIN hospital.cases b ON a.submission_id = b.submission_id"))).failure).toBe("INVALID");
  });

  it("reports an engine error as INVALID with the engine's words", async () => {
    const e = await failureOf(port.sql("SELECT nope FROM hospital.requirements"));
    expect(e.failure).toBe("INVALID");
    expect(e.message).toContain("nope");
  });

  it("sorts NULL first on ascending and last on descending, as Spark does", async () => {
    const asc = await port.sql("SELECT completion_date FROM registry.studies ORDER BY completion_date");
    expect(asc.rows[0]).toEqual({ completion_date: null });
    const desc = await port.sql("SELECT completion_date FROM registry.studies ORDER BY completion_date DESC");
    expect(desc.rows[desc.rows.length - 1]).toEqual({ completion_date: null });
  });

  it("gives Spark's answer for NULL arithmetic with || and keeps concat out of reach", async () => {
    expect((await port.sql("SELECT ('a' || CAST(NULL AS STRING)) AS v")).rows).toEqual([{ v: null }]);
  });

  it("runs the statements concurrently without interleaving them", async () => {
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => port.sql(`SELECT ${i} AS n`)));
    expect(results.map((r) => r.rows[0]!["n"])).toEqual(Array.from({ length: 20 }, (_, i) => i));
  });

  describe("catalog statements", () => {
    it("lists file and REST sources and JDBC sources under the statements Zetaris uses", async () => {
      const lightning = await port.sql("SHOW LIGHTNING DATABASES");
      expect(lightning.rows.map((r) => r["name"])).toEqual(["registry", "regulator", "vendor_packets"]);
      expect(lightning.columns.map((c) => c.name)).toEqual(["name", "description", "id"]);
      expect((await port.sql("SHOW DATASOURCES")).rows.map((r) => r["name"])).toEqual(["hospital"]);
    });
    it("lists the tables of one database", async () => {
      const t = await port.sql("SHOW TABLES IN hospital");
      expect(t.rows.map((r) => r["tableName"])).toEqual(["cases", "decisions", "identity_links", "precedents", "requirements", "reviewers", "submissions", "vendors"]);
    });
    it("refuses an unknown database and an unsupported SHOW", async () => {
      expect((await failureOf(port.sql("SHOW TABLES IN nowhere"))).failure).toBe("INVALID");
      expect((await failureOf(port.sql("SHOW GRANT"))).failure).toBe("REFUSED");
    });
  });
});

describe("loading from files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sakaime-fallback-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("loads a CSV with a header and casts to declared types, reading an empty cell as unknown", async () => {
    const csv = join(dir, "claims.csv");
    writeFileSync(csv, 'claim_id,metric_value,page,note\nC1,0.91,4,"has, comma"\nC2,,7,\n');
    const p = await DuckDbFallbackPort.create();
    await p.registerCsv("vendor_packets.claims", csv, [
      { name: "claim_id", type: "string" },
      { name: "metric_value", type: "double" },
      { name: "page", type: "integer" },
      { name: "note", type: "string" },
    ]);
    const r = await p.sql("SELECT * FROM vendor_packets.claims ORDER BY claim_id");
    expect(r.rows).toEqual([
      { claim_id: "C1", metric_value: 0.91, page: 4, note: "has, comma" },
      { claim_id: "C2", metric_value: null, page: 7, note: null },
    ]);
    p.close();
  });

  it("fails loudly on a CSV value that does not fit the declared type", async () => {
    const csv = join(dir, "bad.csv");
    writeFileSync(csv, "a\nnot-a-number\n");
    const p = await DuckDbFallbackPort.create();
    await expect(p.registerCsv("d.t", csv, [{ name: "a", type: "integer" }])).rejects.toThrow();
    p.close();
  });

  it("loads a Parquet file", async () => {
    const parquet = join(dir, "p.parquet");
    const writer = await DuckDBInstance.create(":memory:");
    const wc = await writer.connect();
    await wc.run(`COPY (SELECT 1 AS id, 'a' AS name UNION ALL SELECT 2, 'b') TO '${parquet.replace(/\\/g, "/")}' (FORMAT PARQUET)`);
    writer.closeSync();
    const p = await DuckDbFallbackPort.create();
    await p.registerParquet("regulator.snapshot", parquet);
    expect((await p.sql("SELECT id, name FROM regulator.snapshot ORDER BY id")).rows).toEqual([
      { id: 1, name: "a" },
      { id: 2, name: "b" },
    ]);
    p.close();
  });

  it("refuses table and column names that are not plain", async () => {
    const p = await DuckDbFallbackPort.create();
    await expect(p.registerTable("a b.t", [{ name: "x", type: "int" }], [])).rejects.toThrow(PortError);
    await expect(p.registerTable("d.t", [{ name: "x; DROP", type: "int" }], [])).rejects.toThrow(PortError);
    await expect(p.registerTable("d.t", [{ name: "x", type: "geometry" }], [])).rejects.toThrow(PortError);
    await expect(p.registerTable("d.t", [{ name: "x", type: "int" }], [[1, 2]])).rejects.toThrow(PortError);
    p.close();
  });
});
