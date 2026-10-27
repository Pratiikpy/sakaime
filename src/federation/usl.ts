/**
 * The Sakaime semantic layer on Zetaris: one Unified Semantic Layer (USL) over the three silos, its data-quality rules, and the
 * code that builds it, reads it and judges it.
 *
 *   ensureUsl         administrator. Compiles the whole DDL in one request, activates each table with explicit casts, sets the
 *                     business descriptions, registers the rules, grants the roles. Idempotent: a second run changes nothing.
 *   queryUsl          the read-only agent identity. Reads tables, definitions and rule results through the layer.
 *   runCompletenessRule  the completeness gate, in two forms that must agree: RUN DQ over the collection manifest, and the code
 *                     check of checkCollectionCompleteness over the same rows.
 *
 * The layer names things the way a hospital reviewer says them (authorized_on, study_enrolled, claimed_age_min_years, an age
 * is years, a rate is a proportion from 0 to 1) instead of the way each silo happens to spell them, and it publishes the
 * compiler's own setting, purpose and metric vocabulary as a table (usl-terms.ts), so a second consumer reads the same words.
 *
 * Zetaris behaviour this file works around, each found on the installed 2.4.3.1 build (infra/zetaris/GATES.md):
 *   - a non-admin identity needs the SQL grant on the USL namespace AND a REST-side assignment of the USL instance to its role;
 *     there is no SQL form of the second, so ensureUsl asks its UslAdmin for it, and a rebuilt USL has a new id and loses it;
 *   - a refresh of a datasource deletes the policies on it, but a USL reads through the policies of the identity that queries
 *     it, so the layer needs no policy of its own and queryUsl never widens what the identity may see;
 *   - ACTIVATE USL TABLE refuses a column that would have to be downcast, and a NOT NULL key needs COALESCE, hence the casts;
 *   - one statement per request except COMPILE USL ... DDL, which must arrive whole;
 *   - descriptions are free text to the end of the statement, so they are limited to letters, digits, space and _ . , -.
 *
 * The DQ rules run on the engine as the caller. A rule that fails is a result (verdict FAILED, with counts); an engine that
 * cannot be asked is a PortError UNAVAILABLE. The two are never mixed: a failed rule must not read as an outage and an outage
 * must never read as a passed rule.
 */
import { PortError, type FederationResult } from "../ports/index.ts";
import { sha256Hex } from "../util/canonical.ts";
import {
  buildCompileUslSql,
  buildCreateNamespaceSql,
  buildLoadUslSql,
  checkCollectionCompleteness,
  COMPLETENESS_MANIFEST,
  COMPLETENESS_RULE,
  completenessExpression,
  DqExpression,
  parseRunDq,
  uslTablePath,
  type Completeness,
  type UslColumn,
  type UslTable,
} from "./dq.ts";
import type { FederationQueryOptionsEx } from "./result.ts";
import { sqlBoolean, sqlIdent, sqlList, sqlNumber, sqlQualified, sqlString, type SqlValue, sqlValue } from "./sql.ts";
import { buildTermRows, wordsOf, type TermDefinition, type TermSources } from "./usl-terms.ts";

export const USL_NAMESPACE = "sakaime";
export const USL_NAME = "review_semantics";
/** The name a table is queried by: lightning.metastore.<namespace>.<usl>.<table>. */
export const uslPath = (table?: string): string => sqlQualified("lightning", "metastore", USL_NAMESPACE, USL_NAME, ...(table ? [table] : []));

/** Roles of the Sakaime stack that may read the layer (infra/zetaris/scripts/seed.mjs). */
export const DEFAULT_USL_ROLES: readonly string[] = ["agent_readonly", "case_reviewer_assigned", "case_reviewer_unassigned"];

/** What a USL port must offer. ZetarisPort, CassettePort and the session ports of the service all fit. */
export interface UslSqlPort {
  sql(statement: string, options?: FederationQueryOptionsEx): Promise<FederationResult>;
}

// ---------------------------------------------------------------- specification

export type DqRuleKind = "completeness" | "record_completeness" | "range" | "identifier" | "vocabulary" | "definition";

export interface UslColumnSpec extends UslColumn {
  /** Business meaning, in the words a reviewer uses. Letters, digits, space and _ . , - only. */
  description: string;
}

export interface UslTableSpec {
  name: string;
  description: string;
  columns: UslColumnSpec[];
  /** The SELECT that binds the table to the silos. Explicit casts to the declared types; no WHERE that drops rows silently. */
  activation: string;
  /** The silo tables it reads, as Zetaris names them. */
  sources: readonly string[];
}

export interface UslRuleSpec {
  rule: string;
  table: string;
  expression: DqExpression;
  kind: DqRuleKind;
  description: string;
  /** What a failure means for the product, one sentence. A design statement, not a measurement. */
  consequence: string;
}

export interface CollectionRef {
  database: string;
  table: string;
}

export interface SemanticLayerSpec {
  usl: string;
  namespace: string;
  tables: UslTableSpec[];
  rules: UslRuleSpec[];
  terms: TermDefinition[];
  /** Hash of the structure (tables, columns, types, keys). A different value means the USL must be recompiled. */
  structureHash: string;
}

/** Silo tables whose landed size the completeness gate checks. Each needs a row in the collection manifest. */
export const MANIFEST_COLLECTIONS: readonly CollectionRef[] = [
  { database: "sk_registry", table: "fda_510k" },
  { database: "sk_registry", table: "fda_udi" },
  { database: "sk_registry", table: "fda_classification" },
  { database: "sk_registry", table: "ctgov_studies" },
  { database: "sk_registry", table: "pubmed_articles" },
  { database: "sk_vendor", table: "vendor_packets" },
  { database: "sk_vendor", table: "vendor_claims" },
];

/** The manifest silo table the setup script lands (infra/zetaris/scripts/usl.ts) and the layer reads. */
export const MANIFEST_SOURCE = "sk_registry.collection_manifest";

const DESCRIPTION_RE = /^[A-Za-z0-9 _.,-]+$/;
export function assertDescription(text: string, where: string): string {
  if (!DESCRIPTION_RE.test(text) || text.length > 400) {
    throw new PortError("INVALID", `description of ${where} must be 1 to 400 characters of letters, digits, space and _ . , -`, { reason: "BAD_DESCRIPTION" });
  }
  return text;
}

const c = (name: string, type: string, description: string, extra: Partial<UslColumn> = {}): UslColumnSpec => ({ name, type, description, ...extra });
const pk = (name: string, type: string, description: string): UslColumnSpec => c(name, type, description, { primaryKey: true });

/** Cast every SELECT item to its declared type. Keys get COALESCE because the engine refuses a possibly-null expression for NOT NULL. */
const cast = (expr: string, type: string, name: string, key = false): string => `CAST(${key ? `COALESCE(${expr}, '')` : expr} AS ${type.toUpperCase()}) AS ${name}`;

function proportionBoundsExpression(): DqExpression {
  return DqExpression.of(`unit IS NULL OR unit <> 'proportion' OR (value_min IS NOT NULL AND value_max IS NOT NULL AND value_min >= 0 AND value_max <= 1)`);
}

function termsValues(terms: readonly TermDefinition[]): string {
  const text = (v: string | null): string => (v === null ? "CAST(NULL AS STRING)" : sqlString(v));
  const num = (v: number | null): string => (v === null ? "CAST(NULL AS DECIMAL(4,2))" : `CAST(${sqlNumber(v)} AS DECIMAL(4,2))`);
  const bool = (v: boolean | null): string => (v === null ? "CAST(NULL AS BOOLEAN)" : `CAST(${sqlBoolean(v)} AS BOOLEAN)`);
  return terms
    .map(
      (t) =>
        `(${[
          sqlString(t.kind),
          sqlString(t.term),
          sqlString(t.canonical),
          bool(t.isAlias),
          sqlString(t.label),
          text(t.broader),
          sqlString(t.ancestry.join("|")),
          `CAST(${Math.max(0, t.ancestry.length - 1)} AS INT)`,
          sqlString(t.definition),
          text(t.unit),
          num(t.valueMin),
          num(t.valueMax),
          bool(t.prevalenceDependent),
          sqlString(t.source),
        ].join(", ")})`,
    )
    .join(", ");
}

function liveCounts(collections: readonly CollectionRef[]): string {
  return collections
    .map((r) => `SELECT ${sqlString(r.database)} AS database_name, ${sqlString(r.table)} AS table_name, count(*) AS live_total FROM ${sqlQualified(r.database, r.table)}`)
    .join(" UNION ALL ");
}

/** Build the whole specification from the compiler's vocabulary. Pure: no engine is contacted. */
export function buildSemanticLayer(vocabulary: TermSources, collections: readonly CollectionRef[] = MANIFEST_COLLECTIONS): SemanticLayerSpec {
  const terms = buildTermRows(vocabulary);

  const manifest: UslTableSpec = {
    name: COMPLETENESS_MANIFEST.name,
    description: assertDescription("One row per landed collection. expected_total is what landing recorded, retrieved_total is counted live, a short collection fails the completeness rule", "collection_manifest"),
    columns: [
      pk("collection_id", "varchar(200)", "Database and table of the collection, for example sk_registry.ctgov_studies"),
      c("source_id", "varchar(100)", "Source the collection was landed from"),
      c("expected_total", "bigint", "Records the source or the landing step said the collection holds. Empty means nobody said, which is unknown"),
      c("retrieved_total", "bigint", "Records counted now in the silo table. Empty means the layer cannot count the collection"),
      c("truncated", "boolean", "True when the connector reported that it stopped early"),
      c("landed_sha256", "varchar(64)", "Hash of the file that was landed"),
    ],
    activation: [
      `SELECT ${[
        cast("concat(m.database_name, '.', m.table_name)", "varchar(200)", "collection_id", true),
        cast("m.source_id", "varchar(100)", "source_id"),
        cast("m.expected_total", "bigint", "expected_total"),
        cast("n.live_total", "bigint", "retrieved_total"),
        cast("m.truncated", "boolean", "truncated"),
        cast("m.landed_sha256", "varchar(64)", "landed_sha256"),
      ].join(", ")}`,
      `FROM ${MANIFEST_SOURCE} m`,
      `LEFT JOIN (${liveCounts(collections)}) n ON n.database_name = m.database_name AND n.table_name = m.table_name`,
    ].join(" "),
    sources: [MANIFEST_SOURCE, ...collections.map((r) => `${r.database}.${r.table}`)],
  };

  const tables: UslTableSpec[] = [
    {
      name: "device_authorization",
      description: assertDescription("FDA premarket decisions for devices, one row per authorization, as openFDA lists them", "device_authorization"),
      columns: [
        pk("authorization_id", "varchar(20)", "FDA premarket number, for example K200667"),
        c("applicant_name", "varchar(200)", "Company that applied, as FDA spells it"),
        c("device_name", "varchar(200)", "Device name in the FDA record"),
        c("product_code", "varchar(10)", "FDA product code"),
        c("authorized_on", "date", "Date FDA made the decision"),
        c("authorization_pathway", "varchar(40)", "Pathway as openFDA names it, for example Traditional or Direct"),
      ],
      activation: `SELECT ${[
        cast("k.k_number", "varchar(20)", "authorization_id", true),
        cast("k.applicant", "varchar(200)", "applicant_name"),
        cast("k.device_name", "varchar(200)", "device_name"),
        cast("k.product_code", "varchar(10)", "product_code"),
        cast("k.decision_date", "date", "authorized_on"),
        cast("k.clearance_type", "varchar(40)", "authorization_pathway"),
      ].join(", ")} FROM sk_registry.fda_510k k`,
      sources: ["sk_registry.fda_510k"],
    },
    {
      name: "device_version_record",
      description: assertDescription("Software versions FDA lists for an authorization, one row per public device record", "device_version_record"),
      columns: [
        pk("device_record_key", "varchar(64)", "Public device record key from the FDA device identifier database"),
        c("authorization_id", "varchar(20)", "Authorization the record is filed under", { references: { table: "device_authorization", column: "authorization_id" } }),
        c("brand_name", "varchar(200)", "Brand name on the record"),
        c("listed_version", "varchar(100)", "Version or model number the record lists. A claim about another version is not covered by this record"),
        c("version_published_on", "date", "Date this version of the record was published"),
      ],
      activation: `SELECT ${[
        cast("u.public_device_record_key", "varchar(64)", "device_record_key", true),
        cast("u.submission_number", "varchar(20)", "authorization_id"),
        cast("u.brand_name", "varchar(200)", "brand_name"),
        cast("u.version_or_model_number", "varchar(100)", "listed_version"),
        cast("u.public_version_date", "date", "version_published_on"),
      ].join(", ")} FROM sk_registry.fda_udi u`,
      sources: ["sk_registry.fda_udi"],
    },
    {
      name: "registered_study",
      description: assertDescription("Clinical studies from the ClinicalTrials.gov snapshot, one row per registered study", "registered_study"),
      columns: [
        pk("study_id", "varchar(20)", "ClinicalTrials.gov identifier, for example NCT03112005"),
        c("title", "varchar(500)", "Brief title"),
        c("status", "varchar(40)", "Overall status as the registry reports it"),
        c("study_started", "varchar(20)", "Start date as written. Partial dates such as 2005-05 stay text"),
        c("study_enrolled", "int", "Participants enrolled, as the registry reports the count"),
        c("study_enrolled_age_min_years", "decimal(6,2)", "Youngest age the eligibility criteria admit, in years. Empty when the record has no eligibility block. Empty is unknown, never zero"),
        c("record_kind", "varchar(20)", "full_record, or search_summary when the record came from a search result and carries no eligibility block"),
      ],
      activation: `SELECT ${[
        cast("t.nct_id", "varchar(20)", "study_id", true),
        cast("t.brief_title", "varchar(500)", "title"),
        cast("t.overall_status", "varchar(40)", "status"),
        cast("t.start_date", "varchar(20)", "study_started"),
        cast("t.enrollment_count", "int", "study_enrolled"),
        cast("t.minimum_age_years", "decimal(6,2)", "study_enrolled_age_min_years"),
        cast("t.record_kind", "varchar(20)", "record_kind"),
      ].join(", ")} FROM sk_registry.ctgov_studies t`,
      sources: ["sk_registry.ctgov_studies"],
    },
    {
      name: "vendor_claim",
      description: assertDescription("Claims in vendor evidence packets, one row per claim. Commercial columns of the packet export are left out on purpose", "vendor_claim"),
      columns: [
        pk("claim_id", "varchar(20)", "Claim identifier in the packet"),
        c("packet_id", "varchar(20)", "Packet the claim sits in"),
        c("cited_authorization", "varchar(20)", "FDA premarket number the claim cites", { references: { table: "device_authorization", column: "authorization_id" } }),
        c("claimed_version", "varchar(20)", "Software version the claim is about"),
        c("claimed_age_min_years", "int", "Lowest age in years the claim covers. 0 means the claim names no lower bound"),
        c("claimed_setting", "varchar(100)", "Care setting or settings the claim covers, separated by a vertical bar"),
        c("claimed_purpose", "varchar(60)", "Intended purpose the claim states"),
        c("claimed_equipment", "varchar(100)", "Equipment the claim covers, for example a camera model"),
      ],
      activation: `SELECT ${[
        cast("v.claim_id", "varchar(20)", "claim_id", true),
        cast("v.packet_id", "varchar(20)", "packet_id"),
        cast("v.cited_submission", "varchar(20)", "cited_authorization"),
        cast("v.claimed_version", "varchar(20)", "claimed_version"),
        cast("v.claimed_min_age_years", "int", "claimed_age_min_years"),
        cast("v.claimed_setting", "varchar(100)", "claimed_setting"),
        cast("v.claimed_purpose", "varchar(60)", "claimed_purpose"),
        cast("v.claimed_camera", "varchar(100)", "claimed_equipment"),
      ].join(", ")} FROM sk_vendor.vendor_claims v`,
      sources: ["sk_vendor.vendor_claims"],
    },
    {
      name: "review_case",
      description: assertDescription("Hospital review cases with the vendor, the product and the intended use, one row per case. Constructed data", "review_case"),
      columns: [
        pk("case_id", "varchar(30)", "Hospital case identifier"),
        c("submission_id", "varchar(20)", "Vendor submission under review"),
        c("vendor_name", "varchar(200)", "Vendor name in the hospital record"),
        c("product_name", "varchar(100)", "Product under review"),
        c("product_version_claimed", "varchar(20)", "Version the vendor submitted"),
        c("packet_id", "varchar(20)", "Evidence packet of the submission"),
        c("cited_authorization", "varchar(20)", "FDA premarket number the submission cites", { references: { table: "device_authorization", column: "authorization_id" } }),
        c("intended_purpose", "varchar(60)", "Purpose the hospital intends to use the product for"),
        c("intended_setting", "varchar(60)", "Care setting the hospital intends to use it in"),
        c("intended_age_min_years", "int", "Youngest age in years of the patients the hospital intends to use it for"),
        c("deployment_date", "date", "Planned start of use"),
        c("case_state", "varchar(20)", "open or closed"),
      ],
      activation: [
        `SELECT ${[
          cast("c.case_id", "varchar(30)", "case_id", true),
          cast("c.submission_id", "varchar(20)", "submission_id"),
          cast("v.vendor_name", "varchar(200)", "vendor_name"),
          cast("s.product_name", "varchar(100)", "product_name"),
          cast("s.product_version_claimed", "varchar(20)", "product_version_claimed"),
          cast("s.packet_id", "varchar(20)", "packet_id"),
          cast("s.regulator_submission_cited", "varchar(20)", "cited_authorization"),
          cast("c.intended_purpose", "varchar(60)", "intended_purpose"),
          cast("c.intended_setting", "varchar(60)", "intended_setting"),
          cast("c.intended_min_age", "int", "intended_age_min_years"),
          cast("c.deployment_date", "date", "deployment_date"),
          cast("c.state", "varchar(20)", "case_state"),
        ].join(", ")}`,
        "FROM hospital.cases c JOIN hospital.submissions s ON s.submission_id = c.submission_id LEFT JOIN hospital.vendors v ON v.vendor_id = s.vendor_id",
      ].join(" "),
      sources: ["hospital.cases", "hospital.submissions", "hospital.vendors"],
    },
    {
      name: "hospital_requirement",
      description: assertDescription("What the hospital asks of a product for an intended purpose, one row per requirement. Constructed data", "hospital_requirement"),
      columns: [
        pk("requirement_id", "varchar(20)", "Requirement identifier"),
        c("applies_to_purpose", "varchar(60)", "Intended purpose the requirement applies to"),
        c("dimension", "varchar(60)", "What is required, for example validation_type or population_min_age"),
        c("comparator", "varchar(20)", "How the value is compared, for example equals or at_most"),
        c("required_value", "varchar(100)", "The value compared against"),
        c("policy_ref", "varchar(60)", "Policy the requirement comes from"),
        c("policy_version", "varchar(20)", "Version of that policy"),
        c("effective_on", "date", "Date the requirement took effect"),
      ],
      activation: `SELECT ${[
        cast("r.requirement_id", "varchar(20)", "requirement_id", true),
        cast("r.applies_to_purpose", "varchar(60)", "applies_to_purpose"),
        cast("r.dimension", "varchar(60)", "dimension"),
        cast("r.comparator", "varchar(20)", "comparator"),
        cast("r.required_value", "varchar(100)", "required_value"),
        cast("r.policy_ref", "varchar(60)", "policy_ref"),
        cast("r.policy_version", "varchar(20)", "policy_version"),
        cast("r.effective_date", "date", "effective_on"),
      ].join(", ")} FROM hospital.requirements r`,
      sources: ["hospital.requirements"],
    },
    {
      name: "confirmed_evidence_link",
      description: assertDescription("Links a reviewer made between a case and a public record, with the class the reviewer gave them", "confirmed_evidence_link"),
      columns: [
        pk("link_id", "varchar(20)", "Link identifier"),
        c("case_id", "varchar(30)", "Case the link belongs to"),
        c("left_type", "varchar(30)", "Kind of record on the left, for example fda_submission"),
        c("left_id", "varchar(40)", "Identifier of the left record"),
        c("right_type", "varchar(30)", "Kind of record on the right, for example ctgov_study"),
        c("right_id", "varchar(40)", "Identifier of the right record"),
        c("link_class", "varchar(20)", "CONFIRMED when a reviewer confirmed it, otherwise a candidate class"),
        c("confirmed_on", "date", "Date the reviewer decided"),
      ],
      activation: `SELECT ${[
        cast("l.link_id", "varchar(20)", "link_id", true),
        cast("l.case_id", "varchar(30)", "case_id"),
        cast("l.left_type", "varchar(30)", "left_type"),
        cast("l.left_id", "varchar(40)", "left_id"),
        cast("l.right_type", "varchar(30)", "right_type"),
        cast("l.right_id", "varchar(40)", "right_id"),
        cast("l.link_class", "varchar(20)", "link_class"),
        cast("l.confirmed_on", "date", "confirmed_on"),
      ].join(", ")} FROM hospital.evidence_links l`,
      sources: ["hospital.evidence_links"],
    },
    {
      name: "case_evidence_matrix",
      description: assertDescription("The three silos joined once per case and claim, so a consumer reads one table. Same logic as the Evidence Matrix statement", "case_evidence_matrix"),
      columns: [
        pk("matrix_key", "varchar(60)", "Case and claim, joined by a vertical bar"),
        c("case_id", "varchar(30)", "Hospital case"),
        c("claim_id", "varchar(20)", "Vendor claim on the case packet"),
        c("product_name", "varchar(100)", "Product under review"),
        c("authorization_id", "varchar(20)", "FDA premarket number the submission cites"),
        c("listed_versions", "varchar(400)", "Versions FDA lists for that authorization, separated by a vertical bar"),
        c("claimed_version", "varchar(20)", "Version the claim is about"),
        c("claimed_age_min_years", "int", "Lowest age in years the claim covers"),
        c("intended_age_min_years", "int", "Youngest age in years the hospital intends to use it for"),
        c("confirmed_studies", "int", "Studies a reviewer confirmed for the case"),
        c("study_enrolled_age_min_years", "decimal(6,2)", "Youngest age enrolled across the confirmed studies. Empty is unknown, never zero"),
        c("version_listed", "varchar(20)", "LISTED when the claimed version is among the listed versions, otherwise NOT_LISTED"),
        c("claim_age_vs_study", "varchar(40)", "CLAIM_BELOW_STUDY_MINIMUM when the claim reaches younger patients than the study enrolled, WITHIN_STUDY, or UNKNOWN"),
        c("case_age_vs_study", "varchar(40)", "NOT_COVERED_BY_STUDY when the hospital intends younger patients than the study enrolled, COVERED_BY_STUDY, or UNKNOWN"),
      ],
      activation: [
        `SELECT ${[
          cast("concat(c.case_id, '|', vc.claim_id)", "varchar(60)", "matrix_key", true),
          cast("c.case_id", "varchar(30)", "case_id"),
          cast("vc.claim_id", "varchar(20)", "claim_id"),
          cast("s.product_name", "varchar(100)", "product_name"),
          cast("k.k_number", "varchar(20)", "authorization_id"),
          cast("u.udi_versions", "varchar(400)", "listed_versions"),
          cast("vc.claimed_version", "varchar(20)", "claimed_version"),
          cast("vc.claimed_min_age_years", "int", "claimed_age_min_years"),
          cast("c.intended_min_age", "int", "intended_age_min_years"),
          cast("st.confirmed_studies", "int", "confirmed_studies"),
          cast("st.study_min_age_years", "decimal(6,2)", "study_enrolled_age_min_years"),
          cast("CASE WHEN instr(concat('|', coalesce(u.udi_versions, ''), '|'), concat('|', vc.claimed_version, '|')) > 0 THEN 'LISTED' ELSE 'NOT_LISTED' END", "varchar(20)", "version_listed"),
          cast("CASE WHEN st.study_min_age_years IS NULL THEN 'UNKNOWN' WHEN CAST(vc.claimed_min_age_years AS DOUBLE) < st.study_min_age_years THEN 'CLAIM_BELOW_STUDY_MINIMUM' ELSE 'WITHIN_STUDY' END", "varchar(40)", "claim_age_vs_study"),
          cast("CASE WHEN st.study_min_age_years IS NULL THEN 'UNKNOWN' WHEN CAST(c.intended_min_age AS DOUBLE) >= st.study_min_age_years THEN 'COVERED_BY_STUDY' ELSE 'NOT_COVERED_BY_STUDY' END", "varchar(40)", "case_age_vs_study"),
        ].join(", ")}`,
        "FROM hospital.cases c",
        "JOIN hospital.submissions s ON s.submission_id = c.submission_id",
        "JOIN sk_vendor.vendor_claims vc ON vc.packet_id = s.packet_id",
        "JOIN sk_registry.fda_510k k ON k.k_number = s.regulator_submission_cited",
        "LEFT JOIN (SELECT submission_number, concat_ws('|', sort_array(collect_set(version_or_model_number))) AS udi_versions FROM sk_registry.fda_udi GROUP BY submission_number) u ON u.submission_number = k.k_number",
        "LEFT JOIN (SELECT l.case_id, COUNT(DISTINCT t.nct_id) AS confirmed_studies, MIN(CAST(t.minimum_age_years AS DOUBLE)) AS study_min_age_years FROM hospital.evidence_links l JOIN sk_registry.ctgov_studies t ON t.nct_id = l.right_id WHERE l.link_class = 'CONFIRMED' AND l.right_type = 'ctgov_study' GROUP BY l.case_id) st ON st.case_id = c.case_id",
      ].join(" "),
      sources: ["hospital.cases", "hospital.submissions", "hospital.evidence_links", "sk_vendor.vendor_claims", "sk_registry.fda_510k", "sk_registry.fda_udi", "sk_registry.ctgov_studies"],
    },
    manifest,
    {
      name: "term_definition",
      description: assertDescription("The words the compiler reasons with, care settings and intended purposes and metrics, with where each sits and what it means", "term_definition"),
      columns: [
        pk("term_id", "varchar(100)", "Kind and word, joined by a colon"),
        c("kind", "varchar(20)", "setting, purpose, metric or population"),
        c("term", "varchar(100)", "The word as a source writes it"),
        c("canonical_term", "varchar(100)", "The node or metric the compiler reads that word as"),
        c("is_alias", "boolean", "True when the word is a spelling of another term"),
        c("label", "varchar(200)", "Plain label"),
        c("broader_term", "varchar(100)", "The next broader term, for settings and purposes"),
        c("ancestry", "varchar(400)", "Path from the broadest term to this one, separated by a vertical bar"),
        c("depth", "int", "Steps below the broadest term. 0 is the broadest"),
        c("definition", "varchar(1200)", "What the term means and what evidence established for it covers"),
        c("unit", "varchar(20)", "proportion for a rate from 0 to 1, years for an age"),
        c("value_min", "decimal(4,2)", "Lowest value the unit allows"),
        c("value_max", "decimal(4,2)", "Highest value the unit allows"),
        c("prevalence_dependent", "boolean", "True when the value changes with how common the condition is in the people tested"),
        c("origin", "varchar(100)", "Where the row comes from, taxonomy and version"),
      ],
      activation: `SELECT ${[
        cast("concat(t.kind, ':', t.term)", "varchar(100)", "term_id", true),
        cast("t.kind", "varchar(20)", "kind"),
        cast("t.term", "varchar(100)", "term"),
        cast("t.canonical_term", "varchar(100)", "canonical_term"),
        cast("t.is_alias", "boolean", "is_alias"),
        cast("t.label", "varchar(200)", "label"),
        cast("t.broader_term", "varchar(100)", "broader_term"),
        cast("t.ancestry", "varchar(400)", "ancestry"),
        cast("t.depth", "int", "depth"),
        cast("t.definition", "varchar(1200)", "definition"),
        cast("t.unit", "varchar(20)", "unit"),
        cast("t.value_min", "decimal(4,2)", "value_min"),
        cast("t.value_max", "decimal(4,2)", "value_max"),
        cast("t.prevalence_dependent", "boolean", "prevalence_dependent"),
        cast("t.origin", "varchar(100)", "origin"),
      ].join(", ")} FROM (VALUES ${termsValues(terms)}) AS t(kind, term, canonical_term, is_alias, label, broader_term, ancestry, depth, definition, unit, value_min, value_max, prevalence_dependent, origin)`,
      sources: ["compiler vocabulary"],
    },
  ];

  const settingWords = wordsOf(terms, "setting");
  const purposeWords = wordsOf(terms, "purpose");

  const rules: UslRuleSpec[] = [
    {
      rule: COMPLETENESS_RULE,
      table: COMPLETENESS_MANIFEST.name,
      expression: completenessExpression(),
      kind: "completeness",
      description: "A landed collection is complete only when its expected size is known, the whole of it is present, and the connector did not report stopping early",
      consequence: "A collection that fails feeds nothing downstream: its records are not used as evidence, and the finding that needed them is unresolved, not negative.",
    },
    {
      rule: "study_has_eligibility",
      table: "registered_study",
      expression: DqExpression.of("study_enrolled_age_min_years IS NOT NULL"),
      kind: "record_completeness",
      description: "A study record must carry an eligibility block, or its youngest enrolled age is unknown",
      consequence: "A study that fails cannot answer an age question. Unknown is never read as covered.",
    },
    {
      rule: "version_is_listed",
      table: "device_version_record",
      expression: DqExpression.of("listed_version IS NOT NULL AND listed_version <> ''"),
      kind: "identifier",
      description: "A device record must state the version it lists",
      consequence: "A record without a version cannot show that a claimed version is covered.",
    },
    {
      rule: "claimed_age_plausible",
      table: "vendor_claim",
      expression: DqExpression.of("claimed_age_min_years IS NOT NULL AND claimed_age_min_years BETWEEN 0 AND 120"),
      kind: "range",
      description: "A claim must state a lowest age between 0 and 120 years",
      consequence: "A claim with an impossible or missing age is held for a reviewer instead of being compared.",
    },
    {
      rule: "claim_cites_authorization",
      table: "vendor_claim",
      expression: DqExpression.of("cited_authorization IS NOT NULL AND cited_authorization <> ''"),
      kind: "identifier",
      description: "A claim must cite the FDA premarket number it relies on",
      consequence: "A claim that cites nothing has no regulator record to be checked against.",
    },
    {
      rule: "case_vocabulary_defined",
      table: "review_case",
      expression: DqExpression.of(`intended_setting IN ${sqlList(settingWords)} AND intended_purpose IN ${sqlList(purposeWords)}`),
      kind: "vocabulary",
      description: "A case must name its setting and purpose with words the term table defines",
      consequence: "A case in an unknown word cannot be placed on the hierarchy; it goes to a reviewer instead of being guessed.",
    },
    {
      rule: "metric_proportion_bounds",
      table: "term_definition",
      expression: proportionBoundsExpression(),
      kind: "definition",
      description: "A metric defined as a proportion must be bounded by 0 and 1",
      consequence: "A rate outside 0 to 1 would be read as a percentage by mistake.",
    },
  ];

  const structure = tables.map((t) => ({ name: t.name, columns: t.columns.map((col) => ({ name: col.name, type: col.type.toLowerCase(), pk: col.primaryKey === true, fk: col.references ? `${col.references.table}.${col.references.column}` : null })) }));
  return { usl: USL_NAME, namespace: USL_NAMESPACE, tables, rules, terms, structureHash: sha256Hex(JSON.stringify(structure)) };
}

/** The COMPILE USL statement for the layer: every table in one request. */
export function compileStatement(spec: SemanticLayerSpec): string {
  const tables: UslTable[] = spec.tables.map((t) => ({ name: t.name, columns: t.columns.map(({ description: _d, ...col }) => col) }));
  return buildCompileUslSql({ usl: spec.usl, namespace: spec.namespace, tables, deploy: true });
}

export const activateStatement = (spec: SemanticLayerSpec, table: UslTableSpec): string => `ACTIVATE USL TABLE ${uslTablePath({ namespace: spec.namespace, usl: spec.usl, table: table.name })} AS ${table.activation}`;

const layerDescription = (spec: SemanticLayerSpec): string => `sakaime_structure_${spec.structureHash.slice(0, 16)}`;

// ---------------------------------------------------------------- the model the engine reports

interface ModelColumn {
  name: string;
  description?: string;
}
interface ModelTable {
  name: string;
  description?: string;
  activateQuery?: string;
  columnSpecs: ModelColumn[];
  dqAnnotations: { name: string; expression: string }[];
}
interface UslModel {
  description?: string;
  tables: ModelTable[];
}

/** Read the JSON that LOAD USL returns. Anything else is DRIFTED: a layer is never assumed from a response that does not look like one. */
export function parseUslModel(result: FederationResult): UslModel {
  const cell = result.rows[0] ? Object.values(result.rows[0])[0] : undefined;
  let json: unknown;
  try {
    json = typeof cell === "string" ? JSON.parse(cell) : undefined;
  } catch {
    json = undefined;
  }
  const o = json as { description?: unknown; tables?: unknown } | undefined;
  if (!o || !Array.isArray(o.tables)) throw new PortError("DRIFTED", "LOAD USL no longer returns a model with a table list", { reason: "USL_MODEL_SHAPE" });
  const tables: ModelTable[] = (o.tables as Record<string, unknown>[]).map((t) => {
    const cols = Array.isArray(t["columnSpecs"]) ? (t["columnSpecs"] as Record<string, unknown>[]) : [];
    const dq = Array.isArray(t["dqAnnotations"]) ? (t["dqAnnotations"] as Record<string, unknown>[]) : [];
    return {
      name: String(t["name"]),
      ...(typeof t["description"] === "string" ? { description: t["description"] } : {}),
      ...(typeof t["activateQuery"] === "string" ? { activateQuery: t["activateQuery"] } : {}),
      columnSpecs: cols.map((col) => ({ name: String(col["name"]), ...(typeof col["description"] === "string" ? { description: col["description"] } : {}) })),
      dqAnnotations: dq.map((d) => ({ name: String(d["name"]), expression: String(d["expression"] ?? "") })),
    };
  });
  return { ...(typeof o.description === "string" ? { description: o.description } : {}), tables };
}

const squash = (s: string): string => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- ensureUsl

export interface UslAdmin {
  /** Runs as the administrator. ensureUsl passes statementPolicy "admin" on every call. */
  readonly port: UslSqlPort;
  /** POST /access-control/assign/role/usl. There is no SQL form of this assignment (GATES.md finding 4). */
  assignUslToRoles(uslId: number, roles: readonly string[]): Promise<void>;
}

export interface UslAction {
  step: "compile" | "rebuild" | "describe-layer" | "describe-table" | "describe-column" | "activate" | "register-rule" | "update-rule";
  target: string;
}

export interface EnsureReport {
  usl: string;
  path: string;
  uslId: number;
  /** Everything that changed on the engine. Empty on a second run. */
  actions: UslAction[];
  /** Objects found already correct. */
  kept: number;
  rebuilt: boolean;
  statements: number;
  elapsedMs: number;
}

export interface EnsureOptions {
  roles?: readonly string[];
  now?: () => number;
}

/**
 * Bring the engine to the specification and report what had to change. Safe to run twice: the second run sends only reads
 * and the role assignments, which the engine accepts repeatedly.
 */
export async function ensureUsl(admin: UslAdmin, spec: SemanticLayerSpec, options: EnsureOptions = {}): Promise<EnsureReport> {
  const now = options.now ?? (() => performance.now());
  const began = now();
  const actions: UslAction[] = [];
  let kept = 0;
  let statements = 0;
  const run = async (statement: string): Promise<FederationResult> => {
    statements += 1;
    return admin.port.sql(statement, { statementPolicy: "admin" });
  };
  const path = sqlQualified("lightning", "metastore", spec.namespace, spec.usl);
  const listing = async (): Promise<{ uslId: number | undefined }> => {
    const r = await run(`SHOW NAMESPACES OR TABLES IN ${sqlQualified("lightning", "metastore", spec.namespace)}`);
    const row = r.rows.find((x) => String(x["name"]) === spec.usl && String(x["type"]) === "usl");
    return { uslId: row ? Number(row["usl_id"]) : undefined };
  };

  // CREATE NAMESPACE IF NOT EXISTS changes nothing once the namespace exists, so it is not reported as an action.
  for (const statement of buildCreateNamespaceSql(spec.namespace)) await run(statement);

  let found = await listing();
  let model: UslModel | undefined;
  let rebuilt = false;
  if (found.uslId !== undefined) {
    model = parseUslModel(await run(buildLoadUslSql(spec.namespace, spec.usl)));
    const sameStructure = model.description === layerDescription(spec) && spec.tables.length === model.tables.length && spec.tables.every((t) => model!.tables.find((m) => m.name === t.name)?.columnSpecs.map((x) => x.name).join(",") === t.columns.map((x) => x.name).join(","));
    if (!sameStructure) {
      await run(`REMOVE USL ${sqlIdent(spec.usl)} NAMESPACE ${sqlQualified("lightning", "metastore", spec.namespace)}`);
      actions.push({ step: "rebuild", target: path });
      found = { uslId: undefined };
      model = undefined;
      rebuilt = true;
    }
  }
  if (found.uslId === undefined) {
    await run(compileStatement(spec));
    actions.push({ step: "compile", target: path });
    await run(`UPDATE USL ${path} SET DESCRIPTION ${assertDescription(layerDescription(spec), "the layer")}`);
    actions.push({ step: "describe-layer", target: path });
    found = await listing();
    if (found.uslId === undefined) throw new PortError("DRIFTED", "the USL was compiled but does not appear in the namespace listing", { reason: "USL_NOT_LISTED" });
    model = parseUslModel(await run(buildLoadUslSql(spec.namespace, spec.usl)));
  } else kept += 1;
  const uslId = found.uslId;
  const loaded = model!;

  // Descriptions are read from the model, so a table whose text is already right costs no statement.
  for (const table of spec.tables) {
    const m = loaded.tables.find((x) => x.name === table.name);
    const target = `${path}.${table.name}`;
    if (m?.description !== table.description) {
      await run(`UPDATE USL ${target} SET TABLE DESCRIPTION ${assertDescription(table.description, table.name)}`);
      actions.push({ step: "describe-table", target });
    } else kept += 1;
    for (const column of table.columns) {
      if (m?.columnSpecs.find((x) => x.name === column.name)?.description !== column.description) {
        await run(`UPDATE USL ${target}.${sqlIdent(column.name)} SET COLUMN DESCRIPTION ${assertDescription(column.description, `${table.name}.${column.name}`)}`);
        actions.push({ step: "describe-column", target: `${target}.${column.name}` });
      } else kept += 1;
    }
  }

  // Activation. The engine stores the query it was given; a different query (a changed taxonomy, a new silo column) reactivates.
  for (const table of spec.tables) {
    const m = loaded.tables.find((x) => x.name === table.name);
    if (m?.activateQuery !== undefined && squash(m.activateQuery) === squash(table.activation)) {
      kept += 1;
      continue;
    }
    await run(activateStatement(spec, table));
    actions.push({ step: "activate", target: `${path}.${table.name}` });
  }

  // Rules. Registered if missing, updated if the expression differs, left alone otherwise. A rule the specification does not
  // name is not removed: someone may have added it on purpose.
  for (const rule of spec.rules) {
    const m = loaded.tables.find((x) => x.name === rule.table);
    const have = m?.dqAnnotations.find((d) => d.name === rule.rule);
    const target = `${path}.${rule.table}`;
    if (!have) {
      await run(`REGISTER DQ ${sqlIdent(rule.rule)} TABLE ${target} AS ${rule.expression.sql}`);
      actions.push({ step: "register-rule", target: `${rule.rule} on ${rule.table}` });
    } else if (squash(have.expression) !== squash(rule.expression.sql)) {
      await run(`UPDATE DQ ${sqlIdent(rule.rule)} TABLE ${target} SET NAME = ${sqlIdent(rule.rule)}, EXPRESSION = ${rule.expression.sql}`);
      actions.push({ step: "update-rule", target: `${rule.rule} on ${rule.table}` });
    } else kept += 1;
  }

  // Access. The SQL grant is idempotent; so is the REST assignment, and a rebuilt USL has a new id that needs it again.
  const roles = options.roles ?? DEFAULT_USL_ROLES;
  for (const role of roles) {
    try {
      await run(`GRANT SELECT ON USL NAMESPACE ${sqlQualified("lightning", "metastore", spec.namespace)} TO ROLE ${sqlString(role)}`);
    } catch (e) {
      if (!(e instanceof PortError && /already/i.test(e.message))) throw e;
    }
  }
  // Repeated on every run and not reported as a change: the engine gives no way to read the assignment back.
  await admin.assignUslToRoles(uslId, roles);

  const state = await run(`SHOW NAMESPACES OR TABLES IN ${path}`);
  const inactive = spec.tables.filter((t) => !state.rows.some((r) => String(r["name"]) === t.name && String(r["activated"]) === "true")).map((t) => t.name);
  if (inactive.length > 0) throw new PortError("DRIFTED", `after setup these USL tables are not activated: ${inactive.join(", ")}`, { reason: "USL_NOT_ACTIVATED", tables: inactive });

  return { usl: spec.usl, path, uslId, actions, kept, rebuilt, statements, elapsedMs: Math.round(now() - began) };
}

// ---------------------------------------------------------------- reading the layer

export interface UslColumnInfo {
  name: string;
  type: string;
  description: string;
}
export interface UslTableInfo {
  name: string;
  description: string;
  activated: boolean;
  rows: number | null;
  columns: UslColumnInfo[];
  sources: string[];
  primaryKey: string | null;
}

export interface UslStatementTrace {
  statement: string;
  queryId: string;
  rows: number;
  elapsedMs: number;
  servedFrom: FederationResult["servedFrom"];
}

/** Wraps a port so that every statement a read sends is listed with its query id. The service shows this list as the trace. */
export class TracedPort implements UslSqlPort {
  readonly traces: UslStatementTrace[] = [];
  /** When each replayed response was recorded, for a port that replays recordings. Empty for a live port. */
  readonly recordedAt: string[] = [];
  constructor(private readonly inner: UslSqlPort) {}
  async sql(statement: string, options?: FederationQueryOptionsEx): Promise<FederationResult> {
    const r = await this.inner.sql(statement, options);
    this.traces.push({ statement: statement.replace(/\s+/g, " ").trim(), queryId: r.queryId, rows: r.rows.length, elapsedMs: r.elapsedMs, servedFrom: r.servedFrom });
    const at = (r as { recordedAt?: unknown }).recordedAt;
    if (typeof at === "string") this.recordedAt.push(at);
    return r;
  }
}

const TYPE_DISPLAY: Record<string, string> = { long: "bigint", integer: "int", short: "smallint", byte: "tinyint", string: "varchar" };
function displayType(raw: string): string {
  let t = raw;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "string") t = parsed;
  } catch {
    /* already plain */
  }
  return TYPE_DISPLAY[t] ?? t;
}

const COUNT_SCHEMA = { n: "bigint" } as const;
const asCount = (v: unknown, what: string): number => {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) throw new PortError("DRIFTED", `${what} is not a count: ${JSON.stringify(v)}`, { reason: "COUNT_SHAPE" });
  return n;
};

export interface UslLayerRead {
  tables: UslTableInfo[];
}

/** Tables, columns with their descriptions, activation state and live row counts, read as the caller. */
export async function readLayerTables(reader: UslSqlPort, spec: SemanticLayerSpec): Promise<UslTableInfo[]> {
  const path = sqlQualified("lightning", "metastore", spec.namespace, spec.usl);
  const state = await reader.sql(`SHOW NAMESPACES OR TABLES IN ${path}`);
  const model = parseUslModel(await reader.sql(buildLoadUslSql(spec.namespace, spec.usl)));
  const counts = await reader.sql(
    spec.tables.map((t) => `SELECT ${sqlString(t.name)} AS table_name, count(*) AS n FROM ${uslPath(t.name)}`).join(" UNION ALL "),
    { schema: COUNT_SCHEMA },
  );
  return spec.tables.map((t) => {
    const m = model.tables.find((x) => x.name === t.name);
    if (!m) throw new PortError("DRIFTED", `the layer has no table ${t.name}; run ensureUsl`, { reason: "USL_TABLE_MISSING", table: t.name });
    const activated = state.rows.some((r) => String(r["name"]) === t.name && String(r["activated"]) === "true");
    const row = counts.rows.find((r) => String(r["table_name"]) === t.name);
    const specCols = new Map(t.columns.map((col) => [col.name, col]));
    return {
      name: t.name,
      description: m.description ?? t.description,
      activated,
      rows: row ? asCount(row["n"], `count of ${t.name}`) : null,
      columns: m.columnSpecs.map((col) => ({ name: col.name, type: specCols.get(col.name)?.type ?? "", description: col.description ?? specCols.get(col.name)?.description ?? "" })),
      sources: [...t.sources],
      primaryKey: t.columns.find((col) => col.primaryKey)?.name ?? null,
    };
  });
}

export interface UslSelect {
  table: string;
  columns?: readonly string[];
  /** Equality filters, ANDed. Values go through sqlValue, never into the text. */
  where?: Readonly<Record<string, SqlValue>>;
  orderBy?: readonly string[];
  limit?: number;
}

/** A read of one USL table by name. Names are checked against the specification, so a typo is an error, not an empty answer. */
export async function queryUsl(reader: UslSqlPort, spec: SemanticLayerSpec, select: UslSelect, schema?: Readonly<Record<string, string>>): Promise<FederationResult> {
  const table = spec.tables.find((t) => t.name === select.table);
  if (!table) throw new PortError("INVALID", `the layer has no table ${select.table.slice(0, 60)}`, { reason: "UNKNOWN_TABLE" });
  const known = new Set(table.columns.map((col) => col.name));
  for (const name of [...(select.columns ?? []), ...Object.keys(select.where ?? {}), ...(select.orderBy ?? [])]) {
    if (!known.has(name)) throw new PortError("INVALID", `${table.name} has no column ${name.slice(0, 60)}`, { reason: "UNKNOWN_COLUMN" });
  }
  const cols = select.columns && select.columns.length > 0 ? select.columns.map(sqlIdent).join(", ") : "*";
  const where = Object.entries(select.where ?? {}).map(([k, v]) => (v === null ? `${sqlIdent(k)} IS NULL` : `${sqlIdent(k)} = ${sqlValue(v)}`));
  const typed = schema ?? Object.fromEntries(table.columns.map((col) => [col.name, col.type]));
  return reader.sql(
    `SELECT ${cols} FROM ${uslPath(table.name)}${where.length > 0 ? ` WHERE ${where.join(" AND ")}` : ""}${select.orderBy && select.orderBy.length > 0 ? ` ORDER BY ${select.orderBy.map(sqlIdent).join(", ")}` : ""}`,
    { ...(select.limit ? { limit: select.limit } : {}), schema: typed },
  );
}

// ---------------------------------------------------------------- definitions

export interface UslDefinition {
  kind: TermDefinition["kind"];
  term: string;
  canonical: string;
  isAlias: boolean;
  label: string;
  broader: string | null;
  ancestry: string[];
  definition: string;
  unit: string | null;
  valueMin: number | null;
  valueMax: number | null;
  prevalenceDependent: boolean | null;
  source: string;
}

const DEFINITION_SCHEMA = { depth: "integer", is_alias: "boolean", value_min: "double", value_max: "double", prevalence_dependent: "boolean" } as const;
const DEFINITION_COLUMNS = "d.kind, d.term, d.canonical_term, d.is_alias, d.label, d.broader_term, d.ancestry, d.depth, d.definition, d.unit, d.value_min, d.value_max, d.prevalence_dependent, d.origin";

function toDefinition(row: Record<string, unknown>): UslDefinition {
  const text = (v: unknown): string | null => (v === null || v === undefined || v === "" ? null : String(v));
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return {
    kind: String(row["kind"]) as UslDefinition["kind"],
    term: String(row["term"]),
    canonical: String(row["canonical_term"]),
    isAlias: row["is_alias"] === true,
    label: String(row["label"]),
    broader: text(row["broader_term"]),
    ancestry: String(row["ancestry"] ?? "") === "" ? [] : String(row["ancestry"]).split("|"),
    definition: String(row["definition"]),
    unit: text(row["unit"]),
    valueMin: num(row["value_min"]),
    valueMax: num(row["value_max"]),
    prevalenceDependent: row["prevalence_dependent"] === null || row["prevalence_dependent"] === undefined ? null : row["prevalence_dependent"] === true,
    source: String(row["origin"]),
  };
}

/** Every canonical term (no aliases), for the overview. */
export async function readAllDefinitions(reader: UslSqlPort): Promise<UslDefinition[]> {
  const r = await reader.sql(`SELECT ${DEFINITION_COLUMNS} FROM ${uslPath("term_definition")} d WHERE d.is_alias = FALSE ORDER BY d.kind, d.depth, d.term`, { schema: DEFINITION_SCHEMA });
  return r.rows.map(toDefinition);
}

export interface UslCaseRow {
  caseId: string;
  productName: string;
  setting: string;
  purpose: string;
  ageMinYears: number | null;
}

/** The case as the layer holds it. An unknown case is a 404-class error, never an empty success. */
export async function readCaseRow(reader: UslSqlPort, caseId: string): Promise<UslCaseRow> {
  const r = await reader.sql(
    `SELECT case_id, product_name, intended_setting, intended_purpose, intended_age_min_years FROM ${uslPath("review_case")} WHERE case_id = ${sqlString(caseId)}`,
    { schema: { intended_age_min_years: "integer" } },
  );
  const row = r.rows[0];
  if (!row) throw new PortError("INVALID", `the semantic layer holds no case ${caseId.slice(0, 40)}`, { reason: "UNKNOWN_CASE" });
  return { caseId: String(row["case_id"]), productName: String(row["product_name"]), setting: String(row["intended_setting"]), purpose: String(row["intended_purpose"]), ageMinYears: row["intended_age_min_years"] === null ? null : Number(row["intended_age_min_years"]) };
}

export interface CaseDefinitions {
  case: UslCaseRow;
  definitions: UslDefinition[];
  /** Words the case (or the metric list) names that the layer does not define. A missing definition is reported, never skipped. */
  unresolved: { kind: "setting" | "purpose" | "metric"; term: string }[];
}

/**
 * The definitions a case needs: its care setting and its purpose with every broader term above them, and the metrics it asks
 * about. `metrics` are canonical metric names (the compiler's normMetric output). One statement for the definitions, one for
 * the case row. Words the layer cannot place come back in `unresolved`.
 */
export async function readCaseDefinitions(reader: UslSqlPort, caseId: string, metrics: readonly string[] = []): Promise<CaseDefinitions> {
  const row = await readCaseRow(reader, caseId);
  const hierarchy = (kind: "setting" | "purpose", column: string): string =>
    `SELECT ${DEFINITION_COLUMNS} FROM ${uslPath("review_case")} c JOIN ${uslPath("term_definition")} a ON a.kind = '${kind}' AND a.term = c.${column} JOIN ${uslPath("term_definition")} d ON d.kind = '${kind}' AND d.is_alias = FALSE AND instr(concat('|', a.ancestry, '|'), concat('|', d.term, '|')) > 0 WHERE c.case_id = ${sqlString(caseId)}`;
  const wanted = [...new Set(metrics.map((m) => m.toLowerCase()))];
  const metricSelect = wanted.length === 0 ? "" : ` UNION ALL SELECT ${DEFINITION_COLUMNS} FROM ${uslPath("term_definition")} d WHERE d.kind = 'metric' AND d.is_alias = FALSE AND d.term IN ${sqlList(wanted)}`;
  const r = await reader.sql(`${hierarchy("setting", "intended_setting")} UNION ALL ${hierarchy("purpose", "intended_purpose")}${metricSelect} ORDER BY kind, depth, term`, { schema: DEFINITION_SCHEMA });
  const definitions = r.rows.map(toDefinition);
  const unresolved: CaseDefinitions["unresolved"] = [];
  if (!definitions.some((d) => d.kind === "setting")) unresolved.push({ kind: "setting", term: row.setting });
  if (!definitions.some((d) => d.kind === "purpose")) unresolved.push({ kind: "purpose", term: row.purpose });
  for (const m of wanted) if (!definitions.some((d) => d.kind === "metric" && d.term === m)) unresolved.push({ kind: "metric", term: m });
  return { case: row, definitions, unresolved };
}

// ---------------------------------------------------------------- data-quality rules

export type RuleVerdict = "PASSED" | "FAILED" | "UNVERIFIABLE";

export interface RuleReport {
  rule: string;
  table: string;
  kind: DqRuleKind;
  description: string;
  expression: string;
  consequence: string;
  rowsChecked: number;
  failures: number;
  /** PASSED: every row valid. FAILED: at least one row invalid. UNVERIFIABLE: the engine answered with no rows to judge. */
  verdict: RuleVerdict;
  queryId: string;
  elapsedMs: number;
}

/** Run one registered rule as the caller. The engine being unreachable throws; a rule that fails returns verdict FAILED. */
export async function runRule(reader: UslSqlPort, rule: UslRuleSpec): Promise<RuleReport> {
  const statement = `RUN DQ ${sqlIdent(rule.rule)} TABLE ${uslPath(rule.table)}`;
  const result = await reader.sql(statement);
  const parsed = parseRunDq(result).filter((p) => p.rule === undefined || p.rule === rule.rule);
  if (parsed.length !== 1) throw new PortError("DRIFTED", `RUN DQ ${rule.rule} returned ${parsed.length} results, expected one`, { reason: "DQ_SHAPE", rule: rule.rule });
  const p = parsed[0]!;
  if (p.valid + p.invalid !== p.total) throw new PortError("DRIFTED", `RUN DQ ${rule.rule}: ${p.valid} valid plus ${p.invalid} invalid is not ${p.total}`, { reason: "DQ_ARITHMETIC", rule: rule.rule });
  return {
    rule: rule.rule,
    table: rule.table,
    kind: rule.kind,
    description: rule.description,
    expression: rule.expression.sql,
    consequence: rule.consequence,
    rowsChecked: p.total,
    failures: p.invalid,
    verdict: p.total === 0 ? "UNVERIFIABLE" : p.invalid > 0 ? "FAILED" : "PASSED",
    queryId: result.queryId,
    elapsedMs: result.elapsedMs,
  };
}

/** All rules of the specification, a few at a time. Order of the result is the order of the specification. */
export async function runRules(reader: UslSqlPort, spec: SemanticLayerSpec, concurrency = 3): Promise<RuleReport[]> {
  const out: RuleReport[] = new Array(spec.rules.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= spec.rules.length) return;
      out[i] = await runRule(reader, spec.rules[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, spec.rules.length) }, worker));
  return out;
}

// ---------------------------------------------------------------- the completeness gate

export interface CollectionCheck {
  collectionId: string;
  sourceId: string | null;
  expectedTotal: number | null;
  retrievedTotal: number | null;
  truncatedByConnector: boolean | null;
  status: Completeness["status"];
  reason: string | null;
}

export interface CompletenessReport {
  rule: typeof COMPLETENESS_RULE;
  table: string;
  rowsChecked: number;
  failures: number;
  verdict: RuleVerdict;
  /** The RUN DQ statement, whose query id is the engine's own witness. */
  queryId: string;
  elapsedMs: number;
  collections: CollectionCheck[];
  /** Collections that may feed evidence downstream. */
  complete: string[];
  /** Collections that may not: short, cut by the connector, or of unknown size. */
  blocked: string[];
  /** True when the engine's count of failures equals the code check's. A disagreement is thrown as DRIFTED, not reported as false. */
  codeCheckAgrees: boolean;
}

const MANIFEST_SCHEMA = { expected_total: "bigint", retrieved_total: "bigint", truncated: "boolean" } as const;

/**
 * The completeness gate in both forms. RUN DQ decides on the engine; checkCollectionCompleteness decides again in code over
 * the same manifest rows. If they disagree the layer or the code is wrong, and that is thrown (DRIFTED) rather than guessed.
 * A collection that is not demonstrably complete is blocked.
 */
export async function runCompletenessRule(reader: UslSqlPort, spec: SemanticLayerSpec): Promise<CompletenessReport> {
  const rule = spec.rules.find((r) => r.rule === COMPLETENESS_RULE);
  if (!rule) throw new PortError("INVALID", "the specification has no completeness rule", { reason: "NO_COMPLETENESS_RULE" });
  const report = await runRule(reader, rule);
  const manifest = await reader.sql(`SELECT collection_id, source_id, expected_total, retrieved_total, truncated FROM ${uslPath(COMPLETENESS_MANIFEST.name)} ORDER BY collection_id`, { schema: MANIFEST_SCHEMA });
  const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  const collections: CollectionCheck[] = manifest.rows.map((row) => {
    const retrievedTotal = num(row["retrieved_total"]);
    const expectedTotal = num(row["expected_total"]);
    const truncated = row["truncated"] === null || row["truncated"] === undefined ? null : row["truncated"] === true;
    // A collection the layer cannot count is not "zero records": the size is unknown, which the check treats as not complete.
    // The manifest rule demands a recorded expected size. checkCollectionCompleteness alone would accept a connector that reached the
    // end of a source that reported no total; for a landed collection that is not enough, so the two forms are made to agree here.
    const verdict: Completeness =
      retrievedTotal === null
        ? { status: "UNVERIFIABLE", reason: "the layer cannot count this collection" }
        : expectedTotal === null
          ? truncated === true
            ? { status: "TRUNCATED", reason: "the connector flagged the collection as cut short" }
            : { status: "UNVERIFIABLE", reason: "no expected size was recorded for this collection" }
          : checkCollectionCompleteness({ retrieved: retrievedTotal, expectedTotal, truncated });
    const unmet = verdict.status === "COMPLETE" && truncated === null ? ({ status: "UNVERIFIABLE", reason: "the connector did not say whether it stopped early" } as const) : verdict;
    return {
      collectionId: String(row["collection_id"]),
      sourceId: row["source_id"] === null ? null : String(row["source_id"]),
      expectedTotal,
      retrievedTotal,
      truncatedByConnector: truncated,
      status: unmet.status,
      reason: "reason" in unmet ? unmet.reason : null,
    };
  });
  const codeFailures = collections.filter((x) => x.status !== "COMPLETE").length;
  if (collections.length !== report.rowsChecked || codeFailures !== report.failures) {
    throw new PortError("DRIFTED", `the completeness rule disagrees with its code check: the engine counts ${report.failures} of ${report.rowsChecked} failing, the code ${codeFailures} of ${collections.length}`, {
      reason: "RULE_DISAGREEMENT",
      engine: { rows: report.rowsChecked, failures: report.failures },
      code: { rows: collections.length, failures: codeFailures },
    });
  }
  return {
    rule: COMPLETENESS_RULE,
    table: rule.table,
    rowsChecked: report.rowsChecked,
    failures: report.failures,
    verdict: report.verdict,
    queryId: report.queryId,
    elapsedMs: report.elapsedMs,
    collections,
    complete: collections.filter((x) => x.status === "COMPLETE").map((x) => x.collectionId),
    blocked: collections.filter((x) => x.status !== "COMPLETE").map((x) => x.collectionId),
    codeCheckAgrees: true,
  };
}

/** The gate for a consumer: throws unless every named collection is demonstrably complete. */
export function requireComplete(report: CompletenessReport, needed: readonly string[]): void {
  const blocked = needed.filter((id) => !report.complete.includes(id));
  if (blocked.length > 0) {
    throw new PortError("TRUNCATED", `these collections are not demonstrably complete and feed nothing downstream: ${blocked.join(", ")}`, { reason: "COLLECTION_NOT_COMPLETE", blocked });
  }
}

// ---------------------------------------------------------------- the collection manifest file

export interface ManifestEntry {
  database: string;
  table: string;
  sourceId: string;
  /** What the landing step recorded, or the source reported. Null when nobody said. */
  expectedTotal: number | null;
  truncated: boolean;
  landedSha256: string;
}

/** The CSV the setup script lands as sk_registry.collection_manifest. A null total is written as an empty field. */
export function manifestCsv(entries: readonly ManifestEntry[]): string {
  const header = "database_name,table_name,source_id,expected_total,truncated,landed_sha256";
  const rows = entries.map((e) => [e.database, e.table, e.sourceId, e.expectedTotal === null ? "" : String(e.expectedTotal), String(e.truncated), e.landedSha256].map(csvField).join(","));
  return `${[header, ...rows].join("\n")}\n`;
}

function csvField(v: string): string {
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}
