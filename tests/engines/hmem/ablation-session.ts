import type { AmbiguityQuestion } from "../../../src/engines/hmem/ablation.ts";

/**
 * CONSTRUCTED session for MA-2: ten review cases at two fictional hospitals. Seven underlying
 * ambiguities (four identity links, two policy questions, one schema mapping, one unit question)
 * recur across cases, and every recurrence is worded differently from the first time, at three
 * levels of closeness: p0 repeats the identifiers, p1 rewords with the identifiers kept, p2 rewords
 * and drops them. The wording was written once, by hand, before any result was seen; products and
 * submission numbers are invented.
 */
const PHRASING: Record<string, [string, string, string]> = {
  "chestread-link": [
    "Is the Aurelia ChestRead v2 named in the vendor claim the same product as FDA submission K900001?",
    "Does submission K900001 cover Aurelia ChestRead version 2?",
    "Which clearance belongs to the ChestRead software the vendor is describing?",
  ],
  "strokealert-link": [
    "Is the Orbis StrokeAlert in the claim the same product as FDA submission K900002?",
    "Does K900002 cover the Orbis StrokeAlert software?",
    "Which clearance belongs to the stroke software named in this claim?",
  ],
  "retinascan-link": [
    "Is the Calyx RetinaScan in the vendor claim the same product as FDA submission K900003?",
    "Does K900003 cover the Calyx RetinaScan software?",
    "Which clearance belongs to the retina software the vendor describes?",
  ],
  "device-class-mapping": [
    "Does the registry field device_class map to the class field in the evidence schema?",
    "Should device_class from the registry be read as the class field?",
    "How is the device category recorded in the registry mapped onto our schema?",
  ],
  "subgroup-n": [
    "Does our policy require at least 30 patients before a subgroup result is relied on?",
    "Is a subgroup result with fewer than 30 patients acceptable for this review?",
    "What is the smallest subgroup we accept?",
  ],
  "retrospective-triage": [
    "Is retrospective evidence enough for a triage tool at this hospital?",
    "Do triage tools need prospective evidence, or is a retrospective study sufficient?",
    "What study design do we require before a worklist prioritisation tool is used?",
  ],
  "age-units": [
    "Is age reported in months or years in the Dataset Alpha export?",
    "Are the age values in the Alpha export in months?",
    "What unit do the age values use in this dataset?",
  ],
};

const ANSWERS: Record<string, string> = {
  "chestread-link": "Same product: submission K900001 covers ChestRead 2.x.",
  "strokealert-link": "Same product: submission K900002.",
  "retinascan-link": "Different product: K900003 is the earlier RetinaScan 1.x line.",
  "device-class-mapping": "device_class maps to class.",
  "subgroup-n": "Subgroups under 30 patients are not relied on.",
  "retrospective-triage": "Triage tools need prospective evidence.",
  "age-units": "Age is in months.",
};

/** [organization, case, [key, phrasing index][]] in the order the cases were reviewed. */
const CASES: [string, string, [string, 0 | 1 | 2][]][] = [
  ["hospital-a", "case-01", [["chestread-link", 0], ["device-class-mapping", 0], ["retrospective-triage", 0]]],
  ["hospital-a", "case-02", [["chestread-link", 1], ["strokealert-link", 0], ["subgroup-n", 0], ["age-units", 0]]],
  ["hospital-a", "case-03", [["strokealert-link", 2], ["device-class-mapping", 1], ["retrospective-triage", 1]]],
  ["hospital-a", "case-04", [["retinascan-link", 0], ["chestread-link", 2], ["subgroup-n", 1], ["age-units", 1]]],
  ["hospital-b", "case-05", [["chestread-link", 0], ["retrospective-triage", 0], ["device-class-mapping", 0]]],
  ["hospital-a", "case-06", [["retinascan-link", 1], ["strokealert-link", 1], ["device-class-mapping", 2], ["subgroup-n", 2]]],
  ["hospital-b", "case-07", [["chestread-link", 1], ["retrospective-triage", 2], ["age-units", 0]]],
  ["hospital-a", "case-08", [["age-units", 2], ["retrospective-triage", 1], ["chestread-link", 0]]],
  ["hospital-b", "case-09", [["strokealert-link", 0], ["device-class-mapping", 1], ["chestread-link", 2], ["age-units", 1]]],
  ["hospital-a", "case-10", [["retinascan-link", 2], ["strokealert-link", 1], ["subgroup-n", 1]]],
];

export function buildMa2Session(): AmbiguityQuestion[] {
  return CASES.flatMap(([organizationId, caseId, asks]) =>
    asks.map(([key, p]) => ({ organizationId, caseId, key, text: PHRASING[key]![p], answer: ANSWERS[key]! })),
  );
}
