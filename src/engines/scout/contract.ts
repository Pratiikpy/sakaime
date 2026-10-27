/**
 * Execution contracts.
 *
 * A contract is the only thing an executor accepts. It is signed with HMAC-SHA256 over its canonical JSON,
 * expires five minutes after it is issued (never extended: work that runs longer asks for a new contract with
 * the old one as parentId), lists exactly the capabilities the executor may use, and for a high-risk action
 * carries the approval a person gave. The executor, not Scout, refuses a contract that is unsigned, altered,
 * expired, replayed, out of scope or unapproved.
 *
 * HMAC with a shared secret is an integrity check between modules of one deployment. It does not stop a party
 * who holds the secret; the signer is an interface so a stronger scheme can replace it.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { canonicalJson } from "../../util/canonical.ts";
import type { ApprovalRecord, ExecutionContract, Telemetry } from "./types.ts";

export const CONTRACT_TTL_MS = 5 * 60_000;
export const CLOCK_SKEW_MS = 5_000;
/** A chain of refreshed contracts may not outlive its first link by more than this. */
export const MAX_CHAIN_AGE_MS = 60 * 60_000;

export interface Signer {
  sign(canonical: string): string;
  verify(canonical: string, signature: string): boolean;
}

export class HmacSigner implements Signer {
  private readonly key: Buffer;
  constructor(secret: string | Buffer) {
    this.key = Buffer.from(secret);
    if (this.key.length < 16) throw new RangeError("a contract secret needs at least 16 bytes");
  }
  sign(canonical: string): string {
    return createHmac("sha256", this.key).update(canonical).digest("hex");
  }
  verify(canonical: string, signature: string): boolean {
    if (typeof signature !== "string" || !/^[0-9a-f]{64}$/.test(signature)) return false;
    const want = Buffer.from(this.sign(canonical), "hex");
    const got = Buffer.from(signature, "hex");
    return got.length === want.length && timingSafeEqual(got, want);
  }
}

export const newSecret = (): Buffer => randomBytes(32);

// ---------------------------------------------------------------- ids

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Monotonic ULIDs: ten characters of time, sixteen of randomness; within one millisecond the randomness counts up so ids sort in issue order. */
export class UlidFactory {
  private lastMs = -1;
  private lastRand: number[] = [];
  constructor(
    private readonly clock: () => number,
    private readonly random: () => number[] = () => [...randomBytes(16)].map((b) => b & 31),
  ) {}

  next(): string {
    const ms = Math.max(this.clock(), this.lastMs);
    let rand: number[];
    if (ms === this.lastMs) {
      rand = [...this.lastRand];
      for (let i = rand.length - 1; i >= 0; i--) {
        if ((rand[i] as number) < 31) {
          rand[i] = (rand[i] as number) + 1;
          break;
        }
        rand[i] = 0;
      }
    } else rand = this.random();
    this.lastMs = ms;
    this.lastRand = rand;
    let t = ms;
    let time = "";
    for (let i = 0; i < 10; i++) {
      time = CROCKFORD[t % 32] + time;
      t = Math.floor(t / 32);
    }
    return time + rand.map((r) => CROCKFORD[r]).join("");
  }
}

// ---------------------------------------------------------------- signing

export type UnsignedContract = Omit<ExecutionContract, "signature" | "signedBy">;

export function signContract(unsigned: UnsignedContract, signer: Signer): ExecutionContract {
  const body = { ...unsigned, signedBy: "scout" as const };
  return { ...body, signature: signer.sign(canonicalJson(body)) };
}

export type RefusalReason =
  | "malformed"
  | "unsigned"
  | "tampered"
  | "expired"
  | "not-yet-valid"
  | "ttl-too-long"
  | "not-ready"
  | "registry-drift"
  | "policy-drift"
  | "scope-mismatch"
  | "case-mismatch"
  | "actor-mismatch"
  | "approval-missing"
  | "replayed";

export type VerifyResult = { ok: true; contract: ExecutionContract } | { ok: false; reason: RefusalReason; detail: string };

export interface VerifyOptions {
  signer: Signer;
  now: Date;
  /** Capabilities the executor is about to use; any outside the contract's scope refuses it. */
  using?: readonly string[];
  /** The authenticated caller the executor is acting for. */
  actor?: string;
  /** The case the executor is about to touch. */
  caseId?: string;
  registryHash?: string;
  policyPackVersion?: string;
  /** Statuses that count as usable. An executor accepts only "ready"; Scout itself also reads a contract awaiting approval. */
  allowStatuses?: readonly ExecutionContract["status"][];
  /** Accept a contract that expired no more than this long ago (refreshing only; an executor never sets it). */
  graceMs?: number;
}

const fail = (reason: RefusalReason, detail: string): VerifyResult => ({ ok: false, reason, detail });

/** Check a contract without consuming it. Order matters: the cheapest, most fundamental failure is the answer. */
export function verifyContract(c: unknown, o: VerifyOptions): VerifyResult {
  const k = c as Partial<ExecutionContract> | null;
  if (!k || typeof k !== "object" || Array.isArray(k)) return fail("malformed", "not a contract");
  if (typeof k.contractId !== "string" || typeof k.issuedAt !== "string" || typeof k.expiresAt !== "string" || !k.intent || !k.risk || !k.scope || !Array.isArray(k.toolPlan) || !Array.isArray(k.scope.capabilities)) {
    return fail("malformed", "a required field is missing");
  }
  if (typeof k.signature !== "string" || k.signature === "") return fail("unsigned", "the contract carries no signature");
  const { signature, ...rest } = k as ExecutionContract;
  let canonical: string;
  try {
    canonical = canonicalJson(rest);
  } catch {
    return fail("malformed", "the contract cannot be canonicalised");
  }
  if (rest.signedBy !== "scout" || !o.signer.verify(canonical, signature)) return fail("tampered", "the signature does not match the contract");

  const now = o.now.getTime();
  const issued = Date.parse(rest.issuedAt);
  const expires = Date.parse(rest.expiresAt);
  if (!Number.isFinite(issued) || !Number.isFinite(expires)) return fail("malformed", "issuedAt or expiresAt is not a date");
  if (expires - issued > CONTRACT_TTL_MS + 1000) return fail("ttl-too-long", `the contract lives ${Math.round((expires - issued) / 1000)} s; the limit is ${CONTRACT_TTL_MS / 1000} s`);
  if (issued - now > CLOCK_SKEW_MS) return fail("not-yet-valid", `the contract was issued at ${rest.issuedAt}, in the future`);
  if (expires + (o.graceMs ?? 0) <= now) return fail("expired", `the contract expired at ${rest.expiresAt}`);
  if (!(o.allowStatuses ?? ["ready"]).includes(rest.status)) return fail("not-ready", `the contract is ${rest.status}; it cannot be used until that is resolved`);
  if (o.registryHash !== undefined && rest.registryHash !== o.registryHash) return fail("registry-drift", "the contract was issued under a different registry");
  if (o.policyPackVersion !== undefined && rest.policyPackVersion !== o.policyPackVersion) return fail("policy-drift", `the contract was issued under ${rest.policyPackVersion}, not ${o.policyPackVersion}`);
  const outside = (o.using ?? []).filter((u) => !rest.scope.capabilities.includes(u));
  if (outside.length > 0) return fail("scope-mismatch", `${outside.join(", ")} ${outside.length === 1 ? "is" : "are"} outside the contract's capabilities`);
  if (o.actor !== undefined && o.actor !== rest.scope.user.id) return fail("actor-mismatch", "the contract was issued to a different user");
  if (o.caseId !== undefined && rest.scope.caseId !== undefined && rest.scope.caseId !== o.caseId) return fail("case-mismatch", `the contract is for ${rest.scope.caseId}, not ${o.caseId}`);
  if (o.caseId !== undefined && rest.scope.caseId === undefined && rest.intent.primary.riskClass !== "low") return fail("case-mismatch", "the contract is not bound to a case");
  if (rest.intent.primary.riskClass === "high" && rest.status === "ready") {
    const ok = rest.parentId !== undefined && rest.risk.approvals.some((a: ApprovalRecord) => a.decision === "approve" && a.contractId === rest.parentId && a.by === rest.scope.user.id);
    if (!ok) return fail("approval-missing", "a high-risk contract needs the approval of the user it was issued to, recorded against the contract they were shown");
  }
  return { ok: true, contract: rest as ExecutionContract };
}

// ---------------------------------------------------------------- replay

/** Remembers the single-use contracts that have been redeemed. */
export interface ReplayStore {
  /** True the first time an id is presented; false after. Entries need only live until expiresAtMs. */
  redeem(id: string, expiresAtMs: number, nowMs: number): boolean;
}

export class MemoryReplayStore implements ReplayStore {
  private readonly seen = new Map<string, number>();
  redeem(id: string, expiresAtMs: number, nowMs: number): boolean {
    for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
    if (this.seen.has(id)) return false;
    this.seen.set(id, expiresAtMs);
    return true;
  }
  get size(): number {
    return this.seen.size;
  }
}

/**
 * Survives a restart: a redeemed id is written to disk before the redemption is reported. Expired entries are
 * dropped when the file is loaded. One process per file.
 */
export class JsonlReplayStore implements ReplayStore {
  private readonly seen = new Map<string, number>();
  constructor(
    private readonly path: string,
    nowMs: number = Date.now(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) {
      let rewrite = false;
      for (const line of readFileSync(path, "utf8").split("\n")) {
        if (!line.trim()) continue;
        try {
          const [id, exp] = JSON.parse(line) as [string, number];
          if (typeof id === "string" && typeof exp === "number" && exp > nowMs) this.seen.set(id, exp);
          else rewrite = true;
        } catch {
          rewrite = true;
        }
      }
      if (rewrite) writeFileSync(path, [...this.seen].map(([i, e]) => JSON.stringify([i, e])).join("\n") + (this.seen.size ? "\n" : ""));
    }
  }
  redeem(id: string, expiresAtMs: number, nowMs: number): boolean {
    for (const [k, exp] of this.seen) if (exp <= nowMs) this.seen.delete(k);
    if (this.seen.has(id)) return false;
    appendFileSync(this.path, `${JSON.stringify([id, expiresAtMs])}\n`);
    this.seen.set(id, expiresAtMs);
    return true;
  }
}

// ---------------------------------------------------------------- the executor's side

/**
 * What an executor runs on receipt of a contract. Reads and exports alike go through redeem(): an export or any
 * write must present a contract whose scope names the capability, that has not been used before, and that carries
 * the approval a high-risk action needs.
 */
export class ContractExecutor {
  private readonly replay: ReplayStore;

  constructor(
    private readonly opts: {
      signer: Signer;
      clock?: () => Date;
      replay?: ReplayStore;
      registryHash?: string;
      policyPackVersion?: string;
      telemetry?: Telemetry;
      /** Name of the engine redeeming, for the audit trail. */
      engine?: string;
    },
  ) {
    this.replay = opts.replay ?? new MemoryReplayStore();
  }

  redeem(c: unknown, use: { using: readonly string[]; actor?: string; caseId?: string }): VerifyResult {
    const now = (this.opts.clock ?? (() => new Date()))();
    const v = verifyContract(c, { signer: this.opts.signer, now, using: use.using, actor: use.actor, caseId: use.caseId, registryHash: this.opts.registryHash, policyPackVersion: this.opts.policyPackVersion });
    const id = typeof (c as { contractId?: unknown } | null)?.contractId === "string" ? (c as { contractId: string }).contractId : undefined;
    if (!v.ok) {
      this.emit(v.reason === "expired" ? "contract.expired" : "contract.refused", id, { reason: v.reason, detail: v.detail, using: use.using });
      return v;
    }
    if (v.contract.scope.singleUse) {
      const first = this.replay.redeem(v.contract.contractId, Date.parse(v.contract.expiresAt), now.getTime());
      if (!first) {
        this.emit("contract.refused", id, { reason: "replayed", using: use.using });
        return fail("replayed", "this single-use contract has already been redeemed");
      }
    }
    this.emit("contract.verified", id, { using: use.using });
    return v;
  }

  private emit(event: "contract.verified" | "contract.refused" | "contract.expired", contractId: string | undefined, detail: Record<string, unknown>): void {
    try {
      this.opts.telemetry?.({ event, at: (this.opts.clock ?? (() => new Date()))().toISOString(), contractId, detail: { engine: this.opts.engine ?? "unknown", ...detail } });
    } catch {
      // Telemetry must never decide an outcome.
    }
  }
}
