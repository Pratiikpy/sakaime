import { describe, expect, it } from "vitest";
import { buildCorpus, buildDocument } from "../../../src/engines/markovian/ablation/corpus.ts";
import { ARMS, formatMA3, runMA3, scoreFacts } from "../../../src/engines/markovian/ablation/ma3.ts";
import { HarnessChatPort } from "../../../src/engines/markovian/ablation/harnessPort.ts";
import { fmtRate, wilson } from "../../../src/engines/markovian/ablation/stats.ts";
import { normaliseForMatch, type LedgerFact } from "../../../src/engines/markovian/index.ts";
import { PortError } from "../../../src/ports/index.ts";
import { RuleModel } from "./support/ruleModel.ts";

describe("planted-restriction corpus", () => {
  const docs = buildCorpus(12, { seed: 4242, pages: 60 });

  it("is deterministic for a seed and different across seeds", () => {
    expect(buildDocument({ seed: 7 })).toEqual(buildDocument({ seed: 7 }));
    expect(buildDocument({ seed: 7 }).pages[10]!.text).not.toBe(buildDocument({ seed: 8 }).pages[10]!.text);
  });

  it("is labelled constructed and long enough that one prompt cannot hold it", () => {
    for (const d of docs) {
      expect(d.constructed).toBe(true);
      expect(d.pages).toHaveLength(60);
      expect(d.bytes).toBeGreaterThan(100_000);
    }
  });

  it("plants exactly one restriction sentence, on the stated page, deep in the text and past the 32 KB mark", () => {
    for (const d of docs) {
      const hits = d.pages.filter((p) => p.text.includes(d.restriction.sentence));
      expect(hits.map((p) => p.page)).toEqual([d.restriction.page]);
      expect(d.restriction.page / d.pages.length).toBeGreaterThanOrEqual(0.55);
      const before = d.pages.slice(0, d.restriction.page - 1).reduce((s, p) => s + Buffer.byteLength(p.text, "utf8"), 0);
      expect(before).toBeGreaterThan(32 * 1024);
    }
  });

  it("states no scope bound in the indication, so the restriction is not redundant with an early page", () => {
    for (const d of docs) {
      const early = normaliseForMatch(d.pages.slice(0, 3).map((p) => p.text).join(" "));
      expect(early).not.toMatch(/not indicated for patients|under \d\d years|younger than/);
    }
  });

  it("puts the other planted facts where it says they are", () => {
    for (const d of docs) {
      for (const f of d.planted) {
        const text = d.pages[f.page - 1]!.text.replace(/,/g, "");
        for (const k of f.keys) expect(text.toLowerCase(), `${d.id} ${f.field}`).toContain(k.toLowerCase());
      }
    }
  });

  it("has decoy pages that reuse the restriction's key without being the restriction", () => {
    for (const d of docs) {
      expect(d.decoyPages.length).toBeGreaterThan(0);
      for (const p of d.decoyPages) {
        expect(p).not.toBe(d.restriction.page);
        expect(d.pages[p - 1]!.text).not.toContain(d.restriction.sentence);
      }
    }
  });

  it("covers every restriction kind across seeds", () => {
    const kinds = new Set(buildCorpus(60, { seed: 1, pages: 30 }).map((d) => d.restriction.kind));
    expect([...kinds].sort()).toEqual(["age", "camera", "condition", "setting", "version"]);
  });
});

describe("scoring", () => {
  const d = buildDocument({ seed: 99, pages: 40 });
  const fact = (page: number, quote: string, value: string, field: LedgerFact["field"] = "limitation"): LedgerFact => ({ id: "F1", field, value, anchors: [{ page, quote, step: 1 }], relations: [] });

  it("counts the restriction only on its own page, and reports a copy found elsewhere separately", () => {
    const right = scoreFacts(d, [fact(d.restriction.page, d.restriction.sentence, d.restriction.sentence)]);
    expect(right.restrictionFound).toBe(true);
    const wrong = scoreFacts(d, [fact(2, d.restriction.sentence, d.restriction.sentence)]);
    expect(wrong.restrictionFound).toBe(false);
    expect(wrong.restrictionElsewhere).toBe(true);
  });

  it("counts a restriction-type fact anchored on a decoy page as a confusion, not a find", () => {
    const decoyPage = d.decoyPages[0]!;
    const s = scoreFacts(d, [fact(decoyPage, "decoy text", `under ${d.restriction.keys[0]}`)]);
    expect(s.decoyHits).toBe(1);
    expect(s.restrictionFound).toBe(false);
  });
});

describe("statistics", () => {
  it("Wilson interval matches known values and handles n = 0", () => {
    const w = wilson(8, 10);
    expect(w.lo).toBeCloseTo(0.4902, 3);
    expect(w.hi).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 0)).toMatchObject({ lo: 0, hi: 1 });
    expect(wilson(10, 10).hi).toBeCloseTo(1, 10);
    expect(fmtRate(wilson(0, 0))).toContain("n/a");
  });
});

describe("MA-3 harness with the rule-based test double (validates the harness, measures no model)", () => {
  const documents = buildCorpus(6, { seed: 2026, pages: 60 });

  it("the chunked reader reaches every planted restriction; one truncated prompt reaches none; context cost is lower than a full prompt", async () => {
    const report = await runMA3({ model: new RuleModel(), modelLabel: "test double", live: false, documents, fullContextMaxBytes: 400_000, retryDelayMs: 0, chunk: { chunkSize: 8000, carryoverTokens: 800 } });
    const by = Object.fromEntries(report.summaries.map((s) => [s.arm, s]));
    expect(report.summaries.map((s) => s.arm)).toEqual([...ARMS]);

    expect(by.markovian!.restrictionRecallAll).toMatchObject({ k: 6, n: 6 });
    expect(by.markovian_no_carryover!.restrictionRecallAll).toMatchObject({ k: 6, n: 6 });
    expect(by.single_full!.restrictionRecallAll).toMatchObject({ k: 6, n: 6 });
    expect(by.single_truncated!.restrictionRecallAll).toMatchObject({ k: 0, n: 6 });
    expect(by.markovian!.plantedFactRecall.p).toBe(1);
    expect(by.single_truncated!.plantedFactRecall.p).toBeLessThan(1);
    expect(by.markovian!.decoyHits).toBe(0);

    // context cost: the chunked reader never sends more than one chunk's worth; the full prompt sends the document
    expect(by.markovian!.meanPromptTokensPeak).toBeLessThan(by.single_full!.meanPromptTokensPeak / 3);
    expect(by.single_truncated!.meanPromptBytesPeak).toBeLessThanOrEqual(32 * 1024);
    expect(by.markovian!.meanPromptBytesPeak).toBeLessThanOrEqual(32 * 1024);
    expect(by.single_full!.meanPromptBytesPeak).toBeGreaterThan(100_000);
    expect(by.markovian!.tokenLabel).toBe("measured");
    expect(formatMA3(report)).toContain("TEST DOUBLE");
  });

  it("does not run the full-context arm past its size limit and says so, rather than scoring it", async () => {
    const report = await runMA3({ model: new RuleModel(), modelLabel: "test double", live: false, documents: documents.slice(0, 2), arms: ["single_full"], fullContextMaxBytes: 50_000, retryDelayMs: 0 });
    expect(report.results.every((r) => r.status === "NOT_RUN")).toBe(true);
    expect(report.results[0]!.reason).toMatch(/over the 50000-byte/);
    expect(report.summaries[0]!.restrictionRecallAll).toMatchObject({ n: 0 });
  });

  it("a failed call is a failure, not a miss: it is counted separately and left out of the completed recall", async () => {
    const down = { complete: async () => { throw new PortError("UNAVAILABLE", "down"); } };
    const report = await runMA3({ model: down, modelLabel: "down", live: false, documents: documents.slice(0, 2), arms: ["single_truncated", "markovian"], retryDelayMs: 0 });
    for (const s of report.summaries) {
      expect(s.failed).toBe(2);
      expect(s.completed).toBe(0);
      expect(s.restrictionRecallCompleted).toMatchObject({ n: 0 });
    }
  });
});

describe("the live harness port", () => {
  const port = (fetchImpl: typeof fetch) => new HarnessChatPort({ apiKey: "test-key-not-real", baseUrl: "https://example.invalid/v1", model: "m", fetchImpl });
  const req = { role: "reader", system: "s", user: "u", dataClass: "public" as const, memoryScope: "x" };
  const json = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

  it("reads content and measured usage", async () => {
    const r = await port(json(200, { model: "served", choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 12, completion_tokens: 3 } })).complete(req);
    expect(r).toMatchObject({ text: "{}", routedModel: "served", provider: "nvidia", usage: { promptTokens: 12, completionTokens: 3, measured: true } });
  });

  it("classifies failures and never retries a rejected request as if it were transient", async () => {
    const f = async (status: number) => port(json(status, { error: "x" })).complete(req).catch((e: PortError) => e.failure);
    expect(await f(429)).toBe("UNAVAILABLE");
    expect(await f(503)).toBe("UNAVAILABLE");
    expect(await f(401)).toBe("FORBIDDEN");
    expect(await f(400)).toBe("BLOCKED");
    expect(await port((async () => { throw new TypeError("network"); }) as unknown as typeof fetch).complete(req).catch((e: PortError) => e.failure)).toBe("UNAVAILABLE");
    expect(await port(json(200, { choices: [{ message: { content: null } }] })).complete(req).catch((e: PortError) => e.failure)).toBe("INVALID");
  });

  it("does not put the key anywhere but the authorization header", async () => {
    let seen: RequestInit | undefined;
    const p = port((async (_u: unknown, init?: RequestInit) => { seen = init; return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }] }), { status: 200 }); }) as unknown as typeof fetch);
    await p.complete(req);
    expect(String(seen?.body)).not.toContain("test-key-not-real");
    expect((seen?.headers as Record<string, string>).authorization).toBe("Bearer test-key-not-real");
  });
});
