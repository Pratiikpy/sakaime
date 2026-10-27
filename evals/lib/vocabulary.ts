/**
 * Vocabulary mapping between the three places a scope term can come from, fixed here and hashed into every result row.
 *
 *   claim terms     the Gate 0 key's own strings (`dr_screening_detection`, `endoscopy_unit`). The held-out claims use taxonomy keys
 *                   directly and need no claim-side mapping.
 *   extracted terms the controlled lists in src/extraction/lexicon.ts ("primary care", "concurrent reading aid").
 *   taxonomy keys   src/compiler/taxonomy.ts.
 *
 * Rules the table follows. A term maps only when it names the same thing in the taxonomy; a term with no equivalent is passed
 * through unchanged, and the compiler then treats it as unplaced and raises a review flag, which is the product's behaviour for
 * a term nobody can place. Nothing is mapped to make a particular claim come out right. The table was written while looking at
 * the 26 development claims (that is what they are for) and frozen before the first run on the held-out claims; see ERRATA.md E-003.
 */
import { hashOfJson } from "./core.ts";

export const VOCAB_VERSION = "1";

/** Claim-side purpose strings of the Gate 0 key to taxonomy purposes. */
export const CLAIM_PURPOSE: Readonly<Record<string, string>> = {
  dr_screening_detection: "detection_aid",
  concurrent_reading_aid: "detection_aid",
  triage_notification: "triage_notification",
  ai_supported_reading_triage: "triage_notification",
  tb_screening: "screening",
  ai_assisted_second_reading: "detection_aid",
  assistive_detection_after_initial_review: "detection_aid",
  computer_assisted_lesion_detection: "detection_aid",
  coronary_risk_and_functional_assessment: "prognosis",
  lvef_40_screening: "screening",
  echo_image_acquisition_guidance: "acquisition_guidance",
  dr_progression_monitoring: "monitoring",
};

/** Claim-side setting strings. Only identities and the clear synonym; `screening_program` and `endoscopy_unit` have no taxonomy node. */
export const CLAIM_SETTING: Readonly<Record<string, string>> = {
  primary_care: "primary_care",
  eye_care: "eye_care",
  hospital: "hospital",
};

/** Purpose terms the extractor reports to taxonomy purposes. */
export const EXTRACTED_PURPOSE: Readonly<Record<string, string>> = {
  triage: "triage_notification",
  notification: "triage_notification",
  prioritization: "triage_notification",
  detection: "detection_aid",
  "concurrent reading aid": "detection_aid",
  screening: "screening",
  "diagnostic aid": "diagnosis",
  guidance: "acquisition_guidance",
};

/** Setting terms the extractor reports to taxonomy settings. */
export const EXTRACTED_SETTING: Readonly<Record<string, string>> = {
  "primary care": "primary_care",
  "eye care": "eye_care",
  ophthalmology: "eye_care",
  "emergency department": "emergency_department",
  "acute setting": "hospital",
  "hospital network": "hospital",
  hospital: "hospital",
  outpatient: "outpatient_care",
  inpatient: "inpatient_ward",
  "intensive care": "intensive_care_unit",
  clinic: "outpatient_care",
  "healthcare facility": "any_care_setting",
};

/** When one document reports several purposes that are not nested, the evidence is read as establishing the first listed. */
export const PURPOSE_PRIORITY: readonly string[] = ["triage_notification", "detection_aid", "acquisition_guidance", "screening", "diagnosis"];

export const VOCABULARY_HASH = hashOfJson({
  v: VOCAB_VERSION,
  CLAIM_PURPOSE,
  CLAIM_SETTING,
  EXTRACTED_PURPOSE,
  EXTRACTED_SETTING,
  PURPOSE_PRIORITY,
});

const normKey = (s: string): string => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

export function mapClaimPurpose(p: string | undefined): string | undefined {
  if (p === undefined) return undefined;
  return CLAIM_PURPOSE[normKey(p)] ?? p;
}

export function mapClaimSettings(s: string[] | undefined): string[] | undefined {
  if (s === undefined) return undefined;
  return s.map((x) => CLAIM_SETTING[normKey(x)] ?? x);
}
