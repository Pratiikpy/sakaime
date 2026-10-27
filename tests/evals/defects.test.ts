import { describe, expect, it } from "vitest";
import { compile } from "../../src/compiler/index.ts";

/*
 * Defects the evaluation found in other modules. Each was first written as `it.fails`, which passes while the defect exists and turns
 * red when it is fixed. They are ordinary tests now that the modules are repaired, and stay as regression tests.
 */
describe("defects found by the evaluation, now fixed", () => {
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

  it("compile returns a label, not CompilerInvariantError, when a claimed condition is also a study exclusion (Gate 0 claim AN-02 on its hand-written evidence)", () => {
    const f = compile(claim, [auth, study], { requiredDimensions: ["product", "population"] });
    // The exclusion is a study exclusion, not an authorization limit, so it narrows the claim and does not contradict it (R10 reads authorization records only).
    expect(f.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    // The narrower scope keeps the excluded group excluded; that is what makes it fully covered.
    expect(f.supportedScope).toMatchObject({ population: { exclusions: ["paced rhythm"] } });
    expect(f.mismatches.map((m) => m.dimension)).toEqual(["population"]);
  });

  it("the same exclusion stated by the authorization record contradicts the claim (R10)", () => {
    const authWithLimit = { ...auth, scope: { ...auth.scope, population: { ...auth.scope.population, exclusions: ["paced rhythm"] } } };
    const f = compile(claim, [authWithLimit, study], { requiredDimensions: ["product", "population"] });
    expect(f.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });

  it("the same claim and evidence with the compiler's default dependencies does return a label (the defect needs both record types required)", () => {
    const f = compile({ ...claim, dependencies: undefined }, [auth, study], { requiredDimensions: ["product", "population"] });
    expect(f.label).toBe("INSUFFICIENT_EVIDENCE");
  });
});
