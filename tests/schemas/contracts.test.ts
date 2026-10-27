import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { LABELS, LabelSchema, ClaimSchema, EvidenceItemSchema, FindingSchema, EvidenceRecordSchema } from "../../src/schemas/index.ts";
import { canonicalJson, hashOf, sha256Hex } from "../../src/util/canonical.ts";

describe("label set", () => {
  it("has exactly the five labels and rejects safety verdicts", () => {
    expect(LABELS).toHaveLength(5);
    for (const banned of ["SAFE", "CLEARED", "COMPLIANT", "APPROVED", "UNRESOLVED", "supported"]) {
      expect(LabelSchema.safeParse(banned).success).toBe(false);
    }
  });
});

describe("scope schemas", () => {
  it("treats an absent field as unspecified, not as everything", () => {
    const claim = ClaimSchema.parse({ id: "c1", use: { product: "device:fda:K200667" } });
    expect(claim.use.population).toBeUndefined();
    expect(claim.use.versions).toBeUndefined();
  });

  it("rejects an inverted age range and a malformed date", () => {
    expect(ClaimSchema.safeParse({ id: "c", use: { population: { age: { min: 60, max: 20 } } } }).success).toBe(false);
    expect(ClaimSchema.safeParse({ id: "c", use: { timing: { from: "27/10/2026" } } }).success).toBe(false);
  });

  it("defaults list fields on evidence items", () => {
    const item = EvidenceItemSchema.parse({ id: "e1", assertionType: "study", scope: {} });
    expect(item.results).toEqual([]);
    expect(item.limitations).toEqual([]);
  });
});

describe("finding schema", () => {
  it("rejects a label outside the closed set", () => {
    const base = { id: "f1", claimId: "c1", mechanicalCoverage: [], ruleVersion: "r1" };
    expect(FindingSchema.safeParse({ ...base, label: "INSUFFICIENT_EVIDENCE" }).success).toBe(true);
    expect(FindingSchema.safeParse({ ...base, label: "UNRESOLVED" }).success).toBe(false);
  });
});

describe("evidence record", () => {
  it("requires hashes in lowercase hex", () => {
    const rec = {
      id: "r1",
      sourceId: "s1",
      retrievedAt: "2026-10-27T10:00:00Z",
      requestHash: "a".repeat(64),
      contentHash: "b".repeat(64),
      schemaVersion: "1",
      license: "CC0",
    };
    expect(EvidenceRecordSchema.safeParse(rec).success).toBe(true);
    expect(EvidenceRecordSchema.safeParse({ ...rec, contentHash: "XYZ" }).success).toBe(false);
  });
});

describe("canonical hashing", () => {
  it("is independent of key order", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.integer()), (obj) => {
        const reversed = Object.fromEntries(Object.entries(obj).reverse());
        return canonicalJson(obj) === canonicalJson(reversed);
      }),
    );
  });

  it("changes when any byte of content changes", () => {
    expect(hashOf({ a: 1, b: [1, 2] })).not.toBe(hashOf({ a: 1, b: [1, 3] }));
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("refuses non-finite numbers rather than hashing them as null", () => {
    expect(() => canonicalJson({ x: NaN })).toThrow(TypeError);
  });
});
