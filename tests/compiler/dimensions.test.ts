import { describe, expect, it } from "vitest";
import { compileDetailed, type CompileOptions } from "../../src/compiler/index.ts";
import type { Dimension, EvidenceItem, Finding } from "../../src/schemas/index.ts";
import { OP, auth, claim, GOOD_RESULT, study, vendor } from "./fixtures.ts";

type Case = { claim?: ReturnType<typeof claim>; evidence?: EvidenceItem[]; options?: CompileOptions };
const run = (c: Case = {}) => compileDetailed(c.claim ?? claim(), c.evidence ?? [auth(), study()], c.options ?? {});
const rel = (f: Finding, d: Dimension) => f.mechanicalCoverage.find((x) => x.dimension === d)!.relation;
const cov = (f: Finding, d: Dimension) => f.mechanicalCoverage.find((x) => x.dimension === d)!;
const request = (f: Finding, d: Dimension) => f.requiredEvidence.find((x) => x.dimension === d)?.request ?? "";
const ruleIds = (r: ReturnType<typeof run>) => r.trace.map((t) => t.ruleId);

describe("positive control", () => {
  it("is SUPPORTED_FOR_SCOPE when the claim equals what both records establish", () => {
    const r = run();
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.finding.mismatches).toEqual([]);
    expect(r.finding.requiredEvidence).toEqual([]);
    expect(r.finding.mechanicalCoverage.map((m) => m.relation)).toEqual(Array(7).fill("CONTAINED"));
    expect(r.finding.dependsOnFacts).toEqual(["auth-1", "study-1"]);
  });
});

describe("product", () => {
  it("is DISJOINT when the records describe another product, and those records feed no other dimension", () => {
    const r = run({ evidence: [auth({ product: "device:fda:K999999" }), study({ product: "device:fda:K999999" })] });
    expect(rel(r.finding, "product")).toBe("DISJOINT");
    expect(rel(r.finding, "version")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(ruleIds(r)).toContain("SAK-PRODUCT-MISMATCH");
  });

  it("is UNKNOWN, never CONTAINED, when the evidence does not name the product", () => {
    const r = run({ evidence: [auth({ product: undefined }), study({ product: undefined })] });
    expect(rel(r.finding, "product")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(request(r.finding, "product")).toMatch(/submission number/);
  });

  it("is UNKNOWN when the claim names no product", () => {
    const r = run({ claim: claim({ product: undefined }) });
    expect(rel(r.finding, "product")).toBe("UNKNOWN");
    expect(cov(r.finding, "product").claimed).toBeUndefined();
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });
});

describe("version", () => {
  it("ignores a leading v and letter case, and nothing else", () => {
    expect(rel(run({ claim: claim({ versions: ["V2.1.0"] }) }).finding, "version")).toBe("CONTAINED");
    expect(rel(run({ claim: claim({ versions: ["2.1"] }) }).finding, "version")).toBe("DISJOINT");
  });

  it("treats a different build of the same release line as DISJOINT and asks the vendor to bridge it", () => {
    const r = run({ claim: claim({ versions: ["1.7.2"] }), evidence: [auth({ versions: ["1.7.2"] }), study({ versions: ["1.7.0"] })] });
    expect(rel(r.finding, "version")).toBe("DISJOINT");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(request(r.finding, "version")).toMatch(/1\.7\.2/);
    expect(request(r.finding, "version")).toMatch(/1\.7\.0/);
    expect(request(r.finding, "version")).toMatch(/change-control/);
    expect(cov(r.finding, "version").established).toMatch(/authorization record: 1\.7\.2; study: 1\.7\.0/);
  });

  it("gives a claimed version with no evidence at all INSUFFICIENT_EVIDENCE, not a narrower scope", () => {
    const r = run({ claim: claim({ versions: ["3.0.0"] }) });
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.supportedScope).toBeUndefined();
  });

  it("gives the overlap as the narrower scope when only some claimed versions are evidenced", () => {
    const r = run({ claim: claim({ versions: ["2.1.0", "2.2.0"] }) });
    expect(rel(r.finding, "version")).toBe("PARTIAL");
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ versions: ["2.1.0"] });
    expect(request(r.finding, "version")).toMatch(/2\.2\.0/);
  });

  it("is UNKNOWN when no record states the evaluated version", () => {
    const r = run({ evidence: [auth({ versions: undefined }), study({ versions: undefined })] });
    expect(rel(r.finding, "version")).toBe("UNKNOWN");
    expect(ruleIds(r)).toContain("R02-VER-UNRECORDED");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("does not read an empty version list as everything", () => {
    expect(rel(run({ claim: claim({ versions: [] }) }).finding, "version")).toBe("UNKNOWN");
  });
});

describe("population", () => {
  it("contains a claim for ages 22 and above in evidence for ages 18 and above", () => {
    const r = run({ claim: claim({ population: { age: { min: 22 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } }) });
    expect(rel(r.finding, "population")).toBe("CONTAINED");
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("contradicts a claim for ages 18 and above when the authorization record is limited to 22 and above (R10)", () => {
    const pop = { age: { min: 22 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] };
    const r = run({ evidence: [auth({ population: pop }), study({ population: pop })] });
    expect(rel(r.finding, "population")).toBe("PARTIAL");
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(ruleIds(r)).toContain("R10-POP-LABEL-EXCLUDED");
    expect(cov(r.finding, "population").claimed).toBe("ages 18 and above; conditions: diabetes mellitus; excluding: pregnancy");
    expect(cov(r.finding, "population").established).toMatch(/authorization record: ages 22 and above/);
  });

  it("gives only the narrower scope when a study, not the authorization, starts at 22 (silence is not a prohibition)", () => {
    const r = run({ evidence: [auth(), study({ population: { age: { min: 22 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } })] });
    expect(rel(r.finding, "population")).toBe("PARTIAL");
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ population: { age: { min: 22 } } });
    expect(request(r.finding, "population")).toMatch(/ages 18 to below 22/);
    expect(cov(r.finding, "population").established).toMatch(/study: ages 22 and above/);
  });

  it("calls a claim wholly outside the studied ages insufficient, not contradicted (R09)", () => {
    const r = run({ claim: claim({ population: { age: { min: 2, max: 10 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } }), evidence: [auth({ population: undefined }), study()] });
    expect(rel(r.finding, "population")).toBe("DISJOINT");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(ruleIds(r)).toContain("R09-POP-DISJOINT");
  });

  it("is UNKNOWN when the claim states no population but the evidence does", () => {
    const r = run({ claim: claim({ population: undefined }) });
    expect(rel(r.finding, "population")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(request(r.finding, "population")).toMatch(/State the patient population/);
  });

  it("is UNKNOWN when the evidence describes no population", () => {
    const r = run({ evidence: [auth({ population: undefined }), study({ population: undefined })] });
    expect(rel(r.finding, "population")).toBe("UNKNOWN");
    expect(ruleIds(r)).toContain("R11-POP-UNDESCRIBED");
  });

  it("does not read an age range with no bounds as all ages", () => {
    expect(rel(run({ claim: claim({ population: { age: {} } }) }).finding, "population")).toBe("UNKNOWN");
  });

  it("covers only the evidenced conditions of a wider claim", () => {
    const r = run({ claim: claim({ population: { age: { min: 18 }, conditions: ["diabetes mellitus", "hypertension"], exclusions: ["pregnancy"] } }) });
    expect(rel(r.finding, "population")).toBe("PARTIAL");
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ population: { conditions: ["diabetes mellitus"] } });
  });

  it("makes the claim restate an exclusion the evidence applied (exclusion conflict)", () => {
    const r = run({ claim: claim({ population: { age: { min: 18 }, conditions: ["diabetes mellitus"] } }) });
    expect(rel(r.finding, "population")).toBe("PARTIAL");
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ population: { exclusions: ["pregnancy"] } });
    expect(cov(r.finding, "population").claimed).not.toMatch(/pregnancy/);
  });

  it("contradicts a claim that names a group the authorization record excludes", () => {
    const r = run({ claim: claim({ population: { age: { min: 18 }, conditions: ["diabetes mellitus", "pregnancy"] } }) });
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(r.trace.some((t) => t.ruleId === "R10-POP-LABEL-EXCLUDED" && /pregnancy/.test(t.effect))).toBe(true);
  });

  it("sends a result with several disjoint pieces to review instead of choosing one", () => {
    const pops = [
      { age: { min: 18, max: 30 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] },
      { age: { min: 40, max: 65 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] },
    ];
    const r = run({
      claim: claim({ population: { age: { min: 18, max: 65 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } }),
      evidence: [auth({ population: undefined }), study({ population: pops[0] }, [GOOD_RESULT], { id: "study-a" }), study({ population: pops[1] }, [GOOD_RESULT], { id: "study-b" })],
    });
    expect(rel(r.finding, "population")).toBe("PARTIAL");
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags.map((f) => f.ruleId)).toContain("SAK-NARROWER-AMBIGUOUS");
    expect(r.finding.supportedScope).toBeUndefined();
  });
});

describe("setting hierarchy", () => {
  it("contains an emergency department claim in evidence for the hospital", () => {
    const r = run({ claim: claim({ settings: ["emergency_department"] }), evidence: [auth({ settings: ["hospital"] }), study({ settings: ["hospital"] })] });
    expect(rel(r.finding, "setting")).toBe("CONTAINED");
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("gives the studied unit as the narrower scope when the claim widens to the hospital", () => {
    const r = run({ claim: claim({ settings: ["hospital"] }), evidence: [auth({ settings: ["hospital"] }), study({ settings: ["emergency_department"] })] });
    expect(rel(r.finding, "setting")).toBe("PARTIAL");
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ settings: ["emergency_department"] });
    expect(request(r.finding, "setting")).toMatch(/hospital \(any unit\) outside emergency department/);
  });

  it("gives the two studied clinics when the claim widens to any care setting", () => {
    const r = run({ claim: claim({ settings: ["any_care_setting"] }), evidence: [auth({ settings: ["any_care_setting"] }), study()] });
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ settings: ["eye_care", "primary_care"] });
  });

  it("is DISJOINT for a sibling setting that was never studied", () => {
    const r = run({ claim: claim({ settings: ["intensive_care_unit"] }), evidence: [auth({ settings: ["hospital"] }), study({ settings: ["emergency_department"] })] });
    expect(rel(r.finding, "setting")).toBe("DISJOINT");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("resolves aliases, so ED and emergency_department are one setting", () => {
    expect(rel(run({ claim: claim({ settings: ["ED"] }), evidence: [auth({ settings: ["emergency_department"] }), study({ settings: ["Emergency Department"] })] }).finding, "setting")).toBe("CONTAINED");
  });

  it("never guesses where an unplaced setting belongs: UNKNOWN plus a review flag", () => {
    const r = run({ claim: claim({ settings: ["mobile stroke unit"] }), evidence: [auth({ settings: ["hospital"] }), study({ settings: ["hospital"] })] });
    expect(rel(r.finding, "setting")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags).toEqual([expect.objectContaining({ ruleId: "SAK-UNPLACED-SETTING", dimension: "setting" })]);
    expect(request(r.finding, "setting")).toMatch(/reviewer must place "mobile_stroke_unit"/);
  });

  it("accepts an unplaced setting that matches the evidence exactly", () => {
    const e = { settings: ["mobile stroke unit"] };
    expect(rel(run({ claim: claim(e), evidence: [auth(e), study(e)] }).finding, "setting")).toBe("CONTAINED");
  });

  it("is UNKNOWN when no record reports a setting", () => {
    const r = run({ evidence: [auth({ settings: undefined }), study({ settings: undefined })] });
    expect(rel(r.finding, "setting")).toBe("UNKNOWN");
    expect(ruleIds(r)).toContain("R15-SETTING-NOT-STUDIED");
  });
});

describe("purpose taxonomy", () => {
  it("contains a triage claim in evidence for a detection aid, and a detection aid in evidence for diagnosis", () => {
    expect(rel(run({ claim: claim({ purpose: "triage_notification" }) }).finding, "purpose")).toBe("CONTAINED");
    expect(rel(run({ claim: claim({ purpose: "detection_aid" }), evidence: [auth({ purpose: "diagnosis" }), study({ purpose: undefined })] }).finding, "purpose")).toBe("CONTAINED");
  });

  it("gives the evidenced purpose when the claim escalates to diagnosis (R25)", () => {
    const r = run({ claim: claim({ purpose: "diagnosis" }) });
    expect(rel(r.finding, "purpose")).toBe("PARTIAL");
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ purpose: "detection_aid" });
    expect(ruleIds(r)).toContain("R25-PURPOSE-ESCALATION");
  });

  it("treats unrelated purposes as DISJOINT, not as narrower", () => {
    const r = run({ claim: claim({ purpose: "screening" }) });
    expect(rel(r.finding, "purpose")).toBe("DISJOINT");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(ruleIds(r)).toContain("SAK-PURPOSE-DISJOINT");
  });

  it("never places a purpose the taxonomy does not know: review flag, not a guess", () => {
    const r = run({ claim: claim({ purpose: "autonomous differential diagnosis" }) });
    expect(rel(r.finding, "purpose")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags[0]).toMatchObject({ ruleId: "SAK-UNPLACED-PURPOSE", dimension: "purpose" });
  });

  it("sends several evidenced purposes inside the claimed one to review", () => {
    const custom = {
      id: "test-purposes",
      version: "1",
      nodes: { broad: { label: "broad use" }, left: { label: "left use", parent: "broad" }, right: { label: "right use", parent: "broad" } },
    };
    const r = run({
      claim: claim({ purpose: "broad" }),
      evidence: [auth({ purpose: "left" }), auth({ purpose: "right" }, { id: "auth-2" }), study({ purpose: undefined })],
      options: { taxonomies: { purposes: custom } },
    });
    expect(rel(r.finding, "purpose")).toBe("PARTIAL");
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags.map((f) => f.ruleId)).toContain("SAK-NARROWER-AMBIGUOUS");
  });

  it("is UNKNOWN when the claim leaves the purpose out", () => {
    expect(rel(run({ claim: claim({ purpose: undefined }) }).finding, "purpose")).toBe("UNKNOWN");
  });
});

describe("timing", () => {
  it("is contained inside an open-ended authorization window", () => {
    expect(rel(run().finding, "timing")).toBe("CONTAINED");
  });

  it("is DISJOINT, and asks for the successor record, when the claimed start is after the window ended", () => {
    const r = run({ evidence: [auth({ timing: { from: "2020-06-01", to: "2025-12-31" } }), study()] });
    expect(rel(r.finding, "timing")).toBe("DISJOINT");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(ruleIds(r)).toContain("SAK-AUTH-WINDOW-ENDED");
    expect(request(r.finding, "timing")).toMatch(/successor authorization/);
    expect(cov(r.finding, "timing").established).toMatch(/2020-06-01 to 2025-12-31/);
  });

  it("contradicts a claimed start before the authorization took effect (R21)", () => {
    const r = run({ claim: claim({ timing: { from: "2020-01-15" } }), evidence: [auth(), study({ timing: { from: "2019-01-01" } })] });
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(ruleIds(r)).toContain("R21-PREDATES-AUTH");
  });

  it("calls study evidence dated after the claimed start DISJOINT", () => {
    const r = run({ claim: claim({ timing: { from: "2021-06-01" } }) });
    expect(rel(r.finding, "timing")).toBe("DISJOINT");
    expect(ruleIds(r)).toContain("SAK-STUDY-POSTDATES");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("clips a claimed period that runs past the window to the covered period", () => {
    const r = run({ claim: claim({ timing: { from: "2026-01-01", to: "2027-12-31" } }), evidence: [auth({ timing: { from: "2020-06-01", to: "2026-12-31" } }), study()] });
    expect(rel(r.finding, "timing")).toBe("PARTIAL");
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ timing: { from: "2026-01-01", to: "2026-12-31" } });
  });

  it("is UNKNOWN when the claim gives no date, or only an end date", () => {
    expect(rel(run({ claim: claim({ timing: undefined }) }).finding, "timing")).toBe("UNKNOWN");
    const r = run({ claim: claim({ timing: { to: "2027-01-01" } }) });
    expect(rel(r.finding, "timing")).toBe("UNKNOWN");
    expect(r.reasons.find((x) => x.dimension === "timing")!.text).toMatch(/end date but no start/);
  });

  it("is UNKNOWN when no record dates itself", () => {
    const r = run({ evidence: [auth({ timing: undefined }), study({ timing: undefined })] });
    expect(rel(r.finding, "timing")).toBe("UNKNOWN");
    expect(ruleIds(r)).toContain("R19-DATES-MISSING");
  });

  it("raises a staleness flag only when the caller configures a window", () => {
    expect(run().finding.expertReviewFlags).toEqual([]);
    const r = run({ options: { policy: { stalenessWindowDays: 365 } } });
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags[0]).toMatchObject({ ruleId: "R20-STALENESS", dimension: "timing" });
    expect(run({ options: { policy: { stalenessWindowDays: 3650 } } }).finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });
});

describe("metric and operating point", () => {
  const withResult = (r: Parameters<typeof study>[1]) => ({ evidence: [auth(), study({}, r)] });

  it("is supported only when the lower bound of the interval reaches the claimed minimum", () => {
    expect(run(withResult([{ ...GOOD_RESULT, ci: [0.9, 0.98] }])).finding.label).toBe("SUPPORTED_FOR_SCOPE");
    const r = run(withResult([{ ...GOOD_RESULT, ci: [0.89, 0.98] }]));
    expect(rel(r.finding, "metric")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(request(r.finding, "metric")).toMatch(/lower bound is at or above 0\.9/);
    expect(r.reasons.find((x) => x.dimension === "metric")!.text).toMatch(/includes the claimed minimum 0\.9/);
  });

  it("contradicts a claim whose minimum lies above the whole interval of an adequate, in-scope study (R34)", () => {
    const r = run(withResult([{ ...GOOD_RESULT, value: 0.84, ci: [0.8, 0.88] }]));
    expect(rel(r.finding, "metric")).toBe("DISJOINT");
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(cov(r.finding, "metric").anchorIds).toContain("anc-study-sens");
  });

  it("never supports from a point estimate alone", () => {
    const r = run(withResult([{ metric: "sensitivity", value: 0.99, operatingPoint: OP }]));
    expect(rel(r.finding, "metric")).toBe("UNKNOWN");
    expect(r.reasons.find((x) => x.dimension === "metric")!.text).toMatch(/no confidence interval/);
  });

  it("does not compare results at a different operating point", () => {
    const r = run(withResult([{ ...GOOD_RESULT, operatingPoint: "high sensitivity threshold" }]));
    expect(rel(r.finding, "metric")).toBe("UNKNOWN");
    expect(ruleIds(r)).toContain("R33-OPERATING-POINT");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(request(r.finding, "metric")).toMatch(/operating point protocol threshold/);
  });

  it("does not compare a result with an unreported operating point against a claim that names one", () => {
    const r = run(withResult([{ ...GOOD_RESULT, operatingPoint: undefined }]));
    expect(rel(r.finding, "metric")).toBe("UNKNOWN");
  });

  it("does not compare a result at a named operating point against a claim that names none", () => {
    const r = run({ claim: claim({ operatingPoint: undefined }) });
    expect(rel(r.finding, "metric")).toBe("UNKNOWN");
  });

  it("compares threshold-free metrics when neither side names an operating point", () => {
    const r = run({
      claim: claim({ operatingPoint: undefined }, { metric: "AUC", atLeast: 0.9 }),
      evidence: [auth(), study({}, [{ metric: "auroc", value: 0.95, ci: [0.93, 0.97] }])],
    });
    expect(rel(r.finding, "metric")).toBe("CONTAINED");
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("reads recall as sensitivity and nothing else as anything", () => {
    expect(rel(run(withResult([{ ...GOOD_RESULT, metric: "Recall" }])).finding, "metric")).toBe("CONTAINED");
    const r = run(withResult([{ ...GOOD_RESULT, metric: "specificity" }]));
    expect(rel(r.finding, "metric")).toBe("UNKNOWN");
    expect(ruleIds(r)).toContain("R32-METRIC-ABSENT");
  });

  it("does not take a measured result from an authorization record or a vendor record", () => {
    const fromAuth = run({ evidence: [auth({}, { results: [GOOD_RESULT] }), study({}, [])] });
    expect(rel(fromAuth.finding, "metric")).toBe("UNKNOWN");
    const fromVendor = run({ evidence: [auth(), study({}, []), vendor()] });
    expect(rel(fromVendor.finding, "metric")).toBe("UNKNOWN");
    expect(fromVendor.finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("flags prevalence-dependent metrics instead of computing a transport", () => {
    const r = run({ claim: claim({}, { metric: "PPV", atLeast: 0.5 }), evidence: [auth(), study({}, [{ ...GOOD_RESULT, metric: "ppv", value: 0.8, ci: [0.7, 0.9] }])] });
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags.map((f) => f.ruleId)).toEqual(["R14-PREVALENCE-TRANSPORT"]);
  });

  it("raises an imprecision flag only under a configured policy", () => {
    expect(run().finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(run({ options: { policy: { minResultN: 2000 } } }).finding.expertReviewFlags[0]).toMatchObject({ ruleId: "R13-RESULT-IMPRECISE" });
    expect(run({ options: { policy: { maxCiWidth: 0.05 } } }).finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(run({ options: { policy: { maxCiWidth: 0.5, minResultN: 10 } } }).finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("does not assess a metric when the claim states no performance", () => {
    const r = run({ claim: claim({}, null), evidence: [auth()] });
    expect(rel(r.finding, "metric")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.finding.mismatches.map((m) => m.dimension)).not.toContain("metric");
  });
});

describe("minimal counterexample and evidence requests", () => {
  it("names exactly the dimensions that are not contained, with both sides, in dimension order", () => {
    const r = run({ claim: claim({ versions: ["2.2.0"], settings: ["hospital"], purpose: "diagnosis" }) });
    expect(r.finding.mismatches.map((m) => m.dimension)).toEqual(["version", "setting", "purpose"]);
    expect(r.finding.mismatches[0]).toMatchObject({ claimed: "2.2.0", established: expect.stringContaining("2.1.0") });
    expect(r.finding.requiredEvidence.map((x) => x.dimension)).toEqual(["version", "setting", "purpose"]);
    for (const x of r.finding.requiredEvidence) expect(x.request.length).toBeGreaterThan(40);
  });

  it("repairing each mismatched dimension on its own removes it and nothing else", () => {
    const wide = claim({ versions: ["2.2.0"], settings: ["hospital"] });
    const base = run({ claim: wide });
    expect(base.finding.mismatches.map((m) => m.dimension)).toEqual(["version", "setting"]);
    const fixV = run({ claim: claim({ versions: ["2.1.0"], settings: ["hospital"] }) });
    expect(fixV.finding.mismatches.map((m) => m.dimension)).toEqual(["setting"]);
    const fixBoth = run({ claim: claim() });
    expect(fixBoth.finding.mismatches).toEqual([]);
  });
});
