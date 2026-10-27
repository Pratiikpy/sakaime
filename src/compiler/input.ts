import { z } from "zod";
import {
  AssertionTypeSchema,
  ClaimSchema,
  ContraryDispositionSchema,
  DimensionSchema,
  EvidenceItemSchema,
  IsoDateTime,
  SourceHealthSchema,
  type AssertionType,
  type Claim,
  type ContraryDisposition,
  type Dimension,
  type EvidenceItem,
  type SourceHealth,
} from "../schemas/index.ts";
import { normCondition } from "./conditions.ts";
import { COMPILER_VERSION } from "./rules.ts";
import { DEFAULT_PURPOSE_TAXONOMY, DEFAULT_SETTING_TAXONOMY, Hierarchy, TaxonomySchema, normMetric } from "./taxonomy.ts";
import { cmp, isCalendarDate, normKey, normText, normVersion, sortedUnique } from "./util.ts";

/** Raised for input the schemas or the compiler's own consistency checks reject. Never for a merely weak claim. */
export class CompilerInputError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`compiler input rejected: ${issues.join("; ")}`);
    this.name = "CompilerInputError";
    this.issues = issues;
  }
}

/** Raised when the code is asked to replay a finding under a rule version it does not implement. */
export class RuleVersionMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`finding was computed under ${expected}; this build implements ${actual}`);
    this.name = "RuleVersionMismatchError";
  }
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** Health of the source behind an evidence type. The long form carries what an EMPTY statement needs ("none found in X on D"). */
export const SourceStatusSchema = z.union([
  SourceHealthSchema,
  z
    .object({
      health: SourceHealthSchema,
      sourceId: z.string().min(1).optional(),
      checkedOn: IsoDate.optional(),
      note: z.string().min(1).optional(),
    })
    .strict(),
]);
export type SourceStatus = z.infer<typeof SourceStatusSchema>;

export const PolicySchema = z
  .object({
    /** Evidence older than this many days at the end of the claimed period raises R20. No default: no standard sets one. */
    stalenessWindowDays: z.number().int().positive().optional(),
    /** A supporting result with fewer participants raises R13. */
    minResultN: z.number().int().positive().optional(),
    /** A supporting interval wider than this raises R13. */
    maxCiWidth: z.number().positive().optional(),
  })
  .strict();
export type Policy = z.infer<typeof PolicySchema>;

export const CompileOptionsSchema = z
  .object({
    /** Health of the source behind each evidence type, from the Source Console. Absent means not reported. */
    sourceHealth: z.partialRecord(AssertionTypeSchema, SourceStatusSchema).optional(),
    /** Dimensions the claim needs. Default: all but metric, plus metric when the claim states a performance. */
    requiredDimensions: z.array(DimensionSchema).optional(),
    /** Reviewer dispositions of contrary material, keyed by evidence item id. */
    dispositions: z.array(ContraryDispositionSchema).default([]),
    /** Fact ids behind each evidence item, for change impact. Default: the item id itself is the fact id. */
    factIds: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
    policy: PolicySchema.optional(),
    taxonomies: z.object({ settings: TaxonomySchema.optional(), purposes: TaxonomySchema.optional() }).strict().optional(),
    /** Replay guard: refuse to run when this build does not implement the stated rule version. */
    expectedRuleVersion: z.string().min(1).optional(),
    traceId: z.string().min(1).optional(),
    /** Stamped on the finding as given. The compiler never reads the clock. */
    computedAt: IsoDateTime.optional(),
  })
  .strict();
export type CompileOptions = z.input<typeof CompileOptionsSchema>;

export interface ResolvedStatus {
  health: SourceHealth;
  sourceId?: string;
  checkedOn?: string;
  note?: string;
}

export interface ResolvedOptions {
  sourceHealth: Partial<Record<AssertionType, ResolvedStatus>>;
  requiredDimensions: ReadonlySet<Dimension>;
  dispositions: ReadonlyMap<string, ContraryDisposition>;
  factIds: ReadonlyMap<string, readonly string[]>;
  policy: Policy;
  settings: Hierarchy;
  purposes: Hierarchy;
  traceId?: string;
  computedAt?: string;
  ruleVersion: string;
  /** The options as they affect the result, in a stable form, for hashing. */
  fingerprint: unknown;
}

export interface Prepared {
  claim: Claim;
  evidence: EvidenceItem[];
  options: ResolvedOptions;
}

const DEFAULT_DIMENSIONS: readonly Dimension[] = ["product", "version", "population", "setting", "purpose", "timing"];

export function ruleVersionFor(settings: Hierarchy, purposes: Hierarchy): string {
  const t = (h: Hierarchy) => `${h.taxonomy.id}@${h.taxonomy.version}`;
  return `${COMPILER_VERSION}+${t(settings)}+${t(purposes)}+metrics@1`;
}

function formatIssues(err: z.ZodError, prefix: string): string[] {
  return err.issues.map((i) => `${prefix}${i.path.map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`)).join("")}: ${i.message}`);
}

function checkFinite(value: unknown, path: string, issues: string[]): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) issues.push(`${path}: number is not finite`);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => checkFinite(v, `${path}[${i}]`, issues));
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) checkFinite(v, `${path}.${k}`, issues);
  }
}

function checkTiming(t: { from?: string; to?: string } | undefined, path: string, issues: string[]): void {
  if (!t) return;
  for (const k of ["from", "to"] as const) {
    const v = t[k];
    if (v !== undefined && !isCalendarDate(v)) issues.push(`${path}.${k}: "${v}" is not a calendar date`);
  }
  if (t.from !== undefined && t.to !== undefined && isCalendarDate(t.from) && isCalendarDate(t.to) && t.from > t.to) {
    issues.push(`${path}: from is after to`);
  }
}

function canonScope<S extends EvidenceItem["scope"]>(s: S): S {
  const out: Record<string, unknown> = { ...s };
  if (s.product !== undefined) out["product"] = s.product.trim();
  if (s.versions) out["versions"] = sortedUnique(s.versions.map(normVersion));
  if (s.settings) out["settings"] = sortedUnique(s.settings.map(normKey));
  if (s.purpose !== undefined) out["purpose"] = normKey(s.purpose);
  if (s.operatingPoint !== undefined) out["operatingPoint"] = normText(s.operatingPoint);
  if (s.population) {
    const p: Record<string, unknown> = { ...s.population };
    if (s.population.conditions) p["conditions"] = sortedUnique(s.population.conditions.map(normCondition));
    if (s.population.exclusions) p["exclusions"] = sortedUnique(s.population.exclusions.map(normCondition));
    out["population"] = p;
  }
  return out as S;
}

export function canonClaim(c: Claim): Claim {
  const { text: _text, ...rest } = c;
  const out: Claim = { ...rest, use: canonScope(c.use) };
  if (c.performance) out.performance = { metric: normMetric(c.performance.metric), atLeast: c.performance.atLeast };
  if (c.dependencies) {
    out.dependencies = {
      required: [...new Set(c.dependencies.required)].sort(cmp) as AssertionType[],
      corroborating: [...new Set(c.dependencies.corroborating)].sort(cmp) as AssertionType[],
    };
  }
  return out;
}

export function canonItem(i: EvidenceItem): EvidenceItem {
  const results = i.results
    .map((r) => ({ ...r, metric: normMetric(r.metric), ...(r.operatingPoint !== undefined ? { operatingPoint: normText(r.operatingPoint) } : {}) }))
    .sort((a, b) => cmp(JSON.stringify(a), JSON.stringify(b)));
  return {
    ...i,
    scope: canonScope(i.scope),
    results,
    limitations: [...i.limitations].sort(cmp),
    anchorIds: sortedUnique(i.anchorIds),
  };
}

function resolveOptions(raw: unknown, claim: Claim, issues: string[]): ResolvedOptions | undefined {
  const parsed = CompileOptionsSchema.safeParse(raw ?? {});
  if (!parsed.success) {
    issues.push(...formatIssues(parsed.error, "options"));
    return undefined;
  }
  const o = parsed.data;
  const settings = new Hierarchy(o.taxonomies?.settings ?? DEFAULT_SETTING_TAXONOMY);
  const purposes = new Hierarchy(o.taxonomies?.purposes ?? DEFAULT_PURPOSE_TAXONOMY);
  const ruleVersion = ruleVersionFor(settings, purposes);
  if (o.expectedRuleVersion !== undefined && o.expectedRuleVersion !== ruleVersion) {
    throw new RuleVersionMismatchError(o.expectedRuleVersion, ruleVersion);
  }

  const sourceHealth: Partial<Record<AssertionType, ResolvedStatus>> = {};
  for (const [type, status] of Object.entries(o.sourceHealth ?? {}) as [AssertionType, SourceStatus][]) {
    sourceHealth[type] = typeof status === "string" ? { health: status } : { ...status };
    if (typeof status !== "string" && status.checkedOn !== undefined && !isCalendarDate(status.checkedOn)) {
      issues.push(`options.sourceHealth.${type}.checkedOn: "${status.checkedOn}" is not a calendar date`);
    }
  }

  const dispositions = new Map<string, ContraryDisposition>();
  for (const d of o.dispositions) {
    if (dispositions.has(d.evidenceId)) issues.push(`options.dispositions: two dispositions for "${d.evidenceId}"`);
    dispositions.set(d.evidenceId, d);
  }

  const required = new Set<Dimension>(o.requiredDimensions ?? DEFAULT_DIMENSIONS);
  if (claim.performance) required.add("metric");

  const factIds = new Map<string, readonly string[]>();
  for (const [itemId, ids] of Object.entries(o.factIds ?? {})) factIds.set(itemId, sortedUnique(ids));

  const policy = o.policy ?? {};
  const resolved: ResolvedOptions = {
    sourceHealth,
    requiredDimensions: required,
    dispositions,
    factIds,
    policy,
    settings,
    purposes,
    ruleVersion,
    fingerprint: {
      sourceHealth,
      required: [...required].sort(cmp),
      dispositions: [...dispositions.values()].sort((a, b) => cmp(a.evidenceId, b.evidenceId)),
      factIds: [...factIds.entries()].sort((a, b) => cmp(a[0], b[0])),
      policy,
      taxonomies: { settings: settings.taxonomy, purposes: purposes.taxonomy },
    },
  };
  if (o.traceId !== undefined) resolved.traceId = o.traceId;
  if (o.computedAt !== undefined) resolved.computedAt = o.computedAt;
  return resolved;
}

/**
 * Validate and canonicalise everything the compiler reads. After this point terms are normalised, sets are sorted
 * and evidence is ordered by id, so the result cannot depend on how the caller happened to order or spell things.
 */
export function prepare(claimIn: unknown, evidenceIn: unknown, optionsIn: unknown): Prepared {
  const issues: string[] = [];

  const claimParsed = ClaimSchema.safeParse(claimIn);
  if (!claimParsed.success) issues.push(...formatIssues(claimParsed.error, "claim"));

  const evidenceParsed = z.array(EvidenceItemSchema).safeParse(evidenceIn);
  if (!evidenceParsed.success) issues.push(...formatIssues(evidenceParsed.error, "evidence"));

  if (!claimParsed.success || !evidenceParsed.success) throw new CompilerInputError(issues);
  const claim = claimParsed.data;
  const evidence = evidenceParsed.data;

  checkFinite(claim, "claim", issues);
  checkFinite(evidence, "evidence", issues);
  checkTiming(claim.use.timing, "claim.use.timing", issues);

  const seen = new Set<string>();
  evidence.forEach((item, idx) => {
    const p = `evidence[${idx}]`;
    if (seen.has(item.id)) issues.push(`${p}.id: duplicate evidence id "${item.id}"`);
    seen.add(item.id);
    checkTiming(item.scope.timing, `${p}.scope.timing`, issues);
    item.results.forEach((r, ri) => {
      if (r.ci) {
        const [lo, hi] = r.ci;
        if (lo > hi) issues.push(`${p}.results[${ri}].ci: lower bound exceeds upper bound`);
        else if (r.value < lo || r.value > hi) issues.push(`${p}.results[${ri}]: value lies outside its own interval`);
      }
    });
  });

  const options = resolveOptions(optionsIn, claim, issues);
  if (issues.length > 0 || !options) throw new CompilerInputError(issues);

  const canonEvidence = evidence.map(canonItem).sort((a, b) => cmp(a.id, b.id));
  return { claim: canonClaim(claim), evidence: canonEvidence, options };
}
