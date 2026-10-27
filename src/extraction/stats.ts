/**
 * Performance statements: which metric does each reported value belong to, and what kind of number is it?
 *
 * The same sentence can hold an observed result, a prespecified goal, an enrichment-corrected result and a worst-case
 * result. Binding a number to the wrong one is the failure this module exists to prevent, so every binding carries a
 * kind and qualifiers, and values that cannot be bound with confidence are left unbound and counted.
 *
 * Values are returned as proportions (87.8% -> 0.878); the form seen in the text is recorded.
 */

import { DEVELOPMENT } from "./lexicon.ts";

export const METRICS = ["sensitivity", "specificity", "auc", "ppv", "npv", "accuracy", "ppa", "npa"] as const;
export type Metric = (typeof METRICS)[number];

const METRIC_SOURCES: Record<Metric, string> = {
  sensitivity: String.raw`(?<!time\s)sensitivit(?:y|ies)(?!\s+analys)`,
  specificity: String.raw`specificit(?:y|ies)`,
  auc: String.raw`(?:ROC\s+)?AUC|AUROC|area\s+under\s+the\s+(?:receiver\s+operating\s+characteristic\s+)?(?:\(ROC\)\s+)?curve|C-statistic`,
  ppv: String.raw`PPV|positive\s+predictive\s+value`,
  npv: String.raw`NPV|negative\s+predictive\s+value`,
  accuracy: String.raw`(?:overall\s+)?accuracy`,
  ppa: String.raw`positive\s+percent\s+agreement`,
  npa: String.raw`negative\s+percent\s+agreement`,
};
function buildMetricRe(sources: Record<Metric, string>): RegExp {
  return new RegExp(String.raw`\b(?:(${METRICS.map((m) => `(?<m_${m}>${sources[m]})`).join("|")}))\b`, "gi");
}
const METRIC_RE = buildMetricRe(METRIC_SOURCES);
/**
 * "PPA" and "NPA" mean positive and negative percent agreement in diagnostic-accuracy summaries and something else
 * elsewhere (polyps per adenoma in colonoscopy). The acronyms are read as metrics only when the caller says the
 * document spells the metric out.
 */
const METRIC_RE_WITH_AGREEMENT_ACRONYMS = buildMetricRe({
  ...METRIC_SOURCES,
  ppa: String.raw`PPA|${METRIC_SOURCES.ppa}`,
  npa: String.raw`NPA|${METRIC_SOURCES.npa}`,
});

const SEP = String.raw`(?:\s*(?:-|\u2010|\u2011|\u2012|\u2013|\u2014|\u2015|\u2212|\uFFFD|to|,|;)\s*|\s+)`;
const NUM = String.raw`(\d{1,3}(?:\.\d+)?)`;
const CI_LABELLED = new RegExp(
  String.raw`^\s*[\(\[]?\s*(?:[A-Za-z]{2,6},\s*)?(?:two-sided\s+)?(?:9[059](?:\.\d)?\s?%\s*)?(?:CI|C\.[I1l]\.?|CL|confidence\s+(?:interval|limits?))\s*(?:of\s+|[:,=])?\s*[\[\(]?\s*${NUM}\s*%?${SEP}${NUM}\s*%?\s*[\]\)]?`,
  "i",
);
const CI_BARE = new RegExp(String.raw`^\s*[\[\(]\s*${NUM}\s*%?${SEP}${NUM}\s*%?\s*[\]\)]`);
const CI_PROP_LABELLED = new RegExp(
  String.raw`^\s*[\(\[]?\s*(?:[A-Za-z]{2,6},\s*)?(?:two-sided\s+)?(?:9[059](?:\.\d)?\s?%\s*)?(?:CI|C\.[I1l]\.?|CL|confidence\s+(?:interval|limits?))\s*(?:of\s+|[:,=])?\s*[\[\(]?\s*(\d?\.\d{2,4})${SEP}(\d?\.\d{2,4})\s*[\]\)]?`,
  "i",
);
const CI_PROP_BARE = new RegExp(String.raw`^\s*[\[\(]\s*(\d?\.\d{2,4})${SEP}(\d?\.\d{2,4})\s*[\]\)]`);
const COUNTS = /^\s*\(\s*(\d{1,6})\s*\/\s*(\d{1,6})\s*\)/;

const GOAL_BEFORE = /(threshold|goal|criteri(?:on|a)|target|margin|exceed|at least|no less than|minimum|lower bound|pre-?\s?specified|pre-?\s?defined|non-?inferiority|acceptance|above|greater than|>)/i;
const GOAL_AFTER = /^\s*(?:\)|,)?\s*(?:(?:performance\s+)?(?:goal|threshold|target|criterion)|(?:non-?inferiority\s+)?margin|or\s+(?:higher|more|greater|above|better))/i;
const CONNECTOR_ONLY = /^[\s,;/&]*(?:and|or|as well as)?[\s,;/&]*$/i;
const POSTFIX_FILLER = /^\s*(?:\)\s*)?(?:for|of|in|on|with|the|overall|a|an|\(|\s)*$/i;

export interface StatBinding {
  metric: Metric;
  /** "observed": a measured result. "goal": a prespecified bar the result is compared with. */
  kind: "observed" | "goal";
  /** As a proportion between 0 and 1. */
  value: number;
  form: "percent" | "proportion";
  ci?: [number, number];
  /** Denominator when the text shows "(173/238)". */
  denominator?: number;
  qualifiers: string[];
  /** Offsets into the scanned text. */
  quoteStart: number;
  quoteEnd: number;
  valueStart: number;
  valueEnd: number;
}

export interface ScanOutcome {
  bindings: StatBinding[];
  /** Values seen but not bound to a metric with confidence. They are reported, never guessed. */
  unbound: { text: string; start: number; reason: string }[];
}

interface MetricEvent {
  type: "metric";
  metric: Metric;
  start: number;
  end: number;
}
interface ValueEvent {
  type: "value";
  start: number;
  end: number;
  value: number;
  form: "percent" | "proportion";
  /** end of the value plus its interval and counts, when present */
  groupEnd: number;
  ci?: [number, number];
  denominator?: number;
  ciInconsistent?: boolean;
}
type Event = MetricEvent | ValueEvent;

function toProportion(raw: number, form: "percent" | "proportion"): number {
  // six decimals is finer than any reported figure and removes binary rounding noise (0.896, not 0.8959999999999999)
  return Number((form === "percent" ? raw / 100 : raw).toFixed(6));
}

function parseCiAfter(text: string, from: number, form: "percent" | "proportion"): { ci: [number, number]; end: number } | undefined {
  const rest = text.slice(from, from + 140);
  const labelled = form === "percent" ? CI_LABELLED.exec(rest) : CI_PROP_LABELLED.exec(rest);
  const m = labelled ?? (form === "percent" ? CI_BARE.exec(rest) : CI_PROP_BARE.exec(rest));
  if (!m) return undefined;
  const lo = Number(m[1]);
  const hi = Number(m[2]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo > hi) return undefined;
  return { ci: [toProportion(lo, form), toProportion(hi, form)], end: from + m[0].length };
}

function collectEvents(text: string, agreementAcronyms: boolean): Event[] {
  const events: Event[] = [];
  for (const m of text.matchAll(agreementAcronyms ? METRIC_RE_WITH_AGREEMENT_ACRONYMS : METRIC_RE)) {
    const groups = m.groups ?? {};
    const metric = METRICS.find((k) => groups[`m_${k}`] !== undefined);
    if (!metric) continue;
    events.push({ type: "metric", metric, start: m.index as number, end: (m.index as number) + m[0].length });
  }

  const consumed: [number, number][] = [];
  const inConsumed = (i: number) => consumed.some(([a, b]) => i >= a && i < b);

  // percent values first; they are the common form
  const pctRe = /(?<![\d.])(\d{1,3}(?:\.\d+)?)\s?%/g;
  for (const m of text.matchAll(pctRe)) {
    const start = m.index as number;
    const end = start + m[0].length;
    if (inConsumed(start)) continue;
    const after = text.slice(end, end + 12);
    const before = text.slice(Math.max(0, start - 8), start);
    // "95% CI" is a confidence level, not a result
    if (/^\s*(?:CI|C\.[I1l]|CL|confidence)/i.test(after) && Number(m[1]) >= 90) continue;
    if (/p\s*[<=>]\s*$/i.test(before)) continue;
    // a prevalence is a property of the sample, not a performance value
    if (/\b(?:prevalence|incidence)\s*(?:of|was|is|=|:)?\s*$/i.test(text.slice(Math.max(0, start - 25), start))) continue;
    // a negative figure ("-3.1%") is a difference, never a performance value; the sign is not dropped, the figure is
    if (/(?:^|[^\d%)\]\w.])[-\u2212]\s?$/.test(before)) continue;
    // the first number after a "CI:" label is the interval's lower end
    if (/(?:\bCI|C\.[I1l]\.?|\bCL|confidence\s+(?:interval|limits?))\s*(?:of\s+|[:,=])?\s*[\[(]?\s*$/i.test(text.slice(Math.max(0, start - 30), start))) continue;
    // "[85.1% - 97.5%]" is an interval whose point estimate is missing or elsewhere, not a result
    if (/[\[(]\s*$/.test(text.slice(Math.max(0, start - 3), start)) && new RegExp(String.raw`^${SEP}${NUM}\s*%?\s*[\])]`).test(text.slice(end, end + 24))) continue;
    // part of an arithmetic expression: "(6.2% + 1.6%)"
    if (/\+\s*$/.test(before) || /^\s*\+\s*\d/.test(text.slice(end, end + 6))) continue;
    // ...and its upper end: "97.5%]" after "85.1% -"
    if (new RegExp(String.raw`\d\s*%?${SEP}$`).test(text.slice(Math.max(0, start - 12), start)) && /^\s*[\])]/.test(text.slice(end, end + 4))) continue;
    const v = Number(m[1]);
    if (v > 100) continue;
    const ciHit = parseCiAfter(text, end, "percent");
    let groupEnd = ciHit ? ciHit.end : end;
    let denominator: number | undefined;
    const c = COUNTS.exec(text.slice(groupEnd, groupEnd + 24));
    if (c) {
      denominator = Number(c[2]);
      groupEnd += c[0].length;
    }
    if (ciHit) consumed.push([end, ciHit.end]);
    const ev: ValueEvent = { type: "value", start, end, value: toProportion(v, "percent"), form: "percent", groupEnd };
    if (ciHit) {
      ev.ci = ciHit.ci;
      if (ev.value < ciHit.ci[0] - 0.0005 || ev.value > ciHit.ci[1] + 0.0005) ev.ciInconsistent = true;
    }
    if (denominator !== undefined) ev.denominator = denominator;
    events.push(ev);
  }

  // proportions such as "AUC 0.91" or "sensitivity 0.867 (95% CI 0.811-0.908)"
  const propRe = /(?<![\d.\w])((?:0)?\.\d{2,4}|1\.0{1,4})(?![\d%])/g;
  for (const m of text.matchAll(propRe)) {
    const start = m.index as number;
    const end = start + m[0].length;
    if (inConsumed(start) || events.some((e) => e.type === "value" && start >= e.start && start < e.groupEnd)) continue;
    const before = text.slice(Math.max(0, start - 12), start);
    if (/p(?:\s*-?\s*value)?\s*[<=>:]*\s*$/i.test(before) || /(?:version|v)\s*$/i.test(before)) continue;
    if (/(?:\bCI|C\.[I1l]\.?|\bCL|confidence\s+(?:interval|limits?))\s*(?:of\s+|[:,=])?\s*[\[(]?\s*$/i.test(text.slice(Math.max(0, start - 30), start))) continue;
    // "AUC=+0.085" is a difference between two readings, not an AUC
    if (/[+\u2212\-]\s*$/.test(before) && !/\d\s*[+\u2212\-]\s*$/.test(before)) continue;
    // an interval end "[0.752 - 0.843]" or start "[0.044 - 0.127]"
    if (new RegExp(String.raw`\d${SEP}$`).test(text.slice(Math.max(0, start - 8), start)) && /^\s*[\])]/.test(text.slice(end, end + 4))) continue;
    if (/[\[(]\s*$/.test(text.slice(Math.max(0, start - 3), start)) && new RegExp(String.raw`^${SEP}(?:\d?\.\d{2,4})\s*[\])]`).test(text.slice(end, end + 24))) continue;
    const v = Number(m[1]);
    if (v > 1) continue;
    const ciHit = parseCiAfter(text, end, "proportion");
    if (ciHit) consumed.push([end, ciHit.end]);
    const ev: ValueEvent = { type: "value", start, end, value: v, form: "proportion", groupEnd: ciHit ? ciHit.end : end };
    if (ciHit) {
      ev.ci = ciHit.ci;
      if (v < ciHit.ci[0] - 0.00005 || v > ciHit.ci[1] + 0.00005) ev.ciInconsistent = true;
    }
    events.push(ev);
  }

  // a value that lies inside another value's interval is not an event of its own
  const filtered = events.filter((e) => e.type === "metric" || !consumed.some(([a, b]) => e.start >= a && e.start < b));
  return filtered.sort((a, b) => a.start - b.start);
}

function qualifiersFor(text: string, valueStart: number, sentenceHasRedaction: boolean, tableLike: boolean): string[] {
  const q: string[] = [];
  const window = text.slice(Math.max(0, valueStart - 140), valueStart + 30);
  const whole = text;
  if (/corrected\s+for\s+enrichment|enrichment[- ]corrected/i.test(window)) q.push("enrichment_corrected");
  if (/worst[- ]case/i.test(whole)) q.push("worst_case");
  if (
    /\b(subgroup|stratif\w*|vari(?:ed|es)\s+across|(?:lowest|highest)\b[^.]{0,80}\b(?:observed|performance)|across\s+(?:clinical\s+)?(?:sites|demographics|ECG\s+manufacturers?|manufacturers|subgroups|ages|races)|by\s+(?:age|sex|gender|race|ethnicity|site|region|scanner|manufacturer|vendor|slice|contrast|center|centre)|(?:in|among)\s+(?:the\s+)?(?:\d[\d,]*\s+)?(?:patients|subjects|participants|women|men|exams|cases|images)\s+(?:aged|over|under|with|who|from)|(?:in|among)\s+(?:younger|older|pediatric|female|male)\b)/i.test(
      window,
    )
  )
    q.push("subgroup");
  if (DEVELOPMENT.test(whole)) q.push("development_set");
  // Reading with the tool is a different quantity from the tool alone. "standalone" before the value wins: in
  // "the AUC of the system as a standalone device was 0.883 ... superior to radiologists in unaided reading" the
  // figure is the standalone one even though readers are discussed afterwards.
  const standaloneBefore = /\bstandalone\b/i.test(text.slice(0, valueStart));
  if (/\b(unaided|aided|assisted|readers?|reading\s+conditions|human[- ]AI|with\s+and\s+without)\b/i.test(whole) && !standaloneBefore) q.push("reader_arm");
  if (/\bstandalone\b/i.test(whole)) q.push("standalone");
  // a change between two readings, not a reading
  if (/\b(improvement|improved|increase[sd]?|decrease[sd]?|reduction|difference|gain|change|delta|higher|lower)\b[^.%]{0,40}$/i.test(text.slice(Math.max(0, valueStart - 60), valueStart))) q.push("difference");
  if (sentenceHasRedaction) q.push("redacted_context");
  if (tableLike) q.push("table_row");
  return q;
}

/**
 * Scan one sentence (or one table row) for performance statements.
 */
export function scanStatements(text: string, options: { tableLike?: boolean; prose?: boolean; agreementAcronyms?: boolean } = {}): ScanOutcome {
  const events = collectEvents(text, options.agreementAcronyms === true);
  const redacted = /\(b\)\s*\(\d\)/.test(text);
  const bindings: StatBinding[] = [];
  const bound = new Set<number>();
  const values = events.filter((e): e is ValueEvent => e.type === "value");
  const metrics = events.filter((e): e is MetricEvent => e.type === "metric");

  // A row of a table: wide gaps, the same metric named again with nothing but numbers between (two columns side by
  // side), or a label followed by a count and a percentage ("Specificity 221 91.9%"). Its headers are not in the row.
  // "positive predictive value of 30.5% (PPV, ..." names one metric twice in a row; that is not two columns.
  const metricRuns = metrics.filter((m, i) => !(i > 0 && (metrics[i - 1] as MetricEvent).metric === m.metric && m.start - (metrics[i - 1] as MetricEvent).end <= 20));
  const FILLER = new Set(["with", "confidence", "interval", "limits", "limit"]);
  let repeatsMetric = false;
  for (let i = 0; i < metricRuns.length && !repeatsMetric; i++) {
    for (let j = i + 1; j < metricRuns.length; j++) {
      if ((metricRuns[j] as MetricEvent).metric !== (metricRuns[i] as MetricEvent).metric) continue;
      const between = text.slice((metricRuns[i] as MetricEvent).end, (metricRuns[j] as MetricEvent).start);
      const words = (between.match(/[A-Za-z]{4,}/g) ?? []).filter((w) => !FILLER.has(w.toLowerCase()));
      if (words.length === 0) repeatsMetric = true;
      break;
    }
  }
  repeatsMetric = !options.prose && repeatsMetric && values.length >= 2;
  const labelCountPercent = !options.prose && /^\s*[A-Za-z][\w ()/-]{0,25}?\s+\d+\s+\d+(?:\.\d+)?\s?%/.test(text);
  const tableLike = options.tableLike ?? (/\S {3,}\S/.test(text) || repeatsMetric || labelCountPercent);

  const push =(metric: MetricEvent, v: ValueEvent, quoteStart: number, extra: string[] = [], forceGoal = false) => {
    const before = text.slice(Math.max(0, v.start - 45), v.start);
    const after = text.slice(v.groupEnd, v.groupEnd + 30);
    const goal = forceGoal || GOAL_BEFORE.test(before) || GOAL_AFTER.test(after);
    const qualifiers = [...qualifiersFor(text, v.start, redacted, tableLike), ...extra];
    if (v.ciInconsistent) qualifiers.push("ci_inconsistent");
    const b: StatBinding = {
      metric: metric.metric,
      kind: goal ? "goal" : "observed",
      value: v.value,
      form: v.form,
      qualifiers,
      quoteStart: Math.min(quoteStart, v.start),
      quoteEnd: Math.max(v.groupEnd, metric.end),
      valueStart: v.start,
      valueEnd: v.end,
    };
    if (v.ci) b.ci = v.ci;
    if (v.denominator !== undefined) b.denominator = v.denominator;
    bindings.push(b);
    bound.add(v.start);
  };

  // A. a value followed directly by a metric word: "94.29% sensitivity", "85.0% for sensitivity"
  for (const v of values) {
    const next = metrics.find((m) => m.start >= v.groupEnd);
    if (!next) continue;
    const between = text.slice(v.groupEnd, next.start);
    const nextValue = values.find((x) => x.start >= v.groupEnd);
    if (between.length <= 18 && !/^[ \t]*\n/.test(between) && POSTFIX_FILLER.test(between) && (!nextValue || nextValue.start > next.start)) {
      // only filler words on the same line may sit between: "87%" at a line end does not belong to the next line's label
      // "0.9973 ROC AUC (95% CI: 0.9955 - 0.9992)": the interval follows the metric word, not the number
      const late = v.ci ? undefined : parseCiAfter(text, next.end, v.form);
      push(next, late ? { ...v, ci: late.ci, groupEnd: late.end } : v, v.start);
    }
  }

  // B. runs of metrics followed by runs of values
  const runs: MetricEvent[][] = [];
  for (const m of metrics) {
    const last = runs[runs.length - 1];
    const prev = last?.[last.length - 1];
    if (prev && CONNECTOR_ONLY.test(text.slice(prev.end, m.start))) last.push(m);
    else runs.push([m]);
  }
  for (const run of runs) {
    const runEnd = (run[run.length - 1] as MetricEvent).end;
    const first = values.find((v) => v.start >= runEnd && !bound.has(v.start));
    if (!first) continue;
    const gap = text.slice(runEnd, first.start);
    if (gap.length > 110 || /[.;]\s+[A-Z]/.test(gap) || metrics.some((m) => m.start >= runEnd && m.start < first.start)) continue;
    const valueRun: ValueEvent[] = [first];
    for (;;) {
      const lastV = valueRun[valueRun.length - 1] as ValueEvent;
      const nextV = values.find((v) => v.start >= lastV.groupEnd && !bound.has(v.start));
      if (!nextV) break;
      if (metrics.some((m) => m.start >= lastV.groupEnd && m.start < nextV.start)) break;
      if (!CONNECTOR_ONLY.test(text.slice(lastV.groupEnd, nextV.start).replace(/\b(?:respectively)\b/i, ""))) break;
      // a following value that has its own metric directly after it belongs to that metric (rule A)
      valueRun.push(nextV);
    }
    const startOfRun = (run[0] as MetricEvent).start;
    if (valueRun.length === run.length) {
      run.forEach((m, i) => push(m, valueRun[i] as ValueEvent, startOfRun));
    } else if (valueRun.length === 1 && run.length > 1) {
      // one number for several metrics: only a goal reads that way ("sensitivity and specificity ... an 80% goal")
      const v = valueRun[0] as ValueEvent;
      const goal = GOAL_BEFORE.test(text.slice(Math.max(0, v.start - 70), v.start)) || GOAL_AFTER.test(text.slice(v.groupEnd, v.groupEnd + 30));
      if (goal) for (const m of run) push(m, v, startOfRun, [], true);
    } else if (run.length === 1) {
      // one metric, several values: a table row across columns whose headers are not known here
      for (const v of valueRun) push(run[0] as MetricEvent, v, startOfRun, valueRun.length > 1 ? ["multi_value_row"] : []);
    }
  }

  // C. nearest preceding metric with no value in between
  for (const v of values) {
    if (bound.has(v.start)) continue;
    const prior = [...metrics].reverse().find((m) => m.end <= v.start);
    if (!prior) continue;
    const gap = text.slice(prior.end, v.start);
    if (gap.length <= 80 && !values.some((x) => x.start >= prior.end && x.start < v.start) && !/[.;]\s+[A-Z]/.test(gap)) {
      push(prior, v, prior.start);
    }
  }

  // D. the same metric restated for another condition: "AUC is 0.945 (...) for 2D and 0.945 (...) for DBT"
  for (const v of values) {
    if (bound.has(v.start)) continue;
    const prev = [...bindings].reverse().find((b) => b.valueStart < v.start);
    if (!prev) continue;
    const prevValue = values.find((x) => x.start === prev.valueStart);
    if (!prevValue) continue;
    const gap = text.slice(prevValue.groupEnd, v.start);
    if (gap.length <= 60 && /^[\s\w,]*\b(?:and|to)\s*$/i.test(gap) && !metrics.some((m) => m.start >= prevValue.groupEnd && m.start < v.start)) {
      push({ type: "metric", metric: prev.metric, start: prev.quoteStart, end: prev.quoteStart }, v, prev.quoteStart, ["repeated_metric"]);
    }
  }

  // a value with no metric word anywhere in the sentence (a demographic share, a prevalence) is not a performance candidate
  const unbound = (metrics.length === 0 ? [] : values)
    .filter((v) => !bound.has(v.start))
    .map((v) => ({ text: text.slice(v.start, v.groupEnd), start: v.start, reason: "no metric could be bound" }));
  bindings.sort((a, b) => a.valueStart - b.valueStart);
  // A table row holding several values spans several columns whose headers (subgroup, site, setting) are not in the row.
  if (tableLike && values.length >= 2) {
    for (const b of bindings) if (!b.qualifiers.includes("multi_value_row")) b.qualifiers.push("multi_value_row");
  }
  // a goal stated for one metric carries over to the next value joined by "and" ("85.0% for sensitivity and 82.5% for specificity")
  for (let i = 1; i < bindings.length; i++) {
    const prev = bindings[i - 1] as StatBinding;
    const cur = bindings[i] as StatBinding;
    if (prev.kind === "goal" && cur.kind === "observed" && /^[\s,;]*(?:and\s+)?$/i.test(text.slice(prev.quoteEnd, cur.quoteStart))) {
      cur.kind = "goal";
    }
  }
  // A figure belongs to the predicate device when "predicate" (or "reference device") stands in the clause just before
  // it, and so does every following figure until the clause changes ("... equivalence to the predicate device, with
  // sensitivity of 0.910 and specificity of 0.889").
  let carrying = false;
  let prevEnd = 0;
  for (const b of bindings) {
    const clause = text.slice(prevEnd, b.valueStart);
    if (/\b(?:predicate|reference\s+device)\b/i.test(clause)) carrying = true;
    else if (/[;]|\b(?:whereas|while|however|but|subject\s+device|proposed\s+device)\b/i.test(clause)) carrying = false;
    if (carrying) b.qualifiers.push("predicate_value");
    prevEnd = b.quoteEnd;
  }
  return { bindings, unbound };
}
