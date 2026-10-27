import type { ContraryDisposition, EvidenceItem, EvidenceResult, ExpertFlag } from "../schemas/index.ts";
import type { Pools } from "./pools.ts";
import { genericRequest } from "./requests.ts";
import { isPrevalenceDependent } from "./taxonomy.ts";
import type { DimResult } from "./types.ts";
import { cmp, fmtNumber, sortedUnique } from "./util.ts";

type Verdict = "SUPPORT" | "CONTRARY" | "STRADDLE" | "NOCI_ABOVE" | "NOCI_BELOW";

interface Row {
  item: EvidenceItem;
  result: EvidenceResult;
  verdict: Verdict;
}

export interface ContraryEntry {
  itemId: string;
  anchorIds: string[];
  text: string;
  /** contradiction: relevant, adequate, interval-backed. needs-disposition: a reviewer must rule. dispositioned: ruled out. */
  status: "contradiction" | "needs-disposition" | "dispositioned";
  relevant: boolean;
  disposition?: ContraryDisposition;
  why: string;
}

export interface MetricEvaluation {
  dim: DimResult;
  contrary: ContraryEntry[];
}

const describe = (r: EvidenceResult): string =>
  `${r.metric} ${fmtNumber(r.value)}${r.ci ? ` (CI ${fmtNumber(r.ci[0])} to ${fmtNumber(r.ci[1])})` : ""}${r.n !== undefined ? `, n=${r.n}` : ""}${r.operatingPoint ? `, operating point ${r.operatingPoint}` : ""}`;

function verdictOf(r: EvidenceResult, atLeast: number): Verdict {
  if (r.ci) {
    if (atLeast <= r.ci[0]) return "SUPPORT";
    if (atLeast > r.ci[1]) return "CONTRARY";
    return "STRADDLE";
  }
  return r.value >= atLeast ? "NOCI_ABOVE" : "NOCI_BELOW";
}

/**
 * The metric dimension: the claimed minimum value against the study results.
 *
 * Only study records supply measured results. Results at a different operating point, or at an unreported one, are not
 * comparable and are never read as supporting or contradicting. A result supports only when the lower bound of its interval
 * reaches the claimed minimum; a point estimate alone never does. Contrary material is classified, not just counted: see ContraryEntry.
 */
export function evaluateMetric(pools: Pools, isRelevant: (item: EvidenceItem) => boolean): MetricEvaluation {
  const { claim, options } = pools;
  const dimension = "metric" as const;
  const perf = claim.performance;
  const flags: ExpertFlag[] = [];

  if (!perf) {
    return {
      dim: {
        dimension,
        relation: "UNKNOWN",
        evidenceIds: [],
        anchorIds: [],
        reason: "The claim states no performance figure, so there is nothing to compare with the study results.",
        request: genericRequest({ dimension, relation: "UNKNOWN", cause: "claim" }),
        ruleIds: ["SAK-CLAIM-UNSPECIFIED"],
        flags,
        explicit: [],
        pending: false,
      },
      contrary: [],
    };
  }

  const claimOp = claim.use.operatingPoint;
  const claimed = `${perf.metric} at least ${fmtNumber(perf.atLeast)}${claimOp ? ` at operating point ${claimOp}` : ""}`;
  const supportIds = new Set(pools.supportStudy.map((i) => i.id));

  const matching: { item: EvidenceItem; result: EvidenceResult }[] = [];
  for (const item of pools.watchStudy) for (const result of item.results) if (result.metric === perf.metric) matching.push({ item, result });

  const comparable: Row[] = [];
  const notComparable: { item: EvidenceItem; result: EvidenceResult }[] = [];
  for (const m of matching) {
    const op = m.result.operatingPoint ?? m.item.scope.operatingPoint;
    const ok = (claimOp === undefined && op === undefined) || (claimOp !== undefined && op !== undefined && op === claimOp);
    if (ok) comparable.push({ ...m, verdict: verdictOf(m.result, perf.atLeast) });
    else notComparable.push(m);
  }

  // Contrary candidates, classified.
  const contrary: ContraryEntry[] = [];
  const dispositionedAway = new Set<Row>();
  for (const row of comparable) {
    if (row.verdict !== "CONTRARY" && row.verdict !== "NOCI_BELOW") continue;
    const disp = options.dispositions.get(row.item.id);
    const relevantComputed = isRelevant(row.item);
    const relevance = disp?.relevance ?? (relevantComputed ? "relevant" : "off_scope");
    const adequate = disp?.adequate ?? row.item.adequate;
    const text = `${row.item.id}: ${describe(row.result)} against the claimed minimum ${fmtNumber(perf.atLeast)}`;
    let status: ContraryEntry["status"];
    let why: string;
    if (disp) {
      if (relevance === "relevant" && adequate === true) {
        status = "contradiction";
        why = "a reviewer recorded it as relevant and adequate";
      } else if (relevance === "relevant" && adequate === undefined) {
        status = "needs-disposition";
        why = "the recorded disposition says relevant but does not say whether the study is adequate";
      } else {
        status = "dispositioned";
        why = relevance === "relevant" ? "a reviewer recorded the study as inadequate" : `a reviewer recorded it as ${relevance === "weak" ? "weak" : "outside the claimed scope"}`;
      }
    } else if (relevance === "relevant" && adequate === true && row.verdict === "CONTRARY") {
      status = "contradiction";
      why = "the study covers the claimed scope, is adequate, and its interval lies wholly below the claimed minimum";
    } else {
      status = "needs-disposition";
      why = !relevantComputed
        ? "the study does not cover the claimed scope"
        : adequate === false
          ? "the study is recorded as inadequate"
          : adequate === undefined
            ? "the adequacy of the study is not established"
            : "the result has no confidence interval, so it cannot be tested against the claimed minimum";
    }
    const entry: ContraryEntry = { itemId: row.item.id, anchorIds: sortedUnique([...row.item.anchorIds, ...(row.result.anchorId ? [row.result.anchorId] : [])]), text, status, relevant: relevance === "relevant", why };
    if (disp) entry.disposition = disp;
    contrary.push(entry);
    if (status === "dispositioned") dispositionedAway.add(row);
  }

  const live = comparable.filter((r) => !dispositionedAway.has(r));
  const relevantLive = live.filter((r) => supportIds.has(r.item.id) && isRelevant(r.item));
  const blockingContrary = contrary.filter((c) => (c.status === "contradiction" || c.status === "needs-disposition") && c.relevant);
  const supportRows = relevantLive.filter((r) => r.verdict === "SUPPORT");
  // Inconclusive results from other records do not veto a supporting one: they do not contradict it. Only contrary results do.
  const openRows = relevantLive.filter((r) => r.verdict !== "SUPPORT");

  for (const c of contrary.filter((x) => x.status === "needs-disposition")) {
    flags.push({
      ruleId: "SAK-CONTRARY-UNDISPOSITIONED",
      dimension,
      reason: `Contrary result, ${c.text}. It has no usable disposition: ${c.why}. A reviewer must record one before any supported label.`,
    });
  }
  if (isPrevalenceDependent(perf.metric)) {
    flags.push({
      ruleId: "R14-PREVALENCE-TRANSPORT",
      dimension,
      reason: `${perf.metric} depends on how common the condition was in the tested population. The evidence carries no prevalence, so whether the figure carries over to the local population is a reviewer judgement.`,
    });
  }

  const usedRows = [...live, ...dispositionedAway];
  const evidenceIds = sortedUnique(usedRows.map((r) => r.item.id));
  const anchorIds = sortedUnique(usedRows.flatMap((r) => [...r.item.anchorIds, ...(r.result.anchorId ? [r.result.anchorId] : [])]));
  const established = usedRows.length ? usedRows.map((r) => `${r.item.id}: ${describe(r.result)}`).sort(cmp).join("; ") : undefined;
  const base = { dimension, claimed, evidenceIds, anchorIds, flags, explicit: [], pending: false } as const;
  const mk = (relation: DimResult["relation"], reason: string, ruleIds: string[], request?: string, derived = false): MetricEvaluation => {
    const dim: DimResult = { ...base, flags: [...flags], explicit: [], relation, reason, ruleIds, ...(established ? { established } : {}) };
    if (request) dim.request = request;
    if (derived) dim.derived = true;
    return { dim, contrary };
  };

  if (blockingContrary.length > 0) {
    const worstRow = blockingContrary[0]!;
    return mk(
      "DISJOINT",
      `A study result lies below the claim: ${worstRow.text}. ${worstRow.status === "contradiction" ? `It counts against the claim because ${worstRow.why}.` : `Whether it counts against the claim is not settled: ${worstRow.why}.`}`,
      ["R34-CLAIMED-VALUE-VS-CI"],
      `From the vendor: a written explanation of the gap between the claimed ${perf.metric} (at least ${fmtNumber(perf.atLeast)}) and the reported result in ${worstRow.itemId}, or restate the claim at a value the data support.`,
    );
  }

  if (supportRows.length > 0) {
    const weak = supportRows.filter((r) => {
      const { minResultN, maxCiWidth } = options.policy;
      return (minResultN !== undefined && (r.result.n === undefined || r.result.n < minResultN)) || (maxCiWidth !== undefined && r.result.ci !== undefined && r.result.ci[1] - r.result.ci[0] > maxCiWidth);
    });
    for (const r of weak) {
      flags.push({
        ruleId: "R13-RESULT-IMPRECISE",
        dimension,
        reason: `The supporting result in ${r.item.id} (${describe(r.result)}) falls outside the configured precision policy. Whether it is precise enough is a reviewer judgement.`,
      });
    }
    return mk("CONTAINED", `The reported interval for ${perf.metric} lies at or above the claimed minimum of ${fmtNumber(perf.atLeast)}, in a study that covers the claimed scope.`, ["R34-CLAIMED-VALUE-VS-CI"]);
  }

  // UNKNOWN: say precisely why.
  const reasons: string[] = [];
  const ruleIds: string[] = [];
  let request: string | undefined;
  let derived = false;
  if (matching.length === 0) {
    ruleIds.push("R32-METRIC-ABSENT");
    reasons.push(`No study result reports ${perf.metric}.`);
    request = `From the vendor: the study result for ${perf.metric}${claimOp ? ` at operating point ${claimOp}` : ""} for the claimed version and population, with its confidence interval and the operating point it was measured at.`;
  } else if (comparable.length === 0) {
    ruleIds.push("R33-OPERATING-POINT");
    const ops = sortedUnique(notComparable.map((m) => m.result.operatingPoint ?? m.item.scope.operatingPoint ?? "unreported"));
    reasons.push(
      `${perf.metric} is reported only at operating point ${ops.join(", ")}, while the claim ${claimOp ? `is made at ${claimOp}` : "names no operating point"}. Results at different thresholds are not comparable.`,
    );
    request = `From the vendor: the result for ${perf.metric} at ${claimOp ? `operating point ${claimOp}` : "the threshold the claim refers to"}, or confirmation of which operating point the claim concerns.`;
  } else if (relevantLive.length === 0) {
    ruleIds.push("R32-METRIC-ABSENT");
    derived = true;
    reasons.push(`${perf.metric} is reported only by records that do not cover the claimed scope or are not among the evidence the claim depends on.`);
    request = `From the vendor: a result for ${perf.metric} measured in the claimed version, population and setting, with its confidence interval.`;
  } else {
    ruleIds.push("R34-CLAIMED-VALUE-VS-CI");
    for (const r of openRows) {
      reasons.push(
        r.verdict === "STRADDLE"
          ? `In ${r.item.id} the interval for ${perf.metric} (${fmtNumber(r.result.ci![0])} to ${fmtNumber(r.result.ci![1])}) includes the claimed minimum ${fmtNumber(perf.atLeast)}, so the data neither support nor contradict it.`
          : `${r.item.id} reports ${perf.metric} ${fmtNumber(r.result.value)} with no confidence interval, so the claimed minimum ${fmtNumber(perf.atLeast)} cannot be tested.`,
      );
    }
    request = `From the vendor: a confidence interval for ${perf.metric} whose lower bound is at or above ${fmtNumber(perf.atLeast)}, or restate the claim at a value the data support.`;
  }
  return mk("UNKNOWN", reasons.join(" "), ruleIds, request, derived);
}
