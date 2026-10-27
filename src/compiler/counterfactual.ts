import { z } from "zod";
import { ClaimSchema, ClaimedPerformanceSchema, ScopeSchema, SourceDependenciesSchema } from "../schemas/index.ts";
import type { Claim, Dimension, Finding, Label, Relation, Scope } from "../schemas/index.ts";
import { compileDetailed, type CompileDetail } from "./compile.ts";
import { CompilerInputError, type CompileOptions } from "./input.ts";
import { cmp } from "./util.ts";

const ScopePatchSchema = z
  .object(Object.fromEntries(Object.entries(ScopeSchema.shape).map(([k, v]) => [k, v.nullable().optional()])) as { [K in keyof Scope]: z.ZodOptional<z.ZodNullable<z.ZodTypeAny>> })
  .strict();

export const ClaimPatchSchema = z
  .object({
    /** Dimension values to replace. A dimension is replaced whole, not merged. `null` clears it to unspecified. */
    use: ScopePatchSchema.optional(),
    performance: ClaimedPerformanceSchema.nullable().optional(),
    dependencies: SourceDependenciesSchema.nullable().optional(),
  })
  .strict();
export type ClaimPatch = z.input<typeof ClaimPatchSchema>;

export function applyPatch(claim: Claim, patch: ClaimPatch): Claim {
  const parsed = ClaimPatchSchema.safeParse(patch);
  if (!parsed.success) {
    throw new CompilerInputError(parsed.error.issues.map((i) => `patch${i.path.length ? "." + i.path.join(".") : ""}: ${i.message}`));
  }
  const p = parsed.data;
  const use: Record<string, unknown> = { ...claim.use };
  for (const [k, v] of Object.entries(p.use ?? {})) {
    if (v === undefined) continue;
    if (v === null) delete use[k];
    else use[k] = v;
  }
  const next: Record<string, unknown> = { ...claim, use };
  if (p.performance === null) delete next["performance"];
  else if (p.performance !== undefined) next["performance"] = p.performance;
  if (p.dependencies === null) delete next["dependencies"];
  else if (p.dependencies !== undefined) next["dependencies"] = p.dependencies;
  const checked = ClaimSchema.safeParse(next);
  if (!checked.success) {
    throw new CompilerInputError(checked.error.issues.map((i) => `patched claim.${i.path.join(".")}: ${i.message}`));
  }
  return checked.data;
}

export interface FindingDiff {
  /** True when nothing a reader could see differs. */
  unchanged: boolean;
  label: { from: Label; to: Label; changed: boolean };
  /** Dimensions whose relation or claimed value changed. */
  dimensions: { dimension: Dimension; from: Relation; to: Relation; claimedFrom?: string; claimedTo?: string }[];
  mismatchesAdded: Dimension[];
  mismatchesRemoved: Dimension[];
  flagsAdded: string[];
  flagsRemoved: string[];
  requiredEvidenceAdded: Dimension[];
  requiredEvidenceRemoved: Dimension[];
  supportedScopeChanged: boolean;
  degradedChanged: boolean;
}

const flagKey = (f: { ruleId: string; dimension?: string; reason: string }): string => `${f.ruleId}${f.dimension ? `@${f.dimension}` : ""}: ${f.reason}`;

function delta<T>(before: readonly T[], after: readonly T[], key: (x: T) => string): { added: T[]; removed: T[] } {
  const b = new Set(before.map(key));
  const a = new Set(after.map(key));
  return { added: after.filter((x) => !b.has(key(x))), removed: before.filter((x) => !a.has(key(x))) };
}

/** A structural diff of two findings for the same claim. Pure; the findings are only read. */
export function diffFindings(before: Finding, after: Finding): FindingDiff {
  const dimensions: FindingDiff["dimensions"] = [];
  for (const a of after.mechanicalCoverage) {
    const b = before.mechanicalCoverage.find((x) => x.dimension === a.dimension);
    if (!b) continue;
    if (b.relation !== a.relation || b.claimed !== a.claimed || b.established !== a.established) {
      dimensions.push({
        dimension: a.dimension,
        from: b.relation,
        to: a.relation,
        ...(b.claimed !== undefined ? { claimedFrom: b.claimed } : {}),
        ...(a.claimed !== undefined ? { claimedTo: a.claimed } : {}),
      });
    }
  }
  const m = delta(before.mismatches, after.mismatches, (x) => `${x.dimension}:${x.relation}`);
  const f = delta(before.expertReviewFlags, after.expertReviewFlags, flagKey);
  const r = delta(before.requiredEvidence, after.requiredEvidence, (x) => `${x.dimension}:${x.request}`);
  const scopeChanged = JSON.stringify(before.supportedScope ?? null) !== JSON.stringify(after.supportedScope ?? null);
  const degradedChanged = JSON.stringify(before.degraded) !== JSON.stringify(after.degraded);
  const labelChanged = before.label !== after.label;
  const diff: FindingDiff = {
    unchanged: false,
    label: { from: before.label, to: after.label, changed: labelChanged },
    dimensions,
    mismatchesAdded: m.added.map((x) => x.dimension).sort(cmp),
    mismatchesRemoved: m.removed.map((x) => x.dimension).sort(cmp),
    flagsAdded: f.added.map(flagKey).sort(cmp),
    flagsRemoved: f.removed.map(flagKey).sort(cmp),
    requiredEvidenceAdded: r.added.map((x) => x.dimension).sort(cmp),
    requiredEvidenceRemoved: r.removed.map((x) => x.dimension).sort(cmp),
    supportedScopeChanged: scopeChanged,
    degradedChanged,
  };
  diff.unchanged =
    !labelChanged &&
    dimensions.length === 0 &&
    diff.mismatchesAdded.length === 0 &&
    diff.mismatchesRemoved.length === 0 &&
    diff.flagsAdded.length === 0 &&
    diff.flagsRemoved.length === 0 &&
    diff.requiredEvidenceAdded.length === 0 &&
    diff.requiredEvidenceRemoved.length === 0 &&
    !scopeChanged &&
    !degradedChanged;
  return diff;
}

export interface Counterfactual {
  patchedClaim: Claim;
  /** The finding for the claim as it stood. */
  previous: Finding;
  /** The finding for the patched claim, with its reasons and trace. */
  next: CompileDetail;
  diff: FindingDiff;
}

/**
 * The Applicability Lab. Change one or more claim dimensions and recompute against the same evidence and options.
 * No model is called: this is `compile` twice and a diff. Neither finding is stored or marked as superseding the
 * other; use `supersede` when the reviewer commits the changed use.
 */
export function recompute(claim: unknown, patch: ClaimPatch, evidence: unknown, options?: CompileOptions): Counterfactual {
  const original = compileDetailed(claim, evidence, options);
  const base = ClaimSchema.parse(claim);
  const patchedClaim = applyPatch(base, patch);
  const next = compileDetailed(patchedClaim, evidence, options);
  return { patchedClaim, previous: original.finding, next, diff: diffFindings(original.finding, next.finding) };
}
