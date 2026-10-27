/**
 * Measured evaluation of identity resolution against the labelled corpus.
 *
 * What counts as the system saying "link": a CONFIRMED or CANDIDATE state. AMBIGUOUS is abstention: the pair is
 * shown to a reviewer without a claim. REJECTED is "no". A pair that is not proposed at all is "silent", which
 * is neither a claim nor an abstention and is counted apart.
 *
 *   precision          links that are true / links on pairs with a decided truth (MATCH or NON_MATCH)
 *   recall             true links found / MATCH pairs
 *   surfaced recall    true links found or shown as AMBIGUOUS / MATCH pairs
 *   correct abstention AMBIGUOUS-state results / AMBIGUOUS-truth pairs
 *   false confirm      CONFIRMED where the truth is not MATCH (must be zero)
 *
 * Because every pair of one device family is related, intervals are reported two ways: Wilson (treats pairs as
 * independent, optimistic) and a cluster bootstrap over families (honest about the effective sample size).
 */
import { compareRecords } from "./compare.ts";
import type { LinkState } from "../schemas/index.ts";
import type { Corpus, CorpusPair } from "./corpus.ts";
import { applicableLinkTypes, exactEvidence, orient } from "./exact.ts";
import { resolveDeterministic, type LinkResolution } from "./resolver.ts";
import { trainModel, type ScorerModel, type TrainingPair } from "./scorer.ts";
import type { IdentityRecord } from "./types.ts";

export type Verdict = "LINK" | "ABSTAIN" | "NO" | "SILENT";

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  lo: number | null;
  hi: number | null;
}

export function wilson(k: number, n: number, z = 1.96): Rate {
  if (n === 0) return { k, n, rate: null, lo: null, hi: null };
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { k, n, rate: p, lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}

export interface PairOutcome {
  pair: CorpusPair;
  verdict: Verdict;
  state: LinkState | null;
  candidateClass: LinkResolution["candidateClass"];
  weight: number | null;
  flags: string[];
  /** Whether every expected flag prefix appeared; null when none were expected. */
  flagsHit: boolean | null;
  reasons: string[];
}

export function verdictOf(res: LinkResolution): Verdict {
  const state = res.link?.state;
  if (state === "CONFIRMED" || state === "CANDIDATE") return "LINK";
  if (state === "AMBIGUOUS") return "ABSTAIN";
  if (state === "REJECTED") return "NO";
  return "SILENT";
}

export function recordsOf(corpus: Corpus): IdentityRecord[] {
  return [...corpus.records.values()].map((r) => r.record);
}

export function resolvePair(pair: CorpusPair, corpus: Corpus, model: ScorerModel): LinkResolution {
  const a = corpus.records.get(pair.a)!.record;
  const b = corpus.records.get(pair.b)!.record;
  return resolveDeterministic(a, b, pair.linkType, { model, knownRecords: recordsOf(corpus) });
}

export function outcomeOf(pair: CorpusPair, corpus: Corpus, model: ScorerModel): PairOutcome {
  const res = resolvePair(pair, corpus, model);
  const flagsHit = pair.expectedFlags.length === 0 ? null : pair.expectedFlags.every((p) => res.flags.some((f) => f.startsWith(p)));
  return {
    pair,
    verdict: verdictOf(res),
    state: res.link?.state ?? null,
    candidateClass: res.candidateClass,
    weight: res.score?.weight ?? null,
    flags: res.flags,
    flagsHit,
    reasons: res.reasons,
  };
}

// ------------------------------------------------------------------------------------------ training

/**
 * Training pairs for the scorer: only pairs whose truth is decided and that no exact identifier settles,
 * because the scorer is only ever consulted for those. The trivial cross-family negatives are left out so
 * they do not drag u towards zero.
 */
export function trainingPairs(pairs: readonly CorpusPair[], corpus: Corpus, reference: ScorerModel["reference"]): TrainingPair[] {
  const out: TrainingPair[] = [];
  for (const p of pairs) {
    if (p.truth === "AMBIGUOUS" || p.family === "easy") continue;
    const a = corpus.records.get(p.a)!.record;
    const b = corpus.records.get(p.b)!.record;
    const { from, to } = orient(p.linkType, a, b);
    if (exactEvidence(p.linkType, from, to).kind !== "NONE") continue;
    out.push({ linkType: p.linkType, outcomes: compareRecords(from, to, { familyNames: reference.familyNames }), match: p.truth === "MATCH" });
  }
  return out;
}

export interface FitOptions {
  upperFloorBits?: number;
  lowerFloorBits?: number;
}

export function fitModel(corpus: Corpus, reference: ScorerModel["reference"], exclude?: (p: CorpusPair) => boolean, fit: FitOptions = {}): ScorerModel {
  const pairs = corpus.pairs.filter((p) => !(exclude?.(p) ?? false));
  return trainModel(trainingPairs(pairs, corpus, reference), { reference, ...fit });
}

export interface EvalRun {
  model: ScorerModel;
  outcomes: PairOutcome[];
}

/** Trains and evaluates on the whole corpus. Optimistic: the model has seen every test pair. */
export function runInSample(corpus: Corpus, reference: ScorerModel["reference"], fit: FitOptions = {}): EvalRun {
  const model = fitModel(corpus, reference, undefined, fit);
  return { model, outcomes: corpus.pairs.map((p) => outcomeOf(p, corpus, model)) };
}

/**
 * Leave-one-family-out: for each device family, train on every pair that touches no record of that family,
 * then score that family's pairs. The trivial cross-family negatives are scored by the full-corpus model.
 */
export function runLeaveOneFamilyOut(corpus: Corpus, reference: ScorerModel["reference"], fit: FitOptions = {}): EvalRun {
  const families = [...new Set(corpus.pairs.filter((p) => p.family !== "easy").map((p) => p.family))].sort();
  const outcomes: PairOutcome[] = [];
  for (const family of families) {
    const touches = (p: CorpusPair) => corpus.records.get(p.a)!.family === family || corpus.records.get(p.b)!.family === family || p.family === family;
    const model = fitModel(corpus, reference, touches, fit);
    for (const p of corpus.pairs) if (p.family === family) outcomes.push(outcomeOf(p, corpus, model));
  }
  const full = fitModel(corpus, reference, undefined, fit);
  for (const p of corpus.pairs) if (p.family === "easy") outcomes.push(outcomeOf(p, corpus, full));
  return { model: full, outcomes };
}

// ------------------------------------------------------------------------------------------ metrics

export interface Metrics {
  pairs: number;
  byTruth: Record<CorpusPair["truth"], number>;
  precision: Rate;
  recall: Rate;
  surfacedRecall: Rate;
  correctAbstention: Rate;
  /** NON_MATCH pairs the system called a link. */
  falseMergeRate: Rate;
  /** AMBIGUOUS-truth pairs the system called a link. */
  overconfidentOnAmbiguous: Rate;
  /** AMBIGUOUS-truth pairs the system said "no" to. */
  overRejectedOnAmbiguous: Rate;
  /** CONFIRMED results whose truth is not MATCH. */
  falseConfirms: number;
  confirmRecall: Rate;
  flagRecall: Rate;
}

export function summarise(outcomes: readonly PairOutcome[]): Metrics {
  const by = (t: CorpusPair["truth"]) => outcomes.filter((o) => o.pair.truth === t);
  const match = by("MATCH");
  const non = by("NON_MATCH");
  const amb = by("AMBIGUOUS");
  const tp = match.filter((o) => o.verdict === "LINK").length;
  const fp = non.filter((o) => o.verdict === "LINK").length;
  const surfaced = match.filter((o) => o.verdict === "LINK" || o.verdict === "ABSTAIN").length;
  const expectConfirmed = outcomes.filter((o) => o.pair.expectConfirmed);
  const withFlags = outcomes.filter((o) => o.flagsHit !== null);
  return {
    pairs: outcomes.length,
    byTruth: { MATCH: match.length, NON_MATCH: non.length, AMBIGUOUS: amb.length },
    precision: wilson(tp, tp + fp),
    recall: wilson(tp, match.length),
    surfacedRecall: wilson(surfaced, match.length),
    correctAbstention: wilson(amb.filter((o) => o.verdict === "ABSTAIN").length, amb.length),
    falseMergeRate: wilson(fp, non.length),
    overconfidentOnAmbiguous: wilson(amb.filter((o) => o.verdict === "LINK").length, amb.length),
    overRejectedOnAmbiguous: wilson(amb.filter((o) => o.verdict === "NO").length, amb.length),
    falseConfirms: outcomes.filter((o) => o.state === "CONFIRMED" && o.pair.truth !== "MATCH").length,
    confirmRecall: wilson(expectConfirmed.filter((o) => o.state === "CONFIRMED").length, expectConfirmed.length),
    flagRecall: wilson(withFlags.filter((o) => o.flagsHit).length, withFlags.length),
  };
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Interval {
  point: number | null;
  lo: number | null;
  hi: number | null;
  clusters: number;
}

/** Percentile bootstrap that resamples whole device families, so the interval reflects the number of families, not pairs. */
export function clusterBootstrap(
  outcomes: readonly PairOutcome[],
  statistic: (o: readonly PairOutcome[]) => number | null,
  resamples = 2000,
  seed = 20261027,
): Interval {
  const groups = new Map<string, PairOutcome[]>();
  for (const o of outcomes) {
    if (!groups.has(o.pair.family)) groups.set(o.pair.family, []);
    groups.get(o.pair.family)!.push(o);
  }
  const keys = [...groups.keys()].sort();
  const point = statistic(outcomes);
  if (keys.length < 2) return { point, lo: null, hi: null, clusters: keys.length };
  const rand = mulberry32(seed);
  const values: number[] = [];
  for (let i = 0; i < resamples; i++) {
    const sample: PairOutcome[] = [];
    for (let j = 0; j < keys.length; j++) sample.push(...groups.get(keys[Math.floor(rand() * keys.length)]!)!);
    const v = statistic(sample);
    if (v !== null) values.push(v);
  }
  values.sort((a, b) => a - b);
  if (values.length === 0) return { point, lo: null, hi: null, clusters: keys.length };
  return { point, lo: values[Math.floor(0.025 * (values.length - 1))]!, hi: values[Math.ceil(0.975 * (values.length - 1))]!, clusters: keys.length };
}

export const statistics = {
  precision: (o: readonly PairOutcome[]) => summarise(o).precision.rate,
  recall: (o: readonly PairOutcome[]) => summarise(o).recall.rate,
  surfacedRecall: (o: readonly PairOutcome[]) => summarise(o).surfacedRecall.rate,
  correctAbstention: (o: readonly PairOutcome[]) => summarise(o).correctAbstention.rate,
};

export interface SweepResult {
  /** Record pairs from different device families, each tried under every link type the kinds allow. */
  combinations: number;
  byState: Record<string, number>;
  /** Combinations the resolver called a link (CONFIRMED or CANDIDATE). Records of different families are different products. */
  links: string[];
}

/**
 * An unlabelled negative sweep: every pair of records from different device families under every applicable
 * link type. Different families are different products and studies, so none should be a link. This tests the
 * resolver on thousands of combinations the labelled pairs do not cover.
 */
export function crossFamilySweep(corpus: Corpus, model: ScorerModel): SweepResult {
  const recs = [...corpus.records.values()];
  const byState: Record<string, number> = {};
  const links: string[] = [];
  let combinations = 0;
  for (let i = 0; i < recs.length; i++) {
    for (let j = i + 1; j < recs.length; j++) {
      const a = recs[i]!;
      const b = recs[j]!;
      if (a.family === b.family) continue;
      for (const linkType of applicableLinkTypes(a.record, b.record)) {
        combinations++;
        const res = resolveDeterministic(a.record, b.record, linkType, { model });
        const state = res.link?.state ?? "not proposed";
        byState[state] = (byState[state] ?? 0) + 1;
        if (state === "CONFIRMED" || state === "CANDIDATE") links.push(`${state} ${linkType} ${a.record.id} ~ ${b.record.id}`);
      }
    }
  }
  return { combinations, byState, links };
}
