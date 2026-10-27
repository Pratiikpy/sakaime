import { describe, expect, it } from "vitest";
import { compile, parsePurposeExclusion } from "../../src/compiler/index.ts";
import { documentFromText } from "../../src/extraction/document.ts";
import { parseFdaSummary } from "../../src/extraction/fda-summary.ts";
import { POPULATION_TEMPLATES, diagnosticExclusion, populationPhrases } from "../../src/extraction/population.ts";
import { toEvidenceItems } from "../../src/extraction/to-evidence.ts";
import { fixture } from "./helpers.ts";

const fda = async (id: string) => parseFdaSummary(documentFromText(id, fixture("fda", `${id}_summary_text.txt`)));
const values = (run: Awaited<ReturnType<typeof fda>>, predicate: string) =>
  [...new Set(run.extraction.kept.filter((k) => k.assertion.predicate === predicate && k.assertion.supportVerified === "PASS").map((k) => String(k.assertion.value)))];

describe("population phrases of the indications", () => {
  it("reads the condition and the exclusion of an EyeArt-style indication, as written", () => {
    const text =
      "EyeArt is indicated for use by healthcare providers to automatically detect more than\n mild diabetic retinopathy in eyes of adults diagnosed with diabetes who have not been previously\n diagnosed with more than mild diabetic retinopathy. EyeArt is indicated for use with Canon cameras.";
    expect(populationPhrases(text).map((h) => [h.predicate, h.value])).toEqual([
      ["population.condition", "diabetes"],
      ["population.exclusion_criterion", "previously diagnosed with more than mild diabetic retinopathy"],
    ]);
  });

  it("splits a parenthesised list of findings and keeps each as written", () => {
    expect(populationPhrases("analyzes images for pre-specified suspected critical findings (pleural effusion and/or pneumothorax).").map((h) => h.value)).toEqual(["pleural effusion", "pneumothorax"]);
  });

  it("drops a phrase that runs to the end of the text: the sentence splitter cut it, it did not finish", () => {
    expect(populationPhrases("in adults at risk for heart")).toEqual([]);
    expect(populationPhrases("in adults at risk for heart failure.").map((h) => h.value)).toEqual(["adults at risk for heart failure"]);
  });

  it("reads a group a sentence says the device must not be used on, and not a purpose it must not be used for", () => {
    const hits = populationPhrases("It should not be used for monitoring of patients, and should not be used on ECGs with a paced rhythm.");
    expect(hits.map((h) => h.value)).toEqual(["paced rhythm"]);
  });

  it("reads nothing from a sentence that names no population", () => {
    expect(populationPhrases("The device analyzes images and sends a notification to a specialist.")).toEqual([]);
  });

  it("names the document each template was written from", () => {
    for (const t of POPULATION_TEMPLATES) expect(t.source, t.id).toMatch(/FDA (K|DEN)\d{6}/);
  });

  it("reads the development documents' indications", async () => {
    expect(values(await fda("K200667"), "population.condition")).toEqual(["diabetes"]);
    expect(values(await fda("K200667"), "population.exclusion_criterion")).toEqual(["previously diagnosed with more than mild diabetic retinopathy"]);
    expect(values(await fda("K232699"), "population.exclusion_criterion")).toEqual(["paced rhythm"]);
    expect(values(await fda("K211733"), "population.condition").sort()).toEqual(["pleural effusion", "pneumothorax"]);
    expect(values(await fda("DEN170073"), "population.condition")).toEqual(["suspected large vessel occlusion"]);
  });
});

describe("sentences that exclude diagnostic use", () => {
  it("is absolute only for the plain labelled forms", () => {
    expect(diagnosticExclusion("The device does not alter the original medical image and is not intended to be used as a diagnostic device.")).toBe("absolute");
    expect(diagnosticExclusion("This output is not for diagnostic use.")).toBe("absolute");
  });

  it("is qualified when the sentence carries a reservation", () => {
    expect(diagnosticExclusion("Identification of suspected findings is not for diagnostic use beyond notification.")).toBe("qualified");
    expect(diagnosticExclusion("It is not intended to be a stand-alone diagnostic device for cardiac conditions.")).toBe("qualified");
    expect(diagnosticExclusion("Its output should not be used as the primary diagnosis.")).toBe("qualified");
    expect(diagnosticExclusion("The notification does not provide any diagnostic information.")).toBe("qualified");
  });

  it("is not raised by a sentence that mentions diagnosis without excluding it", () => {
    expect(diagnosticExclusion("The software supports the diagnosis of coronary artery disease.")).toBeUndefined();
    expect(diagnosticExclusion("The device is not intended to replace clinical decision making.")).toBeUndefined();
  });

  it("reaches the compiler in the structured form, with the sentence as the document wrote it", async () => {
    const run = await fda("K253265");
    const { items } = toEvidenceItems(run.extraction.kept);
    const auth = items.find((i) => i.assertionType === "authorization");
    const parsed = (auth?.limitations ?? []).map(parsePurposeExclusion).filter((x) => x !== undefined);
    expect(parsed.map((p) => p.strength).sort()).toEqual(["absolute", "qualified"]);
    expect(parsed.find((p) => p.strength === "absolute")?.sentence).toMatch(/is not intended to be used as a diagnostic device/);
  });

  it("makes a claim of diagnosis contradicted where the document says plainly that the device is not diagnostic", async () => {
    const run = await fda("K253265");
    const { items } = toEvidenceItems(run.extraction.kept, { versionsFromSameDocument: true });
    const claim = { id: "c", use: { product: "device:fda:K253265", purpose: "diagnosis" }, dependencies: { required: ["authorization"], corroborating: [] } };
    const f = compile(claim, items, { requiredDimensions: ["product", "purpose"] });
    expect(f.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    // the plain label does not reach a narrower purpose
    const triage = compile({ ...claim, use: { ...claim.use, purpose: "triage_notification" } }, items, { requiredDimensions: ["product", "purpose"] });
    expect(triage.label).not.toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
  });

  it("goes to a reviewer, not to CONTRADICTED, where the exclusion carries a reservation", async () => {
    const run = await fda("K232699");
    const { items } = toEvidenceItems(run.extraction.kept);
    const claim = { id: "c", use: { product: "device:fda:K232699", purpose: "diagnosis" }, dependencies: { required: ["authorization"], corroborating: [] } };
    const f = compile(claim, items, { requiredDimensions: ["product", "purpose"] });
    expect(f.label).not.toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(f.label).not.toMatch(/^SUPPORTED_FOR_SCOPE/);
  });
});

describe("study items", () => {
  it("take the care setting only from a sentence that places the study", async () => {
    const run = await fda("DEN180001");
    expect(values(run, "study.setting_term")).toContain("primary care");
    const { items } = toEvidenceItems(run.extraction.kept);
    expect(items.find((i) => i.assertionType === "study")?.scope.settings).toEqual(["primary care"]);
    // a study that never says where it took place has no setting
    const transpara = toEvidenceItems((await fda("K221347")).extraction.kept).items.find((i) => i.assertionType === "study");
    expect(transpara?.scope.settings).toBeUndefined();
  });

  it("are dated with the decision date of their own document only when asked, and say so", async () => {
    const run = await fda("K253265");
    const plain = toEvidenceItems(run.extraction.kept).items.find((i) => i.assertionType === "study");
    expect(plain?.scope.timing).toBeUndefined();
    const dated = toEvidenceItems(run.extraction.kept, { datesFromSameDocument: true }).items.find((i) => i.assertionType === "study");
    expect(dated?.scope.timing).toEqual({ from: "2025-11-06" });
    expect(dated?.limitations.some((l) => /decision date of the document/.test(l))).toBe(true);
  });

  it("do not take the date of an unrelated document", async () => {
    const run = await fda("K253265");
    const other = toEvidenceItems(run.extraction.kept.map((k) => ({ ...k, assertion: { ...k.assertion, subjectId: k.assertion.assertionType === "study" ? "device:fda:K000000" : k.assertion.subjectId } })), { datesFromSameDocument: true });
    expect(other.items.find((i) => i.assertionType === "study")?.scope.timing).toBeUndefined();
  });

  it("read 'None.' in an exclusion list as no exclusion", async () => {
    const run = await fda("K253265");
    const kept = run.extraction.kept.map((k) => k);
    const ex = kept.find((k) => k.assertion.predicate === "indication.limitation");
    expect(ex).toBeDefined();
    const none = { ...(ex as (typeof kept)[number]), assertion: { ...(ex as (typeof kept)[number]).assertion, predicate: "population.exclusion_criterion", value: "None.", assertionType: "study" as const } };
    const { items } = toEvidenceItems([...kept, none]);
    expect(items.find((i) => i.assertionType === "study")?.scope.population?.exclusions).toBeUndefined();
  });
});

describe("figures under a subgroup heading", () => {
  const page = (body: string) => documentFromText("synthetic", `K999999 510(k) Summary\n\nSummary of Clinical Performance Data\nThe device was validated. Sensitivity 80.0%.\n\n${body}`);

  it("are subgroup figures, including the half of a sentence the layout cut off from its lead", async () => {
    const run = await parseFdaSummary(
      page(
        "Subgroup Analyses\n\nDiagnostic performance varied across ECG manufacturer, with the lowest for Vendor A (sensitivity 70.0%)\nand the highest observed for Vendor B\n(sensitivity 85.0%, specificity 92.0%), though this may be influenced by study site.\n",
      ),
    );
    const byValue = (v: number) => run.extraction.kept.find((k) => k.assertion.predicate === "result.sensitivity" && Number(k.assertion.value) === v);
    expect(byValue(0.8)?.detail.qualifiers ?? []).not.toContain("subgroup");
    expect(byValue(0.85)?.detail.qualifiers).toContain("subgroup");
    expect(byValue(0.7)?.detail.qualifiers).toContain("subgroup");
  });

  it("are not claimed by a sentence that merely mentions subgroup analyses", async () => {
    const run = await parseFdaSummary(page("Results were reported by site; reported subgroup analyses were consistent. Overall sensitivity was 83.0%.\n"));
    const k = run.extraction.kept.find((x) => x.assertion.predicate === "result.sensitivity" && Number(x.assertion.value) === 0.83);
    expect(k?.detail.qualifiers ?? []).not.toContain("subgroup");
  });
});
