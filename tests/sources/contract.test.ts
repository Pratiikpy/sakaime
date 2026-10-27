import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { checkContract, diffShapes, shapeFingerprint, shapeOf, type ContractPath } from "../../src/sources/contract.ts";

const rule = (path: string, type: ContractPath["type"], optional = false): ContractPath => ({ path, type, optional });

describe("response contracts", () => {
  const doc = { meta: { total: 2, last_updated: "2026-10-19" }, results: [{ id: "a", tags: ["x"], extra: null }, { id: "b", tags: [] }] };
  const contract = [rule("meta.total", "number"), rule("meta.last_updated", "string"), rule("results", "array"), rule("results[].id", "string"), rule("results[].tags", "array")];

  it("passes a conforming document, with a fingerprint that does not change when other fields do", () => {
    const a = checkContract(doc, contract);
    expect(a.ok).toBe(true);
    const b = checkContract({ ...doc, newField: 1, results: [{ id: "z", tags: ["q"], more: { deep: true } }] }, contract);
    expect(b.ok).toBe(true);
    expect(b.fingerprint).toBe(a.fingerprint);
  });

  it("reports a missing path, a wrong type and a parent of the wrong kind", () => {
    expect(checkContract({ ...doc, meta: {} }, contract).violations.map((v) => [v.path, v.problem])).toEqual(expect.arrayContaining([["meta.total", "missing"], ["meta.last_updated", "missing"]]));
    expect(checkContract({ ...doc, meta: { total: "2", last_updated: "x" } }, contract).violations).toEqual([{ path: "meta.total", problem: "wrong-type", expected: "number", observed: "string" }]);
    expect(checkContract({ ...doc, results: "none" }, contract).violations.some((v) => v.problem === "wrong-type" || v.problem === "not-a-container")).toBe(true);
    expect(checkContract({ ...doc, meta: "oops" }, contract).ok).toBe(false);
    expect(checkContract([], contract).ok).toBe(false);
    expect(checkContract(null, contract).ok).toBe(false);
  });

  it("checks every element of an array, and one bad element is enough", () => {
    const bad = { ...doc, results: [{ id: "a", tags: [] }, { id: 7, tags: [] }] };
    const c = checkContract(bad, contract);
    expect(c.ok).toBe(false);
    expect(c.violations).toEqual([{ path: "results[].id", problem: "wrong-type", expected: "string", observed: "number" }]);
    expect(checkContract({ ...doc, results: [{ tags: [] }] }, contract).violations).toEqual([{ path: "results[].id", problem: "missing", expected: "string" }]);
  });

  it("accepts an empty array: no element, nothing to violate", () => {
    expect(checkContract({ ...doc, results: [] }, contract).ok).toBe(true);
  });

  it("an optional path may be absent but must have its type when present", () => {
    const c = [rule("results[].note", "string", true)];
    expect(checkContract({ results: [{ id: "a" }] }, c).ok).toBe(true);
    expect(checkContract({ results: [{ note: "x" }] }, c).ok).toBe(true);
    expect(checkContract({ results: [{ note: 5 }] }, c).ok).toBe(false);
  });

  it("'any' accepts every type but still requires the path", () => {
    expect(checkContract({ a: null }, [rule("a", "any")]).ok).toBe(true);
    expect(checkContract({}, [rule("a", "any")]).ok).toBe(false);
  });

  it("reports one violation per path however many elements share it", () => {
    const many = { results: Array.from({ length: 50 }, () => ({ id: 1 })) };
    expect(checkContract(many, [rule("results[].id", "string")]).violations).toHaveLength(1);
  });
});

describe("shape fingerprints for sources without a card", () => {
  it("lists every path with its types and merges array elements", () => {
    expect(shapeOf({ a: 1, b: [{ c: "x" }, { c: null, d: true }] })).toEqual({
      $: "object",
      a: "number",
      b: "array",
      "b[]": "object",
      "b[].c": "null|string",
      "b[].d": "boolean",
    });
  });

  it("does not depend on key order or on how many records there are (property)", () => {
    fc.assert(
      fc.property(fc.array(fc.record({ id: fc.string(), n: fc.integer() }), { minLength: 1, maxLength: 5 }), (records) => {
        const a = shapeFingerprint({ results: records, meta: { n: 1 } });
        const b = shapeFingerprint({ meta: { n: 2 }, results: [...records, ...records].map((r) => ({ n: r.n, id: r.id })) });
        expect(b).toBe(a);
      }),
    );
  });

  it("changes when a field is renamed, retyped or removed", () => {
    const base = { id: "a", n: 1 };
    const fp = shapeFingerprint(base);
    expect(shapeFingerprint({ identifier: "a", n: 1 })).not.toBe(fp);
    expect(shapeFingerprint({ id: "a", n: "1" })).not.toBe(fp);
    expect(shapeFingerprint({ id: "a" })).not.toBe(fp);
  });

  it("separates drift (removed, retyped) from additions", () => {
    const stored = shapeOf({ id: "a", n: 1, gone: true });
    const current = shapeOf({ id: "a", n: "1", extra: [] });
    expect(diffShapes(stored, current)).toEqual({
      removed: ["gone"],
      retyped: [{ path: "n", from: "number", to: "string" }],
      added: ["extra"],
    });
    expect(diffShapes(stored, stored)).toEqual({ removed: [], retyped: [], added: [] });
  });
});
