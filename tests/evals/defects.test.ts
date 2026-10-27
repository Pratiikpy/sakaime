import { describe, expect, it } from "vitest";
import { compile } from "../../src/compiler/index.ts";

/*
 * Defects the evaluation found in other modules. Each is a test that is expected to fail (`it.fails`): it passes while the defect exists and
 * turns red when the defect is fixed, which is the signal to delete it. They sit here because the evaluation owns this directory;
 * the modules themselves are not edited by the evaluation.
 */
describe("known defects found by the evaluation", () => {
  const auth = { id: "a", assertionType: "authorization", scope: { product: "p", population: { conditions: ["adults at risk for heart failure"] } }, results: [], limitations: [], anchorIds: ["x"] };
  const study = {
    id: "s",
    assertionType: "study",
    scope: { product: "p", population: { age: { min: 18 }, conditions: ["adults at risk for heart failure"], exclusions: ["paced rhythm"] } },
    results: [],
    limitations: [],
    anchorIds: ["y"],
    adequate: true,
  };
  const claim = { id: "c", use: { product: "p", population: { age: { min: 18 }, conditions: ["adults at risk for heart failure", "paced rhythm"] } }, dependencies: { required: ["authorization", "study"], corroborating: [] } };

  it.fails("compile returns a label, not CompilerInvariantError, when a claimed condition is also a study exclusion (Gate 0 claim AN-02 on its hand-written evidence)", () => {
    const f = compile(claim, [auth, study], { requiredDimensions: ["product", "population"] });
    expect(f.label).toMatch(/SUPPORTED_ONLY_FOR_NARROWER_SCOPE|INSUFFICIENT_EVIDENCE|REQUIRES_DOMAIN_REVIEW|CONTRADICTED_BY_SPECIFIED_EVIDENCE/);
  });

  it("the same claim and evidence with the compiler's default dependencies does return a label (the defect needs both record types required)", () => {
    const f = compile({ ...claim, dependencies: undefined }, [auth, study], { requiredDimensions: ["product", "population"] });
    expect(f.label).toBe("INSUFFICIENT_EVIDENCE");
  });
});
