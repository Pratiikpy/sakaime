import { describe, expect, it } from "vitest";
import { compileDetailed, CompilerInputError, type CompileOptions } from "../../src/compiler/index.ts";
import { ASSERTION_TYPES, type AssertionType, type EvidenceItem, type SourceHealth } from "../../src/schemas/index.ts";
import { auth, claim, requirement, study, vendor } from "./fixtures.ts";

const LOST: SourceHealth[] = ["UNAVAILABLE", "FORBIDDEN", "BLOCKED", "DRIFTED", "STALE"];
const base = (): { evidence: EvidenceItem[] } => ({ evidence: [auth(), study()] });
const run = (evidence: EvidenceItem[], options: CompileOptions, c = claim()) => compileDetailed(c, evidence, options);
const code = (reason: string) => reason.split(":")[0];

describe("source-off drills for a required type (T6, C-08, FR-4)", () => {
  for (const type of ["authorization", "study"] as const) {
    for (const health of LOST) {
      it(`${type} ${health}: never SUPPORTED, INSUFFICIENT_EVIDENCE with a degraded entry naming the reason`, () => {
        const r = run(base().evidence, { sourceHealth: { [type]: health } });
        expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
        const entry = r.finding.degraded.find((d) => d.sourceType === type);
        expect(entry).toMatchObject({ dependency: "required" });
        expect(code(entry!.reason)).toBe(health);
        expect(r.trace.some((t) => t.ruleId === "SAK-SOURCE-LOSS")).toBe(true);
      });
    }
  }

  it("does not read the records of a lost source, so coverage shows what can no longer be established", () => {
    const r = run(base().evidence, { sourceHealth: { study: "UNAVAILABLE" } });
    expect(r.finding.mechanicalCoverage.find((m) => m.dimension === "metric")!.relation).toBe("UNKNOWN");
    expect(r.finding.dependsOnFacts).toEqual(["auth-1"]);
  });

  it("keeps outage, empty and never-consulted distinct", () => {
    const outage = run(base().evidence, { sourceHealth: { study: "UNAVAILABLE" } }).finding.degraded[0]!;
    const empty = run([auth()], { sourceHealth: { study: { health: "EMPTY", sourceId: "ctgov", checkedOn: "2026-10-27" } } }).finding.degraded[0]!;
    const never = run([auth()], {}).finding.degraded[0]!;
    expect([code(outage.reason), code(empty.reason), code(never.reason)]).toEqual(["UNAVAILABLE", "EMPTY", "NOT_SUPPLIED"]);
    expect(empty.reason).toMatch(/none found in source ctgov on 2026-10-27/);
    expect(empty.reason).toMatch(/not about whether such evidence exists/);
    expect(never.reason).toMatch(/not an outage and not an empty search/);
  });

  it("cannot be supported by a required type that is EMPTY, even when records of that type are supplied", () => {
    const r = run(base().evidence, { sourceHealth: { study: "EMPTY" } });
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.degraded[0]!.reason).toMatch(/1 supplied study record\(s\) were not read/);
  });

  it("is INSUFFICIENT_EVIDENCE when a required type was simply never supplied", () => {
    expect(run([auth()], {}).finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(run([study()], {}).finding.label).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("reports both entries, in type order, when both required sources are lost", () => {
    const r = run(base().evidence, { sourceHealth: { study: "BLOCKED", authorization: "FORBIDDEN" } });
    expect(r.finding.degraded.map((d) => d.sourceType)).toEqual(["authorization", "study"]);
  });

  it("takes a narrower-scope conclusion away as well: it rests on the same lost evidence", () => {
    const r = run(base().evidence, { sourceHealth: { study: "UNAVAILABLE" } }, claim({ versions: ["2.1.0", "2.2.0"] }));
    expect(r.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.finding.supportedScope).toBeUndefined();
  });

  it("still reports a contradiction from the sources that remain", () => {
    const pop = { age: { min: 22 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] };
    const r = run([auth({ population: pop }), study({ population: pop })], { sourceHealth: { study: "UNAVAILABLE" } });
    expect(r.finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(r.finding.degraded.map((d) => d.sourceType)).toEqual(["study"]);
  });

  it("treats an explicit OK like no report", () => {
    const r = run(base().evidence, { sourceHealth: { authorization: "OK", study: { health: "OK", sourceId: "ctgov" } } });
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.finding.degraded).toEqual([]);
  });
});

describe("a corroborating type (FR-4)", () => {
  const deps = { required: ["authorization"], corroborating: ["study"] };
  const noPerf = () => claim({}, null, { dependencies: deps });

  it("keeps the label when the corroborating source is lost, empty or absent, and records the loss", () => {
    const withAll = run(base().evidence, {}, noPerf()).finding;
    expect(withAll.label).toBe("SUPPORTED_FOR_SCOPE");
    for (const health of [...LOST, "EMPTY" as const]) {
      const r = run(base().evidence, { sourceHealth: { study: health } }, noPerf());
      expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
      expect(r.finding.degraded).toEqual([{ sourceType: "study", dependency: "corroborating", reason: expect.stringMatching(new RegExp(`^${health}:`)) }]);
    }
    const absent = run([auth()], {}, noPerf());
    expect(absent.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(absent.finding.degraded[0]).toMatchObject({ sourceType: "study", dependency: "corroborating" });
    expect(code(absent.finding.degraded[0]!.reason)).toBe("NOT_SUPPLIED");
  });

  it("does not let a corroborating study narrow the label while it is present", () => {
    const narrowStudy = study({ settings: ["primary_care"] });
    expect(run([auth(), narrowStudy], {}, noPerf()).finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });
});

describe("a type the claim does not mention", () => {
  it("records an outage as optional and leaves the label alone", () => {
    const r = run([...base().evidence, vendor()], { sourceHealth: { vendor: "UNAVAILABLE", requirement: "STALE" } });
    expect(r.finding.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.finding.degraded.map((d) => `${d.sourceType}:${d.dependency}:${code(d.reason)}`)).toEqual(["requirement:optional:STALE", "vendor:optional:UNAVAILABLE"]);
  });

  it("does not list an unmentioned type as degraded just because nothing was supplied", () => {
    expect(run(base().evidence, {}).finding.degraded).toEqual([]);
  });
});

describe("every evidence type, every state", () => {
  const evidenceFor = (): EvidenceItem[] => [auth(), study(), vendor(), requirement(true)];
  for (const type of ASSERTION_TYPES) {
    for (const health of [...LOST, "EMPTY" as const]) {
      it(`${type} declared required and ${health}: label is not supported`, () => {
        const deps = { required: [...new Set<AssertionType>(["authorization", "study", type])], corroborating: [] };
        const r = compileDetailed(claim({}, undefined, { dependencies: deps }), evidenceFor(), { sourceHealth: { [type]: health } });
        expect(["SUPPORTED_FOR_SCOPE", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE"]).not.toContain(r.finding.label);
        expect(r.finding.degraded.find((d) => d.sourceType === type)).toMatchObject({ dependency: "required" });
      });
    }
  }
});

describe("source health input", () => {
  it("rejects a state outside the closed set and a type that does not exist", () => {
    expect(() => run(base().evidence, { sourceHealth: { study: "MAYBE" as unknown as SourceHealth } })).toThrow(CompilerInputError);
    expect(() => run(base().evidence, { sourceHealth: { oracle: "OK" } as unknown as CompileOptions["sourceHealth"] })).toThrow(CompilerInputError);
    expect(() => run(base().evidence, { sourceHealth: { study: { health: "EMPTY", checkedOn: "2026-02-31" } } })).toThrow(/not a calendar date/);
  });
});
