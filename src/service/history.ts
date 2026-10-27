/**
 * Findings that a re-run replaced after a reviewer had decided on them.
 *
 * A decision is a statement about one finding, and the decision log is never rewritten. If the case is investigated again and
 * the evidence has moved, the finding for that claim has a new id (the id is a hash of the claim, the evidence and the rules),
 * and the reviewer's decision would point at a finding the dossier no longer holds. So when a re-run replaces a finding that has
 * a decision, the older finding is kept, with everything it was computed from, and the dossier lists it as superseded by the
 * newer one with the reason. When a re-run reproduces a finding exactly, nothing is archived: the id is the same and the
 * decision still applies.
 */
import { diffFindings } from "../compiler/index.ts";
import type { DecisionEntry } from "../dossier/index.ts";
import type { InvestigationResult } from "../agents/investigation.ts";
import type { Claim, Finding } from "../schemas/index.ts";

/** One stored finding with the compiler input it was computed from. */
export interface ChainMember {
  finding: Finding;
  claim: Claim;
  evidenceItemIds: string[];
}

/** The findings one run held for one claim, oldest first: two when the run revised its own finding, otherwise one. */
export interface ArchivedChain {
  claimId: string;
  /** The run that computed them. Its evidence, quotes, records and facts are kept so the older finding can be reproduced. */
  run: InvestigationResult;
  members: ChainMember[];
}

/** The chain a run holds for one of its claims. */
export function chainOf(run: InvestigationResult, claimId: string): ChainMember[] {
  const r = run.results.find((x) => x.claim.id === claimId);
  if (!r) return [];
  const rev = run.history.find((h) => h.kind === "revision" && h.newer.id === r.finding.id);
  if (rev) {
    return [
      { finding: rev.older, claim: r.compiled, evidenceItemIds: rev.olderEvidenceIds },
      { finding: rev.newer, claim: r.compiled, evidenceItemIds: r.evidence.map((i) => i.id) },
    ];
  }
  return [{ finding: r.finding, claim: r.compiled, evidenceItemIds: r.evidence.map((i) => i.id) }];
}

/**
 * The archive after `next` replaces `prior` as the case's record. A chain is kept when any of its findings has a decision and
 * no finding of the new run has the same id. Chains kept earlier stay, unless the new run reproduced one of their findings
 * (the finding is current again, and ids are never listed twice).
 */
export function archiveSuperseded(prior: InvestigationResult, archive: readonly ArchivedChain[], next: InvestigationResult, decisions: readonly Pick<DecisionEntry, "findingId">[]): ArchivedChain[] {
  const decided = new Set(decisions.map((d) => d.findingId));
  const nextIds = new Set(next.results.flatMap((r) => chainOf(next, r.claim.id).map((m) => m.finding.id)));
  const kept: ArchivedChain[] = [];
  for (const chain of archive) {
    const members = chain.members.filter((m) => !nextIds.has(m.finding.id));
    if (members.length > 0) kept.push({ ...chain, members });
  }
  const have = new Set(kept.flatMap((c) => c.members.map((m) => m.finding.id)));
  for (const r of prior.results) {
    const members = chainOf(prior, r.claim.id).filter((m) => !nextIds.has(m.finding.id) && !have.has(m.finding.id));
    if (members.length === 0 || !members.some((m) => decided.has(m.finding.id))) continue;
    kept.push({ claimId: r.claim.id, run: prior, members });
  }
  return kept;
}

/** Why a newer finding replaced an older one, in words a reviewer can check against the two findings. */
export function supersessionReason(older: Finding, newer: Finding): string {
  const d = diffFindings(older, newer);
  const parts: string[] = [];
  if (d.label.changed) parts.push(`the label moved from ${d.label.from} to ${d.label.to}`);
  for (const x of d.dimensions) parts.push(`${x.dimension} went from ${x.from} to ${x.to}`);
  if (d.supportedScopeChanged) parts.push("the supported scope changed");
  if (d.degradedChanged) parts.push("the set of sources that could not be read changed");
  const lead = "The case was investigated again and the evidence behind this claim is no longer the same as when the earlier finding was computed";
  return parts.length > 0 ? `${lead}: ${parts.join("; ")}.` : `${lead}: the sources read or the facts they gave differ, although the label and the dimension relations are the same.`;
}
