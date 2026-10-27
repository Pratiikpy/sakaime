/**
 * Small constructed silos for the federation tests. Every value here is made up for testing: none of it describes a
 * real vendor, device, trial or authorization. Two names carry quote and backslash characters on purpose.
 */
import { DuckDbFallbackPort } from "../../../src/federation/fallback.ts";
import { SILOS, type SiloTable } from "../../../src/federation/silo-layout.ts";

export const TRICKY_DEVICE = "O'Neil \\ Sepsis Alert";

type Row = Record<string, unknown>;

export const FIXTURE_DATA: Record<keyof typeof SILOS, Row[]> = {
  requirements: [
    { requirement_id: "R1", setting: "emergency department", purpose: "triage support", min_validation_type: "external prospective", subgroup_reporting_required: true, update_control_required: true, effective_from: "2025-01-01" },
    { requirement_id: "R2", setting: "inpatient", purpose: "triage support", min_validation_type: "retrospective", subgroup_reporting_required: false, update_control_required: true, effective_from: "2025-01-01" },
  ],
  vendors: [
    { vendor_id: "V1", vendor_name: "Acme Imaging" },
    { vendor_id: "V2", vendor_name: "O'Neil Health \\ Labs" },
  ],
  submissions: [
    { submission_id: "S1", vendor_id: "V1", device_name: "EyeScan AI", device_version: "2.1", packet_id: "PK1", claimed_setting: "emergency department", claimed_population: "adults", claimed_purpose: "triage support", submitted_on: "2026-03-01" },
    { submission_id: "S2", vendor_id: "V1", device_name: "EyeScan AI", device_version: "3.0", packet_id: "PK2", claimed_setting: "inpatient", claimed_population: "adults", claimed_purpose: "triage support", submitted_on: "2026-04-01" },
    { submission_id: "S3", vendor_id: "V2", device_name: TRICKY_DEVICE, device_version: "1.0", packet_id: "PK3", claimed_setting: "emergency department", claimed_population: "adults", claimed_purpose: "triage support", submitted_on: "2026-05-01" },
  ],
  cases: [{ case_id: "C1", submission_id: "S1", requirement_id: "R1", reviewer_id: "RV1", status: "open", opened_on: "2026-03-02" }],
  reviewers: [{ reviewer_id: "RV1", display_name: "Reviewer One", role: "clinical informatics" }],
  decisions: [],
  precedents: [{ precedent_id: "P1", requirement_id: "R1", summary: "constructed precedent", decided_on: "2025-09-01" }],
  identityLinks: [
    { link_id: "L1", link_type: "SAME_SUBMISSION", from_id: "S1", to_id: "A1", to_system: "regulator", state: "CONFIRMED", decided_by: "RV1", decided_on: "2026-03-03" },
    { link_id: "L2", link_type: "SAME_SUBMISSION", from_id: "S1", to_id: "A2", to_system: "regulator", state: "CONFIRMED", decided_by: "RV1", decided_on: "2026-03-03" },
    { link_id: "L3", link_type: "SAME_SUBMISSION", from_id: "S1", to_id: "A3", to_system: "regulator", state: "CANDIDATE", decided_by: null, decided_on: null },
    { link_id: "L4", link_type: "STUDY_EVALUATES", from_id: "S1", to_id: "N1", to_system: "registry", state: "CONFIRMED", decided_by: "RV1", decided_on: "2026-03-03" },
    { link_id: "L5", link_type: "STUDY_EVALUATES", from_id: "S1", to_id: "N2", to_system: "registry", state: "CONFIRMED", decided_by: "RV1", decided_on: "2026-03-03" },
    { link_id: "L6", link_type: "STUDY_EVALUATES", from_id: "S1", to_id: "N3", to_system: "registry", state: "AMBIGUOUS", decided_by: null, decided_on: null },
    { link_id: "L7", link_type: "SAME_SUBMISSION", from_id: "S3", to_id: "A4", to_system: "regulator", state: "CONFIRMED", decided_by: "RV1", decided_on: "2026-05-02" },
  ],
  authorizations: [
    { authorization_id: "A1", product_code: "QAS", device_name: "EyeScan AI", applicant: "Acme Imaging", decision_date: "2024-05-01", decision_type: "510(k)", indications_text: "constructed indication", software_version: "2.0" },
    { authorization_id: "A2", product_code: "QAS", device_name: "EyeScan AI", applicant: "Acme Imaging", decision_date: "2025-02-10", decision_type: "510(k)", indications_text: "constructed indication", software_version: "2.1" },
    { authorization_id: "A3", product_code: "QAS", device_name: "EyeScan AI Lite", applicant: "Acme Imaging", decision_date: "2025-06-01", decision_type: "510(k)", indications_text: "constructed indication", software_version: "2.1" },
    { authorization_id: "A4", product_code: "QYE", device_name: TRICKY_DEVICE, applicant: "O'Neil Health", decision_date: "2023-01-01", decision_type: "De Novo", indications_text: "constructed indication", software_version: "1.0" },
  ],
  studies: [
    { nct_id: "N1", title: "Constructed study one", overall_status: "COMPLETED", conditions: "eye disease", enrollment: 400, start_date: "2024-01-01", completion_date: "2025-01-01", intervention_device: "EyeScan AI" },
    { nct_id: "N2", title: "Constructed study two", overall_status: "COMPLETED", conditions: "eye disease", enrollment: 250, start_date: "2025-03-01", completion_date: "2026-01-15", intervention_device: "EyeScan AI" },
    { nct_id: "N3", title: "Constructed study three", overall_status: "RECRUITING", conditions: "eye disease", enrollment: 100, start_date: "2025-09-01", completion_date: null, intervention_device: "EyeScan" },
    { nct_id: "N9", title: "Constructed unrelated study", overall_status: "COMPLETED", conditions: "other", enrollment: 5000, start_date: "2020-01-01", completion_date: "2021-01-01", intervention_device: "Unrelated" },
  ],
  claims: [
    { claim_id: "CL1", packet_id: "PK1", device_version: "2.1", claim_text: "sensitivity claim", claimed_metric: "sensitivity", metric_value: 0.91, population: "adults", setting: "emergency department", purpose: "triage support", page: 4 },
    { claim_id: "CL2", packet_id: "PK1", device_version: "2.1", claim_text: "specificity claim", claimed_metric: "specificity", metric_value: 0.88, population: "adults", setting: "emergency department", purpose: "triage support", page: 4 },
    { claim_id: "CL3", packet_id: "PK1", device_version: "2.0", claim_text: "older version claim", claimed_metric: "sensitivity", metric_value: 0.85, population: "adults", setting: "emergency department", purpose: "triage support", page: 9 },
    { claim_id: "CL4", packet_id: "PK1", device_version: "2.1", claim_text: "auc claim", claimed_metric: "auc", metric_value: 0.95, population: "adults", setting: "emergency department", purpose: "triage support", page: 5 },
    { claim_id: "CL5", packet_id: "PK2", device_version: "3.0", claim_text: "inpatient claim", claimed_metric: "sensitivity", metric_value: 0.9, population: "adults", setting: "inpatient", purpose: "triage support", page: 3 },
    { claim_id: "CL6", packet_id: "PK3", device_version: "1.0", claim_text: "tricky name claim", claimed_metric: "sensitivity", metric_value: 0.8, population: "adults", setting: "emergency department", purpose: "triage support", page: 2 },
  ],
  extractedFacts: [],
};

/** Which Zetaris listing each database appears in: the hospital Postgres is a JDBC datasource, the rest are file or REST sources. */
export const SOURCE_KIND: Record<string, "lightning" | "datasource"> = {
  hospital: "datasource",
  regulator: "lightning",
  registry: "lightning",
  vendor_packets: "lightning",
};

/** Load the fixture silos; `override` replaces whole tables, every other table keeps its fixture rows. */
export async function loadSilos(port: DuckDbFallbackPort, override: Partial<Record<keyof typeof SILOS, Row[]>> = {}): Promise<void> {
  const data = { ...FIXTURE_DATA, ...override };
  for (const [name, table] of Object.entries(SILOS) as [keyof typeof SILOS, SiloTable][]) {
    const columns = Object.entries(table.columns).map(([n, type]) => ({ name: n, type }));
    const rows = data[name].map((r) => columns.map((c) => r[c.name] ?? null));
    await port.registerTable(`${table.database}.${table.table}`, columns, rows, { sourceKind: SOURCE_KIND[table.database] ?? "lightning", description: `constructed ${table.database} silo` });
  }
}

export async function fixturePort(data?: Partial<Record<keyof typeof SILOS, Row[]>>): Promise<DuckDbFallbackPort> {
  const port = await DuckDbFallbackPort.create();
  await loadSilos(port, data);
  return port;
}
