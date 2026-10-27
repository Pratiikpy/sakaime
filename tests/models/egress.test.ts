import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConsentLedger, EgressPolicy, EgressRouter, ForbiddenValues, PromptLog, scanForPhi } from "../../src/models/egress.ts";
import { MemoryTraceSink } from "../../src/models/trace.ts";
import type { LaneDescriptor, SakaimeModelRequest } from "../../src/models/types.ts";
import { PortError, type ModelPort, type ModelResponse } from "../../src/ports/index.ts";
import { request } from "./helpers/build.ts";

const REMOTE: LaneDescriptor = { id: "nvidia:remote", location: "remote", destination: "integrate.api.nvidia.com", verified: false };
const LOCAL: LaneDescriptor = { id: "nightshift:local", location: "local", destination: "this machine", verified: false };

function setup(now?: () => Date) {
  const trace = new MemoryTraceSink();
  const consents = new ConsentLedger(now ? { now } : {});
  const forbidden = new ForbiddenValues();
  const policy = new EgressPolicy({ consents, trace, forbidden });
  const ask = (lane: LaneDescriptor, dataClass: string, extra: Partial<Parameters<EgressPolicy["authorize"]>[0]> = {}) =>
    policy.authorize({ lane, dataClass, role: "extractor", system: "sys", user: "A plain sentence about a device.", requestHash: "h".repeat(64), ...extra });
  return { trace, consents, forbidden, policy, ask };
}

const tmp: string[] = [];
afterEach(() => {
  while (tmp.length) rmSync(tmp.pop() as string, { recursive: true, force: true });
});
const tmpDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), "sakaime-egress-"));
  tmp.push(d);
  return d;
};

describe("the egress decision matrix (C-14, D-019)", () => {
  it("public: allowed on a remote lane and on a local lane", () => {
    const { ask } = setup();
    expect(ask(REMOTE, "public")).toMatchObject({ allowed: true, basis: "public-class" });
    expect(ask(LOCAL, "public")).toMatchObject({ allowed: true, basis: "public-class" });
  });

  it("phi: refused on every lane, with or without a consent token", () => {
    const { ask, consents } = setup();
    const grant = consents.grant({ subject: "*", grantedBy: "reviewer", reason: "test", ttlMs: 60_000 });
    for (const lane of [REMOTE, LOCAL]) {
      expect(ask(lane, "phi")).toMatchObject({ allowed: false, basis: "phi-refused" });
      expect(ask(lane, "phi", { consentToken: grant.id, consentSubject: "case:1" })).toMatchObject({ allowed: false, basis: "phi-refused" });
    }
  });

  it("vendor-confidential: refused on a remote lane without a consent", () => {
    const { ask } = setup();
    const d = ask(REMOTE, "vendor-confidential");
    expect(d).toMatchObject({ allowed: false, basis: "no-consent" });
    expect(d.reason).toMatch(/no consent token/);
  });

  it("vendor-confidential: allowed on a local lane, and says whether the lane has been verified", () => {
    const { ask } = setup();
    expect(ask(LOCAL, "vendor-confidential")).toMatchObject({ allowed: true, basis: "local-lane" });
    expect(ask(LOCAL, "vendor-confidential").reason).toMatch(/not yet been verified/);
    expect(ask({ ...LOCAL, verified: true }, "vendor-confidential").reason).not.toMatch(/not yet/);
  });

  it("vendor-confidential: allowed on a remote lane with a recorded consent that names the case and the destination", () => {
    const { ask, consents } = setup();
    const grant = consents.grant({ subject: "case:K123456", destinations: ["integrate.api.nvidia.com"], grantedBy: "Dr Okafor", reason: "pilot review", ttlMs: 60_000 });
    const d = ask(REMOTE, "vendor-confidential", { consentToken: grant.id, consentSubject: "case:K123456" });
    expect(d).toMatchObject({ allowed: true, basis: "consent", consentId: grant.id });
    expect(consents.uses(grant.id)).toHaveLength(1);
    expect(consents.uses(grant.id)[0]).toMatchObject({ role: "extractor", destination: "integrate.api.nvidia.com" });
  });

  it("vendor-confidential: a consent for another case, another destination, an unknown token, a revoked or expired one all fail", () => {
    let now = new Date("2026-10-27T10:00:00Z");
    const { ask, consents } = setup(() => now);
    const g = consents.grant({ subject: "case:A", destinations: ["integrate.api.nvidia.com"], grantedBy: "x", reason: "y", ttlMs: 60_000 });
    expect(ask(REMOTE, "vendor-confidential", { consentToken: g.id, consentSubject: "case:B" }).reason).toMatch(/covers case:A, not case:B/);
    expect(ask({ ...REMOTE, destination: "elsewhere.example" }, "vendor-confidential", { consentToken: g.id, consentSubject: "case:A" }).reason).toMatch(/destination/);
    expect(ask(REMOTE, "vendor-confidential", { consentToken: "consent_made_up", consentSubject: "case:A" }).reason).toMatch(/not in the ledger/);
    expect(ask(REMOTE, "vendor-confidential", { consentToken: g.id, consentSubject: "case:A" }).allowed).toBe(true);
    expect(consents.revoke(g.id, "reviewer")).toBe(true);
    expect(ask(REMOTE, "vendor-confidential", { consentToken: g.id, consentSubject: "case:A" }).reason).toMatch(/revoked/);
    const g2 = consents.grant({ subject: "case:A", grantedBy: "x", reason: "y", ttlMs: 1000 });
    now = new Date(now.getTime() + 5000);
    expect(ask(REMOTE, "vendor-confidential", { consentToken: g2.id, consentSubject: "case:A" }).reason).toMatch(/expired/);
  });

  it("an undeclared or invented class is treated as the most restricted", () => {
    const { ask } = setup();
    expect(ask(REMOTE, "internal")).toMatchObject({ allowed: false, basis: "unknown-class" });
    expect(ask(REMOTE, undefined as unknown as string)).toMatchObject({ allowed: false, basis: "unknown-class" });
  });

  it("a forbidden value in the prompt is refused on every lane, even when public, and only its label is reported", () => {
    const { ask, forbidden } = setup();
    forbidden.add("Acme-Secret-Price-4821", "masked-price");
    for (const lane of [REMOTE, LOCAL]) {
      const d = ask(lane, "public", { user: "The list price is acme-secret-price-4821 per unit." });
      expect(d).toMatchObject({ allowed: false, basis: "forbidden-value", hits: ["masked-price"] });
      expect(JSON.stringify(d)).not.toContain("4821");
    }
  });

  it("a credential in the prompt is refused", () => {
    const { ask } = setup();
    expect(ask(REMOTE, "public", { user: "use key nvapi-AbCdEfGhIjKlMnOpQrStUvWx to call" })).toMatchObject({ allowed: false, basis: "forbidden-value", hits: ["nvidia-api-key"] });
    expect(ask(REMOTE, "public", { user: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123" }).allowed).toBe(false);
  });

  it("a patient-identifier shape in a prompt declared public is refused as a backstop", () => {
    const { ask } = setup();
    expect(ask(REMOTE, "public", { user: "Patient SSN 123-45-6789 was enrolled." })).toMatchObject({ allowed: false, basis: "phi-pattern" });
    expect(ask(REMOTE, "vendor-confidential", { user: "MRN: 00123456 had a scan." })).toMatchObject({ allowed: false, basis: "phi-pattern" });
    expect(ask(REMOTE, "public", { user: "DOB: 1970-01-02" })).toMatchObject({ allowed: false, basis: "phi-pattern" });
    expect(scanForPhi("Studies reported in 2024-2025 with n=1,204 and a PPV of 12-34-5678? no")).toEqual([]);
  });

  it("logs every decision, allowed or refused, with its basis and never the prompt text", () => {
    const { ask, trace } = setup();
    ask(REMOTE, "public", { user: "SECRET-LOOKING-TEXT-ABC" });
    ask(REMOTE, "phi", { user: "SECRET-LOOKING-TEXT-ABC" });
    ask(REMOTE, "vendor-confidential", { user: "SECRET-LOOKING-TEXT-ABC" });
    const events = trace.of("egress.decision");
    expect(events.map((e) => [e["allowed"], e["basis"]])).toEqual([
      [true, "public-class"],
      [false, "phi-refused"],
      [false, "no-consent"],
    ]);
    for (const e of events) {
      expect(e).toMatchObject({ role: "extractor", laneId: "nvidia:remote", laneLocation: "remote" });
      expect(JSON.stringify(e)).not.toContain("SECRET-LOOKING");
    }
  });

  it("enforce throws REFUSED with the basis; authorize does not throw", () => {
    const { policy } = setup();
    const input = { lane: REMOTE, dataClass: "phi", role: "r", system: "s", user: "u", requestHash: "h" };
    expect(() => policy.enforce(input)).toThrowError(PortError);
    try {
      policy.enforce(input);
    } catch (e) {
      expect((e as PortError).failure).toBe("REFUSED");
      expect((e as PortError).detail).toMatchObject({ basis: "phi-refused" });
    }
  });
});

describe("the active mode is queryable", () => {
  it("describes lanes, consents and the per-class rules", () => {
    const { policy, consents } = setup();
    policy.registerLane(REMOTE);
    let m = policy.mode();
    expect(m).toMatchObject({ remoteConfigured: true, localConfigured: false, localLaneVerified: false, activeConsents: 0 });
    expect(m.rules["vendor-confidential"]).toMatch(/no local lane is configured/);
    expect(m.rules.phi).toMatch(/every lane/);
    policy.registerLane(LOCAL);
    consents.grant({ subject: "*", grantedBy: "x", reason: "y", ttlMs: 1000 });
    m = policy.mode();
    expect(m).toMatchObject({ localConfigured: true, localLaneVerified: false, activeConsents: 1 });
    expect(m.summary).toMatch(/local lane configured \(NOT VERIFIED\)/);
    policy.markLaneVerified("nightshift:local");
    expect(policy.mode().localLaneVerified).toBe(true);
  });
});

describe("ConsentLedger", () => {
  it("requires a subject, a person, a reason and a positive ttl", () => {
    const { consents } = setup();
    expect(() => consents.grant({ subject: "", grantedBy: "x", reason: "y", ttlMs: 1 })).toThrowError(PortError);
    expect(() => consents.grant({ subject: "s", grantedBy: " ", reason: "y", ttlMs: 1 })).toThrowError(PortError);
    expect(() => consents.grant({ subject: "s", grantedBy: "x", reason: "", ttlMs: 1 })).toThrowError(PortError);
    expect(() => consents.grant({ subject: "s", grantedBy: "x", reason: "y", ttlMs: 0 })).toThrowError(PortError);
  });
  it("persists grants, revocations and uses, and refuses a damaged file", () => {
    const path = join(tmpDir(), "consents.jsonl");
    const a = new ConsentLedger({ path });
    const g = a.grant({ subject: "case:1", grantedBy: "x", reason: "y", ttlMs: 3_600_000 });
    a.recordUse(g.id, { at: "t", role: "critic", requestHash: "h", destination: "d" });
    const b = new ConsentLedger({ path });
    expect(b.check(g.id, { subject: "case:1", destination: "d" }).ok).toBe(true);
    expect(b.uses(g.id)).toHaveLength(1);
    b.revoke(g.id, "reviewer");
    expect(new ConsentLedger({ path }).check(g.id, { subject: "case:1", destination: "d" })).toMatchObject({ ok: false });
    // damage
    appendFileSync(path, "not json\n");
    expect(() => new ConsentLedger({ path })).toThrowError(/not trusted/);
  });
});

describe("prompt log: masked and forbidden values never reach it", () => {
  const SECRET = "Contoso-Price-List-99231";
  it("masks a forbidden value in a public prompt that is logged as sent", () => {
    const forbidden = new ForbiddenValues().add(SECRET, "vendor-price");
    const log = new PromptLog({ forbidden });
    const e = log.record({ role: "extractor", dataClass: "public", system: `Never reveal ${SECRET}.`, user: `Quote: ${SECRET.toUpperCase()} again`, requestHash: "h", outcome: "sent" });
    expect(JSON.stringify(e)).not.toMatch(/Contoso-Price/i);
    expect(e.user).toContain("[MASKED:vendor-price]");
  });
  it("keeps no text at all for a refused request or for a non-public class", () => {
    const forbidden = new ForbiddenValues().add(SECRET, "vendor-price");
    const log = new PromptLog({ forbidden });
    const refused = log.record({ role: "r", dataClass: "public", system: "s", user: SECRET, requestHash: "h", outcome: "refused" });
    const vendor = log.record({ role: "r", dataClass: "vendor-confidential", system: "s", user: "anything", requestHash: "h", outcome: "sent" });
    for (const e of [refused, vendor]) {
      expect(e.system).toBeUndefined();
      expect(e.user).toBeUndefined();
      expect(e.bytes).toBeGreaterThan(0);
    }
  });
  it("masks credentials by shape, and the file on disk holds no secret either", () => {
    const path = join(tmpDir(), "prompts.jsonl");
    const forbidden = new ForbiddenValues().add(SECRET, "vendor-price");
    const log = new PromptLog({ forbidden, path });
    log.record({ role: "r", dataClass: "public", system: "ok", user: "token nvapi-AbCdEfGhIjKlMnOpQrStUvWx and Bearer abcdefghijklmnopqrstuvwxyz0123", requestHash: "h", outcome: "sent" });
    log.record({ role: "r", dataClass: "public", system: "ok", user: `value ${SECRET}`, requestHash: "h2", outcome: "sent" });
    const disk = readFileSync(path, "utf8");
    expect(disk).not.toContain("nvapi-AbCd");
    expect(disk).not.toContain("abcdefghijklmnopqrstuvwxyz0123");
    expect(disk).not.toContain(SECRET);
    expect(disk.match(/\[MASKED:/g)?.length).toBeGreaterThanOrEqual(3);
  });
  it("a value too short to be told from ordinary text is not accepted as forbidden", () => {
    expect(() => new ForbiddenValues().add("abc", "x")).toThrowError(TypeError);
  });
});

class ScriptedPort implements ModelPort {
  readonly seen: SakaimeModelRequest[] = [];
  constructor(private readonly behave: (r: SakaimeModelRequest) => ModelResponse | PortError) {}
  async complete(r: SakaimeModelRequest): Promise<ModelResponse> {
    this.seen.push(r);
    const out = this.behave(r);
    if (out instanceof PortError) throw out;
    return out;
  }
}
const answer = (provider: ModelResponse["provider"] = "nvidia"): ModelResponse => ({ text: "x", requestedModel: "m", routedModel: "m", provider, usage: { measured: false }, recorded: false });

describe("EgressRouter", () => {
  it("sends public to the remote lane and vendor-confidential to the local lane first", async () => {
    const remote = new ScriptedPort(() => answer("nvidia"));
    const local = new ScriptedPort(() => answer("nightshift"));
    const router = new EgressRouter({ policy: setup().policy, trace: new MemoryTraceSink(), remote, local });
    await router.complete(request({ dataClass: "public" }));
    await router.complete(request({ dataClass: "vendor-confidential" }));
    expect(remote.seen).toHaveLength(1);
    expect(local.seen).toHaveLength(1);
  });
  it("falls back to the remote lane for vendor-confidential only after the local lane is unavailable, where the client then demands a consent", async () => {
    const remote = new ScriptedPort(() => new PortError("REFUSED", "no consent"));
    const local = new ScriptedPort(() => new PortError("UNAVAILABLE", "local runtime down"));
    const trace = new MemoryTraceSink();
    const router = new EgressRouter({ policy: setup().policy, trace, remote, local });
    await expect(router.complete(request({ dataClass: "vendor-confidential" }))).rejects.toMatchObject({ failure: "REFUSED" });
    expect(trace.of("egress.route.fallback")).toHaveLength(1);
  });
  it("does not fall back after a refusal or a cancellation", async () => {
    const remote = new ScriptedPort(() => answer());
    const local = new ScriptedPort(() => new PortError("REFUSED", "x"));
    const router = new EgressRouter({ policy: setup().policy, trace: new MemoryTraceSink(), remote, local });
    await expect(router.complete(request({ dataClass: "vendor-confidential" }))).rejects.toMatchObject({ failure: "REFUSED" });
    expect(remote.seen).toHaveLength(0);
    const cancelled = new ScriptedPort(() => new PortError("UNAVAILABLE", "cancelled", { cancelled: true }));
    const r2 = new EgressRouter({ policy: setup().policy, trace: new MemoryTraceSink(), remote: answerPort(), local: cancelled });
    await expect(r2.complete(request({ dataClass: "vendor-confidential" }))).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });
  it("uses the local lane for public when there is no remote lane", async () => {
    const local = new ScriptedPort(() => answer("nightshift"));
    const router = new EgressRouter({ policy: setup().policy, trace: new MemoryTraceSink(), local });
    expect((await router.complete(request())).provider).toBe("nightshift");
  });
  it("needs at least one lane", () => {
    expect(() => new EgressRouter({ policy: setup().policy, trace: new MemoryTraceSink() })).toThrowError(PortError);
  });
});

function answerPort(): ModelPort {
  return new ScriptedPort(() => answer());
}
