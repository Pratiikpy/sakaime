import { appendFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  ContractExecutor,
  HmacSigner,
  JsonlReplayStore,
  MAX_CHAIN_AGE_MS,
  MemoryReplayStore,
  SAKAIME_REGISTRY_PATH,
  Scout,
  UlidFactory,
  signContract,
  verifyContract,
  type ExecutionContract,
  type ScoutEvent,
} from "../../../src/engines/scout/index.ts";
import { canonicalJson } from "../../../src/util/canonical.ts";

const SECRET = "test-secret-0123456789abcdef-0123456789abcdef";
const T0 = Date.parse("2026-10-27T10:00:00.000Z");
let now = T0;
const clock = (): Date => new Date(now);
const minutes = (n: number): number => n * 60_000;

const reviewer = { id: "rev-1", role: "reviewer", cases: ["CASE-2041"] };

function scout(extra: Partial<ConstructorParameters<typeof Scout>[0]> = {}): Scout {
  return new Scout({ intentRegistry: SAKAIME_REGISTRY_PATH, policyPack: ["default", "adversarial-tight"], secret: SECRET, clock, ...extra });
}

/** A ready, read-only contract (explain_finding needs no approval). */
async function readOnly(s: Scout, userId = "rev-1"): Promise<ExecutionContract> {
  const d = await s.decide({ prompt: "Explain finding F3.", user: { id: userId, role: "reviewer" }, surface: "chat" });
  expect(d.executionContract?.status).toBe("ready");
  return d.executionContract as ExecutionContract;
}

/** An export contract awaiting approval, then the approved one. */
async function exportContracts(s: Scout): Promise<{ pending: ExecutionContract; approved: ExecutionContract }> {
  const d = await s.decide({ prompt: "Export the dossier for CASE-2041.", user: reviewer, surface: "chat", context: { caseId: "CASE-2041" } });
  const pending = d.executionContract as ExecutionContract;
  expect(pending.status).toBe("awaiting-approval");
  const a = s.approve(pending, { kind: "user-confirm", by: reviewer.id, decision: "approve" });
  expect(a.ok).toBe(true);
  return { pending, approved: (a as { contract: ExecutionContract }).contract };
}

beforeEach(() => {
  now = T0;
});

describe("signing and tampering", () => {
  it("a contract verifies as issued", async () => {
    const s = scout();
    const c = await readOnly(s);
    expect(verifyContract(c, { signer: new HmacSigner(SECRET), now: clock() }).ok).toBe(true);
    expect(c.signedBy).toBe("scout");
    expect(c.signature).toMatch(/^[0-9a-f]{64}$/);
  });

  it("any change to a signed field is refused as tampered", async () => {
    const s = scout();
    const c = await readOnly(s);
    const signer = new HmacSigner(SECRET);
    const mutations: ((x: ExecutionContract) => void)[] = [
      (x) => (x.intent.primary.id = "export_dossier"),
      (x) => (x.intent.primary.riskClass = "high"),
      (x) => x.scope.capabilities.push("dossier.export"),
      (x) => (x.scope.user.id = "someone-else"),
      (x) => (x.scope.user.role = "lead_reviewer"),
      (x) => (x.scope.caseId = "CASE-1"),
      (x) => (x.scope.singleUse = !x.scope.singleUse),
      (x) => (x.expiresAt = new Date(T0 + minutes(60)).toISOString()),
      (x) => (x.issuedAt = new Date(T0 + 1000).toISOString()),
      (x) => (x.risk.level = "high"),
      (x) => (x.status = "awaiting-approval"),
      (x) => x.toolPlan.push({ capability: "dossier.export", tool: "dossier.export", input: {} }),
      (x) => (x.registryVersion += 1),
      (x) => (x.policyPackVersion = "default@2"),
      (x) => (x.traceId = "other"),
      (x) => (x.parentId = "01HZZZZZZZZZZZZZZZZZZZZZZZ"),
      (x) => (x.modelProfile.lane = "none"),
    ];
    for (const [i, mutate] of mutations.entries()) {
      const copy = structuredClone(c);
      mutate(copy);
      const r = verifyContract(copy, { signer, now: clock(), allowStatuses: ["ready", "awaiting-approval"] });
      expect(r.ok, `mutation ${i}`).toBe(false);
      if (!r.ok) expect(r.reason, `mutation ${i}`).toBe("tampered");
    }
  });

  it("a signature made with another secret is refused, as is a truncated or non-hex one", async () => {
    const c = await readOnly(scout());
    const forged = signContract({ ...(c as Omit<ExecutionContract, "signature" | "signedBy">) }, new HmacSigner("another-secret-another-secret-12345"));
    expect(verifyContract(forged, { signer: new HmacSigner(SECRET), now: clock() })).toMatchObject({ ok: false, reason: "tampered" });
    for (const sig of [c.signature.slice(0, 63), `${c.signature.slice(0, 63)}g`, c.signature.toUpperCase(), "", " ".repeat(64)]) {
      const r = verifyContract({ ...c, signature: sig }, { signer: new HmacSigner(SECRET), now: clock() });
      expect(r.ok).toBe(false);
    }
  });

  it("a missing signature is 'unsigned', not 'tampered'", async () => {
    const c = await readOnly(scout());
    const { signature: _s, ...rest } = c;
    void _s;
    expect(verifyContract(rest, { signer: new HmacSigner(SECRET), now: clock() })).toMatchObject({ ok: false, reason: "unsigned" });
  });

  it("property: flipping any character of any string field breaks the signature", async () => {
    const c = await readOnly(scout());
    const signer = new HmacSigner(SECRET);
    const paths: string[][] = [["contractId"], ["traceId"], ["intent", "primary", "id"], ["scope", "user", "id"], ["scope", "surface"], ["policyPackVersion"], ["registryHash"], ["issuedAt"]];
    fc.assert(
      fc.property(fc.constantFrom(...paths), fc.nat(), (path, pos) => {
        const copy = structuredClone(c) as unknown as Record<string, unknown>;
        let o = copy;
        for (const k of path.slice(0, -1)) o = o[k] as Record<string, unknown>;
        const key = path[path.length - 1] as string;
        const v = String(o[key]);
        const i = pos % v.length;
        o[key] = `${v.slice(0, i)}${v[i] === "x" ? "y" : "x"}${v.slice(i + 1)}`;
        expect(verifyContract(copy, { signer, now: clock() }).ok).toBe(false);
      }),
      { numRuns: 120 },
    );
  });
});

describe("expiry", () => {
  it("lives five minutes: valid just before, refused at and after", async () => {
    const s = scout();
    const c = await readOnly(s);
    const signer = new HmacSigner(SECRET);
    expect(Date.parse(c.expiresAt) - Date.parse(c.issuedAt)).toBe(minutes(5));
    now = T0 + minutes(5) - 1;
    expect(verifyContract(c, { signer, now: clock() }).ok).toBe(true);
    now = T0 + minutes(5);
    expect(verifyContract(c, { signer, now: clock() })).toMatchObject({ ok: false, reason: "expired" });
    now = T0 + minutes(60);
    expect(verifyContract(c, { signer, now: clock() })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("an executor refuses an expired contract and reports contract.expired", async () => {
    const s = scout();
    const events: ScoutEvent[] = [];
    const exec = s.executor({ telemetry: (e) => events.push(e) });
    const c = await readOnly(s);
    now = T0 + minutes(6);
    expect(exec.redeem(c, { using: ["finding.explain"] })).toMatchObject({ ok: false, reason: "expired" });
    expect(events.map((e) => e.event)).toContain("contract.expired");
  });

  it("Scout will not issue a lifetime beyond five minutes", () => {
    expect(() => scout({ ttlMs: minutes(5) + 1 })).toThrow(RangeError);
    expect(() => scout({ ttlMs: 500 })).toThrow(RangeError);
    expect(() => scout({ ttlMs: minutes(1) })).not.toThrow();
  });

  it("a contract with a forged long lifetime is refused even when correctly signed", async () => {
    const s = scout();
    const c = await readOnly(s);
    const { signature: _s, signedBy: _b, ...body } = c;
    void _s;
    void _b;
    const long = signContract({ ...body, expiresAt: new Date(T0 + minutes(60)).toISOString() }, new HmacSigner(SECRET));
    expect(verifyContract(long, { signer: new HmacSigner(SECRET), now: clock() })).toMatchObject({ ok: false, reason: "ttl-too-long" });
  });

  it("a contract issued in the future is refused beyond a small clock skew", async () => {
    const s = scout();
    const c = await readOnly(s);
    now = T0 - 3_000;
    expect(verifyContract(c, { signer: new HmacSigner(SECRET), now: clock() }).ok).toBe(true);
    now = T0 - 60_000;
    expect(verifyContract(c, { signer: new HmacSigner(SECRET), now: clock() })).toMatchObject({ ok: false, reason: "not-yet-valid" });
  });
});

describe("scope", () => {
  it("an executor may use only the capabilities in the contract", async () => {
    const s = scout();
    const exec = s.executor();
    const c = await readOnly(s);
    expect(exec.redeem(c, { using: ["finding.explain"] }).ok).toBe(true);
    expect(exec.redeem(c, { using: ["finding.explain", "evidence.read"] }).ok).toBe(true);
    for (const escalate of [["dossier.export"], ["source.register"], ["link.confirm"], ["finding.explain", "dossier.build"]]) {
      expect(exec.redeem(c, { using: escalate })).toMatchObject({ ok: false, reason: "scope-mismatch" });
    }
  });

  it("an explain contract cannot be used to export: scope escalation by swapping the intent breaks the signature", async () => {
    const s = scout();
    const c = await readOnly(s);
    const escalated = structuredClone(c);
    escalated.scope.capabilities = ["dossier.build", "dossier.export"];
    expect(s.executor().redeem(escalated, { using: ["dossier.export"] })).toMatchObject({ ok: false, reason: "tampered" });
  });

  it("a contract is bound to the user it was issued to", async () => {
    const s = scout();
    const c = await readOnly(s, "rev-1");
    const exec = s.executor();
    expect(exec.redeem(c, { using: ["finding.explain"], actor: "rev-1" }).ok).toBe(true);
    expect(exec.redeem(c, { using: ["finding.explain"], actor: "rev-2" })).toMatchObject({ ok: false, reason: "actor-mismatch" });
  });

  it("a contract bound to one case cannot touch another", async () => {
    const s = scout();
    const { approved } = await exportContracts(s);
    const exec = s.executor();
    expect(exec.redeem(approved, { using: ["dossier.export"], caseId: "CASE-9999" })).toMatchObject({ ok: false, reason: "case-mismatch" });
    expect(exec.redeem(approved, { using: ["dossier.export"], caseId: "CASE-2041" }).ok).toBe(true);
  });

  it("registry and policy drift are refused", async () => {
    const s = scout();
    const c = await readOnly(s);
    expect(verifyContract(c, { signer: new HmacSigner(SECRET), now: clock(), registryHash: "0".repeat(64) })).toMatchObject({ ok: false, reason: "registry-drift" });
    expect(verifyContract(c, { signer: new HmacSigner(SECRET), now: clock(), policyPackVersion: "default@1" })).toMatchObject({ ok: false, reason: "policy-drift" });
    expect(verifyContract(c, { signer: new HmacSigner(SECRET), now: clock(), registryHash: s.registry.hash, policyPackVersion: s.policyPackVersion }).ok).toBe(true);
  });
});

describe("approval", () => {
  it("a contract that needs approval is not usable until approved", async () => {
    const s = scout();
    const { pending } = await exportContracts(s);
    expect(s.executor().redeem(pending, { using: ["dossier.export"] })).toMatchObject({ ok: false, reason: "not-ready" });
  });

  it("approval returns a new ready contract that points at the one the person was shown", async () => {
    const s = scout();
    const { pending, approved } = await exportContracts(s);
    expect(approved.parentId).toBe(pending.contractId);
    expect(approved.status).toBe("ready");
    expect(approved.contractId).not.toBe(pending.contractId);
    expect(approved.traceId).toBe(pending.traceId);
    expect(approved.risk.approvals).toEqual([expect.objectContaining({ kind: "user-confirm", by: "rev-1", decision: "approve", contractId: pending.contractId })]);
    expect(s.executor().redeem(approved, { using: ["dossier.export"], actor: "rev-1", caseId: "CASE-2041" }).ok).toBe(true);
  });

  it("only the user the contract was issued to can confirm it, and a rejection is not an approval", async () => {
    const s = scout();
    const d = await s.decide({ prompt: "Export the dossier for CASE-2041.", user: reviewer, surface: "chat", context: { caseId: "CASE-2041" } });
    const pending = d.executionContract as ExecutionContract;
    expect(s.approve(pending, { kind: "user-confirm", by: "rev-2", decision: "approve" })).toMatchObject({ ok: false });
    expect(s.approve(pending, { kind: "user-confirm", by: "rev-1", decision: "reject" })).toMatchObject({ ok: false });
  });

  it("an approval cannot be taken from one contract and put on another", async () => {
    const s = scout();
    const a = await exportContracts(s);
    const other = (await s.decide({ prompt: "Export the dossier for CASE-2041.", user: reviewer, surface: "chat", context: { caseId: "CASE-2041" } })).executionContract as ExecutionContract;
    const grafted = structuredClone(other) as ExecutionContract;
    grafted.status = "ready";
    grafted.risk.approvals = a.approved.risk.approvals;
    grafted.parentId = a.pending.contractId;
    expect(s.executor().redeem(grafted, { using: ["dossier.export"] })).toMatchObject({ ok: false, reason: "tampered" });
  });

  it("a high-risk contract signed as ready without an approval is still refused", async () => {
    const s = scout();
    const { pending } = await exportContracts(s);
    const { signature: _s, signedBy: _b, ...body } = pending;
    void _s;
    void _b;
    const noApproval = signContract({ ...body, status: "ready" }, new HmacSigner(SECRET));
    expect(s.executor().redeem(noApproval, { using: ["dossier.export"] })).toMatchObject({ ok: false, reason: "approval-missing" });
  });

  it("approving a contract that has expired, or one that is already ready, fails", async () => {
    const s = scout();
    const d = await s.decide({ prompt: "Export the dossier for CASE-2041.", user: reviewer, surface: "chat", context: { caseId: "CASE-2041" } });
    const pending = d.executionContract as ExecutionContract;
    now = T0 + minutes(6);
    expect(s.approve(pending, { kind: "user-confirm", by: "rev-1", decision: "approve" })).toMatchObject({ ok: false });
    now = T0;
    const ready = await readOnly(s);
    expect(s.approve(ready, { kind: "user-confirm", by: "rev-1", decision: "approve" })).toMatchObject({ ok: false });
  });
});

describe("replay", () => {
  it("a single-use contract is redeemed once", async () => {
    const s = scout();
    const exec = s.executor();
    const { approved } = await exportContracts(s);
    expect(approved.scope.singleUse).toBe(true);
    expect(exec.redeem(approved, { using: ["dossier.export"] }).ok).toBe(true);
    expect(exec.redeem(approved, { using: ["dossier.export"] })).toMatchObject({ ok: false, reason: "replayed" });
    expect(exec.redeem(approved, { using: ["dossier.build"] })).toMatchObject({ ok: false, reason: "replayed" });
  });

  it("a read-only contract may be used again within its lifetime", async () => {
    const s = scout();
    const exec = s.executor();
    const c = await readOnly(s);
    expect(c.scope.singleUse).toBe(false);
    expect(exec.redeem(c, { using: ["finding.explain"] }).ok).toBe(true);
    expect(exec.redeem(c, { using: ["finding.explain"] }).ok).toBe(true);
  });

  it("a refused attempt does not use up a single-use contract", async () => {
    const s = scout();
    const exec = s.executor();
    const { approved } = await exportContracts(s);
    expect(exec.redeem(approved, { using: ["source.register"] })).toMatchObject({ ok: false, reason: "scope-mismatch" });
    expect(exec.redeem(approved, { using: ["dossier.export"] }).ok).toBe(true);
  });

  it("the replay record survives a restart of the executor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-replay-"));
    try {
      const file = join(dir, "redeemed.jsonl");
      const s = scout();
      const { approved } = await exportContracts(s);
      const first = new ContractExecutor({ signer: new HmacSigner(SECRET), clock, replay: new JsonlReplayStore(file, T0), registryHash: s.registry.hash, policyPackVersion: s.policyPackVersion });
      expect(first.redeem(approved, { using: ["dossier.export"] }).ok).toBe(true);
      const second = new ContractExecutor({ signer: new HmacSigner(SECRET), clock, replay: new JsonlReplayStore(file, T0 + 1000), registryHash: s.registry.hash, policyPackVersion: s.policyPackVersion });
      expect(second.redeem(approved, { using: ["dossier.export"] })).toMatchObject({ ok: false, reason: "replayed" });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("the memory store forgets an id once its contract has expired, so it does not grow without bound", () => {
    const store = new MemoryReplayStore();
    expect(store.redeem("a", T0 + 1000, T0)).toBe(true);
    expect(store.redeem("a", T0 + 1000, T0 + 10)).toBe(false);
    expect(store.redeem("b", T0 + 5000, T0 + 2000)).toBe(true);
    expect(store.size).toBe(1);
  });

  it("a corrupt replay file is rebuilt, not trusted", () => {
    const dir = mkdtempSync(join(tmpdir(), "scout-replay-"));
    try {
      const file = join(dir, "redeemed.jsonl");
      const first = new JsonlReplayStore(file, T0);
      first.redeem("x", T0 + 10_000, T0);
      appendFileSync(file, "not json at all\n");
      const second = new JsonlReplayStore(file, T0 + 1);
      expect(second.redeem("x", T0 + 10_000, T0 + 1)).toBe(false);
      expect(second.redeem("y", T0 + 10_000, T0 + 1)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("refresh", () => {
  it("issues a new contract with the old one as parent, the same scope and a fresh lifetime", async () => {
    const s = scout();
    const c = await readOnly(s);
    now = T0 + minutes(4);
    const r = s.refresh(c, { id: "rev-1", role: "reviewer" });
    expect(r.ok).toBe(true);
    const n = (r as { contract: ExecutionContract }).contract;
    expect(n.parentId).toBe(c.contractId);
    expect(n.traceId).toBe(c.traceId);
    expect(n.scope.capabilities).toEqual(c.scope.capabilities);
    expect(Date.parse(n.expiresAt) - Date.parse(n.issuedAt)).toBe(minutes(5));
    expect(n.chainStartedAt).toBe(c.chainStartedAt);
    expect(s.executor().redeem(n, { using: ["finding.explain"] }).ok).toBe(true);
    // the original still expires on its own clock: refreshing never extends it
    now = T0 + minutes(6);
    expect(s.executor().redeem(c, { using: ["finding.explain"] })).toMatchObject({ ok: false, reason: "expired" });
  });

  it("a high-risk contract comes back awaiting approval again", async () => {
    const s = scout();
    const { approved } = await exportContracts(s);
    const r = s.refresh(approved, reviewer);
    expect(r.ok).toBe(true);
    const n = (r as { contract: ExecutionContract }).contract;
    expect(n.status).toBe("awaiting-approval");
    expect(n.risk.approvals).toEqual([]);
  });

  it("refuses a tampered parent, another user, a downgraded role, and a chain that has run its length", async () => {
    const s = scout();
    const c = await readOnly(s);
    const bad = structuredClone(c);
    bad.scope.capabilities.push("dossier.export");
    expect(s.refresh(bad, { id: "rev-1", role: "reviewer" })).toMatchObject({ ok: false });
    expect(s.refresh(c, { id: "rev-2", role: "reviewer" })).toMatchObject({ ok: false });
    // explain_finding lists the viewer role as allowed; export_dossier does not
    const { approved } = await exportContracts(s);
    expect(s.refresh(approved, { id: "rev-1", role: "viewer" })).toMatchObject({ ok: false });
    now = T0 + MAX_CHAIN_AGE_MS + minutes(1);
    expect(s.refresh(c, { id: "rev-1", role: "reviewer" })).toMatchObject({ ok: false });
  });

  it("refuses to refresh a contract that expired long ago", async () => {
    const s = scout();
    const c = await readOnly(s);
    now = T0 + minutes(30);
    expect(s.refresh(c, { id: "rev-1", role: "reviewer" })).toMatchObject({ ok: false });
  });
});

describe("malformed input", () => {
  const exec = (): ContractExecutor => scout().executor();
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "contract"],
    ["a number", 42],
    ["an array", []],
    ["an empty object", {}],
    ["a function", () => 1],
  ])("rejects %s without throwing", (_n, value) => {
    const r = exec().redeem(value, { using: ["finding.explain"] });
    expect(r.ok).toBe(false);
  });

  it("rejects a contract with a missing or mistyped field, non-date times and a non-array scope", async () => {
    const c = await readOnly(scout());
    const variants: Record<string, unknown>[] = [
      { ...c, contractId: 5 },
      { ...c, issuedAt: "not a date" },
      { ...c, expiresAt: 12345 },
      { ...c, scope: { ...c.scope, capabilities: "finding.explain" } },
      { ...c, toolPlan: {} },
      { ...c, signature: ["x"] },
      { ...c, signedBy: "someone" },
    ];
    for (const v of variants) {
      expect(() => exec().redeem(v, { using: ["finding.explain"] })).not.toThrow();
      expect(exec().redeem(v, { using: ["finding.explain"] }).ok).toBe(false);
    }
  });

  it("a canonicalisation failure (NaN) is a refusal, not a crash", async () => {
    const c = await readOnly(scout());
    const v = { ...c, intent: { ...c.intent, confidence: Number.NaN } };
    expect(exec().redeem(v, { using: ["finding.explain"] })).toMatchObject({ ok: false });
  });

  it("property: arbitrary JSON is never accepted and never throws", () => {
    const e = exec();
    fc.assert(fc.property(fc.jsonValue(), (v) => {
      expect(e.redeem(v, { using: ["finding.explain"] }).ok).toBe(false);
    }), { numRuns: 200 });
  });

  it("an injected __proto__ field does not slip past the signature", async () => {
    const c = await readOnly(scout());
    const v = JSON.parse(JSON.stringify(c)) as Record<string, unknown>;
    v.__proto__ = { status: "ready" };
    Object.defineProperty(v, "constructor", { value: "x", enumerable: true });
    expect(exec().redeem(v, { using: ["finding.explain"] }).ok).toBe(false);
  });

  it("a secret shorter than 16 bytes is refused at construction", () => {
    expect(() => new HmacSigner("short")).toThrow(RangeError);
    expect(() => scout({ secret: "short" })).toThrow(RangeError);
  });

  it("telemetry that throws cannot change the outcome", async () => {
    const s = scout();
    const c = await readOnly(s);
    const exec2 = s.executor({ telemetry: () => { throw new Error("sink down"); } });
    expect(exec2.redeem(c, { using: ["finding.explain"] }).ok).toBe(true);
  });
});

describe("ids", () => {
  it("ULIDs sort in issue order even inside one millisecond, and are 26 characters", () => {
    const f = new UlidFactory(() => T0);
    const ids = Array.from({ length: 500 }, () => f.next());
    expect(ids.every((i) => /^[0-9A-HJKMNP-TV-Z]{26}$/.test(i))).toBe(true);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(500);
  });

  it("the canonical form used for signing does not depend on key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

afterAll(() => {
  now = T0;
});
