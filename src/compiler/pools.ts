import type { AssertionType, Claim, EvidenceItem } from "../schemas/index.ts";
import { ASSERTION_TYPES } from "../schemas/index.ts";
import type { Prepared, ResolvedOptions } from "./input.ts";
import { cmp, dayNumber } from "./util.ts";

/** Health states under which a source's records cannot be relied on. EMPTY is handled alongside: nothing was found. */
export const LOST_HEALTH = ["UNAVAILABLE", "FORBIDDEN", "BLOCKED", "DRIFTED", "STALE"] as const;

export type DependencyRole = "required" | "corroborating" | "optional";

export interface DegradedEntry {
  sourceType: AssertionType;
  dependency: DependencyRole;
  reason: string;
}

/** The claim's declared dependencies. A claim that declares none needs an authorization record, and a study when it states a number. */
export function dependenciesOf(claim: Claim): { required: Set<AssertionType>; corroborating: Set<AssertionType> } {
  if (claim.dependencies) {
    return { required: new Set(claim.dependencies.required), corroborating: new Set(claim.dependencies.corroborating) };
  }
  return { required: new Set<AssertionType>(claim.performance ? ["authorization", "study"] : ["authorization"]), corroborating: new Set() };
}

export function roleOf(type: AssertionType, deps: ReturnType<typeof dependenciesOf>): DependencyRole {
  return deps.required.has(type) ? "required" : deps.corroborating.has(type) ? "corroborating" : "optional";
}

/**
 * An evidence item the service takes from the regulator's decision summary but types as a study, because it reports what the pivotal
 * study analysed (for example "the analysis population was aged 22 and older"). The summary is the regulator's own record, and the
 * authority matrix (docs/02 section 4) makes the regulator record authoritative for the population and setting the authorization
 * covers. The marker is a limitation line on the item, so it is part of the dossier's evidence and the verifier's recompute sees it.
 */
export const REGULATOR_RECORD_NOTE = "taken from the regulator's decision summary";

export const isRegulatorRecord = (item: EvidenceItem): boolean => item.limitations.some((l) => l.startsWith(REGULATOR_RECORD_NOTE));

export interface Pools {
  claim: Claim;
  options: ResolvedOptions;
  deps: ReturnType<typeof dependenciesOf>;
  /** Items whose source can be relied on. Records of a lost or empty source are not read at all. */
  usable: EvidenceItem[];
  /** Records for the product dimension: usable, adequate, required types, any product. */
  productAuth: EvidenceItem[];
  productStudy: EvidenceItem[];
  /** Records that establish scope: usable, adequate, required type, same product as the claim, authorization in force. */
  supportAuth: EvidenceItem[];
  supportStudy: EvidenceItem[];
  /**
   * Study-typed items taken from the regulator's decision summary (see REGULATOR_RECORD_NOTE). Where the authorization is silent on a
   * dimension they bound the claim, as the authorization would. A registry entry or a publication never does.
   */
  regulatorStudy: EvidenceItem[];
  /** Authorization records for the timing dimension: as supportAuth but not filtered by the claimed dates. */
  windowAuth: EvidenceItem[];
  /** Authorization records whose explicit limits can contradict the claim, whatever role the claim gives the type. */
  limitAuth: EvidenceItem[];
  limitWindowAuth: EvidenceItem[];
  /** Study records inspected for contrary results, whatever role the claim gives the type and whatever their adequacy. */
  watchStudy: EvidenceItem[];
  requirement: EvidenceItem[];
  vendor: EvidenceItem[];
  /** Claimed period in day numbers, when the claim gives a start. */
  period?: { from: number; to: number };
}

export function isUsableType(type: AssertionType, options: ResolvedOptions): boolean {
  const status = options.sourceHealth[type];
  return status === undefined || status.health === "OK";
}

function windowOf(item: EvidenceItem): { from: number; to: number } | undefined {
  const t = item.scope.timing;
  if (!t || (t.from === undefined && t.to === undefined)) return undefined;
  return { from: t.from !== undefined ? dayNumber(t.from) : -Infinity, to: t.to !== undefined ? dayNumber(t.to) : Infinity };
}

export function periodOf(claim: Claim): { from: number; to: number } | undefined {
  const t = claim.use.timing;
  if (!t || t.from === undefined) return undefined;
  const from = dayNumber(t.from);
  return { from, to: t.to !== undefined ? dayNumber(t.to) : from };
}

export function buildPools(prep: Prepared): Pools {
  const { claim, evidence, options } = prep;
  const deps = dependenciesOf(claim);
  const period = periodOf(claim);
  const usable = evidence.filter((e) => isUsableType(e.assertionType, options));
  const adequate = (e: EvidenceItem) => e.adequate !== false;
  const sameProduct = (e: EvidenceItem) => claim.use.product === undefined || e.scope.product === undefined || e.scope.product === claim.use.product;
  const inForce = (e: EvidenceItem) => {
    if (!period) return true;
    const w = windowOf(e);
    return w === undefined || (w.from <= period.to && period.from <= w.to);
  };

  const of = (type: AssertionType) => usable.filter((e) => e.assertionType === type);
  const requiredOnly = (items: EvidenceItem[], type: AssertionType) => (deps.required.has(type) ? items : []);

  const pools: Pools = {
    claim,
    options,
    deps,
    usable,
    productAuth: requiredOnly(of("authorization"), "authorization").filter(adequate),
    productStudy: requiredOnly(of("study"), "study").filter(adequate),
    windowAuth: requiredOnly(of("authorization"), "authorization").filter(adequate).filter(sameProduct),
    supportAuth: requiredOnly(of("authorization"), "authorization").filter(adequate).filter(sameProduct).filter(inForce),
    supportStudy: requiredOnly(of("study"), "study").filter(adequate).filter(sameProduct),
    regulatorStudy: of("study").filter(adequate).filter(sameProduct).filter(isRegulatorRecord),
    limitWindowAuth: of("authorization").filter(adequate).filter(sameProduct),
    limitAuth: of("authorization").filter(adequate).filter(sameProduct).filter(inForce),
    watchStudy: of("study").filter(sameProduct),
    requirement: of("requirement"),
    vendor: of("vendor"),
  };
  if (period) pools.period = period;
  return pools;
}

/** Status of every evidence type that matters, with the text the Finding's `degraded` entries carry. */
export function degradation(pools: Pools, evidence: readonly EvidenceItem[]): { entries: DegradedEntry[]; lostRequired: AssertionType[] } {
  const { options, deps } = pools;
  const entries: DegradedEntry[] = [];
  const lostRequired: AssertionType[] = [];

  for (const type of [...ASSERTION_TYPES].sort(cmp)) {
    const role = roleOf(type, deps);
    const status = options.sourceHealth[type];
    const supplied = evidence.filter((e) => e.assertionType === type).length;
    const where = status?.sourceId ? ` in source ${status.sourceId}` : "";
    let reason: string | undefined;

    if (status && status.health !== "OK") {
      const note = status.note ? ` (${status.note})` : "";
      if (status.health === "EMPTY") {
        const on = status.checkedOn ? ` on ${status.checkedOn}` : "";
        reason = `EMPTY: none found${where}${on}. This is a statement about that search only, not about whether such evidence exists.${supplied ? ` ${supplied} supplied ${type} record(s) were not read.` : ""}`;
      } else {
        reason = `${status.health}: the ${type} source${where} cannot be relied on right now${note}.${supplied ? ` ${supplied} supplied ${type} record(s) were not read.` : ""}`;
      }
    } else if (supplied === 0 && role !== "optional") {
      reason = `NOT_SUPPLIED: no ${type} record was supplied to the compiler. This is not an outage and not an empty search; the source was never consulted for this claim.`;
    }

    if (reason === undefined) continue;
    entries.push({ sourceType: type, dependency: role, reason });
    if (role === "required") lostRequired.push(type);
  }
  return { entries, lostRequired };
}
