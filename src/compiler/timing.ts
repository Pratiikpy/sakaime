import type { ExpertFlag, Scope } from "../schemas/index.ts";
import { gapsOf, intersect, listContains, mergeIntervals, type Interval } from "./intervals.ts";
import type { Pools } from "./pools.ts";
import { genericRequest } from "./requests.ts";
import type { DimResult, Explicit } from "./types.ts";
import { dayNumber, formatDay, sortedUnique, worst } from "./util.ts";

const day = (n: number): string => formatDay(n);

function renderWindow(i: Interval): string {
  const noStart = i.lo === -Infinity;
  const noEnd = i.hi === Infinity;
  if (noStart && noEnd) return "with no stated dates";
  if (noEnd) return `from ${day(i.lo)} with no stated end`;
  if (noStart) return `until ${day(i.hi)}`;
  return `from ${day(i.lo)} to ${day(i.hi)}`;
}

function renderGapDays(lo: number, hi: number, loOpen: boolean, hiOpen: boolean): string {
  if (lo === -Infinity) return `before ${day(hi)}`;
  if (hi === Infinity) return `after ${day(lo)}`;
  return `${loOpen ? "after" : "from"} ${day(lo)} ${hiOpen ? "until before" : "to"} ${day(hi)}`;
}

/**
 * Timing is not set containment, so it has its own evaluator.
 *
 * Authorization records define a window (effective from, superseded or withdrawn on). The claimed period must lie in it.
 * A claim that names only a start is assessed at that date. Study records are dated by when the evidence existed: it must
 * not postdate the claimed start. Staleness is measured at the end of the claimed period and only against a window the caller
 * configures, because no standard sets one.
 */
export function evaluateTiming(pools: Pools, use: Scope): DimResult {
  const dimension = "timing" as const;
  const t = use.timing;
  const flags: ExpertFlag[] = [];
  const explicit: Explicit[] = [];

  if (!t || t.from === undefined) {
    return {
      dimension,
      relation: "UNKNOWN",
      evidenceIds: [],
      anchorIds: [],
      reason: t?.to !== undefined ? "The claim gives an end date but no start date, so the claimed period cannot be placed." : "The claim does not state a date, so nothing can be concluded about it.",
      request: genericRequest({ dimension, relation: "UNKNOWN", cause: "claim" }),
      ruleIds: ["SAK-CLAIM-UNSPECIFIED"],
      flags,
      explicit,
      pending: false,
    };
  }

  const period: Interval = { lo: dayNumber(t.from), hi: t.to !== undefined ? dayNumber(t.to) : dayNumber(t.from) };
  const claimed = t.to !== undefined ? `use from ${t.from} to ${t.to}` : `use from ${t.from}`;

  const windowItems = pools.windowAuth.filter((i) => i.scope.timing && (i.scope.timing.from !== undefined || i.scope.timing.to !== undefined));
  const windowOf = (i: (typeof windowItems)[number]): Interval => ({
    lo: i.scope.timing?.from !== undefined ? dayNumber(i.scope.timing.from) : -Infinity,
    hi: i.scope.timing?.to !== undefined ? dayNumber(i.scope.timing.to) : Infinity,
  });
  const windows = mergeIntervals(windowItems.map(windowOf));
  const studyDates = pools.supportStudy.filter((i) => i.scope.timing?.from !== undefined);

  const relations: ("CONTAINED" | "PARTIAL" | "DISJOINT")[] = [];
  const reasons: string[] = [];
  const established: string[] = [];
  const ruleIds: string[] = [];
  let narrower: Partial<Scope> | undefined;
  let gapText: string | undefined;
  let requestText: string | undefined;

  if (windows.length > 0) {
    established.push(`authorization record: in force ${windows.map(renderWindow).join(" and ")}`);
    if (listContains(windows, period)) {
      relations.push("CONTAINED");
      reasons.push(`The authorization record is in force ${windows.map(renderWindow).join(" and ")} and covers the ${claimed}.`);
    } else {
      const pieces = mergeIntervals(windows.map((w) => intersect(w, period)).filter((x): x is Interval => x !== undefined));
      if (pieces.length === 0) {
        relations.push("DISJOINT");
        const lastEnd = Math.max(...windows.map((w) => w.hi));
        if (period.hi < Math.min(...windows.map((w) => w.lo))) {
          ruleIds.push("R21-PREDATES-AUTH");
          reasons.push(`The authorization record took effect ${day(Math.min(...windows.map((w) => w.lo)))}; the ${claimed} begins before that.`);
          requestText = `From the vendor: the date from which the product may be used under the authorization. The claimed start (${t.from}) precedes the recorded effective date (${day(Math.min(...windows.map((w) => w.lo)))}).`;
        } else {
          ruleIds.push("SAK-AUTH-WINDOW-ENDED");
          reasons.push(
            Number.isFinite(lastEnd) && period.lo > lastEnd
              ? `The authorization record ended ${day(lastEnd)} (superseded or withdrawn); the ${claimed} begins after that. The record alone cannot say whether a successor authorization covers the use.`
              : `The ${claimed} falls outside every window in which the authorization record is in force (${windows.map(renderWindow).join(" and ")}).`,
          );
          requestText = `From the vendor: the successor authorization, or written confirmation of current marketing status, in force on ${t.from}.`;
        }
      } else {
        relations.push("PARTIAL");
        const gaps = gapsOf(period, windows);
        gapText = gaps.map((g) => renderGapDays(g.lo, g.hi, g.loOpen, g.hiOpen)).join(" and ");
        ruleIds.push(period.lo < Math.min(...windows.map((w) => w.lo)) ? "R21-PREDATES-AUTH" : "SAK-AUTH-WINDOW-ENDED");
        reasons.push(`The authorization record is in force ${windows.map(renderWindow).join(" and ")}; the ${claimed} also runs ${gapText}.`);
        if (pieces.length === 1) {
          const p = pieces[0]!;
          narrower = { timing: { from: day(p.lo), ...(t.to !== undefined ? { to: day(p.hi) } : {}) } };
        } else {
          flags.push({
            ruleId: "SAK-NARROWER-AMBIGUOUS",
            dimension,
            reason: `The authorization record covers the claimed period in ${pieces.length} separate windows, so no single narrower period can be stated.`,
          });
        }
        requestText = `From the vendor: an authorization record in force ${gapText}, or restate the claimed period as ${narrower?.timing ? `${narrower.timing.from}${narrower.timing.to ? ` to ${narrower.timing.to}` : ""}` : "the period covered"}.`;
      }
    }
  }

  // Explicit effective-date limit: read from every usable authorization record, whatever role the claim gives the type.
  const limitFroms = pools.limitWindowAuth.map((i) => i.scope.timing?.from).filter((x): x is string => x !== undefined);
  const limitHasOpenStart = pools.limitWindowAuth.some((i) => i.scope.timing && i.scope.timing.from === undefined);
  if (limitFroms.length > 0 && !limitHasOpenStart) {
    const earliest = limitFroms.map(dayNumber).reduce((a, b) => Math.min(a, b));
    if (period.lo < earliest) {
      explicit.push({
        ruleId: "R21-PREDATES-AUTH",
        text: `the authorization record took effect ${day(earliest)}; the claimed use starts ${t.from}`,
      });
    }
  }

  if (studyDates.length > 0) {
    const dates = studyDates.map((i) => dayNumber(i.scope.timing!.from!));
    const existed = dates.filter((d) => d <= period.lo);
    if (existed.length > 0) {
      const latest = Math.max(...existed);
      established.push(`study: newest evidence dated ${day(latest)}`);
      relations.push("CONTAINED");
      reasons.push(`Study evidence dated ${day(latest)} existed before the ${claimed} begins.`);
      const window = pools.options.policy.stalenessWindowDays;
      const age = period.hi - latest;
      if (window !== undefined && age > window) {
        flags.push({
          ruleId: "R20-STALENESS",
          dimension,
          reason: `The newest study evidence is dated ${day(latest)}, ${age} days before the end of the claimed period; the configured window is ${window} days. Whether it is still representative is a reviewer judgement.`,
        });
      }
    } else {
      const earliest = Math.min(...dates);
      established.push(`study: earliest evidence dated ${day(earliest)}`);
      relations.push("DISJOINT");
      ruleIds.push("SAK-STUDY-POSTDATES");
      reasons.push(`The earliest study evidence is dated ${day(earliest)}, after the ${claimed} begins; no study existed at the claimed start.`);
      requestText ??= `From the vendor: study evidence dated on or before ${t.from}.`;
    }
  }

  const items = [...windowItems, ...studyDates];
  const base = {
    dimension,
    claimed,
    evidenceIds: sortedUnique(items.map((i) => i.id)),
    anchorIds: sortedUnique(items.flatMap((i) => i.anchorIds)),
    flags,
    explicit,
    pending: false,
  };

  if (relations.length === 0) {
    return {
      ...base,
      relation: "UNKNOWN",
      reason: "No evidence record in use dates itself or states an authorization window, so the claimed dates cannot be placed against anything.",
      request: genericRequest({ dimension, relation: "UNKNOWN", cause: "evidence" }),
      ruleIds: ["R19-DATES-MISSING"],
    };
  }

  const studyUndated = pools.deps.required.has("study") && studyDates.length === 0;
  if (studyUndated) {
    ruleIds.push("R19-DATES-MISSING");
    reasons.push("The study records carry no date, so it cannot be shown that the evidence existed at the claimed start.");
    requestText ??= genericRequest({ dimension, relation: "UNKNOWN", cause: "evidence" });
  }
  const relation = worst([...relations, ...(studyUndated ? (["UNKNOWN"] as const) : [])]);
  const result: DimResult = {
    ...base,
    relation,
    established: established.join("; "),
    reason: reasons.join(" "),
    ruleIds: sortedUnique(ruleIds),
  };
  if (relation === "PARTIAL" && narrower) result.narrower = narrower;
  if (relation !== "CONTAINED") result.request = requestText ?? genericRequest({ dimension, relation, claimed, established: established.join("; "), ...(gapText ? { gap: gapText } : {}) });
  return result;
}
