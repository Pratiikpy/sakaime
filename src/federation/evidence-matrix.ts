/**
 * Statement builders for the Evidence Matrix (docs/03-zetaris-plan.md s4).
 *
 * Two statements, both portable between Spark SQL and DuckDB so the oracle can run them unchanged:
 *   buildEvidenceMatrixSql  one summary row per (submission, hospital requirement). Each silo is aggregated in
 *                           its own subquery BEFORE the join, so a submission with several authorizations, several
 *                           studies and many vendor claims cannot multiply rows (the fan-out that overstated spend
 *                           three-fold in the sibling project's first three-silo join).
 *   buildEvidenceRowsSql    the same evidence as long-form rows, one per source record, each carrying its source
 *                           system and table, so the Matrix can keep provenance instead of collapsing it.
 *
 * Links are used only to retrieve candidates. A candidate link is counted separately from a confirmed one and is
 * never folded into it: resolution belongs to the identity layer, not to this join.
 *
 * Nothing a user types reaches SQL except through sqlString/sqlDate; names come from silo-layout.ts only.
 */
import { PortError } from "../ports/index.ts";
import { declaredSchemaFor, qualifiedName, SILOS } from "./silo-layout.ts";
import { sqlDate, sqlString } from "./sql.ts";

export interface IntendedUse {
  /** Care setting the reviewer has in mind, as written in the hospital requirements table. */
  setting: string;
  purpose: string;
}

export interface EvidenceMatrixInput {
  /** Exact submission id when known; otherwise the device name (and optionally version) is matched case-insensitively. */
  submissionId?: string;
  deviceName?: string;
  deviceVersion?: string;
  intendedUse: IntendedUse;
  /** YYYY-MM-DD. Records dated after it are left out, so a past review can be reproduced. */
  asOf?: string;
}

function text(name: string, value: string | undefined, required: boolean): string | undefined {
  if (value === undefined) {
    if (required) throw new PortError("INVALID", `${name} is required`, { reason: "MISSING_INPUT" });
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 500) {
    throw new PortError("INVALID", `${name} must be 1 to 500 characters`, { reason: "BAD_INPUT" });
  }
  return trimmed;
}

/** Predicate over alias `s` (hospital.submissions) selecting the submission under review. */
function submissionPredicate(input: EvidenceMatrixInput, alias: string): string {
  const id = text("submissionId", input.submissionId, false);
  const name = text("deviceName", input.deviceName, false);
  if (id === undefined && name === undefined) {
    throw new PortError("INVALID", "give a submissionId or a deviceName", { reason: "MISSING_INPUT" });
  }
  if (id !== undefined) return `${alias}.submission_id = ${sqlString(id)}`;
  const version = text("deviceVersion", input.deviceVersion, false);
  const parts = [`lower(${alias}.device_name) = lower(${sqlString(name!)})`];
  if (version !== undefined) parts.push(`lower(${alias}.device_version) = lower(${sqlString(version)})`);
  return parts.join(" AND ");
}

function intendedUsePredicate(use: IntendedUse, alias: string): string {
  const setting = text("intendedUse.setting", use?.setting, true)!;
  const purpose = text("intendedUse.purpose", use?.purpose, true)!;
  return `lower(${alias}.setting) = lower(${sqlString(setting)}) AND lower(${alias}.purpose) = lower(${sqlString(purpose)})`;
}

const SUBMISSIONS = qualifiedName(SILOS.submissions);
const REQUIREMENTS = qualifiedName(SILOS.requirements);
const VENDORS = qualifiedName(SILOS.vendors);
const LINKS = qualifiedName(SILOS.identityLinks);
const AUTHORIZATIONS = qualifiedName(SILOS.authorizations);
const STUDIES = qualifiedName(SILOS.studies);
const CLAIMS = qualifiedName(SILOS.claims);

/** Submissions the subqueries are restricted to, so no silo is aggregated beyond the submission under review. */
function scopedSubmissionIds(input: EvidenceMatrixInput): string {
  return `(SELECT sx.submission_id FROM ${SUBMISSIONS} sx WHERE ${submissionPredicate(input, "sx")})`;
}

export function buildEvidenceMatrixSql(input: EvidenceMatrixInput): string {
  const asOf = input.asOf === undefined ? undefined : sqlDate(input.asOf);
  const scope = scopedSubmissionIds(input);
  const authzAsOf = asOf ? ` AND a.decision_date <= ${asOf}` : "";
  const studyAsOf = asOf ? ` AND st.start_date <= ${asOf}` : "";

  const regulator =
    `SELECT l.from_id AS submission_id, ` +
    `SUM(CASE WHEN l.state = 'CONFIRMED' THEN 1 ELSE 0 END) AS regulator_confirmed, ` +
    `SUM(CASE WHEN l.state IN ('CANDIDATE', 'AMBIGUOUS') THEN 1 ELSE 0 END) AS regulator_candidates, ` +
    `MAX(CASE WHEN l.state = 'CONFIRMED' THEN a.decision_date END) AS regulator_latest_decision ` +
    `FROM ${LINKS} l JOIN ${AUTHORIZATIONS} a ON a.authorization_id = l.to_id ` +
    `WHERE l.to_system = 'regulator' AND l.link_type = 'SAME_SUBMISSION' AND l.from_id IN ${scope}${authzAsOf} ` +
    `GROUP BY l.from_id`;

  const registry =
    `SELECT l.from_id AS submission_id, ` +
    `SUM(CASE WHEN l.state = 'CONFIRMED' THEN 1 ELSE 0 END) AS registry_confirmed, ` +
    `SUM(CASE WHEN l.state IN ('CANDIDATE', 'AMBIGUOUS') THEN 1 ELSE 0 END) AS registry_candidates, ` +
    `SUM(CASE WHEN l.state = 'CONFIRMED' THEN st.enrollment END) AS registry_confirmed_enrollment, ` +
    `MAX(CASE WHEN l.state = 'CONFIRMED' THEN st.completion_date END) AS registry_latest_completion ` +
    `FROM ${LINKS} l JOIN ${STUDIES} st ON st.nct_id = l.to_id ` +
    `WHERE l.to_system = 'registry' AND l.link_type = 'STUDY_EVALUATES' AND l.from_id IN ${scope}${studyAsOf} ` +
    `GROUP BY l.from_id`;

  const packets = `(SELECT sp.packet_id FROM ${SUBMISSIONS} sp WHERE ${submissionPredicate(input, "sp")})`;
  const claimsAll =
    `SELECT c.packet_id AS packet_id, COUNT(*) AS vendor_claims FROM ${CLAIMS} c WHERE c.packet_id IN ${packets} GROUP BY c.packet_id`;
  const claimsForVersion =
    `SELECT c.packet_id AS packet_id, c.device_version AS device_version, COUNT(*) AS vendor_claims_for_version ` +
    `FROM ${CLAIMS} c WHERE c.packet_id IN ${packets} GROUP BY c.packet_id, c.device_version`;

  return (
    `SELECT s.submission_id AS submission_id, v.vendor_name AS vendor_name, s.device_name AS device_name, ` +
    `s.device_version AS device_version, s.packet_id AS packet_id, s.claimed_setting AS claimed_setting, ` +
    `s.claimed_population AS claimed_population, s.claimed_purpose AS claimed_purpose, ` +
    `q.requirement_id AS requirement_id, q.setting AS required_setting, q.purpose AS required_purpose, ` +
    `q.min_validation_type AS min_validation_type, q.subgroup_reporting_required AS subgroup_reporting_required, ` +
    `q.update_control_required AS update_control_required, ` +
    `COALESCE(r.regulator_confirmed, 0) AS regulator_confirmed, COALESCE(r.regulator_candidates, 0) AS regulator_candidates, ` +
    `r.regulator_latest_decision AS regulator_latest_decision, ` +
    `COALESCE(g.registry_confirmed, 0) AS registry_confirmed, COALESCE(g.registry_candidates, 0) AS registry_candidates, ` +
    `g.registry_confirmed_enrollment AS registry_confirmed_enrollment, g.registry_latest_completion AS registry_latest_completion, ` +
    `COALESCE(ca.vendor_claims, 0) AS vendor_claims, COALESCE(cv.vendor_claims_for_version, 0) AS vendor_claims_for_version ` +
    `FROM ${SUBMISSIONS} s ` +
    `LEFT JOIN ${VENDORS} v ON v.vendor_id = s.vendor_id ` +
    `LEFT JOIN ${REQUIREMENTS} q ON ${intendedUsePredicate(input.intendedUse, "q")} ` +
    `LEFT JOIN (${regulator}) r ON r.submission_id = s.submission_id ` +
    `LEFT JOIN (${registry}) g ON g.submission_id = s.submission_id ` +
    `LEFT JOIN (${claimsAll}) ca ON ca.packet_id = s.packet_id ` +
    `LEFT JOIN (${claimsForVersion}) cv ON cv.packet_id = s.packet_id AND cv.device_version = s.device_version ` +
    `WHERE ${submissionPredicate(input, "s")} ` +
    `ORDER BY s.submission_id, q.requirement_id`
  );
}

export function buildEvidenceRowsSql(input: EvidenceMatrixInput): string {
  const asOf = input.asOf === undefined ? undefined : sqlDate(input.asOf);
  const scope = scopedSubmissionIds(input);
  const authzAsOf = asOf ? ` AND a.decision_date <= ${asOf}` : "";
  const studyAsOf = asOf ? ` AND st.start_date <= ${asOf}` : "";

  const regulator =
    `SELECT 'regulator' AS source_system, 'regulator.authorizations' AS source_table, a.authorization_id AS record_id, ` +
    `l.link_id AS link_id, l.state AS link_state, a.device_name AS title, a.decision_date AS event_date, ` +
    `a.software_version AS version, CAST(NULL AS BIGINT) AS amount, l.from_id AS submission_id ` +
    `FROM ${LINKS} l JOIN ${AUTHORIZATIONS} a ON a.authorization_id = l.to_id ` +
    `WHERE l.to_system = 'regulator' AND l.link_type = 'SAME_SUBMISSION' AND l.from_id IN ${scope}${authzAsOf}`;

  const registry =
    `SELECT 'registry' AS source_system, 'registry.studies' AS source_table, st.nct_id AS record_id, ` +
    `l.link_id AS link_id, l.state AS link_state, st.title AS title, st.start_date AS event_date, ` +
    `CAST(NULL AS STRING) AS version, st.enrollment AS amount, l.from_id AS submission_id ` +
    `FROM ${LINKS} l JOIN ${STUDIES} st ON st.nct_id = l.to_id ` +
    `WHERE l.to_system = 'registry' AND l.link_type = 'STUDY_EVALUATES' AND l.from_id IN ${scope}${studyAsOf}`;

  const vendor =
    `SELECT 'vendor_packet' AS source_system, 'vendor_packets.claims' AS source_table, c.claim_id AS record_id, ` +
    `CAST(NULL AS STRING) AS link_id, 'PACKET' AS link_state, c.claim_text AS title, CAST(NULL AS DATE) AS event_date, ` +
    `c.device_version AS version, CAST(NULL AS BIGINT) AS amount, sv.submission_id AS submission_id ` +
    `FROM ${CLAIMS} c JOIN ${SUBMISSIONS} sv ON sv.packet_id = c.packet_id ` +
    `WHERE sv.submission_id IN ${scope}`;

  return `${regulator} UNION ALL ${registry} UNION ALL ${vendor} ORDER BY source_system, record_id`;
}

/** Declared result types for both statements, for the casting layer. */
export const EVIDENCE_MATRIX_SCHEMA: Readonly<Record<string, string>> = {
  ...declaredSchemaFor([SILOS.submissions, SILOS.requirements, SILOS.vendors]),
  required_setting: "string",
  required_purpose: "string",
  regulator_confirmed: "bigint",
  regulator_candidates: "bigint",
  regulator_latest_decision: "date",
  registry_confirmed: "bigint",
  registry_candidates: "bigint",
  registry_confirmed_enrollment: "bigint",
  registry_latest_completion: "date",
  vendor_claims: "bigint",
  vendor_claims_for_version: "bigint",
};

export const EVIDENCE_ROWS_SCHEMA: Readonly<Record<string, string>> = {
  source_system: "string",
  source_table: "string",
  record_id: "string",
  link_id: "string",
  link_state: "string",
  title: "string",
  event_date: "date",
  version: "string",
  amount: "bigint",
  submission_id: "string",
};
