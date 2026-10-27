/*
 * Applicability Compiler (docs/02-architecture.md section 10).
 *
 *   compile(claim, evidence, options) -> Finding
 *
 * How evidence combines.
 *   - Records are split by assertion type. Authorization defines the authorized use. A study defines what was measured and where.
 *     A requirement is the hospital's own and never evidence. A vendor record is a claim: it supports, widens and contradicts nothing.
 *   - On each scope dimension the records of one type combine by union (what any of them establishes). Where authorization and
 *     study both state the dimension, the claim must lie inside both (their meet), so a study never widens an authorization.
 *     An authorization that is silent restricts nothing; a study that is silent leaves its results unattached and the dimension UNKNOWN.
 *     One exception to "a study never bounds": a study-typed item taken from the regulator's own decision summary (it carries
 *     REGULATOR_RECORD_NOTE) bounds the claim where the authorization is silent, because the regulator record is the authority for the
 *     population and setting reviewed. A registry entry or a publication never bounds, however many of them cover the claim.
 *   - Only study records supply measured results. Results at another operating point are not comparable.
 *   - Only the evidence types the claim declares required can support it. Other types are inspected for contrary material and
 *     explicit authorization limits only. Records of a source that is lost, empty or drifted are not read at all.
 *
 * Label precedence (the labels are not an ordered scale; this is the order in which the conditions are tested):
 *   1. CONTRADICTED_BY_SPECIFIED_EVIDENCE  an explicit authorization limit is exceeded, or a relevant, adequate study is wholly below the claim
 *   2. REQUIRES_DOMAIN_REVIEW              contrary material has no recorded disposition
 *   3. INSUFFICIENT_EVIDENCE               a required source is lost or absent, or a required dimension is unknown or not covered at all
 *   4. REQUIRES_DOMAIN_REVIEW              any other flag: unplaced term, joint coverage, hospital requirement, configured policy
 *   5. SUPPORTED_ONLY_FOR_NARROWER_SCOPE   some dimension is partly covered; the covered part is re-evaluated and stated
 *   6. SUPPORTED_FOR_SCOPE                 every required dimension is contained
 */

export { compile, compileDetailed, type CompileDetail, type DimensionReason } from "./compile.ts";
export { recompute, applyPatch, diffFindings, ClaimPatchSchema, type ClaimPatch, type Counterfactual, type FindingDiff } from "./counterfactual.ts";
export { staleFindings, supersede } from "./impact.ts";
export { describeAssessment, summarise } from "./explain.ts";
export { formatPurposeExclusion, parsePurposeExclusion, type PurposeExclusion, type PurposeExclusionStrength } from "./limits.ts";
export { CONDITION_SYNONYMS, NARROWING_MODIFIERS, normCondition, relateCondition, type ConditionRelation, type SynonymEntry } from "./conditions.ts";
export { REGULATOR_RECORD_NOTE } from "./pools.ts";
export { CompilerInputError, RuleVersionMismatchError, CompileOptionsSchema, type CompileOptions } from "./input.ts";
export { CompilerInvariantError } from "./engine.ts";
export { COMPILER_VERSION, RULES, RULE_BY_ID, UNIMPLEMENTED_REGISTRY_RULES, ruleOf, type Rule, type RuleTag } from "./rules.ts";
export { DEFAULT_PURPOSE_TAXONOMY, DEFAULT_SETTING_TAXONOMY, Hierarchy, TaxonomySchema, type Taxonomy, type TaxonomyInput } from "./taxonomy.ts";
export type { TraceStep } from "./types.ts";
