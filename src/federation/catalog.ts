/**
 * Catalog discovery through Zetaris itself, so a database added in Zetaris appears as a Source without a code change.
 *
 * Statements used (docs: zetaris-lightning-sql-commands.md s4.5, s5.4; verified on the local install 2026-10-16/17):
 *   SHOW LIGHTNING DATABASES    file and REST sources: name, description, id
 *   SHOW DATASOURCES            JDBC sources such as the hospital Postgres: name, description, id
 *   SHOW TABLES IN <name>       tables of one database (a bare SHOW TABLES is refused by the engine)
 * An empty list is a valid answer ("nothing registered"), distinct from a failed listing.
 *
 * Column names of the SHOW outputs are documented only as "name, description and id"; the table listing's headers
 * are NOT VERIFIED. Headers are therefore looked up from a list of candidates and, when none is present, the
 * listing fails as DRIFTED rather than guessing a column.
 *
 * Classification (kind, licence, data class) is not in Zetaris's listing. A caller may pass `classify`; any
 * database it does not describe gets kind "other", licence "UNSPECIFIED" and the most restrictive data class,
 * so a newly added source cannot reach a model prompt until someone has classified it.
 */
import { PortError, systemClock, type Clock, type FailureClass, type FederationPort } from "../ports/index.ts";
import type { SourceHealth } from "../schemas/common.ts";
import { SourceSchema, type Source } from "../schemas/evidence.ts";
import { hashOf } from "../util/canonical.ts";
import type { FederationQueryOptionsEx } from "./result.ts";
import { SILO_DATABASES } from "./silo-layout.ts";
import { isSafeIdent, sqlIdent } from "./sql.ts";

export interface CatalogDatabase {
  name: string;
  description: string;
  kind: "lightning" | "datasource";
  id?: string;
}

export interface CatalogClassification {
  kind?: Source["kind"];
  license?: string;
  dataClass?: Source["dataClass"];
  descriptor?: string;
}

export interface CatalogOptions {
  identity?: string;
  classify?: (db: CatalogDatabase) => CatalogClassification | undefined;
  /** Also read each table's column names (SELECT * ... LIMIT 0) and fold them into the schema hash. Empty-result headers are NOT VERIFIED. */
  withColumns?: boolean;
  clock?: Clock;
}

export interface CatalogSnapshot {
  capturedAt: string;
  databases: CatalogDatabase[];
  sources: Source[];
  /** Table names per source id. */
  tables: Record<string, string[]>;
  /** Columns per `<source id>/<table>`, when withColumns was set and the engine returned headers. */
  columns: Record<string, string[]>;
  /** Query ids of the statements that produced it, for the trace. */
  queryIds: string[];
}

const NAME_COLUMNS = ["name", "database", "database_name", "datasource", "datasource_name", "db_name", "namespace"];
const DESCRIPTION_COLUMNS = ["description", "describe_by", "comment"];
const ID_COLUMNS = ["id"];
const TABLE_COLUMNS = ["tablename", "table_name", "table", "name"];

function pick(columns: readonly string[], candidates: readonly string[]): string | undefined {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const c of candidates) {
    const hit = lower.get(c);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const text = (v: unknown): string => (v === null || v === undefined ? "" : String(v));

/** Built-in classification for the databases this project creates; anything else is unclassified. */
export function defaultClassify(db: CatalogDatabase): CatalogClassification | undefined {
  switch (db.name.toLowerCase()) {
    case SILO_DATABASES.hospital:
      return { kind: "hospital", license: "constructed for this project; no PHI", dataClass: "vendor-confidential" };
    case SILO_DATABASES.regulator:
      return { kind: "regulator", license: "public record; per-record terms apply", dataClass: "public" };
    case SILO_DATABASES.registry:
      return { kind: "registry", license: "public record; per-record terms apply", dataClass: "public" };
    case SILO_DATABASES.vendorPackets:
      return { kind: "vendor", license: "constructed for this project", dataClass: "vendor-confidential" };
    default:
      return undefined;
  }
}

function healthFor(failure: FailureClass): SourceHealth {
  switch (failure) {
    case "FORBIDDEN":
      return "FORBIDDEN";
    case "DRIFTED":
      return "DRIFTED";
    case "BLOCKED":
      return "BLOCKED";
    default:
      return "UNAVAILABLE";
  }
}

async function listDatabases(
  port: FederationPort,
  statement: string,
  kind: CatalogDatabase["kind"],
  options: FederationQueryOptionsEx,
  queryIds: string[],
): Promise<CatalogDatabase[]> {
  const result = await port.sql(statement, options);
  queryIds.push(result.queryId);
  if (result.rows.length === 0) return [];
  const names = result.columns.map((c) => c.name);
  const nameCol = pick(names, NAME_COLUMNS);
  if (!nameCol) {
    throw new PortError("DRIFTED", `${statement} returned columns [${names.join(", ")}] with no database-name column`, { reason: "CATALOG_SHAPE", statement });
  }
  const descCol = pick(names, DESCRIPTION_COLUMNS);
  const idCol = pick(names, ID_COLUMNS);
  return result.rows.map((row) => ({
    name: text(row[nameCol]),
    description: descCol ? text(row[descCol]) : "",
    kind,
    ...(idCol && text(row[idCol]) !== "" ? { id: text(row[idCol]) } : {}),
  }));
}

async function listTables(port: FederationPort, db: CatalogDatabase, options: FederationQueryOptionsEx, queryIds: string[]): Promise<string[]> {
  const run = async (statement: string): Promise<string[]> => {
    const result = await port.sql(statement, options);
    queryIds.push(result.queryId);
    if (result.rows.length === 0) return [];
    const names = result.columns.map((c) => c.name);
    const col = pick(names, TABLE_COLUMNS);
    if (!col) throw new PortError("DRIFTED", `${statement} returned columns [${names.join(", ")}] with no table-name column`, { reason: "CATALOG_SHAPE", statement });
    return result.rows.map((r) => text(r[col])).filter((t) => t !== "").sort();
  };
  try {
    return await run(`SHOW TABLES IN ${sqlIdent(db.name)}`);
  } catch (e) {
    // The documented per-kind listing is the second choice for JDBC sources, tried only when the generic form is rejected as invalid.
    if (e instanceof PortError && e.failure === "INVALID" && db.kind === "datasource") {
      return run(`SHOW DATASOURCE TABLES ${sqlIdent(db.name)}`);
    }
    throw e;
  }
}

export async function discoverCatalog(port: FederationPort, options: CatalogOptions = {}): Promise<CatalogSnapshot> {
  const clock = options.clock ?? systemClock;
  const query: FederationQueryOptionsEx = options.identity ? { identity: options.identity } : {};
  const queryIds: string[] = [];
  // A failure of either top-level listing is thrown: it cannot be told apart from "nothing registered" if swallowed.
  const databases = [
    ...(await listDatabases(port, "SHOW LIGHTNING DATABASES", "lightning", query, queryIds)),
    ...(await listDatabases(port, "SHOW DATASOURCES", "datasource", query, queryIds)),
  ].filter((d, i, all) => d.name !== "" && all.findIndex((x) => x.name.toLowerCase() === d.name.toLowerCase()) === i);

  const capturedAt = clock.now().toISOString();
  const sources: Source[] = [];
  const tables: Record<string, string[]> = {};
  const columns: Record<string, string[]> = {};

  for (const db of databases) {
    const id = `zetaris:${db.name.toLowerCase()}`;
    const klass = (options.classify ?? defaultClassify)(db) ?? {};
    const known = defaultClassify(db) ?? {};
    const base = {
      id,
      kind: klass.kind ?? known.kind ?? "other",
      access: "zetaris" as const,
      license: klass.license ?? known.license ?? "UNSPECIFIED",
      dataClass: klass.dataClass ?? known.dataClass ?? "phi",
    };
    const describe = (n: number | undefined, note: string): string =>
      klass.descriptor ?? `${db.description || db.name} (Zetaris ${db.kind === "lightning" ? "Lightning database" : "datasource"}${n === undefined ? "" : `, ${n} table${n === 1 ? "" : "s"}`}${note})`;

    if (!isSafeIdent(db.name)) {
      sources.push(SourceSchema.parse({ ...base, descriptor: describe(undefined, `; name is not a plain identifier, so it is not queried`), health: "UNAVAILABLE" }));
      tables[id] = [];
      continue;
    }
    try {
      const names = await listTables(port, db, query, queryIds);
      tables[id] = names;
      if (options.withColumns) {
        for (const table of names) {
          if (!isSafeIdent(table)) continue;
          const probe = await port.sql(`SELECT * FROM ${sqlIdent(db.name)}.${sqlIdent(table)} LIMIT 0`, { ...query, limit: 1 });
          queryIds.push(probe.queryId);
          columns[`${id}/${table}`] = probe.columns.map((c) => c.name);
        }
      }
      const prefix = `${id}/`;
      const schemaHash = hashOf({
        database: db.name.toLowerCase(),
        tables: names,
        columns: Object.fromEntries(Object.entries(columns).filter(([k]) => k.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b))),
      });
      sources.push(
        SourceSchema.parse({ ...base, descriptor: describe(names.length, ""), schemaHash, health: names.length > 0 ? "OK" : "EMPTY", lastSuccessAt: capturedAt }),
      );
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      tables[id] = [];
      sources.push(SourceSchema.parse({ ...base, descriptor: describe(undefined, `; table listing failed: ${e.failure}`), health: healthFor(e.failure) }));
    }
  }
  return { capturedAt, databases, sources, tables, columns, queryIds };
}
