import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REGULATOR_RECORD_NOTE, compileDetailed } from "../../src/compiler/index.ts";
import type { EvidenceItem } from "../../src/schemas/index.ts";
import { GOOD_RESULT, auth, claim, study } from "./fixtures.ts";

/*
 * Authority by assertion type (docs/02 section 4, C-01): a study cannot widen an authorization; an authorization that is silent on a
 * dimension restricts nothing; a study alone cannot define the authorized use; and the regulator's own summary of the analysed
 * population bounds the claim where the authorization is silent, while a registry entry or a paper never does.
 */

const PEOPLE = { conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] };
const popRelation = (r: ReturnType<typeof compileDetailed>): string => r.finding.mechanicalCoverage.find((m) => m.dimension === "population")!.relation;
const claimAged = (min: number) => claim({ population: { age: { min }, ...PEOPLE } });
const authAged = (min: number | undefined, id = "auth-1") => auth({ population: min === undefined ? PEOPLE : { age: { min }, ...PEOPLE } }, { id });
const studyAged = (min: number, id: string, over: Partial<EvidenceItem> = {}) => study({ population: { age: { min }, ...PEOPLE } }, [GOOD_RESULT], { id, ...over });
const regulatorStudy = (min: number, id = "summary-study") => studyAged(min, id, { limitations: [`${REGULATOR_RECORD_NOTE} K200667`] });

const age = fc.integer({ min: 0, max: 90 });
const ages = fc.array(age, { minLength: 0, maxLength: 4 });
const RUNS = { numRuns: 200 };

describe("a study cannot widen an authorization", () => {
  it("a claim below the authorization's age floor is never contained, however many studies cover it", () => {
    fc.assert(
      fc.property(age, fc.integer({ min: 1, max: 40 }), ages, (floor, gap, studyMins) => {
        const c = Math.max(0, floor - gap);
        fc.pre(c < floor);
        const studies = [studyAged(c, "covering-study"), ...studyMins.map((m, i) => studyAged(Math.min(m, c), `study-${i}`))];
        const r = compileDetailed(claimAged(c), [authAged(floor), ...studies]);
        expect(popRelation(r)).not.toBe("CONTAINED");
        expect(r.finding.label).not.toBe("SUPPORTED_FOR_SCOPE");
      }),
      RUNS,
    );
  });

  it("adding studies that cover the claim never makes a claim outside the authorization more contained", () => {
    fc.assert(
      fc.property(age, fc.integer({ min: 1, max: 40 }), ages, (floor, gap, extra) => {
        const c = Math.max(0, floor - gap);
        fc.pre(c < floor);
        const base = compileDetailed(claimAged(c), [authAged(floor), studyAged(floor, "study-at-floor")]);
        const more = compileDetailed(claimAged(c), [authAged(floor), studyAged(floor, "study-at-floor"), ...extra.map((m, i) => studyAged(Math.min(m, c), `wide-${i}`))]);
        expect(popRelation(base)).toBe(popRelation(more));
        expect(more.finding.label).toBe(base.finding.label);
      }),
      RUNS,
    );
  });

  it("a claim inside the authorization stays limited by the studies: the intersection, not either one", () => {
    fc.assert(
      fc.property(age, age, age, (authMin, studyMin, claimMin) => {
        const r = compileDetailed(claimAged(claimMin), [authAged(authMin), studyAged(studyMin, "study-1")]);
        const insideBoth = claimMin >= authMin && claimMin >= studyMin;
        expect(popRelation(r) === "CONTAINED", `auth ${authMin}, study ${studyMin}, claim ${claimMin}`).toBe(insideBoth);
      }),
      RUNS,
    );
  });
});

describe("an authorization that is silent restricts nothing, and a study alone cannot define the authorized use", () => {
  it("with the authorization silent on age, a claim is contained exactly when some study covers it", () => {
    fc.assert(
      fc.property(age, fc.array(age, { minLength: 1, maxLength: 4 }), (c, mins) => {
        const r = compileDetailed(claimAged(c), [authAged(undefined), ...mins.map((m, i) => studyAged(m, `study-${i}`))]);
        expect(popRelation(r) === "CONTAINED").toBe(c >= Math.min(...mins));
      }),
      RUNS,
    );
  });

  it("with no authorization record at all, studies never give a supported label", () => {
    fc.assert(
      fc.property(age, fc.array(age, { minLength: 1, maxLength: 4 }), (c, mins) => {
        const r = compileDetailed(claimAged(c), mins.map((m, i) => studyAged(m, `study-${i}`)));
        expect(["SUPPORTED_FOR_SCOPE", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE"]).not.toContain(r.finding.label);
        expect(r.finding.degraded.some((d) => d.sourceType === "authorization" && d.dependency === "required")).toBe(true);
      }),
      RUNS,
    );
  });
});

describe("the regulator's summary bounds the claim where the authorization is silent; a registry entry or a paper never does", () => {
  it("a claim is contained exactly when it starts at or above the age the summary analysed", () => {
    fc.assert(
      fc.property(age, age, ages, (c, floor, registryMins) => {
        const r = compileDetailed(claimAged(c), [authAged(undefined), regulatorStudy(floor), ...registryMins.map((m, i) => studyAged(m, `registry-${i}`))]);
        expect(popRelation(r) === "CONTAINED", `claim ${c}, summary ${floor}, registry ${registryMins}`).toBe(c >= floor);
      }),
      RUNS,
    );
  });

  it("the same items without the marker are only covered by union, which is why the marker exists", () => {
    const c = 18;
    const marked = compileDetailed(claimAged(c), [authAged(undefined), regulatorStudy(22), studyAged(18, "registry")]);
    const unmarked = compileDetailed(claimAged(c), [authAged(undefined), studyAged(22, "summary-study"), studyAged(18, "registry")]);
    expect(popRelation(marked)).toBe("PARTIAL");
    expect(popRelation(unmarked)).toBe("CONTAINED");
  });

  it("never widens what an authorization states: where the authorization has an age floor, the summary can only raise it", () => {
    fc.assert(
      fc.property(age, age, age, (authMin, summaryMin, c) => {
        const r = compileDetailed(claimAged(c), [authAged(authMin), regulatorStudy(summaryMin), studyAged(0, "registry")]);
        expect(popRelation(r) === "CONTAINED", `auth ${authMin}, summary ${summaryMin}, claim ${c}`).toBe(c >= Math.max(authMin, summaryMin));
      }),
      RUNS,
    );
  });

  it("where the authorization states the setting, the summary's sites do not change it", () => {
    const withSummarySites = study({ settings: ["primary_care"], population: { age: { min: 18 }, ...PEOPLE } }, [GOOD_RESULT], { id: "summary-study", limitations: [`${REGULATOR_RECORD_NOTE} K200667`] });
    const plain = study({ population: { age: { min: 18 }, ...PEOPLE } }, [GOOD_RESULT], { id: "summary-study" });
    const a = compileDetailed(claimAged(18), [auth(), withSummarySites, study()]);
    const b = compileDetailed(claimAged(18), [auth(), plain, study()]);
    const setting = (r: typeof a) => r.finding.mechanicalCoverage.find((m) => m.dimension === "setting")!.relation;
    expect(setting(a)).toBe(setting(b));
  });

  it("is only used when the claim depends on an authorization", () => {
    const r = compileDetailed(claimAged(18), [regulatorStudy(22), studyAged(18, "registry")], {});
    expect(r.finding.label).not.toBe("SUPPORTED_FOR_SCOPE");
    const noAuth = compileDetailed(claim({ population: { age: { min: 18 }, ...PEOPLE } }, undefined, { dependencies: { required: ["study"], corroborating: [] } }), [regulatorStudy(22), studyAged(18, "registry")]);
    expect(popRelation(noAuth)).toBe("CONTAINED");
  });
});

describe("what limits the claim is named, with both values quoted", () => {
  const eighteenToTwentyOne = () => compileDetailed(claimAged(18), [authAged(undefined), regulatorStudy(22), studyAged(18, "registry")]);

  it("the established value quotes the summary and the studies side by side", () => {
    const pop = eighteenToTwentyOne().finding.mechanicalCoverage.find((m) => m.dimension === "population")!;
    expect(pop.established).toMatch(/regulator decision summary: ages 22 and above/);
    expect(pop.established).toMatch(/study: ages 18 and above/);
    expect(pop.relation).toBe("PARTIAL");
  });

  it("the request names the limiting source, quotes both values and says what to supply", () => {
    const req = eighteenToTwentyOne().finding.requiredEvidence.find((q) => q.dimension === "population")!.request;
    expect(req).toMatch(/^From the vendor: performance results for ages 18 to below 22, or restate the claim to cover only ages 22 and above\./);
    expect(req).toMatch(/The regulator decision summary limits the patient population to ages 22 and above/);
    expect(req).toMatch(/the study records state ages 18 and above, which does not widen it\./);
  });

  it("the label for such a claim is the narrower scope the summary allows", () => {
    const r = eighteenToTwentyOne();
    expect(r.finding.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(r.finding.supportedScope).toMatchObject({ population: { age: { min: 22 } } });
  });

  it("when the studies are what limit it, the request says so", () => {
    const r = compileDetailed(claimAged(18), [authAged(18), studyAged(22, "only-study")]);
    const req = r.finding.requiredEvidence.find((q) => q.dimension === "population")!.request;
    expect(req).toMatch(/The study records limit the patient population to ages 22 and above; the authorization record does not limit it\./);
  });
});

describe("the request for a partly covered population is a short sentence a vendor can act on", () => {
  // The exclusion criteria of the registry record of the EyeArt pivotal study, word for word.
  const EXCLUSIONS = [
    "Persistent visual impairment in one or both eyes;",
    "History of macular edema or retinal vascular (vein or artery) occlusion;",
    "History of ocular injections, laser treatment of the retina, or intraocular surgery other than cataract surgery without complications;",
    "Subject is contraindicated for fundus photography (for example, has light sensitivity);",
    "Subject has contraindications for mydriatic medications or is unwilling or unable to dilate;",
    "Subject is currently enrolled in an interventional study of an investigational device or drug; or",
    "Subject has a condition or is in a situation which in the opinion of the Investigator, might confound study results, may interfere significantly with the subject's participation in the study, or may result in ungradable clinical reference standard photographs.",
  ];
  const labelled = ["previously diagnosed with more than mild diabetic retinopathy"];
  const run = () =>
    compileDetailed(claim({ population: { age: { min: 22 }, conditions: ["diabetic retinopathy"], exclusions: labelled } }), [
      auth({ population: { conditions: ["diabetes mellitus"], exclusions: labelled } }),
      study({ population: { age: { min: 18 }, conditions: ["Diabetic Retinopathy"], exclusions: EXCLUSIONS } }),
    ]);

  it("counts the groups, shows three of them in whole words, and says how to restate the claim", () => {
    const f = run().finding;
    expect(f.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    const req = f.requiredEvidence.find((q) => q.dimension === "population")!.request;
    expect(req).toMatch(/^From the vendor: performance results for the 7 groups the evidence excluded \(/);
    expect(req).toMatch(/; and 4 more\), or restate the claim to exclude those groups\./);
    expect(req.length).toBeLessThan(520);
  });

  it("does not repeat the list, cut a phrase on a connector, or end on one", () => {
    const req = run().finding.requiredEvidence.find((q) => q.dimension === "population")!.request;
    expect(req.match(/persistent visual impairment/gi)?.length ?? 0).toBeLessThanOrEqual(1);
    expect(req).not.toMatch(/\b(or|and|of|the|in|for|with|than)\s*(\.\.\.)?[;)]/);
    expect(req).not.toMatch(/\bdrug or\b/);
    expect(req).not.toMatch(/\bor\.$/);
    expect(req.trim().endsWith(".")).toBe(true);
  });

  it("asks for results for a part of the age range and for the groups together, and restates both", () => {
    const r = compileDetailed(claim({ population: { age: { min: 18 }, conditions: ["diabetic retinopathy"], exclusions: labelled } }), [
      auth({ population: { conditions: ["diabetes mellitus"], exclusions: labelled } }),
      study({ population: { age: { min: 22 }, conditions: ["Diabetic Retinopathy"], exclusions: EXCLUSIONS } }),
    ]);
    const req = r.finding.requiredEvidence.find((q) => q.dimension === "population")!.request;
    expect(req).toMatch(/^From the vendor: performance results for ages 18 to below 22 and the 7 groups the evidence excluded \(/);
    expect(req).toMatch(/or restate the claim to cover only ages 22 and above and to exclude those groups\./);
  });
});
