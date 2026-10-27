/**
 * Turns verified assertions into the EvidenceItem / Scope shape the Applicability Compiler reads.
 *
 * Rules that keep the conversion honest:
 *  - only assertions that passed BOTH checks are used (UNCHECKED is not support) unless the caller opts in;
 *  - a field with no assertion stays unspecified in the scope; nothing is defaulted;
 *  - headline results are observed, unqualified figures; a goal, a subgroup, an enrichment-corrected, worst-case,
 *    development-set, reader-arm, difference or unresolved-table figure never becomes a headline result, and is
 *    listed as a limitation so the reviewer can see it was reported;
 *  - values are proportions between 0 and 1 (87.8% is 0.878), the unit of ClaimedPerformance.atLeast.
 */
import { EvidenceItemSchema, type EvidenceItem, type EvidenceResult } from "../schemas/scope.ts";
import type { Scope } from "../schemas/scope.ts";
import { hashOf } from "../util/canonical.ts";
import { isUsable } from "./verify.ts";
import type { CheckedAssertion } from "./types.ts";

export interface ConversionOptions {
  /** Accept assertions whose semantic check could not decide. Off by default. */
  includeUnchecked?: boolean;
  /** Fields the parser searched for and did not find, for example from FdaSummaryExtraction.fields. */
  absentFields?: string[];
  /**
   * Give a study item the version strings written elsewhere in the SAME document. Off by default: a summary names the
   * version in its device name or software section, but the sentence that reports a result usually does not, so the
   * link from a result to a version is an inference. When on, the inference is stated in the item's limitations.
   */
  versionsFromSameDocument?: boolean;
}

export interface ConversionNote {
  subjectId: string;
  kind: "conflict" | "excluded_result" | "partial_date_dropped" | "unmapped";
  message: string;
}

const NON_HEADLINE = new Set([
  "enrichment_corrected",
  "worst_case",
  "subgroup",
  "development_set",
  "reader_arm",
  "difference",
  "table_row",
  "multi_value_row",
  "ci_inconsistent",
  "comparison_table",
  "predicate_value",
]);

const PURPOSE_ORDER = ["triage", "prioritization", "notification", "detection", "screening", "concurrent reading aid", "diagnostic aid", "guidance"];
const FULL_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Qualifiers that stop a result from being the device's overall observed figure. */
export function blockingQualifiers(a: CheckedAssertion): string[] {
  return quals(a).filter((x) => NON_HEADLINE.has(x) || x.startsWith("context:"));
}

/** A result a reviewer could take as the device's overall observed figure: observed, both checks passed, no blocking qualifier. */
export function isHeadlineResult(a: CheckedAssertion): boolean {
  return /^result\./.test(a.assertion.predicate) && isUsable(a) && blockingQualifiers(a).length === 0;
}

function quals(a: CheckedAssertion): string[] {
  return a.detail.qualifiers ?? [];
}

function distinct<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

interface Group {
  subjectId: string;
  type: CheckedAssertion["assertion"]["assertionType"];
  rows: CheckedAssertion[];
}

export function toEvidenceItems(kept: CheckedAssertion[], options: ConversionOptions = {}): { items: EvidenceItem[]; notes: ConversionNote[] } {
  const usable = kept.filter((k) => (options.includeUnchecked ? k.assertion.quoteVerified && k.assertion.supportVerified !== "FAIL" : isUsable(k)));
  const groups = new Map<string, Group>();
  for (const k of usable) {
    const key = `${k.assertion.subjectId}|${k.assertion.assertionType}`;
    const g = groups.get(key) ?? { subjectId: k.assertion.subjectId, type: k.assertion.assertionType, rows: [] };
    g.rows.push(k);
    groups.set(key, g);
  }

  const items: EvidenceItem[] = [];
  const notes: ConversionNote[] = [];

  for (const g of groups.values()) {
    const rows = g.rows;
    const by = (predicate: string) => rows.filter((r) => r.assertion.predicate === predicate);
    const scope: Scope = {};
    const used = new Set<string>();
    const use = (r: CheckedAssertion) => used.add(r.anchor.id);

    if (g.subjectId.startsWith("device:")) scope.product = g.subjectId;

    const versions = distinct(by("device.version").map((r) => (use(r), String(r.assertion.value))));
    const inherited =
      versions.length === 0 && options.versionsFromSameDocument === true && g.type === "study"
        ? distinct(usable.filter((r) => r.assertion.subjectId === g.subjectId && r.assertion.predicate === "device.version").map((r) => String(r.assertion.value)))
        : [];
    if (versions.length > 0) scope.versions = versions;
    else if (inherited.length > 0) scope.versions = inherited;

    // population: the narrowest bounds the evidence states
    const population: NonNullable<Scope["population"]> = {};
    const age: { min?: number; max?: number } = {};
    for (const [pred, key] of [["population.age_min", "min"], ["population.age_max", "max"]] as const) {
      const vals = by(pred).map((r) => ({ v: Number(r.assertion.value), r }));
      if (vals.length === 0) continue;
      const pick = key === "min" ? Math.max(...vals.map((x) => x.v)) : Math.min(...vals.map((x) => x.v));
      if (distinct(vals.map((x) => x.v)).length > 1) {
        notes.push({ subjectId: g.subjectId, kind: "conflict", message: `${pred} states ${distinct(vals.map((x) => x.v)).join(" and ")}; the narrower ${pick} is used` });
      }
      age[key] = pick;
      vals.forEach((x) => use(x.r));
    }
    if (age.min !== undefined || age.max !== undefined) population.age = age;
    const conditions = distinct(by("population.condition").map((r) => (use(r), String(r.assertion.value))));
    if (conditions.length) population.conditions = conditions;
    const exclusions = distinct(by("population.exclusion_criterion").map((r) => (use(r), String(r.assertion.value))));
    if (exclusions.length) population.exclusions = exclusions;
    if (Object.keys(population).length) scope.population = population;

    const settings = distinct(by("indication.setting_term").map((r) => (use(r), String(r.assertion.value))));
    if (settings.length) scope.settings = settings;

    const purposes = by("indication.purpose_term");
    if (purposes.length) {
      const terms = distinct(purposes.map((r) => String(r.assertion.value)));
      purposes.forEach(use);
      const ordered = [...PURPOSE_ORDER.filter((t) => terms.includes(t)), ...terms.filter((t) => !PURPOSE_ORDER.includes(t))];
      scope.purpose = ordered.map((t) => t.replace(/\s+/g, "_")).join("_");
    }

    // timing: a full date only; "2018-07" is not padded into a day that was never stated
    const dateRows = [...by("authorization.decision_date"), ...by("authorization.letter_date"), ...by("study.start_date")];
    const full = dateRows.filter((r) => FULL_DATE.test(String(r.assertion.value)));
    for (const r of dateRows) {
      if (!FULL_DATE.test(String(r.assertion.value))) {
        notes.push({ subjectId: g.subjectId, kind: "partial_date_dropped", message: `${r.assertion.predicate} "${String(r.assertion.value)}" has no day and is left out of timing` });
      }
    }
    if (full.length) {
      const pickDate = g.type === "authorization" ? full.find((r) => r.assertion.predicate === "authorization.decision_date") ?? full[0] : full.find((r) => r.assertion.predicate === "study.start_date") ?? full[0];
      if (pickDate) {
        scope.timing = { from: String(pickDate.assertion.value) };
        use(pickDate);
      }
    }

    // results
    const results: EvidenceResult[] = [];
    const limitations: string[] = [];
    for (const r of rows.filter((x) => /^result\./.test(x.assertion.predicate))) {
      const q = quals(r);
      const blocking = blockingQualifiers(r);
      const metric = r.assertion.predicate.slice("result.".length);
      const value = Number(r.assertion.value);
      if (blocking.length > 0) {
        const msg = `${metric} ${value} is reported for a narrower or different analysis (${blocking.join(", ")}) and is not used as the headline result`;
        limitations.push(msg);
        notes.push({ subjectId: g.subjectId, kind: "excluded_result", message: msg });
        use(r);
        continue;
      }
      const res: EvidenceResult = { metric, value, anchorId: r.anchor.id };
      if (r.detail.ci) res.ci = r.detail.ci;
      if (r.detail.n !== undefined && Number.isInteger(r.detail.n)) res.n = r.detail.n;
      if (r.detail.operatingPoint) res.operatingPoint = r.detail.operatingPoint;
      if (q.includes("redacted_context")) limitations.push(`a figure in the passage for ${metric} is redacted in the source`);
      results.push(res);
      use(r);
    }
    const opPoints = distinct(results.map((x) => x.operatingPoint).filter((x): x is string => !!x));
    if (opPoints.length === 1) scope.operatingPoint = opPoints[0] as string;

    for (const r of by("indication.limitation")) {
      limitations.push(String(r.assertion.value).replace(/\s+/g, " ").trim());
      use(r);
    }
    for (const r of by("study.clinical_tests")) {
      limitations.push("the source states that clinical testing was not conducted");
      use(r);
    }
    for (const r of by("study.design")) {
      limitations.push(`design: ${String(r.assertion.value)}`);
      use(r);
    }
    for (const r of by("study.sampling_method")) {
      limitations.push(`sampling method: ${String(r.assertion.value)}`);
      use(r);
    }
    if (inherited.length > 0 && versions.length === 0) {
      limitations.push(`version ${inherited.join(", ")} is named elsewhere in the same document; the passages that report these results do not name a version`);
    }
    if (g.type === "authorization" && options.absentFields?.includes("device.version") && versions.length === 0) {
      limitations.push("no software version is stated in the source");
    }

    if (Object.keys(scope).length === 0 && results.length === 0 && limitations.length === 0) {
      notes.push({ subjectId: g.subjectId, kind: "unmapped", message: `${rows.length} verified assertion(s) of type ${g.type} carry no scope, result or limitation` });
      continue;
    }

    const item: EvidenceItem = EvidenceItemSchema.parse({
      id: `ev_${hashOf({ s: g.subjectId, t: g.type }).slice(0, 16)}`,
      assertionType: g.type,
      scope,
      results,
      limitations: distinct(limitations),
      anchorIds: [...used],
    });
    items.push(item);
  }
  return { items, notes };
}
