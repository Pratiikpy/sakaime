import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compile, compileDetailed, type CompileOptions } from "../../src/compiler/index.ts";
import { ASSERTION_TYPES, FindingSchema, LABELS, SOURCE_HEALTH, type AssertionType, type Dimension, type EvidenceItem, type EvidenceResult, type Finding, type Scope } from "../../src/schemas/index.ts";
import { canonicalJson } from "../../src/util/canonical.ts";
import { arbChoices, arbScope, shrink, grow, PRODUCT } from "./arbitraries.ts";
import { GOOD_RESULT, OP, auth, claim, mutate, study, requirement } from "./fixtures.ts";

/*
 * Property tests of docs/02-architecture.md section 10 item 8 (a) to (f), stated on containment and not on label order.
 * These are engineering-consistency tests: they show the code obeys the invariants it was specified with. They do not
 * show the rules are clinically right (docs/06 section 2, C-09).
 */

const SCOPE_DIMS: Dimension[] = ["product", "version", "population", "setting", "purpose", "timing"];
const contained = (f: Finding, dims: readonly Dimension[] = SCOPE_DIMS) =>
  new Set(f.mechanicalCoverage.filter((m) => dims.includes(m.dimension) && m.relation === "CONTAINED").map((m) => m.dimension));
/** Raise COMPILER_PROP_RUNS for a longer soak. */
const RUNS = { numRuns: Number(process.env["COMPILER_PROP_RUNS"] ?? 400) };

const worldFor = (evidenceScope: Scope, studyScope: Scope, claimScope: Scope): { claim: ReturnType<typeof claim>; evidence: EvidenceItem[] } => ({
  claim: claim(claimScope as Record<string, unknown>),
  evidence: [auth(evidenceScope as Record<string, unknown>), study(studyScope as Record<string, unknown>)],
});

describe("(a) widening a claimed scope can only shrink the set of CONTAINED dimensions", () => {
  it("holds on generated scopes", () => {
    let supported = 0;
    let total = 0;
    fc.assert(
      fc.property(arbScope, arbChoices, arbChoices, arbChoices, fc.boolean(), fc.boolean(), (E, cs, cw, cn, studyShrunk, wideFromEvidence) => {
        const studyScope = studyShrunk ? shrink(E, cs) : E;
        const wide = wideFromEvidence ? shrink(studyScope, cw) : grow(shrink(studyScope, cw), cn);
        const narrow = shrink(wide, cn);
        const w = worldFor(E, studyScope, wide);
        const n = worldFor(E, studyScope, narrow);
        const fw = compile(w.claim, w.evidence);
        const fn = compile(n.claim, n.evidence);
        total++;
        if (fw.label === "SUPPORTED_FOR_SCOPE") supported++;
        const cw_ = contained(fw);
        const cn_ = contained(fn);
        for (const d of cw_) expect(cn_.has(d), `${d} contained for the wider claim but not the narrower`).toBe(true);
      }),
      RUNS,
    );
    expect(supported, `only ${supported} of ${total} wider claims were supported, so the property would be close to vacuous`).toBeGreaterThan(total * 0.1);
  });

  it("also holds when widening means leaving a dimension unspecified", () => {
    fc.assert(
      fc.property(arbScope, arbChoices, fc.constantFrom("versions", "population", "settings", "purpose", "timing"), (E, c, drop) => {
        const stated = shrink(E, c);
        const blank = { ...stated, [drop]: undefined } as Scope;
        const a = compile(claim(stated as Record<string, unknown>), [auth(E as Record<string, unknown>), study(E as Record<string, unknown>)]);
        const b = compile(claim(blank as Record<string, unknown>), [auth(E as Record<string, unknown>), study(E as Record<string, unknown>)]);
        for (const d of contained(b)) expect(contained(a).has(d)).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("(b) SUPPORTED_FOR_SCOPE for a wider scope implies it for each narrower scope inside", () => {
  it("holds on generated scopes, with authorization and study records that differ", () => {
    let supported = 0;
    fc.assert(
      fc.property(arbScope, arbChoices, arbChoices, arbChoices, fc.boolean(), fc.boolean(), (E, cs, cw, cn, studyShrunk, widen) => {
        const studyScope = studyShrunk ? shrink(E, cs) : E;
        const both = shrink(studyScope, cw);
        const wide = widen ? grow(both, cn) : both;
        const narrow = shrink(wide, cn);
        const w = worldFor(E, studyScope, wide);
        const n = worldFor(E, studyScope, narrow);
        const fw = compile(w.claim, w.evidence);
        if (fw.label !== "SUPPORTED_FOR_SCOPE") return;
        supported++;
        expect(compile(n.claim, n.evidence).label).toBe("SUPPORTED_FOR_SCOPE");
      }),
      RUNS,
    );
    expect(supported).toBeGreaterThan(20);
  });

  it("holds with several study records, where support must come from one record that covers the claim", () => {
    fc.assert(
      fc.property(arbScope, arbScope, arbChoices, arbChoices, (E1, E2, c1, c2) => {
        const evidence = [auth(E1 as Record<string, unknown>), study(E1 as Record<string, unknown>), study(E2 as Record<string, unknown>, [GOOD_RESULT], { id: "study-2" })];
        const wide = shrink(E1, c1);
        const narrow = shrink(wide, c2);
        const fw = compile(claim(wide as Record<string, unknown>), evidence);
        if (fw.label !== "SUPPORTED_FOR_SCOPE") return;
        expect(compile(claim(narrow as Record<string, unknown>), evidence).label).toBe("SUPPORTED_FOR_SCOPE");
      }),
      RUNS,
    );
  });
});

describe("(c) a contrary item needs a recorded disposition before SUPPORTED_FOR_SCOPE", () => {
  const contraryResult = (hasCi: boolean): EvidenceResult => ({ metric: "sensitivity", value: 0.6, ...(hasCi ? { ci: [0.5, 0.7] as [number, number] } : {}), n: 100, operatingPoint: OP });
  const arbContrary = fc.record({
    adequate: fc.constantFrom(true, false, undefined),
    offScope: fc.boolean(),
    hasCi: fc.boolean(),
    sameProduct: fc.boolean(),
  });
  const items = (c: { adequate?: boolean; offScope: boolean; hasCi: boolean; sameProduct: boolean }) => [
    auth(),
    study(),
    study(c.offScope ? { versions: ["9.9"] } : {}, [contraryResult(c.hasCi)], { id: "study-2", ...(c.adequate !== undefined ? { adequate: c.adequate } : { adequate: undefined }), ...(c.sameProduct ? {} : {}) }),
  ];

  it("never reaches a supported label without one, and goes to CONTRADICTED only for a relevant, adequate, interval-backed result", () => {
    fc.assert(
      fc.property(arbContrary, (c) => {
        const f = compile(claim(), items(c));
        expect(["SUPPORTED_FOR_SCOPE", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE"]).not.toContain(f.label);
        const mustContradict = !c.offScope && c.adequate === true && c.hasCi;
        expect(f.label).toBe(mustContradict ? "CONTRADICTED_BY_SPECIFIED_EVIDENCE" : "REQUIRES_DOMAIN_REVIEW");
      }),
      RUNS,
    );
  });

  it("allows support once the reviewer rules the contrary item weak or off scope, and keeps the ruling in the finding", () => {
    fc.assert(
      fc.property(arbContrary, fc.constantFrom("weak" as const, "off_scope" as const), (c, relevance) => {
        const disposition = { evidenceId: "study-2", relevance };
        const f = compile(claim(), items(c), { dispositions: [disposition] });
        expect(f.label).toBe("SUPPORTED_FOR_SCOPE");
        expect(f.contraryDispositions).toEqual([disposition]);
      }),
      RUNS,
    );
  });

  it("is not satisfied by a disposition for some other item", () => {
    fc.assert(
      fc.property(arbContrary, (c) => {
        const f = compile(claim(), items(c), { dispositions: [{ evidenceId: "study-1", relevance: "weak" }] });
        expect(f.label).not.toBe("SUPPORTED_FOR_SCOPE");
      }),
      RUNS,
    );
  });
});

describe("(d) removing a source the claim declares required never gives SUPPORTED_FOR_SCOPE", () => {
  const requiredSets: AssertionType[][] = [["authorization"], ["study"], ["authorization", "study"], ["authorization", "study", "requirement"], ["authorization", "study", "vendor"]];

  it("holds when the records are removed, or the source is lost or empty, across generated claims", () => {
    let fullySupported = 0;
    fc.assert(
      fc.property(arbScope, arbChoices, fc.constantFrom(...requiredSets), fc.constantFrom(...SOURCE_HEALTH.filter((h) => h !== "OK")), (E, c, required, health) => {
        const claimScope = shrink(E, c);
        const dependencies = { required, corroborating: [] };
        const evidence: EvidenceItem[] = [auth(E as Record<string, unknown>), study(E as Record<string, unknown>), requirement(true), { ...auth(), id: "vendor-1", assertionType: "vendor" }];
        const make = (ev: EvidenceItem[], options: CompileOptions = {}) => compile(claim(claimScope as Record<string, unknown>, undefined, { dependencies }), ev, options);
        if (make(evidence).label === "SUPPORTED_FOR_SCOPE") fullySupported++;
        for (const type of required) {
          const removed = make(evidence.filter((e) => e.assertionType !== type));
          expect(removed.label, `without ${type}`).not.toBe("SUPPORTED_FOR_SCOPE");
          expect(removed.label, `without ${type}`).not.toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
          const lost = make(evidence, { sourceHealth: { [type]: health } });
          expect(lost.label, `${type} ${health}`).not.toBe("SUPPORTED_FOR_SCOPE");
          expect(lost.label, `${type} ${health}`).not.toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
          expect(lost.degraded.some((d) => d.sourceType === type && d.dependency === "required")).toBe(true);
        }
      }),
      RUNS,
    );
    expect(fullySupported, "the intact world must be supported often enough for the property to bite").toBeGreaterThan(30);
  });

  it("does not change the label when a corroborating type is lost, absent or empty", () => {
    fc.assert(
      fc.property(arbScope, arbScope, arbChoices, fc.constantFrom(...SOURCE_HEALTH), (E, other, c, health) => {
        const claimScope = shrink(E, c);
        const dependencies = { required: ["authorization"], corroborating: ["study"] };
        const mk = (ev: EvidenceItem[], options: CompileOptions = {}) => compile(claim(claimScope as Record<string, unknown>, null, { dependencies }), ev, options);
        const withStudy = mk([auth(E as Record<string, unknown>), study(other as Record<string, unknown>)]);
        expect(mk([auth(E as Record<string, unknown>)]).label).toBe(withStudy.label);
        expect(mk([auth(E as Record<string, unknown>), study(other as Record<string, unknown>)], { sourceHealth: { study: health } }).label).toBe(withStudy.label);
      }),
      RUNS,
    );
  });
});

/** Reverse every array except interval tuples, and reverse object key order, at every depth. */
function reorder(value: unknown, key = ""): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((v) => reorder(v));
    return key === "ci" ? mapped : mapped.reverse();
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .reverse()
        .map(([k, v]) => [k, reorder(v, k)]),
    );
  }
  return value;
}

const rare = fc.integer({ min: 0, max: 14 }).map((n) => n === 0);
const mostly = <T>(common: T, other: readonly T[]) => fc.oneof({ weight: 6, arbitrary: fc.constant(common) }, { weight: 1, arbitrary: fc.constantFrom(...other) });

/** A world with every kind of variation the compiler handles. */
const arbWorld = fc
  .record({
    E: arbScope,
    S: arbScope,
    c: arbChoices,
    cw: arbChoices,
    drop: fc.array(rare, { minLength: 6, maxLength: 6 }),
    dropS: fc.array(rare, { minLength: 6, maxLength: 6 }),
    dropC: fc.array(rare, { minLength: 6, maxLength: 6 }),
    derived: fc.boolean(),
    sameStudy: mostly<boolean>(true, [false]),
    adequate: mostly<boolean | undefined>(true, [false, undefined]),
    value: fc.double({ min: 0, max: 1, noNaN: true }),
    lo: fc.double({ min: 0, max: 1, noNaN: true }),
    hi: fc.double({ min: 0, max: 1, noNaN: true }),
    hasCi: fc.boolean(),
    op: mostly<string | undefined>(OP, ["other", undefined]),
    atLeast: fc.double({ min: 0, max: 1, noNaN: true }),
    easy: fc.boolean(),
    hasPerf: fc.integer({ min: 0, max: 9 }).map((n) => n !== 0),
    health: fc.array(mostly<(typeof SOURCE_HEALTH)[number]>("OK", SOURCE_HEALTH), { minLength: 4, maxLength: 4 }),
    useHealth: rare,
    window: mostly<number | undefined>(undefined, [100, 4000]),
    dispose: mostly<string | undefined>(undefined, ["weak", "off_scope", "relevant"]),
    extraStudy: rare,
  })
  .map((w) => {
    const dims = ["versions", "population", "settings", "purpose"] as const;
    const blank = (s: Scope, flags: boolean[], withTiming = false) =>
      ({
        ...s,
        ...Object.fromEntries(dims.map((d, i) => (flags[i] ? [d, undefined] : [d, (s as Record<string, unknown>)[d]]))),
        ...(withTiming && flags[4] ? { timing: undefined } : {}),
      }) as Record<string, unknown>;
    const studyScope = w.sameStudy ? w.E : w.S;
    const claimScope = w.derived ? shrink(studyScope, w.cw) : grow(w.E, w.cw);
    const [lo, hi] = w.lo <= w.hi ? [w.lo, w.hi] : [w.hi, w.lo];
    const value = lo + (hi - lo) * w.value;
    const result: EvidenceResult = { metric: "sensitivity", value: w.hasCi ? value : w.value, ...(w.hasCi ? { ci: [lo, hi] as [number, number] } : {}), ...(w.op ? { operatingPoint: w.op } : {}) };
    const evidence: EvidenceItem[] = [
      auth(blank(w.E, w.drop)),
      study(blank(studyScope, w.dropS), [result], { ...(w.adequate !== undefined ? { adequate: w.adequate } : { adequate: undefined }) }),
    ];
    if (w.extraStudy) evidence.push(study(w.E as Record<string, unknown>, [{ ...GOOD_RESULT, value: 0.5, ci: [0.4, 0.6] }], { id: "study-2", adequate: w.adequate }));
    const options: CompileOptions = {
      ...(w.useHealth ? { sourceHealth: { authorization: w.health[0]!, study: w.health[1]!, vendor: w.health[2]!, requirement: w.health[3]! } } : {}),
      ...(w.window ? { policy: { stalenessWindowDays: w.window } } : {}),
      ...(w.dispose ? { dispositions: [{ evidenceId: "study-2", relevance: w.dispose as "weak" | "off_scope" | "relevant", ...(w.dispose === "relevant" ? { adequate: true } : {}) }] } : {}),
    };
    const atLeast = w.easy && w.hasCi ? lo * 0.9 : w.atLeast;
    return { claim: claim(blank(claimScope, w.dropC, true), w.hasPerf ? { metric: "sensitivity", atLeast } : null), evidence, options };
  });

describe("(e) identical inputs and rule version give identical output, across key and array order", () => {
  it("is a pure function: two runs agree byte for byte", () => {
    fc.assert(
      fc.property(arbWorld, (w) => {
        expect(canonicalJson(compileDetailed(w.claim, w.evidence, w.options))).toBe(canonicalJson(compileDetailed(w.claim, w.evidence, w.options)));
      }),
      RUNS,
    );
  });

  it("does not depend on the order of keys or of list items in the input", () => {
    fc.assert(
      fc.property(arbWorld, (w) => {
        const a = compileDetailed(w.claim, w.evidence, w.options);
        const b = compileDetailed(reorder(w.claim), reorder(w.evidence), reorder(w.options) as CompileOptions);
        expect(canonicalJson(b.finding)).toBe(canonicalJson(a.finding));
        expect(b.reasons).toEqual(a.reasons);
      }),
      RUNS,
    );
  });

  it("changes the finding id when, and only when, an input that matters changes", () => {
    const base = compile(claim(), [auth(), study()]);
    expect(compile(claim(), [study(), auth()]).id).toBe(base.id);
    expect(compile(claim({ versions: ["2.1.0"] }), [auth(), study()]).id).toBe(base.id);
    expect(compile(claim({ versions: ["V2.1.0"] }), [auth(), study()]).id).toBe(base.id);
    expect(compile(claim({ versions: ["2.0.0"] }), [auth(), study()]).id).not.toBe(base.id);
    expect(compile({ ...(claim() as object), text: "marketing copy" }, [auth(), study()]).id).toBe(base.id);
    expect(compile(claim(), [auth(), study()], { traceId: "t1", computedAt: "2026-10-27T10:00:00Z" }).id).toBe(base.id);
  });

  it("never reads the clock: computedAt appears only when the caller supplies it", () => {
    expect(compile(claim(), [auth(), study()]).computedAt).toBeUndefined();
    expect(compile(claim(), [auth(), study()], { computedAt: "2026-10-27T10:00:00Z" }).computedAt).toBe("2026-10-27T10:00:00Z");
  });
});

describe("(f) no path emits a label outside the five", () => {
  it("holds across generated worlds, and the finding always satisfies its schema", () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(arbWorld, (w) => {
        const f = compile(w.claim, w.evidence, w.options);
        seen.add(f.label);
        expect(LABELS).toContain(f.label);
        expect(FindingSchema.safeParse(f).success).toBe(true);
        expect((f.label === "SUPPORTED_ONLY_FOR_NARROWER_SCOPE") === (f.supportedScope !== undefined)).toBe(true);
        if (f.label === "SUPPORTED_FOR_SCOPE") expect(f.mismatches).toEqual([]);
      }),
      { numRuns: RUNS.numRuns * 4 },
    );
    expect([...seen].sort()).toEqual([...LABELS].sort());
  });

  it("never throws on schema-valid input (the narrower-scope self-check is never violated)", () => {
    fc.assert(fc.property(arbWorld, (w) => void compile(w.claim, w.evidence, w.options)), { numRuns: RUNS.numRuns * 4 });
  });
});

describe("derived invariants", () => {
  it("the supported narrower scope is itself supported by the same evidence", () => {
    let narrower = 0;
    fc.assert(
      fc.property(arbScope, arbChoices, arbChoices, (E, cg, cs) => {
        const w = grow(shrink(E, cs), cg);
        const evidence = [auth(E as Record<string, unknown>), study(E as Record<string, unknown>)];
        const f = compile(claim(w as Record<string, unknown>), evidence);
        if (f.label !== "SUPPORTED_ONLY_FOR_NARROWER_SCOPE") return;
        narrower++;
        const again = compile({ id: "claim-1", use: { ...(f.supportedScope as Scope), timing: { from: "2026-11-01" }, operatingPoint: OP }, performance: { metric: "sensitivity", atLeast: 0.9 } }, evidence);
        expect(again.label).toBe("SUPPORTED_FOR_SCOPE");
      }),
      RUNS,
    );
    expect(narrower).toBeGreaterThan(20);
  });

  it("every dimension named in the mismatches is not contained, and every non-contained required dimension is named unless it only repeats another", () => {
    fc.assert(
      fc.property(arbWorld, (w) => {
        const f = compile(w.claim, w.evidence, w.options);
        const open = f.mechanicalCoverage.filter((m) => m.relation !== "CONTAINED").map((m) => m.dimension);
        for (const m of f.mismatches) expect(open).toContain(m.dimension);
        for (const r of f.requiredEvidence) expect(f.mismatches.map((m) => m.dimension)).toContain(r.dimension);
      }),
      RUNS,
    );
  });

  it("unknown is never contained: a claim that leaves any required dimension out is never supported", () => {
    fc.assert(
      fc.property(arbScope, arbChoices, fc.constantFrom("versions", "population", "settings", "purpose", "timing", "product"), (E, c, drop) => {
        const f = compile(claim({ ...shrink(E, c), [drop]: undefined }), [auth(E as Record<string, unknown>), study(E as Record<string, unknown>)]);
        expect(["SUPPORTED_FOR_SCOPE", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE"]).not.toContain(f.label);
      }),
      RUNS,
    );
  });

  it("the product constant used by the generators is what the fixtures use", () => {
    expect(PRODUCT).toBe("device:fda:K1");
    expect(ASSERTION_TYPES).toHaveLength(4);
  });
});
