import { canonicalJson } from "../../util/canonical.ts";
import type { ConflictPolicy, Fact, ISODate, PolicySetting, Relationship } from "./types.ts";

/**
 * Pure functions over plain data. Fact resolution and relationship supersession are computed here
 * from the folded event log, never stored as side effects, so replaying the same log under the same
 * policy always produces the same winners (the reference mutates entity attributes at write time,
 * which a replay cannot reproduce).
 */

/** A fact as the fold holds it: the asserted record plus its position in the log. */
export interface FactRecord extends Fact {
  seq: number;
  recordedAt: ISODate;
  retracted?: { by: string; reason?: string; seq: number };
}

export interface PolicyConfig {
  policy: PolicySetting;
  sourcePriority: readonly string[];
}

export function policyFor(config: PolicyConfig, predicate: string): ConflictPolicy {
  const p = config.policy;
  if (typeof p === "string") return p;
  return p.byPredicate?.[predicate] ?? p.default;
}

const effectiveFrom = (f: Fact): ISODate => f.validFrom ?? f.assertedAt;

function priorityOf(kind: string, ranking: readonly string[]): number {
  const idx = ranking.indexOf(kind);
  return idx === -1 ? Number.MAX_SAFE_INTEGER : idx;
}

/** Negative when `a` outranks `b`. Total order: `seq` is unique, so there are no ties. */
function compareFacts(a: FactRecord, b: FactRecord, policy: ConflictPolicy, ranking: readonly string[]): number {
  const byTime = effectiveFrom(b).localeCompare(effectiveFrom(a));
  const bySeq = b.seq - a.seq;
  switch (policy) {
    case "highest-confidence-wins":
      return b.confidence - a.confidence || byTime || bySeq;
    case "source-priority":
      return priorityOf(a.source.kind, ranking) - priorityOf(b.source.kind, ranking) || byTime || bySeq;
    case "most-recent-wins":
    case "manual":
      return byTime || bySeq;
  }
}

export type RivalStatus = "superseded" | "retracted" | "outside-validity" | "undecided";

export interface SlotResolution {
  about: string;
  predicate: string;
  /**
   * resolved: a winner exists.
   * unresolved: the policy is `manual`, candidates disagree and no reviewer has chosen.
   * none: no usable fact (never asserted, all retracted, or none valid at the requested time).
   */
  status: "resolved" | "unresolved" | "none";
  policy: ConflictPolicy;
  winner?: FactRecord;
  decidedBy?: "policy" | "reviewer" | "sole-candidate";
  rivals: { fact: FactRecord; status: RivalStatus; supersededBy?: string }[];
  /** Candidates disagree on the value (whether or not a winner was chosen). */
  conflict: boolean;
  /** A reviewer chose a fact and a newer candidate has arrived since. */
  decisionOutdated: boolean;
  reason: string;
}

export interface ResolveOptions {
  config: PolicyConfig;
  /** Valid time. Absent means "everything known", not wall-clock now. */
  at?: ISODate;
  /** A reviewer's choice for this slot, if any. */
  manualChoice?: { factId: string; seq: number };
}

export function resolveSlot(about: string, predicate: string, facts: readonly FactRecord[], opts: ResolveOptions): SlotResolution {
  const policy = policyFor(opts.config, predicate);
  const rivals: SlotResolution["rivals"] = [];
  const candidates: FactRecord[] = [];
  for (const f of facts) {
    if (f.retracted) {
      rivals.push({ fact: f, status: "retracted" });
    } else if (opts.at !== undefined && !(effectiveFrom(f) <= opts.at && (f.validTo === undefined || opts.at < f.validTo))) {
      rivals.push({ fact: f, status: "outside-validity" });
    } else {
      candidates.push(f);
    }
  }
  const distinct = new Set(candidates.map((f) => canonicalJson(f.value)));
  const conflict = distinct.size > 1;
  const base = { about, predicate, policy, conflict, decisionOutdated: false };
  if (candidates.length === 0) {
    return { ...base, status: "none", rivals, reason: facts.length === 0 ? "no fact asserted" : "no fact is usable (retracted or outside validity)" };
  }

  const chosen = opts.manualChoice && candidates.find((f) => f.id === opts.manualChoice!.factId);
  let winner: FactRecord;
  let decidedBy: SlotResolution["decidedBy"];
  let reason: string;
  let decisionOutdated = false;
  if (chosen) {
    winner = chosen;
    decidedBy = "reviewer";
    decisionOutdated = candidates.some((f) => f.seq > opts.manualChoice!.seq);
    reason = `reviewer chose ${winner.id}`;
  } else if (candidates.length === 1) {
    winner = candidates[0]!;
    decidedBy = "sole-candidate";
    reason = "single candidate";
  } else if (policy === "manual" && conflict) {
    return {
      ...base,
      status: "unresolved",
      rivals: [...rivals, ...candidates.map((fact) => ({ fact, status: "undecided" as const }))],
      reason: "policy is manual and candidates disagree: a reviewer must choose",
    };
  } else {
    const ranking = opts.config.sourcePriority;
    const ordered = [...candidates].sort((a, b) => compareFacts(a, b, policy, ranking));
    winner = ordered[0]!;
    decidedBy = "policy";
    const runnerUp = ordered[1]!;
    reason = `${policy}: ${winner.id} (${describe(winner, policy)}) over ${runnerUp.id} (${describe(runnerUp, policy)})`;
  }
  for (const f of candidates) if (f.id !== winner.id) rivals.push({ fact: f, status: "superseded", supersededBy: winner.id });
  return { ...base, status: "resolved", winner, decidedBy, rivals, decisionOutdated, reason };
}

function describe(f: FactRecord, policy: ConflictPolicy): string {
  switch (policy) {
    case "highest-confidence-wins":
      return `confidence ${f.confidence}`;
    case "source-priority":
      return `source ${f.source.kind}`;
    default:
      return effectiveFrom(f);
  }
}

/* ---------------------------------------------------------------- relationships */

export interface EffectiveEdge {
  validTo?: ISODate;
  supersededBy?: string;
}

/**
 * Effective end of validity for each edge in one `(from, type, context)` group of a single-valued
 * type. An edge ends at the validity start of the next edge, in (validFrom, record order), that
 * points elsewhere. This is order independent: an edge that arrives late but starts earlier is
 * itself closed by the later-starting edge, instead of closing it (the reference closes whichever
 * edge is open when the new one arrives, which produces an end before its own start for
 * back-filled history).
 *
 * `edges` must already have endpoints resolved through merge aliases.
 */
export function effectiveSingleValued(edges: readonly (Relationship & { seq: number })[]): Map<string, EffectiveEdge> {
  const sorted = [...edges].sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.seq - b.seq);
  const out = new Map<string, EffectiveEdge>();
  sorted.forEach((edge, i) => {
    const next = sorted.slice(i + 1).find((e) => e.to !== edge.to);
    let validTo = edge.validTo;
    let supersededBy: string | undefined;
    if (next && (validTo === undefined || next.validFrom < validTo)) {
      validTo = next.validFrom;
      supersededBy = next.id;
    }
    out.set(edge.id, { ...(validTo !== undefined ? { validTo } : {}), ...(supersededBy ? { supersededBy } : {}) });
  });
  return out;
}

export function isValidAt(edge: { validFrom: ISODate; validTo?: ISODate }, at: ISODate): boolean {
  return edge.validFrom <= at && (edge.validTo === undefined || at < edge.validTo);
}
