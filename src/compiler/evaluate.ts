import type { Relation, Scope } from "../schemas/index.ts";
import type { EvidenceItem } from "../schemas/index.ts";
import type { Pools } from "./pools.ts";
import { DIMENSION_NOUN, UNSPECIFIED_EVIDENCE_RULE, genericRequest } from "./requests.ts";
import type { DimResult, Explicit, Ops, Outcome } from "./types.ts";
import { sortedUnique } from "./util.ts";

const REL_WORDS: Record<Relation, string> = {
  CONTAINED: "covered",
  PARTIAL: "only partly covered",
  DISJOINT: "not covered",
  UNKNOWN: "undecided",
};

interface Folded<V> {
  v?: V;
  used: EvidenceItem[];
}

function fold<V>(ops: Ops<V>, items: readonly EvidenceItem[]): Folded<V> {
  const out: Folded<V> = { used: [] };
  for (const it of items) {
    const x = ops.item(it);
    if (x === undefined) continue;
    out.used.push(it);
    out.v = out.v === undefined ? x : ops.union(out.v, x);
  }
  return out;
}

export interface Layers {
  auth: readonly EvidenceItem[];
  study: readonly EvidenceItem[];
  /**
   * Study-typed items taken from the regulator's decision summary. They bound the claim where the authorization records are silent
   * on the dimension (and, for the population, on the part of it they leave open, such as an age floor); they never widen what an
   * authorization states. Registry entries and publications are in `study` only.
   */
  regulator: readonly EvidenceItem[];
  /** Authorization records whose explicit limits can contradict the claim. */
  limit: readonly EvidenceItem[];
  /**
   * Measured results belong to what was studied, so when the claim depends on studies the study records must state the
   * dimension themselves. An authorization that is silent restricts nothing (silence is not a prohibition); a study that is
   * silent leaves the results unattached to the claimed version, population or setting.
   */
  studyMustSpeak: boolean;
}

const STUDY_MUST_SPEAK: readonly string[] = ["product", "version", "population", "setting"];

export function layersFor(pools: Pools, dimension: string): Layers {
  const studyMustSpeak = pools.deps.required.has("study") && STUDY_MUST_SPEAK.includes(dimension);
  return dimension === "product"
    ? { auth: pools.productAuth, study: pools.productStudy, regulator: [], limit: [], studyMustSpeak }
    : { auth: pools.supportAuth, study: pools.supportStudy, regulator: pools.deps.required.has("authorization") ? pools.regulatorStudy : [], limit: pools.limitAuth, studyMustSpeak };
}

/**
 * Evaluate one scope dimension.
 *
 * Each layer (authorization records, study records) is the union of what its items establish. Where both layers
 * state the dimension, the claim must lie inside both: the effective evidence scope is their meet. This is how
 * "a study can never widen an authorization" is enforced; a layer that is silent on the dimension does not restrict it,
 * because silence in a record is not a prohibition and is also never read as permission.
 */
/**
 * What bounds the claim on a dimension. The authorization records bound it where they speak. The regulator's own summary of what the
 * pivotal study analysed bounds it where they are silent; for the population, which is several parts at once, part by part (the
 * indications give the condition, the summary gives the age floor). It can only narrow what the authorization states, never widen it:
 * where both state a dimension other than the population, the authorization alone is the bound.
 */
function boundOf<V>(ops: Ops<V>, A: V | undefined, R: V | undefined): { v: V | undefined; label: string } {
  if (A === undefined && R === undefined) return { v: undefined, label: "" };
  if (R === undefined) return { v: A, label: "authorization record" };
  if (A === undefined) return { v: R, label: "regulator decision summary" };
  if (ops.dimension === "population") return { v: ops.meet(A, R), label: "authorization record and regulator decision summary" };
  return { v: A, label: "authorization record" };
}

export function evaluateGeneric<V>(ops: Ops<V>, use: Scope, layers: Layers): DimResult {
  const dimension = ops.dimension;
  const noun = DIMENSION_NOUN[dimension];
  const c = ops.claim(use);
  const A = fold(ops, layers.auth);
  const R = fold(ops, layers.regulator);
  const S = fold(ops, layers.study);
  const bound = boundOf(ops, A.v, R.v);
  const used = [...A.used, ...(R.v !== undefined && bound.label.includes("regulator") ? R.used : []), ...S.used];
  const evidenceIds = sortedUnique(used.map((i) => i.id));
  const anchorIds = sortedUnique(used.flatMap((i) => i.anchorIds));
  const brief = (v: V): string => (ops.brief ? ops.brief(v, c) : ops.render(v));
  const limit = (label: string): string => (label.includes(" and ") ? "limit" : "limits");

  const named = [
    A.v !== undefined ? `authorization record: ${ops.render(A.v)}` : undefined,
    R.v !== undefined && bound.label.includes("regulator") ? `regulator decision summary: ${ops.render(R.v)}` : undefined,
    S.v !== undefined ? `study: ${ops.render(S.v)}` : undefined,
  ].filter((x): x is string => x !== undefined);
  const established = named.length ? named.join("; ") : undefined;

  if (c === undefined) {
    return {
      dimension,
      evidenceIds,
      anchorIds,
      flags: [],
      explicit: [],
      pending: false,
      relation: "UNKNOWN",
      ...(established ? { established } : {}),
      reason: `The claim does not state a ${noun}, so nothing can be concluded about it.`,
      request: genericRequest({ dimension, relation: "UNKNOWN", cause: "claim" }),
      ruleIds: ["SAK-CLAIM-UNSPECIFIED"],
    };
  }
  const claimed = ops.render(c);

  // Explicit limits are read from every authorization record in force, whether or not the claim lists the type as required.
  const limits = fold(ops, layers.limit);
  const explicit: Explicit[] = limits.v !== undefined ? [...ops.relate(c, limits.v).explicit] : [];
  const stated = ops.limits?.(c, layers.limit) ?? { explicit: [], flags: [] };
  explicit.push(...stated.explicit);

  // A study silent on the dimension leaves the results unattached, unless the authorization already rules the claim out.
  if (layers.studyMustSpeak && S.v === undefined && bound.v !== undefined && ops.relate(c, bound.v).relation !== "DISJOINT") {
    return {
      dimension,
      evidenceIds,
      anchorIds,
      flags: [],
      explicit,
      pending: false,
      relation: "UNKNOWN",
      claimed,
      ...(established ? { established } : {}),
      reason: `The study records do not state a ${noun}, so the measured results cannot be tied to the claimed ${claimed}.`,
      request: genericRequest({ dimension, relation: "UNKNOWN", cause: "evidence" }),
      ruleIds: [UNSPECIFIED_EVIDENCE_RULE[dimension]],
    };
  }

  const defined = [bound.v, S.v].filter((x): x is V => x !== undefined);
  if (defined.length === 0) {
    return {
      dimension,
      evidenceIds,
      anchorIds,
      flags: [],
      explicit,
      pending: false,
      relation: "UNKNOWN",
      claimed,
      reason: `No evidence record in use states a ${noun}, so the claimed ${claimed} cannot be placed inside anything.`,
      request: genericRequest({ dimension, relation: "UNKNOWN", cause: "evidence" }),
      ruleIds: [UNSPECIFIED_EVIDENCE_RULE[dimension]],
    };
  }

  const effective = defined.reduce((a, b) => ops.meet(a, b));
  const out: Outcome<V> = ops.relate(c, effective);

  let reason = out.detail;
  // Which source limits the claim, with both values quoted: the bound (authorization, or the regulator's summary) or the studies.
  let limitedBy = "";
  if (bound.v !== undefined && S.v !== undefined && out.relation !== "CONTAINED") {
    const relA = ops.relate(c, bound.v).relation;
    const relS = ops.relate(c, S.v).relation;
    if (ops.isEmpty(effective)) {
      reason = `The ${bound.label} (${ops.render(bound.v)}) and the studies (${ops.render(S.v)}) have no ${noun} in common, and the claim is for ${claimed}.`;
    }
    reason += ` Against the ${bound.label} alone the claim is ${REL_WORDS[relA]}; against the studies alone it is ${REL_WORDS[relS]}.`;
    // The bound can be two records (the indications and the regulator's summary, for the population): name the one that limits the claim.
    let who = { label: bound.label, v: bound.v };
    if (bound.label.includes(" and ") && A.v !== undefined && R.v !== undefined) {
      // Silence is not a limit: a record limits the claim only if it narrows it, that is, the claim cut down to the record is not the claim.
      const limits = (v: V): boolean => ops.render(ops.meet(v, c)) !== ops.render(c);
      const byAuthorization = limits(A.v);
      const bySummary = limits(R.v);
      if (byAuthorization && !bySummary) who = { label: "authorization record", v: A.v };
      else if (bySummary && !byAuthorization) who = { label: "regulator decision summary", v: R.v };
    }
    if (relA !== "CONTAINED" && relS === "CONTAINED") {
      limitedBy = `The ${who.label} ${limit(who.label)} the ${noun} to ${brief(who.v)}; the study records state ${brief(S.v)}, which does not widen it.`;
    } else if (relA !== "CONTAINED") {
      limitedBy = `The ${who.label} ${limit(who.label)} the ${noun} to ${brief(who.v)}; the study records state ${brief(S.v)}.`;
    } else if (relS !== "CONTAINED") {
      limitedBy = `The study records limit the ${noun} to ${brief(S.v)}; the ${bound.label} ${bound.label.includes(" and ") ? "do" : "does"} not limit it.`;
    }
  }

  const result: DimResult = {
    dimension,
    relation: out.relation,
    claimed,
    ...(established ? { established } : {}),
    evidenceIds,
    anchorIds,
    reason,
    ruleIds: out.relation !== "CONTAINED" && bound.label.includes("regulator") ? sortedUnique([...out.ruleIds, "SAK-REGULATOR-BOUND"]) : out.ruleIds,
    flags: [...out.flags, ...stated.flags],
    explicit,
    pending: out.pending ?? false,
  };
  if (out.relation === "PARTIAL" && out.narrower !== undefined) result.narrower = ops.toScope(out.narrower);
  if (out.relation !== "CONTAINED") {
    const ask =
      out.request ??
      genericRequest({
        dimension,
        relation: out.relation,
        ...(out.pending ? { cause: "pending" as const } : {}),
        claimed,
        established: established ?? "",
        ...(out.gap ? { gap: out.gap } : {}),
        ...(out.narrower !== undefined ? { narrower: ops.render(out.narrower) } : {}),
        ...(out.term ? { term: out.term } : {}),
      });
    result.request = limitedBy && !out.pending ? `${ask} ${limitedBy}` : ask;
  }
  return result;
}

/** How one item relates to the claim on one dimension: undefined when the item is silent on it. */
export function itemRelation<V>(ops: Ops<V>, use: Scope, item: EvidenceItem): Relation | undefined {
  const v = ops.item(item);
  if (v === undefined) return undefined;
  const c = ops.claim(use);
  if (c === undefined) return "UNKNOWN";
  return ops.relate(c, v).relation;
}
