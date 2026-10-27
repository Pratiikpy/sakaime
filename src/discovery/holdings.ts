/**
 * Sample joins against the records Sakaime already holds.
 *
 * A column mapped to `submission_number` should contain values that the regulator silo knows; a column mapped to
 * `device_name` should overlap the device names we hold. The overlap is measured with one bounded SELECT through the
 * federation port, so the check is a real join against the same silos a query will use, not a comparison against a
 * copy in application memory.
 *
 * Evidence is only evidence. A zero overlap does not prove a mapping wrong (the source may cover other devices);
 * a high overlap with a DIFFERENT field's holdings does prove it wrong. The validator uses both, and when the
 * federation port cannot answer it records that the cross-check was not possible rather than assuming it passed.
 */
import { PortError, type FederationPort } from "../ports/index.ts";
import { isSafeIdent, sqlIdent, sqlList } from "../federation/sql.ts";

export interface HoldingsTarget {
  database: string;
  table: string;
  column: string;
}

export type HoldingsMap = Readonly<Record<string, HoldingsTarget>>;

/** Where the running stack keeps what we hold (infra/zetaris/README.md). */
export const DEFAULT_HOLDINGS: HoldingsMap = {
  submission_number: { database: "sk_registry", table: "fda_510k", column: "k_number" },
  device_name: { database: "sk_registry", table: "fda_510k", column: "device_name" },
  applicant: { database: "sk_registry", table: "fda_510k", column: "applicant" },
  product_code: { database: "sk_registry", table: "fda_classification", column: "product_code" },
  nct_id: { database: "sk_registry", table: "ctgov_studies", column: "nct_id" },
  pmid: { database: "sk_registry", table: "pubmed_articles", column: "pmid" },
  doi: { database: "sk_registry", table: "pubmed_articles", column: "doi" },
};

/** The silo a registered source is joined with to prove the join works, by the key field the source was mapped on. */
export interface JoinTarget {
  database: string;
  table: string;
  column: string;
  /** Columns of the silo shown beside the match. */
  select: readonly string[];
}
export type JoinTargets = Readonly<Record<string, JoinTarget>>;

export const DEFAULT_JOIN_TARGETS: JoinTargets = {
  submission_number: { database: "hospital", table: "submissions", column: "regulator_submission_cited", select: ["submission_id", "product_name"] },
  nct_id: { database: "sk_vendor", table: "vendor_claims", column: "cited_nct_id", select: ["claim_id", "product_name"] },
  pmid: { database: "sk_vendor", table: "vendor_claims", column: "cited_pmid", select: ["claim_id", "product_name"] },
};

/** Fields whose values can be mistaken for one another, so a mapping is compared across the group. */
export const CROSS_GROUPS: readonly (readonly string[])[] = [
  ["submission_number", "nct_id", "pmid", "doi", "product_code"],
  ["device_name", "applicant"],
];

export interface JoinEvidence {
  field: string;
  target: HoldingsTarget;
  checked: number;
  matched: number;
  /** matched / checked, 0 when nothing was checked. */
  rate: number;
  queryId: string;
  servedFrom: string;
}

export type JoinOutcome = { ok: true; evidence: JoinEvidence } | { ok: false; field: string; failure: string; message: string };

/** The upper-case, trimmed form compared on both sides. */
export const joinKey = (v: string): string => v.trim().toUpperCase();

export async function joinRate(
  port: FederationPort,
  field: string,
  values: readonly string[],
  holdings: HoldingsMap,
  limit: number,
  identity?: string,
): Promise<JoinOutcome> {
  const target = holdings[field];
  if (!target) return { ok: false, field, failure: "NO_TARGET", message: `no held records are declared for ${field}` };
  if (![target.database, target.table, target.column].every(isSafeIdent)) {
    return { ok: false, field, failure: "BAD_TARGET", message: `the holdings target for ${field} is not a plain name` };
  }
  const distinct = [...new Set(values.map(joinKey).filter((v) => v !== ""))].slice(0, limit);
  if (distinct.length === 0) return { ok: true, evidence: { field, target, checked: 0, matched: 0, rate: 0, queryId: "", servedFrom: port.mode } };
  const col = `UPPER(TRIM(CAST(${sqlIdent(target.column)} AS STRING)))`;
  const statement = `SELECT DISTINCT ${col} AS v FROM ${sqlIdent(target.database)}.${sqlIdent(target.table)} WHERE ${col} IN ${sqlList(distinct)}`;
  try {
    const result = await port.sql(statement, { ...(identity ? { identity } : {}), limit: Math.max(limit, 1) + 1 });
    const matched = new Set(result.rows.map((r) => String(r["v"] ?? "").toUpperCase()));
    const hits = distinct.filter((v) => matched.has(v)).length;
    return {
      ok: true,
      evidence: { field, target, checked: distinct.length, matched: hits, rate: hits / distinct.length, queryId: result.queryId, servedFrom: result.servedFrom },
    };
  } catch (e) {
    if (e instanceof PortError) return { ok: false, field, failure: e.failure, message: e.message };
    throw e;
  }
}

// ---------------------------------------------------------------- agreement on records that join

/**
 * Where the rest of a held record lives, by the key that finds it. Once a source's rows join on a key, the other mapped
 * columns can be compared with the record we hold for the same key: a column called device_name that holds the FDA
 * classification name ("Diabetic Retinopathy Detection Device") instead of the trade name ("EyeArt") joins on the key
 * perfectly and disagrees on every row. Only descriptive fields that do not change over time are compared; status and
 * enrolment move legitimately.
 */
export interface RowSpec {
  database: string;
  table: string;
  keyColumn: string;
  /** Canonical field to the held column it should agree with. */
  columns: Readonly<Record<string, string>>;
}
export type RowSpecs = Readonly<Record<string, RowSpec>>;

export const DEFAULT_ROW_SPECS: RowSpecs = {
  submission_number: { database: "sk_registry", table: "fda_510k", keyColumn: "k_number", columns: { device_name: "device_name", applicant: "applicant", product_code: "product_code", decision_date: "decision_date", device_class: "device_class" } },
  nct_id: { database: "sk_registry", table: "ctgov_studies", keyColumn: "nct_id", columns: { study_title: "brief_title", study_start_date: "start_date" } },
  pmid: { database: "sk_registry", table: "pubmed_articles", keyColumn: "pmid", columns: { doi: "doi", publication_year: "pub_year", article_title: "title" } },
};

export interface AgreementEvidence {
  field: string;
  column: string;
  compared: number;
  agreed: number;
  rate: number;
  example?: { key: string; source: string; held: string };
  queryId: string;
}

/** The engine renders a date column inferred as a timestamp as "2024-07-27 00:00:00"; only the date is compared. */
const squash = (v: string): string =>
  v
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(\d{4}-\d{2}-\d{2})[ T]00:00:00(\.0+)?$/, "$1")
    .toUpperCase();

/** Compare the canonical rows of a source with the held record for each key. Empty cells on either side are not compared. */
export async function agreement(
  port: FederationPort,
  spec: RowSpec,
  keyField: string,
  canonical: { columns: readonly string[]; rows: readonly (readonly (string | null)[])[] },
  limit: number,
  identity?: string,
): Promise<AgreementEvidence[] | { failure: string; message: string }> {
  const keyAt = canonical.columns.indexOf(keyField);
  if (keyAt < 0) return [];
  const fields = Object.keys(spec.columns).filter((f) => canonical.columns.includes(f));
  if (fields.length === 0) return [];
  const idents = [spec.database, spec.table, spec.keyColumn, ...fields.map((f) => spec.columns[f]!)];
  if (!idents.every(isSafeIdent)) return { failure: "BAD_TARGET", message: "a held-record target is not a plain name" };
  const keys = [...new Set(canonical.rows.map((r) => r[keyAt]).filter((k): k is string => k !== null && k !== undefined).map(joinKey))].slice(0, limit);
  if (keys.length === 0) return [];
  const keyCol = `UPPER(TRIM(CAST(${sqlIdent(spec.keyColumn)} AS STRING)))`;
  const select = [`${keyCol} AS held_key`, ...fields.map((f) => `CAST(${sqlIdent(spec.columns[f]!)} AS STRING) AS ${sqlIdent(`h_${f}`)}`)];
  try {
    const result = await port.sql(`SELECT ${select.join(", ")} FROM ${sqlIdent(spec.database)}.${sqlIdent(spec.table)} WHERE ${keyCol} IN ${sqlList(keys)}`, { ...(identity ? { identity } : {}), limit: limit + 1 });
    const held = new Map<string, Record<string, unknown>>();
    for (const row of result.rows) held.set(String(row["held_key"] ?? "").toUpperCase(), row);
    return fields.map((f): AgreementEvidence => {
      const at = canonical.columns.indexOf(f);
      let compared = 0;
      let agreed = 0;
      let example: AgreementEvidence["example"];
      for (const r of canonical.rows) {
        const key = r[keyAt];
        const mine = r[at];
        const theirs = key ? held.get(joinKey(key))?.[`h_${f}`] : undefined;
        if (mine === null || mine === undefined || mine === "" || theirs === null || theirs === undefined || String(theirs).trim() === "") continue;
        compared += 1;
        // A partial date written by the registry ("2017-01") agrees with the full date it starts.
        const a = squash(mine);
        const b = squash(String(theirs));
        if (a === b || (/^\d{4}(-\d{2})?(-\d{2})?$/.test(a) && /^\d{4}(-\d{2})?(-\d{2})?$/.test(b) && (a.startsWith(b) || b.startsWith(a)))) agreed += 1;
        else example ??= { key: String(key), source: mine.slice(0, 80), held: String(theirs).slice(0, 80) };
      }
      return { field: f, column: spec.columns[f]!, compared, agreed, rate: compared === 0 ? 1 : agreed / compared, ...(example ? { example } : {}), queryId: result.queryId };
    });
  } catch (e) {
    if (e instanceof PortError) return { failure: e.failure, message: e.message };
    throw e;
  }
}
