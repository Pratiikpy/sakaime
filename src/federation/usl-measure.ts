/**
 * One cross-silo question answered three ways, so that what the semantic layer saves can be measured instead of claimed.
 *
 * The question, as a reviewer asks it: for every hospital case and every vendor claim on its packet, does FDA list the claimed
 * software version for the cited authorization, and how does the claimed lowest age and the hospital's lowest age compare with
 * the youngest age enrolled in the study a reviewer confirmed for the case?
 *
 *   answerByHand          seven reads, one per silo table, joined in code. What an agent has to do without the layer, or what a
 *                         consumer does when it only knows the silos.
 *   answerByOneStatement  one hand-written federated statement over the same tables. What the product's Evidence Matrix does.
 *   answerThroughUsl      one read of the layer's case_evidence_matrix table.
 *
 * All three run as the caller, so the identity's policies apply to every arm alike. The by-hand arm is written plainly and
 * reads only the columns it needs; it is not made slower on purpose. compareAnswers checks that the three give the same rows.
 */
import { PortError } from "../ports/index.ts";
import { queryUsl, type SemanticLayerSpec, type UslSqlPort } from "./usl.ts";

export interface AnswerRow {
  case_id: string;
  claim_id: string;
  product_name: string;
  authorization_id: string;
  listed_versions: string | null;
  claimed_version: string;
  claimed_age_min_years: number | null;
  intended_age_min_years: number | null;
  confirmed_studies: number | null;
  study_enrolled_age_min_years: number | null;
  version_listed: string;
  claim_age_vs_study: string;
  case_age_vs_study: string;
}

export interface Answer {
  statements: number;
  rows: AnswerRow[];
}

const num = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));
const str = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));
const key = (r: { case_id: string; claim_id: string }): string => `${r.case_id}|${r.claim_id}`;

function normalise(r: Record<string, unknown>): AnswerRow {
  return {
    case_id: String(r["case_id"]),
    claim_id: String(r["claim_id"]),
    product_name: String(r["product_name"]),
    authorization_id: String(r["authorization_id"]),
    listed_versions: str(r["listed_versions"]),
    claimed_version: String(r["claimed_version"]),
    claimed_age_min_years: num(r["claimed_age_min_years"]),
    intended_age_min_years: num(r["intended_age_min_years"]),
    confirmed_studies: num(r["confirmed_studies"]),
    study_enrolled_age_min_years: num(r["study_enrolled_age_min_years"]),
    version_listed: String(r["version_listed"]),
    claim_age_vs_study: String(r["claim_age_vs_study"]),
    case_age_vs_study: String(r["case_age_vs_study"]),
  };
}

export async function answerByHand(reader: UslSqlPort): Promise<Answer> {
  const ints = { intended_min_age: "integer", claimed_min_age_years: "integer", minimum_age_years: "double" };
  const [cases, subs, links, claims, auths, udi, studies] = await Promise.all([
    reader.sql("SELECT case_id, submission_id, intended_min_age FROM hospital.cases", { schema: ints }),
    reader.sql("SELECT submission_id, product_name, packet_id, regulator_submission_cited FROM hospital.submissions"),
    reader.sql("SELECT case_id, right_type, right_id, link_class FROM hospital.evidence_links"),
    reader.sql("SELECT claim_id, packet_id, claimed_version, claimed_min_age_years FROM sk_vendor.vendor_claims", { schema: ints }),
    reader.sql("SELECT k_number FROM sk_registry.fda_510k"),
    reader.sql("SELECT submission_number, version_or_model_number FROM sk_registry.fda_udi"),
    reader.sql("SELECT nct_id, minimum_age_years FROM sk_registry.ctgov_studies", { schema: ints }),
  ]);
  const submission = new Map(subs.rows.map((r) => [String(r["submission_id"]), r]));
  const authorized = new Set(auths.rows.map((r) => String(r["k_number"])));
  const study = new Map(studies.rows.map((r) => [String(r["nct_id"]), num(r["minimum_age_years"])]));
  const versionsOf = (k: string): string[] => [...new Set(udi.rows.filter((r) => String(r["submission_number"]) === k).map((r) => str(r["version_or_model_number"])).filter((v): v is string => v !== null && v !== ""))].sort();
  const out: AnswerRow[] = [];
  for (const c of cases.rows) {
    const s = submission.get(String(c["submission_id"]));
    if (!s) continue;
    const cited = String(s["regulator_submission_cited"]);
    if (!authorized.has(cited)) continue;
    const versions = versionsOf(cited);
    const confirmed = [...new Set(links.rows.filter((l) => String(l["case_id"]) === String(c["case_id"]) && l["link_class"] === "CONFIRMED" && l["right_type"] === "ctgov_study").map((l) => String(l["right_id"])))].filter((id) => study.has(id));
    const ages = confirmed.map((id) => study.get(id)).filter((a): a is number => a !== null && a !== undefined);
    const youngest = ages.length > 0 ? Math.min(...ages) : null;
    const intended = num(c["intended_min_age"]);
    for (const claim of claims.rows.filter((r) => String(r["packet_id"]) === String(s["packet_id"]))) {
      const claimed = num(claim["claimed_min_age_years"]);
      out.push({
        case_id: String(c["case_id"]),
        claim_id: String(claim["claim_id"]),
        product_name: String(s["product_name"]),
        authorization_id: cited,
        listed_versions: versions.length > 0 ? versions.join("|") : null,
        claimed_version: String(claim["claimed_version"]),
        claimed_age_min_years: claimed,
        intended_age_min_years: intended,
        confirmed_studies: confirmed.length > 0 ? confirmed.length : null,
        study_enrolled_age_min_years: youngest,
        version_listed: versions.includes(String(claim["claimed_version"])) ? "LISTED" : "NOT_LISTED",
        claim_age_vs_study: youngest === null || claimed === null ? "UNKNOWN" : claimed < youngest ? "CLAIM_BELOW_STUDY_MINIMUM" : "WITHIN_STUDY",
        case_age_vs_study: youngest === null || intended === null ? "UNKNOWN" : intended >= youngest ? "COVERED_BY_STUDY" : "NOT_COVERED_BY_STUDY",
      });
    }
  }
  out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  return { statements: 7, rows: out };
}

const MATRIX_SCHEMA = { claimed_age_min_years: "integer", intended_age_min_years: "integer", confirmed_studies: "integer", study_enrolled_age_min_years: "double" } as const;

export async function answerByOneStatement(reader: UslSqlPort, spec: SemanticLayerSpec): Promise<Answer> {
  const table = spec.tables.find((t) => t.name === "case_evidence_matrix");
  if (!table) throw new PortError("INVALID", "the specification has no case_evidence_matrix table", { reason: "NO_MATRIX" });
  const r = await reader.sql(`SELECT * FROM (${table.activation}) m ORDER BY matrix_key`, { schema: MATRIX_SCHEMA });
  return { statements: 1, rows: r.rows.map(normalise) };
}

export async function answerThroughUsl(reader: UslSqlPort, spec: SemanticLayerSpec): Promise<Answer> {
  const r = await queryUsl(reader, spec, { table: "case_evidence_matrix", orderBy: ["matrix_key"] }, MATRIX_SCHEMA);
  return { statements: 1, rows: r.rows.map(normalise) };
}

export interface Comparison {
  equal: boolean;
  rows: number;
  problems: string[];
}

/** Cell-by-cell equality of two answers keyed by case and claim. A missing row, an extra row and a changed cell are each reported. */
export function compareAnswers(expected: Answer, actual: Answer): Comparison {
  const problems: string[] = [];
  const have = new Map(actual.rows.map((r) => [key(r), r]));
  for (const e of expected.rows) {
    const a = have.get(key(e));
    if (!a) {
      problems.push(`missing ${key(e)}`);
      continue;
    }
    for (const col of Object.keys(e) as (keyof AnswerRow)[]) {
      if (e[col] !== a[col]) problems.push(`${key(e)} ${col}: expected ${JSON.stringify(e[col])}, got ${JSON.stringify(a[col])}`);
    }
    have.delete(key(e));
  }
  for (const k of have.keys()) problems.push(`unexpected ${k}`);
  return { equal: problems.length === 0, rows: expected.rows.length, problems };
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new PortError("INVALID", "median of nothing");
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 === 1 ? v[mid]! : Math.round(((v[mid - 1]! + v[mid]!) / 2) * 10) / 10;
}
