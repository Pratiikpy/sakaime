/**
 * Recordings of the semantic layer: the real answers the read-only agent identity got from Zetaris, kept so that a judge
 * without Docker sees the same layer, the same rule results and the same query ids.
 *
 * One file holds the statements of one read (the overview, or one case), named usl-<scope>.json. Each step stores the wire
 * form of one response under the key of its normalised statement and identity, as the ordinary federation cassettes do
 * (cassette.ts), and the file as a whole carries a hash over its steps, so an edited, reordered, truncated or swapped file is
 * refused when it is loaded. A statement with no recording is an explicit error (UNAVAILABLE, CASSETTE_MISS): nothing is
 * invented, and a recording is never offered as a live answer (servedFrom says "cassette").
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PortError, type FederationResult } from "../ports/index.ts";
import { sha256Hex } from "../util/canonical.ts";
import { resolveSchema } from "./cast.ts";
import {
  assertComplete,
  buildResult,
  DEFAULT_LIMIT,
  mergeSchema,
  rawResultHash,
  resolveLimit,
  type FederationQueryOptionsEx,
  type RawFederationPort,
} from "./result.ts";
import { assertReadOnly, prepareStatement, statementKey } from "./sql.ts";
import type { UslSqlPort } from "./usl.ts";

export const USL_CASSETTE_FORMAT = "sakaime.usl-cassette/1";

const Hex64 = z.string().regex(/^[0-9a-f]{64}$/);

const StepSchema = z
  .object({
    key: Hex64,
    statement: z.string().min(1),
    identity: z.string().min(1),
    columns: z.array(z.string()),
    rawRows: z.array(z.array(z.string().nullable())),
    total: z.number().int().nonnegative(),
    queryId: z.string().min(1),
    recordedElapsedMs: z.number().nonnegative(),
    respHash: Hex64,
  })
  .strict();

const FileSchema = z
  .object({
    format: z.literal(USL_CASSETTE_FORMAT),
    /** "overview" or "case:<id>". */
    scope: z.string().min(1),
    recordedAt: z.string().datetime({ offset: true }),
    /** The logical name of the identity that asked, never an address or a credential. */
    readerIdentity: z.string().min(1),
    /** Path of the layer the statements read. */
    layer: z.string().min(1),
    structureHash: Hex64,
    steps: z.array(StepSchema).min(1),
    stepsHash: Hex64,
  })
  .strict();
export type UslCassetteStep = z.infer<typeof StepSchema>;
export type UslCassetteFile = z.infer<typeof FileSchema>;

const stepsHash = (steps: readonly UslCassetteStep[]): string => sha256Hex(JSON.stringify(steps.map((s) => [s.key, s.respHash])));

function broken(file: string, what: string, reason: "CASSETTE_TAMPERED" | "CASSETTE_MALFORMED" = "CASSETTE_TAMPERED"): PortError {
  return new PortError("INVALID", `semantic-layer recording ${file} failed its integrity check: ${what}`, { reason, file });
}

export const uslCassetteName = (scope: string): string => `usl-${scope.replace(/^case:/, "case-").replace(/[^A-Za-z0-9_.-]/g, "_")}.json`;

/** Read and verify one file. */
export function verifyUslCassette(path: string): UslCassetteFile {
  const name = path.split(/[\\/]/).pop() ?? path;
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw broken(name, "not valid JSON", "CASSETTE_MALFORMED");
  }
  const parsed = FileSchema.safeParse(json);
  if (!parsed.success) throw broken(name, "does not match the recording format", "CASSETTE_MALFORMED");
  const file = parsed.data;
  for (const step of file.steps) {
    if (statementKey(step.statement, step.identity) !== step.key) throw broken(name, "a statement no longer matches its key");
    if (step.rawRows.some((r) => r.length !== step.columns.length)) throw broken(name, "a row does not match the column count");
    if (rawResultHash(step.columns, step.rawRows) !== step.respHash) throw broken(name, "a response hash does not match its rows");
  }
  if (stepsHash(file.steps) !== file.stepsHash) throw broken(name, "the steps were changed, removed or reordered");
  if (name !== uslCassetteName(file.scope)) throw broken(name, `the file name does not match its scope "${file.scope}"`);
  return file;
}

export function writeUslCassette(dir: string, file: Omit<UslCassetteFile, "format" | "stepsHash">): string {
  const full: UslCassetteFile = { format: USL_CASSETTE_FORMAT, ...file, stepsHash: stepsHash(file.steps) };
  FileSchema.parse(full);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, uslCassetteName(file.scope));
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(full, null, 2)}\n`);
  renameSync(tmp, path);
  return path;
}

/** Wraps a live raw-capable port, labels the identity, and keeps every successful response for writeUslCassette. */
export class UslRecorder implements UslSqlPort {
  readonly steps: UslCassetteStep[] = [];
  constructor(
    private readonly inner: RawFederationPort,
    readonly identityLabel: string,
  ) {}

  async sql(statement: string, options: FederationQueryOptionsEx = {}): Promise<FederationResult> {
    const raw = await this.inner.sqlRaw(statement, options);
    const normalised = raw.statement;
    if (!this.steps.some((s) => s.key === statementKey(normalised, this.identityLabel))) {
      this.steps.push({
        key: statementKey(normalised, this.identityLabel),
        statement: normalised,
        identity: this.identityLabel,
        columns: raw.columns,
        rawRows: raw.rawRows,
        total: raw.total,
        queryId: raw.queryId,
        recordedElapsedMs: raw.elapsedMs,
        respHash: rawResultHash(raw.columns, raw.rawRows),
      });
    }
    return this.inner.toResult(raw, options);
  }

  /** Forget what was recorded so far, to start the next scope. */
  drain(): UslCassetteStep[] {
    return this.steps.splice(0, this.steps.length);
  }
}

export interface RecordedUslResult extends FederationResult {
  recordedAt: string;
}

/** Replays recorded responses. Never contacts any engine. */
export class UslCassettePort implements UslSqlPort {
  readonly mode = "cassette" as const;
  private readonly index = new Map<string, { step: UslCassetteStep; recordedAt: string }>();
  readonly files: UslCassetteFile[] = [];

  constructor(
    readonly dir: string,
    readonly identityLabel = "agent-reader",
  ) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir).filter((f) => /^usl-.+\.json$/.test(f)).sort()) {
      const file = verifyUslCassette(join(dir, name));
      this.files.push(file);
      for (const step of file.steps) this.index.set(step.key, { step, recordedAt: file.recordedAt });
    }
  }

  /** True when at least one verified recording exists. */
  get available(): boolean {
    return this.files.length > 0;
  }

  async sql(statement: string, options: FederationQueryOptionsEx = {}): Promise<RecordedUslResult> {
    const prepared = prepareStatement(statement);
    if ((options.statementPolicy ?? "read-only") === "read-only") assertReadOnly(prepared);
    const identity = options.identity ?? this.identityLabel;
    const limit = resolveLimit(options.limit, DEFAULT_LIMIT);
    const hit = this.index.get(statementKey(prepared.text, identity));
    if (!hit) {
      throw new PortError("UNAVAILABLE", `no recorded response for this statement as ${identity}; record it against the live engine (key ${statementKey(prepared.text, identity).slice(0, 12)})`, {
        reason: "CASSETTE_MISS",
        retryable: false,
      });
    }
    assertComplete(hit.step.rawRows.length, hit.step.total, limit);
    const base = buildResult({
      raw: { columns: hit.step.columns, rawRows: hit.step.rawRows, total: hit.step.total, queryId: hit.step.queryId, elapsedMs: hit.step.recordedElapsedMs },
      servedFrom: "cassette",
      schema: resolveSchema(mergeSchema(undefined, options.schema)),
      cast: undefined,
    });
    return { ...base, recordedAt: hit.recordedAt };
  }
}
