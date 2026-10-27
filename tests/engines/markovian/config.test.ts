import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { ConfigValidationError, modelTotals, projectionCurve, resolveConfig, runEfficiency, materialBudgetTokens } from "../../../src/engines/markovian/index.ts";

describe("config validation: typed rejection, never clamping", () => {
  it("accepts the documented defaults", () => {
    expect(resolveConfig()).toEqual({ chunkSize: 8000, maxChunks: 24, carryoverTokens: 800, overlapTokens: 0 });
  });

  it.each([
    [{ chunkSize: 999 }, "chunkSize"],
    [{ chunkSize: 128001 }, "chunkSize"],
    [{ maxChunks: 0 }, "maxChunks"],
    [{ maxChunks: 33 }, "maxChunks"],
    [{ carryoverTokens: 127 }, "carryoverTokens"],
    [{ carryoverTokens: 32769, chunkSize: 128000 }, "carryoverTokens"],
    [{ overlapTokens: -1 }, "overlapTokens"],
    [{ overlapTokens: 4097 }, "overlapTokens"],
    [{ chunkSize: Number.NaN }, "chunkSize"],
    [{ maxChunks: Number.POSITIVE_INFINITY }, "maxChunks"],
    [{ maxChunks: 2.5 }, "maxChunks"],
  ])("rejects %j", (partial, field) => {
    try {
      resolveConfig(partial);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigValidationError);
      expect((err as ConfigValidationError).field).toBe(field);
    }
  });

  it("enforces chunkSize >= 400 + carryover + 1200 exactly at the boundary", () => {
    expect(() => resolveConfig({ chunkSize: 2400, carryoverTokens: 800 })).not.toThrow();
    expect(() => resolveConfig({ chunkSize: 2399, carryoverTokens: 800 })).toThrow(ConfigValidationError);
    expect(() => resolveConfig({ chunkSize: 4000, carryoverTokens: 2400 })).not.toThrow();
    expect(() => resolveConfig({ chunkSize: 4000, carryoverTokens: 2401 })).toThrow(/below framing/);
  });

  it("ignores undefined fields instead of letting them erase defaults", () => {
    expect(resolveConfig({ chunkSize: undefined, carryoverTokens: 640 }).chunkSize).toBe(8000);
  });

  it("property: every accepted config satisfies the chunk size rule and the bounds", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 200000 }), fc.integer({ min: 0, max: 40000 }), fc.integer({ min: 0, max: 40 }), fc.integer({ min: -5, max: 5000 }), (chunkSize, carryoverTokens, maxChunks, overlapTokens) => {
        try {
          const c = resolveConfig({ chunkSize, carryoverTokens, maxChunks, overlapTokens });
          expect(c.chunkSize).toBeGreaterThanOrEqual(400 + c.carryoverTokens + 1200);
          expect(c.maxChunks).toBeGreaterThanOrEqual(1);
          expect(c.maxChunks).toBeLessThanOrEqual(32);
          expect(c.overlapTokens).toBeGreaterThanOrEqual(0);
        } catch (err) {
          expect(err).toBeInstanceOf(ConfigValidationError);
        }
      }),
      { numRuns: 400 },
    );
  });

  it("material budget is what is left after framing, carryover, answer room and overlap", () => {
    const c = resolveConfig({ chunkSize: 8000, carryoverTokens: 800, overlapTokens: 100 });
    expect(materialBudgetTokens(c)).toBe(8000 - 400 - 800 - 1200 - 100);
    expect(materialBudgetTokens(c, 900)).toBe(8000 - 900 - 800 - 1200 - 100);
  });
});

describe("efficiency math", () => {
  it("reproduces the documented worked example", () => {
    const m = modelTotals(20);
    expect(m.naiveTotal).toBe(246000);
    expect(m.markovianTotal).toBe(34000);
    expect(m.efficiency * 100).toBeCloseTo(86.18, 1);
  });

  it("break-even: a chain of one step saves nothing, a long chain saves a lot", () => {
    expect(modelTotals(1).savings).toBeLessThan(0);
    expect(modelTotals(30).efficiency).toBeGreaterThan(0.9);
  });

  it("runEfficiency uses prefix sums for the standard cost and the snapshot for the carryover", () => {
    const chunks = [1, 2, 3, 4].map((id) => ({ id, tokens: 1000 }));
    const a = runEfficiency(chunks, resolveConfig({ carryoverTokens: 512 }));
    expect(a.standardCost).toBe(10000);
    expect(a.markovianCost).toBe(4 * 512 + 4000);
    const b = runEfficiency(chunks, resolveConfig({ carryoverTokens: 2048, chunkSize: 8000 }));
    expect(b.tokensSaved).not.toBe(a.tokensSaved);
  });

  it("never reports negative savings, and handles an empty run", () => {
    expect(runEfficiency([{ tokens: 10 }], resolveConfig()).tokensSaved).toBe(0);
    expect(runEfficiency([], resolveConfig())).toMatchObject({ totalTokensUsed: 0, efficiencyPercent: 0 });
  });

  it("projection curve: standard grows, Markovian stays flat", () => {
    const curve = projectionCurve(resolveConfig(), 6);
    expect(new Set(curve.map((p) => p.markovian)).size).toBe(1);
    expect(curve[5]!.standard).toBeGreaterThan(curve[0]!.standard);
  });
});
