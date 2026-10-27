import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  binomialHalfCdf,
  clusterBootstrap,
  clusterCount,
  effectiveSampleSize,
  holm,
  mcnemarExact,
  mcnemarFromOutcomes,
  meanAndWorst,
  pairedDifferenceBootstrap,
  rng,
  wilson,
  zeroErrorUpperBound,
} from "../../evals/stats/index.ts";

describe("wilson interval against known values", () => {
  it("0 of 10: [0, 0.2775]", () => {
    const w = wilson(0, 10);
    expect(w.lo).toBeCloseTo(0, 6);
    expect(w.hi).toBeCloseTo(0.2775, 4);
  });
  it("5 of 10: [0.2366, 0.7634]", () => {
    const w = wilson(5, 10);
    expect(w.lo).toBeCloseTo(0.2366, 4);
    expect(w.hi).toBeCloseTo(0.7634, 4);
  });
  it("81 of 263: [0.2553, 0.3662] (Newcombe 1998, table 1)", () => {
    const w = wilson(81, 263);
    expect(w.lo).toBeCloseTo(0.2553, 4);
    expect(w.hi).toBeCloseTo(0.3662, 4);
  });
  it("n = 0 gives the whole interval and a NaN rate, not a rate of zero", () => {
    const w = wilson(0, 0);
    expect(Number.isNaN(w.rate)).toBe(true);
    expect([w.lo, w.hi]).toEqual([0, 1]);
  });
  it("rejects impossible counts", () => {
    expect(() => wilson(3, 2)).toThrow(RangeError);
    expect(() => wilson(-1, 2)).toThrow(RangeError);
    expect(() => wilson(1.5, 2)).toThrow(RangeError);
  });
  it("always brackets the observed rate and stays inside [0, 1]", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 400 }).chain((n) => fc.tuple(fc.integer({ min: 0, max: n }), fc.constant(n))), ([k, n]) => {
        const w = wilson(k, n);
        return w.lo >= 0 && w.hi <= 1 && w.lo <= k / n + 1e-12 && w.hi >= k / n - 1e-12;
      }),
    );
  });
});

describe("zero-error upper bound", () => {
  it("the rule of three: about 3 / n for large n", () => {
    expect(zeroErrorUpperBound(100)).toBeCloseTo(0.0295, 4);
    expect(zeroErrorUpperBound(300)).toBeCloseTo(0.00993, 4);
  });
  it("n = 1 leaves the bound at 0.95", () => {
    expect(zeroErrorUpperBound(1)).toBeCloseTo(0.95, 10);
  });
});

describe("exact McNemar", () => {
  it("b = 0, c = 5: p = 0.0625", () => {
    expect(mcnemarExact(0, 5).p).toBeCloseTo(0.0625, 10);
  });
  it("b = 2, c = 8: p = 0.109375", () => {
    expect(mcnemarExact(2, 8).p).toBeCloseTo(0.109375, 10);
  });
  it("balanced discordance gives p = 1, and so does no discordance", () => {
    expect(mcnemarExact(4, 4).p).toBe(1);
    expect(mcnemarExact(0, 0).p).toBe(1);
  });
  it("is symmetric in its arguments", () => {
    fc.assert(fc.property(fc.nat(60), fc.nat(60), (b, c) => Math.abs(mcnemarExact(b, c).p - mcnemarExact(c, b).p) < 1e-12));
  });
  it("counts discordant pairs from outcome vectors and refuses mismatched lengths", () => {
    const r = mcnemarFromOutcomes([true, true, false, false, true], [true, false, true, false, false]);
    expect([r.b, r.c]).toEqual([2, 1]);
    expect(() => mcnemarFromOutcomes([true], [true, false])).toThrow(RangeError);
  });
  it("binomial CDF matches a hand sum", () => {
    expect(binomialHalfCdf(2, 10)).toBeCloseTo((1 + 10 + 45) / 1024, 12);
    expect(binomialHalfCdf(10, 10)).toBe(1);
    expect(binomialHalfCdf(-1, 10)).toBe(0);
  });
});

describe("Holm correction", () => {
  it("[0.01, 0.04, 0.03] gives [0.03, 0.06, 0.06]", () => {
    const h = holm([0.01, 0.04, 0.03]);
    expect(h[0]).toBeCloseTo(0.03, 12);
    expect(h[1]).toBeCloseTo(0.06, 12);
    expect(h[2]).toBeCloseTo(0.06, 12);
  });
  it("never lowers a p-value and never exceeds 1", () => {
    fc.assert(
      fc.property(fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { minLength: 1, maxLength: 12 }), (ps) => {
        const adj = holm(ps);
        return adj.every((a, i) => a >= ps[i]! - 1e-12 && a <= 1 + 1e-12);
      }),
    );
  });
  it("a single test is unchanged", () => {
    expect(holm([0.2])).toEqual([0.2]);
  });
});

describe("cluster bootstrap", () => {
  const rows = [
    ...Array.from({ length: 6 }, () => ({ cluster: "a", ok: 1 })),
    ...Array.from({ length: 6 }, () => ({ cluster: "b", ok: 0 })),
    ...Array.from({ length: 2 }, () => ({ cluster: "c", ok: 1 })),
  ];
  const mean = (s: readonly { ok: number }[]) => s.reduce((t, r) => t + r.ok, 0) / s.length;

  it("is repeatable for a seed and differs for another", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ cluster: `c${i}`, ok: i % 3 === 0 ? 1 : 0 }));
    const x = clusterBootstrap(many, mean, { seed: 7, resamples: 500 });
    const y = clusterBootstrap(many, mean, { seed: 7, resamples: 500 });
    const z = clusterBootstrap(many, mean, { seed: 8, resamples: 500 });
    expect(x).toEqual(y);
    expect(z.lo === x.lo && z.hi === x.hi).toBe(false);
  });
  it("is wider with three clusters than the naive interval over the same fourteen cases", () => {
    const b = clusterBootstrap(rows, mean, { seed: 1, resamples: 2000 });
    const naive = wilson(rows.filter((r) => r.ok === 1).length, rows.length);
    expect(b.clusters).toBe(3);
    expect(b.hi - b.lo).toBeGreaterThan(naive.hi - naive.lo);
  });
  it("a constant outcome gives a degenerate interval", () => {
    const b = clusterBootstrap([{ cluster: "a", ok: 1 }, { cluster: "b", ok: 1 }], mean, { seed: 3, resamples: 200 });
    expect([b.lo, b.hi]).toEqual([1, 1]);
  });
  it("empty input does not throw and reports no clusters", () => {
    const b = clusterBootstrap<{ cluster: string; ok: number }>([], mean, { seed: 3 });
    expect(b.clusters).toBe(0);
    expect(Number.isNaN(b.lo)).toBe(true);
  });
  it("drops resamples where the statistic is undefined and says how many were kept", () => {
    const sparse = [{ cluster: "a", ok: 1 }, { cluster: "b", ok: 0 }];
    const b = clusterBootstrap(sparse, (s) => (s.some((r) => r.cluster === "a") && s.some((r) => r.cluster === "b") ? 0.5 : NaN), { seed: 5, resamples: 400 });
    expect(b.resamples).toBeLessThan(400);
    expect(b.resamples).toBeGreaterThan(0);
  });
  it("paired difference of identical arms is exactly zero", () => {
    const paired = rows.map((r) => ({ cluster: r.cluster, a: r.ok === 1, b: r.ok === 1 }));
    const d = pairedDifferenceBootstrap(paired, { seed: 2, resamples: 300 });
    expect([d.estimate, d.lo, d.hi]).toEqual([0, 0, 0]);
  });
});

describe("effective sample size and run summaries", () => {
  it("counts clusters, not cases", () => {
    const rs = ["a", "a", "a", "b", "c", "c"].map((cluster) => ({ cluster }));
    expect(clusterCount(rs)).toBe(3);
    expect(effectiveSampleSize(rs).clusters).toBe(3);
  });
  it("design-effect form: icc 1 gives the cluster count, icc 0 gives n", () => {
    const rs = ["a", "a", "a", "a", "b", "b", "b", "b"].map((cluster) => ({ cluster }));
    expect(effectiveSampleSize(rs, 1).designEffectN).toBeCloseTo(2, 10);
    expect(effectiveSampleSize(rs, 0).designEffectN).toBeCloseTo(8, 10);
    expect(() => effectiveSampleSize(rs, 1.5)).toThrow(RangeError);
  });
  it("mean and worst of repeated runs", () => {
    expect(meanAndWorst([0.8, 0.6, 0.7])).toMatchObject({ worst: 0.6, runs: 3 });
    expect(meanAndWorst([0.8, 0.6, 0.7]).mean).toBeCloseTo(0.7, 12);
    expect(meanAndWorst([0.1, 0.3], false).worst).toBe(0.3);
    expect(meanAndWorst([]).runs).toBe(0);
  });
  it("the generator is deterministic and stays in [0, 1)", () => {
    const a = rng(42);
    const b = rng(42);
    for (let i = 0; i < 100; i++) {
      const x = a();
      expect(x).toBe(b());
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
    }
  });
});
