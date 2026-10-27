import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PortError, type ModelPort } from "../ports/index.ts";
import type { AvailabilitySnapshot } from "./availability.ts";
import { RecordedModelPort, RecordingModelPort } from "./cassette.ts";
import type { ChatClientOptions } from "./client.ts";
import { ProviderChain, type NamedPort } from "./chain.ts";
import { ConsentLedger, EgressPolicy, EgressRouter, ForbiddenValues, PromptLog } from "./egress.ts";
import { NightshiftClient, NIGHTSHIFT_DEFAULT_BASE_URL } from "./nightshift.ts";
import { NvidiaClient, NVIDIA_DEFAULT_BASE_URL } from "./nvidia.ts";
import {
  defaultReceiptLogPath,
  readInstalledKeyId,
  readInstalledNightshiftVersion,
  receiptCoverage,
  ReceiptLedger,
  type ModelDerivedItem,
  type ReceiptCoverage,
} from "./receipt.ts";
import { RoleMap } from "./roles.ts";
import { isLoopbackHost } from "./chat.ts";
import { JsonlTraceSink, MemoryTraceSink, type TraceSink } from "./trace.ts";

export type ModelMode = "live" | "record" | "recorded";

/**
 * The environment variable NAMES the model layer reads. Values are never printed or logged.
 *   NVIDIA_API_KEY, NVIDIA_BASE_URL                 NVIDIA's API
 *   NIGHTSHIFT_API_KEY (alias MODEL_API_KEY)        the Nightshift application's bearer token
 *   NIGHTSHIFT_BASE_URL (alias MODEL_BASE_URL)      loopback endpoint, default http://127.0.0.1:8088/v1
 *   NIGHTSHIFT_RECEIPT_KEY_ID                       comma-separated key ids of the installed application
 *   NIGHTSHIFT_RECEIPT_LOG                          path of the application's receipt log, to read its key id
 *   NIGHTSHIFT_APP_ID, NIGHTSHIFT_VERSION           expected app id; version to record when the registry cannot be read
 *   SAKAIME_ROLE_MODELS                             JSON overrides for the role map
 *   SAMPLE_MODE                                     "true" selects recorded mode
 */
export const MODEL_ENV_NAMES = [
  "NVIDIA_API_KEY",
  "NVIDIA_BASE_URL",
  "NIGHTSHIFT_API_KEY",
  "NIGHTSHIFT_BASE_URL",
  "MODEL_API_KEY",
  "MODEL_BASE_URL",
  "NIGHTSHIFT_RECEIPT_KEY_ID",
  "NIGHTSHIFT_RECEIPT_LOG",
  "NIGHTSHIFT_APP_ID",
  "NIGHTSHIFT_VERSION",
  "SAKAIME_ROLE_MODELS",
  "SAMPLE_MODE",
] as const;

export interface ModelStackOptions {
  env?: Record<string, string | undefined>;
  /** Defaults to "recorded" when SAMPLE_MODE=true, otherwise "live". */
  mode?: ModelMode;
  /** Where cassettes live. Default `data/model-cassettes` under the working directory. */
  cassetteDir?: string;
  /** Write the trace as JSON lines here as well as keeping it in memory. */
  traceFile?: string;
  promptLogFile?: string;
  consentFile?: string;
  receiptLedgerFile?: string;
  forbidden?: ForbiddenValues;
  consents?: ConsentLedger;
  roles?: RoleMap;
  /** Build a local-lane client (Nightshift local runtime). NOT VERIFIED on this machine. */
  includeLocalLane?: boolean;
  /** Use NVIDIA's API when Nightshift is unavailable. On by default when a key is present. */
  fallbackToNvidia?: boolean;
  /** HTTP-layer tuning for every client: attempt limits, backoff, deadline, concurrency, and the fetch and sleep functions. */
  transport?: ChatClientOptions["transport"];
}

export interface ModelStack {
  mode: ModelMode;
  /** The port the rest of the product calls. */
  port: ModelPort;
  roles: RoleMap;
  policy: EgressPolicy;
  consents: ConsentLedger;
  forbidden: ForbiddenValues;
  promptLog: PromptLog;
  ledger: ReceiptLedger;
  trace: MemoryTraceSink;
  router?: EgressRouter;
  nightshift?: NightshiftClient;
  nvidia?: NvidiaClient;
  local?: NightshiftClient;
  recorded?: RecordedModelPort;
  recorder?: RecordingModelPort;
  /** Why a configured provider was not built (for example Nightshift without a pinned key). */
  notes: string[];
  /** Re-probes every provider's model list and clears failure memory. Call at the start of each run. */
  beginRun(): Promise<AvailabilitySnapshot[]>;
  coverage(items: readonly ModelDerivedItem[]): ReceiptCoverage;
}

/** Assembles the model layer from the environment. Live and recording modes need credentials; recorded mode needs none. */
export async function createModelStack(options: ModelStackOptions = {}): Promise<ModelStack> {
  const env = options.env ?? process.env;
  const mode: ModelMode = options.mode ?? (env["SAMPLE_MODE"] === "true" ? "recorded" : "live");
  const memory = new MemoryTraceSink();
  const trace: TraceSink = options.traceFile ? fanout(memory, new JsonlTraceSink(options.traceFile)) : memory;
  const forbidden = options.forbidden ?? new ForbiddenValues();
  const consents = options.consents ?? new ConsentLedger(options.consentFile ? { path: options.consentFile } : {});
  const policy = new EgressPolicy({ consents, trace, forbidden });
  const promptLog = new PromptLog({ forbidden, ...(options.promptLogFile ? { path: options.promptLogFile } : {}) });
  const ledger = new ReceiptLedger(options.receiptLedgerFile ? { path: options.receiptLedgerFile } : {});
  const roles = options.roles ?? RoleMap.fromEnv(env);
  const cassetteDir = options.cassetteDir ?? join(process.cwd(), "data", "model-cassettes");
  const notes: string[] = [];
  const keyIds = trustedKeyIds(env);

  const base = {
    mode,
    roles,
    policy,
    consents,
    forbidden,
    promptLog,
    ledger,
    trace: memory,
    notes,
    coverage: (items: readonly ModelDerivedItem[]) => receiptCoverage(items, ledger),
  };

  if (mode === "recorded") {
    const recorded = new RecordedModelPort({
      dir: cassetteDir,
      trace,
      receiptPolicy: { trustedKeyIds: keyIds.ids },
      ledger,
    });
    notes.push(...keyIds.notes);
    return { ...base, port: recorded, recorded, beginRun: async () => [] };
  }

  const nightshiftKey = env["NIGHTSHIFT_API_KEY"] ?? env["MODEL_API_KEY"];
  const nightshiftBase = env["NIGHTSHIFT_BASE_URL"] ?? hostIfLoopback(env["MODEL_BASE_URL"]) ?? NIGHTSHIFT_DEFAULT_BASE_URL;
  const nvidiaKey = env["NVIDIA_API_KEY"];
  const common = { trace, egress: policy, roles, promptLog, ...(options.transport ? { transport: options.transport } : {}) };

  let nightshift: NightshiftClient | undefined;
  let local: NightshiftClient | undefined;
  if (nightshiftKey) {
    notes.push(...keyIds.notes);
    if (keyIds.ids.length === 0) {
      notes.push("Nightshift was not used: the installed application's key id could not be determined. Set NIGHTSHIFT_RECEIPT_KEY_ID.");
    } else {
      const version = env["NIGHTSHIFT_VERSION"] ?? (await readInstalledNightshiftVersion());
      const shared = {
        ...common,
        baseUrl: nightshiftBase,
        apiKey: nightshiftKey,
        ledger,
        trustedKeyIds: keyIds.ids,
        ...(env["NIGHTSHIFT_APP_ID"] ? { expectedAppId: env["NIGHTSHIFT_APP_ID"] } : {}),
        ...(version ? { version } : {}),
        ...(isLoopbackHost(safeHost(nightshiftBase)) ? {} : { allowNonLoopback: true }),
      };
      nightshift = new NightshiftClient({ ...shared, lane: "remote" });
      if (options.includeLocalLane) local = new NightshiftClient({ ...shared, lane: "local" });
    }
  }
  const nvidia = nvidiaKey ? new NvidiaClient({ ...common, apiKey: nvidiaKey, baseUrl: env["NVIDIA_BASE_URL"] ?? NVIDIA_DEFAULT_BASE_URL }) : undefined;
  if (!nightshift && !nvidia) {
    throw new PortError("FORBIDDEN", "no model provider is configured. Set NIGHTSHIFT_API_KEY (with the installed key id) or NVIDIA_API_KEY, or use recorded mode (SAMPLE_MODE=true).");
  }

  const chain: NamedPort[] = [];
  if (nightshift) chain.push({ name: "nightshift", port: nightshift });
  if (nvidia && ((options.fallbackToNvidia ?? true) || !nightshift)) chain.push({ name: "nvidia", port: nvidia });
  const remote = new ProviderChain(chain, { trace });
  const router = new EgressRouter({ policy, trace, remote, ...(local ? { local } : {}) });

  let port: ModelPort = router;
  let recorder: RecordingModelPort | undefined;
  if (mode === "record") {
    recorder = new RecordingModelPort(router, { dir: cassetteDir, trace, forbidden });
    port = recorder;
  }
  const clients = [nightshift, local, nvidia].filter((c): c is NightshiftClient | NvidiaClient => c !== undefined);
  return {
    ...base,
    port,
    router,
    ...(nightshift ? { nightshift } : {}),
    ...(nvidia ? { nvidia } : {}),
    ...(local ? { local } : {}),
    ...(recorder ? { recorder } : {}),
    beginRun: async () => Promise.all(clients.map((c) => c.beginRun())),
  };
}

function fanout(a: TraceSink, b: TraceSink): TraceSink {
  return {
    emit(kind, detail) {
      a.emit(kind, detail);
      b.emit(kind, detail);
    },
  };
}

function safeHost(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function hostIfLoopback(url: string | undefined): string | undefined {
  return url && isLoopbackHost(safeHost(url)) ? url : undefined;
}

function trustedKeyIds(env: Record<string, string | undefined>): { ids: string[]; notes: string[] } {
  const explicit = (env["NIGHTSHIFT_RECEIPT_KEY_ID"] ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => /^[0-9a-f]{16}$/.test(s));
  if (explicit.length > 0) return { ids: explicit, notes: [] };
  const path = defaultReceiptLogPath(env);
  if (path) {
    const id = readInstalledKeyId(path);
    if (id) return { ids: [id], notes: [`the installed application's key id (${id}) was read from its receipt log; pin it with NIGHTSHIFT_RECEIPT_KEY_ID for a stronger guarantee`] };
  }
  return { ids: [], notes: [] };
}

/**
 * Parses a `.env` file into a record without touching `process.env`. A variable already set in the shell would otherwise
 * shadow the file (on this machine a stale ambient NVIDIA_API_KEY did exactly that, and the API answered 403), so the
 * caller chooses the order: `createModelStack({ env: { ...process.env, ...readEnvFile(".env") } })`.
 */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m || line.trim().startsWith("#")) continue;
    out[m[1] as string] = (m[2] as string).trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}
