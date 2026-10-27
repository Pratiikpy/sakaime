/**
 * The records a case is evaluated against, and how candidates for a product are found.
 *
 * Development claims: the FDA summary of the device (pdftotext text from the feasibility fixtures, or the K223357 summary kept by Gate 0)
 * plus every study or publication the labelled identity corpus pairs with the device's submission record, whether or not it truly
 * belongs to it. Those pairs are exactly what a name-and-brand search would return, hard negatives included.
 *
 * Held-out claims: the FDA summary read through pdfjs (evals/heldout/text). There are no external study records for these devices.
 *
 * The identity layer is what separates the candidates that belong to the device from those that do not (pipeline.ts). The arms
 * that have no identity layer (B1 to B4) receive every candidate.
 */
import { join } from "node:path";
import { loadCorpus, type Corpus } from "../../src/identity/corpus.ts";
import { fitModel, resolveDeterministic, verdictOf, type Verdict } from "../../src/identity/index.ts";
import { loadReference } from "../../src/identity/run-eval.ts";
import type { ScorerModel } from "../../src/identity/index.ts";
import { documentFromText } from "../../src/extraction/document.ts";
import { parseClinicalTrials } from "../../src/extraction/structured/ctgov.ts";
import { parsePubMedXml } from "../../src/extraction/structured/pubmed.ts";
import type { CheckedAssertion } from "../../src/extraction/types.ts";
import { FIXTURES, ROOT, exists, readText } from "./core.ts";

export interface Doc {
  id: string;
  kind: "fda-summary" | "registry-record" | "publication";
  label: string;
  /** Page-separated text (form feed) for a summary; field text for a structured record. */
  text: string;
  origin: string;
}

export interface Candidate {
  recordId: string;
  kind: "Study" | "Publication";
  fixtureRef: string;
  /** The identity resolver's verdict for (record, product) under STUDY_EVALUATES, trained without the product's family. */
  verdict: Verdict;
  state: string | null;
  flags: string[];
  /** The builder's label for the same pair, for diagnostics only. Never read by any arm. */
  truth: string | undefined;
  doc: Doc;
  /** The record's assertions after both checks, with subject ids as the parsers set them. */
  kept: CheckedAssertion[];
  subjectId: string;
}

export interface Retrieval {
  product: string;
  partition: "development" | "held-out";
  fda: Doc;
  candidates: Candidate[];
}

const FDA_PATHS: Record<string, string> = {
  K223357: join(ROOT, "evals", "gate0", "raw", "fda", "K223357_summary_text.txt"),
};

export function fdaIdOf(product: string): string {
  const id = product.split(":").pop();
  if (!id) throw new Error(`cannot read a submission number from ${product}`);
  return id;
}

export function fdaDoc(product: string, partition: "development" | "held-out"): Doc {
  const id = fdaIdOf(product);
  if (partition === "held-out") {
    const path = join(ROOT, "evals", "heldout", "text", `${id}_pages.txt`);
    return { id: `fda:${id}`, kind: "fda-summary", label: `FDA decision summary ${id}`, text: readText(path), origin: "pdfjs page text (evals/heldout/text)" };
  }
  const path = FDA_PATHS[id] ?? join(FIXTURES, "fda", `${id}_summary_text.txt`);
  if (!exists(path)) throw new Error(`no FDA summary on disk for ${id}`);
  return { id: `fda:${id}`, kind: "fda-summary", label: `FDA decision summary ${id}`, text: readText(path), origin: "pdftotext text (feasibility fixtures)" };
}

export { documentFromText };

let corpusCache: { corpus: Corpus; reference: ReturnType<typeof loadReference>; models: Map<string, ScorerModel> } | undefined;

function identity(): NonNullable<typeof corpusCache> {
  corpusCache ??= { corpus: loadCorpus(), reference: loadReference(), models: new Map() };
  return corpusCache;
}

/** The scorer trained on every labelled pair that touches nothing of the product's family (leave-one-family-out). */
function modelWithout(family: string): ScorerModel {
  const ctx = identity();
  const hit = ctx.models.get(family);
  if (hit) return hit;
  const touches = (p: Corpus["pairs"][number]) =>
    ctx.corpus.records.get(p.a)!.family === family || ctx.corpus.records.get(p.b)!.family === family || p.family === family;
  const model = fitModel(ctx.corpus, ctx.reference, touches);
  ctx.models.set(family, model);
  return model;
}

function submissionRecordId(corpus: Corpus, product: string): string | undefined {
  const id = fdaIdOf(product);
  return [`510k:${id}`, `list:${id}`].find((r) => corpus.records.has(r));
}

async function parseCandidate(recordId: string, fixtureRef: string): Promise<{ doc: Doc; kept: CheckedAssertion[]; subjectId: string }> {
  const [path, anchor] = fixtureRef.split("#") as [string, string | undefined];
  if (path.startsWith("fda/")) {
    // The record is a trial identifier cited inside an FDA summary; no registry record was fetched for it.
    const nctCited = recordId.replace(/^ctgov:/, "");
    return {
      doc: { id: `reg:${nctCited}`, kind: "registry-record", label: `ClinicalTrials.gov ${nctCited} (identifier cited in an FDA summary; no registry record fetched)`, text: `Registered trial ${nctCited}, cited in the FDA decision summary.`, origin: path },
      kept: [],
      subjectId: `record:${nctCited}`,
    };
  }
  const raw = readText(join(FIXTURES, path));
  if (path.endsWith(".xml")) {
    const pmid = anchor ?? "";
    const parsed = await parsePubMedXml(raw, pmid || recordId);
    const subjectId = `publication:pmid:${pmid}`;
    const kept = parsed.extraction.kept.filter((k) => k.assertion.subjectId === subjectId);
    const index = parsed.facts.articles.findIndex((a) => a.pmid === pmid);
    const prefix = `$.PubmedArticleSet.PubmedArticle[${index}]`;
    const lines: string[] = [];
    parsed.document.pages.forEach((page, i) => {
      const path = parsed.document.fieldPaths?.[i] ?? "";
      if (index >= 0 && path.startsWith(prefix)) lines.push(`${parsed.document.fieldLabels?.[i] ?? path}: ${page.text}`);
    });
    const text = lines.join("\n");
    return { doc: { id: `pub:${pmid}`, kind: "publication", label: `PubMed ${pmid}`, text, origin: path }, kept, subjectId };
  }
  const nct = recordId.replace(/^ctgov:/, "");
  const parsed = await parseClinicalTrials(JSON.parse(raw), nct);
  // A fixture can hold a whole search response; only the record's own study belongs to this candidate.
  const subjectId = `study:${nct}`;
  const kept = parsed.extraction.kept.filter((k) => k.assertion.subjectId === subjectId);
  const lines: string[] = [];
  parsed.document.pages.forEach((page, i) => {
    const label = parsed.document.fieldLabels?.[i] ?? parsed.document.fieldPaths?.[i] ?? "";
    const path = parsed.document.fieldPaths?.[i] ?? "";
    const own = parsed.facts.studies.findIndex((st) => st.nctId === nct);
    const prefix = parsed.facts.studies.length > 1 && own >= 0 ? `$.studies[${own}]` : "$";
    if (path.startsWith(prefix)) lines.push(`${label}: ${page.text}`);
  });
  return { doc: { id: `reg:${nct}`, kind: "registry-record", label: `ClinicalTrials.gov ${nct}`, text: lines.join("\n"), origin: path }, kept, subjectId };
}

export async function retrieve(product: string, partition: "development" | "held-out"): Promise<Retrieval> {
  const fda = fdaDoc(product, partition);
  if (partition === "held-out") return { product, partition, fda, candidates: [] };
  const { corpus, reference } = identity();
  void reference;
  const sub = submissionRecordId(corpus, product);
  if (!sub) return { product, partition, fda, candidates: [] };
  const family = corpus.records.get(sub)!.family;
  const model = modelWithout(family);
  const known = [...corpus.records.values()].map((r) => r.record);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  for (const pair of corpus.pairs) {
    if (pair.linkType !== "STUDY_EVALUATES") continue;
    const other = pair.a === sub ? pair.b : pair.b === sub ? pair.a : undefined;
    if (!other || seen.has(other)) continue;
    const rec = corpus.records.get(other)!.record;
    if (rec.kind !== "Study" && rec.kind !== "Publication") continue;
    const ref = (rec as { fixtureRef?: string }).fixtureRef;
    if (!ref) continue;
    seen.add(other);
    const res = resolveDeterministic(corpus.records.get(pair.a)!.record, corpus.records.get(pair.b)!.record, "STUDY_EVALUATES", { model, knownRecords: known });
    const parsed = await parseCandidate(other, ref);
    out.push({
      recordId: other,
      kind: rec.kind,
      fixtureRef: ref,
      verdict: verdictOf(res),
      state: res.link?.state ?? null,
      flags: res.flags,
      truth: pair.truth,
      doc: parsed.doc,
      kept: parsed.kept,
      subjectId: parsed.subjectId,
    });
  }
  return { product, partition, fda, candidates: out };
}
