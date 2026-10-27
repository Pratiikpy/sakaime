import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { canonicalJson } from "../../../src/util/canonical.ts";
import { completion, type RecordedRequest } from "./chat-server.ts";

/**
 * TEST DOUBLE. Produces chat completions in the shape Nightshift 1.2.3 returns, read from live calls on 2026-10-27
 * (see tests/models/fixtures/real-nightshift-replies.json): a `meterless` object beside the completion, holding a
 * `receipt_envelope` whose Ed25519 signature covers a body that holds the receipt. It signs with a key it generates, so
 * the verifier can be shown accepting a good receipt and rejecting each way a receipt can be wrong.
 */

export class SimKey {
  readonly privateKey: KeyObject;
  readonly publicRaw: Buffer;
  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    this.publicRaw = (pair.publicKey.export({ format: "der", type: "spki" }) as Buffer).subarray(-32);
  }
  get keyId(): string {
    return createHash("sha256").update(this.publicRaw).digest("hex").slice(0, 16);
  }
}

export interface SimOptions {
  content: string;
  /** The model that answered (signed). Default: the model requested. */
  routedModel?: string;
  tier?: string;
  app?: string;
  hmem?: unknown;
  status?: string;
  kind?: string;
  cacheStatus?: string;
  fromCache?: boolean;
  receiptId?: string;
  decisionId?: string;
  requestId?: string;
  promptChars?: number;
  promptPreview?: string;
  inputTokens?: number;
  outputTokens?: number;
  tsMs?: number;
  /** Sign with a different key than the one named in the envelope: the signature will not verify. */
  forgeSignature?: boolean;
  /** Corrupt the signature bytes. */
  flipSignatureBit?: boolean;
  /** Change a signed field after signing. */
  tamperAfterSigning?: (receipt: Record<string, unknown>) => void;
  /** Change an unsigned outer field. */
  tamperOuter?: (outer: Record<string, unknown>) => void;
  omitEnvelope?: boolean;
  omitMeterless?: boolean;
  extraReceiptFields?: Record<string, unknown>;
  /** Echo this scope instead of the one sent. */
  echoScope?: string;
}

export class NightshiftSim {
  readonly key = new SimKey();
  private n = 0;
  constructor(private readonly clock: () => number = Date.now) {}

  reply(req: RecordedRequest, opts: SimOptions, signer: SimKey = this.key): Record<string, unknown> {
    this.n += 1;
    const body = req.body as { model: string; messages: { role: string; content: string }[] };
    // The receipt's "prompt", as the installed 1.2.3 builds it (measured 2026-10-27): the non-system messages joined by one
    // newline, and only the last 4000 characters when longer. prompt_chars is its length, prompt_preview its first 180.
    const joined = body.messages.filter((m) => m.role !== "system").map((m) => m.content).join(String.fromCharCode(10));
    const lastUser = joined.length > 4000 ? joined.slice(joined.length - 4000) : joined;
    const model = body.model;
    const routed = opts.routedModel ?? model;
    const id = `chatcmpl-sim-${this.n}-${Math.random().toString(16).slice(2, 8)}`;
    const decisionId = opts.decisionId ?? `req_sim${this.n}${Math.random().toString(36).slice(2, 6)}`;
    const receiptId = opts.receiptId ?? `rcpt_${decisionId}`;
    const inTok = opts.inputTokens ?? Math.max(1, Math.ceil(body.messages.reduce((a, m) => a + m.content.length, 0) / 4));
    const outTok = opts.outputTokens ?? Math.max(1, Math.ceil(opts.content.length / 4));
    const scope = String(req.headers["meterless-scope"] ?? "");
    const ts = opts.tsMs ?? this.clock();

    const receipt: Record<string, unknown> = {
      app: opts.app ?? "node",
      cache: { status: opts.cacheStatus ?? "miss", losers_reclaimed: 0, partials_reclaimed: 0 },
      created_at: ts,
      decision_id: decisionId,
      egress: { coverage: "pattern_floor", destination: opts.kind === "local" ? "local" : "nvidia", never_eligible: [], sent: { context_sources: ["messages"], prompt_chars: opts.promptChars ?? lastUser.length, redacted: [] }, withheld: [] },
      error: "",
      hmem: opts.hmem === undefined ? null : opts.hmem,
      mode: "auto",
      phases: [{ phase: "final_synthesis", model: routed, ms: 5, tokensIn: inTok, tokensOut: outTok, tier: opts.tier ?? "A" }],
      privacy: { path: "cloud-ok", redaction: { applied: false, spans: 0 } },
      prompt_preview: opts.promptPreview ?? lastUser.slice(0, 180),
      receipt_id: receiptId,
      request_id: opts.requestId ?? id,
      requested_mode: "meterless/auto",
      routing: { policy: "learned-router", reason: "single-candidate", winner: routed, predicted: routed },
      schema: "meterless.compute_receipt.v1",
      status: opts.status ?? "ok",
      usage: { input_tokens: inTok, latency_ms: 5, output_tokens: outTok, total_tokens: inTok + outTok },
      winning_route: { kind: opts.kind ?? "cloud", label: routed, model: routed, provider: "nvidia", tier: opts.tier ?? "A" },
      ...(opts.extraReceiptFields ?? {}),
    };
    const envBody: Record<string, unknown> = { llama_cpp_ref: "08659901c43b51de735740f1cf61bb82fbe0c4e4", manifest_hash: "", receipt, signer: "meterlessd", ts_ms: ts };
    const signingKey = opts.forgeSignature ? new SimKey() : signer;
    let sig = sign(null, Buffer.from(canonicalJson(envBody), "utf8"), signingKey.privateKey);
    if (opts.flipSignatureBit) {
      sig = Buffer.from(sig);
      sig[0] = (sig[0] as number) ^ 0x01;
    }
    opts.tamperAfterSigning?.(receipt);
    const envelope = { body: envBody, pubkey_b64: signer.publicRaw.toString("base64"), sig_b64: sig.toString("base64") };

    const meterless: Record<string, unknown> = {
      schema: "meterless.compute_receipt.v1",
      receipt_id: receiptId,
      decision_id: decisionId,
      requested_model: model,
      provider_model: routed,
      routed_model: routed,
      winning_route: receipt["winning_route"],
      from_cache: opts.fromCache ?? false,
      receipt: structuredClone(receipt),
      ...(opts.omitEnvelope ? {} : { receipt_envelope: envelope }),
      app: receipt["app"],
      mode: "auto",
      scope: opts.echoScope ?? scope,
    };
    opts.tamperOuter?.(meterless);
    return completion({
      content: opts.content,
      model: routed,
      id,
      usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
      extra: opts.omitMeterless ? {} : { meterless },
    });
  }
}
