/** Wilson score interval for k successes in n trials at 95% confidence. With n = 0 nothing was measured and the interval is [0, 1]. */
export interface Rate {
  k: number;
  n: number;
  p: number;
  lo: number;
  hi: number;
}

export function wilson(k: number, n: number, z = 1.959964): Rate {
  if (n <= 0) return { k, n, p: 0, lo: 0, hi: 1 };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export const fmt = (r: Rate): string => (r.n === 0 ? "n/a (0 in scope)" : `${r.k}/${r.n} = ${pct(r.p)} (95% CI ${pct(r.lo)} to ${pct(r.hi)})`);
