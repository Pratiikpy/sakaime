/** Wilson score interval for a proportion k/n at 95% confidence. Returns [0, 1] for n = 0 (nothing was measured). */
export function wilson(k: number, n: number, z = 1.959964): { p: number; lo: number; hi: number; k: number; n: number } {
  if (n <= 0) return { p: 0, lo: 0, hi: 1, k, n };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half), k, n };
}

export const fmtRate = (r: { p: number; lo: number; hi: number; k: number; n: number }): string =>
  r.n === 0 ? "n/a (0 measured)" : `${r.k}/${r.n} = ${(r.p * 100).toFixed(1)}% (95% CI ${(r.lo * 100).toFixed(1)} to ${(r.hi * 100).toFixed(1)})`;

export const mean = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
