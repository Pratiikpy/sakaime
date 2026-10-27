import { createHash, createPublicKey, verify } from "node:crypto";
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync } from "node:fs";
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";
import type { ComputeReceipt } from "../ports/index.ts";
import { canonicalJson } from "../util/canonical.ts";
import type { ChatUsage } from "./chat.ts";
import type { LaneLocation } from "./types.ts";

/*
 * Nightshift receipts (requirement C-13).
 *
 * What the installed Nightshift 1.2.3 returns, read on 2026-10-27 from live calls: beside the chat completion it adds a
 * `meterless` object. Inside it, `receipt_envelope` is `{ body, pubkey_b64, sig_b64 }`; `sig_b64` is an Ed25519 signature
 * over the compact JSON of `body`, and `body.receipt` is the receipt (`schema: meterless.compute_receipt.v1`). The
 * fields OUTSIDE the envelope (`requested_model`, `routed_model`, `scope`, `app`, `from_cache`) are not signed, so every
 * decision below is taken from the signed receipt and the outer fields are only compared against it for tampering.
 *
 * What a receipt does not carry: a hash of the request or the reply. It carries the length and a preview of the last
 * user message, the token counts, and the id of the chat completion (`request_id`). Those are what binds it to a call.
 * A valid receipt therefore shows where a call was routed and that this runtime wrote the receipt; it does not commit to
 * the reply text, and it shows origin, never truth.
 *
 * What the receipt's "prompt" is (measured against the installed 1.2.3 on 2026-10-27, not documented): the user and assistant
 * messages of the request, system messages left out, joined by one separator character, and when that text is longer than
 * 4000 characters only its LAST 4000. `egress.sent.prompt_chars` is the length of that text and `prompt_preview` is its first
 * 180 characters. A request that is one user message under 4000 characters therefore matches the message exactly, which is all
 * the first version of this check handled; a structured call that needed a repair (user, assistant, user) and any long prompt
 * did not match, and the check rejected 13 of 60 genuine Nightshift replies while recording the sample run.
 */
export const RECEIPT_PROMPT_WINDOW_CHARS = 4000;

export const RECEIPT_SCHEMA = "meterless.compute_receipt.v1";
const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export type ReceiptRejection =
  | "MISSING"
  | "MALFORMED"
  | "UNSIGNED"
  | "BAD_SIGNATURE"
  | "UNTRUSTED_KEY"
  | "REPLAYED"
  | "WRONG_MODEL"
  | "WRONG_TIER"
  | "WRONG_APP"
  | "WRONG_CUSTODY"
  | "HMEM_NONZERO"
  | "BINDING_MISMATCH"
  | "SCOPE_MISMATCH"
  | "STALE"
  | "TAMPERED"
  | "NOT_OK"
  | "FROM_CACHE"
  | "LANE_VIOLATION";

export interface ReceiptCheck {
  name: string;
  passed: boolean;
  detail: string;
}

export interface ReceiptPolicy {
  /** Key ids (first 16 hex characters of the SHA-256 of the raw public key) of the installed application. */
  trustedKeyIds: readonly string[];
  /** Accept a valid signature from a key that is not pinned. Labelled in the record; off by default. */
  allowUnpinnedKey?: boolean;
  /** The app id the receipt must name (Nightshift records which app made the call). Not enforced when absent. */
  expectedAppId?: string;
  /** The tier the receipt must name for a model. Not enforced for a model without an entry. */
  expectedTierByModel?: Readonly<Record<string, string>>;
  maxAgeMs?: number;
  maxFutureSkewMs?: number;
  nightshiftVersion?: string;
}

export interface ReceiptContext {
  requestedModel: string;
  /** The exact `meterless-scope` value sent on this attempt. */
  memoryScope: string;
  /** The `id` of the chat completion that carried the receipt. */
  responseId?: string;
  /** The text of the last user message sent. Used alone when `conversation` is not given. */
  lastUserText: string;
  /** The contents of every non-system message sent on this attempt, in order: what the receipt's prompt length and preview describe. */
  conversation?: readonly string[];
  /** SHA-256 of the request body and of the reply text, taken locally. */
  requestHash: string;
  responseHash: string;
  usage?: ChatUsage;
  lane: LaneLocation;
  now: Date;
}

export type ReceiptVerdict =
  | { accepted: true; receipt: ComputeReceipt; checks: ReceiptCheck[] }
  | { accepted: false; code: ReceiptRejection; reason: string; checks: ReceiptCheck[]; receiptId?: string; hmem?: number };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined);

export function keyIdOf(rawPublicKey: Buffer): string {
  return createHash("sha256").update(rawPublicKey).digest("hex").slice(0, 16);
}

export interface SignatureCheck {
  valid: boolean;
  reason?: string;
  keyId?: string;
  body?: Obj;
  receipt?: Obj;
  signatureB64?: string;
  signedAtMs?: number;
}

/** Checks the Ed25519 signature on an envelope. Never throws; anything malformed is a reason. */
export function verifyEnvelopeSignature(envelope: unknown): SignatureCheck {
  if (!isObj(envelope)) return { valid: false, reason: "no envelope" };
  const body = envelope["body"];
  const pub = envelope["pubkey_b64"];
  const sig = envelope["sig_b64"];
  if (!isObj(body)) return { valid: false, reason: "the envelope has no body" };
  if (typeof pub !== "string" || typeof sig !== "string") return { valid: false, reason: "the envelope has no public key or no signature" };
  const raw = Buffer.from(pub, "base64");
  const signature = Buffer.from(sig, "base64");
  if (raw.length !== 32) return { valid: false, reason: "the public key is not a 32-byte Ed25519 key" };
  if (signature.length !== 64) return { valid: false, reason: "the signature is not 64 bytes" };
  const keyId = keyIdOf(raw);
  const receipt = body["receipt"];
  if (!isObj(receipt) || receipt["schema"] !== RECEIPT_SCHEMA) return { valid: false, reason: `the body holds no ${RECEIPT_SCHEMA}`, keyId };
  let ok = false;
  try {
    const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX, raw]), format: "der", type: "spki" });
    // The producer writes keys in sorted order, so both forms are the same bytes; trying both tolerates a producer that does not.
    ok = verify(null, Buffer.from(canonicalJson(body), "utf8"), key, signature) || verify(null, Buffer.from(JSON.stringify(body), "utf8"), key, signature);
  } catch {
    ok = false;
  }
  const signedAtMs = typeof body["ts_ms"] === "number" ? body["ts_ms"] : undefined;
  if (!ok) return { valid: false, reason: "the signature does not match the receipt", keyId };
  return { valid: true, keyId, body, receipt, signatureB64: sig, ...(signedAtMs !== undefined ? { signedAtMs } : {}) };
}

/** The number of memory entries the receipt says were added to the prompt. Null, absent and 0 are all zero. NaN means unreadable. */
export function hmemCount(value: unknown): number {
  if (value === null || value === undefined || value === false) return 0;
  if (typeof value === "number") return Number.isFinite(value) && value >= 0 ? value : Number.NaN;
  if (value === true) return 1;
  if (Array.isArray(value)) return value.length;
  if (isObj(value)) {
    // The shape of a non-null value is not documented and has not been observed. Sum every numeric leaf and count
    // every array element: any positive total excludes the call.
    let total = 0;
    for (const v of Object.values(value)) {
      const n = Array.isArray(v) ? v.length : typeof v === "number" ? v : isObj(v) ? hmemCount(v) : v === true ? 1 : 0;
      if (Number.isNaN(n)) return Number.NaN;
      total += n;
    }
    return total;
  }
  return Number.NaN;
}

export interface AcceptedReceipt {
  receiptId: string;
  decisionId?: string;
  keyId: string;
  model: string;
  tier: string;
  at: string;
  requestHash: string;
  responseHash: string;
  origin: "live" | "recorded";
  role?: string;
}

export interface RejectedReceipt {
  receiptId?: string;
  code: ReceiptRejection;
  reason: string;
  at: string;
  model?: string;
  role?: string;
  hmem?: number;
}

type LedgerLine = { op: "accept"; record: AcceptedReceipt } | { op: "reject"; record: RejectedReceipt };

/**
 * Every receipt verdict of a run. A receipt id seen once is never accepted again (replay), a call excluded for
 * non-zero memory is listed so an evaluation can drop it, and the coverage report reads from here.
 */
export class ReceiptLedger {
  private readonly acceptedById = new Map<string, AcceptedReceipt>();
  private readonly decisions = new Set<string>();
  private readonly rejectedList: RejectedReceipt[] = [];

  constructor(private readonly options: { path?: string; now?: () => Date } = {}) {
    if (options.path && existsSync(options.path)) {
      for (const raw of readFileSync(options.path, "utf8").split("\n")) {
        if (!raw.trim()) continue;
        try {
          const line = JSON.parse(raw) as LedgerLine;
          if (line.op === "accept") this.index(line.record);
          else this.rejectedList.push(line.record);
        } catch {
          /* a damaged line is skipped; the next accept for that id would then not be seen as a replay, which the report states */
        }
      }
    }
  }

  private index(record: AcceptedReceipt): void {
    this.acceptedById.set(record.receiptId, record);
    if (record.decisionId) this.decisions.add(record.decisionId);
  }

  now(): Date {
    return (this.options.now ?? (() => new Date()))();
  }

  hasAccepted(receiptId: string, decisionId?: string): boolean {
    return this.acceptedById.has(receiptId) || (decisionId !== undefined && this.decisions.has(decisionId));
  }

  accept(record: AcceptedReceipt): void {
    this.index(record);
    this.append({ op: "accept", record });
  }

  reject(record: Omit<RejectedReceipt, "at">): RejectedReceipt {
    const full: RejectedReceipt = { ...record, at: this.now().toISOString() };
    this.rejectedList.push(full);
    this.append({ op: "reject", record: full });
    return full;
  }

  accepted(): AcceptedReceipt[] {
    return [...this.acceptedById.values()];
  }

  rejected(): readonly RejectedReceipt[] {
    return this.rejectedList;
  }

  get(receiptId: string): AcceptedReceipt | undefined {
    return this.acceptedById.get(receiptId);
  }

  /** Calls whose receipt showed remembered context: excluded from evaluation, kept here so the exclusion is auditable. */
  excludedForMemory(): readonly RejectedReceipt[] {
    return this.rejectedList.filter((r) => r.code === "HMEM_NONZERO");
  }

  private append(line: LedgerLine): void {
    if (!this.options.path) return;
    try {
      mkdirSync(dirname(this.options.path), { recursive: true });
      appendFileSync(this.options.path, `${JSON.stringify(line)}\n`, "utf8");
    } catch {
      /* the in-memory ledger stands; the disk copy is best effort */
    }
  }
}

export interface ModelDerivedItem {
  id: string;
  /** The receipt id the item's model call carried, if any. */
  receiptId?: string;
}

export interface ReceiptCoverage {
  total: number;
  verifiedLive: number;
  verifiedRecorded: number;
  /** Items whose model call carried no receipt at all. */
  unreceipted: string[];
  /** Items that named a receipt the ledger does not hold as verified. */
  unverified: { id: string; receiptId: string }[];
  /** (verifiedLive + verifiedRecorded) / total; null when there are no items, never 1. */
  share: number | null;
  shareLive: number | null;
}

/** MA-5: the share of model-derived items that can be tied to a verified receipt. */
export function receiptCoverage(items: readonly ModelDerivedItem[], ledger: ReceiptLedger): ReceiptCoverage {
  let live = 0;
  let recorded = 0;
  const unreceipted: string[] = [];
  const unverified: { id: string; receiptId: string }[] = [];
  for (const item of items) {
    if (!item.receiptId) {
      unreceipted.push(item.id);
      continue;
    }
    const rec = ledger.get(item.receiptId);
    if (!rec) unverified.push({ id: item.id, receiptId: item.receiptId });
    else if (rec.origin === "live") live += 1;
    else recorded += 1;
  }
  const total = items.length;
  return {
    total,
    verifiedLive: live,
    verifiedRecorded: recorded,
    unreceipted,
    unverified,
    share: total === 0 ? null : (live + recorded) / total,
    shareLive: total === 0 ? null : live / total,
  };
}

/**
 * Verifies the receipt that came back with one live call. Returns a verdict; the caller decides what to do with a
 * rejection (the clients throw). On acceptance the receipt id is entered in the ledger so it cannot be accepted twice.
 */
export function verifyLiveReceipt(meterless: unknown, ctx: ReceiptContext, policy: ReceiptPolicy, ledger: ReceiptLedger, role?: string): ReceiptVerdict {
  const checks: ReceiptCheck[] = [];
  const pass = (name: string, detail: string): void => {
    checks.push({ name, passed: true, detail });
  };
  const reject = (code: ReceiptRejection, name: string, reason: string, extra: { receiptId?: string; hmem?: number } = {}): ReceiptVerdict => {
    checks.push({ name, passed: false, detail: reason });
    ledger.reject({ code, reason, model: ctx.requestedModel, ...(role ? { role } : {}), ...extra });
    return { accepted: false, code, reason, checks, ...extra };
  };

  if (!isObj(meterless)) return reject("MISSING", "present", "the reply carried no meterless object, so it has no receipt");
  if (meterless["schema"] !== RECEIPT_SCHEMA) return reject("MALFORMED", "schema", `the meterless object is not a ${RECEIPT_SCHEMA}`);
  pass("schema", RECEIPT_SCHEMA);

  const envelope = meterless["receipt_envelope"];
  if (envelope === undefined || envelope === null) return reject("UNSIGNED", "signed", "the receipt carries no signed envelope", { ...receiptIdOf(meterless) });
  const sig = verifyEnvelopeSignature(envelope);
  if (!sig.valid || !sig.receipt || !sig.keyId) return reject("BAD_SIGNATURE", "signature", sig.reason ?? "the signature is not valid", { ...receiptIdOf(meterless) });
  pass("signature", `Ed25519 over the envelope body verified (key ${sig.keyId})`);
  const signed = sig.receipt;
  const receiptId = str(signed["receipt_id"]);
  if (!receiptId) return reject("MALFORMED", "receipt_id", "the signed receipt has no receipt_id");
  const withId = { receiptId };

  const pinned = policy.trustedKeyIds.includes(sig.keyId);
  if (!pinned && !policy.allowUnpinnedKey) {
    return reject("UNTRUSTED_KEY", "key", `signed by key ${sig.keyId}, which is not the installed application's key (${policy.trustedKeyIds.length === 0 ? "none pinned" : policy.trustedKeyIds.join(", ")})`, withId);
  }
  pass("key", pinned ? `key ${sig.keyId} is pinned to the installed application` : `key ${sig.keyId} is NOT pinned; accepted only because unpinned keys were allowed`);

  // The outer object is unsigned. Anything in it that disagrees with the signed receipt is tampering or a routing fault.
  const decisionId = str(signed["decision_id"]);
  const outerChecks: [string, unknown, unknown][] = [
    ["receipt_id", meterless["receipt_id"], receiptId],
    ["decision_id", meterless["decision_id"], decisionId],
  ];
  const route = isObj(signed["winning_route"]) ? signed["winning_route"] : {};
  const routedModel = str(route["model"]);
  if (!routedModel) return reject("MALFORMED", "winning_route", "the signed receipt names no model in winning_route", withId);
  outerChecks.push(["routed_model", meterless["routed_model"], routedModel]);
  for (const [name, outer, inner] of outerChecks) {
    if (outer !== undefined && outer !== inner) return reject("TAMPERED", "outer-matches-signed", `the unsigned ${name} differs from the signed receipt`, withId);
  }
  if (isObj(meterless["receipt"]) && canonicalJson(meterless["receipt"]) !== canonicalJson(signed)) {
    return reject("TAMPERED", "outer-matches-signed", "the unsigned receipt copy differs from the signed receipt", withId);
  }
  pass("outer-matches-signed", "the unsigned fields agree with the signed receipt");

  if (signed["status"] !== "ok") return reject("NOT_OK", "status", `the signed receipt's status is ${JSON.stringify(signed["status"])}, not "ok"`, withId);
  pass("status", "ok");

  const cache = isObj(signed["cache"]) ? str(signed["cache"]["status"]) : undefined;
  if (meterless["from_cache"] === true || (cache !== undefined && /hit/i.test(cache))) {
    return reject("FROM_CACHE", "not-cached", "the answer came from Nightshift's response cache, not from a fresh call", withId);
  }
  pass("not-cached", `cache status ${cache ?? "not stated"}`);

  if (ledger.hasAccepted(receiptId, decisionId)) return reject("REPLAYED", "not-replayed", `receipt ${receiptId} was already accepted for another call`, withId);
  pass("not-replayed", "receipt id and decision id not seen before");

  const winner = isObj(signed["routing"]) ? str(signed["routing"]["winner"]) : undefined;
  if (routedModel !== ctx.requestedModel || (winner !== undefined && winner !== ctx.requestedModel)) {
    return reject("WRONG_MODEL", "routed-model", `the receipt says ${winner !== undefined && winner !== routedModel ? `${routedModel} (routing winner ${winner})` : routedModel} answered; ${ctx.requestedModel} was requested`, withId);
  }
  pass("routed-model", `${routedModel} answered, as requested`);

  const tier = str(route["tier"]);
  if (!tier) return reject("WRONG_TIER", "tier", "the receipt names no tier", withId);
  const wantTier = policy.expectedTierByModel?.[ctx.requestedModel];
  if (wantTier !== undefined && wantTier !== tier) return reject("WRONG_TIER", "tier", `the receipt names tier ${tier}; ${ctx.requestedModel} is expected at tier ${wantTier}`, withId);
  pass("tier", wantTier === undefined ? `tier ${tier} named (no expectation set for this model)` : `tier ${tier} as expected`);

  const app = str(signed["app"]);
  if (!app) return reject("WRONG_APP", "app", "the receipt names no app id", withId);
  if (policy.expectedAppId !== undefined && app !== policy.expectedAppId) return reject("WRONG_APP", "app", `the receipt names app ${app}; this client's key belongs to ${policy.expectedAppId}`, withId);
  pass("app", policy.expectedAppId === undefined ? `app ${app} named (no expectation set)` : `app ${app} as expected`);

  const requestId = str(signed["request_id"]);
  if (!ctx.responseId) return reject("WRONG_CUSTODY", "request-id", "the chat completion has no id to compare the receipt's request id with", withId);
  if (requestId !== ctx.responseId) return reject("WRONG_CUSTODY", "request-id", `the receipt is for request ${requestId ?? "(none)"}, not for the completion ${ctx.responseId}`, withId);
  pass("request-id", "the signed request id is this completion's id");

  const echoed = str(meterless["scope"]);
  if (echoed !== undefined && echoed !== ctx.memoryScope) return reject("SCOPE_MISMATCH", "memory-scope", "the memory scope Nightshift echoed is not the one sent on this call", withId);
  pass("memory-scope", echoed === undefined ? "the scope was not echoed" : "the echoed scope is the one sent");

  const hmem = hmemCount(signed["hmem"]);
  if (Number.isNaN(hmem)) return reject("HMEM_NONZERO", "hmem", "the receipt's hmem value cannot be read, so memory-free operation cannot be shown", withId);
  if (hmem > 0) return reject("HMEM_NONZERO", "hmem", `the receipt shows ${hmem} remembered item${hmem === 1 ? "" : "s"} added to the prompt; the call is excluded`, { ...withId, hmem });
  pass("hmem", "no remembered context was added");

  const sent = isObj(signed["egress"]) && isObj(signed["egress"]["sent"]) ? signed["egress"]["sent"] : undefined;
  // prompt_chars counts UTF-16 code units, the same as a JS string's length (checked live with an emoji, 2026-10-27).
  const chars = sent && typeof sent["prompt_chars"] === "number" ? sent["prompt_chars"] : undefined;
  const preview = str(signed["prompt_preview"]);
  const promptText = (ctx.conversation ?? [ctx.lastUserText]).join("\n");
  const total = promptText.length;
  let window = promptText;
  if (chars !== undefined) {
    if (chars === total) window = promptText;
    else if (total > RECEIPT_PROMPT_WINDOW_CHARS && chars === RECEIPT_PROMPT_WINDOW_CHARS) window = promptText.slice(total - RECEIPT_PROMPT_WINDOW_CHARS);
    else {
      return reject(
        "BINDING_MISMATCH",
        "request-binding",
        `the receipt records a ${chars}-character prompt; the messages sent make ${total}${total > RECEIPT_PROMPT_WINDOW_CHARS ? ` (${RECEIPT_PROMPT_WINDOW_CHARS} when only the last ${RECEIPT_PROMPT_WINDOW_CHARS} are kept)` : ""}`,
        withId,
      );
    }
  } else if (total > RECEIPT_PROMPT_WINDOW_CHARS) {
    window = promptText.slice(total - RECEIPT_PROMPT_WINDOW_CHARS);
  }
  if (preview !== undefined) {
    // Whichever whitespace character joins two messages in the receipt's text, a preview that spans the join still matches.
    const head = preview.replace(/(?:\.\.\.|…)$/u, "").replace(/\s/gu, " ");
    if (!window.replace(/\s/gu, " ").startsWith(head)) return reject("BINDING_MISMATCH", "request-binding", "the receipt's prompt preview is not the start of the prompt text that was sent", withId);
  }
  const hashes = [
    ["request_hash", ctx.requestHash],
    ["response_hash", ctx.responseHash],
  ] as const;
  let hashesCarried = 0;
  for (const [field, ours] of hashes) {
    const theirs = str(signed[field]);
    if (theirs === undefined) continue;
    hashesCarried += 1;
    if (theirs.replace(/^sha256:/, "") !== ours) return reject("BINDING_MISMATCH", "request-binding", `the receipt's ${field} is not the hash taken here`, withId);
  }
  pass("request-binding", `prompt length${preview !== undefined ? " and preview" : ""} match what was sent${window.length < total ? ` (last ${window.length} characters)` : ""}${hashesCarried > 0 ? `; ${hashesCarried} hash field(s) match` : "; this receipt carries no request or response hash"}`);

  const u = isObj(signed["usage"]) ? signed["usage"] : undefined;
  const inTok = u && typeof u["input_tokens"] === "number" ? u["input_tokens"] : undefined;
  const outTok = u && typeof u["output_tokens"] === "number" ? u["output_tokens"] : undefined;
  if (ctx.usage?.promptTokens !== undefined && inTok !== undefined && inTok !== ctx.usage.promptTokens) {
    return reject("BINDING_MISMATCH", "response-binding", `the receipt counts ${inTok} prompt tokens; the reply reported ${ctx.usage.promptTokens}`, withId);
  }
  if (ctx.usage?.completionTokens !== undefined && outTok !== undefined && outTok !== ctx.usage.completionTokens) {
    return reject("BINDING_MISMATCH", "response-binding", `the receipt counts ${outTok} completion tokens; the reply reported ${ctx.usage.completionTokens}`, withId);
  }
  pass("response-binding", "the token counts agree with the reply's usage");

  const signedAt = sig.signedAtMs ?? (typeof signed["created_at"] === "number" ? signed["created_at"] : undefined);
  if (signedAt === undefined) return reject("STALE", "fresh", "the receipt carries no signing time", withId);
  const age = ctx.now.getTime() - signedAt;
  if (age > (policy.maxAgeMs ?? 10 * 60_000) || age < -(policy.maxFutureSkewMs ?? 2 * 60_000)) {
    return reject("STALE", "fresh", `the receipt was signed ${Math.round(age / 1000)} s before it was checked, outside the window`, withId);
  }
  pass("fresh", `signed ${Math.max(0, Math.round(age / 1000))} s ago`);

  const kind = str(route["kind"]);
  if (ctx.lane === "local" && kind === "cloud") {
    return reject("LANE_VIOLATION", "lane", "the call was meant to stay on this machine but the receipt says it was routed to the cloud", withId);
  }
  pass("lane", `${kind ?? "route kind not stated"} for a ${ctx.lane} call`);

  const receipt: ComputeReceipt = {
    receiptId,
    ...(decisionId ? { decisionId } : {}),
    routedModel,
    ...(str(route["provider"]) ? { provider: str(route["provider"]) as string } : {}),
    ...(u && typeof u["latency_ms"] === "number" ? { latencyMs: u["latency_ms"] } : {}),
    hmem: 0,
    signature: sig.signatureB64 as string,
    keyId: sig.keyId,
    requestHash: ctx.requestHash,
    responseHash: ctx.responseHash,
    raw: {
      envelope,
      tier,
      kind: kind ?? null,
      app,
      requestId: requestId as string,
      signedAtMs: signedAt,
      keyPinned: pinned,
      nightshiftVersion: policy.nightshiftVersion ?? null,
      // Computed here; Nightshift 1.2.3 receipts carry no request or response hash.
      hashesComputedLocally: hashesCarried === 0,
      verification: { verifiedAt: ctx.now.toISOString(), origin: "live", checks },
    },
  };
  ledger.accept({
    receiptId,
    ...(decisionId ? { decisionId } : {}),
    keyId: sig.keyId,
    model: routedModel,
    tier,
    at: ctx.now.toISOString(),
    requestHash: ctx.requestHash,
    responseHash: ctx.responseHash,
    origin: "live",
    ...(role ? { role } : {}),
  });
  return { accepted: true, receipt, checks };
}

function receiptIdOf(meterless: Obj): { receiptId?: string } {
  const id = str(meterless["receipt_id"]);
  return id ? { receiptId: id } : {};
}

export type StoredReceiptCheck = { ok: true; keyId: string; checks: ReceiptCheck[] } | { ok: false; reason: string; checks: ReceiptCheck[] };

/**
 * Re-checks a receipt that was stored with a reply (a cassette, a dossier) with no network and no clock: the signature,
 * the pinned key, that the signed receipt is the one named, that it routed the model the stored reply says it did, that
 * it reported no remembered context. Replay and freshness are properties of a live call and do not apply here.
 */
export function verifyStoredReceipt(receipt: ComputeReceipt, expected: { requestedModel: string }, policy: Pick<ReceiptPolicy, "trustedKeyIds" | "allowUnpinnedKey">): StoredReceiptCheck {
  const checks: ReceiptCheck[] = [];
  const fail = (name: string, reason: string): StoredReceiptCheck => {
    checks.push({ name, passed: false, detail: reason });
    return { ok: false, reason, checks };
  };
  const envelope = receipt.raw["envelope"];
  if (envelope === undefined) return fail("signed", "the stored receipt has no signed envelope");
  const sig = verifyEnvelopeSignature(envelope);
  if (!sig.valid || !sig.receipt || !sig.keyId) return fail("signature", sig.reason ?? "the signature is not valid");
  checks.push({ name: "signature", passed: true, detail: `Ed25519 verified (key ${sig.keyId})` });
  if (!policy.trustedKeyIds.includes(sig.keyId) && !policy.allowUnpinnedKey) return fail("key", `signed by key ${sig.keyId}, which is not pinned`);
  checks.push({ name: "key", passed: true, detail: `key ${sig.keyId}` });
  if (sig.receipt["receipt_id"] !== receipt.receiptId) return fail("receipt-id", "the stored receipt id is not the signed one");
  const route = isObj(sig.receipt["winning_route"]) ? sig.receipt["winning_route"] : {};
  if (route["model"] !== expected.requestedModel || receipt.routedModel !== expected.requestedModel) {
    return fail("routed-model", `the signed receipt names ${String(route["model"])}; the stored reply was requested from ${expected.requestedModel}`);
  }
  checks.push({ name: "routed-model", passed: true, detail: expected.requestedModel });
  const hmem = hmemCount(sig.receipt["hmem"]);
  if (Number.isNaN(hmem) || hmem > 0) return fail("hmem", "the signed receipt does not show memory-free operation");
  checks.push({ name: "hmem", passed: true, detail: "0" });
  return { ok: true, keyId: sig.keyId, checks };
}

// ---------------------------------------------------------------- the installed application

/** Where Nightshift for Windows keeps its receipt log. Other platforms are NOT VERIFIED here. */
export function defaultReceiptLogPath(env: Record<string, string | undefined> = process.env, platform: string = process.platform): string | undefined {
  const explicit = env["NIGHTSHIFT_RECEIPT_LOG"];
  if (explicit) return explicit;
  if (platform === "win32" && env["LOCALAPPDATA"]) return join(env["LOCALAPPDATA"], "ai.meterless.runtime", "receipts.jsonl");
  return undefined;
}

/**
 * The key id of the Nightshift installed on this machine, read from the last verifiable envelope in the application's
 * own receipt log. This trusts the application's data directory exactly as far as the application itself is trusted:
 * anyone who can write there can also replace the application. Pinning the id in configuration is stronger.
 */
export function readInstalledKeyId(logPath: string): string | undefined {
  if (!existsSync(logPath)) return undefined;
  const fd = openSync(logPath, "r");
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, 1024 * 1024);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n").reverse();
    for (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue; // the first line of the window is usually cut in half
      }
      const check = verifyEnvelopeSignature(parsed);
      if (check.valid && check.keyId) return check.keyId;
    }
    return undefined;
  } finally {
    closeSync(fd);
  }
}

/** The installed Nightshift's version from the Windows uninstall entry. Resolves undefined where it cannot be read. */
export function readInstalledNightshiftVersion(platform: string = process.platform): Promise<string | undefined> {
  if (platform !== "win32") return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Nightshift", "/v", "DisplayVersion"],
      { timeout: 5000, windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(undefined);
        const m = /DisplayVersion\s+REG_SZ\s+(\S+)/.exec(stdout);
        resolve(m?.[1]);
      },
    );
  });
}
