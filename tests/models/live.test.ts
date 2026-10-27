import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { NightshiftClient, NIGHTSHIFT_DEFAULT_BASE_URL } from "../../src/models/nightshift.ts";
import { NvidiaClient, NVIDIA_DEFAULT_BASE_URL } from "../../src/models/nvidia.ts";
import { readEnvFile } from "../../src/models/stack.ts";
import { defaultReceiptLogPath, readInstalledKeyId, readInstalledNightshiftVersion, receiptCoverage } from "../../src/models/receipt.ts";
import { MODEL_PROFILES, NEMOTRON_LIGHTNING, NEMOTRON_SUPER_VL, NEMOTRON_ULTRA, RoleMap } from "../../src/models/roles.ts";
import { PortError } from "../../src/ports/index.ts";
import { harness, request } from "./helpers/build.ts";

/*
 * Live checks against the real endpoints. They run only with LIVE=1 and a key, and they skip, saying so, otherwise.
 * Keys are read from the environment, or from this repository's own gitignored .env (names only are ever printed).
 *   LIVE=1 npx vitest run tests/models/live.test.ts
 *   NIGHTSHIFT_API_KEY must also be set to exercise the installed Nightshift (its token is not in .env).
 */

// The repository's .env wins over the shell: a stale NVIDIA_API_KEY in the ambient environment shadowed the hackathon key
// on 2026-10-27 and every chat call came back 403 while the model list (which any key can read) looked fine.
const env = { ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== undefined)), ...readEnvFile(join(process.cwd(), ".env")) } as Record<string, string>;
const live = env["LIVE"] === "1";
const nvidiaKey = env["NVIDIA_API_KEY"];
const nightshiftKey = env["NIGHTSHIFT_API_KEY"];

if (!live) console.info("live.test.ts: SKIPPED. Set LIVE=1 to call the real NVIDIA API and Nightshift.");
else if (!nvidiaKey) console.info("live.test.ts: NVIDIA tests SKIPPED. LIVE=1 is set but NVIDIA_API_KEY is not (environment or .env).");
if (live && !nightshiftKey) console.info("live.test.ts: Nightshift tests SKIPPED. Set NIGHTSHIFT_API_KEY to the installed application's token.");

const latencies: { what: string; ms: number; model: string; via: string }[] = [];
async function timed<T>(what: string, via: string, model: string, fn: () => Promise<T>): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    latencies.push({ what, ms: Date.now() - t0, model, via });
  }
}

const schema = { type: "object", properties: { answer: { type: "string", enum: ["yes", "no"] }, reason: { type: "string", minLength: 3 } }, required: ["answer", "reason"], additionalProperties: false };

describe.skipIf(!live || !nvidiaKey)("live: NVIDIA API", () => {
  const h = harness();
  // Built on first use: describe.skipIf still runs this body to collect the tests, and the empty key in a copy of .env.example would throw here.
  let built: NvidiaClient | undefined;
  const client = (): NvidiaClient => (built ??= new NvidiaClient({ baseUrl: env["NVIDIA_BASE_URL"] ?? NVIDIA_DEFAULT_BASE_URL, apiKey: nvidiaKey as string, trace: h.trace, egress: h.egress, promptLog: h.promptLog }));

  it("lists the models the role map names", async () => {
    const snap = await client().beginRun();
    expect(snap.status).toBe("ok");
    for (const id of [NEMOTRON_LIGHTNING, NEMOTRON_ULTRA, NEMOTRON_SUPER_VL]) expect(snap.listed, `${id} is listed`).toContain(id);
    for (const [role, v] of Object.entries(snap.roles)) expect(v.model, `role ${role} has a listed model`).not.toBeNull();
  }, 60_000);

  it("answers a tiny prompt on Lightning", async () => {
    const r = await timed("tiny", "nvidia", NEMOTRON_LIGHTNING, () => client().complete(request({ role: "extractor", system: "Reply with the single word asked for.", user: "Reply with exactly: ok", maxTokens: 32 })));
    expect(r.text.trim().toLowerCase()).toContain("ok");
    expect(r.provider).toBe("nvidia");
    expect(r.usage.measured).toBe(true);
    expect(r.requestedModel).toBe(NEMOTRON_LIGHTNING);
    expect(r.routedModel).toContain("nemotron");
  }, 150_000);

  it("answers a tiny prompt on Ultra (the critic's model)", async () => {
    const r = await timed("tiny", "nvidia", NEMOTRON_ULTRA, () => client().complete(request({ role: "critic", system: "Reply with the single word asked for.", user: "Reply with exactly: ok", maxTokens: 32 })));
    expect(r.text.trim().toLowerCase()).toContain("ok");
    expect(r.requestedModel).toBe(NEMOTRON_ULTRA);
  }, 240_000);

  it("returns a schema-valid JSON answer", async () => {
    const r = await timed("json", "nvidia", NEMOTRON_LIGHTNING, () =>
      client().complete(request({ role: "extractor", system: "You check statements against a passage.", user: 'Passage: "The device was cleared for adults aged 22 and over." Statement: "The device is cleared for adults." Does the passage support the statement? Answer with a yes or no and a short reason.', jsonSchema: schema, maxTokens: 200 })),
    );
    expect(["yes", "no"]).toContain((r.json as { answer: string }).answer);
    expect(() => JSON.parse(r.text)).not.toThrow();
  }, 150_000);

  it("fails cleanly with a wrong key (FORBIDDEN, and the key is not in the message)", async () => {
    const bad = new NvidiaClient({ baseUrl: env["NVIDIA_BASE_URL"] ?? NVIDIA_DEFAULT_BASE_URL, apiKey: "invalid-key-for-the-test-0000", trace: harness().trace, egress: harness().egress });
    const e = await bad.complete(request()).catch((x) => x as PortError);
    expect(e).toBeInstanceOf(PortError);
    expect((e as PortError).failure).toBe("FORBIDDEN");
    expect((e as PortError).message).not.toContain("invalid-key-for-the-test-0000");
  }, 60_000);

  it("a model that is not served is UNAVAILABLE and is not retried", async () => {
    const roles = new RoleMap().withOverrides({ planner: { model: "nvidia/does-not-exist-0", fallbacks: [] } });
    const c = new NvidiaClient({ baseUrl: env["NVIDIA_BASE_URL"] ?? NVIDIA_DEFAULT_BASE_URL, apiKey: nvidiaKey as string, trace: h.trace, egress: h.egress, roles });
    const e = await c.complete(request({ role: "planner" })).catch((x) => x as PortError);
    expect((e as PortError).failure).toBe("UNAVAILABLE");
    expect((e as PortError).detail).toMatchObject({ modelGone: true });
  }, 60_000);

  it("Super VL answers a small prompt when asked, behind a fallback", async () => {
    const roles = new RoleMap().withOverrides({ planner: { model: NEMOTRON_SUPER_VL, fallbacks: [NEMOTRON_LIGHTNING] } });
    const c = new NvidiaClient({ baseUrl: env["NVIDIA_BASE_URL"] ?? NVIDIA_DEFAULT_BASE_URL, apiKey: nvidiaKey as string, trace: h.trace, egress: h.egress, roles });
    const r = await timed("tiny", "nvidia", NEMOTRON_SUPER_VL, () => c.complete(request({ role: "planner", user: "Reply with exactly: ok", maxTokens: 32 })));
    expect(r.text.toLowerCase()).toContain("ok");
    expect([NEMOTRON_SUPER_VL, NEMOTRON_LIGHTNING]).toContain(r.requestedModel);
    console.info(`live: Super VL request resolved to ${r.requestedModel}`);
  }, 240_000);
});

describe.skipIf(!live || !nightshiftKey)("live: the installed Nightshift", () => {
  const h = harness();
  const logPath = defaultReceiptLogPath(env);
  const keyId = env["NIGHTSHIFT_RECEIPT_KEY_ID"] ?? (logPath ? readInstalledKeyId(logPath) : undefined);
  const make = async () =>
    new NightshiftClient({
      baseUrl: env["NIGHTSHIFT_BASE_URL"] ?? NIGHTSHIFT_DEFAULT_BASE_URL,
      apiKey: nightshiftKey as string,
      trace: h.trace,
      egress: h.egress,
      promptLog: h.promptLog,
      ledger: h.ledger,
      trustedKeyIds: keyId ? [keyId] : [],
      version: (await readInstalledNightshiftVersion()) ?? "unknown",
    });

  it("has an installed key id to pin", () => {
    expect(keyId, "no key id: set NIGHTSHIFT_RECEIPT_KEY_ID or point NIGHTSHIFT_RECEIPT_LOG at the application's receipt log").toMatch(/^[0-9a-f]{16}$/);
  });

  it("serves Lightning and Ultra with receipts that pass every check, hmem 0, distinct ids", async () => {
    const c = await make();
    await c.beginRun();
    const a = await timed("tiny", "nightshift", NEMOTRON_LIGHTNING, () => c.complete(request({ role: "extractor", system: "Reply with the single word asked for.", user: "Reply with exactly: ok", maxTokens: 32 })));
    const b = await timed("tiny", "nightshift", NEMOTRON_ULTRA, () => c.complete(request({ role: "critic", system: "Reply with the single word asked for.", user: "Reply with exactly: ok", maxTokens: 32 })));
    for (const [r, model] of [[a, NEMOTRON_LIGHTNING], [b, NEMOTRON_ULTRA]] as const) {
      expect(r.provider).toBe("nightshift");
      expect(r.receipt?.routedModel).toBe(model);
      expect(r.receipt?.hmem).toBe(0);
      expect(r.receipt?.keyId).toBe(keyId);
      expect(r.text.toLowerCase()).toContain("ok");
    }
    expect(a.receipt!.receiptId).not.toBe(b.receipt!.receiptId);
    const cov = receiptCoverage([{ id: "a", receiptId: a.receipt!.receiptId }, { id: "b", receiptId: b.receipt!.receiptId }], h.ledger);
    expect(cov.share).toBe(1);
    console.info(`live: Nightshift ${a.receipt!.raw["nightshiftVersion"]} receipts ${a.receipt!.receiptId}, ${b.receipt!.receiptId}`);
  }, 300_000);

  it("verifies receipts for a system+user prompt with non-ASCII text, a long prompt and a structured call", async () => {
    const c = await make();
    const long = `Étude: précision d'un dispositif (日本語) 😀.\nSecond line.\n${"The cohort was adults. ".repeat(60)}`;
    const r1 = await c.complete(request({ role: "extractor", system: "Reply briefly.", user: `${long}\nReply with exactly: ok`, maxTokens: 32 }));
    expect(r1.receipt).toBeDefined();
    const r2 = await timed("json", "nightshift", NEMOTRON_LIGHTNING, () => c.complete(request({ role: "extractor", system: "You check statements against a passage.", user: 'Passage: "Cleared for adults aged 22 and over." Statement: "Cleared for adults." Does the passage support the statement?', jsonSchema: schema, maxTokens: 200 })));
    expect(["yes", "no"]).toContain((r2.json as { answer: string }).answer);
    expect(r2.receipt?.routedModel).toBe(NEMOTRON_LIGHTNING);
  }, 300_000);

  it("enters every accepted receipt id in the ledger, so a second presentation of it is a replay", async () => {
    const c = await make();
    const r = await c.complete(request({ role: "extractor", user: "Reply with exactly: ok", maxTokens: 32 }));
    const accepted = h.ledger.get(r.receipt!.receiptId);
    expect(accepted).toBeDefined();
    expect(h.ledger.hasAccepted(r.receipt!.receiptId)).toBe(true);
  }, 120_000);

  it("a model Nightshift has not enabled is UNAVAILABLE", async () => {
    const roles = new RoleMap().withOverrides({ planner: { model: "nvidia/nemotron-nano-3-30b-a3b", fallbacks: [] } });
    const c = new NightshiftClient({ baseUrl: env["NIGHTSHIFT_BASE_URL"] ?? NIGHTSHIFT_DEFAULT_BASE_URL, apiKey: nightshiftKey as string, trace: h.trace, egress: h.egress, ledger: h.ledger, trustedKeyIds: keyId ? [keyId] : [], roles });
    const e = await c.complete(request({ role: "planner" })).catch((x) => x as PortError);
    expect((e as PortError).failure).toBe("UNAVAILABLE");
  }, 60_000);

  it("a wrong token is FORBIDDEN", async () => {
    const c = new NightshiftClient({ baseUrl: env["NIGHTSHIFT_BASE_URL"] ?? NIGHTSHIFT_DEFAULT_BASE_URL, apiKey: "wrong-token-for-the-test-00000", trace: harness().trace, egress: harness().egress, ledger: harness().ledger, trustedKeyIds: keyId ? [keyId] : [] });
    const e = await c.complete(request({ role: "planner" })).catch((x) => x as PortError);
    expect((e as PortError).failure).toBe("FORBIDDEN");
  }, 60_000);
});

describe.skipIf(!live)("live: report", () => {
  it("prints the latencies and the profiles that were exercised", () => {
    if (latencies.length > 0) console.info(`live latencies (ms):\n${latencies.map((l) => `  ${l.via.padEnd(10)} ${l.what.padEnd(6)} ${String(l.ms).padStart(6)}  ${l.model}`).join("\n")}`);
    console.info(`profiles: ${MODEL_PROFILES.map((p) => p.id).join(", ")}`);
    expect(true).toBe(true);
  });
});
