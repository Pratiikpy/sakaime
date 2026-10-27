import { describe, expect, it } from "vitest";
import { CompilerInputError, compile, compileDetailed, recompute, staleFindings, supersede } from "../../src/compiler/index.ts";
import { FindingSchema, type Finding } from "../../src/schemas/index.ts";
import { GOOD_RESULT, auth, claim, study, vendor } from "./fixtures.ts";

const deepFreeze = <T>(o: T): T => {
  if (o && typeof o === "object") {
    Object.freeze(o);
    for (const v of Object.values(o as object)) deepFreeze(v);
  }
  return o;
};

describe("recompute: the Applicability Lab (T5, no model call)", () => {
  const evidence = [auth(), study()];

  it("returns the new finding and a diff against the old one when a setting widens", () => {
    const r = recompute(claim(), { use: { settings: ["any_care_setting"] } }, evidence);
    expect(r.previous.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.next.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.diff.label).toEqual({ from: "SUPPORTED_FOR_SCOPE", to: "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", changed: true });
    expect(r.diff.dimensions).toEqual([expect.objectContaining({ dimension: "setting", from: "CONTAINED", to: "PARTIAL" })]);
    expect(r.diff.mismatchesAdded).toEqual(["setting"]);
    expect(r.diff.requiredEvidenceAdded).toEqual(["setting"]);
    expect(r.diff.supportedScopeChanged).toBe(true);
    expect(r.diff.unchanged).toBe(false);
    expect(r.patchedClaim.use.settings).toEqual(["any_care_setting"]);
    expect(r.next.reasons.find((x) => x.dimension === "setting")!.findingId).toBe(r.next.finding.id);
  });

  it("changes version, population, purpose and date, each recomputed against the same evidence", () => {
    expect(recompute(claim(), { use: { versions: ["2.2.0"] } }, evidence).next.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(recompute(claim(), { use: { population: { age: { min: 10 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } } }, evidence).next.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(recompute(claim(), { use: { purpose: "diagnosis" } }, evidence).next.finding.supportedScope).toMatchObject({ purpose: "detection_aid" });
    expect(recompute(claim(), { use: { timing: { from: "2019-01-01" } } }, evidence).next.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });

  it("clears a dimension with null, which makes it unspecified and the claim insufficient", () => {
    const r = recompute(claim(), { use: { purpose: null } }, evidence);
    expect(r.patchedClaim.use.purpose).toBeUndefined();
    expect(r.next.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.diff.dimensions.map((d) => d.dimension)).toContain("purpose");
    expect(r.diff.mismatchesAdded).toEqual(["purpose"]);
  });

  it("changes the claimed performance and the dependencies", () => {
    expect(recompute(claim(), { performance: { metric: "sensitivity", atLeast: 0.99 } }, evidence).next.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(recompute(claim(), { performance: null }, evidence).next.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    const r = recompute(claim(), { dependencies: { required: ["authorization"], corroborating: ["study"] }, performance: null }, evidence);
    expect(r.next.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("reports an empty patch as unchanged, with the same finding id", () => {
    const r = recompute(claim(), {}, evidence);
    expect(r.diff.unchanged).toBe(true);
    expect(r.next.finding.id).toBe(r.previous.id);
  });

  it("rejects a patch that names an unknown field or produces an invalid claim", () => {
    expect(() => recompute(claim(), { use: { colour: "red" } } as never, evidence)).toThrow(CompilerInputError);
    expect(() => recompute(claim(), { use: { timing: { from: "2026-13-45" } } }, evidence)).toThrow(CompilerInputError);
    expect(() => recompute(claim(), { use: { population: { age: { min: 60, max: 20 } } } }, evidence)).toThrow(/patch\.use\.population/);
    expect(() => recompute(claim(), { extra: 1 } as never, evidence)).toThrow(CompilerInputError);
  });

  it("is synchronous and pure: the inputs are untouched and the result repeats", () => {
    const c = deepFreeze(claim());
    const ev = deepFreeze([auth(), study()]);
    const patch = deepFreeze({ use: { settings: ["hospital"] } });
    const a = recompute(c, patch, ev);
    const b = recompute(c, patch, ev);
    expect(a).not.toBeInstanceOf(Promise);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("change impact (T5, FR-8)", () => {
  const f1 = compile({ ...(claim() as object), id: "c1" }, [auth({}, { id: "auth-a" }), study({}, [GOOD_RESULT], { id: "study-a" })]);
  const f2 = compile({ ...(claim() as object), id: "c2" }, [auth({}, { id: "auth-b" }), study({}, [GOOD_RESULT], { id: "study-b" })]);
  const f3 = compile({ ...(claim() as object), id: "c3" }, [auth({}, { id: "auth-a" }), study({}, [GOOD_RESULT], { id: "study-b" })]);
  const f4 = compile({ ...(claim() as object), id: "c4" }, [auth({}, { id: "auth-c" }), study({}, [GOOD_RESULT], { id: "study-c" }), vendor({ id: "vendor-z" })]);
  const all = [f1, f2, f3, f4];

  it("returns exactly the findings that used a changed fact, in the order given", () => {
    expect(staleFindings(all, ["study-b"]).map((f) => f.claimId)).toEqual(["c2", "c3"]);
    expect(staleFindings(all, ["auth-a"]).map((f) => f.claimId)).toEqual(["c1", "c3"]);
    expect(staleFindings(all, ["auth-a", "study-c"]).map((f) => f.claimId)).toEqual(["c1", "c3", "c4"]);
  });

  it("returns nothing for no change, an unknown fact, or a fact only a vendor record carried", () => {
    expect(staleFindings(all, [])).toEqual([]);
    expect(staleFindings(all, ["nobody-uses-this"])).toEqual([]);
    expect(staleFindings(all, ["vendor-z"])).toEqual([]);
  });

  it("accepts any iterable of fact ids and does not touch the findings", () => {
    const frozen = deepFreeze(all.map((f) => structuredClone(f)));
    expect(staleFindings(frozen, new Set(["study-a"])).map((f) => f.claimId)).toEqual(["c1"]);
  });

  it("uses the fact ids the caller maps to each record instead of the record id", () => {
    const f = compile(claim(), [auth(), study()], { factIds: { "study-1": ["fact:ctgov:NCT03112005:v3", "fact:pubmed:34779843"] } });
    expect(f.dependsOnFacts).toEqual(["auth-1", "fact:ctgov:NCT03112005:v3", "fact:pubmed:34779843"]);
    expect(staleFindings([f], ["fact:pubmed:34779843"])).toHaveLength(1);
    expect(staleFindings([f], ["study-1"])).toHaveLength(0);
  });

  it("depends on records of a lost source never, and on records it inspected for contrary material always", () => {
    const lost = compile(claim(), [auth(), study()], { sourceHealth: { study: "UNAVAILABLE" } });
    expect(lost.dependsOnFacts).toEqual(["auth-1"]);
    const inspected = compile(claim(), [auth(), study(), study({ versions: ["9.9"] }, [{ ...GOOD_RESULT, value: 0.5, ci: [0.4, 0.6] }], { id: "study-x" })]);
    expect(inspected.dependsOnFacts).toContain("study-x");
  });
});

describe("supersession keeps history (FR-26)", () => {
  const evidence = [auth(), study()];
  const old = compile(claim(), evidence);
  const changed = compile(claim(), [auth(), study({ versions: ["3.0.0"] })]);

  it("records which finding is replaced and why, and never rewrites the old one", () => {
    const frozenOld = deepFreeze(structuredClone(old));
    const next = supersede(changed, frozenOld, "study-1 was corrected to version 3.0.0");
    expect(next.supersedes).toBe(old.id);
    expect(next.supersedesReason).toBe("study-1 was corrected to version 3.0.0");
    expect(next.id).toBe(changed.id);
    expect(frozenOld).toEqual(old);
    expect(old.supersedes).toBeUndefined();
    expect(changed.supersedes).toBeUndefined();
    expect(FindingSchema.safeParse(next).success).toBe(true);
  });

  it("composes with a counterfactual when the reviewer commits the changed use", () => {
    const r = recompute(claim(), { use: { settings: ["any_care_setting"] } }, evidence);
    const committed = supersede(r.next.finding, r.previous, "reviewer widened the intended setting");
    expect(committed.supersedes).toBe(r.previous.id);
    expect(committed.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
  });

  it("refuses a supersession that would say nothing", () => {
    expect(() => supersede(changed, old, "   ")).toThrow(/reason is required/);
    expect(() => supersede(old, old, "again")).toThrow(/nothing to supersede/);
    const other = compile({ ...(claim() as object), id: "other" }, evidence);
    expect(() => supersede(other, old, "mixing claims")).toThrow(/not claim-1|is for claim/);
  });

  it("keeps both findings in a history array and finds the stale one by its facts", () => {
    const history: Finding[] = [old];
    const stale = staleFindings(history, ["study-1"]);
    expect(stale).toEqual([old]);
    const replacement = supersede(compile(claim(), [auth(), study({ versions: ["3.0.0"] })]), stale[0]!, "study-1 changed");
    history.push(replacement);
    expect(history.map((f) => f.supersedes)).toEqual([undefined, old.id]);
    expect(history[0]).toEqual(old);
  });
});

describe("explanations tied to the finding", () => {
  it("gives a plain-language reason per dimension, carrying the finding id and the rules that decided it", () => {
    const r = compileDetailed(claim({ versions: ["2.2.0"] }), [auth(), study()]);
    expect(r.reasons).toHaveLength(7);
    expect(r.reasons.every((x) => x.findingId === r.finding.id)).toBe(true);
    const v = r.reasons.find((x) => x.dimension === "version")!;
    expect(v.relation).toBe("DISJOINT");
    expect(v.ruleIds).toEqual(["R01-VER-DISJOINT"]);
    expect(v.text).toMatch(/Nothing in the evidence speaks for the claimed version/);
    expect(r.summary).toMatch(/does not settle the claim/);
  });
});
