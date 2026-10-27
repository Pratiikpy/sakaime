/**
 * ScopeShift (A): controlled single-dimension counterfactuals (docs/06 section 3).
 *
 * For each authentic scope E (the evidence items the extraction layer reads from the real FDA summary of a device) a claim identical to
 * E is built as the positive control, then exactly one dimension is mutated. The expected label follows from the construction
 * and is written down below before the compiler is called; it does not come from the compiler's code.
 *
 * What this measures: consistency between a rule table (the label table of docs/02 section 10) and the compiler's implementation.
 * It does NOT measure clinical correctness, and a rule table and a test derived from it agree by construction. Every number from
 * this file is tagged `consistency`.
 *
 * Two worlds per device:
 *   W1  the authorization item alone; the claim states the dimensions the authorization states (no performance figure).
 *   W2  authorization and study; the claim states only what the study states plus a performance threshold taken from its own results.
 *       The study is marked adequate: that is a stated assumption of the construction, extraction never sets it.
 *
 * Where the meaning of "wider" is contestable (a term the taxonomy cannot place, a date past a window nobody sets) the expected label
 * is REQUIRES_DOMAIN_REVIEW and the case is scored on abstention.
 *
 *   npx tsx evals/suites/scopeshift-a.ts
 */
import { compileDetailed, DEFAULT_PURPOSE_TAXONOMY, DEFAULT_SETTING_TAXONOMY, Hierarchy, type CompileOptions } from "../../src/compiler/index.ts";
import { ClaimSchema, type Dimension, type EvidenceItem, type Label } from "../../src/schemas/index.ts";
import { clusterBootstrap, effectiveSampleSize, wilson, zeroErrorUpperBound } from "../stats/index.ts";
import { authenticItems } from "../lib/scopes.ts";
import { hashOfJson, round, stamp } from "../lib/core.ts";
import { rateRow, writeResult } from "../lib/results.ts";

const SEED = 20261027;
const WINDOW_DAYS = 1095;
const settingsH = new Hierarchy(DEFAULT_SETTING_TAXONOMY);
const purposesH = new Hierarchy(DEFAULT_PURPOSE_TAXONOMY);

const PRODUCTS: { id: string; part: "development" | "held-out"; family: string }[] = [
  ...["K200667", "K223357"].map((k) => ({ id: k, part: "development" as const, family: "eyeart" })),
  ...["K221347", "K211733", "DEN170073", "K253265", "K240301", "DEN200080", "DEN200055", "K213857", "K232699", "DEN180001", "DEN190040"].map((k) => ({ id: k, part: "development" as const, family: k })),
  ...["K253801", "K252360", "K253825", "K250680", "K253163"].map((k) => ({ id: k, part: "held-out" as const, family: k })),
];

interface Case {
  id: string;
  cluster: string;
  product: string;
  world: "W1" | "W2";
  mutation: string;
  dimension: string;
  expected: Label;
  contestable: boolean;
  claim: Record<string, unknown>;
  items: EvidenceItem[];
  options: CompileOptions;
}

const addDays = (iso: string, days: number): string => new Date(Date.parse(iso + "T00:00:00Z") + days * 86400000).toISOString().slice(0, 10);

const itemsFor = authenticItems;

const REQUIRED_DEFAULT: Dimension[] = ["product"];

function w1Cases(p: (typeof PRODUCTS)[number], auth: EvidenceItem): Case[] {
  const cases: Case[] = [];
  const product = `device:fda:${p.id}`;
  const s = auth.scope;
  const base: Record<string, unknown> = { product };
  const required: Dimension[] = [...REQUIRED_DEFAULT];
  if (s.versions?.length) {
    base["versions"] = s.versions;
    required.push("version");
  }
  const authAge = s.population?.age;
  if (authAge && (authAge.min !== undefined || authAge.max !== undefined)) {
    base["population"] = { age: authAge };
    required.push("population");
  }
  if (s.settings?.length) {
    base["settings"] = s.settings;
    required.push("setting");
  }
  if (s.purpose) {
    base["purpose"] = s.purpose;
    required.push("purpose");
  }
  const decision = s.timing?.from;
  if (decision) {
    base["timing"] = { from: addDays(decision, 30) };
    required.push("timing");
  }
  const options: CompileOptions = { requiredDimensions: required, policy: { stalenessWindowDays: WINDOW_DAYS }, traceId: p.id, computedAt: "2026-10-27T00:00:00.000Z" };
  const mk = (mutation: string, dimension: string, expected: Label, claim: Record<string, unknown>, extra: Partial<Case> = {}): void => {
    cases.push({ id: `A-${p.id}-W1-${mutation}`, cluster: p.family, product, world: "W1", mutation, dimension, expected, contestable: false, claim, items: [auth], options, ...extra });
  };
  mk("positive-control", "none", "SUPPORTED_FOR_SCOPE", base);
  if (s.versions?.length) {
    mk("version-bump", "version", "INSUFFICIENT_EVIDENCE", { ...base, versions: ["99.9"] });
    const { versions: _v, ...noVersion } = base;
    mk("version-unconfirmed", "version", "INSUFFICIENT_EVIDENCE", noVersion);
  }
  if (authAge?.min !== undefined && authAge.min > 5) {
    mk("age-min-lowered", "population", "CONTRADICTED_BY_SPECIFIED_EVIDENCE", { ...base, population: { age: { ...authAge, min: authAge.min - 5 } } });
  }
  if (s.settings?.length) {
    const covered = s.settings.filter((x) => settingsH.has(x));
    const parents = covered.map((x) => settingsH.ancestorsOrSelf(x)[1]).filter((x): x is string => !!x && covered.every((c) => !settingsH.covers(c, x)));
    if (parents[0]) mk("setting-widened", "setting", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", { ...base, settings: [parents[0]] });
    const stranger = Object.keys(settingsH.taxonomy.nodes).find((k) => covered.every((c) => !settingsH.covers(c, k) && !settingsH.covers(k, c)));
    if (stranger) mk("setting-unrelated", "setting", "INSUFFICIENT_EVIDENCE", { ...base, settings: [stranger] });
    mk("setting-unplaced", "setting", "REQUIRES_DOMAIN_REVIEW", { ...base, settings: ["a setting the taxonomy has never heard of"] }, { contestable: true });
  }
  if (s.purpose) {
    const up = purposesH.has(s.purpose) ? purposesH.ancestorsOrSelf(s.purpose)[1] : undefined;
    if (up) mk("purpose-escalated", "purpose", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", { ...base, purpose: up });
    const stranger = Object.keys(purposesH.taxonomy.nodes).find((k) => !purposesH.covers(s.purpose as string, k) && !purposesH.covers(k, s.purpose as string));
    if (stranger) mk("purpose-sideways", "purpose", "INSUFFICIENT_EVIDENCE", { ...base, purpose: stranger });
    mk("purpose-unplaced", "purpose", "REQUIRES_DOMAIN_REVIEW", { ...base, purpose: "autonomous treatment selection" }, { contestable: true });
  }
  if (decision) {
    mk("date-before-authorization", "timing", "CONTRADICTED_BY_SPECIFIED_EVIDENCE", { ...base, timing: { from: addDays(decision, -400) } });
    mk("date-past-window", "timing", "REQUIRES_DOMAIN_REVIEW", { ...base, timing: { from: addDays(decision, WINDOW_DAYS + 30) } }, { contestable: true });
  }
  mk("product-replaced", "product", "INSUFFICIENT_EVIDENCE", { ...base, product: "device:fda:K000000" });
  mk("product-brand-only", "product", "INSUFFICIENT_EVIDENCE", { ...base, product: "a brand name shared by several cleared devices" });
  const healthCases: [string, CompileOptions["sourceHealth"]][] = [
    ["authorization-source-unavailable", { authorization: "UNAVAILABLE" }],
    ["authorization-source-empty", { authorization: { health: "EMPTY", sourceId: "fda-510k", checkedOn: "2026-10-27" } }],
  ];
  for (const [mutation, sourceHealth] of healthCases) mk(mutation, "source", "INSUFFICIENT_EVIDENCE", base, { options: { ...options, sourceHealth } });
  return cases;
}

function w2Cases(p: (typeof PRODUCTS)[number], auth: EvidenceItem, study: EvidenceItem): Case[] {
  const cases: Case[] = [];
  const product = `device:fda:${p.id}`;
  const headline = study.results.find((r) => r.ci && ["sensitivity", "auc", "ppa", "specificity"].includes(r.metric));
  if (!headline || !headline.ci) return cases;
  const [lo, hi] = headline.ci;
  const adequateStudy: EvidenceItem = { ...study, adequate: true };
  const claimBase: Record<string, unknown> = { product };
  const required: Dimension[] = ["product", "metric"];
  const studyAge = study.scope.population?.age;
  if (study.scope.versions?.length && auth.scope.versions?.length) {
    claimBase["versions"] = study.scope.versions.filter((v) => auth.scope.versions?.includes(v));
    required.push("version");
  }
  if (studyAge?.min !== undefined) {
    claimBase["population"] = { age: studyAge };
    required.push("population");
  }
  const hasVersions = Array.isArray(claimBase["versions"]) && (claimBase["versions"] as string[]).length > 0;
  if (!hasVersions) {
    delete claimBase["versions"];
    const i = required.indexOf("version");
    if (i >= 0) required.splice(i, 1);
  }
  const options: CompileOptions = { requiredDimensions: required, policy: { stalenessWindowDays: WINDOW_DAYS }, traceId: p.id, computedAt: "2026-10-27T00:00:00.000Z" };
  const items = [auth, adequateStudy];
  const perf = (atLeast: number) => ({ metric: headline.metric, atLeast: round(atLeast, 3) });
  const mk = (mutation: string, dimension: string, expected: Label, claim: Record<string, unknown>, extra: Partial<Case> = {}): void => {
    cases.push({ id: `A-${p.id}-W2-${mutation}`, cluster: p.family, product, world: "W2", mutation, dimension, expected, contestable: false, claim, items, options, ...extra });
  };
  mk("positive-control", "none", "SUPPORTED_FOR_SCOPE", { ...claimBase, performance: perf(Math.max(0, lo - 0.02)) });
  mk("threshold-above-interval", "metric", "CONTRADICTED_BY_SPECIFIED_EVIDENCE", { ...claimBase, performance: perf(Math.min(0.999, hi + 0.02)) });
  mk("study-source-unavailable", "source", "INSUFFICIENT_EVIDENCE", { ...claimBase, performance: perf(Math.max(0, lo - 0.02)) }, { options: { ...options, sourceHealth: { study: "UNAVAILABLE" } } });
  if (studyAge?.min !== undefined && studyAge.min > 5) {
    const authStates = auth.scope.population?.age?.min !== undefined;
    mk("age-min-lowered", "population", authStates ? "CONTRADICTED_BY_SPECIFIED_EVIDENCE" : "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", { ...claimBase, population: { age: { ...studyAge, min: studyAge.min - 5 } }, performance: perf(Math.max(0, lo - 0.02)) });
  }
  if (hasVersions) mk("version-bump", "version", "INSUFFICIENT_EVIDENCE", { ...claimBase, versions: ["99.9"], performance: perf(Math.max(0, lo - 0.02)) });
  const decision = auth.scope.timing?.from;
  if (decision) {
    // The compiler ages study evidence, not the authorization, so the staleness case needs a dated study. The date is constructed: the clearance date.
    const dated: EvidenceItem = { ...adequateStudy, scope: { ...adequateStudy.scope, timing: { from: decision } } };
    mk(
      "date-past-window-dated-study",
      "timing",
      "REQUIRES_DOMAIN_REVIEW",
      { ...claimBase, timing: { from: addDays(decision, WINDOW_DAYS + 30) }, performance: perf(Math.max(0, lo - 0.02)) },
      { contestable: true, items: [auth, dated], options: { ...options, requiredDimensions: [...required, "timing"] } },
    );
  }
  return cases;
}

async function main(): Promise<void> {
  const started = stamp("scopeshift-a", SEED);
  const cases: Case[] = [];
  const skipped: { product: string; world: string; reason: string }[] = [];
  for (const p of PRODUCTS) {
    const { auth, study } = await itemsFor(p.id, p.part);
    if (!auth) {
      skipped.push({ product: p.id, world: "W1", reason: "no authorization item could be extracted" });
      continue;
    }
    cases.push(...w1Cases(p, auth));
    if (study) {
      const w2 = w2Cases(p, auth, study);
      if (w2.length === 0) skipped.push({ product: p.id, world: "W2", reason: "the study item has no result with a confidence interval, so no threshold case can be built" });
      cases.push(...w2);
    } else skipped.push({ product: p.id, world: "W2", reason: "no study item" });
  }

  const rows = cases.map((c) => {
    let emitted: Label | null = null;
    let error: string | undefined;
    let basis: string[] = [];
    try {
      const d = compileDetailed(ClaimSchema.parse({ id: c.id, use: Object.fromEntries(Object.entries(c.claim).filter(([k]) => k !== "performance")), ...(c.claim["performance"] ? { performance: c.claim["performance"] } : {}) }), c.items, c.options);
      emitted = d.finding.label;
      basis = d.labelBasis;
    } catch (err) {
      error = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    }
    return { id: c.id, cluster: c.cluster, product: c.product, world: c.world, mutation: c.mutation, dimension: c.dimension, expected: c.expected, contestable: c.contestable, emitted, error: error ?? null, match: emitted === c.expected, basis: basis.slice(0, 3) };
  });

  const clusters = effectiveSampleSize(rows);
  const stat = (pick: (r: (typeof rows)[number]) => boolean, denom: (r: (typeof rows)[number]) => boolean, seed: number) => {
    const d = rows.filter(denom);
    const k = d.filter(pick).length;
    const w = wilson(k, d.length);
    const out = rateRow({ ...w, ...(k === 0 && d.length ? { zeroUpper: zeroErrorUpperBound(d.length) } : {}) } as never);
    const boot = d.length ? clusterBootstrap(d, (s) => (s.length ? s.filter(pick).length / s.length : NaN), { seed, resamples: 2000 }) : undefined;
    return { ...out, ...(boot ? { clusterLo: boot.lo, clusterHi: boot.hi, clusters: boot.clusters } : {}) };
  };
  const supported = (l: Label | null) => l === "SUPPORTED_FOR_SCOPE" || l === "SUPPORTED_ONLY_FOR_NARROWER_SCOPE";
  const summaries: Record<string, unknown> = {
    cases: { n: rows.length, clusters: clusters.clusters, products: new Set(rows.map((r) => r.product)).size, meanClusterSize: round(clusters.meanClusterSize, 2) },
    exactLabel: stat((r) => r.match, () => true, SEED),
    deterministicExactLabel: stat((r) => r.match, (r) => !r.contestable, SEED + 1),
    positiveControlCorrectSupported: stat((r) => r.emitted === "SUPPORTED_FOR_SCOPE", (r) => r.mutation === "positive-control", SEED + 2),
    positiveControlFalseAlarm: stat((r) => r.emitted !== "SUPPORTED_FOR_SCOPE", (r) => r.mutation === "positive-control", SEED + 3),
    falseSupported: stat((r) => (r.emitted === "SUPPORTED_FOR_SCOPE" && r.expected !== "SUPPORTED_FOR_SCOPE") || (r.emitted === "SUPPORTED_ONLY_FOR_NARROWER_SCOPE" && !supported(r.expected)), (r) => r.expected !== "SUPPORTED_FOR_SCOPE", SEED + 4),
    contestableAbstention: stat((r) => r.emitted === "REQUIRES_DOMAIN_REVIEW" || r.emitted === "INSUFFICIENT_EVIDENCE", (r) => r.contestable, SEED + 5),
    contestableReviewExact: stat((r) => r.emitted === "REQUIRES_DOMAIN_REVIEW", (r) => r.contestable, SEED + 6),
    noVerdict: { k: rows.filter((r) => r.emitted === null).length, n: rows.length },
    skipped,
  };
  const byMutation: Record<string, { n: number; match: number; mismatchIds: string[] }> = {};
  for (const r of rows) {
    const m = (byMutation[r.mutation] ??= { n: 0, match: 0, mismatchIds: [] });
    m.n++;
    if (r.match) m.match++;
    else m.mismatchIds.push(`${r.id}: expected ${r.expected}, got ${r.emitted ?? r.error}`);
  }
  summaries["byMutation"] = byMutation;

  writeResult("scopeshift-a.json", {
    meta: {
      ...started,
      class: ["consistency"],
      description: "ScopeShift (A): controlled single-dimension counterfactuals over authentic scopes read by the extraction layer from real FDA summaries. Consistency between a rule table and the compiler; not clinical correctness.",
      stalenessWindowDays: WINDOW_DAYS,
      studyAdequacy: "Study items are marked adequate by construction in world W2; extraction never sets the flag.",
      resultsHash: hashOfJson(rows).slice(0, 16),
    },
    summaries,
    rows,
  });
  const s = summaries["exactLabel"] as { k: number; n: number };
  console.log(`ScopeShift A: ${rows.length} cases, ${clusters.clusters} clusters, ${new Set(rows.map((r) => r.product)).size} products; exact ${s.k}/${s.n}`);
  for (const [m, v] of Object.entries(byMutation)) console.log(`  ${m.padEnd(36)} ${v.match}/${v.n}${v.mismatchIds.length ? "  " + v.mismatchIds.slice(0, 2).join(" | ") : ""}`);
}

await main();
