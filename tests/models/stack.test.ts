import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createModelStack, readEnvFile } from "../../src/models/stack.ts";
import { defaultReceiptLogPath, readInstalledKeyId } from "../../src/models/receipt.ts";
import { NEMOTRON_LIGHTNING, NEMOTRON_ULTRA } from "../../src/models/roles.ts";
import { PortError } from "../../src/ports/index.ts";
import { instantTransport, request } from "./helpers/build.ts";
import { completion, TestChatServer } from "./helpers/chat-server.ts";
import { NightshiftSim } from "./helpers/nightshift-sim.ts";

const nightshift = new TestChatServer();
const nvidia = new TestChatServer();
const sim = new NightshiftSim();
const dirs: string[] = [];
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sakaime-stack-"));
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
});
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const baseEnv = () => ({
  NIGHTSHIFT_API_KEY: "nightshift-token-0123456789",
  NIGHTSHIFT_BASE_URL: nightshift.baseUrl,
  NIGHTSHIFT_RECEIPT_KEY_ID: sim.key.keyId,
  NIGHTSHIFT_VERSION: "1.2.3",
  NVIDIA_API_KEY: "nvidia-key-0123456789",
  NVIDIA_BASE_URL: nvidia.baseUrl,
});

describe("createModelStack", () => {
  it("live: Nightshift is primary and its receipts are covered", async () => {
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "via nightshift" }) });
    const stack = await createModelStack({ env: baseEnv(), mode: "live", transport: instantTransport().transport });
    const r = await stack.port.complete(request({ role: "reporter" }));
    expect(r).toMatchObject({ provider: "nightshift", text: "via nightshift" });
    expect(stack.coverage([{ id: "a", receiptId: r.receipt!.receiptId }]).share).toBe(1);
    expect(stack.policy.mode().remoteConfigured).toBe(true);
  });

  it("live: falls back to NVIDIA when Nightshift is down, and the answer is labelled nvidia and unreceipted", async () => {
    nightshift.chat = () => ({ status: 503, body: {} });
    nvidia.chat = () => ({ body: completion({ content: "via nvidia" }) });
    const stack = await createModelStack({ env: baseEnv(), mode: "live", transport: instantTransport().transport });
    const r = await stack.port.complete(request({ role: "reporter" }));
    expect(r).toMatchObject({ provider: "nvidia", text: "via nvidia" });
    expect(r.receipt).toBeUndefined();
    expect(stack.coverage([{ id: "a" }]).unreceipted).toEqual(["a"]);
  });

  it("live without Nightshift's key id and without a receipt log: Nightshift is not used and the note says why", async () => {
    const env = { ...baseEnv(), NIGHTSHIFT_RECEIPT_KEY_ID: undefined, NIGHTSHIFT_RECEIPT_LOG: join(tmp(), "none.jsonl") };
    nvidia.chat = () => ({ body: completion({ content: "via nvidia" }) });
    const stack = await createModelStack({ env, mode: "live", transport: instantTransport().transport });
    expect(stack.nightshift).toBeUndefined();
    expect(stack.notes.join(" ")).toMatch(/NIGHTSHIFT_RECEIPT_KEY_ID/);
    expect((await stack.port.complete(request())).provider).toBe("nvidia");
    expect(nightshift.chatRequests).toHaveLength(0);
  });

  it("live with neither provider configured fails loudly", async () => {
    await expect(createModelStack({ env: {}, mode: "live" })).rejects.toMatchObject({ failure: "FORBIDDEN" });
  });

  it("beginRun re-probes every provider and records availability in the trace", async () => {
    const stack = await createModelStack({ env: baseEnv(), mode: "live", transport: instantTransport().transport });
    const snaps = await stack.beginRun();
    expect(snaps).toHaveLength(2);
    expect(stack.trace.of("model.availability")).toHaveLength(2);
  });

  it("record then recorded: a run with no keys replays what a live run recorded", async () => {
    const dir = join(tmp(), "cassettes");
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "recorded answer" }) });
    const live = await createModelStack({ env: baseEnv(), mode: "record", cassetteDir: dir });
    const req = { role: "extractor", system: "S", user: "U", dataClass: "public" as const };
    const first = await live.port.complete({ ...req, memoryScope: "scope-a" });
    expect(first.recorded).toBe(false);

    const replay = await createModelStack({ env: { NIGHTSHIFT_RECEIPT_KEY_ID: sim.key.keyId }, mode: "recorded", cassetteDir: dir });
    const second = await replay.port.complete({ ...req, memoryScope: "scope-b" });
    expect(second).toMatchObject({ text: "recorded answer", recorded: true, provider: "recorded" });
    expect(second.receipt?.receiptId).toBe(first.receipt?.receiptId);
    await expect(replay.port.complete({ ...req, user: "unseen", memoryScope: "scope-c" })).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { reason: "no recording" } });
    expect(await replay.beginRun()).toEqual([]);
  });

  it("SAMPLE_MODE=true selects recorded mode and needs no credentials", async () => {
    const stack = await createModelStack({ env: { SAMPLE_MODE: "true" }, cassetteDir: join(tmp(), "empty") });
    expect(stack.mode).toBe("recorded");
    await expect(stack.port.complete(request())).rejects.toBeInstanceOf(PortError);
  });

  it("the role map can be overridden from the environment", async () => {
    const stack = await createModelStack({ env: { ...baseEnv(), SAKAIME_ROLE_MODELS: JSON.stringify({ reporter: { model: NEMOTRON_ULTRA, fallbacks: [NEMOTRON_LIGHTNING] } }) }, mode: "live" });
    expect(stack.roles.spec("reporter").model).toBe(NEMOTRON_ULTRA);
  });

  it("a Nightshift that is not on loopback via MODEL_BASE_URL is ignored in favour of the default loopback address", async () => {
    const stack = await createModelStack({ env: { MODEL_API_KEY: "nightshift-token-0123456789", MODEL_BASE_URL: "https://elsewhere.example.com/v1", NIGHTSHIFT_RECEIPT_KEY_ID: sim.key.keyId, NVIDIA_API_KEY: "nvidia-key-0123456789", NVIDIA_BASE_URL: nvidia.baseUrl }, mode: "live" });
    expect(stack.nightshift).toBeDefined();
  });
});

describe("the installed application's key", () => {
  it("is read from the last verifiable envelope in the application's own receipt log", () => {
    const dir = tmp();
    const path = join(dir, "receipts.jsonl");
    const r1 = sim.reply({ method: "POST", url: "", headers: { "meterless-scope": "s" }, raw: "", body: { model: NEMOTRON_LIGHTNING, messages: [{ role: "user", content: "a" }] } }, { content: "x" });
    const env = (r1 as { meterless: { receipt_envelope: unknown } }).meterless.receipt_envelope;
    // a half-written first line, a good line, then a corrupt trailing line
    writeFileSync(path, `{"body": {"rec\n${JSON.stringify(env)}\nnot json at all\n`);
    expect(readInstalledKeyId(path)).toBe(sim.key.keyId);
  });
  it("is undefined when the log is missing or holds no verifiable envelope", () => {
    const dir = tmp();
    expect(readInstalledKeyId(join(dir, "missing.jsonl"))).toBeUndefined();
    const path = join(dir, "r.jsonl");
    writeFileSync(path, '{"body":{},"pubkey_b64":"AAAA","sig_b64":"AAAA"}\n');
    expect(readInstalledKeyId(path)).toBeUndefined();
  });
  it("finds the default log location from the environment", () => {
    expect(defaultReceiptLogPath({ NIGHTSHIFT_RECEIPT_LOG: "/x/y.jsonl" }, "linux")).toBe("/x/y.jsonl");
    expect(defaultReceiptLogPath({ LOCALAPPDATA: "C:\\L" }, "win32")).toContain("ai.meterless.runtime");
    expect(defaultReceiptLogPath({}, "linux")).toBeUndefined();
  });
  it("the stack takes the key id from the log when none is configured, and says it did", async () => {
    const dir = tmp();
    const path = join(dir, "receipts.jsonl");
    const r1 = sim.reply({ method: "POST", url: "", headers: { "meterless-scope": "s" }, raw: "", body: { model: NEMOTRON_LIGHTNING, messages: [{ role: "user", content: "a" }] } }, { content: "x" });
    writeFileSync(path, `${JSON.stringify((r1 as { meterless: { receipt_envelope: unknown } }).meterless.receipt_envelope)}\n`);
    const env = { ...baseEnv(), NIGHTSHIFT_RECEIPT_KEY_ID: undefined, NIGHTSHIFT_RECEIPT_LOG: path };
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "ok" }) });
    const stack = await createModelStack({ env, mode: "live", transport: instantTransport().transport });
    expect(stack.nightshift).toBeDefined();
    expect(stack.notes.join(" ")).toContain(sim.key.keyId);
    expect((await stack.port.complete(request())).provider).toBe("nightshift");
  });
});

describe("readEnvFile", () => {
  it("parses names and values, ignores comments, strips quotes, and never touches process.env", () => {
    const path = join(tmp(), ".env");
    writeFileSync(path, ["# comment", 'NVIDIA_API_KEY="abc123"', "  NIGHTSHIFT_BASE_URL = http://127.0.0.1:8088/v1 ", "EMPTY=", "not a line", ""].join("\n"));
    const before = process.env["NVIDIA_API_KEY"];
    expect(readEnvFile(path)).toEqual({ NVIDIA_API_KEY: "abc123", NIGHTSHIFT_BASE_URL: "http://127.0.0.1:8088/v1", EMPTY: "" });
    expect(process.env["NVIDIA_API_KEY"]).toBe(before);
    expect(readEnvFile(join(tmp(), "missing"))).toEqual({});
  });
});
