/**
 * Evidence extraction layer: documents and structured records in, anchored and checked assertions out.
 *
 *   text      readPdf, documentFromText, documentFromFields (pages or fields with stable numbers and offsets)
 *   parsers   parseFdaSummary, parseOpenFda*, parseClinicalTrials, parsePubMedXml, parseEuropePmc
 *   checks    verifyProposals (quote-exists, then semantic support, reported apart)
 *   model     askModelForSupport (optional second opinion through a ModelPort)
 *   output    toEvidenceItems (the compiler's EvidenceItem / Scope shape), chunkByPages / chunkBySize
 */
export { readPdf, type PdfExtraction, type PdfOptions } from "./pdf.ts";
export {
  checkQuoteExists,
  detectOcrDamage,
  documentFromFields,
  documentFromPages,
  documentFromText,
  locateOffset,
  makeAnchor,
  pageByNumber,
  parseNumberToken,
  type DamageHit,
  type FieldInput,
} from "./document.ts";
export { buildKey, findAll, numericTokens, type MatchTier } from "./normalize.ts";
export { findSections, sectionAt, type Section, type SectionKind } from "./sections.ts";
export { parseAgeBounds, parseRegistryAge, summariseAge, type AgeBound } from "./age.ts";
export { scanStatements, METRICS, type Metric, type StatBinding } from "./stats.ts";
export { assessSupport, assessStructuredSupport, type SupportClaim, type SupportContext } from "./support.ts";
export { verifyProposals, isUsable, emptyCounts, type VerifyOptions } from "./verify.ts";
export { askModelForSupport, buildSupportPrompt, SUPPORT_JSON_SCHEMA, type ModelSupportDeps } from "./model-check.ts";
export { parseFdaSummary, type FdaSummaryExtraction, type FdaSummaryOptions } from "./fda-summary.ts";
export { parseOpenFda510k, parseOpenFdaUdi, parseOpenFdaPma, parseOpenFdaClassification } from "./structured/openfda.ts";
export { parseClinicalTrials, parseCriteria, type StudyFacts } from "./structured/ctgov.ts";
export { parsePubMedXml, type PublicationFacts } from "./structured/pubmed.ts";
export { parseEuropePmc, cleanEpmcTitle } from "./structured/europepmc.ts";
export type { StructuredExtraction } from "./structured/collector.ts";
export { toEvidenceItems, type ConversionNote, type ConversionOptions } from "./to-evidence.ts";
export { chunkByPages, chunkBySize, chunkOffsetToPage, type Chunk } from "./chunks.ts";
export * from "./types.ts";
