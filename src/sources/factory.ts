/**
 * Wires the source layer: cards, allowlist, fetcher, request budgets and one connector per card.
 *
 *   mode "live"      every request goes through the SSRF-safe fetcher and spends the card's request budget
 *   mode "cassette"  every request is answered from recorded responses; nothing touches the network or the budget
 *
 * Both modes run the same connector code, so a replay exercises the same classification, contract checks and
 * record building as a live read.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { systemClock, type Clock, type Connector } from "../ports/index.ts";
import { CardError, allowlistFromCards, defaultCardsDir, loadSourceCards, type LoadedCard } from "./cards.ts";
import { CassetteFetcher, CassetteStore } from "./cassette.ts";
import { HttpConnector } from "./connectors/common.ts";
import { FdaAiListConnector } from "./connectors/fda-ai-list.ts";
import { specFor } from "./connectors/specs.ts";
import type { Fetcher } from "./fetcher.ts";
import { RateLimiter, type RateWindow } from "./limiter.ts";
import { SafeFetcher, type HostAllowlist } from "./safe-fetch.ts";
import { loadSnapshot } from "./snapshot.ts";

export const DEFAULT_CASSETTE_DIR = fileURLToPath(new URL("../../data/cassettes/public-evidence-2026-10-27", import.meta.url));

export interface SourceLayerOptions {
  mode: "live" | "cassette";
  cardsDir?: string;
  cassetteDir?: string;
  /** Where the on-disk request budget is kept (live mode). Defaults to $SAKAIME_STATE_DIR or ./.sakaime/state. */
  stateDir?: string;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** Replace the fetcher entirely (tests inject doubles here). */
  fetcher?: Fetcher;
  maxAttempts?: number;
  backoffMs?: number;
  /** Let the FDA AI-list connector try the live list before the pinned snapshot. */
  preferLiveAiList?: boolean;
}

export interface SourceLayer {
  mode: SourceLayerOptions["mode"];
  cards: LoadedCard[];
  allowlist: HostAllowlist;
  fetcher: Fetcher;
  connectors: Map<string, Connector>;
}

export function windowsOf(card: LoadedCard["file"]): RateWindow[] {
  if (card.rateLimit) {
    return [{ requests: card.rateLimit.requests, perSeconds: card.rateLimit.perSeconds }, ...(card.rateLimit.perDay ? [{ requests: card.rateLimit.perDay, perSeconds: 86_400 }] : [])];
  }
  if (card.politeness) return [{ requests: card.politeness.requests, perSeconds: card.politeness.perSeconds }];
  return [];
}

export function createSourceLayer(options: SourceLayerOptions): SourceLayer {
  const cardsDir = options.cardsDir ?? defaultCardsDir();
  const cards = loadSourceCards(cardsDir);
  const allowlist = allowlistFromCards(cards);
  const clock = options.clock ?? systemClock;

  const fetcher: Fetcher =
    options.fetcher ??
    (options.mode === "cassette"
      ? new CassetteFetcher(CassetteStore.load(options.cassetteDir ?? DEFAULT_CASSETTE_DIR), allowlist)
      : new SafeFetcher({ allowlist }));

  // One limiter per group: the three openFDA endpoints draw on one per-IP allowance.
  const limiters = new Map<string, RateLimiter>();
  const limiterFor = (card: LoadedCard): RateLimiter | undefined => {
    if (fetcher.servedFrom !== "live") return undefined;
    const windows = windowsOf(card.file);
    if (windows.length === 0) return undefined;
    const group = card.file.rateLimitGroup ?? card.file.id;
    const existing = limiters.get(group);
    if (existing) return existing;
    const stateDir = options.stateDir ?? process.env["SAKAIME_STATE_DIR"] ?? path.join(process.cwd(), ".sakaime", "state");
    const limiter = new RateLimiter({
      group,
      windows,
      stateFile: path.join(stateDir, "source-budget.json"),
      clock,
      ...(options.sleep ? { sleep: options.sleep } : {}),
      ...(card.file.maxConcurrent ? { maxConcurrent: card.file.maxConcurrent } : {}),
    });
    limiters.set(group, limiter);
    return limiter;
  };

  // Cards in one group must state the same allowance, or one of them is wrong.
  const byGroup = new Map<string, LoadedCard>();
  for (const card of cards) {
    const group = card.file.rateLimitGroup;
    if (!group) continue;
    const first = byGroup.get(group);
    if (first && JSON.stringify(windowsOf(first.file)) !== JSON.stringify(windowsOf(card.file))) {
      throw new CardError(`cards ${first.file.id} and ${card.file.id} share rate-limit group "${group}" but state different limits`);
    }
    byGroup.set(group, first ?? card);
  }

  const connectors = new Map<string, Connector>();
  for (const loaded of cards) {
    const shared = { clock, ...(options.sleep ? { sleep: options.sleep } : {}), ...(options.maxAttempts ? { maxAttempts: options.maxAttempts } : {}), ...(options.backoffMs !== undefined ? { backoffMs: options.backoffMs } : {}) };
    if (loaded.file.connector === "fda-ai-list") {
      const manifest = path.join(cardsDir, loaded.file.snapshot!.manifest);
      const limiter = limiterFor(loaded);
      connectors.set(loaded.file.id, new FdaAiListConnector(loaded, loadSnapshot(manifest), { fetcher, ...(limiter ? { limiter } : {}), clock, preferLive: options.preferLiveAiList }));
      continue;
    }
    const limiter = limiterFor(loaded);
    connectors.set(loaded.file.id, new HttpConnector(loaded, specFor(loaded), { fetcher, ...(limiter ? { limiter } : {}), ...shared }));
  }
  return { mode: options.mode, cards, allowlist, fetcher, connectors };
}
