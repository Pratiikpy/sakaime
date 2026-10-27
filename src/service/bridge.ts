/**
 * The vocabulary bridge between what the readers extract and what the compiler's taxonomies name.
 *
 * The extractors report the words a document uses ("primary care", "detection", "screening concurrent reading aid"). The
 * compiler places terms on hierarchies and never guesses at a term it cannot place. This file lists, once and in the open,
 * which extracted or hospital terms are read as which taxonomy node. It is a design decision, not a finding: a clinician may
 * disagree with any line, and the taxonomy version in the rule version changes when a line does, so a finding says which
 * bridge it was computed under. A term that is not listed stays unplaced and sends the finding to a reviewer.
 */
import { DEFAULT_PURPOSE_TAXONOMY, DEFAULT_SETTING_TAXONOMY, TaxonomySchema, type CompileOptions } from "../compiler/index.ts";

export const BRIDGE_VERSION = "bridge1";

const SETTING_ALIASES: Record<string, string> = {
  ophthalmology: "eye_care",
  acute_setting: "hospital",
  hospital_network: "hospital",
  healthcare_facility: "any_care_setting",
  clinic: "outpatient_care",
  intensive_care: "intensive_care_unit",
  // The hospital's own word for a clinic that screens: an outpatient specialty clinic.
  breast_screening_clinic: "specialty_clinic",
};

const PURPOSE_ALIASES: Record<string, string> = {
  detection: "detection_aid",
  triage_prioritization_notification: "triage_notification",
  triage_prioritisation: "triage_notification",
  triage_prioritization: "triage_notification",
  // A concurrent reading aid for screening mammography is computer-aided detection.
  screening_concurrent_reading_aid: "detection_aid",
  concurrent_reading_aid: "detection_aid",
};

export const SERVICE_SETTINGS = TaxonomySchema.parse({
  ...DEFAULT_SETTING_TAXONOMY,
  version: `${DEFAULT_SETTING_TAXONOMY.version}+${BRIDGE_VERSION}`,
  aliases: { ...DEFAULT_SETTING_TAXONOMY.aliases, ...SETTING_ALIASES },
});

export const SERVICE_PURPOSES = TaxonomySchema.parse({
  ...DEFAULT_PURPOSE_TAXONOMY,
  version: `${DEFAULT_PURPOSE_TAXONOMY.version}+${BRIDGE_VERSION}`,
  aliases: { ...DEFAULT_PURPOSE_TAXONOMY.aliases, ...PURPOSE_ALIASES },
});

/**
 * The review policy of the services. A staleness window is a hospital choice and no standard sets one (compiler rule R20), so the
 * compiler has no default. These services configure one: three years. It is our design inference, not a requirement: evidence or an
 * authorization record dated longer than this before the end of a claimed period raises a review flag, and a hospital that wants another
 * window changes it here. Nothing else in the policy is configured, because no source gives a sample-size or interval-width threshold.
 */
export const SERVICE_POLICY = { stalenessWindowDays: 1095 } as const;

/** Compile options every service call shares. The rule version these produce is what a dossier records. */
export function baseCompileOptions(): Pick<CompileOptions, "taxonomies" | "policy"> {
  return { taxonomies: { settings: SERVICE_SETTINGS, purposes: SERVICE_PURPOSES }, policy: { ...SERVICE_POLICY } };
}
