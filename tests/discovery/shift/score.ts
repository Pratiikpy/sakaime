/**
 * Scoring for the DiscoveryShift suite. Pure functions over (expected, actual), so the same scorer runs on the pipeline,
 * its ablations and the hardcoded baseline.
 */
export type Label = "mapped" | "held" | "declined";

export interface Expected {
  expect: Label[];
  /** What a registration must contain, as header -> canonical field. */
  mapping?: Record<string, string>;
  /** Pairs that must never appear as accepted fields in a registration. */
  forbid?: [string, string][];
  knownLimit?: string;
}

export interface Actual {
  label: Label;
  /** Fields accepted into the registration (ok or renamed). */
  accepted: Record<string, string>;
}

export type Category =
  | "correct" // an allowed outcome, and when mapped, exactly the expected mapping
  | "false_accept" // registered although the policy says it must not be, or with a forbidden field
  | "wrong_mapping" // registered where mapping was allowed, but the mapping differs from the expected one
  | "false_hold" // should have been mapped, was held
  | "false_decline" // should have been mapped, was declined
  | "over_refusal" // held or declined where the other of the two was the only allowed answer
  | "imprecise"; // not registered, an allowed refusal of the other kind (held vs declined) when only one was listed

const sameMapping = (a: Record<string, string>, b: Record<string, string>): boolean => {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};

export function categorise(e: Expected, a: Actual): { category: Category; detail?: string } {
  const mustMap = e.expect.length === 1 && e.expect[0] === "mapped";
  if (a.label === "mapped") {
    const forbidden = (e.forbid ?? []).find(([h, c]) => a.accepted[h] === c);
    if (forbidden) return { category: "false_accept", detail: `accepted ${forbidden[0]} as ${forbidden[1]}` };
    if (!e.expect.includes("mapped")) return { category: "false_accept", detail: "registered although the policy says the source must not be" };
    if (e.mapping && !sameMapping(e.mapping, a.accepted)) {
      const missing = Object.keys(e.mapping).filter((k) => a.accepted[k] !== e.mapping![k]);
      const extra = Object.keys(a.accepted).filter((k) => !(k in e.mapping!));
      return { category: "wrong_mapping", detail: `missing or different: ${missing.join(", ") || "none"}; extra: ${extra.join(", ") || "none"}` };
    }
    return { category: "correct" };
  }
  if (e.expect.includes(a.label)) return { category: "correct" };
  if (mustMap) return { category: a.label === "held" ? "false_hold" : "false_decline" };
  if (e.expect.length === 1 && e.expect.includes("mapped")) return { category: "over_refusal" };
  // Not registered, and the other refusal was the one listed (or mapped plus the other refusal): still a refusal.
  return { category: e.expect.includes("mapped") ? "correct" : "imprecise", detail: `${a.label} where ${e.expect.join(" or ")} was expected` };
}

/** Wilson score interval, 95%. */
export function wilson(k: number, n: number, z = 1.96): { low: number; high: number } {
  if (n === 0) return { low: 0, high: 1 };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) };
}

export const pctText = (x: number): string => `${(x * 100).toFixed(1)}%`;
export const rate = (k: number, n: number): string => {
  const w = wilson(k, n);
  return `${k}/${n} = ${n ? pctText(k / n) : "n/a"} (95% Wilson ${pctText(w.low)} to ${pctText(w.high)})`;
};
