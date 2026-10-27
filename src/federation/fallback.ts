/**
 * Mode "fallback": the same statements over local tables in DuckDB.
 *
 * This is a degraded path and an independent test oracle. It is never presented as live federation: every result
 * is labelled servedFrom "fallback", and `check()` reports STALE (a local snapshot, not the engine). It runs the
 * statements the product sends to Zetaris after the explicit Spark-to-DuckDB translation in translate.ts, and
 * refuses what that translation cannot carry. It is read-only: statements are held to the same read-only policy
 * as the live port, and external file access is switched off before the first statement runs.
 */
import { randomUUID } from "node:crypto";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { PortError, systemClock, type CheckResult, type Clock, type FederationPort, type FederationResult } from "../ports/index.ts";
import { parseTypeName, resolveSchema, type CastOptions, type ColumnType, type DeclaredSchema } from "./cast.ts";
import { assertComplete, buildResult, DEFAULT_LIMIT, mergeSchema, resolveLimit, type FederationQueryOptionsEx } from "./result.ts";
import { assertReadOnly, isSafeIdent, prepareStatement } from "./sql.ts";
import { translateSparkToDuckDb } from "./translate.ts";

export interface TableColumn {
  name: string;
  /** A canonical type or an engine type name such as varchar(200) or decimal(18,3). */
  type: string;
}

export interface RegisterOptions {
  /** Which Zetaris listing the database appears in: file/REST sources are "lightning", JDBC sources are "datasource". */
  sourceKind?: "lightning" | "datasource";
  description?: string;
}

export interface FallbackPortConfig {
  schema?: DeclaredSchema;
  cast?: CastOptions;
  defaultLimit?: number;
  clock?: Clock;
}

interface DatabaseEntry {
  kind: "lightning" | "datasource";
  description: string;
  tables: Map<string, TableColumn[]>;
}

const DUCK_TYPES: Readonly<Record<ColumnType, string>> = {
  string: "VARCHAR",
  integer: "INTEGER",
  bigint: "BIGINT",
  double: "DOUBLE",
  decimal: "DECIMAL(38,10)",
  boolean: "BOOLEAN",
  date: "DATE",
  timestamp: "TIMESTAMP",
};

function duckType(type: string): string {
  const parsed = parseTypeName(type);
  if (!parsed) throw new PortError("INVALID", `unsupported column type "${type}"`, { reason: "BAD_TYPE" });
  const sized = /^\s*(decimal|numeric)\s*\(\s*(\d{1,2})\s*,\s*(\d{1,2})\s*\)\s*$/i.exec(type);
  if (sized && Number(sized[2]) <= 38 && Number(sized[3]) <= Number(sized[2])) return `DECIMAL(${sized[2]},${sized[3]})`;
  return DUCK_TYPES[parsed];
}

const duckLiteral = (s: string): string => `'${s.replace(/'/g, "''")}'`;

function splitQualified(name: string): [string, string] {
  const parts = name.split(".");
  if (parts.length !== 2 || !parts.every(isSafeIdent)) {
    throw new PortError("INVALID", `table name "${name.slice(0, 60)}" must be <database>.<table> with plain names`, { reason: "BAD_IDENTIFIER" });
  }
  return [parts[0]!, parts[1]!];
}

export class DuckDbFallbackPort implements FederationPort {
  readonly mode = "fallback" as const;
  private readonly databases = new Map<string, DatabaseEntry>();
  private sealed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private readonly defaultLimit: number;
  private readonly clock: Clock;

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    private readonly config: FallbackPortConfig,
  ) {
    this.defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
    this.clock = config.clock ?? systemClock;
    resolveSchema(config.schema);
  }

  static async create(config: FallbackPortConfig = {}): Promise<DuckDbFallbackPort> {
    const instance = await DuckDBInstance.create(":memory:");
    const connection = await instance.connect();
    // Spark sorts NULL first on ASC and last on DESC; match it so ordered, limited statements agree.
    await connection.run("SET default_null_order='nulls_first_on_asc_last_on_desc'");
    return new DuckDbFallbackPort(instance, connection, config);
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }

  // -------------------------------------------------------------- loading data

  private assertOpen(): void {
    if (this.sealed) throw new PortError("REFUSED", "tables cannot be registered after the first statement has run", { reason: "SEALED" });
  }

  private entry(db: string, options: RegisterOptions): DatabaseEntry {
    let e = this.databases.get(db);
    if (!e) {
      e = { kind: options.sourceKind ?? "lightning", description: options.description ?? db, tables: new Map() };
      this.databases.set(db, e);
    }
    return e;
  }

  /** Create a table from in-memory rows. Values are bound as parameters, never concatenated. */
  async registerTable(qualified: string, columns: readonly TableColumn[], rows: readonly (readonly unknown[])[], options: RegisterOptions = {}): Promise<void> {
    this.assertOpen();
    const [db, table] = splitQualified(qualified);
    if (columns.length === 0) throw new PortError("INVALID", "a table needs at least one column");
    await this.connection.run(`CREATE SCHEMA IF NOT EXISTS ${duckIdent(db)}`);
    const defs = columns.map((c) => `${duckIdent(c.name)} ${duckType(c.type)}`).join(", ");
    await this.connection.run(`CREATE TABLE ${duckIdent(db)}.${duckIdent(table)} (${defs})`);
    const perChunk = Math.max(1, Math.floor(900 / columns.length));
    for (let at = 0; at < rows.length; at += perChunk) {
      const chunk = rows.slice(at, at + perChunk);
      for (const r of chunk) {
        if (r.length !== columns.length) throw new PortError("INVALID", `a row has ${r.length} values for ${columns.length} columns`, { reason: "ROW_WIDTH" });
      }
      const placeholders = chunk.map(() => `(${columns.map(() => "?").join(", ")})`).join(", ");
      await this.connection.run(
        `INSERT INTO ${duckIdent(db)}.${duckIdent(table)} VALUES ${placeholders}`,
        chunk.flat().map((v) => (v === undefined ? null : (v as never))),
      );
    }
    this.entry(db, options).tables.set(table, [...columns]);
  }

  /** Create a table from a CSV file with a header row. With `columns`, values are cast to those types and a bad value fails. */
  async registerCsv(qualified: string, path: string, columns?: readonly TableColumn[], options: RegisterOptions = {}): Promise<void> {
    await this.registerFile(qualified, `read_csv(${duckLiteral(path)}, header=true, all_varchar=true)`, columns, options);
  }

  async registerParquet(qualified: string, path: string, columns?: readonly TableColumn[], options: RegisterOptions = {}): Promise<void> {
    await this.registerFile(qualified, `read_parquet(${duckLiteral(path)})`, columns, options);
  }

  private async registerFile(qualified: string, source: string, columns: readonly TableColumn[] | undefined, options: RegisterOptions): Promise<void> {
    this.assertOpen();
    const [db, table] = splitQualified(qualified);
    if (/\u0000/.test(source)) throw new PortError("INVALID", "path contains a NUL character");
    await this.connection.run(`CREATE SCHEMA IF NOT EXISTS ${duckIdent(db)}`);
    const target = `${duckIdent(db)}.${duckIdent(table)}`;
    if (columns) {
        const select = columns.map((c) => `CAST(${duckIdent(c.name)} AS ${duckType(c.type)}) AS ${duckIdent(c.name)}`).join(", ");
      await this.connection.run(`CREATE TABLE ${target} AS SELECT ${select} FROM ${source}`);
      this.entry(db, options).tables.set(table, [...columns]);
    } else {
      await this.connection.run(`CREATE TABLE ${target} AS SELECT * FROM ${source}`);
      const described = await this.connection.runAndReadAll(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = ${duckLiteral(db)} AND table_name = ${duckLiteral(table)} ORDER BY ordinal_position`);
      this.entry(db, options).tables.set(table, described.getRows().map((r) => ({ name: String(r[0]), type: String(r[1]) })));
    }
  }

  private async seal(): Promise<void> {
    if (this.sealed) return;
    this.sealed = true;
    await this.connection.run("SET enable_external_access=false");
    await this.connection.run("SET lock_configuration=true");
  }

  // -------------------------------------------------------------- FederationPort

  async sql(statement: string, options: FederationQueryOptionsEx = {}): Promise<FederationResult> {
    const prepared = prepareStatement(statement);
    assertReadOnly(prepared);
    const limit = resolveLimit(options.limit, this.defaultLimit);
    const started = performance.now();

    const catalog = this.catalogAnswer(prepared.text);
    let columns: string[];
    let rawRows: (string | null)[][];
    let nativeTypes: ColumnType[];
    if (catalog) {
      ({ columns, rows: rawRows } = catalog);
      nativeTypes = columns.map(() => "string");
    } else {
      const duckSql = translateSparkToDuckDb(prepared.text);
      await this.seal();
      const reader = await this.serial(() => this.connection.runAndReadAll(duckSql)).catch((e: unknown) => {
        throw mapDuckError(e);
      });
      columns = reader.columnNames();
      nativeTypes = reader.columnTypes().map((t) => parseTypeName(t.toString()) ?? "string");
      rawRows = reader.getRowsJson().map((row) =>
        row.map((v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v))),
      );
    }
    assertComplete(rawRows.length, rawRows.length, limit);
    return buildResult({
      raw: { columns, rawRows, total: rawRows.length, queryId: randomUUID(), elapsedMs: Math.round(performance.now() - started) },
      servedFrom: "fallback",
      schema: resolveSchema(mergeSchema(this.config.schema, options.schema)),
      cast: this.config.cast,
      nativeTypes,
    });
  }

  async check(): Promise<CheckResult> {
    const started = performance.now();
    const done = (health: CheckResult["health"], detail: string): CheckResult => ({
      health,
      detail,
      latencyMs: Math.round(performance.now() - started),
      checkedAt: this.clock.now().toISOString(),
    });
    try {
      const r = await this.sql("SELECT 1", { limit: 1 });
      return r.rows[0] && Object.values(r.rows[0])[0] === 1 ? done("STALE", "local DuckDB engine over registered snapshots; degraded, not Zetaris") : done("DRIFTED", "SELECT 1 did not return 1");
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      return done("UNAVAILABLE", `${e.failure}: ${e.message}`);
    }
  }

  // -------------------------------------------------------------- internals

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** The discovery statements the product runs against Zetaris, answered from the registered tables. */
  private catalogAnswer(text: string): { columns: string[]; rows: (string | null)[][] } | undefined {
    if (/^SHOW LIGHTNING DATABASES$/i.test(text) || /^SHOW DATASOURCES$/i.test(text)) {
      const kind = /DATASOURCES/i.test(text) ? "datasource" : "lightning";
      const names = [...this.databases.entries()].filter(([, e]) => e.kind === kind).map(([n, e]) => [n, e] as const).sort(([a], [b]) => a.localeCompare(b));
      return { columns: ["name", "description", "id"], rows: names.map(([n, e], i) => [n, e.description, String(i + 1)]) };
    }
    const tables = /^SHOW (?:TABLES IN|LIGHTNING TABLES|DATASOURCE TABLES)\s+(\S+)$/i.exec(text);
    if (tables) {
      const db = tables[1]!;
      if (!isSafeIdent(db)) throw new PortError("INVALID", "database name is not a plain name", { reason: "BAD_IDENTIFIER" });
      const entry = this.databases.get(db);
      if (!entry) throw new PortError("INVALID", `database ${db} is not registered`, { reason: "UNRESOLVED" });
      return { columns: ["namespace", "tableName", "isTemporary"], rows: [...entry.tables.keys()].sort().map((t) => [db, t, "false"]) };
    }
    if (/^SHOW\b/i.test(text)) throw new PortError("REFUSED", "this SHOW statement has no fallback equivalent", { reason: "UNTRANSLATABLE", construct: "SHOW" });
    return undefined;
  }
}

function duckIdent(name: string): string {
  if (!isSafeIdent(name)) throw new PortError("INVALID", `"${name.slice(0, 40)}" is not a valid SQL name`, { reason: "BAD_IDENTIFIER" });
  return `"${name}"`;
}

function mapDuckError(e: unknown): PortError {
  if (e instanceof PortError) return e;
  const message = (e instanceof Error ? e.message : String(e)).split("\n")[0] ?? "engine error";
  if (/out of memory/i.test(message)) return new PortError("UNAVAILABLE", message, { reason: "OUT_OF_MEMORY", retryable: false });
  return new PortError("INVALID", `the fallback engine rejected the statement: ${message}`, { reason: "ENGINE_ERROR" });
}
