import { describe, expect, it } from "vitest";
import { compileDetailed, CompilerInputError, type CompileOptions } from "../../src/compiler/index.ts";
import type { EvidenceItem, EvidenceResult } from "../../src/schemas/index.ts";
import { GOOD_RESULT, OP, auth, claim, requirement, study, vendor } from "./fixtures.ts";

const run = (evidence: EvidenceItem[], options: CompileOptions = {}, c = claim()) => compileDetailed(c, evidence, options);
const flagIds = (r: ReturnType<typeof run>) => r.finding.expertReviewFlags.map((f) => f.ruleId);

const BAD: EvidenceResult = { metric: "sensitivity", value: 0.7, ci: [0.62, 0.78], n: 200, operatingPoint: OP, anchorId: "anc-contrary" };

describe("authority by assertion type (C-01, T4, I-7)", () => {
  it("never lets a vendor record support, widen or contradict anything", () => {
    const without = run([auth(), study()]).finding;
    const withVendor = run([auth(), study(), vendor({ scope: { ...vendor().scope, settings: ["any_care_setting"], purpose: "diagnosis" } })]).finding;
    const strip = (f: typeof without) => ({ ...f, id: "x" });
    expect(strip(withVendor)).toEqual(strip(without));
    expect(withVendor.dependsOnFacts).not.toContain("vendor-1");
  });

  it("does not let a newer vendor figure outweigh an older controlled study", () => {
    const r = run([auth(), study({}, [{ ...GOOD_RESULT, value: 0.84, ci: [0.8, 0.88] }]), vendor({ scope: { ...vendor().scope, timing: { from: "2026-10-30" } } })]);
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });

  it("is INSUFFICIENT_EVIDENCE with nothing but a vendor record, and says no authorization or study was supplied", () => {
    const r = run([vendor()]);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.degraded.map((d) => `${d.sourceType}:${d.dependency}:${d.reason.split(":")[0]}`)).toEqual(["authorization:required:NOT_SUPPLIED", "study:required:NOT_SUPPLIED"]);
  });

  it("never lets a study widen an authorization: the claim must lie inside both", () => {
    const narrowAuth = auth({ settings: ["primary_care"] });
    const r = run([narrowAuth, study()], {}, claim({ settings: ["eye_care"] }));
    expect(r.finding.mechanicalCoverage.find((m) => m.dimension === "setting")!.relation).toBe("DISJOINT");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    const both = run([narrowAuth, study()], {}, claim({ settings: ["eye_care", "primary_care"] }));
    expect(both.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(both.finding.supportedScope).toMatchObject({ settings: ["primary_care"] });
  });

  it("never lets an authorization record stand in for, or overwrite, a measured result", () => {
    const authWithNumbers = auth({}, { results: [{ ...GOOD_RESULT, value: 0.99, ci: [0.98, 1] }] });
    const r = run([authWithNumbers, study({}, [{ ...GOOD_RESULT, value: 0.84, ci: [0.8, 0.88] }])]);
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(run([authWithNumbers, study({}, [])]).finding.mechanicalCoverage.find((m) => m.dimension === "metric")!.relation).toBe("UNKNOWN");
  });

  it("does not let a later authorization record that is out of force change an earlier one's scope", () => {
    const old = auth({ population: { age: { min: 40 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] }, timing: { from: "2015-01-01", to: "2019-12-31" } }, { id: "auth-old" });
    const r = run([old, auth(), study()]);
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.finding.dependsOnFacts).toContain("auth-old");
  });
});

describe("contrary material (C-07)", () => {
  const second = (over: Partial<EvidenceItem> = {}, scope: Record<string, unknown> = {}, results: EvidenceResult[] = [BAD]) => study(scope, results, { id: "study-2", anchorIds: ["anc-contrary"], ...over });

  it("is CONTRADICTED when a relevant, adequate study reports an interval wholly below the claim", () => {
    const r = run([auth(), study(), second()]);
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(r.labelBasis.join(" ")).toMatch(/study-2/);
  });

  it("goes to review, not support, when the contrary study is inadequate", () => {
    const r = run([auth(), study(), second({ adequate: false })]);
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(flagIds(r)).toEqual(["SAK-CONTRARY-UNDISPOSITIONED"]);
    expect(r.finding.expertReviewFlags[0]!.reason).toMatch(/study-2/);
  });

  it("goes to review when the adequacy of the contrary study is unknown", () => {
    const r = run([auth(), study(), second({ adequate: undefined })]);
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
  });

  it("goes to review when the contrary study does not cover the claimed version", () => {
    const r = run([auth(), study(), second({}, { versions: ["3.1.0"] })]);
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags[0]!.reason).toMatch(/does not cover the claimed scope/);
  });

  it("goes to review when the contrary result has no interval", () => {
    const r = run([auth(), study(), second({}, {}, [{ metric: "sensitivity", value: 0.7, operatingPoint: OP }])]);
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
  });

  it("allows support again only once a reviewer records a disposition, and records it in the finding", () => {
    const evidence = [auth(), study(), second({ adequate: false })];
    const disposition = { evidenceId: "study-2", relevance: "weak" as const, note: "single site, convenience sample" };
    const r = run(evidence, { dispositions: [disposition] });
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.finding.contraryDispositions).toEqual([disposition]);
    expect(r.finding.dependsOnFacts).toContain("study-2");
  });

  it("accepts an off-scope disposition for a study of another version", () => {
    const r = run([auth(), study(), second({}, { versions: ["3.1.0"] })], { dispositions: [{ evidenceId: "study-2", relevance: "off_scope" }] });
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("lets a reviewer record the contrary study as relevant and adequate, which contradicts", () => {
    const r = run([auth(), study(), second({ adequate: undefined })], { dispositions: [{ evidenceId: "study-2", relevance: "relevant", adequate: true }] });
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });

  it("treats a disposition that says relevant but not whether the study is adequate as still open", () => {
    const r = run([auth(), study(), second({ adequate: undefined })], { dispositions: [{ evidenceId: "study-2", relevance: "relevant" }] });
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
  });

  it("reports dispositions that matched nothing instead of applying them silently", () => {
    const r = run([auth(), study()], { dispositions: [{ evidenceId: "study-404", relevance: "weak" }] });
    expect(r.unusedDispositions).toEqual(["study-404"]);
    expect(r.finding.contraryDispositions).toEqual([]);
  });

  it("rejects two dispositions for one item", () => {
    expect(() => run([auth(), study()], { dispositions: [{ evidenceId: "a", relevance: "weak" }, { evidenceId: "a", relevance: "off_scope" }] })).toThrow(CompilerInputError);
  });

  it("ignores a contrary result at a different operating point, which is not comparable", () => {
    const r = run([auth(), study(), second({}, {}, [{ ...BAD, operatingPoint: "high sensitivity threshold" }])]);
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("ignores a contrary study of a different product", () => {
    const r = run([auth(), study(), second({}, { product: "device:fda:K999999" })]);
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("still inspects a study the claim lists only as corroborating, but cannot be supported by it", () => {
    const deps = { required: ["authorization"], corroborating: ["study"] };
    const withContrary = compileDetailed(claim({}, { metric: "sensitivity", atLeast: 0.9 }, { dependencies: deps }), [auth(), study(), second()], {});
    expect(withContrary.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    const alone = compileDetailed(claim({}, { metric: "sensitivity", atLeast: 0.9 }, { dependencies: deps }), [auth(), study()], {});
    expect(alone.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(alone.finding.mechanicalCoverage.find((m) => m.dimension === "metric")!.relation).toBe("UNKNOWN");
  });
});

describe("hospital requirement", () => {
  const deps = { required: ["authorization", "study", "requirement"], corroborating: [] };
  const withReq = (items: EvidenceItem[]) => compileDetailed(claim({}, undefined, { dependencies: deps }), items, {});

  it("is supported when the requirement is recorded as met", () => {
    expect(withReq([auth(), study(), requirement(true)]).finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("goes to review when the requirement is recorded as not met", () => {
    const r = withReq([auth(), study(), requirement(false)]);
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(flagIds(r)).toEqual(["SAK-REQUIREMENT"]);
  });

  it("goes to review when a required requirement has not been assessed", () => {
    expect(withReq([auth(), study(), requirement(undefined)]).finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
  });

  it("is insufficient when a required requirement record was never supplied", () => {
    const r = withReq([auth(), study()]);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.degraded).toEqual([expect.objectContaining({ sourceType: "requirement", dependency: "required" })]);
  });

  it("surfaces an unmet requirement even when the claim does not list the type", () => {
    const r = run([auth(), study(), requirement(false)]);
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
  });
});

describe("joint coverage", () => {
  it("sends coverage stitched from records that each cover only part of the claim to review", () => {
    const r = run([auth({ settings: ["eye_care"] }), auth({ settings: ["primary_care"] }, { id: "auth-2" }), study()]);
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(flagIds(r)).toEqual(["SAK-JOINT-COVERAGE"]);
  });

  it("does not flag an authorization split into a letter that states the product and an indications form that states the rest", () => {
    const { product, versions } = auth().scope;
    const letter = auth({ population: undefined, settings: undefined, purpose: undefined, product, versions }, { id: "auth-letter" });
    const ifu = auth({ product: undefined, versions: undefined }, { id: "auth-ifu" });
    const r = run([letter, ifu, study()]);
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(flagIds(r)).toEqual([]);
  });

  it("does not flag two records that state the same thing", () => {
    expect(run([auth(), auth({}, { id: "auth-2" }), study()]).finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });
});

describe("the label set", () => {
  it("never reports a narrower scope that is not itself contained in the evidence", () => {
    const r = run([auth(), study()], {}, claim({ versions: ["2.1.0", "9.9.9"], settings: ["any_care_setting"], purpose: "diagnosis", population: { age: { min: 18 }, conditions: ["diabetes mellitus", "asthma"], exclusions: ["pregnancy"] } }));
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    const narrow = compileDetailed({ id: "claim-1", use: r.finding.supportedScope, performance: { metric: "sensitivity", atLeast: 0.9 } }, [auth(), study()], {});
    expect(narrow.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("orders precedence: an explicit authorization limit beats everything, contrary material beats a missing record", () => {
    const pop = { age: { min: 22 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] };
    expect(run([auth({ population: pop }), study({ population: pop })]).finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    const noDates = run([auth({ timing: undefined }), study({ timing: undefined }), study({}, [BAD], { id: "study-2", adequate: false })]);
    expect(noDates.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
  });
});
