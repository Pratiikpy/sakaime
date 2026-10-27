/**
 * The semantic layer in the service: GET /api/usl and the setup of the layer on a running Zetaris.
 *
 * Three modes, never blended:
 *   live      the read-only agent identity reads the layer on a running Zetaris. Every figure is from this moment.
 *   cassette  SAMPLE_MODE: the recorded answers of the same statements (data/federation-cassettes/usl-*.json), labelled so.
 *   off       nothing is configured or recorded. The route answers UNAVAILABLE and says what is missing.
 *
 * Failure semantics. A rule that fails is a result: the snapshot is returned, the rule says FAILED, and the collections that
 * failed the completeness rule are listed under `blocked`. An engine that cannot be asked is a PortError UNAVAILABLE, so the
 * route answers 503 and never an empty success. The two are never confused: no outage can look like a passed rule, and no
 * failed rule can look like an outage.
 *
 * Reading the layer always uses the read-only agent identity. The administrator exists only in setup (ensure), through
 * openUslAdmin, and is never reachable from a route.
 */
import { randomUUID } from "node:crypto";
import { normMetric, METRIC_TABLE } from "../compiler/taxonomy.ts";
import { login } from "../discovery/zetaris-auth.ts";
import { ZetarisPort, zetarisConfigFromEnv } from "../federation/zetaris-port.ts";
import type { FederationQueryOptionsEx, RawFederationPort, RawFederationResult } from "../federation/result.ts";
import { COMPLETENESS_RULE } from "../federation/dq.ts";
import {
  buildSemanticLayer,
  readAllDefinitions,
  readCaseDefinitions,
  readLayerTables,
  runCompletenessRule,
  runRules,
  TracedPort,
  type CaseDefinitions,
  type CompletenessReport,
  type RuleReport,
  type SemanticLayerSpec,
  type UslAdmin,
  type UslDefinition,
  type UslSqlPort,
  type UslStatementTrace,
  type UslTableInfo,
} from "../federation/usl.ts";
import { UslCassettePort, UslRecorder, writeUslCassette } from "../federation/usl-cassette.ts";
import { PortError, type CheckResult, type FederationResult } from "../ports/index.ts";
import type { ServiceConfig } from "./config.ts";
import { SERVICE_PURPOSES, SERVICE_SETTINGS } from "./bridge.ts";
import { brief, errorMessage } from "./util.ts";

export const READER_LABEL = "agent-reader";
export const REST_URL_DEFAULT = "http://127.0.0.1:8988/api/v1.0";

/** The one specification of the layer, built from the compiler's own vocabulary so the layer cannot say another thing. */
let memo: SemanticLayerSpec | undefined;
export function uslSpec(): SemanticLayerSpec {
  memo ??= buildSemanticLayer({ settings: SERVICE_SETTINGS, purposes: SERVICE_PURPOSES, metrics: METRIC_TABLE });
  return memo;
}

// ---------------------------------------------------------------- connections

export interface Credential {
  email: string;
  password: string;
}

export interface UslConnection {
  restUrl: string;
  orgId: string;
  reader?: Credential;
  admin?: Credential;
}

export function uslConnectionFromEnv(env: Record<string, string | undefined>): UslConnection {
  const cred = (e?: string, p?: string): Credential | undefined => (e && p ? { email: e, password: p } : undefined);
  const reader = cred(env["SAKAIME_ZETARIS_READER_EMAIL"], env["SAKAIME_ZETARIS_READER_PASSWORD"]);
  const admin = cred(env["ZETARIS_ADMIN_EMAIL"] ?? "admin@sakaime.example", env["SAKAIME_ZETARIS_ADMIN_PASSWORD"]);
  return {
    restUrl: env["ZETARIS_REST_URL"] ?? `http://127.0.0.1:${env["API_PORT"] ?? "8988"}/api/v1.0`,
    orgId: env["ZETARIS_ORG_ID"] ?? "1",
    ...(reader ? { reader } : {}),
    ...(admin ? { admin } : {}),
  };
}

/** A federation port for one password identity. It signs in again before the token expires; the token is never logged. */
export class PasswordSessionPort implements RawFederationPort {
  readonly mode = "live" as const;
  private port: ZetarisPort | undefined;
  private expires = 0;

  constructor(
    private readonly restUrl: string,
    private readonly orgId: string,
    private readonly who: Credential,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async token(): Promise<string> {
    await this.current();
    return this.bearer!;
  }
  private bearer: string | undefined;

  private async current(): Promise<ZetarisPort> {
    if (this.port && Date.now() < this.expires - 30_000) return this.port;
    const token = await login(this.restUrl, this.orgId, this.who, this.fetchImpl);
    let exp = Date.now() + 10 * 60_000;
    try {
      const payload = JSON.parse(Buffer.from(token.split(".")[1]!, "base64url").toString("utf8")) as { exp?: number };
      if (payload.exp) exp = payload.exp * 1000;
    } catch {
      /* keep the default lifetime */
    }
    this.expires = exp;
    this.bearer = token;
    this.port = new ZetarisPort({ restUrl: this.restUrl, orgId: this.orgId, identities: { default: { apiKey: token } }, defaultIdentity: "default", fetch: this.fetchImpl, maxAttempts: 2 });
    return this.port;
  }

  async sqlRaw(statement: string, options?: FederationQueryOptionsEx): Promise<RawFederationResult> {
    return (await this.current()).sqlRaw(statement, options);
  }
  toResult(raw: RawFederationResult, options?: FederationQueryOptionsEx): FederationResult {
    if (!this.port) throw new PortError("INVALID", "no session yet");
    return this.port.toResult(raw, options);
  }
  async sql(statement: string, options?: FederationQueryOptionsEx): Promise<FederationResult> {
    return (await this.current()).sql(statement, options);
  }
  async check(): Promise<CheckResult> {
    try {
      return await (await this.current()).check();
    } catch (e) {
      return { health: e instanceof PortError && e.failure === "FORBIDDEN" ? "FORBIDDEN" : "UNAVAILABLE", detail: brief(errorMessage(e)), latencyMs: 0, checkedAt: new Date().toISOString() };
    }
  }
}

/** The administrator side of setup. Not used by any route. */
export function openUslAdmin(conn: UslConnection, fetchImpl: typeof fetch = fetch): UslAdmin {
  if (!conn.admin) throw new PortError("INVALID", "the administrator login is not configured: set SAKAIME_ZETARIS_ADMIN_PASSWORD", { reason: "ADMIN_NOT_CONFIGURED" });
  const session = new PasswordSessionPort(conn.restUrl, conn.orgId, conn.admin, fetchImpl);
  return {
    port: session,
    async assignUslToRoles(uslId, roles) {
      const token = await session.token();
      for (const role of roles) {
        let res: Response;
        try {
          res = await fetchImpl(`${conn.restUrl.replace(/\/+$/, "")}/access-control/assign/role/usl`, {
            method: "POST",
            redirect: "manual",
            headers: { Authorization: `Bearer ${token}`, "X-Org-ID": conn.orgId, "X-Request-ID": randomUUID(), "Content-Type": "application/json" },
            body: JSON.stringify({ roleNames: [role.toUpperCase()], uslId }),
            signal: AbortSignal.timeout(30_000),
          });
        } catch (e) {
          throw new PortError("UNAVAILABLE", `Zetaris did not answer the USL assignment: ${errorMessage(e)}`, { retryable: true });
        }
        // The response body is not echoed: the status is enough to act on.
        if (!res.ok) throw new PortError(res.status === 401 || res.status === 403 ? "FORBIDDEN" : "UNAVAILABLE", `Zetaris refused to assign USL ${uslId} to role ${role} (HTTP ${res.status})`, { status: res.status, role });
      }
    },
  };
}

// ---------------------------------------------------------------- the snapshot

export interface UslSnapshot {
  layer: { namespace: string; name: string; path: string; structureHash: string };
  tables: UslTableInfo[];
  definitions: UslDefinition[];
  dqRules: RuleReport[];
  completeness: Pick<CompletenessReport, "verdict" | "collections" | "complete" | "blocked" | "codeCheckAgrees">;
  case?: CaseDefinitions["case"];
  unresolved: CaseDefinitions["unresolved"];
  servedFrom: "live" | "cassette";
  recordedAt: string;
  readerIdentity: string;
  statements: UslStatementTrace[];
}

export interface SnapshotRequest {
  /** The hospital's own case id, for example CASE-2026-014. */
  caseId?: string;
  /** Canonical metric names the case asks about. */
  metrics?: readonly string[];
}

/** What a request needs from an unavailable-or-not-provisioned layer: a clear UNAVAILABLE, not an engine message. */
function notProvisioned(e: unknown, path: string): never {
  if (e instanceof PortError && e.failure === "INVALID" && /not found|not defined|does not exist|not activated/i.test(e.message)) {
    throw new PortError("UNAVAILABLE", `the semantic layer ${path} is not set up on this Zetaris: run "tsx infra/zetaris/scripts/usl.ts ensure"`, { reason: "LAYER_NOT_PROVISIONED", retryable: false });
  }
  throw e;
}

/**
 * Read the layer as the caller: tables, definitions, every rule, and the completeness gate. The statements are independent, so
 * they run together; the order of the lists is fixed by the specification, never by which answer arrived first.
 */
export async function readUslSnapshot(port: UslSqlPort, spec: SemanticLayerSpec, request: SnapshotRequest, now: () => Date): Promise<UslSnapshot> {
  const traced = new TracedPort(port);
  const path = `lightning.metastore.${spec.namespace}.${spec.usl}`;
  try {
    const others = { ...spec, rules: spec.rules.filter((r) => r.rule !== COMPLETENESS_RULE) };
    const [tables, overview, caseRead, rules, completeness] = await Promise.all([
      readLayerTables(traced, spec),
      request.caseId ? Promise.resolve(undefined) : readAllDefinitions(traced),
      request.caseId ? readCaseDefinitions(traced, request.caseId, request.metrics ?? []) : Promise.resolve(undefined),
      runRules(traced, others),
      runCompletenessRule(traced, spec),
    ]);
    const gate: RuleReport = {
      rule: completeness.rule,
      table: completeness.table,
      kind: "completeness",
      description: spec.rules.find((r) => r.rule === COMPLETENESS_RULE)!.description,
      expression: spec.rules.find((r) => r.rule === COMPLETENESS_RULE)!.expression.sql,
      consequence: spec.rules.find((r) => r.rule === COMPLETENESS_RULE)!.consequence,
      rowsChecked: completeness.rowsChecked,
      failures: completeness.failures,
      verdict: completeness.verdict,
      queryId: completeness.queryId,
      elapsedMs: completeness.elapsedMs,
    };
    const byRule = new Map([...rules, gate].map((r) => [r.rule, r]));
    const dqRules = spec.rules.map((r) => byRule.get(r.rule)!);
    const servedFrom = traced.traces.every((t) => t.servedFrom === "cassette") ? "cassette" : "live";
    const recordedAt = servedFrom === "cassette" ? traced.recordedAt.sort().at(-1) ?? now().toISOString() : now().toISOString();
    return {
      layer: { namespace: spec.namespace, name: spec.usl, path, structureHash: spec.structureHash },
      tables,
      definitions: caseRead ? caseRead.definitions : overview!,
      dqRules,
      completeness: { verdict: completeness.verdict, collections: completeness.collections, complete: completeness.complete, blocked: completeness.blocked, codeCheckAgrees: completeness.codeCheckAgrees },
      ...(caseRead ? { case: caseRead.case } : {}),
      unresolved: caseRead?.unresolved ?? [],
      servedFrom,
      recordedAt,
      readerIdentity: READER_LABEL,
      statements: [...traced.traces].sort((a, b) => (a.statement < b.statement ? -1 : a.statement > b.statement ? 1 : 0)),
    };
  } catch (e) {
    return notProvisioned(e, path);
  }
}

// ---------------------------------------------------------------- the service object

export type UslMode = "live" | "cassette" | "off";

export interface UslServiceOptions {
  /** Replace the port the layer is read through (tests). Treated as live. */
  port?: UslSqlPort & { identityLabel?: string };
  spec?: SemanticLayerSpec;
  /** How long a live snapshot is reused, in milliseconds. Default 30 s; 0 disables. */
  ttlMs?: number;
}

export class UslService {
  readonly spec: SemanticLayerSpec;
  readonly mode: UslMode;
  readonly notes: string[] = [];
  private readonly reader: (UslSqlPort & { sqlRaw?: RawFederationPort["sqlRaw"] }) | undefined;
  private readonly raw: RawFederationPort | undefined;
  private readonly cache = new Map<string, { at: number; value: UslSnapshot }>();
  private readonly ttlMs: number;

  constructor(
    private readonly config: Pick<ServiceConfig, "sample" | "env" | "dirs" | "clock" | "record">,
    options: UslServiceOptions = {},
  ) {
    this.spec = options.spec ?? uslSpec();
    this.ttlMs = options.ttlMs ?? 30_000;
    if (options.port) {
      this.reader = options.port;
      this.mode = "live";
      return;
    }
    if (config.sample) {
      const cassette = new UslCassettePort(config.dirs.federationCassettes, READER_LABEL);
      if (cassette.available) {
        this.reader = cassette;
        this.mode = "cassette";
        this.notes.push("the semantic layer is replayed from recorded real responses");
      } else {
        this.mode = "off";
        this.notes.push("no semantic-layer recordings are present (usl-*.json in the federation cassette directory)");
      }
      return;
    }
    const env = config.env;
    const fromEnv = zetarisConfigFromEnv(env);
    const conn = uslConnectionFromEnv(env);
    if (fromEnv) this.raw = new ZetarisPort({ ...fromEnv, maxAttempts: 2 });
    else if (conn.reader) this.raw = new PasswordSessionPort(conn.restUrl, conn.orgId, conn.reader);
    if (this.raw) {
      this.reader = this.raw as UslSqlPort;
      this.mode = "live";
    } else {
      this.mode = "off";
      this.notes.push("Zetaris is not configured: set SAKAIME_ZETARIS_READER_EMAIL and SAKAIME_ZETARIS_READER_PASSWORD, or ZETARIS_REST_URL, ZETARIS_API_KEY and ZETARIS_ORG_ID");
    }
  }

  /** Throws UNAVAILABLE with the reason when no layer can be read; never returns an empty snapshot. */
  async snapshot(request: SnapshotRequest = {}): Promise<UslSnapshot> {
    if (this.mode === "off" || !this.reader) {
      throw new PortError("UNAVAILABLE", `the semantic layer cannot be read: ${this.notes[0] ?? "no source is configured"}`, { reason: "USL_OFF", retryable: false });
    }
    const key = `${request.caseId ?? ""}|${(request.metrics ?? []).join(",")}`;
    const hit = this.cache.get(key);
    if (this.mode === "live" && this.ttlMs > 0 && hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const value = await readUslSnapshot(this.reader, this.spec, request, () => this.config.clock.now());
    if (this.mode === "live" && this.ttlMs > 0) this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  /**
   * Record the answers of the overview and of each named case against the live engine, as usl-<scope>.json in the federation
   * cassette directory. Returns the files written. Only meaningful in live mode with a raw-capable port.
   */
  async record(caseRequests: readonly (SnapshotRequest & { caseId: string })[]): Promise<string[]> {
    if (this.mode !== "live" || !this.raw) throw new PortError("INVALID", "recording needs a live Zetaris with the read-only login configured", { reason: "NOT_LIVE" });
    const written: string[] = [];
    const common = (): { readerIdentity: string; layer: string; structureHash: string } => ({ readerIdentity: READER_LABEL, layer: `lightning.metastore.${this.spec.namespace}.${this.spec.usl}`, structureHash: this.spec.structureHash });
    const scopes: { scope: string; request: SnapshotRequest }[] = [{ scope: "overview", request: {} }, ...caseRequests.map((r) => ({ scope: `case:${r.caseId}`, request: r }))];
    // A case read repeats the table and rule statements of the overview. Those stay in the overview file only, so that one
    // statement is never recorded twice with two different query ids and a replay always shows one consistent set.
    const seen = new Set<string>();
    for (const { scope, request } of scopes) {
      const recorder = new UslRecorder(this.raw, READER_LABEL);
      await readUslSnapshot(recorder, this.spec, request, () => this.config.clock.now());
      const steps = recorder.drain().filter((s) => !seen.has(s.key)).sort((a, b) => (a.statement < b.statement ? -1 : 1));
      for (const s of steps) seen.add(s.key);
      written.push(writeUslCassette(this.config.dirs.federationCassettes, { scope, recordedAt: this.config.clock.now().toISOString(), ...common(), steps }));
    }
    return written;
  }

  /** Product case id to the hospital case id and the canonical metric the case asks about. */
  static requestFor(spec: { hospital: { caseId: string }; intended: { performance?: { metric: string } | undefined } }): SnapshotRequest & { caseId: string } {
    const metric = spec.intended.performance?.metric;
    return { caseId: spec.hospital.caseId, ...(metric ? { metrics: [normMetric(metric)] } : {}) };
  }
}
