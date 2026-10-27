/**
 * The live Zetaris port.
 *
 * Wire contract (verified against the local install, 2026-10-16 and 2026-10-22; see
 * research/hackathon/sponsors/zetaris-local-setup.md):
 *   POST {restUrl}/sql-editor/sqls/run
 *   headers  Authorization: Bearer <api key>, X-Org-ID, X-Request-ID (a fresh UUID)
 *   body     exactly {queryId, sql, source: "SqlEditor", limit}
 *   200      {"headers": [...], "data": [[...]], "total": n, "timeUsed": ms}, every value a string or null
 *
 * Behaviour the rest of the product depends on:
 *   - one statement per request, no trailing semicolon (see sql.ts);
 *   - the engine is asked for limit+1 rows, so a capped answer is detected even when `total` is wrong;
 *   - a result that may be partial is refused (TRUNCATED), never returned;
 *   - infrastructure faults (stopped Spark context, thrift errors, 5xx, timeouts, refused connections) are
 *     UNAVAILABLE and retried with capped backoff; access refusals are FORBIDDEN and never retried;
 *   - check() runs a real SELECT 1 through the engine;
 *   - an API key never appears in an error, a detail field or a log line.
 */
import { randomUUID } from "node:crypto";
import {
  PortError,
  systemClock,
  type CheckResult,
  type Clock,
  type FailureClass,
  type FederationResult,
} from "../ports/index.ts";
import { resolveSchema, type CastOptions, type DeclaredSchema } from "./cast.ts";
import { classifyFailure, scrub } from "./classify.ts";
import {
  assertComplete,
  buildResult,
  DEFAULT_LIMIT,
  mergeSchema,
  resolveLimit,
  type FederationQueryOptionsEx,
  type RawFederationPort,
  type RawFederationResult,
} from "./result.ts";
import { assertReadOnly, prepareStatement } from "./sql.ts";

export interface ZetarisCredential {
  apiKey: string;
  /** Overrides the port's organisation id for this identity. */
  orgId?: string;
}

export interface ZetarisPortConfig {
  /** Base of the REST route including the version, for example http://localhost:8888/api/v1.0 */
  restUrl: string;
  orgId: string;
  /** Named identities. Each maps to its own Zetaris API key, so two reviewers can see different columns for one statement. */
  identities: Record<string, ZetarisCredential>;
  defaultIdentity: string;
  /** Declared types by output column name; the wire response carries none. */
  schema?: DeclaredSchema;
  cast?: CastOptions;
  defaultLimit?: number;
  /** Per attempt. The engine's own limit is 60 s, so this is capped at 55 s. Default 45 s. */
  attemptTimeoutMs?: number;
  /** Total attempts including the first. Default 3. */
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  /** No retry starts if it could not finish inside this budget. Default 120 s. */
  totalBudgetMs?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Monotonic milliseconds. */
  now?: () => number;
  random?: () => number;
  clock?: Clock;
}

export const HARD_ATTEMPT_TIMEOUT_MS = 55_000;
const SQL_PATH = "/sql-editor/sqls/run";

/** Read the connection settings from the environment. Returns null when any of the three is missing. */
export function zetarisConfigFromEnv(env: Record<string, string | undefined>): ZetarisPortConfig | null {
  const restUrl = env["ZETARIS_REST_URL"];
  const apiKey = env["ZETARIS_API_KEY"];
  const orgId = env["ZETARIS_ORG_ID"];
  if (!restUrl || !apiKey || !orgId) return null;
  const identities: Record<string, ZetarisCredential> = { default: { apiKey } };
  // Extra reviewer identities: ZETARIS_API_KEY__<NAME> becomes identity "<name>" (lower case).
  for (const [k, v] of Object.entries(env)) {
    const m = /^ZETARIS_API_KEY__([A-Za-z0-9_]+)$/.exec(k);
    if (m && v) identities[m[1]!.toLowerCase()] = { apiKey: v };
  }
  return { restUrl, orgId, identities, defaultIdentity: "default" };
}

interface Attempt {
  raw: Omit<RawFederationResult, "statement" | "identity" | "elapsedMs">;
  elapsedMs: number;
}

export class ZetarisPort implements RawFederationPort {
  readonly mode = "live" as const;
  private readonly url: string;
  private readonly secrets: string[];
  private readonly schema: DeclaredSchema | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly clock: Clock;
  private readonly attemptTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly backoffBaseMs: number;
  private readonly backoffMaxMs: number;
  private readonly totalBudgetMs: number;
  private readonly defaultLimit: number;

  constructor(private readonly config: ZetarisPortConfig) {
    let parsed: URL;
    try {
      parsed = new URL(config.restUrl);
    } catch {
      throw new PortError("INVALID", "restUrl is not a valid URL", { reason: "BAD_CONFIG" });
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new PortError("INVALID", "restUrl must be http or https", { reason: "BAD_CONFIG" });
    }
    if (!config.identities[config.defaultIdentity]) {
      throw new PortError("INVALID", `default identity "${config.defaultIdentity}" is not configured`, { reason: "BAD_CONFIG" });
    }
    for (const [name, cred] of Object.entries(config.identities)) {
      if (!cred.apiKey) throw new PortError("INVALID", `identity "${name}" has no API key`, { reason: "BAD_CONFIG" });
    }
    resolveSchema(config.schema); // fail now on an unknown declared type
    this.url = `${config.restUrl.replace(/\/+$/, "")}${SQL_PATH}`;
    this.secrets = Object.values(config.identities).map((c) => c.apiKey);
    this.schema = config.schema;
    this.fetchImpl = config.fetch ?? fetch;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = config.now ?? (() => performance.now());
    this.random = config.random ?? Math.random;
    this.clock = config.clock ?? systemClock;
    this.attemptTimeoutMs = Math.min(config.attemptTimeoutMs ?? 45_000, HARD_ATTEMPT_TIMEOUT_MS);
    this.maxAttempts = Math.max(1, config.maxAttempts ?? 3);
    this.backoffBaseMs = config.backoffBaseMs ?? 250;
    this.backoffMaxMs = config.backoffMaxMs ?? 4_000;
    this.totalBudgetMs = config.totalBudgetMs ?? 120_000;
    this.defaultLimit = config.defaultLimit ?? DEFAULT_LIMIT;
  }

  identityNames(): string[] {
    return Object.keys(this.config.identities);
  }

  async sql(statement: string, options: FederationQueryOptionsEx = {}): Promise<FederationResult> {
    return this.toResult(await this.sqlRaw(statement, options), options);
  }

  toResult(raw: RawFederationResult, options: FederationQueryOptionsEx = {}): FederationResult {
    return buildResult({
      raw,
      servedFrom: "live",
      schema: resolveSchema(mergeSchema(this.schema, options.schema)),
      cast: this.config.cast,
    });
  }

  async sqlRaw(statement: string, options: FederationQueryOptionsEx = {}): Promise<RawFederationResult> {
    return this.execute(statement, options, this.maxAttempts);
  }

  /** A real probe: SELECT 1 through the engine, one attempt, as the default (or given) identity. Never a container healthcheck. */
  async check(identity?: string): Promise<CheckResult> {
    const started = this.now();
    const done = (health: CheckResult["health"], detail: string): CheckResult => ({
      health,
      detail,
      latencyMs: Math.round(this.now() - started),
      checkedAt: this.clock.now().toISOString(),
    });
    try {
      const raw = await this.execute("SELECT 1", { limit: 1, ...(identity ? { identity } : {}) }, 1);
      const value = raw.rawRows[0]?.[0];
      if (raw.rawRows.length !== 1 || raw.columns.length !== 1 || value !== "1") {
        return done("DRIFTED", "SELECT 1 did not return the single value 1");
      }
      return done("OK", `SELECT 1 answered by the engine (query ${raw.queryId})`);
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      return done(healthFor(e.failure), `${e.failure}: ${e.message}`);
    }
  }

  // -------------------------------------------------------------- internals

  private async execute(statement: string, options: FederationQueryOptionsEx, maxAttempts: number): Promise<RawFederationResult> {
    const prepared = prepareStatement(statement);
    if ((options.statementPolicy ?? "read-only") === "read-only") assertReadOnly(prepared);
    const identity = options.identity ?? this.config.defaultIdentity;
    const cred = this.config.identities[identity];
    if (!cred) {
      throw new PortError("REFUSED", `identity "${identity}" is not configured`, { reason: "UNKNOWN_IDENTITY", identity });
    }
    const limit = resolveLimit(options.limit, this.defaultLimit);
    const timeoutMs = Math.min(options.timeoutMs ?? this.attemptTimeoutMs, HARD_ATTEMPT_TIMEOUT_MS);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new PortError("INVALID", "timeoutMs must be a positive number", { timeoutMs });

    const began = this.now();
    let lastError: PortError | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const got = await this.once(prepared.text, cred, limit, timeoutMs);
        assertComplete(got.raw.rawRows.length, got.raw.total, limit);
        return { ...got.raw, elapsedMs: Math.round(got.elapsedMs), statement: prepared.text, identity };
      } catch (e) {
        if (!(e instanceof PortError)) throw e;
        lastError = e;
        const retryable = e.failure === "UNAVAILABLE" && e.detail?.["retryable"] !== false;
        if (!retryable || attempt === maxAttempts) throw this.withAttempts(e, attempt);
        const wait = this.backoff(attempt, e.detail?.["retryAfterMs"]);
        if (this.now() - began + wait + timeoutMs > this.totalBudgetMs) throw this.withAttempts(e, attempt, true);
        await this.sleep(wait);
      }
    }
    /* c8 ignore next */
    throw lastError ?? new PortError("UNAVAILABLE", "no attempt was made");
  }

  private backoff(attempt: number, retryAfter: unknown): number {
    const exp = Math.min(this.backoffMaxMs, this.backoffBaseMs * 2 ** (attempt - 1));
    const jittered = Math.round(exp * (0.75 + this.random() * 0.5));
    const asked = typeof retryAfter === "number" && retryAfter > 0 ? Math.min(retryAfter, this.backoffMaxMs) : 0;
    return Math.max(jittered, asked);
  }

  private withAttempts(e: PortError, attempts: number, budget = false): PortError {
    const note = attempts > 1 || budget ? ` (after ${attempts} attempt${attempts === 1 ? "" : "s"}${budget ? ", retry budget spent" : ""})` : "";
    return new PortError(e.failure, `${e.message}${note}`, { ...e.detail, attempts });
  }

  private async once(sql: string, cred: ZetarisCredential, limit: number, timeoutMs: number): Promise<Attempt> {
    const queryId = randomUUID();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const started = this.now();
    let status: number;
    let text: string;
    let retryAfterMs: number | undefined;
    try {
      const res = await this.fetchImpl(this.url, {
        method: "POST",
        // Never follow a redirect: it would carry the bearer key to wherever the redirect points.
        redirect: "manual",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${cred.apiKey}`,
          "X-Org-ID": cred.orgId ?? this.config.orgId,
          "X-Request-ID": randomUUID(),
          "Content-Type": "application/json",
        },
        // limit+1: receiving more than `limit` rows proves the answer was cut, whatever `total` says.
        body: JSON.stringify({ queryId, sql, source: "SqlEditor", limit: limit + 1 }),
      });
      status = res.status;
      const header = res.headers.get("retry-after");
      if (header && /^\d+$/.test(header)) retryAfterMs = Number(header) * 1000;
      text = await res.text();
    } catch (e) {
      throw this.networkFailure(e, controller.signal.aborted, timeoutMs);
    } finally {
      clearTimeout(timer);
    }
    const elapsedMs = this.now() - started;

    if (status < 200 || status >= 300) {
      const c = classifyFailure({ status, body: text });
      throw new PortError(c.failure, scrub(`Zetaris answered HTTP ${status}: ${c.text || c.reason}`, this.secrets), {
        reason: c.reason,
        status,
        retryable: c.retryable,
        ...(retryAfterMs ? { retryAfterMs } : {}),
      });
    }
    return { raw: this.parseBody(text, status, queryId), elapsedMs };
  }

  private networkFailure(e: unknown, aborted: boolean, timeoutMs: number): PortError {
    if (aborted) {
      return new PortError("UNAVAILABLE", `Zetaris did not answer within ${timeoutMs} ms`, { reason: "TIMEOUT", retryable: true });
    }
    const err = e as { cause?: { code?: string; message?: string }; code?: string; message?: string };
    const code = err.cause?.code ?? err.code;
    const c = classifyFailure({ ...(code ? { code } : {}), message: err.cause?.message ?? err.message ?? "network failure" });
    return new PortError(c.failure, scrub(`Zetaris is not reachable: ${c.text || c.reason}`, this.secrets), { reason: c.reason, retryable: true });
  }

  private parseBody(text: string, status: number, queryId: string): Attempt["raw"] {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      // A 200 that is not JSON is a cut connection or a proxy page: treat as an outage, not as an answer.
      throw new PortError("UNAVAILABLE", "Zetaris returned HTTP 200 with a body that is not JSON", { reason: "NOT_JSON", status, retryable: true });
    }
    const o = body as { headers?: unknown; data?: unknown; total?: unknown };
    const headersOk = Array.isArray(o?.headers) && (o.headers as unknown[]).every((h) => typeof h === "string");
    const dataOk = Array.isArray(o?.data) && (o.data as unknown[]).every((r) => Array.isArray(r));
    if (!headersOk || !dataOk) {
      throw new PortError("DRIFTED", "Zetaris response no longer has the headers and data arrays", { reason: "SHAPE", status, retryable: false });
    }
    const columns = o.headers as string[];
    const rawRows: (string | null)[][] = [];
    for (const row of o.data as unknown[][]) {
      if (row.length !== columns.length) {
        throw new PortError("DRIFTED", `a row has ${row.length} values for ${columns.length} columns`, { reason: "ROW_WIDTH", retryable: false });
      }
      rawRows.push(
        row.map((v) => {
          if (v === null || v === undefined) return null;
          if (typeof v === "string") return v;
          if (typeof v === "number" || typeof v === "boolean") return String(v);
          throw new PortError("DRIFTED", "a value is neither text nor a number", { reason: "VALUE_SHAPE", retryable: false });
        }),
      );
    }
    const total = typeof o.total === "number" && Number.isFinite(o.total) ? o.total : rawRows.length;
    return { columns, rawRows, total, queryId };
  }
}

function healthFor(failure: FailureClass): CheckResult["health"] {
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
