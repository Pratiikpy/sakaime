/**
 * FDA decision-summary parser (De Novo decision summaries, 510(k) summaries and the clearance letter that precedes
 * them). Pure code, no model. It reads the page text of one document and produces typed assertion PROPOSALS, each
 * with the verbatim sentence it rests on, then runs both checks (quote-exists, semantic support) over them.
 *
 * What it will not do: default a missing field. A version that is not written stays absent, an age limit that is not
 * written stays open, a result in a table whose columns cannot be resolved stays unextracted and is counted.
 */
import { parseAgeBounds } from "./age.ts";
import { detectOcrDamage } from "./document.ts";
import { GROUP_TERMS, PURPOSE_TERMS, SETTING_TERMS } from "./lexicon.ts";
import { diagnosticExclusion, populationPhrases } from "./population.ts";
import { findSections, type Section } from "./sections.ts";
import { add, collapse, extractStudy, extractVersionStrings, pageComparesDevices, spanContaining, spansOf, type Builder } from "./study.ts";
import type { Span } from "./text.ts";
import type { DocumentText, ExtractionResult, PageText } from "./types.ts";
import { verifyProposals, type VerifyOptions } from "./verify.ts";

export interface FdaSummaryOptions {
  /** Defaults to device:fda:<K, DEN or P number found on the first pages>. */
  subjectId?: string;
  /** Extra names the device goes by, used by the subject checks. */
  subjectNames?: string[];
  /** Names that mark a passage as being about another product (predicate devices, sibling modules). */
  otherSubjectNames?: string[];
  verify?: Pick<VerifyOptions, "model">;
}

export type FieldStatus = "stated" | "absent";

export interface FdaSummaryExtraction {
  identifier?: string;
  subjectId: string;
  sections: Section[];
  extraction: ExtractionResult;
  /** For each field searched: stated (with the assertion ids) or absent. Never defaulted. */
  fields: Record<string, { status: FieldStatus; assertionIds: string[] }>;
  /** Performance values found but not bound to a metric with confidence, counted by reason. */
  unboundValues: number;
  /** Table rows with a metric label and several values, whose column headers were not resolved. */
  unresolvedTableRows: number;
  /** Pages with no text layer; nothing was read from them. */
  pagesWithoutText: number[];
  damage: { replacementChars: number; glyphSymbols: number; digitInWord: number };
  redactionMarks: number;
}

const IDENTIFIER = /\b(K\d{6}|DEN\d{6}|P\d{6})\b/;
const MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December";
const LETTER_DATE = new RegExp(String.raw`^\s*(${MONTHS})\s+(\d{1,2}),\s+(\d{4})\s*$`, "i");

const LIMITATION_CUE = /\b(?:not\s+(?:intended|indicated|for\s+use|to\s+be\s+used)|should\s+not\s+be\s+used|limited\s+to|only\s+for|is\s+not\s+for)\b/i;

const FIELDS = [
  "document.identifier",
  "device.name",
  "device.version",
  "authorization.letter_date",
  "indication.text",
  "population.age_min",
  "population.age_max",
  "population.group_term",
  "indication.setting_term",
  "indication.purpose_term",
  "indication.limitation",
  "population.condition",
  "population.exclusion_criterion",
  "indication.purpose_exclusion",
  "study.setting_term",
  "study.design",
  "study.sample_size",
  "study.site_count",
  "result.sensitivity",
  "result.specificity",
  "result.auc",
  "document.cites_nct",
  "study.clinical_tests",
] as const;

function isoDate(month: string, day: string, year: string): string {
  const m = MONTHS.toLowerCase().split("|").indexOf(month.toLowerCase()) + 1;
  return `${year}-${String(m).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------------------- indications

interface IfuBody {
  page: PageText;
  start: number;
  end: number;
  source: "form" | "summary";
}

const IFU_HEADING = /^\s*(?:[A-N]\.\s*)?(?:\d{1,2}\.?\s+)?(?:intended\s+use\s*\/\s*)?indications?\s+for\s+use\s*:?\s*(?:\[[^\]]{1,30}\])?\s*$/i;
const STOP_LINE =
  /^\s*(?:\d{1,2}\.?\s+(?:[A-Z][a-z]+\s*){1,4}$|(?:Performance|Clinical|Non-?clinical|Substantial\s+Equivalence|Conclusions?|Predicate|Technological|Summary\s+of)\b[^\n]{0,60}$|LIMITATIONS|WARNINGS?|CONTRAINDICATIONS|510\(k\)\s+Number|Device\s+Name|Indications?\s+for\s+Use|Special\s+Conditions|\d{1,2}\.\s+(?:Special|Warnings|Contra)|[A-N]\.\s+[A-Z]|Device\s+Description|Summary\s+of|Type\s+of\s+Use|Prescription\s+Use|Over-The-Counter|CONTINUE\s+ON|Please\s+select|Intended\s+use\s*\(|Technological)/i;

/** Lines that repeat on many pages (running headers and footers), keyed with digits masked. */
function runningLineKeys(doc: DocumentText): Set<string> {
  const counts = new Map<string, number>();
  for (const page of doc.pages) {
    const seen = new Set<string>();
    for (const l of page.text.split("\n")) {
      const key = l.trim().replace(/\s+/g, " ").replace(/\d+/g, "#");
      if (key.length >= 3) seen.add(key);
    }
    for (const k of seen) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const threshold = Math.max(3, Math.ceil(doc.pages.length * 0.25));
  return new Set([...counts].filter(([, n]) => n >= threshold).map(([k]) => k));
}

function findIfuBodies(doc: DocumentText): IfuBody[] {
  const out: IfuBody[] = [];
  const running = runningLineKeys(doc);
  const isRunning = (line: string) => running.has(line.trim().replace(/\s+/g, " ").replace(/\d+/g, "#"));
  for (const page of doc.pages) {
    const lines: { text: string; start: number }[] = [];
    let pos = 0;
    for (const l of page.text.split("\n")) {
      lines.push({ text: l, start: pos });
      pos += l.length + 1;
    }
    for (let i = 0; i < lines.length; i++) {
      const line = (lines[i] as { text: string }).text;
      let source: IfuBody["source"] | undefined;
      let from = -1;
      if (/^\s*Indications\s+for\s+Use\s*\(Describe\)\s*$/i.test(line)) {
        source = "form";
        from = i + 1;
      } else if (/Please\s+provide\s+your\s+Indications\s+for\s+Use\s+below/i.test(line)) {
        source = "form";
        from = i + 1;
      } else if (IFU_HEADING.test(line)) {
        source = "summary";
        from = i + 1;
        while (from < lines.length && (IFU_HEADING.test((lines[from] as { text: string }).text) || (lines[from] as { text: string }).text.trim() === "")) from++;
      }
      if (!source) continue;
      let j = from;
      while (j < lines.length && (lines[j] as { text: string }).text.trim() === "") j++;
      const bodyStart = j;
      // a title line over the form ("Indications for Use" above "510(k) Number") has no body of its own
      if (bodyStart < lines.length && STOP_LINE.test((lines[bodyStart] as { text: string }).text)) continue;
      let last = j;
      for (; j < lines.length; j++) {
        const t = (lines[j] as { text: string }).text;
        if (t.trim() !== "" && STOP_LINE.test(t) && j > bodyStart) break;
        if (/\S {3,}\S/.test(t) && source === "summary") break; // a table row is not the indication body
        if (t.trim() !== "") last = j;
        if (j - bodyStart > 40) break;
      }
      if (bodyStart >= lines.length) continue;
      const start = (lines[bodyStart] as { start: number }).start;
      const end = (lines[last] as { start: number; text: string }).start + (lines[last] as { text: string }).text.length;
      const text = page.text.slice(start, end);
      if (text.replace(/\s+/g, " ").trim().length < 40) continue;
      if (/^\s*(?:Please|Indications|Type of Use)/i.test(text)) continue;
      out.push({ page, start: start, end, source });

      // an indication that runs to the foot of the page continues on the next one (DEN170073 breaks mid-sentence)
      const trailing = lines.slice(last + 1).every((l) => l.text.trim() === "" || /^\s*\d{1,3}\s*$/.test(l.text));
      const next = trailing ? doc.pages[page.page] : undefined;
      if (next) {
        const nl: { text: string; start: number }[] = [];
        let np = 0;
        for (const l of next.text.split("\n")) {
          nl.push({ text: l, start: np });
          np += l.length + 1;
        }
        let k = 0;
        while (k < nl.length && ((nl[k] as { text: string }).text.trim() === "" || isRunning((nl[k] as { text: string }).text) || /^\s*(?:pg\s*)?\d{1,3}(?:\s*\/\s*\d{1,3})?\s*$/i.test((nl[k] as { text: string }).text))) k++;
        const cStart = k;
        let cLast = -1;
        for (; k < nl.length; k++) {
          const t = (nl[k] as { text: string }).text;
          if (t.trim() !== "" && STOP_LINE.test(t)) break;
          if (/\S {3,}\S/.test(t)) break;
          if (t.trim() !== "") cLast = k;
          if (k - cStart > 40) break;
        }
        if (cLast >= cStart) {
          const cs = (nl[cStart] as { start: number }).start;
          const ce = (nl[cLast] as { start: number; text: string }).start + (nl[cLast] as { text: string }).text.length;
          out.push({ page: next, start: cs, end: ce, source });
        }
      }
    }
  }
  return out;
}

function extractIndications(b: Builder): void {
  const bodies = findIfuBodies(b.doc);
  for (const body of bodies) {
    const text = body.page.text.slice(body.start, body.end);
    add(b, body.page, { start: body.start, end: body.end }, {
      predicate: "indication.text",
      value: text,
      assertionType: "authorization",
      detail: { section: body.source === "form" ? "Indications for Use (form)" : "Indications for Use (summary)" },
    });
    const spans = spansOf(body.page).filter((s) => s.end > body.start && s.start < body.end);
    const inBody = (s: Span): Span => ({ start: Math.max(s.start, body.start), end: Math.min(s.end, body.end) });

    for (const s of spans.map(inBody)) {
      const sentence = body.page.text.slice(s.start, s.end);
      for (const bound of parseAgeBounds(sentence)) {
        const years = bound.exclusive ? (bound.kind === "min" ? bound.years + 1 : bound.years - 1) : bound.years;
        add(b, body.page, s, {
          predicate: bound.kind === "min" ? "population.age_min" : "population.age_max",
          value: years,
          unit: "years",
          assertionType: "authorization",
          numbers: [{ value: bound.years, form: "raw" }],
          detail: { qualifiers: [bound.fromExclusion ? "from_exclusion" : "stated", ...(bound.exclusive ? ["strict_bound"] : [])] },
        });
      }
      for (const [term, re] of SETTING_TERMS) {
        if (re.test(sentence)) add(b, body.page, s, { predicate: "indication.setting_term", value: term, assertionType: "authorization" });
      }
      for (const [term, re] of PURPOSE_TERMS) {
        if (re.test(sentence)) add(b, body.page, s, { predicate: "indication.purpose_term", value: term, assertionType: "authorization" });
      }
      for (const [term, re] of GROUP_TERMS) {
        if (re.test(sentence)) add(b, body.page, s, { predicate: "population.group_term", value: term, assertionType: "authorization" });
      }
      if (LIMITATION_CUE.test(sentence)) {
        add(b, body.page, s, { predicate: "indication.limitation", value: collapse(sentence), assertionType: "authorization" });
      }
      for (const hit of populationPhrases(sentence)) {
        add(b, body.page, s, { predicate: hit.predicate, value: hit.value, assertionType: "authorization", detail: { qualifiers: [hit.pattern] } });
      }
      const exclusion = diagnosticExclusion(sentence);
      if (exclusion) {
        add(b, body.page, s, { predicate: "indication.purpose_exclusion", value: "diagnosis", assertionType: "authorization", detail: { qualifiers: [exclusion] } });
      }
      const eq = /indicated\s+for\s+use\s+with\s+(?:the\s+)?([^.]{3,120}?)(?:\s+in\s+(?:both\s+)?[^.]*)?\./i.exec(sentence);
      if (eq?.[1]) add(b, body.page, s, { predicate: "indication.compatible_equipment", value: collapse(eq[1]), assertionType: "authorization" });
    }
  }
}

/**
 * The "Intended patient population" statement of a 510(k) summary sits outside the indications block, as its own sentence. It is read
 * wherever it stands except on a page that sets the subject and a predicate device side by side, where the column is not known.
 */
function extractIntendedPopulation(b: Builder): void {
  for (const page of b.doc.pages) {
    if (page.textLayer === "absent" || pageComparesDevices(page.text)) continue;
    for (const span of spansOf(page)) {
      const sentence = page.text.slice(span.start, span.end);
      for (const hit of populationPhrases(sentence, ["population-of"])) {
        add(b, page, span, { predicate: hit.predicate, value: hit.value, assertionType: "authorization", detail: { qualifiers: [hit.pattern] } });
      }
    }
  }
}

// ---------------------------------------------------------------------------------- identity and version

function extractIdentity(b: Builder): void {
  const first = b.doc.pages[0];
  if (first) {
    const lines = first.text.split("\n");
    let pos = 0;
    for (let i = 0; i < Math.min(lines.length, 8); i++) {
      const line = lines[i] as string;
      const m = LETTER_DATE.exec(line);
      if (m) {
        const start = pos + line.indexOf(m[1] as string);
        add(b, first, { start, end: pos + line.trimEnd().length }, {
          predicate: "authorization.letter_date",
          value: isoDate(m[1] as string, m[2] as string, m[3] as string),
          assertionType: "authorization",
        });
        break;
      }
      pos += line.length + 1;
    }
  }

  for (const page of b.doc.pages.slice(0, 6)) {
    // The bare "Device Name" label is read only on the Indications for Use form, where the value is the next line.
    const isForm = /Indications\s+for\s+Use\s*\(Describe\)/i.test(page.text);
    const patterns = [/Trade\/Device\s+Name:\s*([^\n]+)/i, /Name\s+of\s+Device:\s*([^\n]+)/i, /Proprietary\s+and\s+Established\s+Names?:\s*\n?\s*([^\n]+)/i];
    if (isForm) patterns.push(/^\s*Device\s+Name\s*\n\s*([^\n]+)/im);
    for (const re of patterns) {
      const m = re.exec(page.text);
      if (!m?.[1]) continue;
      const nameStart = (m.index as number) + m[0].indexOf(m[1]);
      const line = m[1].trimEnd();
      const lineSpan: Span = { start: nameStart, end: nameStart + line.length };
      add(b, page, lineSpan, { predicate: "device.name", value: collapse(line.replace(/\s*\(v?[\d.]+\)\s*$/i, "")), assertionType: "authorization" });
      const ver = /(?:^|\s)\(?v(?:ersion)?\s*(\d+\.\d+(?:\.\d+){0,3})\)?\s*$|\s(\d+\.\d+(?:\.\d+){1,3})\s*$/i.exec(line);
      const token = ver?.[1] ?? ver?.[2];
      if (token) {
        add(b, page, lineSpan, { predicate: "device.version", value: token, assertionType: "authorization", detail: { qualifiers: ["device_name_line"] } });
      }
    }
  }

  extractVersionStrings(b, "authorization");
}

// ----------------------------------------------------------------------------------------------- entry

/**
 * Parse one FDA summary into verified assertions. `doc` may come from `readPdf` or from pre-extracted text.
 */
export async function parseFdaSummary(doc: DocumentText, options: FdaSummaryOptions = {}): Promise<FdaSummaryExtraction> {
  const head = doc.pages.slice(0, 2).map((p) => p.text).join("\n");
  const identifier = IDENTIFIER.exec(head)?.[1] ?? IDENTIFIER.exec(doc.text)?.[1];
  const subjectId = options.subjectId ?? (identifier ? `device:fda:${identifier}` : `record:${doc.recordId}`);
  const sections = findSections(doc);
  const b: Builder = { doc, sections, subjectId, proposals: [], seen: new Set() };

  if (identifier) {
    const first = doc.pages.find((p) => p.text.includes(identifier));
    if (first) {
      const at = first.text.indexOf(identifier);
      const spans = spansOf(first);
      const span = spanContaining(spans, at) ?? { start: at, end: at + identifier.length };
      add(b, first, span, { predicate: "document.identifier", value: identifier, assertionType: "authorization" });
    }
  }

  extractIdentity(b);
  extractIndications(b);
  extractIntendedPopulation(b);
  const counters = { unbound: 0, unresolvedRows: 0 };
  extractStudy(b, counters);

  const names = new Set<string>(options.subjectNames ?? []);
  for (const p of b.proposals) if (p.predicate === "device.name") names.add(String(p.value));
  const others = new Set<string>(options.otherSubjectNames ?? []);
  for (const page of doc.pages) {
    for (const m of page.text.matchAll(/Trade\s+name\s+of\s+the\s+device:\s*([^\n]+)/gi)) others.add(collapse(m[1] as string));
  }
  for (const n of names) others.delete(n);

  const searched = new Set(b.proposals.map((p) => p.predicate));
  const extraction = await verifyProposals(doc, b.proposals, {
    context: {
      subjectNames: [...names],
      otherSubjectNames: [...others],
      requireSubjectMention: false,
    },
    ...(options.verify?.model ? { model: options.verify.model } : {}),
  });

  const fields: FdaSummaryExtraction["fields"] = {};
  for (const f of FIELDS) fields[f] = { status: searched.has(f) ? "stated" : "absent", assertionIds: [] };
  for (const k of extraction.kept) {
    const f = fields[k.assertion.predicate] ?? (fields[k.assertion.predicate] = { status: "stated", assertionIds: [] });
    f.assertionIds.push(k.assertion.id);
  }

  const damageHits = detectOcrDamage(doc.text);
  const pagesWithoutText = doc.pages.filter((p) => p.textLayer === "absent").map((p) => p.page);
  return {
    ...(identifier ? { identifier } : {}),
    subjectId,
    sections,
    extraction,
    fields,
    unboundValues: counters.unbound,
    unresolvedTableRows: counters.unresolvedRows,
    pagesWithoutText,
    damage: {
      replacementChars: damageHits.filter((h) => h.kind === "replacement_char").length,
      glyphSymbols: damageHits.filter((h) => h.kind === "glued_symbol" || h.kind === "private_use").length,
      digitInWord: damageHits.filter((h) => h.kind === "digit_in_word").length,
    },
    redactionMarks: (doc.text.match(/\(b\)\s*\(\d\)/g) ?? []).length,
  };
}
