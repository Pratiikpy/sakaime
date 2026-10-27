import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { PortError } from "../../src/ports/index.ts";
import { castRows, castValue, parseTypeName, plainDecimal, resolveSchema, type ColumnType } from "../../src/federation/cast.ts";

const ctx = { column: "c", row: 0 };
const cast = (raw: string | null, type: ColumnType, opts = {}): unknown => castValue(raw, type, ctx, opts);
const failure = (fn: () => unknown): PortError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected a PortError");
};

describe("type names", () => {
  it("maps Spark and DuckDB names to canonical types", () => {
    expect(parseTypeName("VARCHAR(200)")).toBe("string");
    expect(parseTypeName("decimal(18, 3)")).toBe("decimal");
    expect(parseTypeName("BIGINT")).toBe("bigint");
    expect(parseTypeName("TIMESTAMP WITH TIME ZONE")).toBe("timestamp");
    expect(parseTypeName("hugeint")).toBe("decimal");
    expect(parseTypeName("array<int>")).toBeUndefined();
  });
  it("rejects an unknown declared type when the schema is resolved, not when the first row arrives", () => {
    expect(failure(() => resolveSchema({ a: "array<int>" })).failure).toBe("INVALID");
    expect(resolveSchema({ A: "int" }).get("a")).toBe("integer");
  });
});

describe("nulls and empty strings", () => {
  it("keeps null as null in every type", () => {
    for (const t of ["string", "integer", "bigint", "double", "decimal", "boolean", "date", "timestamp"] as const) expect(cast(null, t)).toBeNull();
  });
  it("keeps an empty string in a string column and reads it as unknown elsewhere", () => {
    expect(cast("", "string")).toBe("");
    expect(cast("", "integer")).toBeNull();
    expect(cast("", "boolean")).toBeNull();
    expect(cast("", "date")).toBeNull();
  });
  it("can instead treat an empty value in a typed column as drift", () => {
    expect(failure(() => cast("", "integer", { emptyAs: "error" })).failure).toBe("DRIFTED");
  });
  it("never turns the text 'null' or 'NULL' into a null", () => {
    expect(cast("null", "string")).toBe("null");
    expect(failure(() => cast("null", "integer")).failure).toBe("DRIFTED");
  });
});

describe("integers", () => {
  it("reads signed integers", () => {
    expect(cast("42", "integer")).toBe(42);
    expect(cast("-7", "bigint")).toBe(-7);
    expect(cast("+5", "integer")).toBe(5);
    expect(cast("0", "bigint")).toBe(0);
  });
  it("keeps integers beyond 2^53 exact, as a string by default and as a BigInt on request", () => {
    expect(cast("9007199254740993", "bigint")).toBe("9007199254740993");
    expect(cast("9007199254740993", "bigint", { bigint: "bigint" })).toBe(9007199254740993n);
    expect(cast("9007199254740991", "bigint")).toBe(9007199254740991);
    expect(cast("-9223372036854775808", "bigint")).toBe("-9223372036854775808");
    expect(JSON.stringify({ v: cast("9007199254740993", "bigint") })).toBe('{"v":"9007199254740993"}');
  });
  it("refuses values outside the declared width", () => {
    expect(failure(() => cast("2147483648", "integer")).failure).toBe("DRIFTED");
    expect(failure(() => cast("9223372036854775808", "bigint")).failure).toBe("DRIFTED");
  });
  it("refuses text and decimals in an integer column", () => {
    for (const bad of ["1.5", "abc", "1e3", " 5", "5 ", "0x10", "--1"]) expect(failure(() => cast(bad, "integer")).failure, bad).toBe("DRIFTED");
  });
});

describe("doubles", () => {
  it("reads ordinary and exponent forms", () => {
    expect(cast("1.5", "double")).toBe(1.5);
    expect(cast("-0.25", "double")).toBe(-0.25);
    expect(cast("1.0E10", "double")).toBe(1e10);
    expect(cast("2e-3", "double")).toBe(0.002);
    expect(cast(".5", "double")).toBe(0.5);
  });
  it("reads NaN and the infinities as Spark and DuckDB print them", () => {
    expect(cast("NaN", "double")).toBeNaN();
    expect(cast("nan", "double")).toBeNaN();
    expect(cast("Infinity", "double")).toBe(Number.POSITIVE_INFINITY);
    expect(cast("-Infinity", "double")).toBe(Number.NEGATIVE_INFINITY);
    expect(cast("inf", "double")).toBe(Number.POSITIVE_INFINITY);
  });
  it("refuses an overflowing or non-numeric value", () => {
    expect(failure(() => cast("1e999", "double")).failure).toBe("DRIFTED");
    expect(failure(() => cast("twelve", "double")).failure).toBe("DRIFTED");
    expect(failure(() => cast("1,5", "double")).failure).toBe("DRIFTED");
  });
});

describe("decimals", () => {
  it("returns a number when nothing is lost", () => {
    expect(cast("1.250", "decimal")).toBe(1.25);
    expect(cast("0E-18", "decimal")).toBe(0); // the form the engine prints for a zero decimal
    expect(cast("12", "decimal")).toBe(12);
    expect(cast("-0.5", "decimal")).toBe(-0.5);
  });
  it("keeps the exact digits when a double would lose them", () => {
    expect(cast("12345678901234567890.123", "decimal")).toBe("12345678901234567890.123");
    expect(cast("0.1234567890123456789", "decimal")).toBe("0.1234567890123456789");
  });
  it("normalises a high-precision zero-padded value", () => {
    expect(cast("00012345678901234567890.1230000", "decimal")).toBe("12345678901234567890.123");
  });
  it("computes the plain form of exponent notation", () => {
    expect(plainDecimal("1.5E3")).toBe("1500");
    expect(plainDecimal("1.5E-3")).toBe("0.0015");
    expect(plainDecimal("100")).toBe("100");
    expect(plainDecimal("-0.0")).toBe("0");
    expect(plainDecimal("1E5000")).toBeUndefined();
    expect(plainDecimal("abc")).toBeUndefined();
  });
  it("round-trips: a decimal that comes back as a number prints as the same digits", () => {
    fc.assert(
      fc.property(fc.integer({ min: -1_000_000, max: 1_000_000 }), fc.integer({ min: 0, max: 6 }), (n, scale) => {
        const text = (n / 10 ** scale).toFixed(scale);
        const out = cast(text, "decimal");
        expect(plainDecimal(String(out))).toBe(plainDecimal(text));
      }),
    );
  });
});

describe("booleans", () => {
  it("reads true and false in any case", () => {
    expect(cast("true", "boolean")).toBe(true);
    expect(cast("FALSE", "boolean")).toBe(false);
    expect(cast("True", "boolean")).toBe(true);
  });
  it("refuses everything else instead of guessing", () => {
    for (const bad of ["1", "0", "yes", "t", "y", "null"]) expect(failure(() => cast(bad, "boolean")).failure, bad).toBe("DRIFTED");
  });
});

describe("dates and timestamps", () => {
  it("accepts real dates and refuses impossible ones", () => {
    expect(cast("2028-02-29", "date")).toBe("2028-02-29");
    for (const bad of ["2026-02-29", "2026-13-01", "2026-00-01", "2026-04-31", "26-01-01", "2026-01-01T00:00:00", "2026/01/01"]) {
      expect(failure(() => cast(bad, "date")).failure, bad).toBe("DRIFTED");
    }
  });
  it("normalises Spark and DuckDB timestamp renderings to one form", () => {
    expect(cast("2026-08-31 11:22:21.0", "timestamp")).toBe("2026-08-31T11:22:21");
    expect(cast("2026-08-31 11:22:21", "timestamp")).toBe("2026-08-31T11:22:21");
    expect(cast("2026-08-31 11:22:21.120", "timestamp")).toBe("2026-08-31T11:22:21.12");
    expect(cast("2026-08-31T11:22:21.123456", "timestamp")).toBe("2026-08-31T11:22:21.123456");
  });
  it("keeps a zone the engine printed and adds one only when told to", () => {
    expect(cast("2026-08-31 11:22:21+00", "timestamp")).toBe("2026-08-31T11:22:21+00:00");
    expect(cast("2026-08-31 11:22:21+0530", "timestamp")).toBe("2026-08-31T11:22:21+05:30");
    expect(cast("2026-08-31 11:22:21Z", "timestamp")).toBe("2026-08-31T11:22:21Z");
    expect(cast("2026-08-31 11:22:21", "timestamp", { timestampZone: "Z" })).toBe("2026-08-31T11:22:21Z");
  });
  it("refuses a malformed or impossible instant", () => {
    for (const bad of ["2026-08-31", "2026-08-31 25:00:00", "2026-08-31 11:61:00", "2026-02-30 00:00:00", "yesterday"]) {
      expect(failure(() => cast(bad, "timestamp")).failure, bad).toBe("DRIFTED");
    }
  });
});

describe("castRows", () => {
  const schema = resolveSchema({ n: "bigint", ok: "boolean", at: "timestamp" });
  it("types declared columns and leaves every other column a string", () => {
    const out = castRows(["n", "ok", "at", "code"], [["3", "true", "2026-01-01 00:00:00.0", "00123"]], schema);
    expect(out.rows).toEqual([{ n: 3, ok: true, at: "2026-01-01T00:00:00", code: "00123" }]);
    expect(out.columns).toEqual([
      { name: "n", type: "bigint" },
      { name: "ok", type: "boolean" },
      { name: "at", type: "timestamp" },
      { name: "code", type: "string" },
    ]);
  });
  it("matches declared names case-insensitively", () => {
    expect(castRows(["N"], [["5"]], schema).rows).toEqual([{ N: 5 }]);
  });
  it("refuses two columns with one name instead of keeping one of them", () => {
    const e = failure(() => castRows(["id", "id"], [["1", "2"]], schema));
    expect(e.failure).toBe("INVALID");
    expect(e.detail?.["reason"]).toBe("DUPLICATE_COLUMN");
  });
  it("reports a ragged row as drift", () => {
    expect(failure(() => castRows(["a", "b"], [["1"]], schema)).failure).toBe("DRIFTED");
  });
  it("names the column and row of a value that does not fit", () => {
    const e = failure(() => castRows(["n"], [["1"], ["two"]], schema));
    expect(e.failure).toBe("DRIFTED");
    expect(e.detail).toMatchObject({ column: "n", row: 1, type: "bigint" });
  });
  it("returns an empty list for no rows", () => {
    expect(castRows(["n"], [], schema)).toEqual({ columns: [{ name: "n", type: "bigint" }], rows: [] });
  });
});
