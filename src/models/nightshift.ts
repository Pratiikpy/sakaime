import { PortError, type ComputeReceipt } from "../ports/index.ts";
import { isLoopbackHost } from "./chat.ts";
import { ChatModelClient, type ChatClientOptions, type ReplyContext } from "./client.ts";
import { verifyLiveReceipt, type ReceiptLedger, type ReceiptPolicy } from "./receipt.ts";
import type { LaneDescriptor } from "./types.ts";

export const NIGHTSHIFT_DEFAULT_BASE_URL = "http://127.0.0.1:8088/v1";

export interface NightshiftClientOptions extends Omit<ChatClientOptions, "baseUrl"> {
  baseUrl?: string;
  ledger: ReceiptLedger;
  /** Key ids of the installed application. A receipt signed by any other key is rejected. */
  trustedKeyIds: readonly string[];
  allowUnpinnedKey?: boolean;
  expectedAppId?: string;
  /**
   * The tier a receipt must name for a model, for example `{ "nvidia/nemotron-3.5-lightning-30b-a3b": "A" }`. A receipt that names
   * no tier is always rejected; a tier is compared only for models listed here. Off by default: the tiers in MODEL_PROFILES
   * were observed on 2026-10-27, and a re-tiering by a later Nightshift build should not stop the product.
   */
  expectedTiers?: Readonly<Record<string, string>>;
  /** Recorded in every receipt so a later reader knows which build routed the call. */
  version?: string;
  /**
   * `remote`: the role map's cloud models, routed by Nightshift to a provider. `local`: the role map's `localModel`, which
   * is meant to stay on this machine. The local lane is NOT VERIFIED on this machine.
   */
  lane?: "remote" | "local";
  /** Reject a reply that carries no receipt (the default). When false, such a reply is returned without one and counted as unreceipted. */
  requireReceipt?: boolean;
  /** Permit a Nightshift on another host (a cloud VM on a private network). Loopback only by default. */
  allowNonLoopback?: boolean;
  maxReceiptAgeMs?: number;
}

/**
 * Nemotron through the Nightshift application's OpenAI-compatible endpoint, with its signed compute receipt verified on
 * every reply (C-13). A reply is Nightshift's only if its receipt passes every check; otherwise the call fails with
 * INVALID and `detail.receiptRejection` names the reason, so an evaluation can exclude it and the run log shows why.
 */
export class NightshiftClient extends ChatModelClient {
  readonly provider = "nightshift" as const;
  protected readonly lanePreference: "remote" | "local";
  private readonly laneDescriptor: LaneDescriptor;
  private readonly policy: ReceiptPolicy;
  private readonly ledger: ReceiptLedger;
  private readonly requireReceipt: boolean;

  constructor(options: NightshiftClientOptions) {
    const baseUrl = options.baseUrl ?? NIGHTSHIFT_DEFAULT_BASE_URL;
    let host: string;
    try {
      host = new URL(baseUrl).hostname;
    } catch {
      throw new PortError("INVALID", "NightshiftClient: the base URL is not a URL");
    }
    if (!isLoopbackHost(host) && !options.allowNonLoopback) {
      throw new PortError("REFUSED", `NightshiftClient: ${host} is not a loopback address. Nightshift is reached on this machine; pass allowNonLoopback to use one on a private network.`);
    }
    if (!options.apiKey || options.apiKey.length < 8) throw new PortError("FORBIDDEN", "NightshiftClient needs the application's API key (NIGHTSHIFT_API_KEY)");
    super("nightshift", {
      ...options,
      baseUrl,
      transport: { ...options.transport, allowInsecureHttp: options.allowNonLoopback ?? false },
    });
    this.lanePreference = options.lane ?? "remote";
    this.ledger = options.ledger;
    this.requireReceipt = options.requireReceipt ?? true;
    this.policy = {
      trustedKeyIds: options.trustedKeyIds,
      ...(options.expectedTiers ? { expectedTierByModel: options.expectedTiers } : {}),
      ...(options.allowUnpinnedKey !== undefined ? { allowUnpinnedKey: options.allowUnpinnedKey } : {}),
      ...(options.expectedAppId !== undefined ? { expectedAppId: options.expectedAppId } : {}),
      ...(options.version !== undefined ? { nightshiftVersion: options.version } : {}),
      ...(options.maxReceiptAgeMs !== undefined ? { maxAgeMs: options.maxReceiptAgeMs } : {}),
    };
    this.laneDescriptor =
      this.lanePreference === "local"
        ? { id: "nightshift:local", location: "local", destination: "this machine (Nightshift local runtime)", verified: false, note: "NOT VERIFIED: no local model has been run through this lane on this machine" }
        : { id: "nightshift:cloud", location: "remote", destination: "nightshift-cloud", verified: false, note: "Nightshift routes the call to a cloud provider; prompts leave this machine" };
    this.opts.egress.registerLane(this.laneDescriptor);
  }

  protected laneFor(): LaneDescriptor {
    return this.laneDescriptor;
  }

  protected headersFor(scope: string, timeoutMs: number): Record<string, string> {
    return {
      // The application keeps a response cache and may add remembered answers to later prompts. A scope no other call
      // shares avoids both (2026-10-24: a repeated planner request came back empty from the cache).
      "meterless-scope": scope,
      // The application's own first-token limit for cloud calls would otherwise end some slow calls early.
      "meterless-ttfb-ms": String(Math.min(300_000, Math.max(1_000, Math.floor(timeoutMs)))),
    };
  }

  protected verifyReply(ctx: ReplyContext, role: string): ComputeReceipt | undefined {
    const verdict = verifyLiveReceipt(
      ctx.reply.body["meterless"],
      {
        requestedModel: ctx.model,
        memoryScope: ctx.scope,
        ...(ctx.reply.id ? { responseId: ctx.reply.id } : {}),
        lastUserText: ctx.lastUserText,
        conversation: ctx.conversation,
        requestHash: ctx.requestHash,
        responseHash: ctx.responseHash,
        ...(ctx.reply.usage ? { usage: ctx.reply.usage } : {}),
        lane: ctx.lane.location,
        now: ctx.now,
      },
      this.policy,
      this.ledger,
      role,
    );
    this.opts.trace.emit("model.receipt", {
      provider: this.provider,
      role,
      model: ctx.model,
      accepted: verdict.accepted,
      ...(verdict.accepted
        ? { receiptId: verdict.receipt.receiptId, keyId: verdict.receipt.keyId }
        : { code: verdict.code, reason: verdict.reason, ...(verdict.receiptId ? { receiptId: verdict.receiptId } : {}), ...(verdict.hmem !== undefined ? { hmem: verdict.hmem } : {}) }),
      checks: verdict.checks.map((c) => `${c.passed ? "pass" : "FAIL"}:${c.name}`),
    });
    if (verdict.accepted) return verdict.receipt;
    if (verdict.code === "MISSING" && !this.requireReceipt) return undefined;
    throw new PortError("INVALID", `Nightshift receipt rejected (${verdict.code}): ${verdict.reason}`, {
      receiptRejection: verdict.code,
      ...(verdict.receiptId ? { receiptId: verdict.receiptId } : {}),
      ...(verdict.hmem !== undefined ? { hmem: verdict.hmem } : {}),
      excluded: true,
      model: ctx.model,
    });
  }
}
