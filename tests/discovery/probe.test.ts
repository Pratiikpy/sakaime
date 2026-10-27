/**
 * Stage 3: parsing the bounded probe, truncation, and the schema fingerprint (stable under order, sensitive to shape).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { diffFingerprints, fingerprintOf, schemaHashOf, shapeOfTable } from "../../src/discovery/fingerprint.ts";
import { probe } from "../../src/discovery/probe.ts";
import { parseProbe } from "../../src/discovery/tabular.ts";
import { PortError } from "../../src/ports/index.ts";
import { ServedFetcher } from "./helpers/doubles.ts";
import { csv } from "./helpers/fixtures.ts";

const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const failure = (fn: () => unknown): PortError => {
  try {
    fn();
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected a PortError");
};

describe("parsing", () => {
  it("reads CSV, JSON arrays, wrapped arrays and newline-delimited JSON", () => {
    expect(parseProbe(enc("a,b\n1,2\n3,4\n")).rows).toEqual([{ a: "1", b: "2" }, { a: "3", b: "4" }]);
    expect(parseProbe(enc('[{"a":1},{"a":2}]')).rows).toEqual([{ a: 1 }, { a: 2 }]);
    const wrapped = parseProbe(enc('{"meta":{"results":{"total":2}},"results":[{"k":"K1"},{"k":"K2"}]}'));
    expect(wrapped.rows).toHaveLength(2);
    expect(wrapped.container).toBe("results");
    expect(wrapped.declaredTotal).toBe(2);
    expect(parseProbe(enc('{"a":1}\n{"a":2}\n')).format).toBe("ndjson");
  });

  it("flattens nested objects and arrays to dotted paths", () => {
    const t = parseProbe(enc(JSON.stringify({ studies: [{ protocolSection: { identificationModule: { nctId: "NCT03112005" }, conditionsModule: { conditions: ["DR", "diabetes"] }, interventions: [{ name: "EyeArt" }, { name: "Other" }] } }] })));
    expect(t.rows[0]).toMatchObject({ "protocolSection.identificationModule.nctId": "NCT03112005", "protocolSection.conditionsModule.conditions": "DR | diabetes", "protocolSection.interventions[].name": "EyeArt | Other" });
  });

  it("detects other delimiters", () => {
    expect(parseProbe(enc("a;b\n1;2\n")).rows).toEqual([{ a: "1", b: "2" }]);
  });

  it("a response cut off inside a quoted value is TRUNCATED, not a smaller table", () => {
    expect(failure(() => parseProbe(enc('a,b\n1,"two\n3,'))).failure).toBe("TRUNCATED");
  });

  it("a last row cut short with no line break is TRUNCATED; a ragged middle row is INVALID", () => {
    expect(failure(() => parseProbe(enc("a,b,c\n1,2,3\n4,5"))).failure).toBe("TRUNCATED");
    expect(failure(() => parseProbe(enc("a,b,c\n1,2\n4,5,6\n"))).failure).toBe("INVALID");
  });

  it("JSON that ends before it closes is TRUNCATED; JSON with a syntax error is INVALID", () => {
    expect(failure(() => parseProbe(enc('{"results":[{"k":"K1"},{"k":"K'))).failure).toBe("TRUNCATED");
    expect(failure(() => parseProbe(enc('{"results":[{"k":"K1"},]}'))).failure).toBe("INVALID");
  });

  it("refuses an HTML page, an empty body, bad encoding, duplicate and empty headers", () => {
    expect(failure(() => parseProbe(enc("<html></html>"), "text/html")).failure).toBe("INVALID");
    expect(failure(() => parseProbe(enc(""))).detail?.["reason"]).toBe("EMPTY_BODY");
    expect(failure(() => parseProbe(new Uint8Array([0x61, 0x2c, 0x62, 0x0a, 0xff, 0xfe, 0x0a]))).detail?.["reason"]).toBe("ENCODING");
    expect(failure(() => parseProbe(enc("a,a\n1,2\n"))).detail?.["reason"]).toBe("DUPLICATE_HEADER");
    expect(failure(() => parseProbe(enc("a,\n1,2\n"))).detail?.["reason"]).toBe("EMPTY_HEADER");
  });

  it("strips a byte-order mark", () => {
    expect(parseProbe(enc("﻿a,b\n1,2\n")).columns).toEqual(["a", "b"]);
  });
});

describe("schema fingerprint", () => {
  const base = csv(["k_number", "decision_date", "sens"], [["K200667", "2020-08-03", 0.93], ["K211733", "2021-11-10", 0.88]]);
  const hash = (text: string): string => fingerprintOf(parseProbe(enc(text))).schemaHash;

  it("does not depend on column order or record order", () => {
    const reordered = csv(["sens", "k_number", "decision_date"], [[0.88, "K211733", "2021-11-10"], [0.93, "K200667", "2020-08-03"]]);
    expect(hash(reordered)).toBe(hash(base));
  });

  it("is the same for a CSV and a JSON export of the same data, and for any key order", () => {
    const json1 = JSON.stringify([{ k_number: "K200667", decision_date: "2020-08-03", sens: 0.93 }]);
    const json2 = JSON.stringify([{ sens: 0.93, decision_date: "2020-08-03", k_number: "K200667" }]);
    expect(hash(json1)).toBe(hash(json2));
    expect(hash(json1)).toBe(hash(base));
  });

  it("does not depend on which values were sampled, nor on missing-value codes", () => {
    const other = csv(["k_number", "decision_date", "sens"], [["K999999", "2019-01-02", 0.5], ["K888888", "NA", "-"]]);
    expect(hash(other)).toBe(hash(base));
  });

  it("changes when a field is renamed, removed or added", () => {
    expect(hash(csv(["k_number", "decision_date", "sensitivity"], [["K1", "2020-08-03", 0.9]]))).not.toBe(hash(base));
    expect(hash(csv(["k_number", "sens"], [["K1", 0.9]]))).not.toBe(hash(base));
    expect(hash(csv(["k_number", "decision_date", "sens", "extra"], [["K1", "2020-08-03", 0.9, "x"]]))).not.toBe(hash(base));
  });

  it("changes when a type does: a date format shift, a percent string, a number as text", () => {
    expect(hash(csv(["k_number", "decision_date", "sens"], [["K1", "03/08/2020", 0.9]]))).not.toBe(hash(base));
    expect(hash(csv(["k_number", "decision_date", "sens"], [["K1", "2020-08-03", "93%"]]))).not.toBe(hash(base));
  });

  it("does not change when a whole number appears where decimals were", () => {
    expect(hash(csv(["k_number", "decision_date", "sens"], [["K1", "2020-08-03", 1]]))).toBe(hash(base));
  });

  it("reports what changed", () => {
    const a = shapeOfTable(parseProbe(enc(base)));
    const b = shapeOfTable(parseProbe(enc(csv(["k_number", "decision_date", "sens", "new"], [["K1", "03/08/2020", "93%", "x"]]))));
    const d = diffFingerprints(a, b);
    expect(d.added).toEqual(["new"]);
    expect(d.retyped.map((r) => r.path).sort()).toEqual(["decision_date", "sens"]);
    expect(d.removed).toEqual([]);
  });

  it("property: any permutation of columns and rows gives the same hash", () => {
    fc.assert(
      fc.property(
        fc.array(fc.tuple(fc.constantFrom("K200667", "DEN180001", "K211733"), fc.constantFrom("2020-08-03", "2018-04-11"), fc.constantFrom(0.5, 0.93, 1)), { minLength: 1, maxLength: 8 }),
        fc.shuffledSubarray([0, 1, 2], { minLength: 3, maxLength: 3 }),
        (rows, order) => {
          const names = ["k_number", "decision_date", "sens"];
          const canonical = csv(names, rows.map((r) => [...r]));
          const permuted = csv(order.map((i) => names[i]!), [...rows].reverse().map((r) => order.map((i) => r[i]!)));
          return hash(canonical) === hash(permuted);
        },
      ),
    );
  });

  it("property: the hash is a pure function of the shape", () => {
    fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), fc.constantFrom("number", "string", "date", "boolean")), (shape) => schemaHashOf(shape) === schemaHashOf({ ...shape })));
  });
});

describe("the bounded probe", () => {
  const now = new Date("2026-10-27T12:00:00Z");
  const run = async (fetcher: ServedFetcher, url: string, family: "generic" | "openfda" | "ctgov" = "generic") => probe({ fetcher, url, family, maxBytes: 1_000_000, maxRows: 100, now });
  const u = "https://registry.partner-data.test/export/x.csv";

  it("returns a table and its fingerprint", async () => {
    const f = new ServedFetcher(new Map());
    f.set(u, "a,b\n1,2\n");
    const o = await run(f, u);
    expect(o.kind).toBe("ok");
    if (o.kind === "ok") expect(o.fingerprint.schemaHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps an empty answer, an outage and a refusal apart", async () => {
    const f = new ServedFetcher(new Map());
    f.set(u, JSON.stringify({ error: { code: "NOT_FOUND", message: "No matches found!" } }), 404);
    const empty = await run(f, "https://registry.partner-data.test/export/x.csv", "openfda");
    expect(empty.kind).toBe("empty");

    f.set(u, "service unavailable", 503);
    const down = await run(f, u);
    expect(down).toMatchObject({ kind: "failed", failure: "UNAVAILABLE", retryable: true });

    f.set(u, "denied", 403);
    expect(await run(f, u)).toMatchObject({ kind: "failed", failure: "FORBIDDEN", retryable: false });

    f.set(u, "a,b\n");
    expect((await run(f, u)).kind).toBe("empty");
  });

  it("a source that declares more records than it sent, with no limit in the request, was cut short", async () => {
    const f = new ServedFetcher(new Map());
    f.set(u, JSON.stringify({ total: 500, results: [{ k: "K1" }, { k: "K2" }] }));
    expect(await run(f, u)).toMatchObject({ kind: "failed", failure: "TRUNCATED" });
    const bounded = `${u}?limit=2`;
    f.set(bounded, JSON.stringify({ total: 500, results: [{ k: "K1" }, { k: "K2" }] }));
    expect((await run(f, bounded)).kind).toBe("ok");
  });

  it("refuses more rows than a bounded endpoint should return", async () => {
    const f = new ServedFetcher(new Map());
    f.set(u, csv(["a"], Array.from({ length: 101 }, (_, i) => [i])));
    expect(await run(f, u)).toMatchObject({ kind: "failed", failure: "INVALID" });
  });

  it("passes a fetcher refusal through with its class", async () => {
    const f = new ServedFetcher(new Map([[u, new PortError("REFUSED", "resolves to a blocked address")]]));
    expect(await run(f, u)).toMatchObject({ kind: "failed", failure: "REFUSED", retryable: false });
  });
});
