/**
 * Statistics for the evaluation suites (docs/06-evaluation-protocol.md section 6).
 *
 * Everything here is a pure function of its inputs. Resampling takes an explicit seed so a run can be repeated bit for bit.
 * The functions are checked against published values in tests/evals/stats.test.ts.
 */

// ------------------------------------------------------------------------------------------ seeded random numbers

/** mulberry32: a small, fast generator with a 32-bit state. Good enough for resampling, not for security. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ------------------------------------------------------------------------------------------ proportions

export interface Proportion {
  k: number;
  n: number;
  /** k / n, or NaN when n is 0. */
  rate: number;
  lo: number;
  hi: number;
}

/** Wilson score interval. For n = 0 the interval is the whole of [0, 1]: nothing was observed. */
export function wilson(k: number, n: number, z = 1.959963984540054): Proportion {
  if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n) throw new RangeError(`wilson: invalid counts k=${k} n=${n}`);
  if (n === 0) return { k, n, rate: NaN, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

/**
 * One-sided exact (Clopper-Pearson) upper bound at confidence 1 - alpha, for the case where nothing was observed:
 * 1 - alpha^(1/n). Zero errors in n trials is compatible with a true error rate up to this value.
 */
export function zeroErrorUpperBound(n: number, alpha = 0.05): number {
  if (!Number.isInteger(n) || n < 0) throw new RangeError("zeroErrorUpperBound: n must be a non-negative integer");
  return n === 0 ? 1 : 1 - Math.pow(alpha, 1 / n);
}

// ------------------------------------------------------------------------------------------ exact tests

function logFactorial(n: number): number {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** P(X <= x) for X ~ Binomial(n, 1/2), exact. */
export function binomialHalfCdf(x: number, n: number): number {
  if (x < 0) return 0;
  if (x >= n) return 1;
  let sum = 0;
  for (let i = 0; i <= x; i++) sum += Math.exp(logChoose(n, i) - n * Math.LN2);
  return Math.min(1, sum);
}

export interface McNemar {
  /** Cases the first arm got right and the second wrong. */
  b: number;
  /** Cases the second arm got right and the first wrong. */
  c: number;
  /** Two-sided exact p-value; 1 when there are no discordant pairs. */
  p: number;
}

/** Exact McNemar test on paired binary outcomes, from the two discordant counts. */
export function mcnemarExact(b: number, c: number): McNemar {
  if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0) throw new RangeError("mcnemarExact: counts must be non-negative integers");
  const n = b + c;
  if (n === 0) return { b, c, p: 1 };
  return { b, c, p: Math.min(1, 2 * binomialHalfCdf(Math.min(b, c), n)) };
}

/** McNemar from two parallel arrays of correct / incorrect outcomes (same case order). */
export function mcnemarFromOutcomes(a: readonly boolean[], b: readonly boolean[]): McNemar {
  if (a.length !== b.length) throw new RangeError("mcnemarFromOutcomes: the arms must cover the same cases");
  let onlyA = 0;
  let onlyB = 0;
  for (let i = 0; i < a.length; i++) {
    if (a[i] && !b[i]) onlyA++;
    else if (!a[i] && b[i]) onlyB++;
  }
  return mcnemarExact(onlyA, onlyB);
}

/** Holm-Bonferroni step-down adjusted p-values, returned in the order given. */
export function holm(pvalues: readonly number[]): number[] {
  const m = pvalues.length;
  const order = pvalues.map((p, i) => ({ p, i })).sort((x, y) => x.p - y.p);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, i }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[i] = running;
  });
  return adjusted;
}

// ------------------------------------------------------------------------------------------ clusters

export function clusterCount(rows: readonly { cluster: string }[]): number {
  return new Set(rows.map((r) => r.cluster)).size;
}

/**
 * Effective sample size. The number of clusters is the conservative answer the protocol asks for (cases within one device
 * are not independent). With an intraclass correlation the design-effect form n / (1 + (m - 1) * icc) is also returned,
 * where m is the mean cluster size; icc = 1 gives the cluster count and icc = 0 gives n.
 */
export function effectiveSampleSize(rows: readonly { cluster: string }[], icc?: number): { n: number; clusters: number; meanClusterSize: number; designEffectN?: number } {
  const n = rows.length;
  const clusters = clusterCount(rows);
  const meanClusterSize = clusters === 0 ? 0 : n / clusters;
  const out: { n: number; clusters: number; meanClusterSize: number; designEffectN?: number } = { n, clusters, meanClusterSize };
  if (icc !== undefined) {
    if (icc < 0 || icc > 1) throw new RangeError("effectiveSampleSize: icc must be in [0, 1]");
    out.designEffectN = n === 0 ? 0 : n / (1 + (meanClusterSize - 1) * icc);
  }
  return out;
}

export interface BootstrapInterval {
  estimate: number;
  lo: number;
  hi: number;
  clusters: number;
  resamples: number;
  seed: number;
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return NaN;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const next = sorted[base + 1];
  return next === undefined ? (sorted[base] as number) : (sorted[base] as number) + rest * (next - (sorted[base] as number));
}

/**
 * Percentile cluster bootstrap. Whole clusters are resampled with replacement, so cases from one device move together.
 * `statistic` receives the resampled rows and returns a number, or NaN when it is undefined for that resample (for example
 * a ratio whose denominator is empty); NaN resamples are dropped and `resamples` reports how many were kept.
 */
export function clusterBootstrap<T extends { cluster: string }>(
  rows: readonly T[],
  statistic: (sample: readonly T[]) => number,
  options: { seed: number; resamples?: number; level?: number },
): BootstrapInterval {
  const resamples = options.resamples ?? 2000;
  const level = options.level ?? 0.95;
  const byCluster = new Map<string, T[]>();
  for (const r of rows) {
    const list = byCluster.get(r.cluster);
    if (list) list.push(r);
    else byCluster.set(r.cluster, [r]);
  }
  const keys = [...byCluster.keys()].sort();
  const estimate = statistic(rows);
  if (keys.length === 0) return { estimate, lo: NaN, hi: NaN, clusters: 0, resamples: 0, seed: options.seed };
  const rand = rng(options.seed);
  const draws: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const sample: T[] = [];
    for (let i = 0; i < keys.length; i++) {
      const pick = byCluster.get(keys[Math.floor(rand() * keys.length)] as string) as T[];
      for (const r of pick) sample.push(r);
    }
    const v = statistic(sample);
    if (Number.isFinite(v)) draws.push(v);
  }
  draws.sort((x, y) => x - y);
  const alpha = (1 - level) / 2;
  return { estimate, lo: quantile(draws, alpha), hi: quantile(draws, 1 - alpha), clusters: keys.length, resamples: draws.length, seed: options.seed };
}

/** Paired difference in a binary outcome between two arms (a minus b), with a cluster bootstrap interval. */
export function pairedDifferenceBootstrap(
  rows: readonly { cluster: string; a: boolean; b: boolean }[],
  options: { seed: number; resamples?: number; level?: number },
): BootstrapInterval {
  return clusterBootstrap(
    rows,
    (s) => (s.length === 0 ? NaN : s.filter((r) => r.a).length / s.length - s.filter((r) => r.b).length / s.length),
    options,
  );
}

/** Mean and worst of repeated runs of a model arm (docs/06 section 4). "Worst" is the lowest value when higher is better. */
export function meanAndWorst(values: readonly number[], higherIsBetter = true): { mean: number; worst: number; runs: number } {
  if (values.length === 0) return { mean: NaN, worst: NaN, runs: 0 };
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  return { mean, worst: higherIsBetter ? Math.min(...values) : Math.max(...values), runs: values.length };
}
