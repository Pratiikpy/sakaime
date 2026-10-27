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
 *   SAKAIME_MODEL_FALLBACK                          "on" or "off": whether NVIDIA's API answers when Nightshift cannot. Default on when
 *                                                   serving, off when recording (a recording made through the fallback would not be
 *                                                   a Nightshift recording, so a Nightshift failure stops the recording instead)
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
  "SAKAIME_MODEL_FALLBACK",
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
  /**
   * Use NVIDIA's API when Nightshift is unreachable or its receipt is rejected. On by default when serving; off by default
   * when recording and Nightshift is configured. SAKAIME_MODEL_FALLBACK overrides the default; this option overrides both.
   */
  fallbackToNvidia?: boolean;
  /**
   * A JSON file pinning the key id of the Nightshift installation that made the committed recordings, for replay on a
   * machine that has no Nightshift. Shape: `{ "keyId": "<16 hex>" }`. Read only in recorded mode.
   */
  trustedKeyFile?: string;
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
  /** The receipt key ids this stack trusts. Empty when no key is pinned. */
  keyIds: readonly string[];
  /** Whether NVIDIA's API may answer when Nightshift cannot. */
  fallbackEnabled: boolean;
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
  const fallbackEnabled = options.fallbackToNvidia ?? fallbackFromEnv(env["SAKAIME_MODEL_FALLBACK"]) ?? mode !== "record";

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
    keyIds: keyIds.ids,
    fallbackEnabled,
    coverage: (items: readonly ModelDerivedItem[]) => receiptCoverage(items, ledger),
  };

  if (mode === "recorded") {
    // A machine that replays has no Nightshift to ask. The key id the recordings were made under is committed beside them, and
    // each stored receipt must verify against it; without it the replies are still shown, but as unreceipted.
    const pinned = options.trustedKeyFile ? readPinnedKeyIds(options.trustedKeyFile, notes) : [];
    const trusted = [...new Set([...keyIds.ids, ...pinned])];
    const recorded = new RecordedModelPort({
      dir: cassetteDir,
      trace,
      receiptPolicy: { trustedKeyIds: trusted },
      ledger,
    });
    notes.push(...keyIds.notes);
    return { ...base, keyIds: trusted, port: recorded, recorded, beginRun: async () => [] };
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
  if (nvidia && (fallbackEnabled || !nightshift)) chain.push({ name: "nvidia", port: nvidia });
  else if (nvidia && nightshift) notes.push("NVIDIA's API is configured but is not a fallback in this mode: when Nightshift cannot answer, the call fails instead of being answered by another provider");
  if (!nightshift && nvidia) notes.push(`Nightshift is not the model route: ${nightshiftKey ? "its receipt key id could not be determined" : "NIGHTSHIFT_API_KEY is not set"}; model calls go to NVIDIA's API directly and carry no receipt`);
  // A receipt that fails verification is not Nightshift's answer. When NVIDIA may answer instead, the reply is labelled nvidia and
  // unreceipted, and the provider_fallback event in the trace names the receipt rejection.
  const remote = new ProviderChain(chain, { trace, fallbackOnReceiptRejection: fallbackEnabled });
  const router = new EgressRouter({ policy, trace, remote, ...(local ? { local } : {}) });

  let port: ModelPort = router;
  let recorder: RecordingModelPort | undefined;
  if (mode === "record") {
    recorder = new RecordingModelPort(router, { dir: cassetteDir, trace, forbidden, consents });
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

function fallbackFromEnv(value: string | undefined): boolean | undefined {
  const v = value?.trim().toLowerCase();
  if (v === "on" || v === "true" || v === "1") return true;
  if (v === "off" || v === "false" || v === "0") return false;
  return undefined;
}

/** The key ids named in a pin file. A missing or unreadable file pins nothing, and a note says so. */
function readPinnedKeyIds(path: string, notes: string[]): string[] {
  if (!existsSync(path)) return [];
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { keyId?: unknown; keyIds?: unknown };
    const ids = [parsed.keyId, ...(Array.isArray(parsed.keyIds) ? parsed.keyIds : [])].filter((x): x is string => typeof x === "string" && /^[0-9a-f]{16}$/.test(x.toLowerCase())).map((x) => x.toLowerCase());
    if (ids.length === 0) notes.push(`${path} names no usable receipt key id; recorded receipts cannot be re-verified`);
    return ids;
  } catch {
    notes.push(`${path} could not be read; recorded receipts cannot be re-verified`);
    return [];
  }
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
