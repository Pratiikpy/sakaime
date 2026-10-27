import { describe, expect, it } from "vitest";
import { CompilerInputError, RuleVersionMismatchError, compile, compileDetailed } from "../../src/compiler/index.ts";
import { LABELS } from "../../src/schemas/index.ts";
import { auth, claim, study } from "./fixtures.ts";

const ok = [auth(), study()];
const rejects = (c: unknown, e: unknown = ok, o?: object) => {
  try {
    compile(c, e, o);
  } catch (err) {
    expect(err).toBeInstanceOf(CompilerInputError);
    return (err as CompilerInputError).issues.join(" | ");
  }
  throw new Error("expected the input to be rejected");
};

describe("junk input is rejected by the schema, never answered with a label", () => {
  it("rejects a claim that is not an object, has no id, or states a use of the wrong shape", () => {
    expect(rejects(null)).toMatch(/claim/);
    expect(rejects(undefined)).toMatch(/claim/);
    expect(rejects("a claim")).toMatch(/claim/);
    expect(rejects({ use: {} })).toMatch(/claim\.id/);
    expect(rejects({ id: "", use: {} })).toMatch(/claim\.id/);
    expect(rejects({ id: "c" })).toMatch(/claim\.use/);
    expect(rejects({ id: "c", use: { settings: "ED" } })).toMatch(/claim\.use\.settings/);
    expect(rejects({ id: "c", use: { versions: [1.7] } })).toMatch(/claim\.use\.versions/);
    expect(rejects({ id: "c", use: { product: "" } })).toMatch(/claim\.use\.product/);
  });

  it("rejects an inverted age range, a negative age and a malformed date", () => {
    expect(rejects(claim({ population: { age: { min: 60, max: 20 } } }))).toMatch(/min must not exceed max/);
    expect(rejects(claim({ population: { age: { min: -1 } } }))).toMatch(/population/);
    expect(rejects(claim({ timing: { from: "27/10/2026" } }))).toMatch(/YYYY-MM-DD/);
  });

  it("rejects dates the pattern allows but the calendar does not", () => {
    expect(rejects(claim({ timing: { from: "2026-02-31" } }))).toMatch(/not a calendar date/);
    expect(rejects(claim({ timing: { from: "2026-13-01" } }))).toMatch(/not a calendar date/);
    expect(rejects(claim(), [auth({ timing: { from: "2026-00-10" } }), study()])).toMatch(/evidence\[0\]\.scope\.timing\.from/);
  });

  it("rejects a period that ends before it starts, on either side", () => {
    expect(rejects(claim({ timing: { from: "2027-01-01", to: "2026-01-01" } }))).toMatch(/from is after to/);
    expect(rejects(claim(), [auth({ timing: { from: "2025-01-01", to: "2020-01-01" } }), study()])).toMatch(/from is after to/);
  });

  it("rejects numbers that are not finite", () => {
    expect(rejects(claim({}, { metric: "sensitivity", atLeast: Infinity }))).toMatch(/not finite/);
    expect(rejects(claim({}, { metric: "sensitivity", atLeast: Number.NaN }))).toMatch(/claim\.performance\.atLeast/);
    expect(rejects(claim(), [auth(), study({}, [{ metric: "sensitivity", value: Infinity }])])).toMatch(/not finite/);
    expect(rejects(claim({ population: { age: { min: Infinity } } }))).toMatch(/not finite/);
  });

  it("rejects an interval that is inverted or does not contain its own point estimate", () => {
    expect(rejects(claim(), [auth(), study({}, [{ metric: "sensitivity", value: 0.9, ci: [0.95, 0.85] }])])).toMatch(/lower bound exceeds upper bound/);
    expect(rejects(claim(), [auth(), study({}, [{ metric: "sensitivity", value: 0.99, ci: [0.8, 0.9] }])])).toMatch(/outside its own interval/);
  });

  it("rejects evidence that is not a list of valid items, or that repeats an id", () => {
    expect(rejects(claim(), "evidence")).toMatch(/evidence/);
    expect(rejects(claim(), [{ id: "x" }])).toMatch(/evidence\[0\]/);
    expect(rejects(claim(), [{ ...auth(), assertionType: "press release" }])).toMatch(/assertionType/);
    expect(rejects(claim(), [auth({}, { id: "dup" }), study({}, undefined, { id: "dup" })])).toMatch(/duplicate evidence id "dup"/);
    expect(rejects(claim(), [auth({}, { results: [{ metric: "", value: 1 }] }), study()])).toMatch(/metric/);
  });

  it("collects every problem in one error instead of stopping at the first", () => {
    const issues = rejects({ id: "", use: { timing: { from: "2026-02-31" } } }, [{ id: "x" }]);
    expect(issues.split(" | ").length).toBeGreaterThan(2);
  });

  it("rejects options it does not know, a disposition outside the closed set, and duplicate dispositions", () => {
    expect(rejects(claim(), ok, { colour: "red" })).toMatch(/options/);
    expect(rejects(claim(), ok, { dispositions: [{ evidenceId: "s", relevance: "irrelevant" }] })).toMatch(/options\.dispositions/);
    expect(rejects(claim(), ok, { policy: { stalenessWindowDays: -5 } })).toMatch(/options\.policy/);
    expect(rejects(claim(), ok, { policy: { stalenessWindowDays: 1.5 } })).toMatch(/options\.policy/);
    expect(rejects(claim(), ok, { computedAt: "yesterday" })).toMatch(/options\.computedAt/);
    expect(rejects(claim(), ok, { requiredDimensions: ["colour"] })).toMatch(/options\.requiredDimensions/);
  });

  it("never reaches a label on rejection: the result is an exception, not a Finding", () => {
    for (const bad of [null, {}, { id: "c" }, { id: "c", use: 5 }]) {
      expect(() => compile(bad, ok)).toThrow(CompilerInputError);
    }
  });
});

describe("taxonomies as data", () => {
  const nodes = { a: { label: "a" }, b: { label: "b", parent: "a" } };

  it("rejects a taxonomy with a missing parent, a cycle, a bad alias or an unnormalised key", () => {
    const bad = (t: object) => rejects(claim(), ok, { taxonomies: { settings: { id: "t", version: "1", ...t } } });
    expect(bad({ nodes: { a: { label: "a", parent: "ghost" } } })).toMatch(/is not a node/);
    expect(bad({ nodes: { a: { label: "a", parent: "b" }, b: { label: "b", parent: "a" } } })).toMatch(/cycle/);
    expect(bad({ nodes, aliases: { x: "ghost" } })).toMatch(/unknown node/);
    expect(bad({ nodes, aliases: { a: "b" } })).toMatch(/shadows a node key/);
    expect(bad({ nodes: { "Not Normal": { label: "x" } } })).toMatch(/normalised form/);
  });

  it("changes the rule version, and so the finding id, when a taxonomy changes", () => {
    const base = compile(claim(), ok);
    const custom = compile(claim(), ok, { taxonomies: { purposes: { id: "sakaime-purposes", version: "2", nodes: { detection_aid: { label: "detection aid" }, triage_notification: { label: "triage", parent: "detection_aid" }, diagnosis: { label: "diagnosis" } } } } });
    expect(base.ruleVersion).toMatch(/sakaime-purposes@1/);
    expect(custom.ruleVersion).toMatch(/sakaime-purposes@2/);
    expect(custom.id).not.toBe(base.id);
  });

  it("applies a custom hierarchy, so a purpose order is data and not code", () => {
    const flipped = { id: "flipped", version: "1", nodes: { diagnosis: { label: "diagnosis", parent: "detection_aid" }, detection_aid: { label: "detection aid" } } };
    const f = compile(claim({ purpose: "diagnosis" }), ok, { taxonomies: { purposes: flipped } });
    expect(f.mechanicalCoverage.find((m) => m.dimension === "purpose")!.relation).toBe("CONTAINED");
  });
});

describe("rule version guard", () => {
  it("replays under the version it implements and refuses another", () => {
    const f = compile(claim(), ok);
    expect(compile(claim(), ok, { expectedRuleVersion: f.ruleVersion }).id).toBe(f.id);
    expect(() => compile(claim(), ok, { expectedRuleVersion: "sakaime-compiler@0.9.0+old" })).toThrow(RuleVersionMismatchError);
  });

  it("stamps the rule version on every finding, whatever the label", () => {
    for (const evidence of [ok, [], [auth()]]) {
      const f = compile(claim(), evidence);
      expect(LABELS).toContain(f.label);
      expect(f.ruleVersion).toMatch(/^sakaime-compiler@\d+\.\d+\.\d+\+/);
    }
  });
});

describe("empty and sparse input", () => {
  it("an empty evidence set is INSUFFICIENT_EVIDENCE with every required dimension unknown", () => {
    const r = compileDetailed(claim(), []);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.mechanicalCoverage.every((m) => m.relation === "UNKNOWN")).toBe(true);
    expect(r.finding.mismatches.map((m) => m.dimension)).toEqual(["product", "version", "population", "setting", "purpose", "timing", "metric"]);
    expect(r.finding.degraded.map((d) => d.reason.split(":")[0])).toEqual(["NOT_SUPPLIED", "NOT_SUPPLIED"]);
    expect(r.finding.dependsOnFacts).toEqual([]);
  });

  it("an empty claim use is INSUFFICIENT_EVIDENCE, never supported by being vacuous", () => {
    const r = compileDetailed({ id: "c", use: {} }, ok);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.mechanicalCoverage.filter((m) => m.dimension !== "metric").every((m) => m.relation === "UNKNOWN")).toBe(true);
  });

  it("evidence items with empty scopes establish nothing", () => {
    const empty = (id: string, assertionType: "authorization" | "study") => ({ id, assertionType, scope: {}, results: [], limitations: [], anchorIds: [] });
    const r = compileDetailed(claim(), [empty("a", "authorization"), empty("s", "study")]);
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.mechanicalCoverage.every((m) => m.relation === "UNKNOWN")).toBe(true);
  });

  it("a claim may require no dimension at all, and then only the sources decide", () => {
    const r = compileDetailed({ id: "c", use: {} }, ok, { requiredDimensions: [] });
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.finding.mismatches).toEqual([]);
  });

  it("states the performance as required even when the caller leaves metric out of requiredDimensions", () => {
    const r = compileDetailed(claim({}, { metric: "sensitivity", atLeast: 0.99 }), ok, { requiredDimensions: ["product"] });
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });
});
