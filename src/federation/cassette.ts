/**
 * Cassettes: recorded real Zetaris responses, replayed for judges and CI.
 *
 * A cassette stores the wire form of one response (column names and string values) under a key derived from
 * the normalised statement and the identity that ran it. Typing is applied at replay, so changing the declared
 * schema never invalidates a recording. Every load re-derives the key and the response hash, so an edited,
 * renamed or swapped file is refused. A statement with no recording is an explicit error: nothing is invented.
 *
 * Cassettes recorded under a privileged identity hold what that identity saw. Record restricted-identity
 * cassettes for anything that will be committed.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PortError, systemClock, type CheckResult, type Clock, type FederationPort, type FederationResult } from "../ports/index.ts";
import { resolveSchema, type CastOptions, type DeclaredSchema } from "./cast.ts";
import {
  assertComplete,
  buildResult,
  DEFAULT_LIMIT,
  mergeSchema,
  rawResultHash,
  resolveLimit,
  type FederationQueryOptionsEx,
  type RawFederationPort,
  type RawFederationResult,
} from "./result.ts";
import { assertReadOnly, prepareStatement, statementKey } from "./sql.ts";

export const CASSETTE_FORMAT = "sakaime.federation-cassette/1";
export const DEFAULT_CASSETTE_DIR = "data/federation-cassettes";

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const CassetteSchema = z
  .object({
    format: z.literal(CASSETTE_FORMAT),
    key: Hex64,
    statement: z.string().min(1),
    identity: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
    columns: z.array(z.string()),
    rawRows: z.array(z.array(z.string().nullable())),
    total: z.number().int().nonnegative(),
    queryId: z.string().min(1),
    recordedElapsedMs: z.number().nonnegative(),
    respHash: Hex64,
  })
  .strict();
export type CassetteFile = z.infer<typeof CassetteSchema>;

/** A replayed result: the port contract plus when the live response was recorded. */
export interface RecordedFederationResult extends FederationResult {
  recordedAt: string;
  recordedElapsedMs: number;
}

function broken(file: string, reason: "CASSETTE_TAMPERED" | "CASSETTE_MALFORMED", what: string): PortError {
  return new PortError("INVALID", `cassette ${file} failed its integrity check: ${what}`, { reason, file });
}

export class CassetteStore {
  constructor(readonly dir: string = DEFAULT_CASSETTE_DIR) {}

  fileFor(normalisedStatement: string, identity: string): string {
    return join(this.dir, `zetaris-${statementKey(normalisedStatement, identity).slice(0, 32)}.json`);
  }

  /** Write one recording atomically. Returns the file path. */
  write(raw: RawFederationResult, recordedAt: string): string {
    const file: CassetteFile = {
      format: CASSETTE_FORMAT,
      key: statementKey(raw.statement, raw.identity),
      statement: raw.statement,
      identity: raw.identity,
      recordedAt,
      columns: raw.columns,
      rawRows: raw.rawRows,
      total: raw.total,
      queryId: raw.queryId,
      recordedElapsedMs: raw.elapsedMs,
      respHash: rawResultHash(raw.columns, raw.rawRows),
    };
    mkdirSync(this.dir, { recursive: true });
    const path = this.fileFor(raw.statement, raw.identity);
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`);
    renameSync(tmp, path);
    return path;
  }

  /** Load and verify one recording. Returns undefined when none exists; throws INVALID when one exists and is not intact. */
  load(normalisedStatement: string, identity: string): CassetteFile | undefined {
    const path = this.fileFor(normalisedStatement, identity);
    if (!existsSync(path)) return undefined;
    return this.verifyFile(path, statementKey(normalisedStatement, identity));
  }

  verifyFile(path: string, expectedKey?: string): CassetteFile {
    const name = path.split(/[\\/]/).pop() ?? path;
    let json: unknown;
    try {
      json = JSON.parse(readFileSync(path, "utf8"));
    } catch {
      throw broken(name, "CASSETTE_MALFORMED", "not valid JSON");
    }
    const parsed = CassetteSchema.safeParse(json);
    if (!parsed.success) throw broken(name, "CASSETTE_MALFORMED", "does not match the cassette format");
    const file = parsed.data;
    if (statementKey(file.statement, file.identity) !== file.key) throw broken(name, "CASSETTE_TAMPERED", "statement or identity no longer matches its key");
    if (expectedKey !== undefined && file.key !== expectedKey) throw broken(name, "CASSETTE_TAMPERED", "file holds a different statement than its name says");
    if (file.rawRows.some((r) => r.length !== file.columns.length)) throw broken(name, "CASSETTE_TAMPERED", "a row does not match the column count");
    if (rawResultHash(file.columns, file.rawRows) !== file.respHash) throw broken(name, "CASSETTE_TAMPERED", "response hash does not match the recorded rows");
    return file;
  }

  /** Verify every recording in the directory. */
  verifyAll(): { intact: string[]; broken: { file: string; error: string }[] } {
    const intact: string[] = [];
    const bad: { file: string; error: string }[] = [];
    if (!existsSync(this.dir)) return { intact, broken: bad };
    for (const name of readdirSync(this.dir).filter((f) => /^zetaris-[0-9a-f]{32}\.json$/.test(f))) {
      try {
        this.verifyFile(join(this.dir, name));
        intact.push(name);
      } catch (e) {
        bad.push({ file: name, error: e instanceof Error ? e.message : String(e) });
      }
    }
    return { intact, broken: bad };
  }
}

export interface CassettePortConfig {
  store: CassetteStore;
  defaultIdentity?: string;
  schema?: DeclaredSchema;
  cast?: CastOptions;
  defaultLimit?: number;
}

/** Mode "cassette": replays recorded real responses. Never contacts any engine. */
export class CassettePort implements FederationPort {
  readonly mode = "cassette" as const;
  private readonly defaultIdentity: string;
  private readonly defaultLimit: number;

  constructor(private readonly config: CassettePortConfig) {
    this.defaultIdentity = config.defaultIdentity ?? "default";
    this.defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
    resolveSchema(config.schema);
  }

  async sql(statement: string, options: FederationQueryOptionsEx = {}): Promise<RecordedFederationResult> {
    const prepared = prepareStatement(statement);
    // Same refusals as the live port, so a judge in cassette mode sees the behaviour the live system has.
    if ((options.statementPolicy ?? "read-only") === "read-only") assertReadOnly(prepared);
    const identity = options.identity ?? this.defaultIdentity;
    const limit = resolveLimit(options.limit, this.defaultLimit);
    const file = this.config.store.load(prepared.text, identity);
    if (!file) {
      throw new PortError(
        "UNAVAILABLE",
        `no recorded response for this statement and identity "${identity}" (key ${statementKey(prepared.text, identity).slice(0, 12)}); record it against the live engine`,
        { reason: "CASSETTE_MISS", identity, retryable: false },
      );
    }
    assertComplete(file.rawRows.length, file.total, limit);
    const base = buildResult({
      raw: { columns: file.columns, rawRows: file.rawRows, total: file.total, queryId: file.queryId, elapsedMs: 0 },
      servedFrom: "cassette",
      schema: resolveSchema(mergeSchema(this.config.schema, options.schema)),
      cast: this.config.cast,
    });
    return { ...base, recordedAt: file.recordedAt, recordedElapsedMs: file.recordedElapsedMs };
  }

  /**
   * Replay is not a probe of any engine. A directory whose recordings are all intact reports STALE (recorded data,
   * not live); any broken recording reports DRIFTED; no recordings report UNAVAILABLE.
   */
  async check(): Promise<CheckResult> {
    const started = performance.now();
    const { intact, broken: bad } = this.config.store.verifyAll();
    const finish = (health: CheckResult["health"], detail: string): CheckResult => ({
      health,
      detail,
      latencyMs: Math.round(performance.now() - started),
      checkedAt: systemClock.now().toISOString(),
    });
    if (bad.length > 0) return finish("DRIFTED", `${bad.length} recording(s) failed verification: ${bad.map((b) => b.file).join(", ")}`);
    if (intact.length === 0) return finish("UNAVAILABLE", "no recordings found");
    return finish("STALE", `replaying ${intact.length} recorded response(s); not a live engine`);
  }
}

export interface RecordingPortConfig {
  clock?: Clock;
}

/** Wraps a live raw-capable port and writes each successful response to the store. Failures and refused partial results are never recorded. */
export class RecordingPort implements RawFederationPort {
  readonly recorded: { file: string; statement: string; identity: string }[] = [];
  private readonly clock: Clock;

  constructor(
    private readonly inner: RawFederationPort,
    private readonly store: CassetteStore,
    config: RecordingPortConfig = {},
  ) {
    this.clock = config.clock ?? systemClock;
  }

  get mode(): RawFederationPort["mode"] {
    return this.inner.mode;
  }

  async sqlRaw(statement: string, options?: FederationQueryOptionsEx): Promise<RawFederationResult> {
    const raw = await this.inner.sqlRaw(statement, options);
    const file = this.store.write(raw, this.clock.now().toISOString());
    this.recorded.push({ file, statement: raw.statement, identity: raw.identity });
    return raw;
  }

  toResult(raw: RawFederationResult, options?: FederationQueryOptionsEx): FederationResult {
    return this.inner.toResult(raw, options);
  }

  async sql(statement: string, options?: FederationQueryOptionsEx): Promise<FederationResult> {
    return this.toResult(await this.sqlRaw(statement, options), options);
  }

  check(): Promise<CheckResult> {
    return this.inner.check();
  }
}
