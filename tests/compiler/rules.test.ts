import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RULES, RULE_BY_ID, UNIMPLEMENTED_REGISTRY_RULES, compileDetailed, ruleOf, type CompileOptions } from "../../src/compiler/index.ts";
import type { EvidenceItem } from "../../src/schemas/index.ts";
import { GOOD_RESULT, OP, auth, claim, requirement, study, vendor } from "./fixtures.ts";

const REGISTRY = join(process.cwd(), "research", "standards", "APPLICABILITY-RULE-REGISTRY.md");
const registryText = existsSync(REGISTRY) ? readFileSync(REGISTRY, "utf8") : undefined;

describe("rule registry integrity", () => {
  it("has unique ids, a version, a summary and a tag on every rule", () => {
    expect(new Set(RULES.map((r) => r.id)).size).toBe(RULES.length);
    for (const r of RULES) {
      expect(r.version).toMatch(/^\d+$/);
      expect(r.summary.length).toBeGreaterThan(20);
      expect(["deterministic", "flag"]).toContain(r.tag);
    }
    expect(() => ruleOf("R99-INVENTED")).toThrow(/unknown compiler rule id/);
  });

  it("cites a standard for every rule built on a standard's concept, and nothing for design inferences", () => {
    for (const r of RULES) {
      if (r.basis === "standard-concept") expect(r.citations.length, r.id).toBeGreaterThan(0);
      else expect(r.citations, r.id).toEqual([]);
    }
  });

  it("covers the 38 registry rules exactly once: implemented here, or listed as unimplemented with a reason", () => {
    const implemented = RULES.flatMap((r) => (r.registryId ? [r.registryId] : []));
    const unimplemented = Object.keys(UNIMPLEMENTED_REGISTRY_RULES);
    expect(implemented.filter((id) => unimplemented.includes(id))).toEqual([]);
    const all = [...implemented, ...unimplemented].sort();
    expect(all).toEqual(Array.from({ length: 38 }, (_, i) => `R${String(i + 1).padStart(2, "0")}`));
    for (const reason of Object.values(UNIMPLEMENTED_REGISTRY_RULES)) expect(reason).toMatch(/^needs /);
  });

  it("marks the clinician-contested registry rules, and only those, as contested", () => {
    expect(RULES.filter((r) => r.contested).map((r) => r.registryId).sort()).toEqual(["R01", "R25", "R34"]);
  });

  it("tags the rules the registry calls human judgement as flags, and the arithmetic rules as deterministic", () => {
    const flagged = RULES.filter((r) => r.tag === "flag" && r.registryId).map((r) => r.registryId);
    expect(flagged.sort()).toEqual(["R13", "R14", "R20"]);
    for (const id of ["R01", "R02", "R08", "R09", "R10", "R11", "R15", "R19", "R21", "R25", "R32", "R33", "R34"]) {
      expect(RULES.find((r) => r.registryId === id)!.tag).toBe("deterministic");
    }
  });

  it.skipIf(!registryText)("takes every numbered pointer in a citation from that rule's line of the registry", () => {
    let checked = 0;
    for (const rule of RULES.filter((r) => r.registryId)) {
      const line = registryText!.split("\n").find((l) => l.startsWith(`${rule.registryId} `));
      expect(line, `registry line for ${rule.registryId}`).toBeDefined();
      for (const citation of rule.citations) {
        const tokens = citation.match(/\b(?:K|DEN)\d{6}\b|\b\d{4}-\d{2}-\d{2}\b|\b\d+(?:\.\d+)*[a-e]?(?:\/[a-e])?(?:\([a-z0-9]+\))*|\b[IVX]+\.[A-Z]\b|\bF\.\d\b/g) ?? [];
        for (const t of tokens) {
          if (/^(1|2|3|4)$/.test(t) && !/\bitem\b|\bquestion\b|\bsection\b/.test(citation)) continue;
          expect(line!.includes(t) || registryText!.includes(t), `${rule.id}: "${t}" from "${citation}" is not in the registry`).toBe(true);
          checked++;
        }
      }
    }
    expect(checked, "the citation check must actually compare pointers").toBeGreaterThan(15);
  });
});

type Scenario = { id: string; run: () => ReturnType<typeof compileDetailed>; where: "trace" | "flags" };
const SCENARIOS: Scenario[] = [
  { id: "R01-VER-DISJOINT", where: "trace", run: () => compileDetailed(claim({ versions: ["9.9"] }), [auth(), study()]) },
  { id: "R02-VER-UNRECORDED", where: "trace", run: () => compileDetailed(claim(), [auth({ versions: undefined }), study({ versions: undefined })]) },
  { id: "R08-POP-SUBSET", where: "trace", run: () => compileDetailed(claim({ population: { age: { min: 18 }, conditions: ["diabetes mellitus", "asthma"], exclusions: ["pregnancy"] } }), [auth(), study()]) },
  { id: "R09-POP-DISJOINT", where: "trace", run: () => compileDetailed(claim({ population: { age: { max: 5 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } }), [auth({ population: undefined }), study()]) },
  { id: "R10-POP-LABEL-EXCLUDED", where: "trace", run: () => compileDetailed(claim({ population: { age: { min: 10 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } }), [auth(), study()]) },
  { id: "R11-POP-UNDESCRIBED", where: "trace", run: () => compileDetailed(claim(), [auth({ population: undefined }), study({ population: undefined })]) },
  { id: "R13-RESULT-IMPRECISE", where: "flags", run: () => compileDetailed(claim(), [auth(), study()], { policy: { minResultN: 5000 } }) },
  { id: "R14-PREVALENCE-TRANSPORT", where: "flags", run: () => compileDetailed(claim({}, { metric: "npv", atLeast: 0.5 }), [auth(), study({}, [{ ...GOOD_RESULT, metric: "NPV" }])]) },
  { id: "R15-SETTING-NOT-STUDIED", where: "trace", run: () => compileDetailed(claim({ settings: ["emergency_department"] }), [auth(), study()]) },
  { id: "R19-DATES-MISSING", where: "trace", run: () => compileDetailed(claim(), [auth({ timing: undefined }), study({ timing: undefined })]) },
  { id: "R20-STALENESS", where: "flags", run: () => compileDetailed(claim(), [auth(), study()], { policy: { stalenessWindowDays: 30 } }) },
  { id: "R21-PREDATES-AUTH", where: "trace", run: () => compileDetailed(claim({ timing: { from: "2020-01-01" } }), [auth(), study({ timing: { from: "2019-01-01" } })]) },
  { id: "R25-PURPOSE-ESCALATION", where: "trace", run: () => compileDetailed(claim({ purpose: "diagnosis" }), [auth(), study()]) },
  { id: "R32-METRIC-ABSENT", where: "trace", run: () => compileDetailed(claim(), [auth(), study({}, [])]) },
  { id: "R33-OPERATING-POINT", where: "trace", run: () => compileDetailed(claim({ operatingPoint: "other" }), [auth(), study()]) },
  { id: "R34-CLAIMED-VALUE-VS-CI", where: "trace", run: () => compileDetailed(claim({}, { metric: "sensitivity", atLeast: 0.99 }), [auth(), study()]) },
  { id: "SAK-CLAIM-UNSPECIFIED", where: "trace", run: () => compileDetailed(claim({ population: undefined }), [auth(), study()]) },
  { id: "SAK-EVIDENCE-UNSPECIFIED", where: "trace", run: () => compileDetailed(claim(), [auth({ product: undefined }), study({ product: undefined })]) },
  { id: "SAK-PRODUCT-MISMATCH", where: "trace", run: () => compileDetailed(claim(), [auth({ product: "device:fda:K9" }), study({ product: "device:fda:K9" })]) },
  { id: "SAK-PURPOSE-DISJOINT", where: "trace", run: () => compileDetailed(claim({ purpose: "screening" }), [auth(), study()]) },
  { id: "SAK-AUTH-WINDOW-ENDED", where: "trace", run: () => compileDetailed(claim(), [auth({ timing: { from: "2020-06-01", to: "2025-01-01" } }), study()]) },
  { id: "SAK-STUDY-POSTDATES", where: "trace", run: () => compileDetailed(claim({ timing: { from: "2021-06-01" } }), [auth(), study()]) },
  { id: "SAK-SOURCE-LOSS", where: "trace", run: () => compileDetailed(claim(), [auth(), study()], { sourceHealth: { study: "DRIFTED" } }) },
  { id: "SAK-AUTHORITY", where: "trace", run: () => compileDetailed(claim(), [auth({}, { results: [GOOD_RESULT] }), study(), vendor()]) },
  { id: "SAK-JOINT-COVERAGE", where: "flags", run: () => compileDetailed(claim(), [auth({ settings: ["eye_care"] }), auth({ settings: ["primary_care"] }, { id: "auth-2" }), study()]) },
  { id: "SAK-UNPLACED-SETTING", where: "flags", run: () => compileDetailed(claim({ settings: ["moon base"] }), [auth(), study()]) },
  { id: "SAK-UNPLACED-PURPOSE", where: "flags", run: () => compileDetailed(claim({ purpose: "moon base" }), [auth(), study()]) },
  {
    id: "SAK-NARROWER-AMBIGUOUS",
    where: "flags",
    run: () =>
      compileDetailed(claim({ population: { age: { min: 18, max: 65 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } }), [
        auth({ population: undefined }),
        study({ population: { age: { min: 18, max: 30 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } }),
        study({ population: { age: { min: 40, max: 65 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] } }, [GOOD_RESULT], { id: "study-2" }),
      ]),
  },
  { id: "SAK-CONTRARY-UNDISPOSITIONED", where: "flags", run: () => compileDetailed(claim(), [auth(), study(), study({}, [{ ...GOOD_RESULT, value: 0.5, ci: [0.4, 0.6] }], { id: "study-2", adequate: false })]) },
  { id: "SAK-REQUIREMENT", where: "flags", run: () => compileDetailed(claim(), [auth(), study(), requirement(false)]) },
];

describe("every rule fires in a test, and what fires is in the registry", () => {
  it("has a scenario for every rule in the registry", () => {
    expect(SCENARIOS.map((s) => s.id).sort()).toEqual(RULES.map((r) => r.id).sort());
  });

  for (const s of SCENARIOS) {
    it(`${s.id} is reported where it fires`, () => {
      const r = s.run();
      const fired = s.where === "trace" ? r.trace.map((t) => t.ruleId) : r.finding.expertReviewFlags.map((f) => f.ruleId);
      expect(fired).toContain(s.id);
      expect(RULE_BY_ID.get(s.id)!.tag).toBe(s.where === "flags" ? "flag" : "deterministic");
    });
  }

  it("raises only registered ids, and expert flags only from rules tagged as flags", () => {
    const evidence: EvidenceItem[] = [auth(), study(), vendor(), requirement(false)];
    const options: CompileOptions[] = [{}, { policy: { stalenessWindowDays: 10, minResultN: 99999, maxCiWidth: 0.001 } }, { sourceHealth: { study: "EMPTY" } }];
    for (const s of SCENARIOS) {
      const r = s.run();
      for (const t of r.trace) expect(RULE_BY_ID.has(t.ruleId), t.ruleId).toBe(true);
      for (const f of r.finding.expertReviewFlags) expect(RULE_BY_ID.get(f.ruleId)?.tag, f.ruleId).toBe("flag");
    }
    for (const o of options) {
      const r = compileDetailed(claim({ operatingPoint: OP }), evidence, o);
      for (const f of r.finding.expertReviewFlags) expect(RULE_BY_ID.get(f.ruleId)?.tag, f.ruleId).toBe("flag");
    }
  });
});
