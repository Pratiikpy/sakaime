import { describe, expect, it } from "vitest";
import { compareRecords } from "../../src/identity/compare.ts";
import { corroboration, FIELD_LEVELS, scoreOutcomes, trainModel, weightOf, type TrainingPair } from "../../src/identity/scorer.ts";
import { SCORER_FIELDS, type ComparisonOutcome } from "../../src/identity/types.ts";
import { MODEL, rec } from "./helpers.ts";

const out = (field: ComparisonOutcome["field"], level: string): ComparisonOutcome => ({ field, level });

describe("field comparison levels", () => {
  it("compares the Transpara pair field by field", () => {
    const c = Object.fromEntries(compareRecords(rec("510k:K221347"), rec("list:K210404"), { familyNames: MODEL.reference.familyNames }).map((o) => [o.field, o.level]));
    expect(c).toMatchObject({ name: "FAMILY_NAME", manufacturer: "EXACT", productCode: "EXACT", version: "SAME_RELEASE_LINE", purpose: "AGREE" });
  });

  it("calls a Viz company spelled two ways EXACT, and the owner drift for IDx an ALIAS", () => {
    expect(compareRecords(rec("510k:DEN170073"), rec("list:K223042")).find((o) => o.field === "manufacturer")?.level).toBe("EXACT");
    const idx = compareRecords(rec("510k:DEN180001"), rec("list:K203629")).find((o) => o.field === "manufacturer");
    expect(idx?.level).toBe("ALIAS");
  });

  it("treats a missing field as UNKNOWN, never as a disagreement", () => {
    const c = compareRecords(rec("list:K251406"), rec("list:K251195"));
    expect(c.find((o) => o.field === "purpose")?.level).toBe("UNKNOWN");
    expect(c.find((o) => o.field === "version")?.level).toBe("UNKNOWN");
    expect(c.find((o) => o.field === "enrollment")?.level).toBe("UNKNOWN");
  });

  it("does not let a sponsor lower belief about the manufacturer", () => {
    const study = rec("ctgov:NCT03705650");
    const m = compareRecords({ ...study, manufacturer: undefined, sponsor: "Some University" }, rec("510k:DEN190040")).find((o) => o.field === "manufacturer");
    expect(m?.level).toBe("UNKNOWN");
  });

  it("matches a name inside free text only as whole tokens", () => {
    const paper = { ...rec("pubmed:30251484") };
    const level = compareRecords(paper, rec("510k:K253265")).find((o) => o.field === "name")?.level;
    expect(["GENERIC_CONTAINS", "UNKNOWN", "DIFFERENT"]).toContain(level);
  });

  it("a one-word common name found inside free text is weak, and inside another record's name is not", () => {
    const inText = compareRecords(rec("pubmed:35183401"), rec("510k:DEN170073")).find((o) => o.field === "name")?.level;
    expect(inText).not.toBe("EXACT");
    expect(compareRecords(rec("510k:DEN170073"), rec("list:K223042")).find((o) => o.field === "name")?.level).toBe("CONTAINS");
  });

  it("compares dates in year bands and enrolment by size", () => {
    expect(compareRecords(rec("ctgov:NCT03112005"), rec("510k:K200667")).find((o) => o.field === "enrollment")?.level).toBe("EXACT");
    expect(compareRecords(rec("ctgov:NCT03112005"), rec("510k:K200667")).find((o) => o.field === "date")?.level).toBe("WITHIN_6Y"); // trial start 2017, clearance 2020: 3.3 years
  });
});

describe("Fellegi-Sunter model", () => {
  const pairs: TrainingPair[] = [
    ...Array.from({ length: 8 }, () => ({ linkType: "SAME_PRODUCT" as const, match: true, outcomes: [out("name", "EXACT"), out("manufacturer", "EXACT")] })),
    ...Array.from({ length: 2 }, () => ({ linkType: "SAME_PRODUCT" as const, match: true, outcomes: [out("name", "OVERLAP"), out("manufacturer", "UNKNOWN")] })),
    ...Array.from({ length: 2 }, () => ({ linkType: "SAME_PRODUCT" as const, match: false, outcomes: [out("name", "EXACT"), out("manufacturer", "DIFFERENT")] })),
    ...Array.from({ length: 8 }, () => ({ linkType: "SAME_PRODUCT" as const, match: false, outcomes: [out("name", "DIFFERENT"), out("manufacturer", "EXACT")] })),
  ];
  const model = trainModel(pairs);

  it("learns that a name match carries evidence and a manufacturer-only match carries less", () => {
    const params = model.byLinkType.SAME_PRODUCT!;
    expect(weightOf(params, "name", "EXACT")).toBeGreaterThan(0);
    expect(weightOf(params, "name", "DIFFERENT")).toBeLessThan(0);
    expect(weightOf(params, "manufacturer", "DIFFERENT")).toBeLessThan(weightOf(params, "manufacturer", "EXACT"));
  });

  it("keeps every m and u strictly between 0 and 1 even for levels never seen (smoothing)", () => {
    for (const f of SCORER_FIELDS) {
      for (const l of FIELD_LEVELS[f]) {
        for (const set of [model.pool, model.byLinkType.SAME_PRODUCT!]) {
          const p = set[f][l]!;
          expect(p.m).toBeGreaterThan(0);
          expect(p.m).toBeLessThan(1);
          expect(p.u).toBeGreaterThan(0);
          expect(p.u).toBeLessThan(1);
        }
      }
    }
    expect(Number.isFinite(weightOf(model.pool, "enrollment", "CLOSE"))).toBe(true);
  });

  it("normalises m and u over the known levels of each field", () => {
    for (const f of SCORER_FIELDS) {
      const m = FIELD_LEVELS[f].reduce((s, l) => s + model.pool[f][l]!.m, 0);
      const u = FIELD_LEVELS[f].reduce((s, l) => s + model.pool[f][l]!.u, 0);
      expect(m).toBeCloseTo(1, 9);
      expect(u).toBeCloseTo(1, 9);
    }
  });

  it("scores as a waterfall whose steps sum to the total, with unknown fields at zero", () => {
    const s = scoreOutcomes(model, "SAME_PRODUCT", [out("name", "EXACT"), out("manufacturer", "UNKNOWN"), out("version", "EXACT")]);
    expect(s.waterfall.find((w) => w.field === "manufacturer")?.weight).toBe(0);
    expect(s.waterfall.reduce((a, w) => a + w.weight, 0)).toBeCloseTo(s.weight, 2);
    expect(s.waterfall.map((w) => w.field)).toEqual(["name", "manufacturer", "version"]);
  });

  it("is deterministic: the same pairs give the same model and the same hash", () => {
    expect(trainModel(pairs).training.contentHash).toBe(model.training.contentHash);
    expect(trainModel([...pairs].reverse()).training.contentHash).toBe(model.training.contentHash);
  });

  it("derives a band with the upper edge above the highest training non-link and never below the floors", () => {
    const b = model.thresholds.pooled;
    expect(b.upper).toBeGreaterThanOrEqual(model.smoothing.upperFloorBits);
    expect(b.lower).toBeGreaterThanOrEqual(model.smoothing.lowerFloorBits);
    expect(b.lower).toBeLessThan(b.upper);
    const nonLinkWeights = pairs.filter((p) => !p.match).map((p) => scoreOutcomes(model, "SAME_PRODUCT", p.outcomes).weight);
    expect(b.upper).toBeGreaterThan(Math.max(...nonLinkWeights));
  });

  it("falls back to pooled parameters for a link type it has no pairs for", () => {
    const s = scoreOutcomes(model, "STUDY_EVALUATES", [out("name", "EXACT")]);
    expect(s.weight).toBeCloseTo(weightOf(model.pool, "name", "EXACT"), 2);
  });

  it("the committed default model records what it was trained on", () => {
    expect(MODEL.training.pairs).toBeGreaterThan(50);
    expect(MODEL.method).toBe("supervised-counting-with-shrinkage");
  });
});

describe("corroboration gate", () => {
  it("needs two independent kinds of evidence: a name alone is weak", () => {
    expect(corroboration([out("name", "EXACT"), out("purpose", "AGREE")]).strong).toBe(false);
    expect(corroboration([out("name", "EXACT"), out("manufacturer", "EXACT")]).strong).toBe(true);
    expect(corroboration([out("name", "EXACT"), out("enrollment", "EXACT")]).strong).toBe(true);
  });

  it("does not count a manufacturer that is part of the brand as a second kind of evidence", () => {
    const g = corroboration([out("name", "EXACT"), { field: "manufacturer", level: "EXACT", detail: "brand-contains-manufacturer" }]);
    expect(g.strong).toBe(false);
    expect(g.families).toContain("manufacturer-in-brand");
  });

  it("a name shared by many list rows identifies a line only when the use agrees", () => {
    expect(corroboration([out("name", "FAMILY_NAME"), out("manufacturer", "EXACT"), out("productCode", "EXACT")]).strong).toBe(false);
    expect(corroboration([out("name", "FAMILY_NAME"), out("manufacturer", "EXACT"), out("purpose", "AGREE")]).strong).toBe(true);
  });

  it("a contradicting extracted fact blocks a strong candidate whatever the rest says", () => {
    for (const blocker of [out("manufacturer", "DIFFERENT"), out("module", "DISAGREE"), out("purpose", "DISAGREE")]) {
      const g = corroboration([out("name", "EXACT"), out("enrollment", "EXACT"), out("productCode", "EXACT"), blocker]);
      expect(g.strong, blocker.field).toBe(false);
      expect(g.blockers.length).toBeGreaterThan(0);
    }
  });

  it("a link about a marketed version needs the versions shown equal", () => {
    const base = [out("name", "EXACT"), out("manufacturer", "EXACT"), out("productCode", "EXACT")];
    expect(corroboration([...base, out("version", "UNKNOWN")], "SAME_MARKETED_VERSION").strong).toBe(false);
    expect(corroboration([...base, out("version", "EXACT")], "SAME_MARKETED_VERSION").strong).toBe(true);
    expect(corroboration([...base, out("version", "UNKNOWN")], "SAME_PRODUCT").strong).toBe(true);
  });
});
