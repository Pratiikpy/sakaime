import { FindingSchema, type Finding } from "../schemas/index.ts";
import { CompilerInputError } from "./input.ts";

/**
 * Change impact. The findings that depend on at least one of the changed facts, in the order given, and nothing else.
 * Dependence is exactly what each finding recorded in `dependsOnFacts` when it was computed.
 */
export function staleFindings(findings: readonly Finding[], changedFactIds: Iterable<string>): Finding[] {
  const changed = new Set(changedFactIds);
  if (changed.size === 0) return [];
  return findings.filter((f) => f.dependsOnFacts.some((id) => changed.has(id)));
}

/**
 * A newer finding that replaces an older one. The older finding is read, never written: the result is a new object
 * that records which finding it replaces and why, and history keeps both.
 */
export function supersede(newer: Finding, older: Finding, reason: string): Finding {
  const why = reason.trim();
  if (why.length === 0) throw new CompilerInputError(["supersedesReason: a reason is required"]);
  if (newer.claimId !== older.claimId) {
    throw new CompilerInputError([`supersedes: finding ${newer.id} is for claim ${newer.claimId}, not ${older.claimId}`]);
  }
  if (newer.id === older.id) {
    throw new CompilerInputError(["supersedes: identical inputs give the same finding id, so there is nothing to supersede"]);
  }
  return FindingSchema.parse({ ...newer, supersedes: older.id, supersedesReason: why });
}
