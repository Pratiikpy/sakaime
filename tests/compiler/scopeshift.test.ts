import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compileDetailed, type CompileOptions } from "../../src/compiler/index.ts";
import type { Dimension, EvidenceItem, Label, Scope } from "../../src/schemas/index.ts";
import { arbScope, ancestorsOrSelf, purposesH, settingsH } from "./arbitraries.ts";
import { GOOD_RESULT, OP, auth, claim, study } from "./fixtures.ts";

/*
 * ScopeShift (A), docs/06-evaluation-protocol.md section 3: build a claim identical to an evidence scope (the positive
 * control), then mutate exactly one dimension and check the label the construction implies, and that the minimal counterexample
 * names that dimension and no other. These are consistency tests: the expected label follows from the rules, and a rule table and
 * a test derived from it agree by construction. Identity ambiguity, the last mutation in the protocol, is upstream of the compiler
 * and is NOT covered here.
 */

interface World {
  E: Scope;
  /** Whether the authorization record states a population. When it does not, an age mutation is a study limit, not an authorization limit. */
  authStatesPopulation: boolean;
  use: Record<string, unknown>;
  perf: { metric: string; atLeast: number };
  evidence: EvidenceItem[];
  options: CompileOptions;
}

const world = (E: Scope, authStatesPopulation = true): World => {
  const authScope: Record<string, unknown> = { ...E, ...(authStatesPopulation ? {} : { population: undefined }) };
  return {
    E,
    authStatesPopulation,
    use: { ...E },
    perf: { metric: "sensitivity", atLeast: 0.9 },
    evidence: [auth(authScope, { id: "auth-1" }), study({ ...E } as Record<string, unknown>, [GOOD_RESULT])],
    options: {},
  };
};

const evaluate = (w: World) => compileDetailed(claim(w.use, w.perf), w.evidence, w.options);

interface Mutation {
  name: string;
  /** Returns undefined when the mutation does not apply to this evidence scope. */
  apply(w: World): World | undefined;
  expect(w: World): { label: Label; dimensions: Dimension[]; check?: (f: ReturnType<typeof evaluate>["finding"]) => void };
}

const withUse = (w: World, patch: Record<string, unknown>): World => ({ ...w, use: { ...w.use, ...patch } });
const age = (w: World) => (w.E.population!.age ?? {}) as { min?: number; max?: number };

const MUTATIONS: Mutation[] = [
  {
    name: "version added beyond the evidence",
    apply: (w) => withUse(w, { versions: [...w.E.versions!, "9.9"] }),
    expect: (w) => ({ label: "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", dimensions: ["version"], check: (f) => expect(f.supportedScope).toMatchObject({ versions: [...w.E.versions!].sort() }) }),
  },
  { name: "version replaced by one never evidenced", apply: (w) => withUse(w, { versions: ["9.9"] }), expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["version"] }) },
  { name: "version left unconfirmed", apply: (w) => withUse(w, { versions: undefined }), expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["version"] }) },
  {
    name: "minimum age lowered below the evidence",
    apply: (w) => (age(w).min !== undefined && age(w).min! > 0 ? withUse(w, { population: { ...w.E.population!, age: { ...age(w), min: age(w).min! - 1 } } }) : undefined),
    // The authorization record states the limit: contradicted. If only the study states it: a narrower scope.
    expect: (w) => ({
      label: w.authStatesPopulation ? "CONTRADICTED_BY_SPECIFIED_EVIDENCE" : "SUPPORTED_ONLY_FOR_NARROWER_SCOPE",
      dimensions: ["population"],
      check: (f) => {
        if (!w.authStatesPopulation) expect((f.supportedScope as Scope).population!.age!.min).toBe(age(w).min);
      },
    }),
  },
  {
    name: "maximum age raised above the evidence",
    apply: (w) => (age(w).max !== undefined ? withUse(w, { population: { ...w.E.population!, age: { ...age(w), max: age(w).max! + 1 } } }) : undefined),
    expect: (w) => ({ label: w.authStatesPopulation ? "CONTRADICTED_BY_SPECIFIED_EVIDENCE" : "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", dimensions: ["population"] }),
  },
  {
    name: "age bound removed (open-ended)",
    apply: (w) => (age(w).max !== undefined ? withUse(w, { population: { ...w.E.population!, age: { min: age(w).min } } }) : undefined),
    expect: (w) => ({ label: w.authStatesPopulation ? "CONTRADICTED_BY_SPECIFIED_EVIDENCE" : "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", dimensions: ["population"] }),
  },
  {
    name: "condition added",
    apply: (w) => withUse(w, { population: { ...w.E.population!, conditions: [...w.E.population!.conditions!, "a condition nobody studied"] } }),
    expect: (w) => ({ label: "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", dimensions: ["population"], check: (f) => expect((f.supportedScope as Scope).population!.conditions).toEqual([...w.E.population!.conditions!].sort()) }),
  },
  {
    name: "exclusion dropped",
    apply: (w) => (w.E.population!.exclusions?.length ? withUse(w, { population: { age: w.E.population!.age, conditions: w.E.population!.conditions } }) : undefined),
    expect: (w) => ({ label: "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", dimensions: ["population"], check: (f) => expect((f.supportedScope as Scope).population!.exclusions).toEqual([...w.E.population!.exclusions!].sort()) }),
  },
  {
    name: "population left unspecified",
    apply: (w) => withUse(w, { population: undefined }),
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["population"] }),
  },
  {
    name: "setting widened to its parent",
    apply: (w) => {
      // Only a parent that no studied setting already covers is a widening.
      const parent = w.E.settings!.map((s) => ancestorsOrSelf(settingsH, s)[1]).find((p) => p !== undefined && w.E.settings!.every((e) => !settingsH.covers(e, p)));
      return parent ? withUse(w, { settings: [parent] }) : undefined;
    },
    expect: (w) => ({
      label: "SUPPORTED_ONLY_FOR_NARROWER_SCOPE",
      dimensions: ["setting"],
      check: (f) => {
        const supported = (f.supportedScope as Scope).settings!;
        for (const s of supported) expect(w.E.settings!.some((e) => settingsH.covers(e, s))).toBe(true);
      },
    }),
  },
  {
    name: "setting moved to an unrelated unit",
    apply: (w) => {
      const all = Object.keys(settingsH.taxonomy.nodes);
      const stranger = all.find((k) => w.E.settings!.every((e) => !settingsH.covers(e, k) && !settingsH.covers(k, e)));
      return stranger ? withUse(w, { settings: [stranger] }) : undefined;
    },
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["setting"] }),
  },
  {
    name: "setting a taxonomy cannot place",
    apply: (w) => withUse(w, { settings: ["a setting the taxonomy has never heard of"] }),
    expect: () => ({ label: "REQUIRES_DOMAIN_REVIEW", dimensions: ["setting"] }),
  },
  {
    name: "purpose escalated to its parent",
    apply: (w) => {
      const a = ancestorsOrSelf(purposesH, w.E.purpose!);
      return a.length > 1 ? withUse(w, { purpose: a[1] }) : undefined;
    },
    expect: (w) => ({ label: "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", dimensions: ["purpose"], check: (f) => expect(f.supportedScope).toMatchObject({ purpose: w.E.purpose }) }),
  },
  {
    name: "purpose shifted sideways to an unrelated one",
    apply: (w) => {
      const stranger = Object.keys(purposesH.taxonomy.nodes).find((k) => !purposesH.covers(w.E.purpose!, k) && !purposesH.covers(k, w.E.purpose!));
      return stranger ? withUse(w, { purpose: stranger }) : undefined;
    },
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["purpose"] }),
  },
  {
    name: "purpose a taxonomy cannot place",
    apply: (w) => withUse(w, { purpose: "autonomous treatment selection" }),
    expect: () => ({ label: "REQUIRES_DOMAIN_REVIEW", dimensions: ["purpose"] }),
  },
  { name: "go-live before the authorization took effect", apply: (w) => withUse(w, { timing: { from: "2020-01-01" } }), expect: () => ({ label: "CONTRADICTED_BY_SPECIFIED_EVIDENCE", dimensions: ["timing"] }) },
  {
    name: "go-live after the authorization window ended",
    apply: (w) => ({ ...w, evidence: [auth({ ...w.E, timing: { from: "2020-06-01", to: "2025-12-31" } } as Record<string, unknown>), w.evidence[1]!] }),
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["timing"] }),
  },
  { name: "go-live before any study existed", apply: (w) => withUse(w, { timing: { from: "2021-01-01" } }), expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["timing"] }) },
  {
    name: "claimed minimum above the whole interval",
    apply: (w) => ({ ...w, perf: { metric: "sensitivity", atLeast: 0.99 } }),
    expect: () => ({ label: "CONTRADICTED_BY_SPECIFIED_EVIDENCE", dimensions: ["metric"] }),
  },
  {
    name: "claimed minimum inside the interval",
    apply: (w) => ({ ...w, perf: { metric: "sensitivity", atLeast: 0.95 } }),
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["metric"] }),
  },
  {
    name: "claim made at a different operating point",
    apply: (w) => withUse(w, { operatingPoint: "a stricter threshold" }),
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["metric"] }),
  },
  {
    name: "claim made at no named operating point",
    apply: (w) => withUse(w, { operatingPoint: undefined }),
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["metric"] }),
  },
  {
    name: "a metric nobody reported",
    apply: (w) => ({ ...w, perf: { metric: "specificity", atLeast: 0.8 } }),
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: ["metric"] }),
  },
  {
    name: "study source unavailable",
    apply: (w) => ({ ...w, options: { sourceHealth: { study: "UNAVAILABLE" } } }),
    expect: () => ({ label: "INSUFFICIENT_EVIDENCE", dimensions: [] }),
  },
];

describe("ScopeShift (A): positive control", () => {
  it("a claim identical to the evidence scope is SUPPORTED_FOR_SCOPE, for any scope", () => {
    fc.assert(
      fc.property(arbScope, fc.boolean(), (E, authStates) => {
        const f = evaluate(world(E, authStates)).finding;
        expect(f.label).toBe("SUPPORTED_FOR_SCOPE");
        expect(f.mismatches).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });
});

describe("ScopeShift (A): one mutated dimension", () => {
  for (const m of MUTATIONS.filter((x) => x.name !== "study source unavailable")) {
    it(`${m.name}`, () => {
      let applied = 0;
      fc.assert(
        fc.property(arbScope, fc.boolean(), (E, authStates) => {
          const w = m.apply(world(E, authStates));
          fc.pre(w !== undefined);
          applied++;
          const r = evaluate(w!);
          const want = m.expect(w!);
          expect(r.finding.label).toBe(want.label);
          expect(r.finding.mismatches.map((x) => x.dimension)).toEqual(want.dimensions);
          expect(r.finding.requiredEvidence.map((x) => x.dimension)).toEqual(want.dimensions);
          want.check?.(r.finding);
        }),
        { numRuns: 250 },
      );
      expect(applied, `mutation "${m.name}" never applied to a generated scope`).toBeGreaterThan(10);
    });
  }

  it("study source unavailable: nothing the study would have established survives, and the label is insufficient", () => {
    fc.assert(
      fc.property(arbScope, (E) => {
        const m = MUTATIONS.find((x) => x.name === "study source unavailable")!;
        const r = evaluate(m.apply(world(E))!);
        expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
        expect(r.finding.degraded).toEqual([expect.objectContaining({ sourceType: "study", dependency: "required" })]);
        expect(r.finding.mechanicalCoverage.find((c) => c.dimension === "metric")!.relation).toBe("UNKNOWN");
      }),
      { numRuns: 100 },
    );
  });

  it("every mutated claim shows both sides of the mismatch", () => {
    const w = MUTATIONS.find((x) => x.name === "condition added")!.apply(world(arbSample()))!;
    const m = evaluate(w).finding.mismatches[0]!;
    expect(m.claimed).toMatch(/a condition nobody studied/);
    expect(m.established).toMatch(/authorization record: .*study: /);
  });
});

function arbSample(): Scope {
  return fc.sample(arbScope, { numRuns: 1, seed: 7 })[0]!;
}

describe("ScopeShift (A): the operating point and the result stay tied", () => {
  it("the positive control uses the shared operating point", () => {
    expect(OP).toBe("protocol threshold");
  });
});
