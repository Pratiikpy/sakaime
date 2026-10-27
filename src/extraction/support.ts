/**
 * Check 2 of 2: does the passage STATE what the assertion CLAIMS?
 *
 * A quote can exist verbatim and still say something else: the number belongs to another metric, to a prespecified
 * goal instead of a result, to a development set, to the predicate device, to a different version, or to the other
 * side of an age limit. This module decides that with deterministic rules first. A rule that cannot decide returns
 * null and the assertion stays UNCHECKED; it is never promoted to PASS by default and never demoted to FAIL on a
 * guess. Every outcome names the rule that produced it.
 */
import { parseAgeBounds, parseRegistryAge } from "./age.ts";
import { DEVELOPMENT, TERM_PREDICATES } from "./lexicon.ts";
import { parseNumberToken } from "./document.ts";
import { buildKey, numericTokens } from "./normalize.ts";
import { diagnosticExclusion } from "./population.ts";
import { scanStatements, METRICS, type Metric, type StatBinding } from "./stats.ts";
import type { ProposedAssertion, ResultDetail, RuleOutcome, SupportReport, SupportState } from "./types.ts";

export interface SupportClaim {
  predicate: string;
  value: ProposedAssertion["value"];
  unit?: string;
  appliesToVersion?: string;
  detail?: ResultDetail;
}

export interface SupportContext {
  /** Names the subject goes by in the source (product name variants). */
  subjectNames?: string[];
  /** Names that would make a passage about someone else: predicate devices, sibling modules, other products. */
  otherSubjectNames?: string[];
  /**
   * When true, a passage that names no product at all cannot support a subject-specific claim (free text from a
   * paper). When false, the passage is taken to be about the record's own subject (an FDA summary of that device).
   */
  requireSubjectMention?: boolean;
}

const EPS = 5e-4;

const UNIT_CLASSES: Record<string, string> = {
  patient: "person",
  patients: "person",
  subject: "person",
  subjects: "person",
  participant: "person",
  participants: "person",
  individual: "person",
  individuals: "person",
  women: "person",
  woman: "person",
  men: "person",
  case: "case",
  cases: "case",
  exam: "image",
  exams: "image",
  study: "image",
  studies: "image",
  image: "image",
  images: "image",
  scan: "image",
  scans: "image",
  radiograph: "image",
  radiographs: "image",
  slide: "image",
  slides: "image",
  mammogram: "image",
  mammograms: "image",
  encounter: "record",
  encounters: "record",
  wsi: "image",
  wsis: "image",
  specimen: "record",
  specimens: "record",
  biopsy: "record",
  biopsies: "record",
  record: "record",
  records: "record",
  ecg: "record",
  ecgs: "record",
  video: "record",
  videos: "record",
  eye: "eye",
  eyes: "eye",
  site: "site",
  sites: "site",
  center: "site",
  centers: "site",
  centre: "site",
  centres: "site",
  institution: "site",
  institutions: "site",
  hospital: "site",
  hospitals: "site",
  facility: "site",
  facilities: "site",
  practice: "site",
  practices: "site",
  clinic: "site",
  clinics: "site",
};

export function unitClass(unit: string | undefined): string | undefined {
  return unit === undefined ? undefined : UNIT_CLASSES[unit.toLowerCase()];
}


function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function decide(rules: RuleOutcome[], flags: string[]): { state: SupportState; rules: RuleOutcome[]; flags: string[] } {
  if (rules.some((r) => r.ok === false)) return { state: "FAIL", rules, flags };
  if (rules.length > 0 && rules.every((r) => r.ok === true)) return { state: "PASS", rules, flags };
  return { state: "UNCHECKED", rules, flags };
}

function metricOf(predicate: string): { family: "result" | "goal"; metric: Metric } | undefined {
  const m = /^(result|performance_goal)\.([a-z]+)$/.exec(predicate);
  if (!m) return undefined;
  const metric = METRICS.find((x) => x === m[2]);
  return metric ? { family: m[1] === "result" ? "result" : "goal", metric } : undefined;
}

function nameHits(passage: string, names: string[] | undefined): string[] {
  if (!names?.length) return [];
  const p = buildKey(passage).key.toLowerCase();
  return names.filter((n) => n.trim() && p.includes(buildKey(n).key.toLowerCase()));
}

function subjectRule(passage: string, ctx: SupportContext): RuleOutcome | undefined {
  const own = nameHits(passage, ctx.subjectNames);
  const other = nameHits(passage, ctx.otherSubjectNames);
  if (!ctx.subjectNames?.length && !ctx.otherSubjectNames?.length) return undefined;
  if (own.length > 0) return { rule: "subject", ok: true, detail: `the passage names ${own.join(", ")}` };
  if (other.length > 0) return { rule: "subject", ok: false, detail: `the passage is about ${other.join(", ")}, not the subject` };
  if (ctx.requireSubjectMention) return { rule: "subject", ok: null, detail: "the passage names no product, so the subject is not established" };
  return undefined;
}

function predicateContext(passage: string, ctx: SupportContext): RuleOutcome | undefined {
  if (!/\bpredicate\b|\breference\s+device\b/i.test(passage)) return undefined;
  if (nameHits(passage, ctx.subjectNames).length > 0) {
    return { rule: "predicate_context", ok: null, detail: "the passage mentions a predicate device and also the subject" };
  }
  return { rule: "predicate_context", ok: false, detail: "the passage is about a predicate or reference device, not the subject" };
}

// ---------------------------------------------------------------------------------------------- result rules

function resultRules(passage: string, claim: SupportClaim, ctx: SupportContext): { rules: RuleOutcome[]; flags: string[] } {
  const target = metricOf(claim.predicate);
  const rules: RuleOutcome[] = [];
  const flags: string[] = [];
  if (!target || typeof claim.value !== "number") return { rules, flags };

  const scan = scanStatements(passage, { agreementAcronyms: target.metric === "ppa" || target.metric === "npa" });
  const metricsPresent = new Set<Metric>();
  for (const b of scan.bindings) metricsPresent.add(b.metric);

  const sameValue = (b: StatBinding) => Math.abs(b.value - (claim.value as number)) <= EPS;
  const matchesValue = scan.bindings.filter(sameValue);
  const exact = matchesValue.filter((b) => b.metric === target.metric);

  if (exact.length === 0) {
    if (matchesValue.length > 0) {
      const other = matchesValue.map((b) => b.metric).join(", ");
      rules.push({ rule: "metric_binding", ok: false, detail: `${claim.value} is reported for ${other}, not for ${target.metric}` });
    } else {
      rules.push({ rule: "metric_binding", ok: null, detail: `${claim.value} could not be bound to ${target.metric} by the pattern rules` });
    }
  } else {
    const kinds = new Set(exact.map((b) => b.kind));
    const wantKind = target.family === "result" ? "observed" : "goal";
    if (kinds.has(wantKind)) {
      rules.push({ rule: "metric_binding", ok: true, detail: `${claim.value} is bound to ${target.metric} as a ${wantKind}` });
    } else {
      rules.push({
        rule: "result_vs_goal",
        ok: false,
        detail: `${claim.value} for ${target.metric} is a ${[...kinds].join("/")} in the passage, not a ${wantKind}`,
      });
    }

    const sameKind = exact.filter((b) => b.kind === wantKind);
    const ciOf = (b: StatBinding) => !claim.detail?.ci || (!!b.ci && Math.abs(b.ci[0] - claim.detail.ci[0]) <= EPS && Math.abs(b.ci[1] - claim.detail.ci[1]) <= EPS);
    const chosen = sameKind.find(ciOf) ?? sameKind[0] ?? exact[0];
    if (chosen) {
      const claimed = new Set(claim.detail?.qualifiers ?? []);
      const differing = chosen.qualifiers.filter(
        (q) => ["development_set", "worst_case", "enrichment_corrected", "subgroup", "reader_arm", "difference"].includes(q) && !claimed.has(q),
      );
      if (differing.length > 0) {
        rules.push({
          rule: "analysis_context",
          ok: false,
          detail: `the passage reports this number for a different analysis (${differing.join(", ")})`,
        });
      }
      for (const q of chosen.qualifiers) if (!flags.includes(q)) flags.push(q);
      if (chosen.qualifiers.includes("predicate_value")) {
        rules.push({ rule: "predicate_context", ok: false, detail: "the figure is reported for the predicate or reference device, not the subject" });
      }
      if (claim.detail?.ci && chosen.ci) {
        const same = Math.abs(chosen.ci[0] - claim.detail.ci[0]) <= EPS && Math.abs(chosen.ci[1] - claim.detail.ci[1]) <= EPS;
        rules.push({ rule: "interval", ok: same, detail: same ? "interval matches" : `interval in the passage is ${chosen.ci.join(" to ")}` });
      }
    }
  }

  if (claim.detail?.qualifiers?.includes("comparison_table")) {
    rules.push({ rule: "comparison_table", ok: null, detail: "the figure sits on a page that sets the proposed and the predicate device side by side; the column is not established" });
  }
  const subj = subjectRule(passage, ctx);
  if (subj) rules.push(subj);
  return { rules, flags };
}

// ------------------------------------------------------------------------------------------ version rules

const VERSION_TOKEN = /(?<![\d.])v?(\d+\.\d+(?:\.\d+){0,3})(?![\d]|\.\d)/gi;

function versionRules(passage: string, version: string, ctx: SupportContext): RuleOutcome[] {
  const rules: RuleOutcome[] = [];
  const bare = version.replace(/^v/i, "");
  const own = new RegExp(String.raw`(?<![\d.])v?${escapeRe(bare)}(?![\d]|\.\d)`, "i");
  if (!own.test(passage)) {
    const seen = [...passage.matchAll(VERSION_TOKEN)].map((m) => m[1]);
    rules.push({
      rule: "version_token",
      ok: false,
      detail: seen.length ? `the passage names version ${[...new Set(seen)].join(", ")}, not ${version}` : `the passage does not name version ${version}`,
    });
    return rules;
  }
  rules.push({ rule: "version_token", ok: true, detail: `the passage contains the whole token ${version}` });

  const names = ctx.subjectNames ?? [];
  if (names.length > 0) {
    const m = own.exec(passage);
    const at = m?.index ?? 0;
    const near = passage.slice(Math.max(0, at - 60), at + bare.length + 10);
    const key = buildKey(near).key.toLowerCase();
    const adjacent = names.some((n) => key.includes(buildKey(n).key.toLowerCase()));
    const hasWord = /\b(?:version|ver\.?|release|v)\s*$/i.test(passage.slice(Math.max(0, at - 12), at + (passage[at] === "v" || passage[at] === "V" ? 1 : 0)));
    rules.push(
      adjacent || hasWord
        ? { rule: "version_adjacent_to_product", ok: true, detail: adjacent ? "a product name sits next to the version" : "the word 'version' sits next to it" }
        : { rule: "version_adjacent_to_product", ok: null, detail: "the version is not tied to the product name in this passage" },
    );
  }
  return rules;
}

// ------------------------------------------------------------------------------------------- count rules

const NUMBER_WORDS: Record<number, string> = {
  1: "one", 2: "two", 3: "three", 4: "four", 5: "five", 6: "six", 7: "seven", 8: "eight", 9: "nine", 10: "ten",
  11: "eleven", 12: "twelve", 13: "thirteen", 14: "fourteen", 15: "fifteen", 16: "sixteen", 17: "seventeen", 18: "eighteen",
  19: "nineteen", 20: "twenty",
};

export const COUNT_STOP = new Set([
  "at", "in", "from", "of", "for", "were", "was", "are", "is", "with", "by", "to", "that", "which", "who",
  "whom", "than", "during", "into", "on", "as", "had", "have", "has", "been", "be", "after", "before", "per",
]);

/**
 * The unit words that follow each occurrence of a number, reading on only through adjectives and short bracketed
 * words and stopping at the first function word: "11 US study sites that included" gives [study, sites].
 */
export function unitsAfterNumber(passage: string, numberTexts: string[]): string[][] {
  const out: string[][] = [];
  for (const t of new Set(numberTexts)) {
    const re = new RegExp(String.raw`(?<![\d.,])${escapeRe(t)}(?![\d]|,\d|\.\d)`, "g");
    for (const m of passage.matchAll(re)) {
      const rest = passage.slice((m.index as number) + t.length, (m.index as number) + t.length + 140);
      const units: string[] = [];
      const tok = /^(\s+)([A-Za-z\u00C0-\u024F][\w/-]*|\([A-Za-z]{1,8}\))/;
      let cursor = rest;
      for (let i = 0; i < 8; i++) {
        const mm = tok.exec(cursor);
        if (!mm) break;
        const word = (mm[2] as string).replace(/[()]/g, "").toLowerCase();
        if (COUNT_STOP.has(word)) break;
        if (UNIT_CLASSES[word] !== undefined) units.push(word);
        cursor = cursor.slice(mm[0].length);
      }
      out.push(units);
    }
  }
  return out;
}

function countRules(passage: string, claim: SupportClaim): RuleOutcome[] {
  if (typeof claim.value !== "number") return [];
  const rules: RuleOutcome[] = [];
  const asText = claim.value >= 1000 ? new Intl.NumberFormat("en-US").format(claim.value) : String(claim.value);
  const windows = unitsAfterNumber(passage, [asText, String(claim.value), ...(NUMBER_WORDS[claim.value] ? [NUMBER_WORDS[claim.value] as string] : [])]);
  if (windows.length === 0) {
    rules.push({ rule: "count_unit", ok: null, detail: `${asText} does not appear as a whole number in the passage` });
    return rules;
  }
  const want = unitClass(claim.unit);
  if (want === undefined) {
    rules.push({ rule: "count_unit", ok: null, detail: "the assertion names no unit, so the counted thing is not established" });
  } else if (windows.some((w) => w.some((u) => unitClass(u) === want))) {
    rules.push({ rule: "count_unit", ok: true, detail: `${asText} is counted in ${claim.unit}` });
  } else {
    const seen = [...new Set(windows.flat())];
    rules.push({
      rule: "count_unit",
      ok: seen.length === 0 ? null : false,
      detail: seen.length === 0 ? `${asText} is not followed by a counted unit` : `${asText} counts ${seen.join(", ")}, not ${claim.unit}`,
    });
  }
  const dev = DEVELOPMENT.test(passage);
  const claimsDev = claim.predicate.startsWith("development.");
  if (dev && !claimsDev) rules.push({ rule: "development_context", ok: false, detail: "the count sits in a training or development context" });
  if (!dev && claimsDev) rules.push({ rule: "development_context", ok: null, detail: "no training or development cue near the count" });
  return rules;
}

// --------------------------------------------------------------------------------------------- age rules

function ageRules(passage: string, claim: SupportClaim): RuleOutcome[] {
  if (typeof claim.value !== "number") return [];
  const kind = claim.predicate === "population.age_min" ? "min" : "max";
  const bounds = parseAgeBounds(passage);
  // a strict bound ("older than 22") is held one year inward (23); the passage states 22, so either number matches
  const effective = (b: (typeof bounds)[number]) => (b.exclusive ? (b.kind === "min" ? b.years + 1 : b.years - 1) : b.years);
  const same = bounds.filter((b) => b.years === claim.value || effective(b) === claim.value);
  if (same.length === 0) {
    const mentions = numericTokens(passage).includes(String(claim.value));
    return [
      {
        rule: "age_direction",
        ok: mentions ? false : null,
        detail: mentions ? `${claim.value} appears but not as an age limit` : `no age limit of ${claim.value} could be read from the passage`,
      },
    ];
  }
  if (same.some((b) => b.kind === kind)) {
    return [{ rule: "age_direction", ok: true, detail: `the passage sets a ${kind}imum age of ${claim.value}` }];
  }
  return [
    {
      rule: "age_direction",
      ok: false,
      detail: `the passage uses ${claim.value} as a ${same[0]?.kind === "min" ? "min" : "max"}imum age ("${same[0]?.phrase}"), not a ${kind}imum`,
    },
  ];
}

// ------------------------------------------------------------------------------------------ main entry

/**
 * Deterministic semantic support for one assertion against its quoted passage.
 */
export function assessSupport(passage: string, claim: SupportClaim, ctx: SupportContext = {}): SupportReport["deterministic"] {
  const rules: RuleOutcome[] = [];
  const flags: string[] = [];
  const p = claim.predicate;

  const m = metricOf(p);
  if (m) {
    const r = resultRules(passage, claim, ctx);
    rules.push(...r.rules);
    flags.push(...r.flags);
  } else if (p === "device.version") {
    rules.push(...versionRules(passage, String(claim.value), ctx));
    const q = claim.detail?.qualifiers ?? [];
    if (q.includes("predicate_block")) rules.push({ rule: "predicate_context", ok: false, detail: "the version is stated for the predicate device, not the subject" });
    if (q.includes("comparison_table")) rules.push({ rule: "comparison_table", ok: null, detail: "the version sits in a subject and predicate table and its column is not established" });
    const subj = subjectRule(passage, ctx);
    if (subj) rules.push(subj);
  } else if (p === "population.age_min" || p === "population.age_max") {
    rules.push(...ageRules(passage, claim));
    const subj = subjectRule(passage, ctx);
    if (subj) rules.push(subj);
  } else if (/^(study|development)\.(sample_size|site_count)$/.test(p)) {
    rules.push(...countRules(passage, claim));
    const subj = subjectRule(passage, ctx);
    if (subj) rules.push(subj);
  } else if (p === "document.cites_nct") {
    const id = String(claim.value);
    const ok = new RegExp(String.raw`(?<![A-Z0-9])${escapeRe(id)}(?!\d)`).test(passage);
    rules.push({ rule: "identifier_token", ok, detail: ok ? `${id} appears as a whole token` : `${id} does not appear as a whole token` });
  } else if (p === "study.clinical_tests") {
    const negated = /\b(?:clinical|human)\s+(?:tests?|testing|stud(?:y|ies)|data)\b[^.]{0,60}\b(?:not|no)\b[^.]{0,30}\b(?:conducted|required|performed|needed|provided)\b|\bno\s+clinical\s+(?:tests?|testing|stud(?:y|ies)|data)\b/i.test(passage);
    const wants = String(claim.value) === "not_conducted";
    rules.push({
      rule: "clinical_tests_statement",
      ok: wants ? negated : !negated,
      detail: negated ? "the passage says clinical testing was not conducted or not required" : "the passage does not say that clinical testing was not conducted",
    });
  } else if (p === "indication.purpose_exclusion") {
    const found = diagnosticExclusion(passage);
    const wants = claim.detail?.qualifiers?.includes("qualified") ? "qualified" : "absolute";
    rules.push({
      rule: "purpose_exclusion",
      ok: found === wants,
      detail: found === undefined ? "the passage does not exclude diagnostic use" : found === wants ? `the passage excludes diagnostic use (${found})` : `the passage excludes diagnostic use as ${found}, not ${wants}`,
    });
    const subj = subjectRule(passage, ctx);
    if (subj) rules.push(subj);
  } else if (TERM_PREDICATES[p] && typeof claim.value === "string") {
    const entry = TERM_PREDICATES[p]?.find(([term]) => term === claim.value);
    const ok = entry ? entry[1].test(passage) : buildKey(passage).key.toLowerCase().includes(buildKey(String(claim.value)).key.toLowerCase());
    rules.push({ rule: "term_present", ok: ok ? true : false, detail: ok ? `the passage uses the term "${claim.value}"` : `the passage does not use the term "${claim.value}"` });
    const subj = subjectRule(passage, ctx);
    if (subj) rules.push(subj);
  } else if (p === "authorization.letter_date" && typeof claim.value === "string") {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(claim.value);
    const months = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
    const month = m ? months[Number(m[2]) - 1] : undefined;
    const ok = !!m && !!month && new RegExp(String.raw`${month}\s+0?${Number(m[3])},\s+${m[1]}`, "i").test(passage);
    rules.push({ rule: "date_text", ok, detail: ok ? "the passage prints this date" : "the passage does not print this date" });
  } else if (p === "study.device_mix" && typeof claim.value === "string") {
    const m = /^(.+?)\s+(\d{1,3}(?:\.\d+)?)%$/.exec(claim.value);
    const ok = !!m && new RegExp(String.raw`(?<![\d.])${escapeRe(m[2] as string)}\s?%\s+${escapeRe(m[1] as string)}\b`).test(passage);
    rules.push({ rule: "share_text", ok, detail: ok ? "the passage shows this share for this vendor" : "the passage does not show this share for this vendor" });
  } else if (typeof claim.value === "string" && claim.value.length > 0) {
    const have = buildKey(passage).key.toLowerCase();
    const want = buildKey(claim.value).key.toLowerCase();
    rules.push(
      have.includes(want)
        ? { rule: "text_contained", ok: true, detail: "the asserted text appears in the passage" }
        : { rule: "text_contained", ok: null, detail: "the asserted text is not contained in the passage as written" },
    );
    const subj = subjectRule(passage, ctx);
    if (subj) rules.push(subj);
  } else {
    rules.push({ rule: "no_rule", ok: null, detail: `no deterministic rule covers predicate ${p}` });
  }

  // A passage that talks about a predicate or reference device may describe that product's numbers, not the subject's.
  if (/^(study|development)\./.test(p)) {
    const pc = predicateContext(passage, ctx);
    if (pc) rules.push(pc);
  }

  if (claim.appliesToVersion && p !== "device.version") {
    const vr = versionRules(passage, claim.appliesToVersion, ctx);
    // A result passage usually does not name the version; only a wrong version is a failure here.
    for (const r of vr) {
      if (r.rule === "version_token" && r.ok === false && !/names version/.test(r.detail)) {
        rules.push({ rule: "version_token", ok: null, detail: "the passage does not name the version the result is said to apply to" });
      } else rules.push(r);
    }
  }
  return decide(rules, flags);
}

// --------------------------------------------------------------------------------------- structured fields

/**
 * Support for an assertion read from a typed field of a structured record. The passage is the field's own text, so
 * the question is only whether the asserted value is what that field says, not what a sentence means.
 */
export function assessStructuredSupport(passage: string, claim: SupportClaim): SupportReport["deterministic"] {
  const rules: RuleOutcome[] = [];
  const text = passage.trim();
  const v = claim.value;
  if (claim.predicate === "population.age_min" || claim.predicate === "population.age_max") {
    const years = parseRegistryAge(text);
    const ok = years !== undefined && typeof v === "number" && Math.abs(years - v) < 1e-3;
    rules.push({ rule: "structured_field", ok, detail: ok ? `the field reads ${text}` : `the field "${text}" does not give ${String(v)} years` });
  } else if (typeof v === "number" && claim.detail?.qualifiers?.includes("count_of_lines")) {
    // a count of the entries listed in the field (one per line), not a number written in it
    const lines = text.split("\n").filter((l) => l.trim().length > 0).length;
    rules.push({ rule: "structured_field", ok: lines === v, detail: lines === v ? `the field lists ${lines} entries` : `the field lists ${lines} entries, not ${v}` });
  } else if (typeof v === "number") {
    const ok = numericTokens(text).some((t) => Math.abs(parseNumberToken(t) - v) < 1e-9);
    rules.push({ rule: "structured_field", ok, detail: ok ? `the field holds ${v}` : `the field "${text.slice(0, 60)}" does not hold ${v}` });
  } else if (typeof v === "boolean") {
    const truthy = /^(?:y|yes|true)$/i.test(text);
    const falsy = /^(?:n|no|false)$/i.test(text);
    const ok = (v && truthy) || (!v && falsy);
    rules.push({ rule: "structured_field", ok, detail: ok ? `the field reads ${text}` : `the field "${text}" does not read ${String(v)}` });
  } else if (Array.isArray(v)) {
    const have = buildKey(text).key.toLowerCase();
    const missing = v.filter((x) => !have.includes(buildKey(x).key.toLowerCase()));
    rules.push({ rule: "structured_field", ok: missing.length === 0, detail: missing.length === 0 ? "every listed item is in the field" : `not in the field: ${missing.join(", ")}` });
  } else if (typeof v === "string" && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(v)) {
    // a date held as parts or as text: 2021-Nov-01 and 2021-11-01 are the same day
    const months = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const parts = text.split(/[-\s/]+/).filter(Boolean).map((p, i) => {
      if (i === 0) return p;
      const m = months.indexOf(p.slice(0, 3).toLowerCase());
      return m >= 0 && !/^\d+$/.test(p) ? String(m + 1).padStart(2, "0") : p.padStart(2, "0");
    });
    const ok = parts.join("-") === v;
    rules.push({ rule: "structured_field", ok, detail: ok ? `the field reads ${text}` : `the field "${text}" is not the date ${v}` });
  } else {
    const have = buildKey(text).key.toLowerCase();
    const want = buildKey(String(v)).key.toLowerCase();
    const ok = have === want || have.includes(want);
    rules.push({ rule: "structured_field", ok, detail: ok ? "the field holds this text" : "the field does not hold this text" });
  }
  return decide(rules, []);
}
