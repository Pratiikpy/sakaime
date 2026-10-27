/**
 * Explainable Fellegi-Sunter scorer, in the manner of Splink (MIT): each compared field has comparison levels,
 * each level has an m probability (given a true link) and a u probability (given a non-link), and the evidence
 * for a pair is the sum of log2(m/u) over its fields, shown field by field as a waterfall. This is a
 * re-implementation from the published model; no Splink code is used.
 *
 * Estimation: supervised counting with additive smoothing and hierarchical shrinkage, not EM. Labelled pairs
 * give m and u directly, which is more reliable than EM at this sample size (EM needs thousands of unlabelled
 * pairs to separate the two classes). Per-link-type parameters shrink towards the pooled parameters with
 * strength `kappa`, so a link type with few labelled pairs borrows from the rest instead of overfitting.
 *
 * Known limits, stated so nobody reads the number as more than it is:
 *  - The model assumes fields are conditionally independent. They are not: name, manufacturer and product code
 *    move together, so the summed weight overstates the evidence. The score is therefore a ranking in bits of
 *    evidence, never a calibrated probability, and no lambda (prior) is used.
 *  - Training pairs are enriched with hard negatives chosen because they look alike, so u is larger than it
 *    would be over random pairs. Weights are conservative for that reason.
 *  - Thresholds come from the training pairs and are optimistic on them; use cross-validated figures
 *    (evaluate.ts) to judge behaviour on unseen devices.
 */
import { hashOf } from "../util/canonical.ts";
import type { LinkType } from "../schemas/index.ts";
import { SCORER_FIELDS, type ComparisonOutcome, type ScorerField } from "./types.ts";

export const FIELD_LEVELS: Record<ScorerField, readonly string[]> = {
  name: ["EXACT", "FAMILY_NAME", "CONTAINS", "GENERIC_CONTAINS", "OVERLAP", "DIFFERENT"],
  manufacturer: ["EXACT", "ALIAS", "FUZZY", "DIFFERENT"],
  productCode: ["EXACT", "DIFFERENT"],
  version: ["EXACT", "SAME_RELEASE_LINE", "DIFFERENT"],
  module: ["AGREE", "DISAGREE"],
  purpose: ["AGREE", "PARTIAL", "DISAGREE"],
  date: ["WITHIN_1Y", "WITHIN_3Y", "WITHIN_6Y", "FAR"],
  enrollment: ["EXACT", "CLOSE", "DIFFERENT"],
};

export interface LevelParams {
  m: number;
  u: number;
}
export type FieldParams = Record<string, LevelParams>;
export type ParamSet = Record<ScorerField, FieldParams>;
export interface Band {
  /** Below this the pair is not proposed as a link. */
  lower: number;
  /** At or above this (and passing the corroboration gate) the pair is a strong candidate. Never a confirmation. */
  upper: number;
}

export interface ScorerModel {
  schema: "sakaime.identity.model/1";
  method: "supervised-counting-with-shrinkage";
  smoothing: { alpha: number; kappa: number; upperFloorBits: number; lowerFloorBits: number };
  pool: ParamSet;
  byLinkType: Partial<Record<LinkType, ParamSet>>;
  thresholds: { pooled: Band; byLinkType: Partial<Record<LinkType, Band>> };
  /** The reference list used to recognise family names: normalised name key -> rows carrying it. */
  reference: { totalRows: number; familyNames: Record<string, number> };
  training: { pairs: number; matches: number; nonMatches: number; contentHash: string };
}

export interface TrainingPair {
  linkType: LinkType;
  outcomes: readonly ComparisonOutcome[];
  match: boolean;
}

export interface TrainOptions {
  alpha?: number;
  kappa?: number;
  /** Lowest bits of evidence at which a pair can be a strong candidate. */
  upperFloorBits?: number;
  lowerFloorBits?: number;
  reference?: ScorerModel["reference"];
}

type Counts = Record<ScorerField, Record<string, { m: number; u: number }>>;

function emptyCounts(): Counts {
  const out = {} as Counts;
  for (const f of SCORER_FIELDS) {
    out[f] = {};
    for (const l of FIELD_LEVELS[f]) out[f][l] = { m: 0, u: 0 };
  }
  return out;
}

function tally(counts: Counts, outcomes: readonly ComparisonOutcome[], match: boolean): void {
  for (const o of outcomes) {
    const cell = counts[o.field][o.level];
    if (!cell) continue; // UNKNOWN, or a level this field does not define: contributes nothing.
    if (match) cell.m++;
    else cell.u++;
  }
}

function pooledParams(counts: Counts, alpha: number): ParamSet {
  const out = {} as ParamSet;
  for (const f of SCORER_FIELDS) {
    const levels = FIELD_LEVELS[f];
    const mTotal = levels.reduce((s, l) => s + counts[f][l]!.m, 0);
    const uTotal = levels.reduce((s, l) => s + counts[f][l]!.u, 0);
    out[f] = {};
    for (const l of levels) {
      out[f][l] = {
        m: (counts[f][l]!.m + alpha) / (mTotal + alpha * levels.length),
        u: (counts[f][l]!.u + alpha) / (uTotal + alpha * levels.length),
      };
    }
  }
  return out;
}

function shrunkParams(counts: Counts, pool: ParamSet, kappa: number): ParamSet {
  const out = {} as ParamSet;
  for (const f of SCORER_FIELDS) {
    const levels = FIELD_LEVELS[f];
    const mTotal = levels.reduce((s, l) => s + counts[f][l]!.m, 0);
    const uTotal = levels.reduce((s, l) => s + counts[f][l]!.u, 0);
    out[f] = {};
    for (const l of levels) {
      out[f][l] = {
        m: (counts[f][l]!.m + kappa * pool[f][l]!.m) / (mTotal + kappa),
        u: (counts[f][l]!.u + kappa * pool[f][l]!.u) / (uTotal + kappa),
      };
    }
  }
  return out;
}

export function weightOf(params: ParamSet, field: ScorerField, level: string): number {
  const p = params[field][level];
  return p ? Math.log2(p.m / p.u) : 0;
}

export interface WaterfallEntry {
  field: ScorerField;
  level: string;
  weight: number;
  detail?: string;
}

export type BandName = "ABOVE" | "UNCERTAIN" | "BELOW";

export interface PairScore {
  /** Bits of evidence: the sum of the field weights. A ranking, not a probability. */
  weight: number;
  waterfall: WaterfallEntry[];
  band: BandName;
  bandEdges: Band;
}

export function paramsFor(model: ScorerModel, linkType: LinkType): ParamSet {
  return model.byLinkType[linkType] ?? model.pool;
}

export function bandFor(model: ScorerModel, linkType: LinkType): Band {
  return model.thresholds.byLinkType[linkType] ?? model.thresholds.pooled;
}

export function scoreOutcomes(model: ScorerModel, linkType: LinkType, outcomes: readonly ComparisonOutcome[]): PairScore {
  const params = paramsFor(model, linkType);
  const waterfall: WaterfallEntry[] = outcomes.map((o) => ({
    field: o.field,
    level: o.level,
    weight: o.level === "UNKNOWN" ? 0 : round(weightOf(params, o.field, o.level)),
    ...(o.detail ? { detail: o.detail } : {}),
  }));
  const weight = round(waterfall.reduce((s, w) => s + w.weight, 0));
  const edges = bandFor(model, linkType);
  const band: BandName = weight >= edges.upper ? "ABOVE" : weight >= edges.lower ? "UNCERTAIN" : "BELOW";
  return { weight, waterfall, band, bandEdges: edges };
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000;
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * Weights are log2 likelihood ratios, so their meaning does not depend on the sample. Two floors follow from
 * that and are fixed design choices, not fitted: a strong candidate needs a likelihood ratio of at least 16:1
 * (4 bits) in favour of a link, and a pair is not worth a reviewer's time below 1:4 (-2 bits).
 */
export const UPPER_FLOOR_BITS = 2;
export const LOWER_FLOOR_BITS = -2;

/**
 * upper: just above the highest-scoring labelled non-link, so no training non-link reaches the strong band,
 *        but never below the floor.
 * lower: the 10th percentile of labelled links, so most true links are at least shown to a reviewer, but
 *        never below the floor and always below upper.
 * A link type with too few pairs uses the pooled band.
 */
function deriveBand(matchWeights: number[], nonMatchWeights: number[], upperFloor: number, lowerFloor: number): Band {
  const nm = [...nonMatchWeights].sort((a, b) => a - b);
  const mw = [...matchWeights].sort((a, b) => a - b);
  const upper = Math.max(upperFloor, nm.length > 0 ? nm[nm.length - 1]! + 0.5 : upperFloor);
  const lowerRaw = mw.length > 0 ? percentile(mw, 0.1) : 0;
  const lower = Math.max(lowerFloor, Math.min(lowerRaw, upper - 1));
  return { lower: round(lower), upper: round(upper) };
}

export function trainModel(pairs: readonly TrainingPair[], options: TrainOptions = {}): ScorerModel {
  const alpha = options.alpha ?? 0.5;
  const kappa = options.kappa ?? 4;
  const all = emptyCounts();
  const byType = new Map<LinkType, Counts>();
  for (const p of pairs) {
    tally(all, p.outcomes, p.match);
    if (!byType.has(p.linkType)) byType.set(p.linkType, emptyCounts());
    tally(byType.get(p.linkType)!, p.outcomes, p.match);
  }
  const pool = pooledParams(all, alpha);
  const byLinkType: ScorerModel["byLinkType"] = {};
  for (const [lt, counts] of byType) byLinkType[lt] = shrunkParams(counts, pool, kappa);

  const weightsPooled = { m: [] as number[], u: [] as number[] };
  const weightsByType = new Map<LinkType, { m: number[]; u: number[] }>();
  for (const p of pairs) {
    const params = byLinkType[p.linkType] ?? pool;
    const w = p.outcomes.reduce((s, o) => s + (o.level === "UNKNOWN" ? 0 : weightOf(params, o.field, o.level)), 0);
    (p.match ? weightsPooled.m : weightsPooled.u).push(w);
    if (!weightsByType.has(p.linkType)) weightsByType.set(p.linkType, { m: [], u: [] });
    (p.match ? weightsByType.get(p.linkType)!.m : weightsByType.get(p.linkType)!.u).push(w);
  }
  const upperFloor = options.upperFloorBits ?? UPPER_FLOOR_BITS;
  const lowerFloor = options.lowerFloorBits ?? LOWER_FLOOR_BITS;
  const thresholds: ScorerModel["thresholds"] = { pooled: deriveBand(weightsPooled.m, weightsPooled.u, upperFloor, lowerFloor), byLinkType: {} };
  for (const [lt, w] of weightsByType) {
    if (w.m.length >= 4 && w.u.length >= 6) thresholds.byLinkType[lt] = deriveBand(w.m, w.u, upperFloor, lowerFloor);
  }

  const reference = options.reference ?? { totalRows: 0, familyNames: {} };
  const matches = pairs.filter((p) => p.match).length;
  const core = { alpha, kappa, upperFloor, lowerFloor, pool, byLinkType, thresholds, reference };
  return {
    schema: "sakaime.identity.model/1",
    method: "supervised-counting-with-shrinkage",
    smoothing: { alpha, kappa, upperFloorBits: upperFloor, lowerFloorBits: lowerFloor },
    pool,
    byLinkType,
    thresholds,
    reference,
    training: { pairs: pairs.length, matches, nonMatches: pairs.length - matches, contentHash: hashOf(core) },
  };
}

// ------------------------------------------------------------------------------------------ corroboration gate

const NAME_POSITIVE = new Set(["EXACT", "CONTAINS", "OVERLAP"]);

function level(outcomes: readonly ComparisonOutcome[], field: ScorerField): string {
  return outcomes.find((o) => o.field === field)?.level ?? "UNKNOWN";
}

export interface GateResult {
  strong: boolean;
  /** Positive evidence families found, for the audit trail. */
  families: string[];
  /** Facts that forbid a strong presentation whatever the weight. */
  blockers: string[];
  /** True when the only positive identity evidence is a name. */
  nameOnly: boolean;
  /** A name that identifies a brand matched (not merely a common word). */
  brandEvidence: boolean;
  /** Any name signal at all, including a common-word match. */
  nameEvidence: boolean;
}

/**
 * A high weight is not enough to call a pair a strong candidate. It needs two independent kinds of positive
 * evidence among name, manufacturer, study design numbers, an equal version and product code, and no extracted
 * fact that contradicts it. Agreement of intended use or module is context, not independent evidence: a paper
 * that names a product is already about that product's use, so it cannot lift a name-only match. A name shared
 * by several list rows (BriefCase) additionally needs agreeing purpose or module. A link about a marketed
 * version needs the versions shown equal.
 */
export function corroboration(outcomes: readonly ComparisonOutcome[], linkType?: LinkType): GateResult {
  const families: string[] = [];
  const nameLevel = level(outcomes, "name");
  const purposeAgrees = level(outcomes, "purpose") === "AGREE";
  const moduleAgrees = level(outcomes, "module") === "AGREE";
  if (NAME_POSITIVE.has(nameLevel)) families.push("name");
  else if (nameLevel === "FAMILY_NAME") {
    // A name shared by several list rows identifies a product line only when the use agrees.
    families.push(purposeAgrees || moduleAgrees ? "name" : "family-name");
  }
  const mfr = level(outcomes, "manufacturer");
  const mfrOutcome = outcomes.find((o) => o.field === "manufacturer");
  if (mfr === "EXACT" || mfr === "ALIAS") {
    // When the brand contains the company name, manufacturer agreement repeats the name evidence.
    families.push(mfrOutcome?.detail?.includes("brand-contains-manufacturer") ? "manufacturer-in-brand" : "manufacturer");
  }
  const enrollment = level(outcomes, "enrollment");
  if (enrollment === "EXACT" || enrollment === "CLOSE") families.push("design");
  if (level(outcomes, "version") === "EXACT") families.push("version");
  if (level(outcomes, "productCode") === "EXACT") families.push("product-code");

  const blockers: string[] = [];
  if (mfr === "DIFFERENT") blockers.push("manufacturers differ");
  if (level(outcomes, "module") === "DISAGREE") blockers.push("modules differ");
  if (level(outcomes, "purpose") === "DISAGREE") blockers.push("intended uses differ");
  if (linkType === "SAME_MARKETED_VERSION" && level(outcomes, "version") !== "EXACT") blockers.push("the versions are not shown to be equal");

  const independent = families.filter((f) => f !== "family-name" && f !== "manufacturer-in-brand").length;
  const identity = families.filter((f) => f === "name" || f === "manufacturer" || f === "design").length;
  // Every row of a name family shares the company and the product code, so those cannot tell the rows apart.
  const unresolvedFamily = families.includes("family-name");
  const strong = independent >= 2 && identity >= 1 && blockers.length === 0 && !unresolvedFamily;
  const brandEvidence = NAME_POSITIVE.has(nameLevel) || nameLevel === "FAMILY_NAME";
  const nameEvidence = brandEvidence || nameLevel === "GENERIC_CONTAINS";
  const nameOnly = nameEvidence && !families.some((f) => f !== "name" && f !== "family-name" && f !== "manufacturer-in-brand");
  return { strong, families: [...families, ...(purposeAgrees ? ["purpose-context"] : []), ...(moduleAgrees ? ["module-context"] : [])], blockers, nameOnly, brandEvidence, nameEvidence };
}
