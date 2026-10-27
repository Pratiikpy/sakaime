/**
 * Service configuration: where the inputs and recordings live, which mode each layer runs in, and the clock.
 *
 * SAMPLE_MODE=true makes every external read come from committed recordings. The compiler, the identity scorer, the
 * extractors, the verifiers and the guard still execute for real on the recorded inputs; only the world is replayed.
 * Nothing here reads a secret value: the names of the variables are listed in MODEL_ENV_NAMES / ZETARIS_ENV_NAMES and the
 * values stay in the process environment.
 */
import { existsSync, readFileSync } from "node:fs";
import { parseEnv } from "node:util";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock } from "../ports/index.ts";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const SERVICE_VERSION = "0.1.0";

/** Moment every replayed run is stamped with, so two sample runs are byte-equal. */
export const SAMPLE_EPOCH = "2026-10-27T12:00:00.000Z";

export const ZETARIS_ENV_NAMES = [
  "ZETARIS_REST_URL",
  "ZETARIS_API_KEY",
  "ZETARIS_ORG_ID",
  "SAKAIME_ZETARIS_READER_EMAIL",
  "SAKAIME_ZETARIS_READER_PASSWORD",
] as const;

export interface ServiceDirs {
  root: string;
  /** Case definitions (the input examples). */
  cases: string;
  /** Silo files: the constructed vendor packets and hospital rows. */
  silos: string;
  /** Recorded source responses made by this service (public records only). */
  sourceCassette: string;
  /** The earlier public-evidence recording from the feasibility probe. */
  publicCassette: string;
  /** Recorded FDA decision summaries for sample mode. */
  documents: string;
  federationCassettes: string;
  modelCassettes: string;
  /** The committed recorded run (labels and queries), compared byte for byte in the replay test. */
  sampleRun: string;
  /** Committed outputs: dossiers and traces. */
  outputs: string;
  /** Local mutable state (request budgets, export ledger). Never committed. */
  state: string;
}

export interface ServiceConfig {
  sample: boolean;
  env: Record<string, string | undefined>;
  dirs: ServiceDirs;
  clock: Clock;
  /** Call limits for one investigation of one case. */
  limits: InvestigationLimits;
  /** Ports to listen on; the API binds to loopback unless HOST says otherwise. */
  host: string;
  port: number;
  /** The one origin allowed to call the API from a browser. */
  corsOrigin: string;
  /** Record live responses into the sample cassettes (source, federation, model). */
  record: boolean;
}

export interface InvestigationLimits {
  /** Compile/critique turns per case. */
  maxTurns: number;
  /** Seconds to wait for one external call. */
  callTimeoutMs: number;
  /** Retries of a failed step after the connector's own. */
  maxRetries: number;
  /** Source requests per case (documents included). */
  maxSourceCalls: number;
  /** Model calls per case. */
  maxModelCalls: number;
  /** Federation statements per case. */
  maxFederationCalls: number;
  /** Candidate registry/literature records examined per case. */
  maxCandidates: number;
}

export const DEFAULT_LIMITS: InvestigationLimits = {
  maxTurns: 4,
  callTimeoutMs: 60_000,
  maxRetries: 1,
  maxSourceCalls: 40,
  maxModelCalls: 24,
  maxFederationCalls: 6,
  maxCandidates: 4,
};

/** A clock that advances one millisecond per reading from a fixed start, so a replayed run has stable, ordered stamps. */
export function deterministicClock(start: string = SAMPLE_EPOCH): Clock {
  let t = Date.parse(start);
  return {
    now: () => {
      const d = new Date(t);
      t += 1;
      return d;
    },
  };
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && /^(1|true|yes)$/i.test(v.trim());
}

export function defaultDirs(root: string = REPO_ROOT): ServiceDirs {
  return {
    root,
    cases: join(root, "input_examples", "cases"),
    silos: join(root, "data", "silos"),
    sourceCassette: join(root, "data", "sample", "source-cassette"),
    publicCassette: join(root, "data", "cassettes", "public-evidence-2026-10-27"),
    documents: join(root, "data", "sample", "documents"),
    federationCassettes: join(root, "data", "federation-cassettes"),
    modelCassettes: join(root, "data", "model-cassettes"),
    sampleRun: join(root, "data", "sample", "run"),
    outputs: join(root, "output_examples"),
    state: process.env["SAKAIME_STATE_DIR"] ?? join(root, ".sakaime", "state"),
  };
}

/**
 * Loads  from the repository root into process.env unless SAKAIME_NO_ENV is set. Missing file is fine.
 * Values in the repository .env win over variables already in the shell: a stale key exported in a long-lived
 * shell otherwise shadows the project key and every model call fails with HTTP 403.
 */
export function loadDotEnv(root: string = REPO_ROOT): void {
  if (truthy(process.env["SAKAIME_NO_ENV"])) return;
  const file = join(root, ".env");
  if (!existsSync(file)) return;
  try {
    for (const [key, value] of Object.entries(parseEnv(readFileSync(file, "utf8")))) {
      if (value !== undefined) process.env[key] = value;
    }
  } catch {
    /* an unreadable .env is treated as absent; the model layer reports which provider is missing */
  }
}

export interface ConfigOverrides {
  sample?: boolean;
  env?: Record<string, string | undefined>;
  dirs?: Partial<ServiceDirs>;
  clock?: Clock;
  limits?: Partial<InvestigationLimits>;
  host?: string;
  port?: number;
  corsOrigin?: string;
  record?: boolean;
}

export function loadConfig(overrides: ConfigOverrides = {}): ServiceConfig {
  const env = overrides.env ?? process.env;
  const sample = overrides.sample ?? truthy(env["SAMPLE_MODE"]);
  const record = overrides.record ?? truthy(env["SAKAIME_RECORD"]);
  if (sample && record) throw new Error("SAMPLE_MODE and SAKAIME_RECORD cannot both be set: a replayed run records nothing");
  const dirs = { ...defaultDirs(), ...(overrides.dirs ?? {}) };
  return {
    sample,
    env,
    dirs,
    clock: overrides.clock ?? (sample ? deterministicClock() : systemClock),
    limits: { ...DEFAULT_LIMITS, ...(overrides.limits ?? {}) },
    host: overrides.host ?? env["HOST"] ?? "127.0.0.1",
    port: overrides.port ?? Number(env["PORT"] ?? 8787),
    corsOrigin: overrides.corsOrigin ?? env["SAKAIME_UI_ORIGIN"] ?? "http://localhost:5173",
    record,
  };
}
