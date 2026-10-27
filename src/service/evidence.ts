/**
 * The Extractor's mechanism: stored records in, anchored and checked assertions out.
 *
 * Each record kind has one reader. Structured sources (openFDA, ClinicalTrials.gov, PubMed) are parsed by typed code. An
 * FDA decision summary is read by the summary parser from the page text. A publication abstract goes through the same
 * study reader, because an abstract states a population, a version and results in the same kinds of sentence.
 *
 * Two checks run on every assertion, apart: quote-exists and semantic support (the extraction layer does both). A model
 * may give a second opinion on the few assertions the compiler leans on; it can lower a PASS to FAIL and can resolve
 * nothing by itself. A field the reader searched for and did not find stays absent and is listed, never defaulted.
 */
import {
  askModelForSupport,
  parseClinicalTrials,
  parseFdaSummary,
  parseOpenFda510k,
  parseOpenFdaUdi,
  parsePubMedXml,
  type CheckedAssertion,
  type DocumentText,
  type FdaSummaryExtraction,
  type ProposedAssertion,
  type PublicationFacts,
  type StudyFacts,
} from "../extraction/index.ts";
import { contextAround } from "../extraction/verify.ts";
import { SETTING_TERMS } from "../extraction/lexicon.ts";
import { findSections } from "../extraction/sections.ts";
import { STUDY_CUE, add as addProposal, spansOf, type Builder } from "../extraction/study.ts";
import { verifyProposals } from "../extraction/verify.ts";
import type { Clearance, UdiDevice } from "../extraction/structured/openfda.ts";
import { PortError, type ModelPort } from "../ports/index.ts";
import type { AssertionType, EvidenceRecord } from "../schemas/index.ts";
import type { RawContent } from "../sources/index.ts";
import { sha256Hex } from "../util/canonical.ts";
import { MODEL_RESERVE, type Budget } from "./budget.ts";
import { brief, errorMessage } from "./util.ts";
import type { SummaryDocument } from "./sources.ts";

export type RecordKind = "fda-summary" | "openfda-510k" | "openfda-udi" | "ctgov-study" | "pubmed-article";

/** A stored record with the text its anchors quote from: what the dossier keeps as a snapshot. */
export interface StoredRecord {
  id: string;
  sourceId: string;
  kind: RecordKind;
  retrievedAt: string;
  sourcePublishedAt?: string;
  requestHash: string;
  contentHash: string;
  schemaVersion: string;
  license: string;
  /** The text the anchors quote from. */
  text: string;
  textHash: string;
  /** "text": the stored bytes are this text. "extracted": the text was extracted from content with another hash. */
  contentKind: "text" | "extracted";
  url: string;
  servedFrom: "live" | "recorded";
}

export interface ModelOpinion {
  assertionId: string;
  predicate: string;
  state: "PASS" | "FAIL" | "UNCHECKED";
  /** The reply's own words, or why there was none. */
  reason: string;
  routedModel?: string;
  recorded?: boolean;
}

export interface ExtractedRecord {
  stored: StoredRecord;
  doc: DocumentText;
  /** Assertions that passed the quote check, with their support state. Study assertions of a publication keep subject `pub:<pmid>` until a link places them. */
  kept: CheckedAssertion[];
  /** For a summary: the subject the reader found on the document (the K, DEN or P number it prints). */
  subjectId?: string;
  /** For a summary or abstract: what was searched for and whether it was stated. */
  fields: Record<string, { status: "stated" | "absent"; assertionIds: string[] }>;
  /** Plain statements of what the reader could not do with this record. */
  limits: string[];
  warnings: string[];
  opinions: ModelOpinion[];
  /** For a registry study: the words of the record that name what was tested (intervention descriptions and the brief summary). */
  studyText?: string;
  /** Typed convenience facts. */
  clearances?: Clearance[];
  udi?: UdiDevice[];
  study?: StudyFacts;
  article?: PublicationFacts;
  counts: { proposed: number; quotePassed: number; quoteFailed: number; supportPass: number; supportFail: number; supportUnchecked: number };
}

export interface ExtractDeps {
  /** Model for second opinions on critical assertions. Absent: rules only, and the record says so. */
  model?: { port: ModelPort; budget: Budget; newScope: () => string; maxOpinions: number; onCall?: () => void; subjectLabel?: (subjectId: string) => string };
}

const storedFrom = (record: EvidenceRecord, kind: RecordKind, doc: DocumentText, url: string, servedFrom: "live" | "recorded"): StoredRecord => ({
  id: record.id,
  sourceId: record.sourceId,
  kind,
  retrievedAt: record.retrievedAt,
  ...(record.sourcePublishedAt ? { sourcePublishedAt: record.sourcePublishedAt } : {}),
  requestHash: record.requestHash,
  contentHash: record.contentHash,
  schemaVersion: record.schemaVersion,
  license: record.license,
  text: doc.text,
  textHash: sha256Hex(doc.text),
  contentKind: "extracted",
  url,
  servedFrom,
});

const urlOf = (record: EvidenceRecord): string => (record.payload as { provenance?: { url?: string } } | undefined)?.provenance?.url ?? `source:${record.sourceId}`;
const servedOf = (record: EvidenceRecord): "live" | "recorded" => ((record.payload as { provenance?: { servedFrom?: string } } | undefined)?.provenance?.servedFrom === "recorded" ? "recorded" : "live");
const bodyOf = (record: EvidenceRecord): unknown => (record.payload as { body?: unknown } | undefined)?.body;

function counts(kept: CheckedAssertion[], proposed: number, quoteFailed: number): ExtractedRecord["counts"] {
  return {
    proposed,
    quotePassed: kept.length,
    quoteFailed,
    supportPass: kept.filter((k) => k.assertion.supportVerified === "PASS").length,
    supportFail: kept.filter((k) => k.assertion.supportVerified === "FAIL").length,
    supportUnchecked: kept.filter((k) => k.assertion.supportVerified === "UNCHECKED").length,
  };
}

// ---------------------------------------------------------------- care settings of the study itself

const PARTICIPATION_CUE = /\b(consent(?:ed)?|participat\w*|recruit\w*|conducted|enrol\w*)\b/i;

const SITE_CUE = /\b(sites?|centers?|centres?|facilit(?:y|ies)|practices|clinics?|hospitals?|enrolled|recruited|conducted)\b/i;

/**
 * Where the study ran. The decision-summary reader takes care settings from the indications section only, which states where
 * the product may be used, not where the evidence was gathered. A sentence that describes enrolment or sites and names a
 * setting term is read here as a study setting, with the sentence as its quote. Both checks still run on it.
 */
export async function readStudySettings(doc: DocumentText, subjectId: string): Promise<CheckedAssertion[]> {
  const b: Builder = { doc, sections: findSections(doc), subjectId, proposals: [], seen: new Set() };
  for (const page of doc.pages) {
    for (const span of spansOf(page)) {
      const sentence = page.text.slice(span.start, span.end);
      if (!(STUDY_CUE.test(sentence) || PARTICIPATION_CUE.test(sentence)) || !SITE_CUE.test(sentence)) continue;
      for (const [term, re] of SETTING_TERMS) if (re.test(sentence)) addProposal(b, page, span, { predicate: "indication.setting_term", value: term, assertionType: "study" });
    }
  }
  if (b.proposals.length === 0) return [];
  const result = await verifyProposals(doc, b.proposals, { context: { subjectNames: [], otherSubjectNames: [], requireSubjectMention: false } });
  return result.kept;
}

const mergeKept = (a: CheckedAssertion[], b: CheckedAssertion[]): CheckedAssertion[] => {
  const seen = new Set(a.map((k) => k.assertion.id));
  return [...a, ...b.filter((k) => !seen.has(k.assertion.id))];
};

// ---------------------------------------------------------------- readers

export async function extractFdaSummary(summary: SummaryDocument, license: string, deps: ExtractDeps): Promise<ExtractedRecord> {
  const doc = summary.doc;
  const parsed = await parseFdaSummary(doc);
  const limits: string[] = [];
  if (parsed.unresolvedTableRows > 0) {
    limits.push(`${parsed.unresolvedTableRows} table row(s) with a metric label and several values were seen and not extracted: results that exist only in a table whose column headers cannot be resolved stay unextracted`);
  }
  if (parsed.unboundValues > 0) limits.push(`${parsed.unboundValues} performance value(s) could not be bound to a metric with confidence and were not used`);
  if (parsed.pagesWithoutText.length > 0) limits.push(`pages ${parsed.pagesWithoutText.join(", ")} have no text layer (scans); nothing was read from them`);
  if (parsed.redactionMarks > 0) limits.push(`${parsed.redactionMarks} redaction mark(s) "(b)(4)" hide figures in the source`);
  const stored: StoredRecord = {
    id: summary.recordId,
    sourceId: "fda-accessdata-pdf",
    kind: "fda-summary",
    retrievedAt: summary.retrievedAt,
    requestHash: sha256Hex(summary.sourceUrl),
    contentHash: summary.contentHash,
    schemaVersion: "fda-summary/v1",
    license,
    text: doc.text,
    textHash: sha256Hex(doc.text),
    contentKind: "extracted",
    url: summary.sourceUrl,
    servedFrom: summary.servedFrom,
  };
  const settings = await readStudySettings(doc, parsed.subjectId);
  const kept = mergeKept(parsed.extraction.kept, settings);
  const out: ExtractedRecord = {
    stored,
    doc,
    kept,
    subjectId: parsed.subjectId,
    fields: parsed.fields,
    limits,
    warnings: doc.warnings,
    opinions: [],
    counts: counts(kept, parsed.extraction.counts.proposed + settings.length, parsed.extraction.counts.quote.failed),
  };
  await secondOpinions(out, deps);
  return out;
}

export async function extractOpenFda(record: EvidenceRecord, kind: "openfda-510k" | "openfda-udi", deps: ExtractDeps): Promise<ExtractedRecord> {
  const body = bodyOf(record);
  const parsed = kind === "openfda-510k" ? await parseOpenFda510k(body, record.id) : await parseOpenFdaUdi(body, record.id);
  const out: ExtractedRecord = {
    stored: storedFrom(record, kind, parsed.document, urlOf(record), servedOf(record)),
    doc: parsed.document,
    kept: parsed.extraction.kept,
    fields: {},
    limits: parsed.truncated ? [`the source holds ${parsed.truncated.total} rows and ${parsed.truncated.returned} were read`] : [],
    warnings: parsed.warnings,
    opinions: [],
    counts: counts(parsed.extraction.kept, parsed.extraction.counts.proposed, parsed.extraction.counts.quote.failed),
    ...(kind === "openfda-510k" ? { clearances: (parsed.facts as { clearances: Clearance[] }).clearances } : { udi: (parsed.facts as { devices: UdiDevice[] }).devices }),
  };
  await secondOpinions(out, deps);
  return out;
}

/** What the registry record says was tested: intervention descriptions and the brief summary. Used to match the record to a product by name. */
function registryStudyText(body: unknown): string | undefined {
  const p = (body as { protocolSection?: Record<string, any> } | undefined)?.protocolSection;
  if (!p) return undefined;
  const parts: string[] = [];
  for (const i of (p.armsInterventionsModule?.interventions ?? []) as { name?: string; description?: string }[]) {
    if (typeof i.name === "string") parts.push(i.name);
    if (typeof i.description === "string") parts.push(i.description);
  }
  if (typeof p.descriptionModule?.briefSummary === "string") parts.push(p.descriptionModule.briefSummary);
  const text = parts.join(". ").replace(/\s+/g, " ").trim();
  return text === "" ? undefined : text;
}

export async function extractCtgov(record: EvidenceRecord, deps: ExtractDeps): Promise<ExtractedRecord> {
  const parsed = await parseClinicalTrials(bodyOf(record), record.id);
  const study = parsed.facts.studies[0];
  const studyText = registryStudyText(bodyOf(record));
  const out: ExtractedRecord = {
    stored: storedFrom(record, "ctgov-study", parsed.document, urlOf(record), servedOf(record)),
    doc: parsed.document,
    kept: parsed.extraction.kept,
    fields: {},
    limits: [],
    warnings: parsed.warnings,
    opinions: [],
    counts: counts(parsed.extraction.kept, parsed.extraction.counts.proposed, parsed.extraction.counts.quote.failed),
    ...(study ? { study } : {}),
    ...(studyText ? { studyText } : {}),
  };
  if (study && study.population.ageMin === undefined) out.limits.push("the registry record states no minimum age");
  if (study && study.hasResults !== true) out.limits.push("the registry record has no posted results");
  await secondOpinions(out, deps);
  return out;
}

/**
 * One PubMed article. The bibliographic fields come from the PubMed parser; the abstract is then read by the study reader
 * under a neutral subject (`pub:<pmid>`), because who the study is about is decided by a link, not by the text.
 */
export async function extractPubmed(record: EvidenceRecord, content: RawContent | undefined, deps: ExtractDeps): Promise<ExtractedRecord> {
  if (!content) throw new PortError("DRIFTED", `PubMed record ${record.id} carries no XML bytes`);
  const xml = new TextDecoder("utf-8", { fatal: false }).decode(content.bytes);
  const parsed = await parsePubMedXml(xml, record.id);
  const article = parsed.facts.articles[0];
  if (!article) {
    return {
      stored: storedFrom(record, "pubmed-article", parsed.document, urlOf(record), servedOf(record)),
      doc: parsed.document,
      kept: [],
      fields: {},
      limits: ["PubMed returned no record for this identifier"],
      warnings: parsed.warnings,
      opinions: [],
      counts: counts([], 0, 0),
    };
  }
  const study = await parseFdaSummary(parsed.document, { subjectId: `pub:pmid:${article.pmid}` });
  // Whatever the reader typed, a publication states what a study did. It is never an authorization.
  const retyped = study.extraction.kept.map((k) => ({ ...k, assertion: { ...k.assertion, assertionType: "study" as AssertionType } }));
  const settings = await readStudySettings(parsed.document, `pub:pmid:${article.pmid}`);
  const kept = mergeKept(mergeKept(parsed.extraction.kept, retyped), settings);
  const limits: string[] = ["only the abstract is read: a population, setting or result stated only in the full text is not seen"];
  if (study.unboundValues > 0) limits.push(`${study.unboundValues} abstract value(s) could not be bound to a metric with confidence and were not used`);
  const out: ExtractedRecord = {
    stored: storedFrom(record, "pubmed-article", parsed.document, urlOf(record), servedOf(record)),
    doc: parsed.document,
    kept,
    fields: study.fields,
    limits,
    warnings: parsed.warnings,
    opinions: [],
    article,
    counts: counts(kept, parsed.extraction.counts.proposed + study.extraction.counts.proposed, parsed.extraction.counts.quote.failed + study.extraction.counts.quote.failed),
  };
  await secondOpinions(out, deps);
  return out;
}

// ---------------------------------------------------------------- the model's second opinion

const CRITICAL = /^(device\.version|population\.age_min|population\.age_max|result\.(sensitivity|specificity|auc))$/;

/**
 * Selects the assertions the compiler leans on. At most `max`; headline results and the version come first.
 *
 * Only assertions read out of prose are put to the model. A value taken from a typed field of a structured record (a registry
 * minimum age, a regulator date) is already checked by an exact read of that field, and its quotation is the bare field text
 * ("18 Years"), which carries no context for a model to judge. Asking anyway turned a correct field into a veto: a recorded run
 * dropped a registry minimum age of 18 because the passage "18 Years" "does not state the population", and a label moved with it.
 */
export function criticalAssertions(kept: readonly CheckedAssertion[], max: number): CheckedAssertion[] {
  const usable = kept.filter((k) => k.assertion.extractionMethod !== "structured" && k.assertion.quoteVerified && k.assertion.supportVerified === "PASS" && CRITICAL.test(k.assertion.predicate));
  const rank = (k: CheckedAssertion): number => (k.assertion.predicate === "device.version" ? 0 : k.assertion.predicate.startsWith("population.") ? 1 : 2);
  return [...usable].sort((a, b) => rank(a) - rank(b) || (a.assertion.id < b.assertion.id ? -1 : 1)).slice(0, max);
}

function proposalOf(k: CheckedAssertion, subjectLabel?: (subjectId: string) => string): ProposedAssertion {
  return {
    subjectId: subjectLabel ? subjectLabel(k.assertion.subjectId) : k.assertion.subjectId,
    predicate: k.assertion.predicate,
    value: k.assertion.value,
    ...(k.assertion.unit ? { unit: k.assertion.unit } : {}),
    ...(k.assertion.appliesToVersion ? { appliesToVersion: k.assertion.appliesToVersion } : {}),
    assertionType: k.assertion.assertionType,
    extractionMethod: k.assertion.extractionMethod,
    detail: k.detail,
  };
}

async function secondOpinions(out: ExtractedRecord, deps: ExtractDeps): Promise<void> {
  const m = deps.model;
  if (!m) return;
  for (const k of criticalAssertions(out.kept, m.maxOpinions)) {
    try {
      m.budget.spendKeeping("model", MODEL_RESERVE, `support check ${k.assertion.predicate}`);
    } catch (error) {
      out.limits.push(`second opinion skipped: ${errorMessage(error)}`);
      return;
    }
    m.onCall?.();
    const passage = contextAround(out.doc, k.quote.page, k.quote.start, k.quote.end);
    const report = await askModelForSupport({ port: m.port, role: "support_checker", dataClass: "public", newScope: m.newScope }, { passage, proposal: proposalOf(k, m.subjectLabel) });
    out.opinions.push({
      assertionId: k.assertion.id,
      predicate: k.assertion.predicate,
      state: report.state,
      reason: brief(report.reason ?? report.unavailable ?? "no reason given", 200),
      ...(report.routedModel ? { routedModel: report.routedModel } : {}),
      ...(report.recorded !== undefined ? { recorded: report.recorded } : {}),
    });
    if (report.state === "FAIL") {
      // It can lower a PASS to FAIL; the assertion no longer feeds the compiler. It never raises anything.
      k.assertion = { ...k.assertion, supportVerified: "FAIL" };
      k.support = { ...k.support, model: report, final: "FAIL" };
      out.counts = counts(out.kept, out.counts.proposed, out.counts.quoteFailed);
    } else if (report.state === "PASS") {
      k.support = { ...k.support, model: report };
    }
  }
}

// ---------------------------------------------------------------- search results (candidates, not evidence)

export interface CtgovCandidate {
  nctId: string;
  title?: string;
  sponsor?: string;
  interventions: string[];
}

export function candidatesFromCtgovSearch(body: unknown): CtgovCandidate[] {
  const studies = (body as { studies?: unknown[] } | undefined)?.studies;
  if (!Array.isArray(studies)) return [];
  const out: CtgovCandidate[] = [];
  for (const s of studies) {
    const p = (s as { protocolSection?: Record<string, any> }).protocolSection;
    const nctId = p?.identificationModule?.nctId;
    if (typeof nctId !== "string" || !/^NCT\d{8}$/.test(nctId)) continue;
    const interventions = ((p?.armsInterventionsModule?.interventions ?? []) as { name?: string }[]).map((i) => i.name).filter((n): n is string => typeof n === "string");
    out.push({
      nctId,
      ...(typeof p?.identificationModule?.briefTitle === "string" ? { title: p.identificationModule.briefTitle as string } : {}),
      ...(typeof p?.sponsorCollaboratorsModule?.leadSponsor?.name === "string" ? { sponsor: p.sponsorCollaboratorsModule.leadSponsor.name as string } : {}),
      interventions,
    });
  }
  return out;
}

export function pmidsFromPubmedSearch(body: unknown): string[] {
  const ids = (body as { esearchresult?: { idlist?: unknown[] } } | undefined)?.esearchresult?.idlist;
  return Array.isArray(ids) ? ids.filter((x): x is string => typeof x === "string" && /^\d{1,9}$/.test(x)) : [];
}

export function pmidsFromEuropePmc(body: unknown): string[] {
  const hits = (body as { resultList?: { result?: { pmid?: unknown }[] } } | undefined)?.resultList?.result;
  return Array.isArray(hits) ? hits.map((h) => h.pmid).filter((x): x is string => typeof x === "string" && /^\d{1,9}$/.test(x)) : [];
}

/** Version strings an extraction states for a subject, in order of first mention. */
export function versionsStated(kept: readonly CheckedAssertion[]): string[] {
  const out: string[] = [];
  for (const k of kept) {
    if (k.assertion.predicate !== "device.version" || k.assertion.supportVerified !== "PASS") continue;
    const v = String(k.assertion.value);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export type { FdaSummaryExtraction };
