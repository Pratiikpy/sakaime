import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CONDITION_SYNONYMS, NARROWING_MODIFIERS, compile, compileDetailed, normCondition, relateCondition } from "../../src/compiler/index.ts";
import { auth, claim, study } from "./fixtures.ts";

/** Raise COMPILER_PROP_RUNS for a longer soak. */
const RUNS = { numRuns: Number(process.env["COMPILER_PROP_RUNS"] ?? 400) };

const BOTH = { dependencies: { required: ["authorization", "study"], corroborating: [] } };

describe("condition phrases: normal form", () => {
  it("ignores case, punctuation, plural endings, articles and parenthesised abbreviations", () => {
    expect(normCondition("Pleural Effusion;")).toBe(normCondition("pleural effusions"));
    expect(normCondition("a Colorectal  Polyp.")).toBe(normCondition("colorectal polyps"));
    expect(normCondition("Intra-abdominal free gas (IFG) pathologies")).toBe(normCondition("intra abdominal free gas pathology"));
  });

  it("rewrites a curated synonym to its preferred wording, whole words only", () => {
    expect(normCondition("diabetes")).toBe("diabetes mellitus");
    expect(normCondition("adults diagnosed with diabetes")).toBe("adult diagnosed with diabetes mellitus");
    expect(normCondition("diabetes mellitus")).toBe("diabetes mellitus");
    expect(normCondition("LVO")).toBe("large vessel occlusion");
  });

  it("never rewrites a different condition that shares the word: diabetes insipidus stays diabetes insipidus", () => {
    expect(normCondition("diabetes insipidus")).toBe("diabetes insipidus");
    expect(relateCondition(normCondition("diabetes insipidus"), normCondition("diabetes mellitus"))).toBe("related");
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 60 }), (raw) => {
        const once = normCondition(raw);
        expect(normCondition(once)).toBe(once);
      }),
      RUNS,
    );
    for (const e of CONDITION_SYNONYMS) for (const v of [e.canonical, ...e.variants]) expect(normCondition(normCondition(v))).toBe(normCondition(v));
  });

  it("gives every synonym entry a source and every variant one canonical wording", () => {
    for (const e of CONDITION_SYNONYMS) {
      expect(e.source.length, e.canonical).toBeGreaterThan(20);
      for (const v of e.variants) expect(normCondition(v), `${v} -> ${e.canonical}`).toBe(normCondition(e.canonical));
    }
  });
});

describe("condition phrases: placing two phrases", () => {
  const rel = (a: string, b: string) => relateCondition(normCondition(a), normCondition(b));

  it("equal after normalisation", () => {
    expect(rel("Diabetes", "diabetes mellitus")).toBe("equal");
    expect(rel("pleural effusions", "Pleural effusion")).toBe("equal");
  });

  it("a subtype with a closed-list modifier is narrower; any other modifier is not placed", () => {
    expect(rel("type 2 diabetes mellitus", "diabetes mellitus")).toBe("narrower");
    expect(rel("mild diabetic retinopathy", "diabetic retinopathy")).toBe("narrower");
    expect(rel("severe acute pleural effusion", "pleural effusion")).toBe("narrower");
    for (const modifier of ["pre", "non", "suspected", "gestational", "history of", "no"]) {
      expect(["related", "unrelated"], modifier).toContain(rel(`${modifier} diabetic retinopathy`, "diabetic retinopathy"));
    }
  });

  it("the broader phrase is never narrower than the subtype", () => {
    expect(rel("diabetes mellitus", "type 2 diabetes mellitus")).toBe("related");
  });

  it("phrases that share only generic words are unrelated; phrases that share a content word and were not placed are related", () => {
    expect(rel("adults at risk for heart failure", "adults with diabetes")).toBe("unrelated");
    expect(rel("pleural effusion", "pneumothorax")).toBe("unrelated");
    expect(rel("women undergoing screening mammography", "women undergoing screening mammography and digital breast tomosynthesis")).toBe("related");
    expect(rel("diabetic retinopathy", "previously diagnosed with diabetic retinopathy")).toBe("related");
  });

  it("past-diagnosis wordings are one history, compared on what it is a history of", () => {
    expect(normCondition("previously diagnosed with more than mild diabetic retinopathy")).toBe(normCondition("a history of more than mild diabetic retinopathy"));
    expect(rel("prior mild diabetic retinopathy", "previously diagnosed with diabetic retinopathy")).toBe("narrower");
    expect(rel("previously diagnosed with diabetic retinopathy", "prior mild diabetic retinopathy")).toBe("related");
    // a current diagnosis is not a history
    expect(normCondition("diagnosed with diabetic retinopathy")).not.toMatch(/^history of/);
  });

  it("the closed list holds only modifiers that narrow", () => {
    for (const w of NARROWING_MODIFIERS) expect(["pre", "non", "no", "not", "without", "suspected", "history", "risk"]).not.toContain(w);
  });
});

describe("conditions in a finding", () => {
  const withConditions = (c: string[], e: string[], extra: Record<string, unknown> = {}) =>
    compile(claim({ population: { age: { min: 18 }, conditions: c, ...extra } }, null, BOTH), [
      auth({ population: { age: { min: 18 }, conditions: e } }),
      study({ population: { age: { min: 18 }, conditions: e } }, []),
    ]);

  it("covers a claimed condition worded differently from the evidence when the closed rules place it", () => {
    expect(withConditions(["diabetes"], ["Diabetes Mellitus"]).label).toBe("SUPPORTED_FOR_SCOPE");
    expect(withConditions(["type 2 diabetes mellitus"], ["diabetes mellitus"]).label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("sends a wording it cannot place to review, never to SUPPORTED, and names the term", () => {
    const f = withConditions(["gestational diabetes mellitus"], ["diabetes mellitus"]);
    expect(f.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(f.expertReviewFlags.map((x) => x.ruleId)).toContain("SAK-UNPLACED-CONDITION");
    expect(f.expertReviewFlags.find((x) => x.ruleId === "SAK-UNPLACED-CONDITION")!.reason).toMatch(/gestational diabetes mellitus/);
  });

  it("a condition that shares nothing with the evidence is simply not covered", () => {
    expect(withConditions(["tuberculosis"], ["pleural effusion"]).label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("a claim broader than the evidence is not supported", () => {
    expect(withConditions(["diabetes mellitus"], ["type 2 diabetes mellitus"]).label).not.toMatch(/^SUPPORTED/);
  });

  it("an exclusion worded differently is placed the same way", () => {
    const ev = [
      auth({ population: { age: { min: 18 }, conditions: ["diabetes mellitus"], exclusions: ["previously diagnosed with more than mild diabetic retinopathy"] } }),
      study({ population: { age: { min: 18 }, conditions: ["diabetes mellitus"] } }, []),
    ];
    const exact = compile(claim({ population: { age: { min: 18 }, conditions: ["diabetes"], exclusions: ["Previously diagnosed with more than mild diabetic retinopathy."] } }, null, BOTH), ev);
    expect(exact.label).toBe("SUPPORTED_FOR_SCOPE");
    const reworded = compile(claim({ population: { age: { min: 18 }, conditions: ["diabetes"], exclusions: ["more than mild diabetic retinopathy"] } }, null, BOTH), ev);
    expect(reworded.label).toBe("REQUIRES_DOMAIN_REVIEW");
  });

  it("a claimed condition the authorization record excludes, in a different spelling, still contradicts the claim", () => {
    const ev = [
      auth({ population: { age: { min: 18 }, conditions: ["adults at risk for heart failure"], exclusions: ["Paced Rhythms"] } }),
      study({ population: { age: { min: 18 }, conditions: ["adults at risk for heart failure"] } }, []),
    ];
    const f = compile(claim({ population: { age: { min: 18 }, conditions: ["adults at risk for heart failure", "paced rhythm"] } }, null, BOTH), ev);
    expect(f.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });

  it("a claimed condition that is also a study exclusion is a narrower scope, and the narrower scope keeps it excluded (no CompilerInvariantError)", () => {
    const f = compile(claim({ population: { age: { min: 18 }, conditions: ["adults at risk for heart failure", "paced rhythm"] } }, null, BOTH), [
      auth({ population: { age: { min: 18 }, conditions: ["adults at risk for heart failure"] } }),
      study({ population: { age: { min: 18 }, conditions: ["adults at risk for heart failure"], exclusions: ["paced rhythm"] } }, []),
    ]);
    expect(f.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(f.supportedScope).toMatchObject({ population: { exclusions: ["paced rhythm"] } });
  });

  it("two layers that word the target condition differently are not intersected away: the claim goes to review", () => {
    const f = compile(claim({ population: { conditions: ["women undergoing screening mammography"] } }, null, BOTH), [
      auth({ population: { conditions: ["women undergoing screening mammography and digital breast tomosynthesis"] } }),
      study({ population: { conditions: ["breast cancer"] } }, []),
    ]);
    expect(f.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(f.expertReviewFlags.map((x) => x.ruleId)).toContain("SAK-UNPLACED-CONDITION");
  });

  it("explains the placement in the reasons", () => {
    const d = compileDetailed(claim({ population: { age: { min: 18 }, conditions: ["gestational diabetes mellitus"] } }, null, BOTH), [auth(), study({}, [])]);
    expect(d.reasons.find((r) => r.dimension === "population")!.text).toMatch(/cannot be placed/);
  });
});
