import { describe, expect, it } from "vitest";
import { compileDetailed, type CompileOptions } from "../../src/compiler/index.ts";
import type { Dimension, EvidenceItem, EvidenceResult, Finding } from "../../src/schemas/index.ts";

/*
 * Cases built from the real records in docs/01-prd.md section 8, research/feasibility/FEASIBILITY-REPORT.md sections 4 and 6,
 * and the FDA clauses quoted in research/standards/APPLICABILITY-RULE-REGISTRY.md section 5.
 *
 * REAL in these fixtures: device identifiers, software version labels, study identifiers, participant and site counts,
 * the quoted FDA clauses and the K250694 and DEN170073 point estimates and intervals from the registry.
 * CONSTRUCTED: every vendor claim, every hospital requirement, the dates that no source gave, the care-setting mapping into
 * our taxonomy and the performance values for EyeArt, Transpara and Lunit (the report does not carry them).
 * No test here is a finding about a real vendor.
 */

const run = (claim: object, evidence: EvidenceItem[], options: CompileOptions = {}) => compileDetailed(claim, evidence, options);
const rel = (f: Finding, d: Dimension) => f.mechanicalCoverage.find((x) => x.dimension === d)!.relation;
const request = (f: Finding, d: Dimension) => f.requiredEvidence.find((x) => x.dimension === d)?.request ?? "";

const item = (id: string, assertionType: EvidenceItem["assertionType"], scope: EvidenceItem["scope"], extra: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id,
  assertionType,
  scope,
  results: [],
  limitations: [],
  anchorIds: [],
  ...extra,
});

/* ----------------------------------------------------------------- EyeArt */

describe("EyeArt K200667, version 2.1.0, NCT03112005: the clean chain", () => {
  const product = "device:fda:K200667";
  const population = { age: { min: 18 }, conditions: ["diabetes mellitus"] }; // CONSTRUCTED age and condition wording
  const result: EvidenceResult = { metric: "sensitivity", value: 0.95, ci: [0.92, 0.97], n: 942, operatingPoint: "device default", anchorId: "anc-nct03112005-sens" }; // CONSTRUCTED values
  const evidence = [
    item("fda-summary-k200667", "authorization", { product, versions: ["2.1.0"], population, settings: ["primary_care", "eye_care"], purpose: "detection_aid", timing: { from: "2020-06-01" } }, { anchorIds: ["anc-fda-ifu"] }),
    item("study-nct03112005", "study", { product, versions: ["2.1.0"], population, settings: ["primary_care", "eye_care"], timing: { from: "2021-11-01" } }, { adequate: true, results: [result], anchorIds: ["anc-nct03112005-design", "anc-pmid34779843"] }),
  ];
  const claim = (use: object = {}) => ({
    id: "eyeart-claim",
    use: { product, versions: ["2.1.0"], population, settings: ["primary_care"], purpose: "detection_aid", timing: { from: "2026-12-01" }, operatingPoint: "device default", ...use },
    performance: { metric: "sensitivity", atLeast: 0.9 },
  });

  it("supports a primary care deployment of the evaluated version", () => {
    const r = run(claim(), evidence);
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.finding.mechanicalCoverage.find((m) => m.dimension === "metric")!.anchorIds).toEqual(["anc-nct03112005-design", "anc-nct03112005-sens", "anc-pmid34779843"]);
    expect(r.finding.dependsOnFacts).toEqual(["fda-summary-k200667", "study-nct03112005"]);
  });

  it("supports the same use in both studied settings but not in the emergency department", () => {
    expect(run(claim({ settings: ["primary_care", "eye_care"] }), evidence).finding.label).toBe("SUPPORTED_FOR_SCOPE");
    const ed = run(claim({ settings: ["emergency_department"] }), evidence);
    expect(ed.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(request(ed.finding, "setting")).toMatch(/study results from emergency department/);
  });

  it("does not carry the evidence over to a newer software release", () => {
    const r = run(claim({ versions: ["2.2.0"] }), evidence);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(rel(r.finding, "version")).toBe("DISJOINT");
  });

  it("narrows a hospital-wide claim to the two clinics the study ran in", () => {
    const r = run(claim({ settings: ["any_care_setting"] }), [
      item("fda-summary-k200667", "authorization", { ...evidence[0]!.scope, settings: ["any_care_setting"] }),
      evidence[1]!,
    ]);
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ settings: ["eye_care", "primary_care"], versions: ["2.1.0"] });
  });
});

/* -------------------------------------------------------------- Transpara */

describe("Transpara 1.7.2 against the MASAI trial's version 1.7.0", () => {
  const authorization = item("fda-k221347", "authorization", { product: "device:fda:K221347", versions: ["1.7.2"], purpose: "detection_aid", timing: { from: "2022-01-01" } }, { anchorIds: ["anc-k221347"] });
  const successor = item("fda-k241831", "authorization", { product: "device:fda:K221347", versions: ["2.1.0"], purpose: "detection_aid", timing: { from: "2025-01-01" } });
  const masai = item(
    "masai-nct04838756",
    "study",
    { product: "device:fda:K221347", versions: ["1.7.0"], population: { age: { min: 40, max: 74 }, conditions: ["women in breast screening"] }, settings: ["imaging_centre"], timing: { from: "2023-08-01" } },
    { adequate: true, anchorIds: ["anc-pmid37541274"], results: [{ metric: "sensitivity", value: 0.9, ci: [0.88, 0.92], n: 100000, operatingPoint: "risk score 10" }] }, // value CONSTRUCTED
  );
  const claim = (version: string) => ({
    id: "transpara-claim",
    use: { product: "device:fda:K221347", versions: [version], population: { age: { min: 40, max: 74 }, conditions: ["women in breast screening"] }, settings: ["imaging_centre"], purpose: "detection_aid", timing: { from: "2026-12-01" }, operatingPoint: "risk score 10" },
    performance: { metric: "sensitivity", atLeast: 0.85 },
  });

  it("holds the deployed 1.7.2 to the version FDA reviewed, and says the study tested a different one", () => {
    const r = run(claim("1.7.2"), [authorization, masai]);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.mismatches.map((m) => m.dimension)).toEqual(["version"]);
    expect(r.finding.mismatches[0]!.established).toBe("authorization record: 1.7.2; study: 1.7.0");
    expect(r.reasons.find((x) => x.dimension === "version")!.text).toMatch(/Against the authorization record alone the claim is covered; against the studies alone it is not covered/);
    expect(request(r.finding, "version")).toMatch(/whether 1\.7\.2 differs from the evaluated version \(authorization record: 1\.7\.2; study: 1\.7\.0\) in the model or only in the build/);
  });

  it("does not treat the study's 1.7.0 as authorized either", () => {
    expect(run(claim("1.7.0"), [authorization, masai]).finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("keeps the 2.x release separate from both", () => {
    const r = run(claim("2.1.0"), [authorization, successor, masai]);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.mismatches.map((m) => m.dimension)).toEqual(["version"]);
  });
});

/* ------------------------------------------------------------------- Lunit */

describe("Lunit INSIGHT CXR Triage K211733: the same brand, a different use and version", () => {
  const product = "device:fda:K211733";
  const authorization = item(
    "fda-k211733",
    "authorization",
    { product, versions: ["1.0"], population: { conditions: ["pleural effusion", "pneumothorax"] }, purpose: "triage_notification", timing: { from: "2021-08-01" } },
    { anchorIds: ["anc-k211733"] },
  );
  const tbStudy = item(
    "study-nct06401434",
    "study",
    { product, versions: ["3.1.0.0", "3.9.0.1"], population: { conditions: ["tuberculosis"] }, settings: ["outpatient_care"], purpose: "screening", timing: { from: "2025-04-01" } },
    { adequate: true, anchorIds: ["anc-pmid40233023"], results: [{ metric: "sensitivity", value: 0.84, ci: [0.81, 0.87], n: 1000, operatingPoint: "default" }] }, // value CONSTRUCTED
  );

  it("does not let tuberculosis screening studies stand in for pleural effusion triage", () => {
    const r = run(
      { id: "lunit-claim", use: { product, versions: ["1.0"], population: { conditions: ["pleural effusion"] }, settings: ["outpatient_care"], purpose: "triage_notification", timing: { from: "2026-12-01" }, operatingPoint: "default" }, performance: { metric: "sensitivity", atLeast: 0.9 } },
      [authorization, tbStudy],
    );
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags[0]).toMatchObject({ ruleId: "SAK-CONTRARY-UNDISPOSITIONED" });
    expect(r.finding.expertReviewFlags[0]!.reason).toMatch(/does not cover the claimed scope/);
    expect(rel(r.finding, "version")).toBe("DISJOINT");
    expect(rel(r.finding, "purpose")).toBe("DISJOINT");
    expect(rel(r.finding, "population")).toBe("DISJOINT");
  });

  it("lets the reviewer rule the tuberculosis result off scope, leaving the missing evidence for the claimed use", () => {
    const r = run(
      { id: "lunit-claim", use: { product, versions: ["1.0"], population: { conditions: ["pleural effusion"] }, settings: ["outpatient_care"], purpose: "triage_notification", timing: { from: "2026-12-01" }, operatingPoint: "default" }, performance: { metric: "sensitivity", atLeast: 0.9 } },
      [authorization, tbStudy],
      { dispositions: [{ evidenceId: "study-nct06401434", relevance: "off_scope", note: "tuberculosis screening, versions 3.x" }] },
    );
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.contraryDispositions).toHaveLength(1);
    expect(request(r.finding, "version")).toMatch(/study results for software version 1\.0/);
  });

  it("is also insufficient for the claim the studies do speak to, because FDA authorized a different use and version", () => {
    const r = run(
      { id: "lunit-tb", use: { product, versions: ["3.9.0.1"], population: { conditions: ["tuberculosis"] }, settings: ["outpatient_care"], purpose: "screening", timing: { from: "2026-12-01" }, operatingPoint: "default" }, performance: { metric: "sensitivity", atLeast: 0.8 } },
      [authorization, tbStudy],
    );
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.mismatches.map((m) => m.dimension)).toEqual(["version", "population", "purpose"]);
  });
});

/* ----------------------------------------------------------------- Viz LVO */

describe("Viz LVO DEN170073: one De Novo, eleven GUDID versions, a trial that cites the De Novo number", () => {
  const product = "device:fda:DEN170073";
  const authorization = item(
    "fda-den170073",
    "authorization",
    { product, versions: ["1.0"], population: { age: { min: 18 } }, purpose: "triage_notification", timing: { from: "2018-02-13" } }, // "initial version 1.0" is the FDA text; the effective date and age are CONSTRUCTED
    { anchorIds: ["anc-den170073-f"] },
  );
  const registry = item("trial-nct04608617", "study", { product, population: { age: { min: 18 } }, settings: ["hospital"], timing: { from: "2020-10-01" } }, { adequate: true, anchorIds: ["anc-nct04608617"] });
  const claim = (version: string) => ({
    id: "viz-claim",
    use: { product, versions: [version], population: { age: { min: 18 } }, settings: ["hospital"], purpose: "triage_notification", timing: { from: "2026-12-01" } },
  });
  const noPerf = { dependencies: { required: ["authorization", "study"], corroborating: [] } };

  it("does not place a deployed 1.7 on FDA's version 1.0 scale", () => {
    const r = run({ ...claim("1.7"), ...noPerf }, [authorization, registry]);
    expect(rel(r.finding, "version")).toBe("DISJOINT");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("does not tie the registry record to version 1.0 either: the trial states no version", () => {
    const r = run({ ...claim("1.0"), ...noPerf }, [authorization, registry]);
    expect(rel(r.finding, "version")).toBe("UNKNOWN");
    expect(r.reasons.find((x) => x.dimension === "version")!.text).toMatch(/study records do not state a software version/);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.mismatches.map((m) => m.dimension)).toEqual(["version"]);
  });

  it("is supported on the dimensions both records state once the study names the version", () => {
    const r = run({ ...claim("1.0"), ...noPerf }, [authorization, { ...registry, scope: { ...registry.scope, versions: ["1.0"] } }]);
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("holds a diagnosis claim to the notification-only indication as a narrower scope", () => {
    // DEN170073 section F: "Identification of suspected findings is not for diagnostic use beyond notification."
    // The registry's R24 would call a diagnosis claim CONTRADICTED on that explicit negation. The evidence schema carries no
    // structured negation, so this build reports the narrower scope instead and does not parse the sentence.
    const r = run({ ...claim("1.0"), ...noPerf, use: { ...claim("1.0").use, purpose: "diagnosis" } }, [authorization, { ...registry, scope: { ...registry.scope, versions: ["1.0"] } }]);
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ purpose: "triage_notification" });
  });
});

/* ----------------------------------------------------- FDA clauses (registry s5) */

describe("K250694 Scaida BrainCT-ICH v1.0: clauses from the 510(k) summary", () => {
  const product = "device:fda:K250694";
  const base = { product, versions: ["1.0"], population: { age: { min: 22 }, conditions: ["intracranial hemorrhage"] }, settings: ["hospital"] };
  const sensitivity: EvidenceResult = { metric: "sensitivity", value: 0.867, ci: [0.811, 0.908], n: 294, operatingPoint: "unreported", anchorId: "anc-k250694-sens" };
  const evidence = (studyDate?: string): EvidenceItem[] => [
    item("fda-k250694", "authorization", { ...base, purpose: "triage_notification", timing: { from: "2025-11-25" } }, { anchorIds: ["anc-k250694-ifu"] }),
    item("fda-k250694-performance", "study", { ...base, ...(studyDate ? { timing: { from: studyDate } } : {}) }, { adequate: true, results: [sensitivity], anchorIds: ["anc-k250694-study"] }),
  ];
  const claim = (use: object, atLeast: number) => ({
    id: "k250694-claim",
    use: { ...base, purpose: "triage_notification", timing: { from: "2026-12-01" }, operatingPoint: "unreported", ...use },
    performance: { metric: "sensitivity", atLeast },
  });

  it("states ages 22 and above in the indications for use: a claim for 18 and above is contradicted by the record", () => {
    const r = run(claim({ population: { age: { min: 18 }, conditions: ["intracranial hemorrhage"] } }, 0.8), evidence("2025-06-01"));
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(r.trace.find((t) => t.ruleId === "R10-POP-LABEL-EXCLUDED")!.effect).toMatch(/the record covers ages 22 and above; the claim extends to ages 18 to below 22/);
  });

  it("a claim for 22 and above, with every other dimension stated, is supported at a minimum its interval reaches", () => {
    expect(run(claim({}, 0.8), evidence("2025-06-01")).finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("registry example: sensitivity 0.867 (0.811 to 0.908) against a claim of 0.90 is insufficient, against 0.95 it is contradicted", () => {
    const straddle = run(claim({}, 0.9), evidence("2025-06-01"));
    expect(straddle.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(rel(straddle.finding, "metric")).toBe("UNKNOWN");
    const above = run(claim({}, 0.95), evidence("2025-06-01"));
    expect(above.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });

  it("the summary reports no collection dates: the timing dimension stays unknown and the label insufficient", () => {
    const r = run(claim({}, 0.8), evidence());
    expect(rel(r.finding, "timing")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.trace.map((t) => t.ruleId)).toContain("R19-DATES-MISSING");
  });

  it("the summary reports no care setting: a claim for a setting the records never name is unknown", () => {
    const noSetting = evidence("2025-06-01").map((e) => ({ ...e, scope: { ...e.scope, settings: undefined } }));
    const r = run(claim({}, 0.8), noSetting);
    expect(rel(r.finding, "setting")).toBe("UNKNOWN");
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("the letter date 2025-11-25 is the effective date: a go-live before it is contradicted (R21)", () => {
    const r = run(claim({ timing: { from: "2025-11-01" } }, 0.8), evidence("2025-06-01"));
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });
});

describe("DEN170073 test set: approximately equal numbers of positive and negative cases", () => {
  it("sends a predictive-value claim to review, because an enriched test set does not carry its prevalence", () => {
    const product = "device:fda:DEN170073";
    const scope = { product, versions: ["1.0"], population: { age: { min: 18 } }, settings: ["hospital"] };
    const r = run(
      { id: "ppv-claim", use: { ...scope, purpose: "triage_notification", timing: { from: "2026-12-01" }, operatingPoint: "fixed threshold" }, performance: { metric: "PPV", atLeast: 0.5 } },
      [
        item("fda-den170073", "authorization", { ...scope, purpose: "triage_notification", timing: { from: "2018-02-13" } }),
        item("fda-den170073-test", "study", { ...scope, timing: { from: "2018-01-01" } }, { adequate: true, results: [{ metric: "positive predictive value", value: 0.9, ci: [0.85, 0.94], n: 300, operatingPoint: "fixed threshold" }] }),
      ],
    );
    expect(r.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(r.finding.expertReviewFlags.map((f) => f.ruleId)).toEqual(["R14-PREVALENCE-TRANSPORT"]);
  });
});
