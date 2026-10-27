import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProviderChain } from "../../src/models/chain.ts";
import { NightshiftClient } from "../../src/models/nightshift.ts";
import { NvidiaClient } from "../../src/models/nvidia.ts";
import { receiptCoverage } from "../../src/models/receipt.ts";
import { LOCAL_LIGHTNING, NEMOTRON_LIGHTNING, NEMOTRON_ULTRA } from "../../src/models/roles.ts";
import { PortError } from "../../src/ports/index.ts";
import { harness, instantTransport, request } from "./helpers/build.ts";
import { completion, TestChatServer } from "./helpers/chat-server.ts";
import { NightshiftSim, SimKey, type SimOptions } from "./helpers/nightshift-sim.ts";

const server = new TestChatServer();
const sim = new NightshiftSim();
beforeAll(async () => {
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(() => {
  server.reset();
  server.models = [NEMOTRON_LIGHTNING, NEMOTRON_ULTRA, LOCAL_LIGHTNING];
});

/** The Nightshift double answers every chat call with a receipt signed as the installed application would. */
function answerWith(opts: (n: number, model: string) => Partial<SimOptions> & { content?: string } = () => ({})): void {
  server.chat = (r, n) => {
    const o = opts(n, String(r.body["model"]));
    return { body: sim.reply(r, { content: "grounded answer", ...o }) };
  };
}

function client(over: Record<string, unknown> = {}) {
  const h = harness();
  const t = instantTransport();
  const c = new NightshiftClient({
    baseUrl: server.baseUrl,
    apiKey: "nightshift-token-0123456789",
    trace: h.trace,
    egress: h.egress,
    promptLog: h.promptLog,
    ledger: h.ledger,
    trustedKeyIds: [sim.key.keyId],
    expectedAppId: "node",
    version: "1.2.3",
    transport: t.transport,
    ...over,
  });
  return { c, ...h };
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

describe("a call served by Nightshift", () => {
  it("returns the answer with a verified receipt, labelled nightshift", async () => {
    answerWith();
    const { c, ledger } = client();
    const r = await c.complete(request({ role: "planner" }));
    expect(r).toMatchObject({ text: "grounded answer", provider: "nightshift", requestedModel: NEMOTRON_LIGHTNING, routedModel: NEMOTRON_LIGHTNING, recorded: false });
    expect(r.receipt).toMatchObject({ routedModel: NEMOTRON_LIGHTNING, keyId: sim.key.keyId, hmem: 0 });
    expect(r.receipt?.requestHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.receipt?.responseHash).toMatch(/^[0-9a-f]{64}$/);
    expect(r.receipt?.raw["nightshiftVersion"]).toBe("1.2.3");
    expect(ledger.accepted()).toHaveLength(1);
    expect(ledger.get(r.receipt!.receiptId)).toMatchObject({ origin: "live", role: "planner", model: NEMOTRON_LIGHTNING });
  });

  it("sends a memory scope that is unique to every call and to every attempt, and the first-token limit", async () => {
    answerWith((n) => (n === 2 ? {} : {}));
    server.chat = (r, n) => (n === 1 ? { status: 503, body: {} } : { body: sim.reply(r, { content: "ok" }) });
    const { c } = client();
    const first = request();
    const second = request();
    await c.complete(first);
    await c.complete(second);
    const scopes = server.chatRequests.map((r) => String(r.headers["meterless-scope"]));
    expect(new Set(scopes).size).toBe(scopes.length);
    expect(scopes[0]).toBe(`${first.memoryScope}.a1`);
    expect(scopes[1]).toBe(`${first.memoryScope}.a2`);
    expect(scopes[2]).toBe(`${second.memoryScope}.a1`);
    expect(server.chatRequests[0]!.headers["meterless-ttfb-ms"]).toBe("90000");
  });

  it("verifies the receipt against the scope of the attempt that succeeded", async () => {
    server.chat = (r, n) => (n === 1 ? { status: 503, body: {} } : { body: sim.reply(r, { content: "ok" }) });
    const { c } = client();
    const res = await c.complete(request());
    expect(res.receipt).toBeDefined();
  });

  it("two calls produce two different receipts and both are covered", async () => {
    answerWith();
    const { c, ledger } = client();
    const a = await c.complete(request());
    const b = await c.complete(request());
    expect(a.receipt!.receiptId).not.toBe(b.receipt!.receiptId);
    const cov = receiptCoverage([{ id: "x", receiptId: a.receipt!.receiptId }, { id: "y", receiptId: b.receipt!.receiptId }], ledger);
    expect(cov.share).toBe(1);
  });

  it("verifies the repaired call's receipt and lists the first call's id beside it", async () => {
    answerWith((n) => ({ content: n === 1 ? '{"v":"bad"}' : '{"v":"good"}' }));
    const { c, ledger } = client();
    const r = await c.complete(request({ jsonSchema: { type: "object", properties: { v: { const: "good" } }, required: ["v"] } }));
    expect(r.json).toEqual({ v: "good" });
    expect(ledger.accepted()).toHaveLength(2);
    expect(r.receipt?.raw["earlierReceiptIds"]).toHaveLength(1);
  });
});

describe("a bad receipt makes the call fail, is logged, and is excluded", () => {
  const cases: [string, Partial<SimOptions>, string][] = [
    ["remembered context (hmem 2)", { hmem: 2 }, "HMEM_NONZERO"],
    ["a different model answered", { routedModel: NEMOTRON_ULTRA, tier: "C" }, "WRONG_MODEL"],
    ["a forged signature", { forgeSignature: true }, "BAD_SIGNATURE"],
    ["no signature", { omitEnvelope: true }, "UNSIGNED"],
    ["no receipt", { omitMeterless: true }, "MISSING"],
    ["a cached answer", { fromCache: true }, "FROM_CACHE"],
    ["a receipt for another completion", { requestId: "chatcmpl-other" }, "WRONG_CUSTODY"],
  ];
  for (const [name, opts, code] of cases) {
    it(`${name} -> INVALID with receiptRejection ${code}`, async () => {
      server.chat = (r) => ({ body: sim.reply(r, { content: "x", ...opts }) });
      const { c, ledger, trace } = client({ roles: undefined });
      const e = await failure(c.complete(request({ role: "reporter" })));
      expect(e.failure).toBe("INVALID");
      expect(e.detail).toMatchObject({ receiptRejection: code, excluded: true });
      expect(ledger.rejected().at(-1)?.code).toBe(code);
      expect(trace.of("model.receipt").at(-1)).toMatchObject({ accepted: false, code });
      expect(ledger.accepted()).toHaveLength(0);
    });
  }

  it("a receipt signed by another key is rejected: the key is not the installed application's", async () => {
    const stranger = new SimKey();
    server.chat = (r) => ({ body: sim.reply(r, { content: "x" }, stranger) });
    const { c } = client();
    const e = await failure(c.complete(request()));
    expect(e.detail).toMatchObject({ receiptRejection: "UNTRUSTED_KEY" });
  });

  it("a receipt replayed from an earlier call is rejected", async () => {
    server.chat = (r) => ({ body: sim.reply(r, { content: "x", receiptId: "rcpt_replayed", decisionId: "req_replayed" }) });
    const { c } = client();
    await c.complete(request());
    const e = await failure(c.complete(request()));
    expect(e.detail).toMatchObject({ receiptRejection: "REPLAYED" });
  });

  it("does not fall back to another model after a bad receipt: that is a fault to see, not to route around", async () => {
    server.chat = (r) => ({ body: sim.reply(r, { content: "x", hmem: 1 }) });
    const { c } = client();
    await failure(c.complete(request({ role: "critic" })));
    expect(server.chatRequests).toHaveLength(1);
  });

  it("with requireReceipt off, a reply with no receipt at all is returned unreceipted, but a bad receipt still fails", async () => {
    server.chat = (r) => ({ body: sim.reply(r, { content: "plain", omitMeterless: true }) });
    const { c, ledger } = client({ requireReceipt: false });
    const r = await c.complete(request());
    expect(r.text).toBe("plain");
    expect(r.receipt).toBeUndefined();
    expect(ledger.accepted()).toHaveLength(0);
    server.chat = (r2) => ({ body: sim.reply(r2, { content: "x", hmem: 1 }) });
    expect((await failure(c.complete(request()))).detail).toMatchObject({ receiptRejection: "HMEM_NONZERO" });
  });
});

describe("tier expectations", () => {
  it("are enforced only for the models the caller lists, and a receipt with no tier is always rejected", async () => {
    server.chat = (r) => ({ body: sim.reply(r, { content: "x", tier: "C" }) });
    const strict = client({ expectedTiers: { [NEMOTRON_LIGHTNING]: "A" } });
    const e = await failure(strict.c.complete(request({ role: "reporter" })));
    expect(e.detail).toMatchObject({ receiptRejection: "WRONG_TIER" });
    // without an expectation the same receipt is accepted, and its tier is recorded
    const lenient = client();
    const r = await lenient.c.complete(request({ role: "reporter" }));
    expect(r.receipt?.raw["tier"]).toBe("C");
    expect(lenient.ledger.get(r.receipt!.receiptId)?.tier).toBe("C");
    server.chat = (r2) => ({ body: sim.reply(r2, { content: "x", extraReceiptFields: { winning_route: { model: NEMOTRON_LIGHTNING, kind: "cloud", provider: "nvidia" } } }) });
    const noTier = await failure(client().c.complete(request({ role: "reporter" })));
    expect(noTier.detail).toMatchObject({ receiptRejection: "WRONG_TIER" });
  });
});

describe("the endpoint and the key", () => {
  it("refuses an endpoint that is not loopback unless told it is a private deployment", () => {
    const h = harness();
    const base = { apiKey: "nightshift-token-0123456789", trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: [sim.key.keyId] };
    expect(() => new NightshiftClient({ ...base, baseUrl: "http://10.0.0.5:8088/v1" })).toThrowError(/loopback/);
    expect(() => new NightshiftClient({ ...base, baseUrl: "https://nightshift.example.com/v1" })).toThrowError(/loopback/);
    expect(() => new NightshiftClient({ ...base, baseUrl: "http://10.0.0.5:8088/v1", allowNonLoopback: true })).not.toThrow();
    expect(() => new NightshiftClient({ ...base, baseUrl: "http://[::1]:8088/v1" })).not.toThrow();
  });
  it("needs the application's key", () => {
    const h = harness();
    expect(() => new NightshiftClient({ apiKey: "", trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: [] })).toThrowError(/API key/);
  });
  it("sends the bearer token on every call", async () => {
    answerWith();
    await client().c.complete(request());
    expect(server.chatRequests[0]!.headers["authorization"]).toBe("Bearer nightshift-token-0123456789");
  });
});

describe("lanes", () => {
  it("registers a remote lane, and a local lane that says it is NOT VERIFIED", () => {
    const { egress } = client({});
    expect(egress.mode().lanes.map((l) => l.id)).toEqual(["nightshift:cloud"]);
    const h = harness();
    new NightshiftClient({ baseUrl: server.baseUrl, apiKey: "nightshift-token-0123456789", trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: [sim.key.keyId], lane: "local" });
    const mode = h.egress.mode();
    expect(mode).toMatchObject({ localConfigured: true, localLaneVerified: false, remoteConfigured: false });
    expect(mode.lanes[0]!.note).toMatch(/NOT VERIFIED/);
  });

  it("in the local lane uses the role's local model, accepts vendor-confidential content, and then marks the lane verified", async () => {
    server.chat = (r) => ({ body: sim.reply(r, { content: "local answer", kind: "local", tier: undefined }) });
    const h = harness();
    // The local model has no observed tier, so none is expected of it.
    const c = new NightshiftClient({ baseUrl: server.baseUrl, apiKey: "nightshift-token-0123456789", trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: [sim.key.keyId], lane: "local", transport: instantTransport().transport });
    const r = await c.complete(request({ dataClass: "vendor-confidential", role: "extractor" }));
    expect(server.chatRequests[0]!.body["model"]).toBe(LOCAL_LIGHTNING);
    expect(r.routedModel).toBe(LOCAL_LIGHTNING);
    expect(h.egress.mode().localLaneVerified).toBe(true);
    expect(h.trace.of("egress.decision")[0]).toMatchObject({ allowed: true, basis: "local-lane" });
  });

  it("a local-lane call that the receipt says went to the cloud is rejected", async () => {
    server.chat = (r) => ({ body: sim.reply(r, { content: "oops", kind: "cloud" }) });
    const h = harness();
    const c = new NightshiftClient({ baseUrl: server.baseUrl, apiKey: "nightshift-token-0123456789", trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: [sim.key.keyId], lane: "local", transport: instantTransport().transport });
    const e = await failure(c.complete(request({ dataClass: "vendor-confidential", role: "extractor" })));
    expect(e.detail).toMatchObject({ receiptRejection: "LANE_VIOLATION" });
    expect(h.egress.mode().localLaneVerified).toBe(false);
  });

  it("a remote Nightshift refuses vendor-confidential content without a consent, exactly like the NVIDIA client", async () => {
    answerWith();
    const { c } = client();
    expect((await failure(c.complete(request({ dataClass: "vendor-confidential" })))).detail).toMatchObject({ basis: "no-consent" });
    expect(server.chatRequests).toHaveLength(0);
  });
});

describe("provider chain: Nightshift primary, NVIDIA behind it", () => {
  it("answers from Nightshift when it works, and from NVIDIA, labelled nvidia, when Nightshift is unavailable", async () => {
    const nightshiftServer = server;
    const nvidiaServer = await new TestChatServer().start();
    try {
      const h = harness();
      const t = instantTransport({ maxAttempts: 1 });
      const ns = new NightshiftClient({ baseUrl: nightshiftServer.baseUrl, apiKey: "nightshift-token-0123456789", trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: [sim.key.keyId], transport: t.transport });
      const nv = new NvidiaClient({ baseUrl: nvidiaServer.baseUrl, apiKey: "nvidia-key-0123456789", trace: h.trace, egress: h.egress, transport: t.transport });
      const chain = new ProviderChain([{ name: "nightshift", port: ns }, { name: "nvidia", port: nv }], { trace: h.trace });
      nightshiftServer.chat = (r) => ({ body: sim.reply(r, { content: "via nightshift" }) });
      expect((await chain.complete(request({ role: "reporter" }))).provider).toBe("nightshift");
      nightshiftServer.chat = () => ({ status: 503, body: {} });
      nvidiaServer.chat = () => ({ body: completion({ content: "via nvidia" }) });
      const r = await chain.complete(request({ role: "reporter" }));
      expect(r).toMatchObject({ text: "via nvidia", provider: "nvidia" });
      expect(r.receipt).toBeUndefined();
      expect(h.trace.of("model.provider_fallback")).toHaveLength(1);
    } finally {
      await nvidiaServer.stop();
    }
  });

  it("does not hide a bad receipt behind a fallback unless asked to, and says so when it does", async () => {
    const nvidiaServer = await new TestChatServer().start();
    try {
      const h = harness();
      const t = instantTransport({ maxAttempts: 1 });
      const ns = new NightshiftClient({ baseUrl: server.baseUrl, apiKey: "nightshift-token-0123456789", trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: [sim.key.keyId], transport: t.transport });
      const nv = new NvidiaClient({ baseUrl: nvidiaServer.baseUrl, apiKey: "nvidia-key-0123456789", trace: h.trace, egress: h.egress, transport: t.transport });
      server.chat = (r) => ({ body: sim.reply(r, { content: "x", hmem: 1 }) });
      nvidiaServer.chat = () => ({ body: completion({ content: "via nvidia" }) });
      const strict = new ProviderChain([{ name: "nightshift", port: ns }, { name: "nvidia", port: nv }], { trace: h.trace });
      await expect(strict.complete(request({ role: "reporter" }))).rejects.toMatchObject({ failure: "INVALID" });
      expect(nvidiaServer.chatRequests).toHaveLength(0);
      const lenient = new ProviderChain([{ name: "nightshift", port: ns }, { name: "nvidia", port: nv }], { trace: h.trace, fallbackOnReceiptRejection: true });
      const r = await lenient.complete(request({ role: "reporter" }));
      expect(r.provider).toBe("nvidia");
      expect(h.trace.of("model.provider_fallback").at(-1)).toMatchObject({ receiptRejection: "HMEM_NONZERO" });
    } finally {
      await nvidiaServer.stop();
    }
  });
});
