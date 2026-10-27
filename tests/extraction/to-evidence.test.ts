import { describe, expect, it } from "vitest";
import { documentFromText } from "../../src/extraction/document.ts";
import { parseFdaSummary } from "../../src/extraction/fda-summary.ts";
import { parseClinicalTrials } from "../../src/extraction/structured/ctgov.ts";
import { parseOpenFda510k } from "../../src/extraction/structured/openfda.ts";
import { toEvidenceItems } from "../../src/extraction/to-evidence.ts";
import { EvidenceItemSchema } from "../../src/schemas/scope.ts";
import { fixture } from "./helpers.ts";

const fda = async (id: string) => parseFdaSummary(documentFromText(id, fixture("fda", `${id}_summary_text.txt`)));

describe("from verified assertions to the compiler's EvidenceItem / Scope", () => {
  it("builds an authorization item and a study item for BriefCase-Triage (K253265)", async () => {
    const run = await fda("K253265");
    const { items } = toEvidenceItems(run.extraction.kept, { absentFields: Object.entries(run.fields).filter(([, v]) => v.status === "absent").map(([k]) => k) });
    const auth = items.find((i) => i.assertionType === "authorization");
    const study = items.find((i) => i.assertionType === "study");
    expect(auth?.scope.product).toBe("device:fda:K253265");
    expect(auth?.scope.population?.age).toEqual({ min: 18 });
    expect(auth?.scope.settings).toEqual(["hospital network"]);
    expect(auth?.scope.purpose).toBe("triage_prioritization_notification");
    expect(auth?.scope.timing).toEqual({ from: "2025-11-06" });
    // an absent version stays absent and is said to be absent
    expect(auth?.scope.versions).toBeUndefined();
    expect(auth?.limitations.some((l) => l.includes("no software version"))).toBe(true);
    expect(study?.results.map((r) => [r.metric, r.value, r.ci])).toEqual(
      expect.arrayContaining([["sensitivity", 0.942, [0.896, 0.972]], ["specificity", 0.946, [0.907, 0.972]]]),
    );
    expect(study?.results.every((r) => r.anchorId !== undefined)).toBe(true);
    for (const i of items) expect(EvidenceItemSchema.safeParse(i).success).toBe(true);
  });

  it("keeps goals, corrected and worst-case figures out of the headline results and lists them as limitations", async () => {
    const run = await fda("DEN180001");
    const { items, notes } = toEvidenceItems(run.extraction.kept);
    const study = items.find((i) => i.assertionType === "study");
    const sens = study?.results.filter((r) => r.metric === "sensitivity").map((r) => r.value);
    expect(sens).toContain(0.874);
    expect(sens).not.toContain(0.85);
    expect(sens).not.toContain(0.872);
    expect(sens).not.toContain(0.807);
    expect(study?.limitations.some((l) => l.includes("enrichment_corrected"))).toBe(true);
    expect(notes.some((n) => n.kind === "excluded_result")).toBe(true);
    // the version is in the authorization item; the study item takes it only on request, and says so
    expect(study?.scope.versions).toBeUndefined();
    expect(items.find((i) => i.assertionType === "authorization")?.scope.versions).toEqual(["2.0.0"]);
    const inherited = toEvidenceItems(run.extraction.kept, { versionsFromSameDocument: true }).items.find((i) => i.assertionType === "study");
    expect(inherited?.scope.versions).toEqual(["2.0.0"]);
    expect(inherited?.limitations.some((l) => l.includes("named elsewhere in the same document"))).toBe(true);
  });

  it("never uses a figure whose support failed or was undecided", async () => {
    const run = await fda("K211733");
    const { items } = toEvidenceItems(run.extraction.kept);
    const all = items.flatMap((i) => i.results.map((r) => r.value));
    expect(all).not.toContain(0.9885); // the predicate's AUC
    const lenient = toEvidenceItems(run.extraction.kept, { includeUnchecked: true });
    expect(lenient.items.flatMap((i) => i.results.map((r) => r.value))).not.toContain(0.9885);
  });

  it("uses a per-condition figure as a limitation, not as a headline", async () => {
    const run = await fda("K221347");
    const study = toEvidenceItems(run.extraction.kept).items.find((i) => i.assertionType === "study");
    expect(study?.results).toEqual([]);
    expect(study?.limitations.some((l) => l.includes("context:2D"))).toBe(true);
  });

  it("states the study age limit for the study item and the indication's for the authorization item", async () => {
    const run = await fda("K200667");
    const { items } = toEvidenceItems(run.extraction.kept);
    expect(items.find((i) => i.assertionType === "study")?.scope.population?.age).toEqual({ min: 22 });
    expect(items.find((i) => i.assertionType === "authorization")?.scope.population?.age).toBeUndefined();
  });

  it("builds an authorization item from an openFDA record, with the decision date as timing", async () => {
    const r = await parseOpenFda510k(fixture("openfda", "510k_K200667.json"), "k");
    const { items } = toEvidenceItems(r.extraction.kept);
    expect(items[0]?.scope).toMatchObject({ product: "device:fda:K200667", timing: { from: "2020-08-03" } });
  });

  it("builds a study item from a registry record and drops a start date with no day", async () => {
    const study = JSON.parse(fixture("ctgov", "study_NCT03112005.json"));
    study.protocolSection.statusModule.startDateStruct.date = "2017-04";
    const r = await parseClinicalTrials(study, "ct");
    const { items, notes } = toEvidenceItems(r.extraction.kept);
    const item = items.find((i) => i.assertionType === "study");
    expect(item?.scope.timing).toBeUndefined();
    expect(item?.scope.population?.age).toEqual({ min: 18 });
    expect(item?.scope.population?.conditions).toContain("Diabetic Retinopathy");
    expect(item?.scope.population?.exclusions?.[0]).toBe("Persistent visual impairment in one or both eyes;");
    expect(notes.some((n) => n.kind === "partial_date_dropped")).toBe(true);
  });

  it("reports conflicting age limits and uses the narrower", async () => {
    const run = await fda("K200667");
    const kept = run.extraction.kept.map((k) =>
      k.assertion.predicate === "population.age_min" ? { ...k, assertion: { ...k.assertion, value: 18, id: `${k.assertion.id}x` } } : k,
    );
    const dup = [...kept, ...run.extraction.kept.filter((k) => k.assertion.predicate === "population.age_min")];
    const { items, notes } = toEvidenceItems(dup);
    expect(items.find((i) => i.assertionType === "study")?.scope.population?.age?.min).toBe(22);
    expect(notes.some((n) => n.kind === "conflict")).toBe(true);
  });

  it("yields nothing for an empty input", () => {
    expect(toEvidenceItems([])).toEqual({ items: [], notes: [] });
  });
});
