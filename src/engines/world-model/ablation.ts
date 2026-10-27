import { WorldModel, type WorldModelOptions } from "./index.ts";

/**
 * MA-1: what the World Model changes about stale findings.
 *
 * The pre-registered question (docs/04-meterless-plan.md, section 4): after a source changes, how
 * many findings that used it are left unflagged when the World Model is absent, and how many when it
 * is present? This module only measures; the synthetic sessions it is run on live in the tests.
 *
 * Three arms are compared on one session:
 *  - `absent`: no dependency tracking. Nothing is flagged. The number of unflagged stale findings
 *    is therefore the number of stale findings, by construction. That arm is the reference point,
 *    not an experiment: an engine that is not there cannot flag anything.
 *  - `present`: the engine's own `staleFindings()`.
 *  - `recompute-everything`: the alternative that needs no dependency tracking, which flags every
 *    finding after any change. It misses nothing and pays for it in recomputation.
 *
 * Ground truth is computed by an independent evaluator over plain arrays: a finding is stale if the
 * value it consumed from any slot differs from the value that slot resolves to now, or if a fact it
 * used has been retracted. It uses the same rule the engine's default policy uses (the most recent
 * observation wins) but none of the engine's code.
 */

export interface SessionFact {
  key: string;
  about: string;
  predicate: string;
  value: unknown;
  at: string;
  kind: string;
  confidence?: number;
}

export type SessionChange =
  | { op: "assert"; fact: SessionFact }
  | { op: "retract"; factKey: string; at: string };

export interface SessionFinding {
  id: string;
  /** Keys of the facts the finding was computed from. */
  uses: string[];
}

export interface Ma1Session {
  entities: { id: string; type: string }[];
  facts: SessionFact[];
  findings: SessionFinding[];
  changes: SessionChange[];
}

export interface Ma1Arm {
  arm: "absent" | "present" | "recompute-everything";
  findings: number;
  /** Findings whose inputs really changed (independent evaluator). */
  stale: number;
  flagged: number;
  /** Stale findings the arm did not flag: the harm. */
  staleUnflagged: number;
  /** Flagged findings whose inputs did not change: the cost. */
  flaggedUnnecessarily: number;
  /** Findings that must be recomputed under this arm. */
  recomputations: number;
}

export interface Ma1Report {
  arms: Ma1Arm[];
  /** For the `present` arm: findings flagged that the value-based evaluator calls unchanged, and why. */
  overFlagging: { findingId: string; reasons: string[] }[];
}

interface Slot {
  facts: { key: string; value: unknown; at: string; order: number; retracted: boolean }[];
}

function independentTruth(session: Ma1Session): Set<string> {
  const slots = new Map<string, Slot>();
  const byKey = new Map<string, { slot: string }>();
  let order = 0;
  const add = (f: SessionFact) => {
    const slot = `${f.about}|${f.predicate}`;
    const s = slots.get(slot) ?? { facts: [] };
    s.facts.push({ key: f.key, value: f.value, at: f.at, order: order++, retracted: false });
    slots.set(slot, s);
    byKey.set(f.key, { slot });
  };
  const current = (slot: string): unknown => {
    const live = (slots.get(slot)?.facts ?? []).filter((f) => !f.retracted).sort((a, b) => b.at.localeCompare(a.at) || b.order - a.order);
    return live[0]?.value;
  };
  for (const f of session.facts) add(f);

  // What each finding consumed when it was computed: the value its slots resolved to before the changes.
  const consumed = new Map<string, Map<string, unknown>>();
  for (const finding of session.findings) {
    const seen = new Map<string, unknown>();
    for (const key of finding.uses) {
      const slot = byKey.get(key)!.slot;
      seen.set(slot, current(slot));
    }
    consumed.set(finding.id, seen);
  }
  const retractedUsed = new Set<string>();
  for (const change of session.changes) {
    if (change.op === "assert") add(change.fact);
    else {
      const slot = byKey.get(change.factKey)!.slot;
      const fact = slots.get(slot)!.facts.find((f) => f.key === change.factKey)!;
      fact.retracted = true;
      for (const finding of session.findings) if (finding.uses.includes(change.factKey)) retractedUsed.add(finding.id);
    }
  }
  const stale = new Set<string>();
  for (const finding of session.findings) {
    const seen = consumed.get(finding.id)!;
    const changed = [...seen].some(([slot, value]) => JSON.stringify(current(slot)) !== JSON.stringify(value));
    if (changed || retractedUsed.has(finding.id)) stale.add(finding.id);
  }
  return stale;
}

/** Runs the session on a fresh World Model and returns the three arms. */
export async function measureStaleFlagging(session: Ma1Session, options: Partial<WorldModelOptions> = {}): Promise<Ma1Report> {
  const truth = independentTruth(session);
  const world = new WorldModel({ storage: "memory", namespace: "ma1", ...options });
  const ids = new Map<string, string>();
  try {
    for (const e of session.entities) await world.upsertEntity({ type: e.type, externalKey: { system: "ma1", id: e.id }, name: e.id, source: { kind: "manual", at: "2026-01-01T00:00:00.000Z" } });
    const assertFact = async (f: SessionFact) => {
      const rec = await world.assertFact({ about: f.about, predicate: f.predicate, value: f.value, confidence: f.confidence ?? 0.5, source: { kind: f.kind, at: f.at } });
      ids.set(f.key, rec.id);
    };
    for (const f of session.facts) await assertFact(f);
    for (const finding of session.findings) await world.declareDependencies({ findingId: finding.id, refs: finding.uses.map((k) => ids.get(k)!) });
    for (const change of session.changes) {
      if (change.op === "assert") await assertFact(change.fact);
      else await world.retractFact({ factId: ids.get(change.factKey)!, source: { kind: "manual", at: change.at } });
    }
    const flagged = new Set(world.staleFindings());
    const total = session.findings.length;
    const arm = (name: Ma1Arm["arm"], marked: Set<string>): Ma1Arm => ({
      arm: name,
      findings: total,
      stale: truth.size,
      flagged: marked.size,
      staleUnflagged: [...truth].filter((id) => !marked.has(id)).length,
      flaggedUnnecessarily: [...marked].filter((id) => !truth.has(id)).length,
      recomputations: marked.size,
    });
    const overFlagging = [...flagged]
      .filter((id) => !truth.has(id))
      .map((id) => ({ findingId: id, reasons: [...new Set(world.finding(id)!.stale!.causes.map((c) => c.reason))] }));
    return {
      arms: [arm("absent", new Set()), arm("present", flagged), arm("recompute-everything", new Set(session.findings.map((f) => f.id)))],
      overFlagging,
    };
  } finally {
    world.close();
  }
}
