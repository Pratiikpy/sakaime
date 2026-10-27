/**
 * Per-field precision and recall of the FDA summary parser against hand-labelled gold.
 *
 * What counts as extracted: an assertion that passed BOTH checks (quote-exists and semantic support). Assertions that
 * failed or could not be decided are counted apart and never inflate a score.
 *
 * Precision is reported only where the gold list is meant to be exhaustive (versions, age limits, settings, trial
 * identifiers, performance statements). For sample sizes and site counts the gold lists the principal counts, not
 * every count in the document, so only recall is a score and the number of other counts is reported as "other".
 * Performance statements are adjudicated: every extracted figure that the gold did not list was read against its
 * passage and marked correct or incorrect, so precision is not charged for valid statements the gold left out.
 */
import { isHeadlineResult } from "./to-evidence.ts";
import type { FdaSummaryExtraction } from "./fda-summary.ts";
import type { CheckedAssertion } from "./types.ts";
import { isUsable } from "./verify.ts";

export interface GoldResult {
  metric: string;
  value: number;
  ci?: [number, number];
  kind: "observed" | "goal";
  headline: boolean;
}

export interface GoldDoc {
  versions: string[];
  ifuAgeMin: number | null;
  ifuAgeMax: number | null;
  studyAgeMin: number | null;
  studyAgeMax: number | null;
  settings: string[];
  sampleSizes: number[];
  siteCounts: number[];
  ncts: string[];
  results: GoldResult[];
  /**
   * Optional, added later. Absent in a gold file that predates them, and then the field is not scored.
   * conditions / exclusions: phrases of the Indications for Use naming the people or findings the device is for and the groups it excludes.
   * diagnosticExclusions: the strength of each sentence of the indications that excludes diagnostic use.
   * studySettings: care settings the document names as where the study took place.
   */
  conditions?: string[];
  exclusions?: string[];
  diagnosticExclusions?: ("absolute" | "qualified")[];
  studySettings?: string[];
  notes?: string;
}

export interface Gold {
  docs: Record<string, GoldDoc>;
}

/** "correct" and "incorrect" judge an extracted figure against its own passage. */
export type Adjudication = Record<string, Record<string, "correct" | "incorrect">>;

export interface Score {
  gold: number;
  extracted: number;
  tp: number;
  fp: number;
  fn: number;
  precision: number | null;
  recall: number | null;
}

export interface FieldReport extends Score {
  field: string;
  /** For count fields: extracted values not in the gold list (not scored as errors). */
  other?: number;
  /** For results: extras that were adjudicated correct / incorrect / not yet adjudicated. */
  adjudicated?: { correct: number; incorrect: number; unadjudicated: number };
  /** Share of matched figures whose interval equals the gold interval. */
  intervalAgreement?: { matched: number; agree: number };
  note?: string;
}

export interface MeasureReport {
  perField: FieldReport[];
  headline: Score;
  checks: {
    proposed: number;
    quote: { passed: number; failed: number };
    support: { pass: number; fail: number; unchecked: number };
    discardedUnquoted: number;
  };
  perDoc: Record<string, { proposed: number; usable: number; fields: Record<string, { status: string }> }>;
}

function score(gold: number, extracted: number, tp: number, fp: number): Score {
  const fn = gold - tp;
  return {
    gold,
    extracted,
    tp,
    fp,
    fn,
    precision: extracted === 0 ? null : tp / (tp + fp),
    recall: gold === 0 ? null : tp / gold,
  };
}

const r4 = (v: number): string => (Math.round(v * 1e4) / 1e4).toFixed(4);

export function resultKey(metric: string, value: number, kind: string): string {
  return `${metric}|${r4(value)}|${kind}`;
}

function usable(run: FdaSummaryExtraction, predicate: string | RegExp, filter?: (k: CheckedAssertion) => boolean): CheckedAssertion[] {
  return run.extraction.kept.filter((k) => {
    const matches = typeof predicate === "string" ? k.assertion.predicate === predicate : predicate.test(k.assertion.predicate);
    return matches && isUsable(k) && (filter ? filter(k) : true);
  });
}

function setScore(field: string, gold: string[][], extracted: string[][], precision = true): FieldReport {
  let g = 0;
  let e = 0;
  let tp = 0;
  let other = 0;
  for (let i = 0; i < gold.length; i++) {
    const gs = new Set(gold[i]);
    const es = new Set(extracted[i]);
    g += gs.size;
    e += es.size;
    for (const x of es) {
      if (gs.has(x)) tp++;
      else other++;
    }
  }
  const s = score(g, e, tp, precision ? e - tp : 0);
  const rep: FieldReport = { field, ...s };
  if (!precision) {
    rep.precision = null;
    rep.other = other;
  }
  return rep;
}

/** A single limit per document: right, wrong, or missing. */
function limitScore(field: string, gold: (number | null)[], got: (number | null)[]): FieldReport {
  let g = 0;
  let e = 0;
  let tp = 0;
  let fp = 0;
  gold.forEach((gv, i) => {
    const ev = got[i] as number | null;
    if (gv !== null) g++;
    if (ev !== null) e++;
    if (gv !== null && ev === gv) tp++;
    else if (ev !== null) fp++;
  });
  return { field, ...score(g, e, tp, fp) };
}

export function measureFda(gold: Gold, runs: Record<string, FdaSummaryExtraction>, adjudication: Adjudication = {}): MeasureReport {
  const ids = Object.keys(gold.docs).filter((id) => runs[id]);
  const ifu = (k: CheckedAssertion) => (k.detail.qualifiers ?? []).some((q) => q === "stated" || q === "from_exclusion") && !(k.detail.qualifiers ?? []).includes("study_population_text");
  const study = (k: CheckedAssertion) => (k.detail.qualifiers ?? []).includes("study_population_text");

  const versions = setScore(
    "device version strings",
    ids.map((id) => (gold.docs[id] as GoldDoc).versions),
    ids.map((id) => usable(runs[id] as FdaSummaryExtraction, "device.version").map((k) => String(k.assertion.value))),
  );

  const ageOf = (id: string, kind: "population.age_min" | "population.age_max", filter: (k: CheckedAssertion) => boolean) => {
    const rows = usable(runs[id] as FdaSummaryExtraction, kind, filter);
    // when a document states a limit twice with different values, the narrower one is what the converter uses
    if (rows.length === 0) return null;
    const vals = rows.map((r) => Number(r.assertion.value));
    return kind === "population.age_min" ? Math.max(...vals) : Math.min(...vals);
  };
  const ifuMin = limitScore("age minimum in the indications", ids.map((id) => (gold.docs[id] as GoldDoc).ifuAgeMin), ids.map((id) => ageOf(id, "population.age_min", ifu)));
  const ifuMax = limitScore("age maximum in the indications", ids.map((id) => (gold.docs[id] as GoldDoc).ifuAgeMax), ids.map((id) => ageOf(id, "population.age_max", ifu)));
  const stMin = limitScore("age minimum of the study population", ids.map((id) => (gold.docs[id] as GoldDoc).studyAgeMin), ids.map((id) => ageOf(id, "population.age_min", study)));
  const stMax = limitScore("age maximum of the study population", ids.map((id) => (gold.docs[id] as GoldDoc).studyAgeMax), ids.map((id) => ageOf(id, "population.age_max", study)));

  const settings = setScore(
    "care settings in the indications",
    ids.map((id) => (gold.docs[id] as GoldDoc).settings),
    ids.map((id) => usable(runs[id] as FdaSummaryExtraction, "indication.setting_term").map((k) => String(k.assertion.value))),
  );
  const samples = setScore(
    "study sample sizes (recall only)",
    ids.map((id) => (gold.docs[id] as GoldDoc).sampleSizes.map(String)),
    ids.map((id) => usable(runs[id] as FdaSummaryExtraction, /^study\.sample_size$/).map((k) => String(k.assertion.value))),
    false,
  );
  const sites = setScore(
    "study site counts (recall only)",
    ids.map((id) => (gold.docs[id] as GoldDoc).siteCounts.map(String)),
    ids.map((id) => usable(runs[id] as FdaSummaryExtraction, "study.site_count").map((k) => String(k.assertion.value))),
    false,
  );
  const ncts = setScore(
    "registered trial identifiers",
    ids.map((id) => (gold.docs[id] as GoldDoc).ncts),
    ids.map((id) => usable(runs[id] as FdaSummaryExtraction, "document.cites_nct").map((k) => String(k.assertion.value))),
  );

  // fields added later: scored only when the gold carries them
  const phrase = (x: string) => x.replace(/\s+/g, " ").trim().toLowerCase();
  const optional = (name: keyof Pick<GoldDoc, "conditions" | "exclusions" | "diagnosticExclusions" | "studySettings">, field: string, read: (run: FdaSummaryExtraction) => string[], norm: (x: string) => string = phrase): FieldReport[] => {
    if (!ids.every((id) => (gold.docs[id] as GoldDoc)[name] !== undefined)) return [];
    return [
      setScore(
        field,
        ids.map((id) => [...new Set(((gold.docs[id] as GoldDoc)[name] as string[]).map(norm))]),
        ids.map((id) => [...new Set(read(runs[id] as FdaSummaryExtraction).map(norm))]),
      ),
    ];
  };
  const added = [
    ...optional("conditions", "population conditions in the indications", (r) => usable(r, "population.condition").map((k) => String(k.assertion.value))),
    ...optional("exclusions", "excluded groups in the indications", (r) => usable(r, "population.exclusion_criterion").map((k) => String(k.assertion.value))),
    ...optional("diagnosticExclusions", "sentences excluding diagnostic use, by strength", (r) => usable(r, "indication.purpose_exclusion").map((k) => (k.detail.qualifiers ?? []).includes("qualified") ? "qualified" : "absolute"), (x) => x),
    ...optional("studySettings", "care settings named for the study", (r) => usable(r, "study.setting_term").map((k) => String(k.assertion.value))),
  ];

  // performance statements
  let rg = 0;
  let re = 0;
  let rtp = 0;
  let cor = 0;
  let inc = 0;
  let un = 0;
  let ciMatched = 0;
  let ciAgree = 0;
  let hg = 0;
  let he = 0;
  let htp = 0;
  for (const id of ids) {
    const g = gold.docs[id] as GoldDoc;
    const run = runs[id] as FdaSummaryExtraction;
    const rows = usable(run, /^(result|performance_goal)\./);
    const extracted = new Map<string, CheckedAssertion[]>();
    for (const k of rows) {
      const kind = k.assertion.predicate.startsWith("performance_goal.") ? "goal" : "observed";
      const metric = k.assertion.predicate.split(".")[1] as string;
      const key = resultKey(metric, Number(k.assertion.value), kind);
      extracted.set(key, [...(extracted.get(key) ?? []), k]);
    }
    const goldKeys = new Map<string, GoldResult>();
    for (const r of g.results) goldKeys.set(resultKey(r.metric, r.value, r.kind), r);
    rg += goldKeys.size;
    re += extracted.size;
    for (const [key, rowsForKey] of extracted) {
      const goldRow = goldKeys.get(key);
      if (goldRow) {
        rtp++;
        if (goldRow.ci) {
          ciMatched++;
          const ok = rowsForKey.some((k) => k.detail.ci && Math.abs(k.detail.ci[0] - (goldRow.ci as [number, number])[0]) < 6e-4 && Math.abs(k.detail.ci[1] - (goldRow.ci as [number, number])[1]) < 6e-4);
          if (ok) ciAgree++;
        }
      } else {
        const verdict = adjudication[id]?.[key];
        if (verdict === "correct") cor++;
        else if (verdict === "incorrect") inc++;
        else un++;
      }
    }
    // headline classification: observed figures a reviewer could take as the overall result
    const goldHead = new Set(g.results.filter((r) => r.headline && r.kind === "observed").map((r) => resultKey(r.metric, r.value, "observed")));
    const extHead = new Set(
      rows
        .filter((k) => isHeadlineResult(k))
        .map((k) => resultKey(k.assertion.predicate.split(".")[1] as string, Number(k.assertion.value), "observed")),
    );
    hg += goldHead.size;
    he += extHead.size;
    for (const k of extHead) if (goldHead.has(k)) htp++;
  }
  const results: FieldReport = {
    field: "performance statements (metric, value, kind)",
    ...score(rg, re, rtp, inc + un),
    adjudicated: { correct: cor, incorrect: inc, unadjudicated: un },
    intervalAgreement: { matched: ciMatched, agree: ciAgree },
  };
  // precision once valid extras are credited
  const credited = rtp + cor;
  results.note = `strict precision ${(rtp / Math.max(1, re)).toFixed(3)} (extras not in gold counted wrong); adjudicated precision ${(credited / Math.max(1, re)).toFixed(3)} (extras read against their passage)`;
  results.precision = re === 0 ? null : credited / re;
  results.fp = inc + un;

  const checks: MeasureReport["checks"] = { proposed: 0, quote: { passed: 0, failed: 0 }, support: { pass: 0, fail: 0, unchecked: 0 }, discardedUnquoted: 0 };
  const perDoc: MeasureReport["perDoc"] = {};
  for (const id of Object.keys(runs)) {
    const run = runs[id] as FdaSummaryExtraction;
    const c = run.extraction.counts;
    checks.proposed += c.proposed;
    checks.quote.passed += c.quote.passed;
    checks.quote.failed += c.quote.failed;
    checks.support.pass += c.support.pass;
    checks.support.fail += c.support.fail;
    checks.support.unchecked += c.support.unchecked;
    checks.discardedUnquoted += c.discardedUnquoted;
    perDoc[id] = {
      proposed: c.proposed,
      usable: run.extraction.kept.filter(isUsable).length,
      fields: Object.fromEntries(Object.entries(run.fields).map(([k, v]) => [k, { status: v.status }])),
    };
  }

  return {
    perField: [versions, ifuMin, ifuMax, stMin, stMax, settings, ...added, samples, sites, ncts, results],
    headline: score(hg, he, htp, he - htp),
    checks,
    perDoc,
  };
}

export function formatReport(report: MeasureReport): string {
  const f = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
  const lines: string[] = [];
  lines.push("| field | gold | extracted | correct | wrong | missed | precision | recall |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const r of report.perField) {
    lines.push(`| ${r.field} | ${r.gold} | ${r.extracted} | ${r.tp} | ${r.fp}${r.other !== undefined ? ` (+${r.other} other)` : ""} | ${r.fn} | ${f(r.precision)} | ${f(r.recall)} |`);
  }
  const h = report.headline;
  lines.push(`| headline results (overall observed figures) | ${h.gold} | ${h.extracted} | ${h.tp} | ${h.fp} | ${h.fn} | ${f(h.precision)} | ${f(h.recall)} |`);
  return lines.join("\n");
}
