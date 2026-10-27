import type { Dimension } from "../schemas/index.ts";

/*
 * Rule registry for the Applicability Compiler.
 *
 * HONESTY NOTE. No published standard prescribes deterministic applicability checks. PROBAST+AI,
 * STARD-AI, TRIPOD+AI, IMDRF SaMD N41 and the FDA PCCP guidance name the things a reviewer must look at
 * (population, setting, intended use, timing, software version, thresholds). They do not say how to test
 * a claim against that evidence in code. The citations below point at the concept each rule is built on,
 * copied from research/standards/APPLICABILITY-RULE-REGISTRY.md (read first-hand on 2026-10-27). The executable
 * logic and every threshold are our design inference and are open to clinician challenge. Where a rule needs
 * judgement the standards do not supply (staleness windows, sample-size thresholds, generalisability, prevalence
 * transport) the rule is tagged "flag": it raises REQUIRES_DOMAIN_REVIEW and never computes a verdict.
 *
 * Rules marked `basis: "design-inference"` have no standard behind them at all. They carry no citation,
 * because inventing one would be worse than admitting that.
 *
 * Registry rules that this version does not execute are listed in UNIMPLEMENTED_REGISTRY_RULES with the reason.
 * They are not approximated.
 */

/** Bump when any rule's behaviour changes. Part of every Finding as `ruleVersion`. */
export const COMPILER_VERSION = "sakaime-compiler@1.0.0";

export type RuleTag = "deterministic" | "flag";

export interface Rule {
  id: string;
  name: string;
  /** What the rule decides, in one sentence. */
  summary: string;
  tag: RuleTag;
  /** Version of this rule's logic. */
  version: string;
  dimension?: Dimension;
  basis: "standard-concept" | "design-inference";
  /** Pointers into the standards, as recorded in the registry file. Empty for design inferences. */
  citations: readonly string[];
  /** The rule id in research/standards/APPLICABILITY-RULE-REGISTRY.md, when it has one. */
  registryId?: string;
  /** Clinician-contested in the registry (section 9). Computed, but open to challenge. */
  contested?: boolean;
}

const r = (rule: Omit<Rule, "version"> & { version?: string }): Rule => ({ version: "1", ...rule });

export const RULES: readonly Rule[] = [
  r({
    id: "R01-VER-DISJOINT",
    registryId: "R01",
    name: "Claimed and evaluated versions are disjoint",
    summary:
      "A wholly different version supports nothing: INSUFFICIENT_EVIDENCE. Overlap with a larger claimed set gives the overlap as the narrower scope.",
    tag: "deterministic",
    dimension: "version",
    basis: "standard-concept",
    citations: [
      "STARD-AI item 13",
      "FDA PCCP guidance, section V.D (modification specified and implemented per protocol)",
      "K250694 letter: Trade/Device Name: Scaida BrainCT-ICH (v1.0)",
    ],
    contested: true,
  }),
  r({
    id: "R02-VER-UNRECORDED",
    registryId: "R02",
    name: "Evidence does not record a software version",
    summary: "No evidence record states the version evaluated: the version dimension is UNKNOWN.",
    tag: "deterministic",
    dimension: "version",
    basis: "standard-concept",
    citations: [
      "STARD-AI item 13: software (with version number)",
      "TRIPOD+AI has no software version item",
      "K250694 enclosure drops the version",
    ],
  }),
  r({
    id: "R08-POP-SUBSET",
    registryId: "R08",
    name: "Claimed population is partly outside the studied population",
    summary: "The overlap is the narrower scope: SUPPORTED_ONLY_FOR_NARROWER_SCOPE.",
    tag: "deterministic",
    dimension: "population",
    basis: "standard-concept",
    citations: [
      "PROBAST+AI E&E Light (Suppl. Table 4): children-only studies versus adults and children combined",
      "STARD-AI item 7",
      "FDA PCCP guidance, section IV.B (representativeness)",
    ],
  }),
  r({
    id: "R09-POP-DISJOINT",
    registryId: "R09",
    name: "Claimed population is entirely outside the studied population",
    summary: "A study exclusion shows absence of evidence, not contrary evidence: INSUFFICIENT_EVIDENCE, not CONTRADICTED.",
    tag: "deterministic",
    dimension: "population",
    basis: "standard-concept",
    citations: ["STARD-AI item 7", "PROBAST+AI signalling question 1.3"],
  }),
  r({
    id: "R10-POP-LABEL-EXCLUDED",
    registryId: "R10",
    name: "Claimed population contradicts an explicit authorization limit",
    summary:
      "A numeric age bound or a named exclusion in the authorization record that the claim extends beyond: CONTRADICTED_BY_SPECIFIED_EVIDENCE. Silence never triggers it.",
    tag: "deterministic",
    dimension: "population",
    basis: "standard-concept",
    citations: [
      "21 CFR 814.20(b)(3)(i)",
      "K250694 indications for use: adult patients (ages 22 and above), not for patients under 22",
      "DEN170073 decision summary, section F.3",
    ],
  }),
  r({
    id: "R11-POP-UNDESCRIBED",
    registryId: "R11",
    name: "Evidence does not describe its population",
    summary: "No evidence record states age or conditions: the population dimension is UNKNOWN.",
    tag: "deterministic",
    dimension: "population",
    basis: "standard-concept",
    citations: ["STARD-AI item 25", "TRIPOD+AI item 20b", "PROBAST+AI: no information only when reported information is insufficient"],
  }),
  r({
    id: "R15-SETTING-NOT-STUDIED",
    registryId: "R15",
    name: "Claimed care setting was not studied",
    summary: "Other settings studied gives the studied overlap as the narrower scope; a setting the evidence never reports is UNKNOWN.",
    tag: "deterministic",
    dimension: "setting",
    basis: "standard-concept",
    citations: [
      "TRIPOD+AI item 6a",
      "HAIP AI Vendor Disclosure Framework, domain 1: Implementation Context",
      "PROBAST+AI PICOTS: the prediction ability of models may change across healthcare settings or contexts",
    ],
  }),
  r({
    id: "R19-DATES-MISSING",
    registryId: "R19",
    name: "Evidence carries no dates",
    summary: "No evidence record dates itself or states an authorization window: the timing dimension is UNKNOWN.",
    tag: "deterministic",
    dimension: "timing",
    basis: "standard-concept",
    citations: ["TRIPOD+AI item 5b", "STARD-AI item 9", "K250694 gives no collection dates"],
  }),
  r({
    id: "R21-PREDATES-AUTH",
    registryId: "R21",
    name: "Claimed start precedes the authorization effective date",
    summary: "Use that begins before the authorization takes effect: CONTRADICTED_BY_SPECIFIED_EVIDENCE.",
    tag: "deterministic",
    dimension: "timing",
    basis: "standard-concept",
    citations: ["K250694 letter date 2025-11-25 versus received 2025-10-28 (distinct dates)"],
  }),
  r({
    id: "R25-PURPOSE-ESCALATION",
    registryId: "R25",
    name: "Claimed purpose is more consequential than the evidenced purpose",
    summary:
      "The evidenced purpose is the narrower scope: SUPPORTED_ONLY_FOR_NARROWER_SCOPE. Without a structured explicit negation in the record the rule cannot reach CONTRADICTED.",
    tag: "deterministic",
    dimension: "purpose",
    basis: "standard-concept",
    citations: ["IMDRF SaMD N41 section 7: modify your intended use to one that can be supported by available evidence"],
    contested: true,
  }),
  r({
    id: "R32-METRIC-ABSENT",
    registryId: "R32",
    name: "No study reports the claimed metric",
    summary: "The metric dimension is UNKNOWN.",
    tag: "deterministic",
    dimension: "metric",
    basis: "standard-concept",
    citations: ["PROBAST+AI signalling question 4.7", "TRIPOD+AI item 12e", "DEN170073 reports AUC separately from sensitivity and specificity"],
  }),
  r({
    id: "R33-OPERATING-POINT",
    registryId: "R33",
    name: "Operating point differs or is unreported",
    summary: "A result at another threshold, or at an unreported one, is not comparable with the claim: the metric dimension is UNKNOWN.",
    tag: "deterministic",
    dimension: "metric",
    basis: "standard-concept",
    citations: ["STARD-AI item 15c", "TRIPOD+AI item 15", "K250694 states no threshold"],
  }),
  r({
    id: "R34-CLAIMED-VALUE-VS-CI",
    registryId: "R34",
    name: "Claimed minimum value against the reported interval",
    summary:
      "Claimed minimum above the upper bound is contrary; inside the interval is UNKNOWN; at or below the lower bound is supported. A result without an interval is never enough to support.",
    tag: "deterministic",
    dimension: "metric",
    basis: "standard-concept",
    citations: ["STARD-AI item 31"],
    contested: true,
  }),
  r({
    id: "R13-RESULT-IMPRECISE",
    registryId: "R13",
    name: "Result is imprecise under the configured policy",
    summary:
      "Raised only when the caller configures a minimum sample size or a maximum interval width. No standard sets the threshold, so the compiler never invents one.",
    tag: "flag",
    dimension: "metric",
    basis: "standard-concept",
    citations: ["PROBAST+AI glossary: imprecision", "no standard sets the sample-size threshold"],
  }),
  r({
    id: "R14-PREVALENCE-TRANSPORT",
    registryId: "R14",
    name: "Prevalence-dependent metric",
    summary:
      "Predictive values and alert rates depend on the prevalence in the tested population. The evidence schema carries no prevalence, so transport to the local population is a reviewer judgement.",
    tag: "flag",
    dimension: "metric",
    basis: "standard-concept",
    citations: ["STARD-AI items 28 and 26a/b", "DEN170073 test set: approximately equal numbers of positive and negative cases"],
  }),
  r({
    id: "R20-STALENESS",
    registryId: "R20",
    name: "Evidence is older than the configured staleness window",
    summary: "Raised only when the caller configures a window. No standard sets one, so there is no default.",
    tag: "flag",
    dimension: "timing",
    basis: "standard-concept",
    citations: ["GMLP principle 10 names dataset drift as a risk", "threshold NOT VERIFIED in any standard"],
  }),
  r({
    id: "SAK-CLAIM-UNSPECIFIED",
    name: "The claim leaves a dimension unspecified",
    summary: "An unspecified claim dimension is UNKNOWN, never read as everything.",
    tag: "deterministic",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-EVIDENCE-UNSPECIFIED",
    name: "No evidence record states a dimension",
    summary: "Unspecified on the evidence side is UNKNOWN, never CONTAINED.",
    tag: "deterministic",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-PRODUCT-MISMATCH",
    name: "Evidence concerns a different product",
    summary: "Records for another product contribute to no dimension but the product dimension.",
    tag: "deterministic",
    dimension: "product",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-PURPOSE-DISJOINT",
    name: "Claimed and evidenced purposes are unrelated",
    summary: "Neither purpose is inside the other in the taxonomy (for example screening of an unselected population and triage notification): INSUFFICIENT_EVIDENCE.",
    tag: "deterministic",
    dimension: "purpose",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-AUTHORITY",
    name: "Authority by assertion type",
    summary:
      "Authorization defines the authorized use, a study defines measured performance, a requirement is the hospital's own, a vendor record is only a claim. A study never widens an authorization, an authorization never supplies a measured result, and a vendor record never supports.",
    tag: "deterministic",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-AUTH-WINDOW-ENDED",
    name: "Claimed use falls after the authorization window",
    summary:
      "The record was superseded or withdrawn before the claimed start. The record alone cannot say whether a successor covers the use: INSUFFICIENT_EVIDENCE.",
    tag: "deterministic",
    dimension: "timing",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-STUDY-POSTDATES",
    name: "Evidence is dated after the claimed start",
    summary: "No study existed on the claimed start date: the timing dimension is DISJOINT.",
    tag: "deterministic",
    dimension: "timing",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-SOURCE-LOSS",
    name: "A source the claim depends on is lost or empty",
    summary:
      "Loss, emptiness or absence of a required evidence type can never give a supported label. Loss of a corroborating type is recorded and does not change the label.",
    tag: "deterministic",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-JOINT-COVERAGE",
    name: "Coverage is assembled from several records",
    summary:
      "Each dimension is contained by the union of several records, but no single record establishes the claimed combination. Whether the pieces can be combined is a reviewer judgement.",
    tag: "flag",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-UNPLACED-SETTING",
    name: "Care setting is not in the setting taxonomy",
    summary: "A setting term the taxonomy cannot place is never guessed at: UNKNOWN plus a review flag.",
    tag: "flag",
    dimension: "setting",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-UNPLACED-PURPOSE",
    name: "Purpose is not in the purpose taxonomy",
    summary: "A purpose term the taxonomy cannot place is never guessed at: UNKNOWN plus a review flag.",
    tag: "flag",
    dimension: "purpose",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-NARROWER-AMBIGUOUS",
    name: "No single narrower scope can be stated",
    summary:
      "The evidenced overlap is several disjoint pieces (age ranges, purposes). Choosing one would be a guess, so the finding goes to review.",
    tag: "flag",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-CONTRARY-UNDISPOSITIONED",
    name: "Contrary material has no recorded disposition",
    summary:
      "A result below the claim from material that is weak, off-scope or of unknown adequacy needs a recorded reviewer disposition before any supported label.",
    tag: "flag",
    dimension: "metric",
    basis: "design-inference",
    citations: [],
  }),
  r({
    id: "SAK-REQUIREMENT",
    name: "Hospital requirement is unmet or unassessed",
    summary:
      "The hospital's own requirement is a decision for the committee, not a computation. An unmet or unassessed requirement goes to review.",
    tag: "flag",
    basis: "design-inference",
    citations: [],
  }),
];

export const RULE_BY_ID: ReadonlyMap<string, Rule> = new Map(RULES.map((rule) => [rule.id, rule]));

export function ruleOf(id: string): Rule {
  const rule = RULE_BY_ID.get(id);
  if (!rule) throw new Error(`unknown compiler rule id: ${id}`);
  return rule;
}

/** Registry rules (research/standards/APPLICABILITY-RULE-REGISTRY.md section 7) that the evidence schema cannot support. */
export const UNIMPLEMENTED_REGISTRY_RULES: Readonly<Record<string, string>> = {
  R03: "needs the PCCP description of the device, which the schema does not carry",
  R04: "needs the date of a software change and the existence of a post-change performance summary",
  R05: "needs the adaptation mode (global or local) of the device",
  R06: "needs the model basis, base model and prompt version of an LLM-based product",
  R07: "needs capture devices and technical exclusions as structured fields",
  R12: "needs the claim's required subgroups and subgroup-labelled results",
  R16: "needs the number of sites",
  R17: "needs the countries of the claim and of the evidence",
  R18: "needs user roles and the prescription-only condition",
  R22: "needs the care-pathway stage at which the product is used",
  R23: "needs the prediction horizon on both sides",
  R24: "needs a structured explicit negation in the indications for use",
  R26: "needs the evaluated role (standalone or human-AI team)",
  R27: "needs the claim level and the evidence level",
  R28: "needs whether clinical testing was conducted",
  R29: "needs the regulatory status assertion of the vendor",
  R30: "needs a normalised outcome definition",
  R31: "needs the reference standard on both sides",
  R35: "needs comparator language in the claim and the evidence comparator",
  R36: "needs the evaluation type (apparent, internal, external)",
  R37: "needs the independence of training and test data",
  R38: "needs vendor independence and the clinical situation category",
};
