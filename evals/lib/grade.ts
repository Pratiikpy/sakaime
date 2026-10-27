/**
 * Graders and metrics for the ScopeShift suites (docs/06 sections 4 to 6).
 *
 * The primary metrics are always reported together: false-supported rate, critical-mismatch recall, false-alarm rate and
 * correct-SUPPORTED rate. A system that refuses everything has a false-supported rate of zero and a false-alarm rate of one.
 */
import { clusterBootstrap, effectiveSampleSize, wilson, zeroErrorUpperBound, type BootstrapInterval, type Proportion } from "../stats/index.ts";
import type { ArmOutput, CaseKey, EvalCase, Label } from "./types.ts";
import { ABSTAIN_LABELS } from "./types.ts";

export interface CaseScore {
  id: string;
  cluster: string;
  kind: EvalCase["kind"];
  contestable: boolean;
  expected: Label;
  emitted: Label | null;
  status: ArmOutput["status"];
  exact: boolean;
  acceptable: boolean;
  falseSupported: boolean;
  correctSupported: boolean;
  falseAlarm: boolean;
  /** The key withholds support or is contestable, so abstaining is the right behaviour. */
  abstentionCase: boolean;
  abstained: boolean;
  keyMismatches: number;
  /** Key mismatches named with the right dimension. */
  dimensionNamed: number;
  /** Key mismatches named with the right dimension, both values present, and a valid anchor. */
  fullyNamed: number;
  /** All the key's dimensions fully named. */
  allFullyNamed: boolean;
  /** Share of the case's cited anchors that are valid (V only; undefined when nothing was cited). */
  anchorsValid?: boolean;
}

const supports = (l: Label | null): boolean => l === "SUPPORTED_FOR_SCOPE" || l === "SUPPORTED_ONLY_FOR_NARROWER_SCOPE";

export function scoreCase(c: Pick<EvalCase, "id" | "cluster" | "kind"> & { key: CaseKey }, out: ArmOutput): CaseScore {
  const { key } = c;
  const emitted = out.status === "ok" ? out.label : null;
  const exact = emitted === key.expectedLabel;
  const acceptable = exact || (emitted !== null && key.acceptableLabels.includes(emitted));
  const falseSupported = (emitted === "SUPPORTED_FOR_SCOPE" && key.expectedLabel !== "SUPPORTED_FOR_SCOPE") || (emitted === "SUPPORTED_ONLY_FOR_NARROWER_SCOPE" && !supports(key.expectedLabel));
  const abstentionCase = key.keyConfidence === "contestable" || ABSTAIN_LABELS.includes(key.expectedLabel);
  let dimensionNamed = 0;
  let fullyNamed = 0;
  for (const km of key.mismatches) {
    const hit = out.mismatches.filter((m) => m.dimension === km.dimension);
    if (hit.length > 0) dimensionNamed++;
    if (hit.some((m) => !!m.claimed && !!m.established && m.anchored)) fullyNamed++;
  }
  return {
    id: c.id,
    cluster: c.cluster,
    kind: c.kind,
    contestable: key.keyConfidence === "contestable",
    expected: key.expectedLabel,
    emitted,
    status: out.status,
    exact,
    acceptable,
    falseSupported,
    correctSupported: emitted === "SUPPORTED_FOR_SCOPE" && key.expectedLabel === "SUPPORTED_FOR_SCOPE",
    falseAlarm: key.expectedLabel === "SUPPORTED_FOR_SCOPE" && emitted !== "SUPPORTED_FOR_SCOPE",
    abstentionCase,
    abstained: emitted !== null && ABSTAIN_LABELS.includes(emitted),
    keyMismatches: key.mismatches.length,
    dimensionNamed,
    fullyNamed,
    allFullyNamed: key.mismatches.length > 0 && fullyNamed === key.mismatches.length,
  };
}

export interface Rate extends Proportion {
  /** Cluster bootstrap interval over devices, when there are at least two clusters. */
  cluster?: BootstrapInterval;
  /** For zero observed events: the exact one-sided 95% upper bound. */
  zeroUpper?: number;
}

function rateOf(rows: readonly CaseScore[], pick: (r: CaseScore) => boolean, inDenominator: (r: CaseScore) => boolean, seed: number): Rate {
  const denom = rows.filter(inDenominator);
  const k = denom.filter(pick).length;
  const w = wilson(k, denom.length);
  const out: Rate = { ...w };
  if (k === 0 && denom.length > 0) out.zeroUpper = zeroErrorUpperBound(denom.length);
  if (denom.length > 0 && new Set(denom.map((r) => r.cluster)).size >= 2) {
    out.cluster = clusterBootstrap(denom, (s) => (s.length === 0 ? NaN : s.filter(pick).length / s.length), { seed, resamples: 2000 });
  }
  return out;
}

export interface ArmSummary {
  n: number;
  clusters: number;
  effective: ReturnType<typeof effectiveSampleSize>;
  /** Exact label match over all cases. */
  exact: Rate;
  acceptable: Rate;
  exactClear: Rate;
  exactContestable: Rate;
  /** Primary 1: over cases whose key withholds full support. */
  falseSupported: Rate;
  /** Primary 2: key mismatches named with dimension, both values and a valid anchor. */
  criticalMismatchRecall: Rate;
  criticalMismatchDimensionRecall: Rate;
  /** Primary 3: over positive controls. */
  falseAlarm: Rate;
  correctSupported: Rate;
  correctAbstention: Rate;
  noVerdict: { k: number; n: number };
  /** Counts of emitted labels, to make a constant predictor visible. */
  emittedLabels: Record<string, number>;
}

export function summarise(rows: readonly CaseScore[], seed = 20261027): ArmSummary {
  const mismatchRows = rows.filter((r) => r.keyMismatches > 0);
  const recallBy = (pick: (r: CaseScore) => number): Rate => {
    const total = mismatchRows.reduce((s, r) => s + r.keyMismatches, 0);
    const k = mismatchRows.reduce((s, r) => s + pick(r), 0);
    const base: Rate = { ...wilson(k, total) };
    if (k === 0 && total > 0) base.zeroUpper = zeroErrorUpperBound(total);
    return base;
  };
  const emittedLabels: Record<string, number> = {};
  for (const r of rows) emittedLabels[r.emitted ?? "NONE"] = (emittedLabels[r.emitted ?? "NONE"] ?? 0) + 1;
  return {
    n: rows.length,
    clusters: new Set(rows.map((r) => r.cluster)).size,
    effective: effectiveSampleSize(rows),
    exact: rateOf(rows, (r) => r.exact, () => true, seed),
    acceptable: rateOf(rows, (r) => r.acceptable, () => true, seed + 1),
    exactClear: rateOf(rows, (r) => r.exact, (r) => !r.contestable, seed + 2),
    exactContestable: rateOf(rows, (r) => r.exact, (r) => r.contestable, seed + 3),
    falseSupported: rateOf(rows, (r) => r.falseSupported, (r) => r.expected !== "SUPPORTED_FOR_SCOPE", seed + 4),
    criticalMismatchRecall: recallBy((r) => r.fullyNamed),
    criticalMismatchDimensionRecall: recallBy((r) => r.dimensionNamed),
    falseAlarm: rateOf(rows, (r) => r.falseAlarm, (r) => r.expected === "SUPPORTED_FOR_SCOPE", seed + 5),
    correctSupported: rateOf(rows, (r) => r.correctSupported, (r) => r.expected === "SUPPORTED_FOR_SCOPE", seed + 6),
    correctAbstention: rateOf(rows, (r) => r.abstained, (r) => r.abstentionCase, seed + 7),
    noVerdict: { k: rows.filter((r) => r.status !== "ok").length, n: rows.length },
    emittedLabels,
  };
}

/** Per-case correctness vectors for paired tests, in a fixed case order. */
export function exactVector(order: readonly string[], rows: readonly CaseScore[]): boolean[] {
  const by = new Map(rows.map((r) => [r.id, r]));
  return order.map((id) => by.get(id)?.exact === true);
}

export function agreement(a: readonly CaseScore[], b: readonly CaseScore[]): { k: number; n: number } {
  const by = new Map(b.map((r) => [r.id, r]));
  let k = 0;
  for (const r of a) if (by.get(r.id)?.emitted === r.emitted && r.emitted !== null) k++;
  return { k, n: a.length };
}
