/**
 * Markovian engine facade. The conformance runner imports Markovian, modelTotals and runEfficiency from here.
 */
export * from "./types.ts";
export { resolveConfig, projectionCurve, runEfficiency, modelTotals, materialBudgetTokens, DOC_DEFAULTS } from "./config.ts";
export type { RunEfficiency, CostModelConstants } from "./config.ts";
export { parseMarkers, cleanMarkers } from "./markers.ts";
export type { ParsedMarkers } from "./markers.ts";
export { CarryoverService, canonicalBlock } from "./carryover.ts";
export { buildPrompt, overlapSlice, readUsage, boundaryFor, truncateGoal, MARKER_RULES } from "./prompt.ts";
export { Markovian } from "./engine.ts";
export { Reader, DocumentTooLargeError, QUARANTINE_MASK } from "./reader.ts";
export type { ReaderOptions, ReadOutcome, FieldState, CallRecord, ChunkTrace, ScreenFinding, DocumentScreen } from "./reader.ts";
export { FactLedger, factsDropped, emptyDrops } from "./ledger.ts";
export type { LedgerFact, LedgerDefinition, Anchor, DropCounts, Coverage } from "./ledger.ts";
export { FACT_FIELDS, CHECKLIST, MODEL_OUTPUT_JSON_SCHEMA, parseModelOutput, quoteExists, numberAppearsIn, normaliseForMatch } from "./facts.ts";
export type { FactField, ChecklistKey, RawFact } from "./facts.ts";
export { normalisePages, planChunks, pageRanges, hasText, PageInputError } from "./pagination.ts";
export type { Page, PlannedChunk } from "./pagination.ts";
