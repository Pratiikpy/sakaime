import type { Dimension, EvidenceItem, ExpertFlag, Label, Scope } from "../schemas/index.ts";
import { DIMENSIONS } from "../schemas/index.ts";
import { evaluateGeneric, itemRelation, layersFor } from "./evaluate.ts";
import type { Prepared } from "./input.ts";
import { evaluateMetric, type ContraryEntry } from "./metric.ts";
import { buildPools, degradation, type DegradedEntry, type Pools } from "./pools.ts";
import { populationOps, productOps, purposeOps, settingOps, versionOps } from "./scope-ops.ts";
import { evaluateTiming } from "./timing.ts";
import type { DimResult, Ops } from "./types.ts";
import { cmp } from "./util.ts";

export class CompilerInvariantError extends Error {
  constructor(message: string) {
    super(`compiler invariant violated: ${message}`);
    this.name = "CompilerInvariantError";
  }
}

/** Scope dimensions that have set-like containment. Timing and metric have their own evaluators. */
const SCOPE_DIMENSIONS = ["product", "version", "population", "setting", "purpose"] as const;
type ScopeDimension = (typeof SCOPE_DIMENSIONS)[number];

function opsFor(prep: Prepared): Record<ScopeDimension, Ops<any>> {
  return {
    product: productOps,
    version: versionOps,
    population: populationOps,
    setting: settingOps(prep.options.settings),
    purpose: purposeOps(prep.options.purposes),
  };
}

export interface DimensionAnalysis {
  dims: Record<Dimension, DimResult>;
  contrary: ContraryEntry[];
  pools: Pools;
}

/** Evaluate all seven dimensions of `prep.claim` (or of a narrower claim built from it). */
export function analyseDimensions(prep: Prepared): DimensionAnalysis {
  const pools = buildPools(prep);
  const use = prep.claim.use;
  const ops = opsFor(prep);

  const dims = {} as Record<Dimension, DimResult>;
  for (const d of SCOPE_DIMENSIONS) {
    dims[d] = evaluateGeneric(ops[d], use, layersFor(pools, d));
  }
  dims.timing = evaluateTiming(pools, use);

  const required = prep.options.requiredDimensions;
  // A result speaks for the claim when its record covers the part of the claim the evidence covers. Where a dimension is
  // only partly covered, the narrower scope is what a record has to contain; the partial coverage itself is reported on that dimension.
  const evidenced: Scope = { ...use };
  for (const d of SCOPE_DIMENSIONS) if (required.has(d) && dims[d].relation === "PARTIAL" && dims[d].narrower) Object.assign(evidenced, dims[d].narrower);
  const combined = (d: ScopeDimension) => (dims[d].relation === "PARTIAL" && dims[d].narrower ? "CONTAINED" : dims[d].relation);
  const isRelevant = (item: EvidenceItem): boolean =>
    SCOPE_DIMENSIONS.filter((d) => required.has(d)).every((d) => (itemRelation(ops[d], evidenced, item) ?? combined(d)) === "CONTAINED");

  const metric = evaluateMetric(pools, isRelevant);
  dims.metric = metric.dim;
  return { dims, contrary: metric.contrary, pools };
}

/**
 * Joint coverage. Dimension by dimension the union of several records may contain the claim while no single record does:
 * adults in the emergency department from one record, children in clinics from another. A record that is silent on a
 * dimension does not restrict it (silence is not a prohibition), so a record covers the claim when it contains the claim on
 * every dimension it states. If a layer has several such records and none covers the claim, the combination rests on
 * stitching records together, which is a reviewer judgement. Records that state the same dimensions identically are not flagged.
 */
export function jointCoverageFlags(prep: Prepared, pools: Pools): ExpertFlag[] {
  const use = prep.claim.use;
  const ops = opsFor(prep);
  const required = prep.options.requiredDimensions;
  const dims = SCOPE_DIMENSIONS.filter((d) => required.has(d));
  const flags: ExpertFlag[] = [];
  const layers: [string, readonly EvidenceItem[]][] = [
    ["authorization", pools.supportAuth],
    ["study", pools.supportStudy],
  ];
  for (const [name, all] of layers) {
    const items = all.filter((i) => dims.some((d) => ops[d].item(i) !== undefined));
    if (items.length < 2) continue;
    const covers = (i: EvidenceItem) =>
      dims.every((d) => {
        const e = ops[d].item(i);
        if (e === undefined) return true;
        const c = ops[d].claim(use);
        return c !== undefined && ops[d].relate(c, e).relation === "CONTAINED";
      });
    if (!items.some(covers)) {
      flags.push({
        ruleId: "SAK-JOINT-COVERAGE",
        reason: `Each required dimension is contained by the ${name} records taken together, but no single ${name} record contains the claimed use on every dimension it states. Whether the pieces combine is a reviewer judgement.`,
      });
    }
  }
  return flags;
}

export interface Decision {
  label: Label;
  basis: string[];
  supportedScope?: Scope;
  flags: ExpertFlag[];
  /** The analysis the mismatches and requests are taken from (the claim as stated). */
  analysis: DimensionAnalysis;
  degraded: DegradedEntry[];
}

function requirementFlags(pools: Pools): ExpertFlag[] {
  const flags: ExpertFlag[] = [];
  const required = pools.deps.required.has("requirement");
  for (const item of pools.requirement) {
    if (item.satisfied === false) {
      flags.push({ ruleId: "SAK-REQUIREMENT", reason: `The hospital requirement ${item.id} is recorded as not met. Waiving it, or declining the claim, is a committee decision.` });
    } else if (item.satisfied === undefined && required) {
      flags.push({ ruleId: "SAK-REQUIREMENT", reason: `The hospital requirement ${item.id} has not been assessed against this claim.` });
    }
  }
  return flags;
}

const sortFlags = (flags: ExpertFlag[]): ExpertFlag[] => {
  const seen = new Set<string>();
  const out: ExpertFlag[] = [];
  for (const f of [...flags].sort((a, b) => cmp(a.ruleId, b.ruleId) || cmp(a.dimension ?? "", b.dimension ?? "") || cmp(a.reason, b.reason))) {
    const key = `${f.ruleId}|${f.dimension ?? ""}|${f.reason}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return out;
};

function narrowerUse(prep: Prepared, dims: Record<Dimension, DimResult>): Scope {
  const use: Scope = { ...prep.claim.use };
  for (const d of DIMENSIONS) {
    if (!prep.options.requiredDimensions.has(d)) continue;
    const r = dims[d];
    if (r.relation === "PARTIAL" && r.narrower) Object.assign(use, r.narrower);
  }
  return use;
}

/** The label table of docs/02 section 10, with the precedence recorded in rules.ts: C, contrary needing review, I, other review flags, N, S. */
export function decide(prep: Prepared): Decision {
  const analysis = analyseDimensions(prep);
  const { dims, contrary, pools } = analysis;
  const required = prep.options.requiredDimensions;
  const reqDims = DIMENSIONS.filter((d) => required.has(d)).map((d) => dims[d]);
  const { entries, lostRequired } = degradation(pools, prep.evidence);

  const flags = sortFlags([...reqDims.flatMap((d) => d.flags), ...requirementFlags(pools)]);
  const finish = (label: Label, basis: string[], extra: Partial<Decision> = {}): Decision => ({ label, basis, flags, analysis, degraded: entries, ...extra });

  const explicit = reqDims.flatMap((d) => d.explicit.map((e) => `${d.dimension}: ${e.text} (${e.ruleId})`));
  const contradictions = contrary.filter((c) => c.status === "contradiction");
  if (explicit.length > 0 || contradictions.length > 0) {
    return finish("CONTRADICTED_BY_SPECIFIED_EVIDENCE", [
      ...explicit.map((e) => `explicit authorization limit, ${e}`),
      ...contradictions.map((c) => `contrary study result, ${c.text}: ${c.why}`),
    ]);
  }

  const undispositioned = contrary.filter((c) => c.status === "needs-disposition");
  if (undispositioned.length > 0) {
    return finish("REQUIRES_DOMAIN_REVIEW", undispositioned.map((c) => `contrary material without a recorded disposition, ${c.text}: ${c.why}`));
  }

  const blockers: string[] = [];
  for (const t of lostRequired) blockers.push(`required evidence type "${t}" is lost, empty or was never supplied`);
  const othersOpen = (d: DimResult) => reqDims.some((o) => o !== d && o.relation !== "CONTAINED");
  for (const d of reqDims) {
    if (d.derived && othersOpen(d)) continue;
    if (d.relation === "UNKNOWN" && !d.pending) blockers.push(`${d.dimension} is unknown`);
    if (d.relation === "DISJOINT") blockers.push(`${d.dimension} is not covered by any evidence`);
  }
  if (blockers.length > 0) return finish("INSUFFICIENT_EVIDENCE", blockers);

  const pending = reqDims.filter((d) => d.pending);
  if (flags.length > 0 || pending.length > 0) {
    return finish("REQUIRES_DOMAIN_REVIEW", [
      ...flags.map((f) => `${f.ruleId}: ${f.reason}`),
      ...pending.map((d) => `${d.dimension} needs a reviewer to place a term`),
    ]);
  }

  const partial = reqDims.filter((d) => d.relation === "PARTIAL");
  if (partial.length === 0) {
    const joint = jointCoverageFlags(prep, pools);
    if (joint.length > 0) return finish("REQUIRES_DOMAIN_REVIEW", joint.map((f) => `${f.ruleId}: ${f.reason}`), { flags: sortFlags([...flags, ...joint]) });
    return finish("SUPPORTED_FOR_SCOPE", ["every required dimension is contained, no required source is lost, and no review flag is raised"]);
  }

  // A narrower scope must itself be contained in the evidence: build it and check, rather than assume.
  const narrowUse = narrowerUse(prep, dims);
  const narrowPrep: Prepared = { ...prep, claim: { ...prep.claim, use: narrowUse } };
  const narrow = analyseDimensions(narrowPrep);
  for (const d of DIMENSIONS) {
    if (required.has(d) && d !== "metric" && narrow.dims[d].relation !== "CONTAINED") {
      throw new CompilerInvariantError(`the narrower scope derived for ${d} is itself ${narrow.dims[d].relation}`);
    }
  }
  const narrowMetric = narrow.dims.metric;
  if (required.has("metric") && narrowMetric.relation !== "CONTAINED") {
    if (narrowMetric.relation !== "UNKNOWN") {
      throw new CompilerInvariantError(`the narrower scope derived for metric is itself ${narrowMetric.relation}`);
    }
    // Part of the claim is covered, but no result speaks for that part: the evidence is insufficient, and the missing result is the counterexample.
    const shown = { ...analysis, dims: { ...analysis.dims, metric: { ...narrowMetric } } };
    return finish("INSUFFICIENT_EVIDENCE", [`no result covers the evidenced part of the claim: ${narrowMetric.reason}`], { analysis: shown });
  }
  const narrowFlags = sortFlags([...flags, ...DIMENSIONS.filter((d) => required.has(d)).flatMap((d) => narrow.dims[d].flags)]);
  const joint = jointCoverageFlags(narrowPrep, narrow.pools);
  if (narrowFlags.length !== flags.length || joint.length > 0) {
    const all = sortFlags([...narrowFlags, ...joint]);
    return finish("REQUIRES_DOMAIN_REVIEW", all.map((f) => `${f.ruleId}: ${f.reason}`), { flags: all });
  }
  return finish(
    "SUPPORTED_ONLY_FOR_NARROWER_SCOPE",
    partial.map((d) => `${d.dimension} is only partly covered; the evidenced part is stated as the supported scope`),
    { supportedScope: stripEmpty(narrowUse) },
  );
}

function stripEmpty(scope: Scope): Scope {
  return JSON.parse(JSON.stringify(scope)) as Scope;
}

