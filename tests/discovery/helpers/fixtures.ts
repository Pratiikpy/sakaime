/**
 * Shared construction for the discovery tests: the real silo files as the data we hold, a source card for a test host,
 * a Scout that issues real signed contracts, and a full set of dependencies.
 */
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseCsv } from "csv-parse/sync";
import { HMEM } from "../../../src/engines/hmem/index.ts";
import { HmacSigner, SAKAIME_REGISTRY_PATH, Scout } from "../../../src/engines/scout/index.ts";
import type { ExecutionContract } from "../../../src/engines/scout/types.ts";
import { WorldModel } from "../../../src/engines/world-model/index.ts";
import { DEFAULT_CONFIG, type DiscoveryConfig, type DiscoveryDeps, type OnboardRequest } from "../../../src/discovery/types.ts";
import { MemoryLedger, MemoryReviewQueue } from "../../../src/discovery/stores.ts";
import { allowlistFromCards, parseCard, type LoadedCard } from "../../../src/sources/cards.ts";
import type { ModelPort } from "../../../src/ports/index.ts";
import { EngineDouble, ObjectStoreDouble, ScriptedModel, ServedFetcher } from "./doubles.ts";

export const ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const SILOS = join(ROOT, "data", "silos");
export const SECRET = "discovery-test-secret-0123456789abcdef";
export const T0 = Date.parse("2026-10-27T12:00:00.000Z");

export const TEST_HOST = "registry.partner-data.test";
export const urlOf = (name: string): string => `https://${TEST_HOST}/export/${name}`;

const CARD = `
id: partner-registry-test
title: Test partner registry (a double host for the discovery tests)
kind: registry
connector: europepmc
baseUrl: https://${TEST_HOST}/export/
hosts:
  - host: ${TEST_HOST}
    pathPrefixes: ["/export/"]
auth: none
identifierFields: [k_number]
supportedPredicates: []
license: "test fixture"
dataClass: public
schemaVersion: "1"
probe:
  operation: main
  query: {}
  description: "not probed in tests"
verification:
  verifiedOn: "2026-10-27"
  evidence: ["test fixture"]
  notVerified: ["everything: this card describes a test double"]
`;

export const testCard = (): LoadedCard => parseCard(CARD, "partner-registry-test.yaml");

export const readCsv = (relative: string): Record<string, string>[] => parseCsv(readFileSync(join(SILOS, relative)), { columns: true, skip_empty_lines: true }) as Record<string, string>[];

export const HELD_TABLES = [
  { qualified: "sk_registry.fda_510k", csv: join(SILOS, "registry", "fda_510k.csv") },
  { qualified: "sk_registry.ctgov_studies", csv: join(SILOS, "registry", "ctgov_studies.csv") },
  { qualified: "sk_registry.pubmed_articles", csv: join(SILOS, "registry", "pubmed_articles.csv") },
  { qualified: "sk_registry.fda_classification", csv: join(SILOS, "registry", "fda_classification.csv") },
  { qualified: "hospital.submissions", csv: join(SILOS, "hospital", "submissions.csv") },
  { qualified: "sk_vendor.vendor_claims", csv: join(SILOS, "vendor_packets", "vendor_claims.csv") },
];

export interface Harness {
  deps: DiscoveryDeps;
  engine: EngineDouble;
  store: ObjectStoreDouble;
  fetcher: ServedFetcher;
  model: ScriptedModel;
  scout: Scout;
  hmem: HMEM;
  worldModel: WorldModel;
  ledger: MemoryLedger;
  reviews: MemoryReviewQueue;
  clock: { ms: number; now(): Date };
  /** A fresh, signed contract naming source.register for this user. */
  contract(actor?: string, url?: string): Promise<ExecutionContract>;
  request(name: string, over?: Partial<OnboardRequest>): Promise<OnboardRequest>;
  close(): void;
}

export interface HarnessOptions {
  model?: ModelPort | ConstructorParameters<typeof ScriptedModel>[0];
  engine?: EngineDouble;
  store?: ObjectStoreDouble;
  hmem?: HMEM;
  ledger?: MemoryLedger;
  reviews?: MemoryReviewQueue;
  worldModel?: WorldModel;
  resolver?: DiscoveryDeps["sources"]["resolver"];
  config?: Partial<DiscoveryConfig>;
}

export async function harness(options: HarnessOptions = {}): Promise<Harness> {
  const clock = { ms: T0, now: () => new Date(clock.ms) };
  const store = options.store ?? new ObjectStoreDouble();
  const engine = options.engine ?? (await EngineDouble.create(store, HELD_TABLES));
  const fetcher = new ServedFetcher(new Map());
  const model = options.model && typeof options.model === "function" ? new ScriptedModel(options.model) : (options.model as ScriptedModel | undefined) ?? new ScriptedModel(() => new Error("no model reply was scripted for this test"));
  const card = testCard();
  const scout = new Scout({ intentRegistry: SAKAIME_REGISTRY_PATH, policyPack: ["default", "adversarial-tight"], secret: SECRET, clock: () => clock.now() });
  const hmem = options.hmem ?? new HMEM({ clock: () => clock.ms, actor: "test" });
  const worldModel = options.worldModel ?? new WorldModel({ storage: "memory", namespace: "discovery-test", clock: () => clock.now() });
  const ledger = options.ledger ?? new MemoryLedger();
  const reviews = options.reviews ?? new MemoryReviewQueue();
  const deps: DiscoveryDeps = {
    sources: { allowlist: allowlistFromCards([card]), cards: [card], fetcher, ...(options.resolver ? { resolver: options.resolver } : {}) },
    federation: engine,
    models: model,
    hmem,
    worldModel,
    executor: scout.executor(),
    landing: store,
    ledger,
    reviews,
    clock: { now: () => clock.now() },
    config: { ...DEFAULT_CONFIG, ...(options.config ?? {}) },
  };
  const contract = async (actor = "rev-1", url = urlOf("any.csv")): Promise<ExecutionContract> => {
    const d = await scout.decide({ prompt: `Add this registry export as a new source: ${url}`, user: { id: actor, role: "reviewer" }, surface: "chat" });
    if (!d.executionContract) throw new Error(`Scout issued no contract: ${d.decision} ${JSON.stringify(d.clarification ?? d.risk.reason ?? "")}`);
    return d.executionContract;
  };
  return {
    deps,
    engine,
    store,
    fetcher,
    model,
    scout,
    hmem,
    worldModel,
    ledger,
    reviews,
    clock,
    contract,
    async request(name, over = {}) {
      return { description: "A partner export of device clearances", url: urlOf(name), orgId: "org-1", actor: "rev-1", contract: await contract("rev-1", urlOf(name)), ...over };
    },
    close() {
      engine.close();
      hmem.close();
      worldModel.close();
    },
  };
}

export const signerOf = (): HmacSigner => new HmacSigner(SECRET);

/** CSV text from a header and rows of strings. */
export function csv(columns: string[], rows: (string | number | null)[][]): string {
  const q = (v: string | number | null): string => {
    const s = v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.map(q).join(","), ...rows.map((r) => r.map(q).join(","))].join("\n") + "\n";
}

/** The twelve real 510(k) records we hold, as [k_number, applicant, device_name, product_code, decision_date, device_class]. */
export function clearances(): string[][] {
  return readCsv("registry/fda_510k.csv").map((r) => [r["k_number"]!, r["applicant"]!, r["device_name"]!, r["product_code"]!, r["decision_date"]!, r["device_class"]!]);
}
