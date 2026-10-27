import { DuckDBInstance } from "@duckdb/node-api";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PortError } from "../../src/ports/index.ts";
import {
  assertReadOnly,
  isSafeIdent,
  prepareStatement,
  sqlBoolean,
  sqlDate,
  sqlIdent,
  sqlList,
  sqlNumber,
  sqlQualified,
  sqlString,
  sqlValue,
  statementKey,
  tokenize,
} from "../../src/federation/sql.ts";

const failure = (fn: () => unknown): PortError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected a PortError");
};

describe("prepareStatement", () => {
  it("strips trailing semicolons and surrounding whitespace", () => {
    expect(prepareStatement("SELECT 1;").text).toBe("SELECT 1");
    expect(prepareStatement("  SELECT 1 ;; \n ").text).toBe("SELECT 1");
    expect(prepareStatement("SELECT 1; -- done").text).toBe("SELECT 1");
    expect(prepareStatement("SELECT 1 /* c */ ;").text).toBe("SELECT 1");
  });

  it("collapses whitespace and drops comments, so formatting does not change the statement", () => {
    expect(prepareStatement("SELECT\n  a,\n  b -- note\nFROM   t").text).toBe("SELECT a, b FROM t");
  });

  it("keeps whitespace inside string literals untouched", () => {
    expect(prepareStatement("SELECT 'a    b ; c'").text).toBe("SELECT 'a    b ; c'");
  });

  it("refuses an empty statement", () => {
    for (const s of ["", "   ", ";", " ; ; ", "-- only a comment", "/* x */;"]) {
      expect(failure(() => prepareStatement(s)).failure, JSON.stringify(s)).toBe("INVALID");
    }
  });

  it("refuses more than one statement, even when each is harmless", () => {
    for (const s of ["SELECT 1; SELECT 2", "SELECT 1;SELECT 2;", "SELECT 1; DROP TABLE hospital.requirements", "SELECT 1 ; -- c\n DELETE FROM t"]) {
      const e = failure(() => prepareStatement(s));
      expect(e.failure, s).toBe("INVALID");
      expect(e.detail?.["reason"]).toBe("MULTI_STATEMENT");
    }
  });

  it("allows a semicolon inside a string, a quoted name or a comment", () => {
    expect(() => prepareStatement("SELECT 'a;b' AS x")).not.toThrow();
    expect(() => prepareStatement('SELECT "a;b" AS x')).not.toThrow();
    expect(() => prepareStatement("SELECT `a;b` FROM t")).not.toThrow();
    expect(() => prepareStatement("SELECT 1 -- a; b\n")).not.toThrow();
    expect(() => prepareStatement("SELECT 1 /* a; b */")).not.toThrow();
  });

  it("refuses an unterminated string, comment or quoted name", () => {
    for (const s of ["SELECT 'abc", "SELECT 1 /* x", "SELECT `abc", 'SELECT "abc']) {
      expect(failure(() => prepareStatement(s)).failure, s).toBe("INVALID");
    }
  });

  it("refuses quoting that Spark and standard SQL read differently around a semicolon", () => {
    // Spark: the backslash escapes the quote, so the literal runs on and the semicolon is inside it.
    // Standard SQL: the literal ends at the second quote and the semicolon starts a second statement.
    const e = failure(() => prepareStatement("SELECT 'a\\'; DROP TABLE t; --'"));
    expect(e.detail?.["reason"]).toBe("AMBIGUOUS_QUOTING");
  });

  it("refuses NUL characters and oversized text", () => {
    expect(failure(() => prepareStatement("SELECT '\u0000'")).failure).toBe("INVALID");
    expect(failure(() => prepareStatement(`SELECT '${"x".repeat(200_001)}'`)).failure).toBe("INVALID");
  });

  it("permits the documented multi-table COMPILE USL and nothing else with semicolons", () => {
    const ok = "COMPILE USL u DEPLOY NAMESPACE lightning.metastore.n DDL\nCREATE TABLE a (id int);\nCREATE TABLE b (id int);";
    const p = prepareStatement(ok);
    expect(p.multiDdl).toBe(true);
    expect(p.text).toBe("COMPILE USL u DEPLOY NAMESPACE lightning.metastore.n DDL\nCREATE TABLE a (id int);\nCREATE TABLE b (id int)");
    const smuggled = "COMPILE USL u DEPLOY NAMESPACE lightning.metastore.n DDL\nCREATE TABLE a (id int);\nDROP TABLE hospital.requirements";
    expect(failure(() => prepareStatement(smuggled)).detail?.["reason"]).toBe("MULTI_STATEMENT");
    const selectAfter = "COMPILE USL u DEPLOY NAMESPACE lightning.metastore.n DDL\nCREATE TABLE a (id int); SELECT * FROM hospital.requirements";
    expect(failure(() => prepareStatement(selectAfter)).failure).toBe("INVALID");
  });
});

describe("tokenize", () => {
  it("reads Spark double quotes as strings and standard double quotes as names", () => {
    expect(tokenize('SELECT "a"', "spark").find((t) => t.text === '"a"')?.kind).toBe("string");
    expect(tokenize('SELECT "a"', "standard").find((t) => t.text === '"a"')?.kind).toBe("quoted-ident");
  });
  it("splits Spark's adjacent literals where standard SQL sees one doubled quote", () => {
    expect(tokenize("'it''s'", "spark").filter((t) => t.kind === "string")).toHaveLength(2);
    expect(tokenize("'it''s'", "standard").filter((t) => t.kind === "string")).toHaveLength(1);
  });
});

describe("read-only policy", () => {
  const verdict = (sql: string): string | undefined => {
    try {
      assertReadOnly(prepareStatement(sql));
      return undefined;
    } catch (e) {
      return e instanceof PortError ? e.failure : "other";
    }
  };
  it("allows reads", () => {
    for (const s of ["SELECT 1", "WITH x AS (SELECT 1 AS a) SELECT * FROM x", "SHOW LIGHTNING DATABASES", "SHOW TABLES IN hospital", "DESCRIBE hospital.requirements", "LOAD USL u NAMESPACE lightning.metastore.n", "RUN DQ TABLE lightning.metastore.n.u.t", "LIST DQ USL lightning.metastore.n.u", "EXPLAIN SELECT 1"]) {
      expect(verdict(s), s).toBeUndefined();
    }
  });
  it("refuses statements that can change data or definitions", () => {
    for (const s of [
      "DROP TABLE hospital.requirements",
      "INSERT INTO hospital.requirements VALUES (1)",
      "UPDATE hospital.requirements SET setting = 'x'",
      "DELETE FROM hospital.requirements",
      "CREATE TABLE x (a int)",
      "ALTER TABLE hospital.requirements ADD COLUMN c int",
      "GRANT SELECT ON hospital.requirements TO ROLE r",
      "REGISTER DQ r TABLE lightning.metastore.n.u.t AS a IS NOT NULL",
      "COMPILE USL u DEPLOY NAMESPACE lightning.metastore.n DDL\nCREATE TABLE a (id int)",
      "ACTIVATE USL TABLE lightning.metastore.n.u.t AS SELECT 1",
      "CACHE TABLE hospital.requirements",
      "TRUNCATE TABLE hospital.requirements",
    ]) {
      expect(verdict(s), s).toBe("REFUSED");
    }
  });
  it("refuses a CTE that ends in a write", () => {
    expect(verdict("WITH x AS (SELECT 1 AS a) INSERT INTO hospital.requirements SELECT * FROM x")).toBe("REFUSED");
    expect(verdict("WITH x AS (SELECT 1 AS a) DELETE FROM hospital.requirements")).toBe("REFUSED");
  });
  it("does not mistake a column or text that contains a verb for the verb", () => {
    expect(verdict("SELECT update_control_required, 'DROP TABLE x' AS note FROM hospital.requirements")).toBeUndefined();
    expect(verdict("SELECT `delete` FROM hospital.requirements")).toBeUndefined();
  });
});

describe("read-only policy: deny list for code execution, file reach and dynamic statements", () => {
  const verdict = (sql: string): { failure: string; reason?: unknown; detail?: unknown } | undefined => {
    try {
      assertReadOnly(prepareStatement(sql));
      return undefined;
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      return { failure: e.failure, reason: (e.detail as { reason?: unknown } | undefined)?.reason, detail: e.detail };
    }
  };

  it("refuses the functions that run arbitrary code on the engine host, in any case and however they are written", () => {
    for (const s of [
      "SELECT reflect('java.lang.System', 'getenv', 'PATH')",
      "SELECT REFLECT('java.lang.System', 'exit', 1)",
      "SELECT java_method('java.lang.Runtime', 'getRuntime')",
      "SELECT try_reflect('java.lang.System', 'getenv', 'PATH')",
      "SELECT reflect /* gap */ ('a', 'b')",
      "SELECT reflect\n('a', 'b')",
      "SELECT `reflect`('a', 'b')",
      "SELECT x.reflect('a', 'b') FROM t",
      "SELECT 1 FROM t WHERE java_method('a','b') = 'c'",
      "WITH c AS (SELECT reflect('a','b') AS r) SELECT * FROM c",
      "SELECT call_function('reflect', 'a', 'b')",
      "SELECT call_udf('reflect', 'a')",
    ]) {
      const v = verdict(s);
      expect(v?.failure, s).toBe("REFUSED");
      expect(v?.reason, s).toBe("DENIED_FUNCTION");
    }
  });

  it("names the function that was refused", () => {
    expect(verdict("SELECT java_method('a','b')")?.detail).toMatchObject({ reason: "DENIED_FUNCTION", function: "JAVA_METHOD" });
  });

  it("refuses functions that read files or reach another host (Spark, DuckDB and PostgreSQL spellings)", () => {
    for (const s of [
      "SELECT * FROM read_csv('/etc/passwd')",
      "SELECT * FROM read_text('/etc/passwd')",
      "SELECT * FROM read_parquet('s3://bucket/x.parquet')",
      "SELECT * FROM glob('/*')",
      "SELECT * FROM read_json_auto('https://example.com/x.json')",
      "SELECT * FROM query('DROP TABLE x')",
      "SELECT * FROM read_files('/data')",
      "SELECT pg_read_file('/etc/passwd')",
      "SELECT * FROM dblink('host=evil', 'select 1') AS t(a int)",
    ]) {
      expect(verdict(s)?.reason, s).toBe("DENIED_FUNCTION");
    }
  });

  it("refuses a table reference that is a file path (SELECT * FROM csv.`/path`)", () => {
    for (const s of ["SELECT * FROM csv.`/etc/passwd`", "SELECT * FROM PARQUET.`s3://bucket/x`", "SELECT * FROM `json`.`/data/x.json`", "SELECT * FROM text . `/etc/hosts`", "SELECT a FROM t JOIN orc.`/x` USING (a)"]) {
      expect(verdict(s)?.reason, s).toBe("FILE_SCAN");
    }
  });

  it("refuses setup, session and maintenance verbs as first words (outside the admin policy)", () => {
    for (const s of [
      "CALL system.expire_snapshots('t')",
      "ADD JAR 'hdfs://x/udf.jar'",
      "ADD FILE '/etc/passwd'",
      "SET spark.sql.shuffle.partitions = 1",
      "RESET",
      "ANALYZE TABLE hospital.requirements COMPUTE STATISTICS",
      "REFRESH TABLE hospital.requirements",
      "UNCACHE TABLE hospital.requirements",
      "USE hospital",
      "EXECUTE IMMEDIATE 'DROP TABLE x'",
      "PRAGMA enable_profiling",
      "INSTALL httpfs",
      "LOAD DATA INPATH '/x' INTO TABLE t",
      "MSCK REPAIR TABLE t",
      "EXPORT DATABASE '/tmp/x'",
      "ATTACH 'x.db'",
      "VACUUM t",
    ]) {
      const v = verdict(s);
      expect(v?.failure, s).toBe("REFUSED");
      expect(v?.reason, s).toBe("NOT_READ_ONLY");
    }
  });

  it("looks through EXPLAIN: what it explains must itself be a read", () => {
    expect(verdict("EXPLAIN SELECT 1")).toBeUndefined();
    expect(verdict("EXPLAIN EXTENDED SELECT * FROM hospital.requirements")).toBeUndefined();
    expect(verdict("EXPLAIN FORMATTED WITH x AS (SELECT 1 AS a) SELECT * FROM x")).toBeUndefined();
    for (const s of ["EXPLAIN CALL system.f()", "EXPLAIN SET spark.x = 1", "EXPLAIN ANALYZE TABLE t COMPUTE STATISTICS", "EXPLAIN ADD JAR 'x'", "EXPLAIN REFRESH TABLE t", "EXPLAIN SELECT reflect('a','b')", "EXPLAIN"]) {
      expect(verdict(s)?.failure, s).toBe("REFUSED");
    }
  });

  it("refuses SELECT ... INTO, which creates a table in some dialects", () => {
    expect(verdict("SELECT a INTO newtable FROM hospital.requirements")?.failure).toBe("REFUSED");
  });

  it("keeps allowing ordinary reads that merely mention these words as text, names or columns", () => {
    for (const s of [
      "SELECT 'reflect(x)' AS note FROM hospital.requirements",
      "SELECT reflect_note, glob_pattern, query_text FROM hospital.requirements",
      "SELECT `glob` FROM hospital.requirements",
      "SELECT `query`, a FROM t -- reflect('a', 'b')",
      "SELECT * FROM hospital.csv_exports",
      "SELECT csv.a FROM csv",
      "SELECT json.a, parquet.b FROM json JOIN parquet ON json.id = parquet.id",
      "SELECT count(*), upper(x), coalesce(a, b), date_add(d, 1), cast(a AS int), input_file_name() FROM t",
      "SELECT * FROM hospital.requirements WHERE note LIKE '%call_function%'",
    ]) {
      expect(verdict(s), s).toBeUndefined();
    }
  });

  it("does not apply the deny list to the admin policy, which exists for setup statements", () => {
    // The policy is chosen by the caller (statementPolicy: "admin"); prepareStatement itself accepts these statements.
    expect(() => prepareStatement("SET spark.sql.shuffle.partitions = 1")).not.toThrow();
    expect(() => prepareStatement("CALL system.expire_snapshots('t')")).not.toThrow();
  });
});

describe("identifiers", () => {
  it("accepts plain names and quotes reserved words", () => {
    expect(sqlIdent("requirements")).toBe("requirements");
    expect(sqlIdent("_x1")).toBe("_x1");
    expect(sqlIdent("order")).toBe("`order`");
    expect(sqlQualified("hospital", "requirements")).toBe("hospital.requirements");
    expect(sqlQualified("hospital", "table")).toBe("hospital.`table`");
  });
  it("refuses anything that is not letters, digits and underscore", () => {
    for (const bad of ["", "a b", "a-b", "a;b", "a`b", 'a"b', "a'b", "1abc", "a.b", "é", "a/*", "x--", "x\n", "a".repeat(129)]) {
      const e = failure(() => sqlIdent(bad));
      expect(e.failure, JSON.stringify(bad)).toBe("INVALID");
    }
    expect(isSafeIdent("ok_1")).toBe(true);
    expect(isSafeIdent("not ok")).toBe(false);
  });
});

describe("values", () => {
  it("renders plain strings in quotes and quote or backslash content from pieces", () => {
    expect(sqlString("abc")).toBe("'abc'");
    expect(sqlString("")).toBe("''");
    expect(sqlString("it's")).toBe("('it' || chr(39) || 's')");
    expect(sqlString("a\\b")).toBe("('a' || chr(92) || 'b')");
    expect(sqlString("'")).toBe("chr(39)");
    expect(sqlString("''")).toBe("(chr(39) || chr(39))");
  });
  it("never emits a backslash or a doubled quote, which Spark and DuckDB read differently", () => {
    for (const v of ["it's", "\\", "a\\'b", "'; DROP TABLE x; --", "''", "\\\\", "x'\\y'"]) {
      const out = sqlString(v);
      expect(out, v).not.toContain("\\");
      expect(out, v).not.toContain("''");
    }
  });
  it("refuses NUL and oversized strings", () => {
    expect(failure(() => sqlString("a\u0000b")).failure).toBe("INVALID");
    expect(failure(() => sqlString("x".repeat(10_001))).failure).toBe("INVALID");
  });
  it("renders numbers, parenthesising negatives so a leading minus cannot join a comment", () => {
    expect(sqlNumber(5)).toBe("5");
    expect(sqlNumber(-5)).toBe("(-5)");
    expect(sqlNumber(0.25)).toBe("0.25");
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 2 ** 60]) expect(failure(() => sqlNumber(bad)).failure).toBe("INVALID");
  });
  it("accepts only real calendar dates", () => {
    expect(sqlDate("2026-02-28")).toBe("DATE '2026-02-28'");
    expect(sqlDate("2028-02-29")).toBe("DATE '2028-02-29'");
    for (const bad of ["2026-02-29", "2026-13-01", "2026-1-1", "2026-01-01' OR 1=1 --", "", "tomorrow", "2026-00-10"]) {
      expect(failure(() => sqlDate(bad)).failure, bad).toBe("INVALID");
    }
  });
  it("renders booleans, nulls and IN lists, and refuses an empty list", () => {
    expect(sqlBoolean(true)).toBe("TRUE");
    expect(sqlValue(null)).toBe("NULL");
    expect(sqlList(["a", 1, null])).toBe("('a', 1, NULL)");
    expect(failure(() => sqlList([])).failure).toBe("INVALID");
  });
  it("derives a stable key from the statement and the identity", () => {
    expect(statementKey("SELECT 1", "a")).toBe(statementKey("SELECT 1", "a"));
    expect(statementKey("SELECT 1", "a")).not.toBe(statementKey("SELECT 1", "b"));
    expect(statementKey("SELECT 1", "a")).not.toBe(statementKey("SELECT 2", "a"));
  });
});

describe("string literals under attack (property)", () => {
  let instance: DuckDBInstance;
  let run: (sql: string) => Promise<unknown[][]>;
  beforeAll(async () => {
    instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    run = async (sql) => (await connection.runAndReadAll(sql)).getRowsJson() as unknown[][];
  });
  afterAll(() => instance.closeSync());

  // An alphabet made of the characters that matter: both quote styles, backslash, comment openers, semicolons, newlines.
  const hostile = fc.stringOf(fc.constantFrom("'", '"', "`", "\\", ";", "-", "/", "*", " ", "\n", "%", "a", "Z", "0", "é", "日", "😀", "$", "(", ")", ","), { maxLength: 40 });

  it("a value round-trips exactly through the engine and stays one statement", async () => {
    await fc.assert(
      fc.asyncProperty(hostile, async (value) => {
        const statement = `SELECT ${sqlString(value)} AS v`;
        const prepared = prepareStatement(statement); // must not throw: no stray semicolon, no unterminated quote
        expect(prepared.words.filter((w) => !["SELECT", "AS", "V", "CHR"].includes(w))).toEqual([]);
        const rows = await run(statement);
        expect(rows).toEqual([[value]]);
      }),
      { numRuns: 300 },
    );
  });

  it("a value cannot change which rows a filter selects", async () => {
    await run("CREATE TABLE t (name VARCHAR)");
    await run("INSERT INTO t VALUES ('safe'), ('x'' OR ''1''=''1'), ('x'), (NULL)");
    await fc.assert(
      fc.asyncProperty(hostile, async (value) => {
        const rows = await run(`SELECT name FROM t WHERE name = ${sqlString(value)}`);
        const expected = ["safe", "x' OR '1'='1", "x"].filter((n) => n === value).map((n) => [n]);
        expect(rows).toEqual(expected);
      }),
      { numRuns: 200 },
    );
    // The classic payloads, by name.
    for (const payload of ["x' OR '1'='1", "'; DROP TABLE t; --", "\\'; DROP TABLE t; --", "x\\", "' UNION SELECT name FROM t --"]) {
      const rows = await run(`SELECT name FROM t WHERE name = ${sqlString(payload)}`);
      expect(rows.length, payload).toBeLessThanOrEqual(1);
    }
    expect(await run("SELECT count(*) FROM t")).toEqual([["4"]]);
  });
});
