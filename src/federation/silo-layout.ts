/**
 * The silo layout the federation layer builds statements against: database, table and column names with their
 * types. This is the single place to change when the synthetic silos are generated with different names; the
 * statement builders, the declared result schemas and the DuckDB oracle registration all read from here.
 *
 * Databases follow docs/03-zetaris-plan.md s3: a hospital Postgres (JDBC), regulator and registry snapshot tables
 * (filestore), and vendor packet exports (files). The columns are this layer's proposal, not a verified Zetaris
 * schema: nothing in the repository defines them yet.
 */
import { sqlQualified } from "./sql.ts";

export interface SiloTable {
  database: string;
  table: string;
  /** Column name to canonical type (see cast.ts). */
  columns: Readonly<Record<string, string>>;
}

export const SILO_DATABASES = {
  hospital: "hospital",
  regulator: "regulator",
  registry: "registry",
  vendorPackets: "vendor_packets",
} as const;

const t = (database: string, table: string, columns: Record<string, string>): SiloTable => ({ database, table, columns });

export const SILOS = {
  requirements: t("hospital", "requirements", {
    requirement_id: "string",
    setting: "string",
    purpose: "string",
    min_validation_type: "string",
    subgroup_reporting_required: "boolean",
    update_control_required: "boolean",
    effective_from: "date",
  }),
  vendors: t("hospital", "vendors", { vendor_id: "string", vendor_name: "string" }),
  submissions: t("hospital", "submissions", {
    submission_id: "string",
    vendor_id: "string",
    device_name: "string",
    device_version: "string",
    packet_id: "string",
    claimed_setting: "string",
    claimed_population: "string",
    claimed_purpose: "string",
    submitted_on: "date",
  }),
  cases: t("hospital", "cases", {
    case_id: "string",
    submission_id: "string",
    requirement_id: "string",
    reviewer_id: "string",
    status: "string",
    opened_on: "date",
  }),
  reviewers: t("hospital", "reviewers", { reviewer_id: "string", display_name: "string", role: "string" }),
  decisions: t("hospital", "decisions", { decision_id: "string", case_id: "string", decided_on: "date", outcome: "string" }),
  precedents: t("hospital", "precedents", { precedent_id: "string", requirement_id: "string", summary: "string", decided_on: "date" }),
  /** Reviewer-confirmed and candidate identity links: the only bridge from a submission to public records. */
  identityLinks: t("hospital", "identity_links", {
    link_id: "string",
    link_type: "string",
    from_id: "string",
    to_id: "string",
    to_system: "string",
    state: "string",
    decided_by: "string",
    decided_on: "date",
  }),
  authorizations: t("regulator", "authorizations", {
    authorization_id: "string",
    product_code: "string",
    device_name: "string",
    applicant: "string",
    decision_date: "date",
    decision_type: "string",
    indications_text: "string",
    software_version: "string",
  }),
  studies: t("registry", "studies", {
    nct_id: "string",
    title: "string",
    overall_status: "string",
    conditions: "string",
    enrollment: "bigint",
    start_date: "date",
    completion_date: "date",
    intervention_device: "string",
  }),
  claims: t("vendor_packets", "claims", {
    claim_id: "string",
    packet_id: "string",
    device_version: "string",
    claim_text: "string",
    claimed_metric: "string",
    metric_value: "double",
    population: "string",
    setting: "string",
    purpose: "string",
    page: "integer",
  }),
  extractedFacts: t("vendor_packets", "extracted_facts", {
    fact_id: "string",
    packet_id: "string",
    predicate: "string",
    value: "string",
    anchor_id: "string",
  }),
} as const satisfies Record<string, SiloTable>;

export type SiloName = keyof typeof SILOS;

/** `database.table`, checked and quoted where a name is a reserved word. */
export function qualifiedName(table: SiloTable): string {
  return sqlQualified(table.database, table.table);
}

/** Declared types for every silo column, keyed by column name, for the casting layer. */
export function declaredSchemaFor(tables: readonly SiloTable[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const table of tables) {
    for (const [name, type] of Object.entries(table.columns)) {
      const existing = out[name];
      if (existing !== undefined && existing !== type) {
        throw new Error(`column ${name} is declared as both ${existing} and ${type}; rename one`);
      }
      out[name] = type;
    }
  }
  return out;
}
