/**
 * Stage 7: registration with Zetaris.
 *
 * A validated source is turned into a normalised snapshot (canonical columns plus the provenance of every row),
 * landed in the object store, and registered as a filestore table in the Zetaris database for onboarded sources. The
 * snapshot route is used rather than a REST table because a REST table re-issues its request on every query, takes
 * tens of seconds for a large JSON response and can exhaust the driver heap (docs/03-zetaris-plan.md, operating facts).
 *
 * Idempotency: the table name is derived from the request id, so a run that is repeated or resumed finds the table
 * it already created and verifies it instead of creating another. Every step is safe to repeat: landing the same bytes,
 * creating a database that exists, granting a role that has the grant.
 *
 * After registration the row count is read back through the READ-ONLY identity (proving that identity can see the new
 * source) and compared with the snapshot, and the source is joined with an existing silo in the same engine.
 */
import { PortError, type FederationResult } from "../ports/index.ts";
import type { FederationQueryOptionsEx } from "../federation/result.ts";
import { sqlIdent, sqlString } from "../federation/sql.ts";
import type { RecordKind } from "./canonical.ts";
import type { JoinTargets } from "./holdings.ts";
import { canonicalTable, toCsv, type AppliedField } from "./normalise.ts";
import type { ProbeTable } from "./tabular.ts";
import type { DiscoveryConfig, DiscoveryDeps } from "./types.ts";
import { sha256Hex } from "../util/canonical.ts";

export interface RegistrationInput {
  id: string;
  kind: RecordKind;
  table: ProbeTable;
  fields: readonly AppliedField[];
  keyField?: string;
  fetched: { finalUrl: string; sha256: string; at: string };
}

export interface FederatedJoin {
  statement: string;
  rows: number;
  total: number;
  queryId: string;
  servedFrom: string;
  respHash: string;
  sample: Record<string, unknown>[];
}

export interface RegistrationOutcome {
  tableName: string;
  fullName: string;
  uri: string;
  rows: number;
  snapshotSha256: string;
  /** The table already existed with the expected content and was left as it was. */
  kept: boolean;
  databaseCreated: boolean;
  exactDuplicatesDropped: number;
  queryIds: string[];
  statements: string[];
  join?: FederatedJoin;
  joinSkipped?: string;
}

export const tableNameFor = (kind: RecordKind, id: string): string => `s_${kind}_${id.slice(0, 12)}`;

/** Zetaris words a repeated grant as "Database X has already been assigned to Y role" (seen on the live stack, 2026-10-27). */
const ALREADY = /already/i;
const ROLE_RE = /^[A-Za-z][A-Za-z0-9_]{0,60}$/;

export async function registerSource(deps: DiscoveryDeps, cfg: DiscoveryConfig, input: RegistrationInput, joins: JoinTargets): Promise<RegistrationOutcome> {
  const canon = canonicalTable(input.table, input.fields);
  if (canon.rows.length === 0) throw new PortError("INVALID", "the normalised snapshot has no rows; nothing to register", { reason: "EMPTY_SNAPSHOT" });
  const tableName = tableNameFor(input.kind, input.id);
  const db = sqlIdent(cfg.database);
  const t = sqlIdent(tableName);
  const full = `${cfg.database}.${tableName}`;
  const queryIds: string[] = [];
  const statements: string[] = [];

  const admin = (statement: string): Promise<FederationResult> => {
    const options: FederationQueryOptionsEx = { identity: cfg.adminIdentity, statementPolicy: "admin" };
    statements.push(statement);
    return deps.federation.sql(statement, options).then((r) => {
      queryIds.push(r.queryId);
      return r;
    });
  };
  const tolerate = async (statement: string): Promise<void> => {
    try {
      await admin(statement);
    } catch (e) {
      if (!(e instanceof PortError && ALREADY.test(e.message))) throw e;
    }
  };

  // 1. The snapshot: canonical columns, then the provenance every row keeps.
  const retrievedOn = input.fetched.at.slice(0, 10);
  const columns = [...canon.columns, "source_row", "source_url", "source_sha256", "retrieved_on"];
  const rows = canon.rows.map((r, i) => [...r, String(canon.sourceRows[i]), input.fetched.finalUrl, input.fetched.sha256, retrievedOn]);
  const csv = toCsv(columns, rows);
  const bytes = new TextEncoder().encode(csv);
  const key = `${tableName}/${tableName}.csv`;
  const landed = await deps.landing.put(cfg.bucket, key, bytes);

  // 2. The database, then the table, each only if it is not already there.
  const known = await admin("SHOW LIGHTNING DATABASES");
  const names = new Set(known.rows.map((r) => String(Object.values(r)[0] ?? "").toLowerCase()));
  const databaseCreated = !names.has(cfg.database.toLowerCase());
  if (databaseCreated) await admin(`CREATE LIGHTNING DATABASE ${db} DESCRIBE BY "Sources_onboarded_by_the_discovery_fabric"`);

  let kept = false;
  try {
    const existing = await admin(`SELECT COUNT(*) AS n FROM ${db}.${t}`);
    const first = existing.rows[0];
    const n = Number(first ? Object.values(first)[0] : Number.NaN);
    if (n !== canon.rows.length) {
      throw new PortError("INVALID", `${full} already exists with ${n} rows but the snapshot has ${canon.rows.length}; it is not replaced silently`, { reason: "TABLE_MISMATCH" });
    }
    // The columns it was created with must be the ones this snapshot has: a table registered under another mapping of the
    // same request would otherwise be read through a stale column list.
    const header = await admin(`SELECT * FROM ${db}.${t} LIMIT 1`);
    const have = header.columns.map((c) => c.name.toLowerCase());
    const want = columns.map((c) => c.toLowerCase());
    if (have.length !== want.length || have.some((c, i) => c !== want[i])) {
      throw new PortError("INVALID", `${full} already exists with the columns ${have.join(", ")} but the snapshot has ${want.join(", ")}; it is not replaced silently`, { reason: "TABLE_MISMATCH" });
    }
    kept = true;
  } catch (e) {
    // An unknown table is INVALID on this engine (live check, 2026-10-27); anything else is a real failure.
    if (!(e instanceof PortError) || e.failure !== "INVALID" || e.detail?.["reason"] === "TABLE_MISMATCH") throw e;
  }
  if (!kept) {
    await admin(
      `CREATE LIGHTNING FILESTORE TABLE ${t} FROM ${db} FORMAT CSV OPTIONS (path ${JSON.stringify(landed.uri)}, header "true", inferSchema "false", ${cfg.filestoreOptions})`,
    );
  }
  for (const role of cfg.grantRoles) {
    if (!ROLE_RE.test(role)) throw new PortError("INVALID", `role name ${JSON.stringify(role)} is not a plain name`, { reason: "BAD_CONFIG" });
    await tolerate(`ASSIGN LIGHTNING DATABASE ${db} TO ROLE ${sqlString(role)}`);
    await tolerate(`GRANT SELECT ON LIGHTNING DATABASE NAMESPACE ${db} TO ROLE ${sqlString(role)}`);
  }

  // 3. Read it back as the read-only identity: the registered source is visible and complete.
  const readOpts: FederationQueryOptionsEx = {};
  const check = await deps.federation.sql(`SELECT COUNT(*) AS n FROM ${db}.${t}`, readOpts);
  queryIds.push(check.queryId);
  const seen = Number(Object.values(check.rows[0] ?? {})[0]);
  if (seen !== canon.rows.length) {
    throw new PortError("INVALID", `${full} reads back ${seen} rows through the read-only identity; the snapshot has ${canon.rows.length}`, { reason: "READBACK_MISMATCH" });
  }

  // 4. The federated join with an existing silo, in the engine.
  let join: FederatedJoin | undefined;
  let joinSkipped: string | undefined;
  const target = input.keyField ? joins[input.keyField] : undefined;
  if (!target) {
    joinSkipped = input.keyField ? `no silo is declared that ${input.keyField} joins to` : "no key field was mapped";
  } else {
    const extra = canon.columns.filter((c) => c !== input.keyField && /^[a-z_]+$/.test(c)).slice(0, 2);
    const select = [`l.${sqlIdent(target.select[0]!)}`, ...target.select.slice(1).map((c) => `l.${sqlIdent(c)}`), `n.${sqlIdent(input.keyField!)}`, ...extra.map((c) => `n.${sqlIdent(c)}`)];
    const statement = `SELECT DISTINCT ${select.join(", ")} FROM ${sqlIdent(target.database)}.${sqlIdent(target.table)} l JOIN ${db}.${t} n ON UPPER(TRIM(l.${sqlIdent(target.column)})) = UPPER(TRIM(n.${sqlIdent(input.keyField!)})) ORDER BY 1`;
    const result = await deps.federation.sql(statement, { limit: 200 });
    queryIds.push(result.queryId);
    join = { statement, rows: result.rows.length, total: result.total, queryId: result.queryId, servedFrom: result.servedFrom, respHash: result.respHash, sample: result.rows.slice(0, 5) };
  }

  return {
    tableName,
    fullName: full,
    uri: landed.uri,
    rows: canon.rows.length,
    snapshotSha256: sha256Hex(bytes),
    kept,
    databaseCreated,
    exactDuplicatesDropped: canon.exactDuplicatesDropped,
    queryIds,
    statements,
    ...(join ? { join } : {}),
    ...(joinSkipped ? { joinSkipped } : {}),
  };
}
