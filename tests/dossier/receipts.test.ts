import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { computeReceiptCoverage, describeReply, federationQueryFromResult, modelReplyFromResponse, snapshotFromRecord } from "../../src/dossier/index.ts";
import type { ModelReply } from "../../src/dossier/index.ts";
import type { FederationResult, ModelResponse } from "../../src/ports/index.ts";
import { sha256Hex } from "../../src/util/canonical.ts";

const reply = (id: string, over: Partial<ModelReply> = {}): ModelReply => ({
  id,
  at: "2026-10-27T12:00:00.000Z",
  role: "extractor",
  requestedModel: "m",
  routedModel: "m",
  provider: "nightshift",
  recorded: false,
  label: "live",
  dataClass: "public",
  textHash: "a".repeat(64),
  usage: { measured: true },
  derives: [],
  inputRecordIds: [],
  ...over,
});
const receipt = { receiptId: "r", routedModel: "m", raw: {} };

describe("receipt coverage arithmetic", () => {
  it("is receipted fields over all model-derived fields", () => {
    const cov = computeReceiptCoverage(
      [reply("m1", { receipt, derives: ["a", "b", "c"] }), reply("m2", { derives: ["d"] }), reply("m3", { receipt, derives: ["e"] })],
      ["a", "b", "c", "d", "e"],
    );
    expect(cov.fields).toEqual({ total: 5, receipted: 4, unreceipted: 1, withoutReply: 0 });
    expect(cov.coverage).toBe(0.8);
    expect(cov.replies).toMatchObject({ total: 3, receipted: 2, unreceipted: 1, live: 3, recorded: 0 });
    expect(cov.unreceiptedReplyIds).toEqual(["m2"]);
    expect(cov.unreceiptedFieldIds).toEqual(["d"]);
  });

  it("is null, not 100%, when nothing is model-derived", () => {
    expect(computeReceiptCoverage([], []).coverage).toBeNull();
    expect(computeReceiptCoverage([reply("m1", { receipt })], []).coverage).toBeNull();
  });

  it("counts a model-derived field no reply accounts for as unreceipted and says so", () => {
    const cov = computeReceiptCoverage([reply("m1", { receipt, derives: ["a"] })], ["a", "ghost"]);
    expect(cov.fields).toEqual({ total: 2, receipted: 1, unreceipted: 1, withoutReply: 1 });
    expect(cov.coverage).toBe(0.5);
    expect(cov.unreceiptedFieldIds).toEqual(["ghost"]);
  });

  it("treats a field produced by two replies as receipted only if both carry receipts", () => {
    const cov = computeReceiptCoverage([reply("m1", { receipt, derives: ["a"] }), reply("m2", { derives: ["a"] })], ["a"]);
    expect(cov.fields.receipted).toBe(0);
    expect(cov.coverage).toBe(0);
  });

  it("separates live, recorded and fallback replies", () => {
    const cov = computeReceiptCoverage(
      [reply("m1", { receipt }), reply("m2", { label: "recorded", recorded: true, provider: "recorded" }), reply("m3", { label: "fallback" })],
      [],
    );
    expect(cov.replies).toMatchObject({ total: 3, live: 1, recorded: 1, fallback: 1 });
  });

  it("is always between 0 and 1, rounds to four decimals and never counts a field twice (property)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ hasReceipt: fc.boolean(), fields: fc.array(fc.integer({ min: 0, max: 9 }), { maxLength: 4 }) }), { maxLength: 8 }),
        fc.array(fc.integer({ min: 0, max: 12 }), { maxLength: 6 }),
        (replySpecs, extra) => {
          const replies = replySpecs.map((s, i) => reply(`m${i}`, { ...(s.hasReceipt ? { receipt } : {}), derives: s.fields.map((f) => `f${f}`) }));
          const cov = computeReceiptCoverage(replies, extra.map((f) => `f${f}`));
          const all = new Set([...replies.flatMap((r) => r.derives), ...extra.map((f) => `f${f}`)]);
          expect(cov.fields.total).toBe(all.size);
          expect(cov.fields.receipted + cov.fields.unreceipted).toBe(cov.fields.total);
          if (cov.coverage !== null) {
            expect(cov.coverage).toBeGreaterThanOrEqual(0);
            expect(cov.coverage).toBeLessThanOrEqual(1);
            expect(cov.coverage).toBe(Math.round((cov.fields.receipted / cov.fields.total) * 10000) / 10000);
          } else {
            expect(cov.fields.total).toBe(0);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it("describes a reply by origin and receipt", () => {
    expect(describeReply(reply("m", { receipt }))).toBe("live, receipted");
    expect(describeReply(reply("m", { label: "recorded", recorded: true }))).toBe("recorded, unreceipted");
    expect(describeReply(reply("m", { label: "fallback" }))).toBe("fallback, unreceipted");
  });
});

describe("records built from the ports' own objects", () => {
  it("labels a model response by whether it was replayed and keeps its receipt", () => {
    const live: ModelResponse = { text: "hello", requestedModel: "a", routedModel: "b", provider: "nightshift", usage: { measured: true, promptTokens: 3 }, receipt: { receiptId: "r1", routedModel: "b", raw: { x: 1 } }, recorded: false };
    const rec = modelReplyFromResponse(live, { id: "m1", at: "2026-10-27T12:00:00.000Z", role: "extractor", dataClass: "public", derives: ["asr-1"] });
    expect(rec).toMatchObject({ label: "live", recorded: false, textHash: sha256Hex("hello"), derives: ["asr-1"], receipt: { receiptId: "r1" } });
    const replayed = modelReplyFromResponse({ ...live, provider: "recorded", recorded: true, receipt: undefined }, { id: "m2", at: "2026-10-27T12:00:00.000Z", role: "extractor", dataClass: "public" });
    expect(replayed).toMatchObject({ label: "recorded", recorded: true });
    expect("receipt" in replayed).toBe(false);
  });

  it("labels a federation result by where it was served from and keeps the result only on request", () => {
    const result: FederationResult = { columns: [{ name: "n", type: "string" }], rows: [{ n: "1" }], total: 1, queryId: "q1", servedFrom: "cassette", respHash: "b".repeat(64), elapsedMs: 4 };
    const context = { statement: "SELECT 1", at: "2026-10-27T12:00:00.000Z", sourceIds: ["s1"] };
    const without = federationQueryFromResult(result, context);
    expect(without).toMatchObject({ label: "recorded", rowCount: 1, total: 1, servedFrom: "cassette" });
    expect(without.result).toBeUndefined();
    const withRows = federationQueryFromResult(result, { ...context, keepResult: true });
    expect(withRows.result?.rows).toEqual([{ n: "1" }]);
    expect(withRows.resultDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(federationQueryFromResult({ ...result, servedFrom: "live" }, context).label).toBe("live");
    expect(federationQueryFromResult({ ...result, servedFrom: "fallback" }, context).label).toBe("fallback");
  });

  it("builds a snapshot whose text hash is the hash of its text", () => {
    const s = snapshotFromRecord({
      record: { id: "r", sourceId: "s", retrievedAt: "2026-10-27T12:00:00.000Z", requestHash: "c".repeat(64), contentHash: sha256Hex("body"), schemaVersion: "1", license: "x" },
      text: "body",
      contentKind: "text",
    });
    expect(s.textHash).toBe(s.contentHash);
  });
});
