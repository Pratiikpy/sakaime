import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NvidiaClient } from "../../src/models/nvidia.ts";
import { LOCAL_LIGHTNING, NEMOTRON_LIGHTNING, NEMOTRON_ULTRA, RoleMap } from "../../src/models/roles.ts";
import { MAX_PROMPT_BYTES } from "../../src/models/types.ts";
import { PortError } from "../../src/ports/index.ts";
import { harness, instantTransport, request } from "./helpers/build.ts";
import { completion, TestChatServer } from "./helpers/chat-server.ts";

const server = new TestChatServer();
beforeAll(async () => {
  await server.start();
});
afterAll(async () => {
  await server.stop();
});
beforeEach(() => {
  server.reset();
  server.models = [NEMOTRON_LIGHTNING, NEMOTRON_ULTRA];
  server.modelsStatus = 200;
});

function client(over: Record<string, unknown> = {}) {
  const h = harness();
  const t = instantTransport(over["transport"] as Record<string, unknown> | undefined);
  const { transport: _ignored, ...rest } = over;
  const c = new NvidiaClient({ baseUrl: server.baseUrl, apiKey: "test-key-0123456789", trace: h.trace, egress: h.egress, promptLog: h.promptLog, transport: t.transport, ...rest });
  return { c, ...h, sleeps: t.sleeps };
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

describe("a plain call", () => {
  it("sends the documented body with the key, resolves the role to its model, and labels the reply", async () => {
    server.chat = () => ({ body: completion({ content: "hello", model: NEMOTRON_LIGHTNING, usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 } }) });
    const { c } = client();
    const r = await c.complete(request({ role: "planner", system: "SYS", user: "USER" }));
    expect(r).toMatchObject({ text: "hello", requestedModel: NEMOTRON_LIGHTNING, routedModel: NEMOTRON_LIGHTNING, provider: "nvidia", recorded: false, usage: { promptTokens: 12, completionTokens: 2, measured: true } });
    expect(r.receipt).toBeUndefined();
    const sent = server.chatRequests[0]!;
    expect(sent.headers["authorization"]).toBe("Bearer test-key-0123456789");
    expect(sent.headers["meterless-scope"]).toBeUndefined();
    expect(sent.body).toMatchObject({
      model: NEMOTRON_LIGHTNING,
      messages: [{ role: "system", content: "SYS" }, { role: "user", content: "USER" }],
      max_tokens: 2048,
      temperature: 0,
      top_p: 1,
      chat_template_kwargs: { enable_thinking: false },
    });
    expect(sent.body["response_format"]).toBeUndefined();
  });

  it("uses Ultra for the critic and Lightning for the extractor", async () => {
    const { c } = client();
    await c.complete(request({ role: "critic" }));
    await c.complete(request({ role: "extractor" }));
    expect(server.chatRequests.map((r) => r.body["model"])).toEqual([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING]);
  });

  it("reports usage as estimated when the provider returned none", async () => {
    server.chat = () => ({ body: completion({ content: "twelve chars", usage: null }) });
    const { c } = client();
    const r = await c.complete(request({ user: "x".repeat(40) }));
    expect(r.usage.measured).toBe(false);
    expect(r.usage.promptTokens).toBeGreaterThan(0);
    expect(r.usage.completionTokens).toBe(3);
  });

  it("returns the answer without the reasoning a template left in content", async () => {
    server.chat = () => ({ body: completion({ content: "<think>hmm</think>The answer." }) });
    expect((await client().c.complete(request())).text).toBe("The answer.");
  });

  it("reads content delivered as parts", async () => {
    server.chat = () => ({ body: { ...completion({ content: "" }), choices: [{ message: { role: "assistant", content: [{ type: "text", text: "par" }, { type: "text", text: "ts" }] }, finish_reason: "stop" }] } });
    expect((await client().c.complete(request())).text).toBe("parts");
  });

  it("honours a per-role override of the model", async () => {
    const roles = new RoleMap().withOverrides({ reporter: { model: NEMOTRON_ULTRA, fallbacks: [NEMOTRON_LIGHTNING] } });
    await client({ roles }).c.complete(request({ role: "reporter" }));
    expect(server.chatRequests[0]!.body["model"]).toBe(NEMOTRON_ULTRA);
  });

  it("requires a key", () => {
    expect(() => new NvidiaClient({ apiKey: "", trace: harness().trace, egress: harness().egress })).toThrowError(/API key/);
  });
});

describe("request validation", () => {
  it("rejects an unknown role with INVALID and sends nothing", async () => {
    const e = await failure(client().c.complete(request({ role: "oracle" })));
    expect(e.failure).toBe("INVALID");
    expect(server.chatRequests).toHaveLength(0);
  });

  it("rejects a prompt of 32 KB or more with a message that tells the caller to chunk", async () => {
    const { c } = client();
    const e = await failure(c.complete(request({ user: "a".repeat(MAX_PROMPT_BYTES) })));
    expect(e.failure).toBe("INVALID");
    expect(e.message).toMatch(/32 KB/);
    expect(e.message).toMatch(/chunk/i);
    expect(server.chatRequests).toHaveLength(0);
    // just under the cap goes through
    await c.complete(request({ user: "a".repeat(MAX_PROMPT_BYTES - 2000) }));
    expect(server.chatRequests).toHaveLength(1);
  });

  it("counts bytes, not characters, against the cap", async () => {
    const e = await failure(client().c.complete(request({ user: "é".repeat(MAX_PROMPT_BYTES / 2) })));
    expect(e.failure).toBe("INVALID");
  });

  it("counts the schema instruction against the cap", async () => {
    const schema = { type: "object", description: "d".repeat(MAX_PROMPT_BYTES) };
    const e = await failure(client().c.complete(request({ jsonSchema: schema })));
    expect(e.failure).toBe("INVALID");
  });

  it("rejects an empty user message, a bad scope, a reused scope and a silly maxTokens", async () => {
    const { c } = client();
    expect((await failure(c.complete(request({ user: "  " })))).failure).toBe("INVALID");
    expect((await failure(c.complete(request({ memoryScope: "has space" })))).failure).toBe("INVALID");
    expect((await failure(c.complete(request({ maxTokens: 3 })))).failure).toBe("INVALID");
    const same = request();
    await c.complete(same);
    const e = await failure(c.complete({ ...same }));
    expect(e.failure).toBe("INVALID");
    expect(e.message).toMatch(/already used/);
  });

  it("rejects a schema that is not a schema before any network call", async () => {
    const e = await failure(client().c.complete(request({ jsonSchema: { type: "nonsense" } })));
    expect(e.failure).toBe("INVALID");
    expect(server.chatRequests).toHaveLength(0);
  });
});

describe("retry, backoff and limits", () => {
  it("retries a 429 and a 503 with capped, jittered, growing waits, then succeeds", async () => {
    server.chat = (_r, n) => (n === 1 ? { status: 429, body: {} } : n === 2 ? { status: 503, body: {} } : { body: completion({ content: "finally" }) });
    const { c, sleeps } = client();
    const r = await c.complete(request());
    expect(r.text).toBe("finally");
    expect(server.chatRequests).toHaveLength(3);
    expect(sleeps).toEqual([750, 1500]); // ceiling 1000 then 2000, jitter 0.5 -> 75% of the ceiling
  });

  it("caps the wait", async () => {
    server.chat = () => ({ status: 500, body: {} });
    const roles = new RoleMap().withOverrides({ planner: { model: NEMOTRON_LIGHTNING, fallbacks: [] } });
    const { c, sleeps } = client({ roles, transport: { maxAttempts: 8, backoffBaseMs: 10_000, backoffCapMs: 15_000 } });
    await failure(c.complete(request()));
    expect(Math.max(...sleeps)).toBeLessThanOrEqual(15_000);
    expect(sleeps.length).toBe(7);
  });

  it("honours Retry-After when it is longer than the backoff, up to the cap", async () => {
    server.chat = (_r, n) => (n === 1 ? { status: 429, body: {}, headers: { "retry-after": "7" } } : { body: completion({ content: "ok" }) });
    const { c, sleeps } = client();
    await c.complete(request());
    expect(sleeps).toEqual([7000]);
  });

  it("stops at the attempt limit and reports UNAVAILABLE with the count", async () => {
    server.chat = () => ({ status: 502, body: {} });
    const { c } = client({ transport: { maxAttempts: 3 } });
    const e = await failure(c.complete(request({ role: "reporter" })));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(e.detail).toMatchObject({ attempts: 3, status: 502 });
    // the reporter falls back to Ultra, which also fails: 3 attempts each
    expect(server.chatRequests).toHaveLength(6);
  });

  it("does not retry a client error", async () => {
    server.chat = () => ({ status: 400, body: { error: { message: "bad parameter" } } });
    const e = await failure(client().c.complete(request()));
    expect(e).toMatchObject({ failure: "INVALID" });
    expect(e.message).toContain("bad parameter");
    expect(server.chatRequests).toHaveLength(1);
  });

  it("maps 401 and 403 to FORBIDDEN without retrying, and never echoes the key", async () => {
    server.chat = () => ({ status: 401, body: { detail: "Invalid key test-key-0123456789" } });
    const e = await failure(client().c.complete(request()));
    expect(e.failure).toBe("FORBIDDEN");
    expect(e.message).not.toContain("test-key-0123456789");
    expect(server.chatRequests).toHaveLength(1);
  });

  it("scrubs the key from an error body", async () => {
    server.chat = () => ({ status: 400, body: { error: { message: "bad key test-key-0123456789 sent" } } });
    const e = await failure(client().c.complete(request()));
    expect(e.message).not.toContain("test-key-0123456789");
    expect(e.message).toContain("[KEY]");
  });

  it("treats a timeout as retryable and then UNAVAILABLE", async () => {
    server.chat = () => ({ hang: true });
    const { c } = client({ transport: { maxAttempts: 2 }, roles: new RoleMap().withOverrides({ planner: { model: NEMOTRON_LIGHTNING, fallbacks: [] } }) });
    const e = await failure(c.complete(request({ timeoutMs: 80 })));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(e.detail).toMatchObject({ timeout: true, attempts: 2 });
    expect(server.chatRequests).toHaveLength(2);
  });

  it("gives up when the total deadline passes, whatever the attempt limit", async () => {
    let t = 0;
    server.chat = () => ({ status: 503, body: {} });
    const { c } = client({
      transport: { maxAttempts: 10, deadlineMs: 1500, now: () => (t += 400), backoffBaseMs: 1000 },
      roles: new RoleMap().withOverrides({ planner: { model: NEMOTRON_LIGHTNING, fallbacks: [] } }),
    });
    const e = await failure(c.complete(request()));
    expect(e.failure).toBe("UNAVAILABLE");
    expect(server.chatRequests.length).toBeLessThan(10);
  });

  it("limits concurrent calls", async () => {
    let active = 0;
    let peak = 0;
    server.chat = async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 40));
      active -= 1;
      return { body: completion({ content: "ok" }) };
    };
    const { c } = client({ transport: { maxConcurrent: 2 } });
    await Promise.all(Array.from({ length: 6 }, () => c.complete(request())));
    expect(peak).toBe(2);
  });
});

describe("cancellation", () => {
  it("cancels a call in flight, and says it was cancelled", async () => {
    server.chat = () => ({ hang: true });
    const { c } = client();
    const ac = new AbortController();
    const p = failure(c.complete({ ...request(), signal: ac.signal }));
    setTimeout(() => ac.abort(), 50);
    const e = await p;
    expect(e).toMatchObject({ failure: "UNAVAILABLE", detail: { cancelled: true } });
    expect(server.chatRequests).toHaveLength(1);
  });

  it("cancels during a backoff wait without making another attempt", async () => {
    server.chat = () => ({ status: 503, body: {} });
    const ac = new AbortController();
    const { c } = client({ transport: { sleep: (_ms: number, signal?: AbortSignal) => new Promise((_res, rej) => { setTimeout(() => ac.abort(), 10); signal?.addEventListener("abort", () => rej(signal.reason)); }) } });
    const e = await failure(c.complete({ ...request(), signal: ac.signal }));
    expect(e.detail).toMatchObject({ cancelled: true });
    expect(server.chatRequests).toHaveLength(1);
  });

  it("a client-level signal cancels every call", async () => {
    const ac = new AbortController();
    ac.abort();
    const e = await failure(client({ signal: ac.signal }).c.complete(request()));
    expect(e.detail).toMatchObject({ cancelled: true });
    expect(server.chatRequests).toHaveLength(0);
  });

  it("does not fall back to another model after a cancellation", async () => {
    server.chat = () => ({ hang: true });
    const { c } = client();
    const ac = new AbortController();
    const p = failure(c.complete({ ...request({ role: "critic" }), signal: ac.signal }));
    setTimeout(() => ac.abort(), 40);
    await p;
    expect(server.chatRequests).toHaveLength(1);
  });
});

describe("what the endpoint can do wrong", () => {
  it("a 200 that is not JSON is DRIFTED, not retried", async () => {
    server.chat = () => ({ rawBody: "<html>proxy page</html>", headers: { "content-type": "text/html" } });
    const e = await failure(client().c.complete(request()));
    expect(e.failure).toBe("DRIFTED");
    expect(server.chatRequests).toHaveLength(1);
  });
  it("a 200 without choices is DRIFTED", async () => {
    server.chat = () => ({ body: { id: "x", object: "chat.completion" } });
    expect((await failure(client().c.complete(request()))).failure).toBe("DRIFTED");
  });
  it("an empty reply is retried, and succeeds on the next try", async () => {
    server.chat = (_r, n) => ({ body: completion({ content: n === 1 ? "" : "second time" }) });
    const r = await client().c.complete(request());
    expect(r.text).toBe("second time");
    expect(server.chatRequests).toHaveLength(2);
  });
  it("a reply that holds only reasoning is TRUNCATED, not retried", async () => {
    server.chat = () => ({ body: completion({ content: null, reasoning: "thinking...", finish: "length" }) });
    const e = await failure(client().c.complete(request()));
    expect(e.failure).toBe("TRUNCATED");
    expect(server.chatRequests).toHaveLength(1);
  });
  it("a reply cut off at maxTokens is TRUNCATED, never returned as an answer", async () => {
    server.chat = () => ({ body: completion({ content: "The study found that", finish: "length" }) });
    const e = await failure(client().c.complete(request({ maxTokens: 64 })));
    expect(e.failure).toBe("TRUNCATED");
    expect(e.message).toMatch(/maxTokens/);
  });
  it("a redirect is refused so the key is never forwarded", async () => {
    server.chat = () => ({ status: 302, headers: { location: "http://example.invalid/steal" }, body: {} });
    const e = await failure(client().c.complete(request()));
    expect(e.failure).toBe("REFUSED");
    expect(server.chatRequests).toHaveLength(1);
  });
  it("an endpoint that is not https and not loopback is refused at construction", () => {
    const h = harness();
    expect(() => new NvidiaClient({ baseUrl: "http://example.com/v1", apiKey: "test-key-0123456789", trace: h.trace, egress: h.egress })).toThrowError(/refused/);
    expect(() => new NvidiaClient({ baseUrl: "https://user:pw@example.com/v1", apiKey: "test-key-0123456789", trace: h.trace, egress: h.egress })).toThrowError(/credentials/);
  });
});

describe("fallback and health", () => {
  it("falls back to the next model when the first is unavailable, and records which answered", async () => {
    server.chat = (r) => (r.body["model"] === NEMOTRON_ULTRA ? { status: 503, body: {} } : { body: completion({ content: "from lightning", model: NEMOTRON_LIGHTNING }) });
    const { c, trace } = client({ transport: { maxAttempts: 2 } });
    const r = await c.complete(request({ role: "critic" }));
    expect(r).toMatchObject({ text: "from lightning", requestedModel: NEMOTRON_LIGHTNING });
    expect(trace.of("model.fallback")).toHaveLength(1);
    expect(trace.of("model.fallback")[0]).toMatchObject({ from: NEMOTRON_ULTRA, to: NEMOTRON_LIGHTNING });
  });

  it("does not fall back for a request the model cannot satisfy", async () => {
    server.chat = () => ({ status: 400, body: { error: "bad" } });
    const { c } = client();
    await failure(c.complete(request({ role: "critic" })));
    expect(server.chatRequests).toHaveLength(1);
  });

  it("remembers a model the endpoint disowns (404) and skips it within the run", async () => {
    server.chat = (r) => (r.body["model"] === NEMOTRON_ULTRA ? { status: 404, body: { error: { message: "not an enabled model" } } } : { body: completion({ content: "ok" }) });
    const { c } = client();
    await c.complete(request({ role: "critic" }));
    await c.complete(request({ role: "critic" }));
    const models = server.chatRequests.map((r) => r.body["model"]);
    expect(models).toEqual([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING, NEMOTRON_LIGHTNING]);
  });

  it("opens the breaker after repeated failures and sends later calls to the fallback first", async () => {
    server.chat = (r) => (r.body["model"] === NEMOTRON_ULTRA ? { status: 503, body: {} } : { body: completion({ content: "ok" }) });
    const { c } = client({ transport: { maxAttempts: 1 } });
    for (let i = 0; i < 4; i += 1) await c.complete(request({ role: "critic" }));
    const models = server.chatRequests.map((r) => r.body["model"]);
    expect(models.slice(0, 6)).toEqual([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING, NEMOTRON_ULTRA, NEMOTRON_LIGHTNING, NEMOTRON_ULTRA, NEMOTRON_LIGHTNING]);
    expect(models.slice(6)).toEqual([NEMOTRON_LIGHTNING]); // third failure opened the breaker
  });

  it("re-probes the model list at the start of a run, records it, and skips a model the list omits", async () => {
    server.models = [NEMOTRON_LIGHTNING];
    const { c, trace } = client();
    const snap = await c.beginRun();
    expect(snap.status).toBe("ok");
    expect(snap.listed).toEqual([NEMOTRON_LIGHTNING]);
    expect(snap.roles["critic"]).toMatchObject({ model: NEMOTRON_LIGHTNING });
    expect(snap.roles["critic"]!.chain).toEqual([{ model: NEMOTRON_ULTRA, listed: false }, { model: NEMOTRON_LIGHTNING, listed: true }]);
    expect(trace.of("model.availability")).toHaveLength(1);
    await c.complete(request({ role: "critic" }));
    expect(server.chatRequests.map((r) => r.body["model"])).toEqual([NEMOTRON_LIGHTNING]);
    expect(c.availability()).toBe(snap);
  });

  it("an unreadable model list is recorded as failed and does not block calls", async () => {
    server.modelsStatus = 500;
    const { c, trace } = client();
    const snap = await c.beginRun();
    expect(snap.status).toBe("failed");
    expect(snap.error).toMatch(/500/);
    expect(trace.of("model.availability")[0]).toMatchObject({ status: "failed" });
    await c.complete(request({ role: "critic" }));
    expect(server.chatRequests.map((r) => r.body["model"])).toEqual([NEMOTRON_ULTRA]);
  });

  it("a new run clears the failure memory", async () => {
    server.chat = (r) => (r.body["model"] === NEMOTRON_ULTRA ? { status: 404, body: { error: "gone" } } : { body: completion({ content: "ok" }) });
    const { c } = client();
    await c.complete(request({ role: "critic" }));
    server.chat = () => ({ body: completion({ content: "ok" }) });
    await c.beginRun();
    server.requests.length = 0;
    await c.complete(request({ role: "critic" }));
    expect(server.chatRequests[0]!.body["model"]).toBe(NEMOTRON_ULTRA);
  });
});

describe("structured output", () => {
  const schema = { type: "object", properties: { verdict: { type: "string", enum: ["match", "no_match"] }, fields: { type: "array", items: { type: "string" } } }, required: ["verdict", "fields"], additionalProperties: false };

  it("asks for JSON, puts the schema in the system prompt, and returns the validated object", async () => {
    server.chat = () => ({ body: completion({ content: '{"verdict":"match","fields":["name","version"]}' }) });
    const r = await client().c.complete(request({ role: "resolver", system: "Adjudicate.", jsonSchema: schema }));
    expect(r.json).toEqual({ verdict: "match", fields: ["name", "version"] });
    expect(r.text).toBe('{"verdict":"match","fields":["name","version"]}');
    const sent = server.chatRequests[0]!.body as { messages: { content: string }[]; response_format: unknown };
    expect(sent.response_format).toEqual({ type: "json_object" });
    expect(sent.messages[0]!.content).toContain("Adjudicate.");
    expect(sent.messages[0]!.content).toContain('"verdict"');
  });

  it("strips reasoning and a code fence before validating", async () => {
    server.chat = () => ({ body: completion({ content: '<think>consider</think>\n```json\n{"verdict":"no_match","fields":[]}\n```' }) });
    expect((await client().c.complete(request({ jsonSchema: schema }))).json).toEqual({ verdict: "no_match", fields: [] });
  });

  it("makes one repair call that carries the validation error, then accepts the corrected reply", async () => {
    server.chat = (_r, n) => ({ body: completion({ content: n === 1 ? '{"verdict":"maybe","fields":[]}' : '{"verdict":"match","fields":["a"]}', usage: { prompt_tokens: 100 * n, completion_tokens: 5, total_tokens: 100 * n + 5 } }) });
    const { c, trace } = client();
    const r = await c.complete(request({ jsonSchema: schema }));
    expect(r.json).toEqual({ verdict: "match", fields: ["a"] });
    expect(server.chatRequests).toHaveLength(2);
    const second = server.chatRequests[1]!.body["messages"] as { role: string; content: string }[];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(second[3]!.content).toMatch(/verdict/);
    expect(second[3]!.content).toMatch(/not accepted/);
    expect(r.usage).toEqual({ promptTokens: 300, completionTokens: 10, measured: true });
    expect(trace.of("model.call")[0]).toMatchObject({ repaired: true, attempts: 2 });
  });

  it("fails with INVALID after the one repair, and never returns a partial object", async () => {
    server.chat = () => ({ body: completion({ content: '{"verdict":"match"}' }) });
    const e = await failure(client().c.complete(request({ jsonSchema: schema })));
    expect(e.failure).toBe("INVALID");
    expect(e.message).toMatch(/after one repair/);
    expect(server.chatRequests).toHaveLength(2);
    expect(e.detail).toHaveProperty("lastReplyHash");
    expect(JSON.stringify(e.detail)).not.toContain("match");
  });

  it("does not repair a truncated reply: that is TRUNCATED", async () => {
    server.chat = () => ({ body: completion({ content: '{"verdict":"mat', finish: "length" }) });
    const e = await failure(client().c.complete(request({ jsonSchema: schema })));
    expect(e.failure).toBe("TRUNCATED");
    expect(server.chatRequests).toHaveLength(1);
  });

  it("drops the echo of its own reply from the repair when that would breach the cap", async () => {
    server.chat = (_r, n) => ({ body: completion({ content: n === 1 ? `{"verdict":"x","pad":"${"p".repeat(6000)}"}` : '{"verdict":"match","fields":[]}' }) });
    const r = await client().c.complete(request({ user: "u".repeat(MAX_PROMPT_BYTES - 3500), jsonSchema: schema }));
    expect(r.json).toEqual({ verdict: "match", fields: [] });
    const second = server.chatRequests[1]!.body["messages"] as { role: string }[];
    expect(second.map((m) => m.role)).toEqual(["system", "user", "user"]);
  });

  it("a reply with two separate objects is rejected, not guessed", async () => {
    server.chat = () => ({ body: completion({ content: '{"verdict":"match","fields":[]} {"verdict":"no_match","fields":[]}' }) });
    const e = await failure(client().c.complete(request({ jsonSchema: schema })));
    expect(e.failure).toBe("INVALID");
  });
});

describe("egress, in the client", () => {
  it("refuses phi before any network call and logs the decision", async () => {
    const { c, trace } = client();
    const e = await failure(c.complete(request({ dataClass: "phi" })));
    expect(e).toMatchObject({ failure: "REFUSED", detail: { basis: "phi-refused" } });
    expect(server.chatRequests).toHaveLength(0);
    expect(trace.of("egress.decision")[0]).toMatchObject({ allowed: false, basis: "phi-refused" });
  });

  it("refuses vendor-confidential content for the remote lane without a consent, and sends it with one", async () => {
    const { c, consents } = client();
    const e = await failure(c.complete(request({ dataClass: "vendor-confidential" })));
    expect(e).toMatchObject({ failure: "REFUSED", detail: { basis: "no-consent" } });
    expect(server.chatRequests).toHaveLength(0);
    const g = consents.grant({ subject: "case:K1", grantedBy: "Dr Okafor", reason: "pilot", ttlMs: 60_000 });
    await c.complete(request({ dataClass: "vendor-confidential", consentToken: g.id, consentSubject: "case:K1" }));
    expect(server.chatRequests).toHaveLength(1);
    expect(consents.uses(g.id)).toHaveLength(1);
  });

  it("refuses a prompt holding a forbidden value, and the value never reaches the prompt log", async () => {
    const { c, forbidden, promptLog } = client();
    forbidden.add("Fabrikam-Rebate-Schedule-77", "masked-rebate");
    const e = await failure(c.complete(request({ user: "Rebate is Fabrikam-Rebate-Schedule-77." })));
    expect(e.detail).toMatchObject({ basis: "forbidden-value", hits: ["masked-rebate"] });
    expect(server.chatRequests).toHaveLength(0);
    expect(JSON.stringify(promptLog.entries)).not.toContain("Fabrikam");
    expect(promptLog.entries[0]).toMatchObject({ outcome: "refused" });
  });

  it("logs what was sent for a public prompt, masked", async () => {
    const { c, promptLog } = client();
    await c.complete(request({ user: "Describe device K123456." }));
    expect(promptLog.entries).toHaveLength(1);
    expect(promptLog.entries[0]).toMatchObject({ outcome: "sent", dataClass: "public", user: "Describe device K123456." });
  });

  it("the local model is never used by the remote client", async () => {
    await client().c.complete(request());
    expect(server.chatRequests.map((r) => r.body["model"])).not.toContain(LOCAL_LIGHTNING);
  });
});

describe("trace", () => {
  it("records one call event with the prompt key, models, usage and timing, and no text", async () => {
    server.chat = () => ({ body: completion({ content: "TEXT-NOT-IN-TRACE" }) });
    const { c, trace } = client();
    await c.complete(request({ user: "PROMPT-NOT-IN-TRACE" }));
    const call = trace.of("model.call")[0]!;
    expect(call).toMatchObject({ provider: "nvidia", role: "planner", model: NEMOTRON_LIGHTNING, repaired: false, structured: false, usageMeasured: true });
    expect(call["promptKey"]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(trace.events)).not.toContain("NOT-IN-TRACE");
  });
});
