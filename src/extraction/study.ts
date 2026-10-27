/**
 * Study-sentence extraction shared by every free-text source (FDA summaries, journal abstracts, registry
 * descriptions): study design, sample sizes, site counts, vendor mix, registered identifiers, statements that no
 * clinical testing was done, and performance statements with their kind and qualifiers.
 *
 * It works on any DocumentText. For an FDA PDF the "pages" are pages; for a registry record or an abstract they are
 * fields, and anchors then carry a JSON path instead of a page.
 */
import { pageSpans } from "./document.ts";
import { parseAgeBounds } from "./age.ts";
import { DEVELOPMENT } from "./lexicon.ts";
import { sectionAt, type Section } from "./sections.ts";
import { scanStatements, type StatBinding } from "./stats.ts";
import { COUNT_STOP, unitClass } from "./support.ts";
import { COUNT_WORD_PATTERN, parseCount, type Span } from "./text.ts";
import type { DocumentText, NumberClaim, PageText, ProposedAssertion } from "./types.ts";

export const STUDY_CUE = /\b(study|trial|enrolled|enrol(?:l)?ment|collected|obtained|retrospective|prospective|dataset|data\s+set|test\s+set|testing|evaluat\w+|analy[sz]ed|included|consisted|cohort|validation|pivotal|cases)\b/i;
const UNIT_WORDS = [
  "patients",
  "subjects",
  "participants",
  "individuals",
  "women",
  "cases",
  "exams",
  "studies",
  "images",
  "scans",
  "radiographs",
  "slides",
  "mammograms",
  "encounters",
  "WSIs",
  "specimens",
  "biopsies",
  "records",
  "ECGs",
  "videos",
  "eyes",
  "sites",
  "centers",
  "centres",
  "institutions",
  "hospitals",
  "facilities",
  "practices",
  "clinics",
].join("|");
const COUNT_RE = new RegExp(
  String.raw`(?<![\d.,%/])(\d{1,3}(?:,\d{3})+|\d+|${COUNT_WORD_PATTERN})\s+((?:(?:[A-Za-z][\w/-]*|\([A-Za-z]{1,6}\))\s+){0,5}?)(${UNIT_WORDS})\b`,
  "gi",
);
const VENDOR_RE = /(\d{1,3}(?:\.\d+)?)\s?%\s+(GE|Siemens|Philips|Toshiba|Canon|Hologic|Fujifilm|Fuji|Topcon|Zeiss|Terason|Olympus|Pentax|Fujinon|Samsung|Carestream|Agfa|Konica|Epson|Nidek|Optos|Medtronic)\b/g;
export const STANDARD_CONTEXT = /\b(IEC|ISO|ANSI|AAMI|DICOM|HL7|UL\s?\d|CFR|guidance|standard|OMB)\b/i;


export interface Builder {
  /** Restrict extraction to some pages (fields) of the document, for a document that holds several records. */
  pageFilter?: (page: number) => boolean;
  doc: DocumentText;
  sections: Section[];
  subjectId: string;
  proposals: ProposedAssertion[];
  seen: Set<string>;
}

export function spansOf(page: PageText): Span[] {
  return pageSpans(page);
}

export function spanContaining(spans: Span[], offset: number): Span | undefined {
  return spans.find((s) => offset >= s.start && offset < s.end);
}

export function add(b: Builder, page: PageText, span: Span, partial: Omit<ProposedAssertion, "subjectId" | "quote" | "page" | "extractionMethod" | "assertionType"> & {
  assertionType?: ProposedAssertion["assertionType"];
}, salt = ""): void {
  const quote = page.text.slice(span.start, span.end);
  const key = `${page.page}:${span.start}:${partial.predicate}:${JSON.stringify(partial.value)}:${partial.unit ?? ""}:${salt}`;
  if (b.seen.has(key)) return;
  b.seen.add(key);
  const section = sectionAt(b.sections, page.page, span.start);
  const label = b.doc.fieldLabels?.[page.page - 1];
  const where = label || section?.title;
  const detail = { ...(partial.detail ?? {}), ...(where ? { section: where } : {}) };
  b.proposals.push({
    subjectId: b.subjectId,
    quote,
    page: page.page,
    extractionMethod: "pattern",
    assertionType: partial.assertionType ?? "study",
    ...partial,
    detail,
  });
}


export function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}


// -------------------------------------------------------------------------------------- study and results

export function extractStudy(b: Builder, counters: { unbound: number; unresolvedRows: number }): void {
  // PPA and NPA are read as agreement metrics only in a document that spells the term out
  const spellsOutAgreement = /positive\s+percent\s+agreement/i.test(b.doc.text);
  for (const page of b.doc.pages) {
    if (page.textLayer === "absent") continue;
    if (b.pageFilter && !b.pageFilter(page.page)) continue;
    const spans = spansOf(page);
    for (const span of spans) {
      const sentence = page.text.slice(span.start, span.end);
      const section = sectionAt(b.sections, page.page, span.start);
      const inIfu = section?.kind === "indications" && !STUDY_CUE.test(sentence);
      // in a journal abstract every sentence is about the study; elsewhere a cue word is needed
      const cue = STUDY_CUE.test(sentence) || b.doc.origin === "fields" || section?.kind === "performance" || section?.kind === "clinical";
      const isPredicateSentence = /\bpredicate\b/i.test(sentence);

      // identifiers of registered studies
      for (const m of sentence.matchAll(/(?<![A-Z0-9])(NCT\d{8})(?!\d)/g)) {
        add(b, page, span, { predicate: "document.cites_nct", value: m[1] as string, assertionType: "study" });
      }

      // statements that no clinical testing was done
      if (
        /\b(?:clinical|human)\s+(?:tests?|testing|stud(?:y|ies)|data)\b[^.]{0,60}\b(?:not|no)\b[^.]{0,30}\b(?:conducted|required|performed|needed|provided)\b|\bno\s+clinical\s+(?:tests?|testing|stud(?:y|ies)|data)\b/i.test(
          sentence,
        )
      ) {
        add(b, page, span, { predicate: "study.clinical_tests", value: "not_conducted", assertionType: "study" });
      }

      if (inIfu) continue;

      // age limits written for the study population ("aged 18 years or older"); an observed spread is not a limit
      // Not an eligibility limit: an observed spread, a subgroup finding, or a demographic breakdown.
      const notALimit = /\b(?:median|mean\s+age|average|range|ranged|observed|significant\w*|effects?|subgroups?|ratio|odds|higher|lower|incidence|prevalence)\b|\d\s?%|p\s*[=<]|\d?\.\d{3}\b|\bby\s+age\b/i;
      if (cue && !isPredicateSentence && !notALimit.test(sentence)) {
        for (const bound of parseAgeBounds(sentence)) {
          const years = bound.exclusive ? (bound.kind === "min" ? bound.years + 1 : bound.years - 1) : bound.years;
          add(b, page, span, {
            predicate: bound.kind === "min" ? "population.age_min" : "population.age_max",
            value: years,
            unit: "years",
            assertionType: "study",
            numbers: [{ value: bound.years, form: "raw" }],
            detail: { qualifiers: ["study_population_text", ...(bound.fromExclusion ? ["from_exclusion"] : [])] },
          });
        }
      }

      // study design
      if (cue && !isPredicateSentence) {
        for (const design of ["retrospective", "prospective"] as const) {
          if (new RegExp(`\\b${design}(?:ly)?\\b`, "i").test(sentence) && !/\bretrospective\s+power\b/i.test(sentence) && !DEVELOPMENT.test(sentence)) {
            add(b, page, span, { predicate: "study.design", value: design, assertionType: "study" });
          }
        }
      }

      // counts: sample sizes and site counts
      if (cue) {
        COUNT_RE.lastIndex = 0;
        for (const m of sentence.matchAll(COUNT_RE)) {
          const n = parseCount(m[1] as string);
          const unit = (m[3] as string).toLowerCase();
          if (n === undefined) continue;
          // adjectives may sit between the number and the unit; a function word means the number counts something else
          if (String(m[2] ?? "").toLowerCase().split(/\s+/).some((w) => COUNT_STOP.has(w.replace(/[()]/g, "")))) continue;
          const cls = unitClass(unit);
          if (cls === undefined) continue;
          if (cls === "site") {
            add(b, page, span, { predicate: "study.site_count", value: n, unit, assertionType: "study", numbers: [{ value: n, form: "count" }] });
          } else if (n >= 10) {
            const dev = DEVELOPMENT.test(sentence);
            add(b, page, span, {
              predicate: dev ? "development.sample_size" : "study.sample_size",
              value: n,
              unit,
              assertionType: "study",
              numbers: [{ value: n, form: "count" }],
            });
          }
        }
        VENDOR_RE.lastIndex = 0;
        for (const m of sentence.matchAll(VENDOR_RE)) {
          add(b, page, span, { predicate: "study.device_mix", value: `${m[2]} ${m[1]}%`, assertionType: "study", numbers: [{ value: Number(m[1]), form: "raw" }] });
        }
      }

      // performance statements
      const scan = scanStatements(sentence, { prose: b.doc.origin === "fields", agreementAcronyms: spellsOutAgreement });
      counters.unbound += scan.unbound.length;
      if (/\S {3,}\S/.test(sentence) && scan.bindings.some((x) => x.qualifiers.includes("multi_value_row"))) counters.unresolvedRows++;
      for (const binding of scan.bindings) addBinding(b, page, span, sentence, binding);
    }
  }
}

function addBinding(b: Builder, page: PageText, span: Span, sentence: string, binding: StatBinding): void {
  // A table row with several values across columns cannot be attributed to a subgroup without its header: not extracted.
  if (binding.qualifiers.includes("multi_value_row")) return;
  const numbers: NumberClaim[] = [{ value: binding.value, form: binding.form }];
  if (binding.ci) {
    numbers.push({ value: binding.ci[0], form: binding.form }, { value: binding.ci[1], form: binding.form });
  }
  let quoteSpan = span;
  if (span.end - span.start > 900) {
    quoteSpan = { start: Math.max(span.start, span.start + binding.quoteStart - 200), end: Math.min(span.end, span.start + binding.quoteEnd + 120) };
  }
  const qualifiers = [...binding.qualifiers];
  // A page that lays the proposed and the predicate device side by side: a number there may belong to either column.
  if (pageComparesDevices(page.text)) qualifiers.push("comparison_table");
  // "For 2D, the sensitivity is ..." / "In DBT, ...": the result belongs to the named condition, not to the whole study
  const lead = /^\s*(?:For|In|Among|On)\s+([^,]{1,30}),/.exec(sentence);
  if (lead && binding.valueStart > (lead[0] as string).length && !/\b(?:study|trial|analysis|dataset|cohort|summary|validation|testing)\b/i.test(lead[1] as string)) {
    qualifiers.push(`context:${collapse(lead[1] as string)}`);
  }
  // "... 0.945 (0.935-0.954) for 2D and ..." / "... 95.7% specificity for pleural effusion.": the condition after the value
  const GENERIC = /^(?:the|each|both|all|detect|identif|screen|use|this|that|these|those|a|an|any|every|our|its)\b/i;
  const after = sentence.slice(binding.quoteEnd);
  const direct = /^\s*,?\s*for\s+([A-Za-z0-9][\w -]{1,30}?)(?=\s+and\b|\s*[.,;:)]|\s*$)/i.exec(after);
  const trailing = /\bfor\s+([A-Za-z][A-Za-z -]{2,40}?)\s*[.;]?\s*$/i.exec(sentence.trimEnd());
  const named = direct?.[1] ?? (trailing && (trailing.index as number) > binding.valueStart ? trailing[1] : undefined);
  if (named && !GENERIC.test(named.trim())) qualifiers.push(`context:${collapse(named)}`);
  const operatingPoint =
    /\bat\s+(\d+(?:\.\d+)?\s*FP\s*\/\s*\w+)/i.exec(sentence)?.[1] ??
    /\b(?:threshold|operating\s+point|cut-?off)\s+(?:of|at|was|is|=|:)\s*([\d.]+\s?[A-Za-z%]{0,4})/i.exec(sentence)?.[1];
  add(
    b,
    page,
    quoteSpan,
    {
      predicate: `${binding.kind === "goal" ? "performance_goal" : "result"}.${binding.metric}`,
      value: binding.value,
      unit: "proportion",
      assertionType: "study",
      numbers,
      detail: {
        metric: binding.metric,
        ...(binding.ci ? { ci: binding.ci } : {}),
        ...(binding.denominator !== undefined ? { n: binding.denominator } : {}),
        ...(operatingPoint ? { operatingPoint: collapse(operatingPoint) } : {}),
        qualifiers,
      },
    },
    String(span.start + binding.valueStart),
  );
}


const WORKSTATION_SOFTWARE = /\b(?:Windows|Office|Chrome|Python|Java|Linux)\b/i;
const VERSION_A = /\b(?:software\s+)?(?:version|ver\.?|release)\s*(?:of\s+)?(?:[A-Za-z][\w.-]*\s+){0,3}?v?(\d+\.\d+(?:\.\d+){0,3})\b/gi;
const VERSION_B = /\bv(\d+\.\d+(?:\.\d+){1,3})\b/g;

/**
 * Version strings written in the text: "version 2.1.0", "Software v2.1.501". A number that sits beside a standard,
 * a guidance or a third-party product ("IEC 62304 version 2.0", "Windows version 10") is not the device's version.
 * Nothing is inferred: no version written means no assertion.
 */
export function extractVersionStrings(b: Builder, assertionType: ProposedAssertion["assertionType"]): void {
  for (const page of b.doc.pages) {
    if (b.pageFilter && !b.pageFilter(page.page)) continue;
    const comparing = pageComparesDevices(page.text);
    for (const span of spansOf(page)) {
      const sentence = page.text.slice(span.start, span.end);
      const seen: { token: string; at: number; re: RegExp }[] = [];
      for (const re of [VERSION_A, VERSION_B]) {
        re.lastIndex = 0;
        for (const m of sentence.matchAll(re)) {
          const at = m.index as number;
          const around = sentence.slice(Math.max(0, at - 40), at + m[0].length + 40);
          if (STANDARD_CONTEXT.test(around)) continue;
          if (WORKSTATION_SOFTWARE.test(around)) continue;
          seen.push({ token: m[1] as string, at, re });
        }
      }
      seen.sort((x, y) => x.at - y.at);
      seen.forEach((v, i) => {
        const qualifiers: string[] = [];
        const absolute = span.start + v.at;
        // a version in the block that describes the predicate device is the predicate's
        if (/\bPredicate\b/i.test(page.text.slice(Math.max(0, absolute - 260), absolute)) && !comparing) qualifiers.push("predicate_block");
        if (comparing) {
          // in a Subject | Predicate table the first column is the subject's; with one token the column is unknown
          const columns = /\S {3,}\S/.test(sentence) && seen.length >= 2;
          qualifiers.push(columns ? (i === 0 ? "comparison_first_column" : "predicate_block") : "comparison_table");
        }
        add(b, page, span, { predicate: "device.version", value: v.token, assertionType, ...(qualifiers.length ? { detail: { qualifiers } } : {}) });
      });
    }
  }
}

/** A page that sets the subject (proposed) device and the predicate side by side in a table. */
export function pageComparesDevices(pageText: string): boolean {
  return /\b(?:Proposed|Subject) Device\b/.test(pageText) && /\bPredicate\b/.test(pageText);
}
