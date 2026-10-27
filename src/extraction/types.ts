import type { EvidenceAnchor, EvidenceAssertion } from "../schemas/evidence.ts";
import type { MatchTier } from "./normalize.ts";

/** Page separator inside DocumentText.text. One character, so global offsets stay simple. */
export const PAGE_SEPARATOR = "\f";

export interface TextLine {
  /** Offsets into the page text (not the document text). */
  start: number;
  end: number;
  /** Bounding box in PDF points [x0, y0, x1, y1], origin bottom-left. Absent for text-only input. */
  bbox?: [number, number, number, number];
}

export interface PageText {
  /** 1-based physical page number. Anchors use this; a printed label such as "Page 3 of 21" is kept apart. */
  page: number;
  text: string;
  /** Offset of this page's first character in DocumentText.text. */
  start: number;
  end: number;
  lines: TextLine[];
  /** The label printed on the page ("Page 3 of 21"), when one is found. Never used as the page number. */
  printedLabel?: string;
  /** "absent" when the page has no text layer (a scan). No OCR is attempted and nothing is invented. */
  textLayer: "present" | "absent";
}

export interface DocumentText {
  recordId: string;
  pages: PageText[];
  /** All pages joined by PAGE_SEPARATOR. */
  text: string;
  /** sha256 of the page texts, so a change in extraction is visible. */
  textHash: string;
  /** How the text was obtained: "pdf" (pdfjs) or "text" (pre-extracted pages). */
  origin: "pdf" | "text" | "fields";
  /**
   * Set when the document is a structured record: each "page" is one field, and anchors carry the field's JSON
   * path instead of a page number. fieldPaths[i] belongs to pages[i].
   */
  fieldPaths?: string[];
  /** Human labels for the fields (for example the abstract section heading), parallel to fieldPaths. */
  fieldLabels?: string[];
  warnings: string[];
}

export type QuoteFailure =
  | "UNQUOTED" // no quote was given: the extraction is discarded
  | "EMPTY_QUOTE"
  | "NOT_FOUND" // the passage is not in the page text
  | "PAGE_MISMATCH" // found, but not on the page the extraction named
  | "NUMBER_NOT_IN_QUOTE" // the quote exists but does not contain a number the assertion states
  | "DIGIT_GUARD" // the matched text differs from the quote in a digit, sign or decimal point
  | "SPANS_PAGES";

export type QuoteCheck =
  | {
      exists: true;
      page: number;
      /** Offsets into the page text. */
      start: number;
      end: number;
      /** The characters of the page at [start, end): the anchor text. */
      verbatim: string;
      tier: MatchTier;
      /** How many times the passage occurs on the page. More than one means the anchor is the first. */
      occurrences: number;
    }
  | { exists: false; reason: QuoteFailure; detail?: string };

export type SupportState = "PASS" | "FAIL" | "UNCHECKED";

export interface RuleOutcome {
  rule: string;
  /** true: satisfied; false: violated; null: the rule could not decide. */
  ok: boolean | null;
  detail: string;
}

export interface SupportReport {
  /** The deterministic pattern rules alone. */
  deterministic: { state: SupportState; rules: RuleOutcome[]; flags: string[] };
  /** The optional second opinion from a separate model call. Absent when none was requested. */
  model?: {
    state: SupportState;
    verdict?: "supports" | "does_not_support" | "cannot_tell";
    mismatches?: string[];
    reason?: string;
    /** Why the model gave no usable opinion (unavailable, invalid JSON). */
    unavailable?: string;
    routedModel?: string;
    recorded?: boolean;
  };
  /** FAIL if either says FAIL; PASS only if no check failed and at least one decided PASS; otherwise UNCHECKED. */
  final: SupportState;
}

/** The statement made about a number inside an assertion, for the digit guard. */
export interface NumberClaim {
  value: number;
  /** "percent": the passage shows 87.8 for 0.878. "proportion": shows 0.878. "count": a whole number. "raw": as shown. */
  form: "percent" | "proportion" | "count" | "raw";
}

/** An extraction as proposed by code or a model, before the two checks. */
export interface ProposedAssertion {
  subjectId: string;
  predicate: string;
  value: string | number | boolean | string[];
  unit?: string;
  appliesToVersion?: string;
  assertionType: EvidenceAssertion["assertionType"];
  extractionMethod: EvidenceAssertion["extractionMethod"];
  /** The verbatim passage the extraction rests on. Without one it is discarded. */
  quote?: string;
  /** The page the extraction names, when it names one. */
  page?: number;
  /** Numbers the assertion states; each must appear in the quoted passage. */
  numbers?: NumberClaim[];
  /** Detail the schema has no field for: interval, sample size, operating point, qualifiers. */
  detail?: ResultDetail;
}

export interface ResultDetail {
  metric?: string;
  ci?: [number, number];
  n?: number;
  nUnit?: string;
  operatingPoint?: string;
  /** "subgroup:eyeart-primary-care", "enrichment_corrected", "worst_case", "development_set"... */
  qualifiers?: string[];
  /** Where in the document the passage sits, for example "I. Performance Characteristics". */
  section?: string;
}

export interface CheckedAssertion {
  assertion: EvidenceAssertion;
  anchor: EvidenceAnchor;
  quote: QuoteCheck & { exists: true };
  support: SupportReport;
  detail: ResultDetail;
}

export interface DroppedAssertion {
  proposal: ProposedAssertion;
  reason: QuoteFailure;
  detail?: string;
}

/** The counters keep the two checks apart: nothing here adds a quote failure to a support failure. */
export interface CheckCounts {
  proposed: number;
  discardedUnquoted: number;
  quote: { passed: number; failed: number; byReason: Partial<Record<QuoteFailure, number>> };
  support: { pass: number; fail: number; unchecked: number };
}

export interface ExtractionResult {
  recordId: string;
  kept: CheckedAssertion[];
  dropped: DroppedAssertion[];
  counts: CheckCounts;
}
