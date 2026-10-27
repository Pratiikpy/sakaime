import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { hmemCount, keyIdOf, receiptCoverage, ReceiptLedger, verifyEnvelopeSignature, verifyLiveReceipt, verifyStoredReceipt, type ReceiptContext, type ReceiptPolicy } from "../../src/models/receipt.ts";
import { NEMOTRON_LIGHTNING, NEMOTRON_ULTRA } from "../../src/models/roles.ts";
import type { ComputeReceipt } from "../../src/ports/index.ts";
import { NightshiftSim, SimKey, type SimOptions } from "./helpers/nightshift-sim.ts";
import type { RecordedRequest } from "./helpers/chat-server.ts";

const here = dirname(fileURLToPath(import.meta.url));

interface RealReply {
  requestedModel: string;
  memoryScope: string;
  lastUserText: string;
  responseId: string;
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number };
  requestHash: string;
  responseHash: string;
  meterless: Record<string, any>;
}
const real: RealReply[] = JSON.parse(readFileSync(join(here, "fixtures", "real-nightshift-replies.json"), "utf8"));

describe("receipts captured from the installed Nightshift 1.2.3 (2026-10-27)", () => {
  it("their Ed25519 signatures verify, and name the key", () => {
    for (const r of real) {
      const check = verifyEnvelopeSignature(r.meterless["receipt_envelope"]);
      expect(check.valid).toBe(true);
      expect(check.keyId).toMatch(/^[0-9a-f]{16}$/);
    }
  });

  it("the full live check accepts them when the key is pinned, using only the signed fields", () => {
    for (const r of real) {
      const keyId = verifyEnvelopeSignature(r.meterless["receipt_envelope"]).keyId as string;
      const ledger = new ReceiptLedger();
      const signedAt = r.meterless["receipt_envelope"].body.ts_ms as number;
      const verdict = verifyLiveReceipt(
        r.meterless,
        {
          requestedModel: r.requestedModel,
          memoryScope: r.memoryScope,
          responseId: r.responseId,
          lastUserText: r.lastUserText,
          requestHash: r.requestHash,
          responseHash: r.responseHash,
          usage: { promptTokens: r.usage.prompt_tokens, completionTokens: r.usage.completion_tokens },
          lane: "remote",
          now: new Date(signedAt + 2000),
        },
        { trustedKeyIds: [keyId], expectedTierByModel: { [NEMOTRON_LIGHTNING]: "A", [NEMOTRON_ULTRA]: "C" } },
        ledger,
      );
      expect(verdict.accepted, JSON.stringify(verdict)).toBe(true);
      if (verdict.accepted) {
        expect(verdict.receipt.routedModel).toBe(r.requestedModel);
        expect(verdict.receipt.hmem).toBe(0);
        expect(verdict.receipt.raw["hashesComputedLocally"]).toBe(true);
      }
    }
  });

  it("rejects them under a different pinned key", () => {
    const r = real[0] as RealReply;
    const other = new SimKey().keyId;
    const verdict = verifyLiveReceipt(
      r.meterless,
      { requestedModel: r.requestedModel, memoryScope: r.memoryScope, responseId: r.responseId, lastUserText: r.lastUserText, requestHash: "a", responseHash: "b", lane: "remote", now: new Date(r.meterless["receipt_envelope"].body.ts_ms + 1000) },
      { trustedKeyIds: [other] },
      new ReceiptLedger(),
    );
    expect(verdict).toMatchObject({ accepted: false, code: "UNTRUSTED_KEY" });
  });

  it("a one-character change to a signed field breaks the signature", () => {
    const r = structuredClone(real[0] as RealReply);
    r.meterless["receipt_envelope"].body.receipt.winning_route.tier = "Z";
    expect(verifyEnvelopeSignature(r.meterless["receipt_envelope"]).valid).toBe(false);
  });

  it("changing any one leaf of the signed receipt to a different value breaks the signature (property)", () => {
    const r = real[0] as RealReply;
    const leaves: (string | number)[][] = [];
    const walk = (node: unknown, path: (string | number)[]): void => {
      if (node !== null && typeof node === "object") {
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) walk(v, [...path, k]);
      } else {
        leaves.push(path);
      }
    };
    walk(r.meterless["receipt_envelope"].body, []);
    expect(leaves.length).toBeGreaterThan(40);
    fc.assert(
      fc.property(fc.nat({ max: leaves.length - 1 }), fc.oneof(fc.string(), fc.integer(), fc.boolean()), (index, replacement) => {
        const copy = structuredClone(r.meterless["receipt_envelope"]);
        const path = leaves[index] as (string | number)[];
        let node: any = copy.body;
        for (const k of path.slice(0, -1)) node = node[k];
        const last = path[path.length - 1] as string;
        fc.pre(node[last] !== replacement);
        node[last] = replacement;
        return verifyEnvelopeSignature(copy).valid === false;
      }),
      { numRuns: 300 },
    );
  });

  it("their stored form re-verifies offline", () => {
    const r = real[0] as RealReply;
    const env = r.meterless["receipt_envelope"];
    const keyId = verifyEnvelopeSignature(env).keyId as string;
    const stored: ComputeReceipt = { receiptId: r.meterless["receipt_id"], routedModel: r.requestedModel, hmem: 0, raw: { envelope: env } };
    expect(verifyStoredReceipt(stored, { requestedModel: r.requestedModel }, { trustedKeyIds: [keyId] }).ok).toBe(true);
    expect(verifyStoredReceipt(stored, { requestedModel: NEMOTRON_ULTRA }, { trustedKeyIds: [keyId] }).ok).toBe(false);
  });
});

// ------------------------------------------------------------------ simulated receipts: every way one can be wrong

const sim = new NightshiftSim(() => NOW.getTime());
const NOW = new Date("2026-10-27T12:00:00.000Z");
const POLICY: ReceiptPolicy = { trustedKeyIds: [sim.key.keyId], expectedTierByModel: { [NEMOTRON_LIGHTNING]: "A", [NEMOTRON_ULTRA]: "C" }, expectedAppId: "node", nightshiftVersion: "1.2.3" };

function fakeRequest(model: string, user: string, scope: string): RecordedRequest {
  return { method: "POST", url: "/v1/chat/completions", headers: { "meterless-scope": scope }, raw: "", body: { model, messages: [{ role: "system", content: "s" }, { role: "user", content: user }] } };
}

function run(opts: Partial<SimOptions>, over: Partial<ReceiptContext> = {}, policy: ReceiptPolicy = POLICY, ledger = new ReceiptLedger(), model = NEMOTRON_LIGHTNING, signer: SimKey = sim.key) {
  const scope = `scope-${Math.random().toString(16).slice(2)}`;
  const user = "Check the version in the label.";
  const body = sim.reply(fakeRequest(model, user, scope), { content: "fine", ...opts }, signer);
  const meterless = (body as { meterless?: unknown }).meterless;
  const usage = (body as { usage: { prompt_tokens: number; completion_tokens: number } }).usage;
  const verdict = verifyLiveReceipt(
    meterless,
    {
      requestedModel: model,
      memoryScope: scope,
      responseId: (body as { id: string }).id,
      lastUserText: user,
      requestHash: "req-hash",
      responseHash: "resp-hash",
      usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens },
      lane: "remote",
      now: NOW,
      ...over,
    },
    policy,
    ledger,
    "planner",
  );
  return { verdict, ledger };
}

describe("verifyLiveReceipt: a good receipt", () => {
  it("is accepted, records every check, and carries the signed fields through", () => {
    const { verdict, ledger } = run({});
    expect(verdict.accepted).toBe(true);
    if (!verdict.accepted) return;
    const names = verdict.checks.map((c) => c.name);
    for (const n of ["signature", "key", "routed-model", "tier", "hmem", "request-id", "memory-scope", "request-binding", "response-binding", "fresh", "not-replayed"]) expect(names).toContain(n);
    expect(verdict.checks.every((c) => c.passed)).toBe(true);
    expect(verdict.receipt).toMatchObject({ routedModel: NEMOTRON_LIGHTNING, hmem: 0, keyId: sim.key.keyId, requestHash: "req-hash", responseHash: "resp-hash" });
    expect(verdict.receipt.raw["nightshiftVersion"]).toBe("1.2.3");
    expect(ledger.get(verdict.receipt.receiptId)?.origin).toBe("live");
  });
  it("accepts a null hmem, an absent hmem and a zero hmem, all as zero", () => {
    for (const hmem of [null, 0, undefined, false, {}, { count: 0, items: [] }]) expect(run({ hmem }).verdict.accepted, JSON.stringify(hmem)).toBe(true);
  });
  it("accepts the Ultra model at its observed tier", () => {
    expect(run({ tier: "C" }, {}, POLICY, new ReceiptLedger(), NEMOTRON_ULTRA).verdict.accepted).toBe(true);
  });
});

describe("verifyLiveReceipt: each way a receipt can be wrong is rejected, logged, and not accepted twice", () => {
  const cases: [string, Partial<SimOptions>, string, Partial<ReceiptContext>?][] = [
    ["no meterless object at all", { omitMeterless: true }, "MISSING"],
    ["no signed envelope", { omitEnvelope: true }, "UNSIGNED"],
    ["a corrupted signature", { flipSignatureBit: true }, "BAD_SIGNATURE"],
    ["a signature made with another key than the one named", { forgeSignature: true }, "BAD_SIGNATURE"],
    ["a signed field changed after signing", { tamperAfterSigning: (r) => { r["usage"] = { input_tokens: 1, output_tokens: 1 }; } }, "BAD_SIGNATURE"],
    ["a different model answered than was requested", { routedModel: NEMOTRON_ULTRA, tier: "C" }, "WRONG_MODEL"],
    ["an explicit id routed to auto (the 0.6.2 defect)", { routedModel: "meterless/auto" }, "WRONG_MODEL"],
    ["the unsigned routed_model hides a swap", { routedModel: NEMOTRON_ULTRA, tier: "C", tamperOuter: (o) => { o["routed_model"] = NEMOTRON_LIGHTNING; } }, "TAMPERED"],
    ["the unsigned receipt copy differs from the signed one", { tamperOuter: (o) => { (o["receipt"] as Record<string, unknown>)["app"] = "other"; } }, "TAMPERED"],
    ["the routing record disagrees with the model that answered", { extraReceiptFields: { routing: { winner: NEMOTRON_ULTRA } } }, "WRONG_MODEL"],
    ["the winning route names another model while the routing record claims the requested one", { routedModel: NEMOTRON_ULTRA, extraReceiptFields: { routing: { winner: NEMOTRON_LIGHTNING } } }, "WRONG_MODEL"],
    ["the wrong tier", { tier: "C" }, "WRONG_TIER"],
    ["a different app id", { app: "someone-else" }, "WRONG_APP"],
    ["a receipt for another completion", { requestId: "chatcmpl-someone-else" }, "WRONG_CUSTODY"],
    ["remembered context was added (hmem 1)", { hmem: 1 }, "HMEM_NONZERO"],
    ["remembered context was added (hmem 2)", { hmem: 2 }, "HMEM_NONZERO"],
    ["remembered context in an unknown shape", { hmem: { used: ["x"] } }, "HMEM_NONZERO"],
    ["an hmem value that cannot be read", { hmem: "yes" }, "HMEM_NONZERO"],
    ["the answer came from the response cache", { fromCache: true }, "FROM_CACHE"],
    ["a cache hit status in the signed receipt", { cacheStatus: "hit" }, "FROM_CACHE"],
    ["a different memory scope was echoed", { echoScope: "scope-of-another-call" }, "SCOPE_MISMATCH"],
    ["a prompt length that is not what was sent", { promptChars: 5 }, "BINDING_MISMATCH"],
    ["a prompt preview that is not what was sent", { promptPreview: "Something else entirely" }, "BINDING_MISMATCH"],
    ["token counts that disagree with the reply", { inputTokens: 999 }, "BINDING_MISMATCH", { usage: { promptTokens: 7, completionTokens: 2 } }],
    ["a receipt whose status is not ok", { status: "error" }, "NOT_OK"],
    ["a receipt signed an hour ago", { tsMs: NOW.getTime() - 3_600_000 }, "STALE"],
    ["a receipt signed in the future", { tsMs: NOW.getTime() + 3_600_000 }, "STALE"],
    ["a cloud route for a call meant to stay local", { kind: "cloud" }, "LANE_VIOLATION", { lane: "local" }],
  ];
  for (const [name, opts, code, over] of cases) {
    it(`${name} -> ${code}`, () => {
      const { verdict, ledger } = run(opts, over ?? {});
      expect(verdict.accepted).toBe(false);
      if (verdict.accepted) return;
      expect(verdict.code).toBe(code);
      expect(verdict.reason.length).toBeGreaterThan(10);
      expect(verdict.checks.at(-1)?.passed).toBe(false);
      expect(ledger.rejected().at(-1)?.code).toBe(code);
      expect(ledger.accepted()).toHaveLength(0);
    });
  }

  it("a receipt signed by an unknown key is rejected, even though its signature is valid", () => {
    const stranger = new SimKey();
    const { verdict } = run({}, {}, POLICY, new ReceiptLedger(), NEMOTRON_LIGHTNING, stranger);
    expect(verdict).toMatchObject({ accepted: false, code: "UNTRUSTED_KEY" });
    expect(verdict.accepted === false && verdict.reason).toContain(stranger.keyId);
  });
  it("an unpinned key is accepted only when allowed, and the receipt says it was not pinned", () => {
    const stranger = new SimKey();
    const { verdict } = run({}, {}, { ...POLICY, allowUnpinnedKey: true }, new ReceiptLedger(), NEMOTRON_LIGHTNING, stranger);
    expect(verdict.accepted).toBe(true);
    if (verdict.accepted) expect(verdict.receipt.raw["keyPinned"]).toBe(false);
  });
  it("with no key pinned at all, nothing is accepted", () => {
    expect(run({}, {}, { trustedKeyIds: [] }).verdict).toMatchObject({ accepted: false, code: "UNTRUSTED_KEY" });
  });

  it("the same receipt id is rejected the second time (replay)", () => {
    const ledger = new ReceiptLedger();
    const first = run({ receiptId: "rcpt_fixed", decisionId: "req_fixed" }, {}, POLICY, ledger);
    expect(first.verdict.accepted).toBe(true);
    const second = run({ receiptId: "rcpt_fixed", decisionId: "req_fixed" }, {}, POLICY, ledger);
    expect(second.verdict).toMatchObject({ accepted: false, code: "REPLAYED" });
  });
  it("a reused decision id under a new receipt id is also a replay", () => {
    const ledger = new ReceiptLedger();
    run({ receiptId: "rcpt_a", decisionId: "req_same" }, {}, POLICY, ledger);
    expect(run({ receiptId: "rcpt_b", decisionId: "req_same" }, {}, POLICY, ledger).verdict).toMatchObject({ accepted: false, code: "REPLAYED" });
  });
  it("a call excluded for memory is listed so an evaluation can drop it", () => {
    const ledger = new ReceiptLedger();
    run({ hmem: 2 }, {}, POLICY, ledger);
    expect(ledger.excludedForMemory()).toHaveLength(1);
    expect(ledger.excludedForMemory()[0]).toMatchObject({ code: "HMEM_NONZERO", hmem: 2, role: "planner" });
  });
  it("with no completion id to compare, custody cannot be shown and the receipt is rejected", () => {
    expect(run({}, { responseId: "" }).verdict).toMatchObject({ accepted: false, code: "WRONG_CUSTODY" });
  });
  it("hash fields, if a future build carries them, must equal the local hashes", () => {
    expect(run({ extraReceiptFields: { request_hash: "sha256:req-hash", response_hash: "resp-hash" } }).verdict.accepted).toBe(true);
    expect(run({ extraReceiptFields: { request_hash: "sha256:something-else" } }).verdict).toMatchObject({ accepted: false, code: "BINDING_MISMATCH" });
  });
  it("tolerates a preview cut short of the prompt but not one that differs", () => {
    expect(run({ promptPreview: "Check the vers" }).verdict.accepted).toBe(true);
    expect(run({ promptPreview: "check the vers" }).verdict.accepted).toBe(false);
  });
});

describe("hmemCount", () => {
  it("reads null, absent, zero, numbers, arrays and objects; NaN for the unreadable", () => {
    expect(hmemCount(null)).toBe(0);
    expect(hmemCount(undefined)).toBe(0);
    expect(hmemCount(0)).toBe(0);
    expect(hmemCount(3)).toBe(3);
    expect(hmemCount([1, 2])).toBe(2);
    expect(hmemCount({ a: 1, b: [1, 2], c: { d: 1 } })).toBe(4);
    expect(hmemCount(-1)).toBeNaN();
    expect(hmemCount("two")).toBeNaN();
  });
});

describe("receipt coverage (MA-5)", () => {
  it("counts live-verified, recorded-verified, unreceipted and unverified items, and never reports 1 for nothing", () => {
    const ledger = new ReceiptLedger();
    const a = run({}, {}, POLICY, ledger).verdict;
    const b = run({}, {}, POLICY, ledger).verdict;
    if (!a.accepted || !b.accepted) throw new Error("setup");
    ledger.accept({ receiptId: "rcpt_rec", keyId: "k", model: "m", tier: "A", at: "t", requestHash: "", responseHash: "", origin: "recorded" });
    const cov = receiptCoverage(
      [
        { id: "f1", receiptId: a.receipt.receiptId },
        { id: "f2", receiptId: b.receipt.receiptId },
        { id: "f3", receiptId: "rcpt_rec" },
        { id: "f4" },
        { id: "f5", receiptId: "rcpt_unknown" },
      ],
      ledger,
    );
    expect(cov).toMatchObject({ total: 5, verifiedLive: 2, verifiedRecorded: 1, unreceipted: ["f4"], unverified: [{ id: "f5", receiptId: "rcpt_unknown" }] });
    expect(cov.share).toBeCloseTo(0.6);
    expect(cov.shareLive).toBeCloseTo(0.4);
    expect(receiptCoverage([], ledger).share).toBeNull();
  });
  it("a rejected receipt does not cover its item", () => {
    const ledger = new ReceiptLedger();
    const rejected = run({ hmem: 1, receiptId: "rcpt_bad" }, {}, POLICY, ledger).verdict;
    expect(rejected.accepted).toBe(false);
    expect(receiptCoverage([{ id: "x", receiptId: "rcpt_bad" }], ledger).verifiedLive).toBe(0);
  });
});

describe("key ids", () => {
  it("is the first 16 hex characters of the SHA-256 of the raw key", () => {
    const k = new SimKey();
    expect(keyIdOf(k.publicRaw)).toBe(k.keyId);
    expect(k.keyId).toMatch(/^[0-9a-f]{16}$/);
  });
});
