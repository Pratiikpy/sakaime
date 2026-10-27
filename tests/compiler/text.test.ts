import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { RULES, UNIMPLEMENTED_REGISTRY_RULES, compileDetailed, describeAssessment, type CompileDetail } from "../../src/compiler/index.ts";
import { DIMENSIONS, RELATIONS } from "../../src/schemas/index.ts";
import { arbChoices, arbScope, shrink, grow } from "./arbitraries.ts";
import { GOOD_RESULT, auth, claim, requirement, study, vendor } from "./fixtures.ts";

/** The words the product's wording lint bans in user-facing text, plus the verdict words the label set exists to avoid. */
const BANNED = /\b(best|proof|guarantee[sd]?|accurate(?:ly)?|accuracy|production-ready|state-of-the-art|validated|safe|safety|cleared|clearance|compliant|approved?)\b/i;

function strings(r: CompileDetail): string[] {
  const f = r.finding;
  return [
    r.summary,
    ...r.labelBasis,
    ...r.reasons.map((x) => x.text),
    ...r.trace.map((t) => t.effect),
    ...f.requiredEvidence.map((x) => x.request),
    ...f.expertReviewFlags.map((x) => x.reason),
    ...f.degraded.map((x) => x.reason),
    ...f.mechanicalCoverage.map((m) => describeAssessment(m)),
  ];
}

describe("plain-language text", () => {
  it("uses none of the banned words in anything a reader sees, across generated worlds", () => {
    fc.assert(
      fc.property(arbScope, arbChoices, arbChoices, fc.boolean(), (E, c1, c2, wide) => {
        const use = wide ? grow(shrink(E, c1), c2) : shrink(E, c1);
        const r = compileDetailed(claim(use as Record<string, unknown>), [auth(E as Record<string, unknown>), study(E as Record<string, unknown>), vendor(), requirement(false)]);
        for (const s of strings(r)) expect(s, s).not.toMatch(BANNED);
      }),
      { numRuns: 300 },
    );
  });

  it("uses none of them in the rule registry or in the explanations of unimplemented rules", () => {
    for (const rule of RULES) for (const s of [rule.name, rule.summary, ...rule.citations]) expect(s, rule.id).not.toMatch(BANNED);
    for (const s of Object.values(UNIMPLEMENTED_REGISTRY_RULES)) expect(s).not.toMatch(BANNED);
  });

  it("gives every relation of every dimension a sentence that names the dimension and both sides", () => {
    for (const dimension of DIMENSIONS) {
      for (const relation of RELATIONS) {
        const text = describeAssessment({ dimension, relation, claimed: "CLAIM-SIDE", established: "EVIDENCE-SIDE" });
        expect(text.length).toBeGreaterThan(30);
        expect(text).not.toMatch(BANNED);
        if (relation !== "UNKNOWN") {
          expect(text).toMatch(/CLAIM-SIDE/);
          expect(text).toMatch(/EVIDENCE-SIDE/);
        }
      }
    }
    expect(describeAssessment({ dimension: "setting", relation: "UNKNOWN" })).toMatch(/The claim does not state it\. No evidence record in use states it\./);
  });

  it("explains a finding without recomputing it: the sentences come from the stored finding alone", () => {
    const r = compileDetailed(claim({ versions: ["2.2.0"] }), [auth(), study()]);
    const stored = JSON.parse(JSON.stringify(r.finding)) as typeof r.finding;
    const sentences = stored.mechanicalCoverage.map((m) => describeAssessment(m));
    expect(sentences.find((s) => s.startsWith("Software version"))).toMatch(/claim asks for 2\.2\.0/);
    expect(sentences.find((s) => s.startsWith("Product"))).toMatch(/lies inside/);
  });

  it("never gives clinical advice: no instruction to treat, withhold, deploy or stop", () => {
    const advice = /\b(you should|we recommend|do not use|stop using|deploy it|start treating|prescribe|diagnose the patient)\b/i;
    fc.assert(
      fc.property(arbScope, arbChoices, (E, c) => {
        const r = compileDetailed(claim(shrink(E, c) as Record<string, unknown>), [auth(E as Record<string, unknown>), study(E as Record<string, unknown>, [GOOD_RESULT])]);
        for (const s of strings(r)) expect(s).not.toMatch(advice);
      }),
      { numRuns: 200 },
    );
  });

  it("states every request as something to obtain: from the vendor, or a statement for the claim author or the reviewer", () => {
    const r = compileDetailed(claim({ versions: ["9.9"], settings: ["hospital"], purpose: "diagnosis", population: undefined, timing: undefined }), [auth(), study()]);
    expect(r.finding.requiredEvidence.length).toBeGreaterThanOrEqual(4);
    for (const x of r.finding.requiredEvidence) expect(x.request).toMatch(/^(From the vendor:|State the |A reviewer must )/);
  });
});
