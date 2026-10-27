/**
 * B1 and B2: the keyword and structured-rule baselines (docs/06 section 4). No model, no compiler, no identity layer.
 *
 * Both read the same raw records as every other arm (the FDA summary plus every candidate a name search returns) and apply plain
 * checks to the claim's stated fields: is the version string in the text, is there an age lower bound at or below the claimed one,
 * does each setting and purpose word appear, do most words of each condition appear. A claim is SUPPORTED_FOR_SCOPE when every stated
 * check passes and INSUFFICIENT_EVIDENCE otherwise. These baselines cannot say "narrower scope", cannot read a negation and cannot
 * tell one product of a shared brand from another; that is the point of having them.
 *
 *   B1  pools all records into one text and checks it once (what a keyword search over everything does).
 *   B2  checks each record on its own and needs a single record to satisfy every stated field (source by source, no composition).
 */
import type { ArmOutput, EvalCase } from "./types.ts";
import type { Doc } from "./documents.ts";
import { mapClaimPurpose } from "./vocabulary.ts";

export interface Check {
  dimension: string;
  claimed: string;
  pass: boolean;
  established?: string;
  /** The sentence the check matched on, when it passed. */
  quote?: string;
}

const STOP = new Set(["with", "from", "that", "this", "have", "been", "were", "their", "than", "under", "undergoing", "patients", "adults", "women", "using", "into", "also", "which", "such", "when", "while", "not", "and", "the", "for"]);

const SETTING_WORDS: Record<string, RegExp> = {
  primary_care: /primary[\s-]care/i,
  eye_care: /eye[\s-]care|ophthalmolog/i,
  hospital: /hospital|acute care|acute setting/i,
  emergency_department: /emergency/i,
  inpatient_ward: /inpatient|ward|hospital/i,
  endoscopy_unit: /endoscop/i,
  screening_program: /screening/i,
  imaging_centre: /imaging cent/i,
  outpatient_care: /outpatient|clinic/i,
};

const PURPOSE_WORDS: Record<string, RegExp> = {
  detection_aid: /detect|aid in|reading aid/i,
  triage_notification: /triage|notif|prioriti/i,
  screening: /screening/i,
  diagnosis: /diagnos/i,
  monitoring: /monitor/i,
  prognosis: /prognos|risk/i,
  acquisition_guidance: /guidance/i,
  autonomous_reading: /autonomous|on its own|without (?:a )?(?:radiologist|physician)/i,
};

function sentences(text: string): string[] {
  return text
    .replace(/\f/g, "\n")
    .split(/(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter((s) => s.length > 3);
}

function firstMatch(text: string, re: RegExp): string | undefined {
  for (const s of sentences(text)) if (re.test(s)) return s.slice(0, 300);
  return undefined;
}

/** Lower age bounds the text states: "aged 22 years and older", ">= 18", "older than 22", "between 40 and 80". */
export function ageLowerBounds(text: string): number[] {
  const out: number[] = [];
  const t = text.replace(/\s+/g, " ");
  const patterns: RegExp[] = [
    /(\d{1,2})\s*(?:years?|yrs?)?\s*(?:of age\s*)?(?:and|or)\s*(?:older|above|over|up)/gi,
    /aged?\s*(\d{1,2})\b/gi,
    /(?:≥|>=|&gt;=)\s*(\d{1,2})\s*(?:years?|yrs?)?/gi,
    /older than\s*(\d{1,2})/gi,
    /between\s*(\d{1,2})\s*and\s*\d{1,2}\s*years/gi,
    /ages?\s*(\d{1,2})\s*(?:and|-|to)/gi,
  ];
  for (const re of patterns) for (const m of t.matchAll(re)) out.push(Number(m[1]));
  return out.filter((n) => n >= 1 && n <= 90);
}

function contentWords(s: string): string[] {
  return [...new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w)))];
}

function wordsOf(term: string): string[] {
  return term.replace(/_/g, " ").split(/\s+/).filter(Boolean);
}

export function runChecks(c: EvalCase, text: string, includeProduct: boolean): Check[] {
  const use = c.claim.use as Record<string, unknown>;
  const checks: Check[] = [];
  const lower = text.toLowerCase();
  const product = use["product"] as string | undefined;
  if (includeProduct && product) {
    const id = product.split(":").pop() ?? product;
    checks.push({ dimension: "product", claimed: product, pass: text.includes(id), ...(text.includes(id) ? { quote: firstMatch(text, new RegExp(id)) ?? "" } : { established: "identifier not found" }) });
  }
  for (const v of (use["versions"] as string[] | undefined) ?? []) {
    const re = new RegExp(`(?:^|[^0-9A-Za-z.])v?${v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9A-Za-z]|\\.\\d)`, "i");
    const hit = re.test(text);
    checks.push({ dimension: "version", claimed: v, pass: hit, ...(hit ? { quote: firstMatch(text, re) ?? "" } : { established: "version string not found" }) });
  }
  const pop = use["population"] as { age?: { min?: number; max?: number }; conditions?: string[] } | undefined;
  if (pop?.age?.min !== undefined) {
    const bounds = ageLowerBounds(text);
    const ok = bounds.some((b) => b <= (pop.age?.min ?? 0));
    checks.push({
      dimension: "population",
      claimed: `age ${pop.age.min} and above`,
      pass: ok,
      ...(ok ? { quote: firstMatch(text, /aged?\s*\d|\d+\s*(?:years|yrs)|≥|>=|older/i) ?? "" } : { established: bounds.length ? `lowest stated age bound ${Math.min(...bounds)}` : "no age bound found" }),
    });
  }
  for (const cond of pop?.conditions ?? []) {
    const words = contentWords(cond);
    const present = words.filter((w) => lower.includes(w));
    const ok = words.length === 0 || present.length / words.length >= 0.6;
    checks.push({ dimension: "population", claimed: cond, pass: ok, ...(ok ? { quote: firstMatch(text, new RegExp(present[0] ?? ".", "i")) ?? "" } : { established: `${present.length} of ${words.length} condition words found` }) });
  }
  for (const s of (use["settings"] as string[] | undefined) ?? []) {
    const re = SETTING_WORDS[s] ?? new RegExp(wordsOf(s).join("\\W+"), "i");
    const hit = re.test(text);
    checks.push({ dimension: "setting", claimed: s, pass: hit, ...(hit ? { quote: firstMatch(text, re) ?? "" } : { established: "setting words not found" }) });
  }
  const purposeRaw = use["purpose"] as string | undefined;
  if (purposeRaw) {
    const mapped = mapClaimPurpose(purposeRaw) ?? purposeRaw;
    const re = PURPOSE_WORDS[mapped] ?? PURPOSE_WORDS[purposeRaw] ?? new RegExp(wordsOf(purposeRaw).filter((w) => w.length > 3).join("|") || ".", "i");
    const hit = re.test(text);
    checks.push({ dimension: "purpose", claimed: purposeRaw, pass: hit, ...(hit ? { quote: firstMatch(text, re) ?? "" } : { established: "purpose words not found" }) });
  }
  const timing = use["timing"] as { from?: string } | undefined;
  if (timing?.from) {
    const years = [...text.matchAll(/\b(20[0-3]\d)\b/g)].map((m) => Number(m[1]));
    const ok = years.some((y) => y <= Number(timing.from?.slice(0, 4)));
    checks.push({ dimension: "timing", claimed: `from ${timing.from}`, pass: ok, ...(ok ? { quote: firstMatch(text, /\b20[0-3]\d\b/) ?? "" } : { established: "no earlier date found" }) });
  }
  const perf = c.claim.performance;
  if (perf) {
    const hits = [...text.matchAll(new RegExp(`${perf.metric}[^.]{0,80}?(\\d{1,3}(?:\\.\\d+)?)\\s*%`, "gi"))].map((m) => Number(m[1]) / 100);
    const ok = hits.some((h) => h >= perf.atLeast);
    checks.push({ dimension: "metric", claimed: `${perf.metric} at least ${perf.atLeast}`, pass: ok, ...(ok ? { quote: firstMatch(text, new RegExp(perf.metric, "i")) ?? "" } : { established: hits.length ? `highest ${perf.metric} found ${Math.max(...hits)}` : "no figure found" }) });
  }
  return checks;
}

function toOutput(label: ArmOutput["label"], checks: Check[]): ArmOutput {
  return {
    label,
    status: "ok",
    mismatches: checks
      .filter((k) => !k.pass)
      .map((k) => ({ dimension: k.dimension, claimed: k.claimed, ...(k.established ? { established: k.established } : {}), anchored: false })),
    citations: checks.filter((k) => k.pass && k.quote).map((k) => k.quote as string),
  };
}

export function b1(c: EvalCase, docs: readonly Doc[]): ArmOutput {
  const text = docs.map((d) => d.text).join("\n\f\n");
  const checks = runChecks(c, text, true);
  return toOutput(checks.every((k) => k.pass) ? "SUPPORTED_FOR_SCOPE" : "INSUFFICIENT_EVIDENCE", checks);
}

export function b2(c: EvalCase, docs: readonly Doc[]): ArmOutput {
  let best: Check[] | undefined;
  for (const d of docs) {
    const checks = runChecks(c, d.text, d.kind === "fda-summary");
    if (!best || checks.filter((k) => !k.pass).length < best.filter((k) => !k.pass).length) best = checks;
    if (checks.every((k) => k.pass)) return toOutput("SUPPORTED_FOR_SCOPE", checks);
  }
  return toOutput("INSUFFICIENT_EVIDENCE", best ?? []);
}
