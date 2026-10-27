/**
 * The Retriever's federation mechanism: the Evidence Matrix and the hospital's requirements, each read with one Zetaris
 * statement through the FederationPort.
 *
 * The matrix statement is the headline statement of docs/03-zetaris-plan.md, verified against DuckDB by gate Z-HEAD
 * (infra/zetaris/sql/headline.zetaris.sql): each silo is aggregated or selected on its own before the join, so a case with
 * several vendor claims cannot multiply rows. It is narrowed to one hospital case here. The statement names the tables the
 * running stack actually has (hospital.*, sk_registry.*, sk_vendor.*); src/federation/evidence-matrix.ts uses a proposed
 * layout that the seeded stack does not carry, so it is not used.
 *
 * Modes. live: a real Zetaris through the REST route, logged in as the read-only agent identity. cassette: recorded real
 * responses. off: no engine is configured or reachable, and the service says so instead of inventing rows.
 */
import { CassetteStore, CassettePort, RecordingPort, ZetarisPort, sqlString, zetarisConfigFromEnv } from "../federation/index.ts";
import type { FederationQueryOptionsEx, RawFederationPort, RawFederationResult } from "../federation/result.ts";
import { PortError, type CheckResult, type FederationPort, type FederationResult } from "../ports/index.ts";
import type { z } from "zod";
import type { EvidenceMatrixSchema } from "../api/contract.ts";
import type { RequirementRow, PrecedentRow } from "./requirements.ts";
import type { ServiceConfig } from "./config.ts";
import { brief, errorMessage } from "./util.ts";

type EvidenceMatrix = z.infer<typeof EvidenceMatrixSchema>;

export const REST_URL_DEFAULT = "http://127.0.0.1:8988/api/v1.0";

/** Declared result types: the wire carries every value as a string. */
export const MATRIX_SCHEMA: Readonly<Record<string, string>> = {
  intended_min_age: "integer",
  claimed_min_age_years: "integer",
  decision_date: "date",
  confirmed_studies: "bigint",
  study_min_age_years: "double",
  requirement_count: "bigint",
  required_min_age: "integer",
};

/** Which silo each result column comes from, so the Matrix keeps provenance instead of collapsing it. */
export const COLUMN_SOURCES: Readonly<Record<string, { sourceId: string; sourceLabel: string }>> = Object.fromEntries([
  ...["case_id", "intended_purpose", "intended_setting", "intended_min_age", "product_name", "requirement_count", "required_min_age"].map((c) => [c, { sourceId: "hospital", sourceLabel: "Hospital review database (constructed)" }]),
  ...["claim_id", "claimed_version", "claimed_min_age_years", "claimed_setting", "claimed_purpose"].map((c) => [c, { sourceId: "vendor-packets", sourceLabel: "Vendor packet export (constructed)" }]),
  ...["k_number", "decision_date", "clearance_type", "udi_versions", "confirmed_studies", "study_min_age_years"].map((c) => [c, { sourceId: "registry-snapshots", sourceLabel: "Regulator and registry snapshots (real records)" }]),
  ...["version_in_device_record", "claim_age_vs_study", "case_age_vs_study"].map((c) => [c, { sourceId: "zetaris", sourceLabel: "Computed by the federated join" }]),
]);

/** One statement per case: one row per (case, vendor claim). */
export function matrixStatement(hospitalCaseId: string): string {
  return `
SELECT
  c.case_id,
  c.intended_purpose,
  c.intended_setting,
  CAST(c.intended_min_age AS INT)               AS intended_min_age,
  s.product_name,
  vc.claim_id,
  vc.claimed_version,
  CAST(vc.claimed_min_age_years AS INT)         AS claimed_min_age_years,
  vc.claimed_setting,
  vc.claimed_purpose,
  k.k_number,
  k.decision_date,
  k.clearance_type,
  u.udi_versions,
  st.confirmed_studies,
  st.study_min_age_years,
  rq.requirement_count,
  rq.required_min_age,
  CASE WHEN instr(concat('|', coalesce(u.udi_versions, ''), '|'), concat('|', vc.claimed_version, '|')) > 0
       THEN 'LISTED' ELSE 'NOT_LISTED' END      AS version_in_device_record,
  CASE WHEN st.study_min_age_years IS NULL THEN 'UNKNOWN'
       WHEN CAST(vc.claimed_min_age_years AS DOUBLE) < st.study_min_age_years THEN 'CLAIM_BELOW_STUDY_MINIMUM'
       ELSE 'WITHIN_STUDY' END                  AS claim_age_vs_study,
  CASE WHEN st.study_min_age_years IS NULL THEN 'UNKNOWN'
       WHEN CAST(c.intended_min_age AS DOUBLE) >= st.study_min_age_years THEN 'COVERED_BY_STUDY'
       ELSE 'NOT_COVERED_BY_STUDY' END          AS case_age_vs_study
FROM hospital.cases c
JOIN hospital.submissions s ON s.submission_id = c.submission_id
JOIN sk_vendor.vendor_claims vc ON vc.packet_id = s.packet_id
JOIN sk_registry.fda_510k k ON k.k_number = s.regulator_submission_cited
LEFT JOIN (
  SELECT submission_number,
         concat_ws('|', sort_array(collect_set(version_or_model_number))) AS udi_versions
  FROM sk_registry.fda_udi
  GROUP BY submission_number
) u ON u.submission_number = k.k_number
LEFT JOIN (
  SELECT l.case_id,
         COUNT(DISTINCT t.nct_id)                           AS confirmed_studies,
         MIN(CAST(t.minimum_age_years AS DOUBLE))           AS study_min_age_years
  FROM hospital.evidence_links l
  JOIN sk_registry.ctgov_studies t ON t.nct_id = l.right_id
  WHERE l.link_class = 'CONFIRMED' AND l.right_type = 'ctgov_study'
  GROUP BY l.case_id
) st ON st.case_id = c.case_id
LEFT JOIN (
  SELECT applies_to_purpose,
         COUNT(*)                                                                                    AS requirement_count,
         MAX(CASE WHEN dimension = 'population_min_age' THEN CAST(required_value AS INT) END)        AS required_min_age
  FROM hospital.requirements
  GROUP BY applies_to_purpose
) rq ON rq.applies_to_purpose = c.intended_purpose
WHERE c.case_id = ${sqlString(hospitalCaseId)}
ORDER BY c.case_id, vc.claim_id`.trim();
}

export const REQUIREMENTS_STATEMENT = `
SELECT requirement_id, applies_to_purpose, dimension, comparator, required_value, rationale, policy_ref, policy_version
FROM hospital.requirements
ORDER BY requirement_id`.trim();

export const PRECEDENTS_STATEMENT = `
SELECT precedent_id, topic, statement
FROM hospital.precedents
WHERE scope_org = ${sqlString("HOSPITAL-A")}
ORDER BY precedent_id`.trim();

// ---------------------------------------------------------------- the port

export interface FederationSetup {
  port?: FederationPort;
  /** What RunMode.federation reports. */
  mode: "live" | "cassette" | "off";
  reachable: boolean;
  notes: string[];
  /** Present in record mode: the wrapper that is writing recordings. */
  recorder?: RecordingPort;
}

/** Wraps a live Zetaris port and signs in again when the token is close to expiry. The token is never logged. */
class SessionPort implements RawFederationPort {
  readonly mode = "live" as const;
  private port: ZetarisPort | undefined;
  private expires = 0;

  constructor(
    private readonly restUrl: string,
    private readonly orgId: string,
    private readonly email: string,
    private readonly password: string,
    private readonly schema: Readonly<Record<string, string>>,
  ) {}

  private async current(): Promise<ZetarisPort> {
    if (this.port && Date.now() < this.expires - 30_000) return this.port;
    const res = await fetch(`${this.restUrl}/auth/login`, {
      headers: { Authorization: `Basic ${Buffer.from(`${this.email}:${this.password}`).toString("base64")}`, "X-Org-ID": this.orgId, "X-Request-ID": crypto.randomUUID() },
      signal: AbortSignal.timeout(20_000),
    }).catch((e: unknown) => {
      throw new PortError("UNAVAILABLE", `the Zetaris login route did not answer: ${errorMessage(e)}`, { retryable: true });
    });
    const body = (await res.json().catch(() => ({}))) as { idToken?: string };
    if (res.status === 401 || res.status === 403) throw new PortError("FORBIDDEN", "the Zetaris login was refused for the configured agent identity");
    if (!res.ok || !body.idToken) throw new PortError("UNAVAILABLE", `the Zetaris login route answered HTTP ${res.status}`);
    let exp = Date.now() + 10 * 60_000;
    try {
      const payload = JSON.parse(Buffer.from(body.idToken.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
      if (payload.exp) exp = payload.exp * 1000;
    } catch {
      /* keep the default lifetime */
    }
    this.expires = exp;
    this.port = new ZetarisPort({ restUrl: this.restUrl, orgId: this.orgId, identities: { default: { apiKey: body.idToken } }, defaultIdentity: "default", schema: this.schema });
    return this.port;
  }

  async sqlRaw(statement: string, options?: FederationQueryOptionsEx): Promise<RawFederationResult> {
    return (await this.current()).sqlRaw(statement, options);
  }
  toResult(raw: RawFederationResult, options?: FederationQueryOptionsEx): FederationResult {
    if (!this.port) throw new PortError("INVALID", "no session yet");
    return this.port.toResult(raw, options);
  }
  async sql(statement: string, options?: FederationQueryOptionsEx): Promise<FederationResult> {
    return (await this.current()).sql(statement, options);
  }
  async check(): Promise<CheckResult> {
    try {
      return await (await this.current()).check();
    } catch (e) {
      return { health: e instanceof PortError && e.failure === "FORBIDDEN" ? "FORBIDDEN" : "UNAVAILABLE", detail: brief(errorMessage(e)), latencyMs: 0, checkedAt: new Date().toISOString() };
    }
  }
}

export function createFederation(config: ServiceConfig): FederationSetup {
  const env = config.env;
  if (config.sample) {
    return { port: new CassettePort({ store: new CassetteStore(config.dirs.federationCassettes), schema: MATRIX_SCHEMA }), mode: "cassette", reachable: true, notes: ["Zetaris answers are replayed from recorded real responses"] };
  }
  const fromEnv = zetarisConfigFromEnv(env);
  let live: RawFederationPort | undefined;
  if (fromEnv) {
    live = new ZetarisPort({ ...fromEnv, schema: MATRIX_SCHEMA });
  } else if (env["SAKAIME_ZETARIS_READER_EMAIL"] && env["SAKAIME_ZETARIS_READER_PASSWORD"]) {
    live = new SessionPort(env["ZETARIS_REST_URL"] ?? REST_URL_DEFAULT, env["ZETARIS_ORG_ID"] ?? "1", env["SAKAIME_ZETARIS_READER_EMAIL"], env["SAKAIME_ZETARIS_READER_PASSWORD"], MATRIX_SCHEMA);
  }
  if (!live) {
    return { mode: "off", reachable: false, notes: ["Zetaris is not configured: set ZETARIS_REST_URL, ZETARIS_API_KEY and ZETARIS_ORG_ID, or the read-only agent login names listed in .env.example"] };
  }
  if (config.record) {
    const recorder = new RecordingPort(live, new CassetteStore(config.dirs.federationCassettes), { clock: config.clock });
    return { port: recorder, mode: "live", reachable: true, notes: ["recording live Zetaris answers into the federation cassette"], recorder };
  }
  return { port: live, mode: "live", reachable: true, notes: [] };
}

// ---------------------------------------------------------------- reads

export interface FederationRead {
  statement: string;
  result: FederationResult;
  identity: string;
  at: string;
}

export async function readMatrix(port: FederationPort, hospitalCaseId: string, at: string): Promise<FederationRead> {
  const statement = matrixStatement(hospitalCaseId);
  const result = await port.sql(statement, { limit: 500 });
  return { statement, result, identity: "default", at };
}

export function matrixView(read: FederationRead): EvidenceMatrix {
  const { result } = read;
  const sourceOf = (name: string) => COLUMN_SOURCES[name] ?? { sourceId: "zetaris", sourceLabel: "Computed by the federated join" };
  const distinct = (col: string) => new Set(result.rows.map((r) => String(r[col] ?? ""))).size;
  const keys: Record<string, string> = { hospital: "case_id", "vendor-packets": "claim_id", "registry-snapshots": "k_number" };
  return {
    statement: read.statement,
    queryId: result.queryId,
    servedFrom: result.servedFrom,
    respHash: result.respHash,
    elapsedMs: result.elapsedMs,
    perSourceRowCounts: Object.fromEntries(Object.entries(keys).map(([src, col]) => [src, result.rows.length === 0 ? 0 : distinct(col)])),
    columns: result.columns.map((c) => ({ name: c.name, ...sourceOf(c.name) })),
    rows: result.rows.map((row) => ({ cells: Object.fromEntries(result.columns.map((c) => [c.name, { value: row[c.name] ?? null, ...sourceOf(c.name) }])) })),
  };
}

export async function readRequirements(port: FederationPort, at: string): Promise<{ rows: RequirementRow[]; precedents: PrecedentRow[]; reads: FederationRead[] }> {
  const rq = await port.sql(REQUIREMENTS_STATEMENT, { limit: 500 });
  const pr = await port.sql(PRECEDENTS_STATEMENT, { limit: 500 });
  const str = (v: unknown) => (v === null || v === undefined ? "" : String(v));
  return {
    rows: rq.rows.map((r) => ({
      requirement_id: str(r["requirement_id"]),
      applies_to_purpose: str(r["applies_to_purpose"]),
      dimension: str(r["dimension"]),
      comparator: str(r["comparator"]),
      required_value: str(r["required_value"]),
      rationale: str(r["rationale"]),
      policy_ref: str(r["policy_ref"]),
      policy_version: str(r["policy_version"]),
    })),
    precedents: pr.rows.map((r) => ({ precedent_id: str(r["precedent_id"]), topic: str(r["topic"]), statement: str(r["statement"]) })),
    reads: [
      { statement: REQUIREMENTS_STATEMENT, result: rq, identity: "default", at },
      { statement: PRECEDENTS_STATEMENT, result: pr, identity: "default", at },
    ],
  };
}
