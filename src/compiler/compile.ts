import type { ContraryDisposition, Dimension, Finding, Relation } from "../schemas/index.ts";
import { DIMENSIONS, FindingSchema } from "../schemas/index.ts";
import { hashOf } from "../util/canonical.ts";
import { decide } from "./engine.ts";
import { summarise } from "./explain.ts";
import { prepare, type CompileOptions, type Prepared } from "./input.ts";
import { genericRequest } from "./requests.ts";
import type { DimResult, TraceStep } from "./types.ts";
import { cmp, sortedUnique } from "./util.ts";

/** The plain-language account of one dimension, tied to the finding it belongs to. */
export interface DimensionReason {
  findingId: string;
  dimension: Dimension;
  relation: Relation;
  /** Deterministic rules that decided the relation. */
  ruleIds: string[];
  text: string;
}

export interface CompileDetail {
  finding: Finding;
  reasons: DimensionReason[];
  /** Why each rule fired, in dimension order, for the JSONL trace. */
  trace: TraceStep[];
  /** Why the label is what it is. */
  labelBasis: string[];
  /** One paragraph restating the finding. */
  summary: string;
  /** Dispositions supplied for evidence that turned out not to be contrary material. They were not applied. */
  unusedDispositions: string[];
}

function factIdsOf(prep: Prepared, usedItemIds: readonly string[]): string[] {
  const out = new Set<string>();
  for (const id of usedItemIds) for (const f of prep.options.factIds.get(id) ?? [id]) out.add(f);
  return [...out].sort(cmp);
}

/**
 * The Applicability Compiler. A pure function of its arguments: no clock, no randomness, no model, no I/O.
 * Inputs are checked against the shared schemas (junk throws CompilerInputError) and canonicalised before use, so the
 * output is the same whatever the order or spelling of the inputs, and identical inputs under one `ruleVersion` give an
 * identical Finding.
 */
export function compileDetailed(claim: unknown, evidence: unknown, options?: CompileOptions): CompileDetail {
  const prep = prepare(claim, evidence, options);
  const decision = decide(prep);
  const { analysis } = decision;
  const { dims, contrary, pools } = analysis;
  const required = prep.options.requiredDimensions;

  const id = `fnd_${hashOf({ ruleVersion: prep.options.ruleVersion, claim: prep.claim, evidence: prep.evidence, options: prep.options.fingerprint }).slice(0, 32)}`;

  const mechanicalCoverage = DIMENSIONS.map((d) => {
    const r = dims[d];
    return {
      dimension: d,
      relation: r.relation,
      ...(r.claimed !== undefined ? { claimed: r.claimed } : {}),
      ...(r.established !== undefined ? { established: r.established } : {}),
      anchorIds: r.anchorIds,
      evidenceIds: r.evidenceIds,
    };
  });

  const notContained = DIMENSIONS.filter((d) => required.has(d) && dims[d].relation !== "CONTAINED").map((d) => dims[d]);
  // A dimension that is unknown only because of the others is not a separate counterexample.
  const open: DimResult[] = notContained.filter((r) => !(r.derived && notContained.some((o) => o !== r)));
  const mismatches = open.map((r) => ({
    dimension: r.dimension,
    relation: r.relation,
    ...(r.claimed !== undefined ? { claimed: r.claimed } : {}),
    ...(r.established !== undefined ? { established: r.established } : {}),
    anchorIds: r.anchorIds,
  }));
  const requiredEvidence = open.map((r) => ({
    dimension: r.dimension,
    request: r.request ?? genericRequest({ dimension: r.dimension, relation: r.relation, ...(r.claimed ? { claimed: r.claimed } : {}), ...(r.established ? { established: r.established } : {}) }),
  }));

  const contraryDispositions: ContraryDisposition[] = [
    ...new Map(contrary.filter((c) => c.disposition).map((c) => [c.itemId, c.disposition!])).values(),
  ].sort((a, b) => cmp(a.evidenceId, b.evidenceId));
  const contraryIds = new Set(contrary.map((c) => c.itemId));
  const unusedDispositions = [...prep.options.dispositions.keys()].filter((k) => !contraryIds.has(k)).sort(cmp);

  const usedItems = pools.usable.filter((i) => i.assertionType !== "vendor" || pools.deps.required.has("vendor"));
  const dependsOnFacts = factIdsOf(
    prep,
    usedItems.map((i) => i.id),
  );

  const raw = {
    id,
    claimId: prep.claim.id,
    label: decision.label,
    ...(decision.supportedScope ? { supportedScope: decision.supportedScope as Record<string, unknown> } : {}),
    mechanicalCoverage,
    expertReviewFlags: decision.flags,
    mismatches,
    requiredEvidence,
    contraryDispositions,
    dependsOnFacts,
    degraded: decision.degraded,
    ruleVersion: prep.options.ruleVersion,
    ...(prep.options.traceId ? { traceId: prep.options.traceId } : {}),
    ...(prep.options.computedAt ? { computedAt: prep.options.computedAt } : {}),
  };
  const finding = FindingSchema.parse(raw);

  const reasons: DimensionReason[] = DIMENSIONS.map((d) => ({
    findingId: id,
    dimension: d,
    relation: dims[d].relation,
    ruleIds: sortedUnique(dims[d].ruleIds),
    text: dims[d].reason,
  }));
  const trace: TraceStep[] = DIMENSIONS.flatMap((d) =>
    sortedUnique(dims[d].ruleIds).map((ruleId) => ({ ruleId, dimension: d, effect: `${d} is ${dims[d].relation}` })),
  );
  for (const e of DIMENSIONS.flatMap((d) => dims[d].explicit.map((x) => ({ d, x })))) {
    trace.push({ ruleId: e.x.ruleId, dimension: e.d, effect: `explicit authorization limit: ${e.x.text}` });
  }
  for (const f of decision.flags) trace.push({ ruleId: f.ruleId, ...(f.dimension ? { dimension: f.dimension } : {}), effect: f.reason });
  for (const d of decision.degraded) trace.push({ ruleId: "SAK-SOURCE-LOSS", effect: `${d.sourceType} (${d.dependency}): ${d.reason}` });
  // Authority by assertion type: say what was deliberately not used, so a reader can see that nothing was silently promoted.
  for (const i of pools.vendor) {
    if (!pools.deps.required.has("vendor")) trace.push({ ruleId: "SAK-AUTHORITY", effect: `vendor record ${i.id} is a claim to be checked; it supports, widens and contradicts nothing` });
  }
  for (const i of pools.usable.filter((x) => x.assertionType === "authorization" && x.results.length > 0)) {
    trace.push({ ruleId: "SAK-AUTHORITY", effect: `results stated on authorization record ${i.id} are not a measured result; only study records supply results` });
  }
  for (const i of pools.requirement.filter((x) => Object.keys(x.scope).length > 0)) {
    trace.push({ ruleId: "SAK-AUTHORITY", effect: `the scope on hospital requirement ${i.id} states what the hospital requires, not what the evidence establishes; it is not read as evidence` });
  }

  return { finding, reasons, trace, labelBasis: decision.basis, summary: summarise(finding), unusedDispositions };
}

export function compile(claim: unknown, evidence: unknown, options?: CompileOptions): Finding {
  return compileDetailed(claim, evidence, options).finding;
}
