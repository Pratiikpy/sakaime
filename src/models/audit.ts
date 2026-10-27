import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ComputeReceipt } from "../ports/index.ts";
import { verifyStoredReceipt, type ReceiptPolicy } from "./receipt.ts";

/**
 * A read of the recorded model replies that makes no call and invents nothing: which route produced each recording, whether
 * the receipt stored with it still verifies (signature, pinned key id, routed model equal to the requested one, memory-free),
 * and which models answered. Used for the run mode shown to a reviewer and for the receipt-coverage report, so the words
 * "replayed from recordings made through Nightshift" are only ever said of recordings that were checked.
 */
export interface CassetteAudit {
  /** Recordings found, and the ones that could not be read as a cassette entry. */
  total: number;
  unreadable: string[];
  byProvider: { nightshift: number; nvidia: number };
  /** Recordings that carry a receipt and whose receipt re-verified against the pinned key. */
  receiptVerified: number;
  /** Recordings that carry a receipt that did not re-verify, with the reason. */
  receiptRejected: { file: string; reason: string }[];
  /** Recordings that carry no receipt at all. */
  withoutReceipt: number;
  /** Models that answered, by the model the signed receipt names (or the stored routed model where there is no receipt). */
  routedModels: Record<string, number>;
  /** Key ids that signed the verified receipts. */
  signingKeyIds: string[];
}

interface StoredEntry {
  role?: unknown;
  response?: {
    requestedModel?: unknown;
    routedModel?: unknown;
    recordedFrom?: unknown;
    receipt?: ComputeReceipt;
  };
}

export function auditCassettes(dir: string, policy: Pick<ReceiptPolicy, "trustedKeyIds" | "allowUnpinnedKey">): CassetteAudit {
  const audit: CassetteAudit = {
    total: 0,
    unreadable: [],
    byProvider: { nightshift: 0, nvidia: 0 },
    receiptVerified: 0,
    receiptRejected: [],
    withoutReceipt: 0,
    routedModels: {},
    signingKeyIds: [],
  };
  if (!existsSync(dir)) return audit;
  const keys = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let entry: StoredEntry;
    try {
      entry = JSON.parse(readFileSync(join(dir, file), "utf8")) as StoredEntry;
    } catch {
      audit.unreadable.push(file);
      continue;
    }
    const r = entry.response;
    if (!r || typeof r.requestedModel !== "string" || typeof r.routedModel !== "string") {
      audit.unreadable.push(file);
      continue;
    }
    audit.total += 1;
    if (r.recordedFrom === "nightshift") audit.byProvider.nightshift += 1;
    else audit.byProvider.nvidia += 1;
    audit.routedModels[r.routedModel] = (audit.routedModels[r.routedModel] ?? 0) + 1;
    if (!r.receipt) {
      audit.withoutReceipt += 1;
      continue;
    }
    const check = verifyStoredReceipt(r.receipt, { requestedModel: r.requestedModel }, policy);
    if (check.ok) {
      audit.receiptVerified += 1;
      keys.add(check.keyId);
    } else {
      audit.receiptRejected.push({ file, reason: check.reason });
    }
  }
  audit.signingKeyIds = [...keys].sort();
  return audit;
}

/**
 * The banner sentence for the run mode, built only from what the audit found. Fully receipted Nightshift recordings read
 * exactly "model answers are replayed from N recordings made through Nightshift (signed receipts)"; any other mix says so.
 */
export function describeAudit(audit: CassetteAudit): string {
  const n = audit.total;
  if (n === 0) return "no model recordings are present";
  if (audit.byProvider.nightshift === n && audit.receiptVerified === n) {
    return `model answers are replayed from ${n} recordings made through Nightshift (signed receipts)`;
  }
  const word = (k: number): string => `${k} recording${k === 1 ? "" : "s"}`;
  const parts: string[] = [];
  if (audit.byProvider.nightshift > 0) parts.push(`${word(audit.byProvider.nightshift)} made through Nightshift`);
  if (audit.byProvider.nvidia > 0) parts.push(`${word(audit.byProvider.nvidia)} made through NVIDIA's API directly, with no receipt`);
  const receipts = audit.receiptVerified === n ? "" : `; ${audit.receiptVerified} of ${n} carry a receipt that re-verified`;
  return `model answers are replayed from ${n} recordings: ${parts.join(" and ")}${receipts}`;
}

/** The second sentence: what was re-checked on every start, so the first one is not taken on trust. */
export function describeAuditChecks(audit: CassetteAudit): string | undefined {
  if (audit.receiptVerified === 0) return undefined;
  const models = Object.entries(audit.routedModels)
    .map(([m, k]) => `${m} x${k}`)
    .join(", ");
  return `${audit.receiptVerified} of ${audit.total} recorded receipts were re-verified when this service started (Ed25519 signature, key id ${audit.signingKeyIds.join(", ")} pinned in data/sample/receipt-key.json, routed model equal to the requested model, no remembered context); answering models: ${models}`;
}
