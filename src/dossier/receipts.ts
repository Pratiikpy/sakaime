/**
 * Compute-receipt coverage (FR-13, C-13).
 *
 * Every model-derived field either traces to a reply that carries a compute receipt or is reported as unreceipted.
 * Coverage is receipted fields over all model-derived fields. With no model-derived fields at all the coverage is
 * null, never 100%: nothing was measured, so nothing is claimed.
 *
 * This module counts receipts. It does not check a receipt's signature, key id or hashes; that belongs to the
 * model layer and is injected into the verifier as `verifyReceipt`.
 */
import type { ModelReply, ReceiptCoverage } from "./schema.ts";

export function computeReceiptCoverage(replies: readonly ModelReply[], modelDerivedFieldIds: readonly string[]): ReceiptCoverage {
  const fieldReplies = new Map<string, ModelReply[]>();
  for (const reply of replies) {
    for (const fieldId of reply.derives) {
      const list = fieldReplies.get(fieldId) ?? [];
      list.push(reply);
      fieldReplies.set(fieldId, list);
    }
  }
  const fieldIds = new Set<string>([...fieldReplies.keys(), ...modelDerivedFieldIds]);

  let receipted = 0;
  let withoutReply = 0;
  const unreceiptedFieldIds: string[] = [];
  for (const fieldId of [...fieldIds].sort()) {
    const sources = fieldReplies.get(fieldId);
    if (!sources || sources.length === 0) {
      withoutReply += 1;
      unreceiptedFieldIds.push(fieldId);
      continue;
    }
    // A field is receipted only if every reply that produced it has a receipt.
    if (sources.every((r) => r.receipt !== undefined)) receipted += 1;
    else unreceiptedFieldIds.push(fieldId);
  }

  const replyReceipted = replies.filter((r) => r.receipt !== undefined).length;
  const total = fieldIds.size;
  return {
    replies: {
      total: replies.length,
      receipted: replyReceipted,
      unreceipted: replies.length - replyReceipted,
      live: replies.filter((r) => r.label === "live").length,
      recorded: replies.filter((r) => r.label === "recorded").length,
      fallback: replies.filter((r) => r.label === "fallback").length,
    },
    fields: { total, receipted, unreceipted: total - receipted, withoutReply },
    coverage: total === 0 ? null : Math.round((receipted / total) * 10000) / 10000,
    unreceiptedReplyIds: replies.filter((r) => r.receipt === undefined).map((r) => r.id).sort(),
    unreceiptedFieldIds,
  };
}

/** The label a reader sees for one reply: where it came from and whether a receipt backs it. */
export function describeReply(reply: Pick<ModelReply, "label" | "receipt">): string {
  const origin = reply.label === "recorded" ? "recorded" : reply.label === "fallback" ? "fallback" : "live";
  return reply.receipt ? `${origin}, receipted` : `${origin}, unreceipted`;
}
