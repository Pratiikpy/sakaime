import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CASSETTE_SCHEMA, RecordedModelPort, RecordingModelPort } from "../../src/models/cassette.ts";
import { ForbiddenValues } from "../../src/models/egress.ts";
import { NightshiftClient } from "../../src/models/nightshift.ts";
import { NvidiaClient } from "../../src/models/nvidia.ts";
import { promptKey } from "../../src/models/keys.ts";
import { ReceiptLedger } from "../../src/models/receipt.ts";
import { NEMOTRON_LIGHTNING } from "../../src/models/roles.ts";
import { MemoryTraceSink } from "../../src/models/trace.ts";
import { PortError, type ModelPort, type ModelResponse } from "../../src/ports/index.ts";
import { harness, instantTransport, request } from "./helpers/build.ts";
import { completion, TestChatServer } from "./helpers/chat-server.ts";
import { NightshiftSim } from "./helpers/nightshift-sim.ts";

const server = new TestChatServer();
const sim = new NightshiftSim();
beforeAll(async () => {
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
const dirs: string[] = [];
beforeEach(() => server.reset());
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sakaime-cassette-"));
  dirs.push(d);
  return d;
};

function recordingStack(dir: string, kind: "nightshift" | "nvidia" = "nightshift") {
  const h = harness();
  const t = instantTransport();
  const live =
    kind === "nightshift"
      ? new NightshiftClient({ baseUrl: server.baseUrl, apiKey: "nightshift-token-0123456789", trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: [sim.key.keyId], transport: t.transport })
      : new NvidiaClient({ baseUrl: server.baseUrl, apiKey: "nvidia-key-0123456789", trace: h.trace, egress: h.egress, transport: t.transport });
  const recorder = new RecordingModelPort(live, { dir, trace: h.trace, forbidden: h.forbidden });
  return { ...h, recorder };
}

const failure = async (p: Promise<unknown>): Promise<PortError> => {
  try {
    await p;
  } catch (e) {
    if (e instanceof PortError) return e;
    throw e;
  }
  throw new Error("expected the call to fail");
};

describe("record then replay", () => {
  it("replays a recorded Nightshift reply with its receipt re-verified, labelled recorded", async () => {
    const dir = tmp();
    server.chat = (r) => ({ body: sim.reply(r, { content: "Version 2.1 is covered." }) });
    const { recorder } = recordingStack(dir);
    const req = request({ role: "extractor", system: "Extract.", user: "Does the study cover version 2.1?" });
    const live = await recorder.complete(req);
    expect(live.recorded).toBe(false);
    expect(recorder.stats.recorded).toBe(1);

    const trace = new MemoryTraceSink();
    const ledger = new ReceiptLedger();
    const replay = new RecordedModelPort({ dir, trace, receiptPolicy: { trustedKeyIds: [sim.key.keyId] }, ledger });
    const again = await replay.complete(request({ role: "extractor", system: "Extract.", user: "Does the study cover version 2.1?" }));
    expect(again).toMatchObject({ text: "Version 2.1 is covered.", provider: "recorded", recorded: true, requestedModel: NEMOTRON_LIGHTNING });
    expect(again.receipt?.receiptId).toBe(live.receipt?.receiptId);
    expect(again.receipt?.raw["replayVerification"]).toMatchObject({ origin: "recorded" });
    expect(ledger.get(again.receipt!.receiptId)?.origin).toBe("recorded");
    expect(trace.of("cassette.hit")[0]).toMatchObject({ recordedFrom: "nightshift", receiptKept: true });
  });

  it("a different scope, timeout or data class does not change the key; a different role or word does", () => {
    const a = request({ user: "same" });
    const sameQuestion = { ...a, memoryScope: "other", timeoutMs: 5, dataClass: "vendor-confidential" as const };
    expect(promptKey(a)).toBe(promptKey(sameQuestion));
    expect(promptKey(a)).not.toBe(promptKey({ ...a, role: "critic" }));
    expect(promptKey(a)).not.toBe(promptKey({ ...a, user: "same." }));
    expect(promptKey(a)).not.toBe(promptKey({ ...a, jsonSchema: { type: "object" } }));
    expect(promptKey(a)).not.toBe(promptKey({ ...a, maxTokens: 500 }));
  });

  it("replays structured output with its parsed json", async () => {
    const dir = tmp();
    server.chat = () => ({ body: completion({ content: '{"ok":true}', model: NEMOTRON_LIGHTNING }) });
    const { recorder } = recordingStack(dir, "nvidia");
    const base = { jsonSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] } };
    await recorder.complete(request({ ...base }));
    const replay = new RecordedModelPort({ dir, trace: new MemoryTraceSink() });
    const r = await replay.complete(request({ ...base }));
    expect(r.json).toEqual({ ok: true });
    expect(r.receipt).toBeUndefined();
    expect(r.provider).toBe("recorded");
  });

  it("the cassette file is plain, labelled and carries the prompt and the reply", async () => {
    const dir = tmp();
    server.chat = (r) => ({ body: sim.reply(r, { content: "reply text" }) });
    const { recorder } = recordingStack(dir);
    await recorder.complete(request({ role: "reporter", system: "S", user: "U" }));
    const [file] = readdirSync(dir);
    expect(file).toMatch(/^reporter-[0-9a-f]{32}\.json$/);
    const parsed = JSON.parse(readFileSync(join(dir, file as string), "utf8"));
    expect(parsed).toMatchObject({ schema: CASSETTE_SCHEMA, role: "reporter", request: { system: "S", user: "U", dataClass: "public" }, response: { text: "reply text", recordedFrom: "nightshift" } });
    expect(parsed.responseHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("a request with no recording abstains visibly and never invents", () => {
  it("throws UNAVAILABLE with the reason 'no recording'", async () => {
    const dir = tmp();
    const trace = new MemoryTraceSink();
    const replay = new RecordedModelPort({ dir, trace });
    const e = await failure(replay.complete(request({ user: "never seen" })));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(e.detail).toMatchObject({ reason: "no recording" });
    expect(e.message).toMatch(/does not invent/);
    expect(trace.of("cassette.miss")).toHaveLength(1);
  });
  it("a near miss (one changed character) is a miss, not the closest recording", async () => {
    const dir = tmp();
    server.chat = () => ({ body: completion({ content: "yes" }) });
    await recordingStack(dir, "nvidia").recorder.complete(request({ user: "Is it covered?" }));
    const replay = new RecordedModelPort({ dir, trace: new MemoryTraceSink() });
    expect((await failure(replay.complete(request({ user: "Is it covered!" })))).detail).toMatchObject({ reason: "no recording" });
    expect(replay.has(request({ user: "Is it covered?" }))).toBe(true);
    expect(replay.has(request({ user: "Is it covered!" }))).toBe(false);
  });
  it("an empty or missing directory is a miss", async () => {
    const replay = new RecordedModelPort({ dir: join(tmp(), "does-not-exist"), trace: new MemoryTraceSink() });
    expect((await failure(replay.complete(request()))).failure).toBe("UNAVAILABLE");
    expect(replay.keys()).toEqual([]);
  });
});

describe("a cassette that was edited is not trusted", () => {
  async function recorded() {
    const dir = tmp();
    server.chat = (r) => ({ body: sim.reply(r, { content: "original answer", tier: "C" }) });
    const req = request({ role: "critic", user: "Check this." });
    await recordingStack(dir).recorder.complete(req);
    const file = join(dir, readdirSync(dir)[0] as string);
    return { dir, file, req: { role: "critic", system: req.system, user: req.user } };
  }
  const ask = (dir: string, r: { role: string; system: string; user: string }) =>
    new RecordedModelPort({ dir, trace: new MemoryTraceSink(), receiptPolicy: { trustedKeyIds: [sim.key.keyId] } }).complete(request(r));

  it("an edited reply fails its response hash", async () => {
    const { dir, file, req } = await recorded();
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.response.text = "a more flattering answer";
    writeFileSync(file, JSON.stringify(j));
    const e = await failure(ask(dir, req));
    expect(e).toMatchObject({ failure: "DRIFTED", detail: { reason: "response hash mismatch" } });
  });
  it("an edited prompt fails its request hash", async () => {
    const { dir, file, req } = await recorded();
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.request.user = "Check something else.";
    writeFileSync(file, JSON.stringify(j));
    expect(await failure(ask(dir, req))).toMatchObject({ failure: "DRIFTED", detail: { reason: "request hash mismatch" } });
  });
  it("a file that is not a cassette is DRIFTED, not a crash", async () => {
    const { dir, file, req } = await recorded();
    writeFileSync(file, "{ nonsense");
    expect((await failure(ask(dir, req))).failure).toBe("DRIFTED");
    writeFileSync(file, JSON.stringify({ schema: "other" }));
    expect((await failure(ask(dir, req))).failure).toBe("DRIFTED");
  });
  it("a receipt that no longer verifies is dropped: the reply is shown but not as receipted", async () => {
    const { dir, file, req } = await recorded();
    const j = JSON.parse(readFileSync(file, "utf8"));
    j.response.receipt.raw.envelope.body.receipt.winning_route.tier = "Z"; // breaks the signature
    // keep the cassette's own integrity hash valid so only the receipt check can catch it
    const { hashOf } = await import("../../src/util/canonical.ts");
    j.responseHash = hashOf(j.response);
    writeFileSync(file, JSON.stringify(j));
    const trace = new MemoryTraceSink();
    const r = await new RecordedModelPort({ dir, trace, receiptPolicy: { trustedKeyIds: [sim.key.keyId] } }).complete(request(req));
    expect(r.text).toBe("original answer");
    expect(r.receipt).toBeUndefined();
    expect(trace.of("cassette.receipt_dropped")[0]).toMatchObject({ reason: expect.stringContaining("signature") });
  });
  it("without a key to check against, a receipt is not re-attached", async () => {
    const { dir, req } = await recorded();
    const r = await new RecordedModelPort({ dir, trace: new MemoryTraceSink() }).complete(request(req));
    expect(r.receipt).toBeUndefined();
    expect(r.recorded).toBe(true);
  });
  it("a receipt signed by a key that is not pinned is dropped", async () => {
    const { dir, req } = await recorded();
    const r = await new RecordedModelPort({ dir, trace: new MemoryTraceSink(), receiptPolicy: { trustedKeyIds: ["0000000000000000"] } }).complete(request(req));
    expect(r.receipt).toBeUndefined();
  });
});

describe("what a cassette may hold", () => {
  it("only public-class exchanges are written; the rest pass through and are listed as skipped", async () => {
    const dir = tmp();
    server.chat = () => ({ body: completion({ content: "ok" }) });
    const { recorder, consents } = recordingStack(dir, "nvidia");
    const g = consents.grant({ subject: "*", grantedBy: "x", reason: "y", ttlMs: 60_000 });
    const r = await recorder.complete(request({ dataClass: "vendor-confidential", consentToken: g.id, consentSubject: "*" }));
    expect(r.text).toBe("ok");
    expect(readdirSync(dir)).toEqual([]);
    expect(recorder.stats.recorded).toBe(0);
    expect(recorder.stats.skipped[0]!.reason).toMatch(/vendor-confidential/);
  });

  it("an exchange that holds a forbidden value in the reply is not written", async () => {
    const dir = tmp();
    server.chat = () => ({ body: completion({ content: "The rebate is Contoso-Rebate-5512." }) });
    const { recorder, forbidden } = recordingStack(dir, "nvidia");
    forbidden.add("Contoso-Rebate-5512", "masked-rebate");
    const r = await recorder.complete(request());
    expect(r.text).toContain("Contoso");
    expect(readdirSync(dir)).toEqual([]);
    expect(recorder.stats.skipped[0]!.reason).toMatch(/must not be written/);
  });

  it("a failed call records nothing", async () => {
    const dir = tmp();
    server.chat = () => ({ status: 401, body: {} });
    const { recorder } = recordingStack(dir, "nvidia");
    await failure(recorder.complete(request()));
    expect(readdirSync(dir)).toEqual([]);
  });

  it("a replayed reply is never re-recorded", async () => {
    const dir = tmp();
    const replayed: ModelResponse = { text: "x", requestedModel: "m", routedModel: "m", provider: "recorded", usage: { measured: false }, recorded: true };
    const inner: ModelPort = { complete: async () => replayed };
    const rec = new RecordingModelPort(inner, { dir, trace: new MemoryTraceSink(), forbidden: new ForbiddenValues() });
    await rec.complete(request());
    expect(readdirSync(dir)).toEqual([]);
  });
});
