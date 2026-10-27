import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { auditCassettes, describeAudit, describeAuditChecks } from "../../src/models/audit.ts";
import { createModelStack } from "../../src/models/stack.ts";
import { NEMOTRON_LIGHTNING, NEMOTRON_ULTRA } from "../../src/models/roles.ts";
import { instantTransport, newScope } from "./helpers/build.ts";
import { completion, TestChatServer } from "./helpers/chat-server.ts";
import { NightshiftSim } from "./helpers/nightshift-sim.ts";

/*
 * The model route: Nightshift first, NVIDIA's API only when Nightshift cannot be reached or its receipt fails, a recording
 * that Nightshift did not make is never presented as one, and a machine without Nightshift can still re-verify the receipts
 * stored with the recordings.
 */

const nightshift = new TestChatServer();
const nvidia = new TestChatServer();
const sim = new NightshiftSim();
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sakaime-route-"));
  dirs.push(d);
  return d;
};
beforeAll(async () => {
  await nightshift.start();
  await nvidia.start();
});
afterAll(async () => {
  await nightshift.stop();
  await nvidia.stop();
});
beforeEach(() => {
  nightshift.reset();
  nvidia.reset();
  nightshift.models = [NEMOTRON_LIGHTNING, NEMOTRON_ULTRA];
  nvidia.models = [NEMOTRON_LIGHTNING, NEMOTRON_ULTRA];
  nvidia.chat = () => ({ body: completion({ content: "via nvidia" }) });
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const env = () => ({
  NIGHTSHIFT_API_KEY: "nightshift-token-0123456789",
  NIGHTSHIFT_BASE_URL: nightshift.baseUrl,
  NIGHTSHIFT_RECEIPT_KEY_ID: sim.key.keyId,
  NIGHTSHIFT_VERSION: "1.2.3",
  NVIDIA_API_KEY: "nvidia-key-0123456789",
  NVIDIA_BASE_URL: nvidia.baseUrl,
});
const ask = (role = "reporter") => ({ role, system: "S", user: `question ${Math.random()}`, dataClass: "public" as const, memoryScope: newScope() });

describe("Nightshift first, NVIDIA only as a stated fallback", () => {
  it("serves from Nightshift when it answers, and never touches NVIDIA", async () => {
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "via nightshift" }) });
    const stack = await createModelStack({ env: env(), mode: "live", transport: instantTransport().transport });
    const r = await stack.port.complete(ask());
    expect(r.provider).toBe("nightshift");
    expect(nvidia.chatRequests).toHaveLength(0);
    expect(stack.trace.of("model.provider_fallback")).toHaveLength(0);
    expect(stack.fallbackEnabled).toBe(true);
  });

  it("every call carries its own memory scope, so no remembered context can cross calls", async () => {
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "x" }) });
    const stack = await createModelStack({ env: env(), mode: "live", transport: instantTransport().transport });
    for (let i = 0; i < 4; i += 1) await stack.port.complete(ask());
    const scopes = nightshift.chatRequests.map((q) => String(q.headers["meterless-scope"]));
    expect(new Set(scopes).size).toBe(4);
  });

  it("falls back when Nightshift is unreachable, says so in the trace, and labels the answer nvidia and unreceipted", async () => {
    nightshift.chat = () => ({ status: 503, body: {} });
    const stack = await createModelStack({ env: env(), mode: "live", transport: instantTransport().transport });
    const r = await stack.port.complete(ask());
    expect(r).toMatchObject({ provider: "nvidia", text: "via nvidia" });
    expect(r.receipt).toBeUndefined();
    const fb = stack.trace.of("model.provider_fallback");
    expect(fb).toHaveLength(1);
    expect(fb[0]).toMatchObject({ from: "nightshift", to: "nvidia" });
  });

  it("falls back when the receipt is invalid, names the rejection, and does not count the reply as Nightshift's", async () => {
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "unsigned claim", flipSignatureBit: true }) });
    const stack = await createModelStack({ env: env(), mode: "live", transport: instantTransport().transport });
    const r = await stack.port.complete(ask());
    expect(r.provider).toBe("nvidia");
    expect(r.text).toBe("via nvidia");
    expect(stack.trace.of("model.provider_fallback")[0]).toMatchObject({ from: "nightshift", receiptRejection: "BAD_SIGNATURE" });
    expect(stack.ledger.rejected().map((x) => x.code)).toEqual(["BAD_SIGNATURE"]);
    expect(stack.ledger.accepted()).toHaveLength(0);
  });

  it("a reply with remembered context (hmem above zero) is excluded and logged, then answered by the fallback", async () => {
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "polluted", hmem: 2 }) });
    const stack = await createModelStack({ env: env(), mode: "live", transport: instantTransport().transport });
    const r = await stack.port.complete(ask());
    expect(r.provider).toBe("nvidia");
    expect(stack.ledger.excludedForMemory()).toHaveLength(1);
    expect(stack.ledger.excludedForMemory()[0]).toMatchObject({ code: "HMEM_NONZERO", hmem: 2 });
    expect(stack.coverage([{ id: "a" }]).unreceipted).toEqual(["a"]);
  });

  it("a wrong Nightshift token is reported, not silently answered by another provider", async () => {
    nightshift.chat = () => ({ status: 401, body: { error: "unauthorized" } });
    const stack = await createModelStack({ env: env(), mode: "live", transport: instantTransport().transport });
    await expect(stack.port.complete(ask())).rejects.toMatchObject({ failure: "FORBIDDEN" });
    expect(nvidia.chatRequests).toHaveLength(0);
  });

  it("SAKAIME_MODEL_FALLBACK=off turns the fallback off: Nightshift down means the call fails", async () => {
    nightshift.chat = () => ({ status: 503, body: {} });
    const stack = await createModelStack({ env: { ...env(), SAKAIME_MODEL_FALLBACK: "off" }, mode: "live", transport: instantTransport().transport });
    expect(stack.fallbackEnabled).toBe(false);
    await expect(stack.port.complete(ask())).rejects.toMatchObject({ failure: "UNAVAILABLE" });
    expect(nvidia.chatRequests).toHaveLength(0);
    expect(stack.notes.join(" ")).toMatch(/not a fallback/);
  });

  it("without a Nightshift key the stack says the route is NVIDIA's API and why", async () => {
    const { NIGHTSHIFT_API_KEY: _drop, ...rest } = env();
    const stack = await createModelStack({ env: rest, mode: "live", transport: instantTransport().transport });
    expect(stack.nightshift).toBeUndefined();
    expect(stack.notes.join(" ")).toMatch(/Nightshift is not the model route: NIGHTSHIFT_API_KEY is not set/);
    expect((await stack.port.complete(ask())).provider).toBe("nvidia");
  });
});

describe("recording", () => {
  it("does not fall back by default: a recording is made by Nightshift or not at all", async () => {
    const dir = join(tmp(), "cassettes");
    nightshift.chat = () => ({ status: 503, body: {} });
    const stack = await createModelStack({ env: env(), mode: "record", cassetteDir: dir, transport: instantTransport().transport });
    expect(stack.fallbackEnabled).toBe(false);
    await expect(stack.port.complete(ask("extractor"))).rejects.toMatchObject({ failure: "UNAVAILABLE" });
    expect(nvidia.chatRequests).toHaveLength(0);
    expect(auditCassettes(dir, { trustedKeyIds: [sim.key.keyId] }).total).toBe(0);
  });

  it("a rejected receipt is excluded from the recording and nothing is written for it", async () => {
    const dir = join(tmp(), "cassettes");
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "x", hmem: 1 }) });
    const stack = await createModelStack({ env: env(), mode: "record", cassetteDir: dir, transport: instantTransport().transport });
    await expect(stack.port.complete(ask("extractor"))).rejects.toMatchObject({ failure: "INVALID", detail: { receiptRejection: "HMEM_NONZERO", excluded: true } });
    expect(auditCassettes(dir, { trustedKeyIds: [sim.key.keyId] }).total).toBe(0);
  });
});

describe("auditing the recordings", () => {
  async function record(dir: string, calls: number, via: "nightshift" | "nvidia" = "nightshift"): Promise<void> {
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: `answer ${Math.random()}` }) });
    const e = via === "nightshift" ? env() : { NVIDIA_API_KEY: "nvidia-key-0123456789", NVIDIA_BASE_URL: nvidia.baseUrl };
    const stack = await createModelStack({ env: e, mode: "record", cassetteDir: dir, transport: instantTransport().transport });
    for (let i = 0; i < calls; i += 1) await stack.port.complete({ ...ask(i % 2 === 0 ? "extractor" : "critic"), user: `recorded question ${via} ${i}` });
  }

  it("counts recordings made through Nightshift, re-verifies every receipt, and reports the models that answered", async () => {
    const dir = join(tmp(), "cassettes");
    await record(dir, 4);
    const a = auditCassettes(dir, { trustedKeyIds: [sim.key.keyId] });
    expect(a).toMatchObject({ total: 4, unreadable: [], byProvider: { nightshift: 4, nvidia: 0 }, receiptVerified: 4, receiptRejected: [], withoutReceipt: 0, signingKeyIds: [sim.key.keyId] });
    expect(Object.values(a.routedModels).reduce((x, y) => x + y, 0)).toBe(4);
    expect(describeAudit(a)).toBe("model answers are replayed from 4 recordings made through Nightshift (signed receipts)");
    expect(describeAuditChecks(a)).toContain("4 of 4 recorded receipts were re-verified");
  });

  it("does not call a recording Nightshift's when its receipt does not verify under the pinned key", async () => {
    const dir = join(tmp(), "cassettes");
    await record(dir, 2);
    const a = auditCassettes(dir, { trustedKeyIds: ["0000000000000000"] });
    expect(a.byProvider.nightshift).toBe(2);
    expect(a.receiptVerified).toBe(0);
    expect(a.receiptRejected).toHaveLength(2);
    expect(describeAudit(a)).toMatch(/0 of 2 carry a receipt that re-verified/);
    expect(describeAudit(a)).not.toBe("model answers are replayed from 2 recordings made through Nightshift (signed receipts)");
  });

  it("says plainly when recordings were made through NVIDIA's API directly, with no receipt", async () => {
    const dir = join(tmp(), "cassettes");
    await record(dir, 2, "nvidia");
    const a = auditCassettes(dir, { trustedKeyIds: [sim.key.keyId] });
    expect(a).toMatchObject({ total: 2, byProvider: { nightshift: 0, nvidia: 2 }, receiptVerified: 0, withoutReceipt: 2 });
    expect(describeAudit(a)).toMatch(/2 recordings made through NVIDIA's API directly, with no receipt/);
    expect(describeAuditChecks(a)).toBeUndefined();
  });

  it("an empty or missing directory is reported as having no recordings, not as a clean audit", () => {
    expect(describeAudit(auditCassettes(join(tmp(), "nowhere"), { trustedKeyIds: [] }))).toBe("no model recordings are present");
  });

  it("a damaged file is listed as unreadable and not counted", async () => {
    const dir = join(tmp(), "cassettes");
    await record(dir, 1);
    writeFileSync(join(dir, "bad.json"), "{ not json");
    const a = auditCassettes(dir, { trustedKeyIds: [sim.key.keyId] });
    expect(a.total).toBe(1);
    expect(a.unreadable).toEqual(["bad.json"]);
  });
});

describe("replay on a machine without Nightshift", () => {
  it("re-verifies stored receipts against the key id pinned beside the recordings", async () => {
    const root = tmp();
    const dir = join(root, "cassettes");
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "recorded answer" }) });
    const live = await createModelStack({ env: env(), mode: "record", cassetteDir: dir, transport: instantTransport().transport });
    const req = ask("extractor");
    const first = await live.port.complete(req);
    const pin = join(root, "receipt-key.json");
    writeFileSync(pin, JSON.stringify({ keyId: sim.key.keyId }));

    const replay = await createModelStack({ env: { SAMPLE_MODE: "true" }, cassetteDir: dir, trustedKeyFile: pin });
    const second = await replay.port.complete({ ...req, memoryScope: newScope() });
    expect(second).toMatchObject({ provider: "recorded", recorded: true });
    expect(second.receipt?.receiptId).toBe(first.receipt?.receiptId);
    expect(replay.coverage([{ id: "a", receiptId: second.receipt!.receiptId }])).toMatchObject({ verifiedRecorded: 1, share: 1, shareLive: 0 });
  });

  it("without the pin the reply is still shown but as unreceipted, with the reason in the trace", async () => {
    const root = tmp();
    const dir = join(root, "cassettes");
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "recorded answer" }) });
    const live = await createModelStack({ env: env(), mode: "record", cassetteDir: dir, transport: instantTransport().transport });
    const req = ask("extractor");
    await live.port.complete(req);
    const replay = await createModelStack({ env: { SAMPLE_MODE: "true" }, cassetteDir: dir, trustedKeyFile: join(root, "missing.json") });
    const second = await replay.port.complete({ ...req, memoryScope: newScope() });
    expect(second.receipt).toBeUndefined();
    expect(replay.trace.of("cassette.receipt_dropped")).toHaveLength(1);
  });

  it("a pin that names a different key does not verify the receipts", async () => {
    const root = tmp();
    const dir = join(root, "cassettes");
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "recorded answer" }) });
    const live = await createModelStack({ env: env(), mode: "record", cassetteDir: dir, transport: instantTransport().transport });
    const req = ask("extractor");
    await live.port.complete(req);
    const pin = join(root, "receipt-key.json");
    writeFileSync(pin, JSON.stringify({ keyId: "ffffffffffffffff" }));
    const replay = await createModelStack({ env: { SAMPLE_MODE: "true" }, cassetteDir: dir, trustedKeyFile: pin });
    expect((await replay.port.complete({ ...req, memoryScope: newScope() })).receipt).toBeUndefined();
  });

  it("an unreadable pin file is noted, not ignored silently", async () => {
    const root = tmp();
    const pin = join(root, "receipt-key.json");
    writeFileSync(pin, "{ nope");
    const replay = await createModelStack({ env: { SAMPLE_MODE: "true" }, cassetteDir: join(root, "c"), trustedKeyFile: pin });
    expect(replay.notes.join(" ")).toMatch(/could not be read/);
  });
});
