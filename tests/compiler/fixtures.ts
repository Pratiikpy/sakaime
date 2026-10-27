import type { Claim, EvidenceItem, EvidenceResult, Scope } from "../../src/schemas/index.ts";
import type { CompileOptions } from "../../src/compiler/index.ts";

/*
 * Test builders for the Applicability Compiler.
 *
 * Facts taken from the feasibility report (docs/reports/feasibility-report.md) are real: EyeArt K200667,
 * software version 2.1.0, NCT03112005, 942 consented participants, 11 US sites, primary and eye-care settings.
 * Everything else here is CONSTRUCTED for the test: the performance values, the dates, the age range, the condition
 * wording and the mapping of the product into the purpose taxonomy. None of it is a statement about a real vendor.
 */

export const OP = "protocol threshold";
export const AUTH_FROM = "2020-06-01";
export const STUDY_DATE = "2021-11-01";
export const CLAIM_START = "2026-11-01";

export type ClaimInput = Parameters<typeof import("../../src/schemas/index.ts").ClaimSchema.parse>[0];

/** The scope that both the authorization and the study establish, and that the positive-control claim asks for. */
export const E_SCOPE = {
  product: "device:fda:K200667",
  versions: ["2.1.0"],
  population: { age: { min: 18 }, conditions: ["diabetes mellitus"], exclusions: ["pregnancy"] },
  settings: ["primary_care", "eye_care"],
  purpose: "detection_aid",
} satisfies Scope;

export const PERF = { metric: "sensitivity", atLeast: 0.9 };
export const GOOD_RESULT: EvidenceResult = { metric: "sensitivity", value: 0.96, ci: [0.92, 0.98], n: 942, operatingPoint: OP, anchorId: "anc-study-sens" };

/** Apply a patch to an object; a key set to undefined is removed. */
export function mutate<T extends object>(base: T, patch: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out as T;
}

export function claim(use: Record<string, unknown> = {}, perf: { metric: string; atLeast: number } | null = PERF, extra: Record<string, unknown> = {}): ClaimInput {
  const merged = mutate({ ...E_SCOPE, timing: { from: CLAIM_START }, operatingPoint: OP } as Scope, use);
  return { id: "claim-1", use: merged, ...(perf ? { performance: perf } : {}), ...extra };
}

export function auth(scope: Record<string, unknown> = {}, over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "auth-1",
    assertionType: "authorization",
    scope: mutate({ ...E_SCOPE, timing: { from: AUTH_FROM } } as Scope, scope),
    results: [],
    limitations: [],
    anchorIds: ["anc-auth-ifu"],
    ...over,
  };
}

export function study(scope: Record<string, unknown> = {}, results: EvidenceResult[] = [GOOD_RESULT], over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    id: "study-1",
    assertionType: "study",
    scope: mutate({ ...E_SCOPE, timing: { from: STUDY_DATE } } as Scope, scope),
    results,
    adequate: true,
    limitations: [],
    anchorIds: ["anc-study-design"],
    ...over,
  };
}

export const vendor = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  id: "vendor-1",
  assertionType: "vendor",
  scope: { ...E_SCOPE, timing: { from: "2026-10-01" } },
  results: [{ metric: "sensitivity", value: 0.99, ci: [0.98, 1], n: 100, operatingPoint: OP }],
  limitations: [],
  anchorIds: ["anc-vendor"],
  ...over,
});

export const requirement = (satisfied: boolean | undefined, id = "req-1"): EvidenceItem => ({
  id,
  assertionType: "requirement",
  scope: {},
  results: [],
  ...(satisfied !== undefined ? { satisfied } : {}),
  limitations: [],
  anchorIds: [],
});

/** The clean case: authorization and study both establish E_SCOPE, the claim asks for exactly that. */
export function clean(): { claim: ClaimInput; evidence: EvidenceItem[]; options: CompileOptions } {
  return { claim: claim(), evidence: [auth(), study()], options: {} };
}

export const DEPS_AS_STUDY_REQUIRED = { required: ["authorization", "study"] as const, corroborating: [] };
