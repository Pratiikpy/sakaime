import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ReceiptLedger, verifyEnvelopeSignature, verifyLiveReceipt, type ReceiptContext, type ReceiptPolicy } from "../../src/models/receipt.ts";
import { NEMOTRON_LIGHTNING, NEMOTRON_ULTRA } from "../../src/models/roles.ts";
import { NightshiftSim, type SimOptions } from "./helpers/nightshift-sim.ts";
import type { RecordedRequest } from "./helpers/chat-server.ts";

/*
 * What the receipt's prompt is, measured against the installed Nightshift 1.2.3 on 2026-10-27: the user and assistant messages,
 * system messages left out, joined by one separator, and only the last 4000 characters when longer; prompt_chars is its length
 * and prompt_preview its first 180 characters. The first version of the check compared the receipt with the last user message
 * alone and so rejected 13 of 60 genuine replies while the sample run was recorded: every critic call (long prompts) and every
 * call that needed a schema repair (user, assistant, user).
 */

const here = dirname(fileURLToPath(import.meta.url));
const NOW = new Date("2026-10-27T12:00:00.000Z");
const sim = new NightshiftSim(() => NOW.getTime());
const POLICY: ReceiptPolicy = { trustedKeyIds: [sim.key.keyId], expectedTierByModel: { [NEMOTRON_LIGHTNING]: "A", [NEMOTRON_ULTRA]: "C" }, expectedAppId: "node" };
const model = NEMOTRON_LIGHTNING;
const NL = String.fromCharCode(10);
const words = (n: number, p: string): string => Array.from({ length: n }, (_, i) => `${p}${String(i).padStart(4, "0")}`).join(" ");

function verify(messages: { role: string; content: string }[], opts: Partial<SimOptions> = {}, over: Partial<ReceiptContext> = {}) {
  const scope = `scope-${Math.random().toString(16).slice(2)}`;
  const req: RecordedRequest = { method: "POST", url: "/v1/chat/completions", headers: { "meterless-scope": scope }, raw: "", body: { model, messages } };
  const body = sim.reply(req, { content: "fine", ...opts });
  const usage = (body as { usage: { prompt_tokens: number; completion_tokens: number } }).usage;
  const nonSystem = messages.filter((m) => m.role !== "system").map((m) => m.content);
  return verifyLiveReceipt(
    (body as { meterless?: unknown }).meterless,
    { requestedModel: model, memoryScope: scope, responseId: (body as { id: string }).id, lastUserText: nonSystem.at(-1) as string, conversation: nonSystem, requestHash: "a", responseHash: "b", usage: { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens }, lane: "remote", now: NOW, ...over },
    POLICY,
    new ReceiptLedger(),
    "critic",
  );
}

describe("the receipt's prompt is the non-system conversation, limited to its last 4000 characters", () => {
  it("a system message is not part of it", () => {
    expect(verify([{ role: "system", content: words(300, "s") }, { role: "user", content: words(40, "u") }]).accepted).toBe(true);
  });

  it("a repaired structured call (user, assistant, user) is accepted: the whole conversation, one separator between messages", () => {
    const v = verify([{ role: "system", content: "s" }, { role: "user", content: words(40, "a") }, { role: "assistant", content: words(20, "b") }, { role: "user", content: words(10, "c") }]);
    expect(v.accepted, JSON.stringify(v)).toBe(true);
    // The lengths the installed 1.2.3 reported for this shape: 239 + 119 + 59 characters plus two separators is 419.
    const three = [{ role: "user", content: "x".repeat(239) }, { role: "assistant", content: "y".repeat(119) }, { role: "user", content: "z".repeat(59) }];
    expect(verify(three, { promptChars: 419 }).accepted).toBe(true);
    expect(verify(three, { promptChars: 417 })).toMatchObject({ accepted: false, code: "BINDING_MISMATCH" });
  });

  it("a prompt longer than 4000 characters is recorded as its last 4000, and that is accepted", () => {
    const long = words(900, "t");
    expect(long.length).toBeGreaterThan(5000);
    const v = verify([{ role: "user", content: long }]);
    expect(v.accepted, JSON.stringify(v)).toBe(true);
    if (v.accepted) expect(v.checks.find((c) => c.name === "request-binding")?.detail).toContain("last 4000 characters");
  });

  it("a long prompt whose receipt shows the head of the text, or another length, is rejected", () => {
    const long = words(900, "t");
    expect(verify([{ role: "user", content: long }], { promptPreview: long.slice(0, 180) })).toMatchObject({ accepted: false, code: "BINDING_MISMATCH" });
    expect(verify([{ role: "user", content: long }], { promptChars: 3999 })).toMatchObject({ accepted: false, code: "BINDING_MISMATCH" });
  });

  it("a build that stops capping (prompt_chars equals the whole text) is still accepted", () => {
    const long = words(900, "t");
    expect(verify([{ role: "user", content: long }], { promptChars: long.length, promptPreview: long.slice(0, 180) }).accepted).toBe(true);
  });

  it("a preview that spans the join between two messages matches whichever whitespace joins them", () => {
    const a = "first message ends here";
    const b = "second message starts here and goes on for a while";
    const two = [{ role: "user", content: a }, { role: "assistant", content: b }];
    expect(verify(two, { promptPreview: `${a} ${b}` }).accepted).toBe(true);
    expect(verify(two, { promptPreview: `${a}${NL}${b}` }).accepted).toBe(true);
    expect(verify(two, { promptPreview: `${a}XX${b}` }).accepted).toBe(false);
  });

  it("a receipt for a different conversation of the same length is rejected by its preview", () => {
    expect(verify([{ role: "user", content: "a".repeat(100) }], { promptPreview: "b".repeat(100) })).toMatchObject({ accepted: false, code: "BINDING_MISMATCH" });
  });
});

// Real receipts from the installed Nightshift's own log for requests whose prompt was longer than 4000 characters. They are the
// critic calls of the sample run; the prompts are public-class text.
describe("receipts captured from the installed Nightshift 1.2.3 for prompts longer than 4000 characters", () => {
  interface LongFixture { receiptId: string; model: string; prompt: string; envelope: unknown }
  const fixtures: LongFixture[] = JSON.parse(readFileSync(join(here, "fixtures", "real-nightshift-long-prompts.json"), "utf8")).receipts;
  const ctx = (f: LongFixture, prompt: string): ReceiptContext => {
    const check = verifyEnvelopeSignature(f.envelope);
    const signed = check.receipt as Record<string, unknown>;
    return { requestedModel: f.model, memoryScope: "unused", responseId: signed["request_id"] as string, lastUserText: prompt, conversation: [prompt], requestHash: "h1", responseHash: "h2", lane: "remote", now: new Date((check.signedAtMs as number) + 2000) };
  };

  it("verify under the pinned key, with the request bound to the last 4000 characters of the prompt", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(2);
    for (const f of fixtures) {
      expect(f.prompt.length).toBeGreaterThan(4000);
      const check = verifyEnvelopeSignature(f.envelope);
      expect(check.valid).toBe(true);
      const verdict = verifyLiveReceipt({ schema: "meterless.compute_receipt.v1", receipt_envelope: f.envelope }, ctx(f, f.prompt), { trustedKeyIds: [check.keyId as string] }, new ReceiptLedger(), "critic");
      expect(verdict.accepted, JSON.stringify(verdict)).toBe(true);
      expect((check.receipt as { egress: { sent: { prompt_chars: number } } }).egress.sent.prompt_chars).toBe(4000);
    }
  });

  it("are rejected when checked against a different long prompt", () => {
    const f = fixtures[0] as LongFixture;
    const check = verifyEnvelopeSignature(f.envelope);
    const verdict = verifyLiveReceipt({ schema: "meterless.compute_receipt.v1", receipt_envelope: f.envelope }, ctx(f, "different text. ".repeat(600)), { trustedKeyIds: [check.keyId as string] }, new ReceiptLedger());
    expect(verdict).toMatchObject({ accepted: false, code: "BINDING_MISMATCH" });
  });
});
