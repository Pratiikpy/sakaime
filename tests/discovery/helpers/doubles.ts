/**
 * Named test doubles for the discovery tests. Each one stands in for something outside the unit: the network, the
 * object store, the federation engine, a model. None is imported from src/, and none pretends to be more than it is:
 *
 *   ServedFetcher        serves bytes for chosen URLs through the real Fetcher interface (the SSRF fetcher has its own suite)
 *   ObjectStoreDouble    an in-memory object store implementing SnapshotLander
 *   EngineDouble         a federation port over DuckDB that understands the few Zetaris statements the pipeline issues
 *                        (SHOW, CREATE LIGHTNING ..., ASSIGN, GRANT, SELECT) and enforces the admin policy
 *   ScriptedModel        a ModelPort that answers from a function, so a test states exactly what the "model" proposed
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuckDBInstance, type DuckDBConnection } from "@duckdb/node-api";
import { buildResult } from "../../../src/federation/result.ts";
import { prepareStatement } from "../../../src/federation/sql.ts";
import { translateSparkToDuckDb } from "../../../src/federation/translate.ts";
import type { FederationQueryOptionsEx } from "../../../src/federation/result.ts";
import { PortError, type CheckResult, type FederationPort, type FederationResult, type ModelPort, type ModelRequest, type ModelResponse } from "../../../src/ports/index.ts";
import type { Fetcher, FetchInit, FetchResult } from "../../../src/sources/fetcher.ts";
import { sha256Hex } from "../../../src/util/canonical.ts";
import type { LandedObject, SnapshotLander } from "../../../src/discovery/landing.ts";

// ---------------------------------------------------------------- network

export class ServedFetcher implements Fetcher {
  readonly servedFrom = "recorded" as const;
  readonly requests: string[] = [];
  constructor(private readonly responses: Map<string, { body: string | Uint8Array; status?: number; contentType?: string } | Error>) {}
  set(url: string, body: string | Uint8Array, status = 200, contentType?: string): void {
    this.responses.set(url, { body, status, ...(contentType ? { contentType } : {}) });
  }
  async get(url: string, _init?: FetchInit): Promise<FetchResult> {
    this.requests.push(url);
    const r = this.responses.get(url);
    if (!r) throw new PortError("UNAVAILABLE", `no response is scripted for ${url}`, { retryable: false });
    if (r instanceof Error) throw r;
    const body = typeof r.body === "string" ? new TextEncoder().encode(r.body) : r.body;
    return {
      requestedUrl: url,
      finalUrl: url,
      status: r.status ?? 200,
      headers: r.contentType ? { "content-type": r.contentType } : {},
      body,
      truncated: false,
      redirects: [],
      servedFrom: "recorded",
      elapsedMs: 1,
    };
  }
}

// ---------------------------------------------------------------- object store

export class ObjectStoreDouble implements SnapshotLander {
  readonly objects = new Map<string, Uint8Array>();
  puts = 0;
  failNext: PortError | undefined;
  async put(bucket: string, key: string, bytes: Uint8Array): Promise<LandedObject> {
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      throw e;
    }
    this.puts += 1;
    this.objects.set(`${bucket}/${key}`, new Uint8Array(bytes));
    return { uri: `s3a://${bucket}/${key}`, sha256: sha256Hex(bytes), bytes: bytes.length };
  }
  read(uri: string): Uint8Array | undefined {
    return this.objects.get(uri.replace(/^s3a:\/\//, ""));
  }
}

// ---------------------------------------------------------------- federation

export interface SeedTable {
  qualified: string;
  /** Path of a CSV file with a header row. */
  csv: string;
}

export interface RecordedStatement {
  sql: string;
  identity: string;
  policy: string;
}

const q = (s: string): string => `"${s.replace(/"/g, '""')}"`;

export class EngineDouble implements FederationPort {
  readonly mode = "fallback" as const;
  readonly statements: RecordedStatement[] = [];
  /** Throw before the n-th (1-based) statement matching the pattern. */
  failAt: { pattern: RegExp; error: PortError; once?: boolean } | undefined;
  reachable = true;
  private readonly tables = new Map<string, Set<string>>();
  private readonly dir = mkdtempSync(join(tmpdir(), "sakaime-engine-"));
  private n = 0;

  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly conn: DuckDBConnection,
    private readonly store: ObjectStoreDouble,
  ) {}

  static async create(store: ObjectStoreDouble, seeds: readonly SeedTable[] = []): Promise<EngineDouble> {
    const instance = await DuckDBInstance.create(":memory:");
    const conn = await instance.connect();
    const e = new EngineDouble(instance, conn, store);
    for (const s of seeds) await e.load(s.qualified, s.csv);
    return e;
  }

  private async load(qualified: string, csv: string): Promise<void> {
    const [db, table] = qualified.split(".") as [string, string];
    await this.conn.run(`CREATE SCHEMA IF NOT EXISTS ${q(db)}`);
    await this.conn.run(`CREATE TABLE ${q(db)}.${q(table)} AS SELECT * FROM read_csv('${csv.replace(/'/g, "''")}', header=true, all_varchar=true)`);
    (this.tables.get(db) ?? this.tables.set(db, new Set()).get(db)!).add(table);
  }

  close(): void {
    this.conn.closeSync();
    this.instance.closeSync();
    rmSync(this.dir, { recursive: true, force: true });
  }

  async check(): Promise<CheckResult> {
    return { health: this.reachable ? "OK" : "UNAVAILABLE", detail: "test engine", latencyMs: 0, checkedAt: new Date(0).toISOString() };
  }

  /** The statements that changed state (DDL and grants). */
  get ddl(): RecordedStatement[] {
    return this.statements.filter((s) => /^(CREATE|ASSIGN|GRANT)\b/i.test(s.sql));
  }

  tablesIn(db: string): string[] {
    return [...(this.tables.get(db) ?? [])].sort();
  }

  async sql(statement: string, options: FederationQueryOptionsEx = {}): Promise<FederationResult> {
    const prepared = prepareStatement(statement);
    const identity = options.identity ?? "default";
    const policy = options.statementPolicy ?? "read-only";
    this.statements.push({ sql: prepared.text, identity, policy });
    this.n += 1;
    if (!this.reachable) throw new PortError("UNAVAILABLE", "the engine is stopped", { reason: "TEST_DOWN", retryable: true });
    if (this.failAt && this.failAt.pattern.test(prepared.text)) {
      const e = this.failAt.error;
      if (this.failAt.once !== false) this.failAt = undefined;
      throw e;
    }
    const text = prepared.text;
    const first = prepared.words[0] ?? "";
    const mutating = /^(CREATE|ASSIGN|GRANT|DROP|ALTER|INSERT|UPDATE|DELETE)$/.test(first);
    if (mutating && policy !== "admin") throw new PortError("REFUSED", `statement beginning ${first} is not read-only`, { reason: "NOT_READ_ONLY" });
    if (mutating && identity !== "admin") throw new PortError("FORBIDDEN", `identity ${identity} may not run ${first}`, { reason: "FORBIDDEN" });
    const answer = (columns: string[], rows: (string | null)[][]): FederationResult =>
      buildResult({ raw: { columns, rawRows: rows, total: rows.length, queryId: `q-${this.n}`, elapsedMs: 1 }, servedFrom: "fallback", schema: new Map(), cast: undefined });

    if (/^SHOW LIGHTNING DATABASES$/i.test(text)) return answer(["name", "description", "id"], [...this.tables.keys()].sort().map((d, i) => [d, d, String(i)]));
    if (/^SHOW DATASOURCES$/i.test(text)) return answer(["name", "description", "id"], []);
    let m = /^SHOW TABLES IN (\w+)$/i.exec(text);
    if (m) return answer(["tableName"], this.tablesIn(m[1]!).map((t) => [t]));
    m = /^CREATE LIGHTNING DATABASE (\w+)\b/i.exec(text);
    if (m) {
      if (this.tables.has(m[1]!)) throw new PortError("INVALID", `database ${m[1]} already exists`);
      await this.conn.run(`CREATE SCHEMA IF NOT EXISTS ${q(m[1]!)}`);
      this.tables.set(m[1]!, new Set());
      return answer(["result"], [["ok"]]);
    }
    m = /^CREATE LIGHTNING FILESTORE TABLE (\w+) FROM (\w+) FORMAT CSV OPTIONS \(path "([^"]+)"/i.exec(text);
    if (m) {
      const [, table, db, uri] = m as unknown as [string, string, string, string];
      if (!this.tables.has(db)) throw new PortError("INVALID", `database ${db} does not exist`);
      if (this.tables.get(db)!.has(table)) throw new PortError("INVALID", `table ${table} already exists`);
      const bytes = this.store.read(uri);
      if (!bytes) throw new PortError("INVALID", `Path does not exist or is not allowed: ${uri}`);
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${db}-${table}-${this.n}.csv`);
      writeFileSync(file, bytes);
      await this.load(`${db}.${table}`, file);
      return answer(["result"], [["ok"]]);
    }
    if (/^(ASSIGN|GRANT) /i.test(text)) return answer(["result"], [["ok"]]);
    if (first !== "SELECT" && first !== "WITH") throw new PortError("INVALID", `the test engine does not understand ${first}`);

    const duck = translateSparkToDuckDb(text);
    try {
      const reader = await this.conn.runAndReadAll(duck);
      const columns = reader.columnNames();
      const rows = reader.getRowsJson().map((r) => r.map((v) => (v === null || v === undefined ? null : typeof v === "object" ? JSON.stringify(v) : String(v))));
      return answer(columns, rows);
    } catch (e) {
      throw new PortError("INVALID", `the engine rejected the statement: ${(e as Error).message.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------- model

export type Reply = { mappings: { sourceField: string; canonicalField: string | null; confidence: number; rationale?: string }[] };

export class ScriptedModel implements ModelPort {
  readonly requests: ModelRequest[] = [];
  constructor(private readonly answer: (request: ModelRequest, call: number) => Reply | Error | string) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);
    const out = this.answer(request, this.requests.length);
    if (out instanceof Error) throw out;
    const json = typeof out === "string" ? undefined : out;
    return {
      text: typeof out === "string" ? out : JSON.stringify(out),
      ...(json ? { json } : {}),
      requestedModel: "scripted",
      routedModel: "scripted/test-double",
      provider: "recorded",
      usage: { measured: false },
      recorded: true,
    };
  }
}

/** A model that maps every column to the canonical field named for it in `by`. */
export const modelMapping =
  (by: Record<string, string | null>, confidence = 0.9): ConstructorParameters<typeof ScriptedModel>[0] =>
  (request) => {
    const columns = (JSON.parse(request.user) as { columns: { name: string }[] }).columns.map((c) => c.name);
    return { mappings: columns.map((name) => ({ sourceField: name, canonicalField: by[name] ?? null, confidence })) };
  };
