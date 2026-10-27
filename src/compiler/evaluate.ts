import type { Relation, Scope } from "../schemas/index.ts";
import type { EvidenceItem } from "../schemas/index.ts";
import type { Pools } from "./pools.ts";
import { DIMENSION_NOUN, UNSPECIFIED_EVIDENCE_RULE, genericRequest } from "./requests.ts";
import type { DimResult, Ops, Outcome } from "./types.ts";
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
    ? { auth: pools.productAuth, study: pools.productStudy, limit: [], studyMustSpeak }
    : { auth: pools.supportAuth, study: pools.supportStudy, limit: pools.limitAuth, studyMustSpeak };
}

/**
 * Evaluate one scope dimension.
 *
 * Each layer (authorization records, study records) is the union of what its items establish. Where both layers
 * state the dimension, the claim must lie inside both: the effective evidence scope is their meet. This is how
 * "a study can never widen an authorization" is enforced; a layer that is silent on the dimension does not restrict it,
 * because silence in a record is not a prohibition and is also never read as permission.
 */
export function evaluateGeneric<V>(ops: Ops<V>, use: Scope, layers: Layers): DimResult {
  const dimension = ops.dimension;
  const noun = DIMENSION_NOUN[dimension];
  const c = ops.claim(use);
  const A = fold(ops, layers.auth);
  const S = fold(ops, layers.study);
  const used = [...A.used, ...S.used];
  const evidenceIds = sortedUnique(used.map((i) => i.id));
  const anchorIds = sortedUnique(used.flatMap((i) => i.anchorIds));

  const named = [
    A.v !== undefined ? `authorization record: ${ops.render(A.v)}` : undefined,
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
  const explicit = limits.v !== undefined ? ops.relate(c, limits.v).explicit : [];

  // A study silent on the dimension leaves the results unattached, unless the authorization already rules the claim out.
  if (layers.studyMustSpeak && S.v === undefined && A.v !== undefined && ops.relate(c, A.v).relation !== "DISJOINT") {
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

  const defined = [A.v, S.v].filter((x): x is V => x !== undefined);
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
  if (A.v !== undefined && S.v !== undefined && out.relation !== "CONTAINED") {
    const relA = ops.relate(c, A.v).relation;
    const relS = ops.relate(c, S.v).relation;
    if (ops.isEmpty(effective)) {
      reason = `The authorization record (${ops.render(A.v)}) and the studies (${ops.render(S.v)}) have no ${noun} in common, and the claim is for ${claimed}.`;
    }
    reason += ` Against the authorization record alone the claim is ${REL_WORDS[relA]}; against the studies alone it is ${REL_WORDS[relS]}.`;
  }

  const result: DimResult = {
    dimension,
    relation: out.relation,
    claimed,
    ...(established ? { established } : {}),
    evidenceIds,
    anchorIds,
    reason,
    ruleIds: out.ruleIds,
    flags: out.flags,
    explicit,
    pending: out.pending ?? false,
  };
  if (out.relation === "PARTIAL" && out.narrower !== undefined) result.narrower = ops.toScope(out.narrower);
  if (out.relation !== "CONTAINED") {
    result.request = genericRequest({
      dimension,
      relation: out.relation,
      ...(out.pending ? { cause: "pending" as const } : {}),
      claimed,
      established: established ?? "",
      ...(out.gap ? { gap: out.gap } : {}),
      ...(out.narrower !== undefined ? { narrower: ops.render(out.narrower) } : {}),
      ...(out.term ? { term: out.term } : {}),
    });
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
