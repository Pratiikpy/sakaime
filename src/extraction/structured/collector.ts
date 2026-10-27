import { PortError } from "../../ports/index.ts";
import { documentFromFields, type FieldInput } from "../document.ts";
import type { DocumentText, ExtractionResult, NumberClaim, ProposedAssertion, ResultDetail } from "../types.ts";
import { verifyProposals, type VerifyOptions } from "../verify.ts";

/**
 * What every structured parser returns. `health` keeps "the source answered and has nothing" (EMPTY) apart from a
 * failure, which is thrown as a PortError and never returned as an empty result.
 */
export interface StructuredExtraction<F = Record<string, unknown>> {
  recordId: string;
  health: "OK" | "EMPTY";
  /** The record as field text: one page per field, anchors carry the JSON path. */
  document: DocumentText;
  extraction: ExtractionResult;
  /** Typed convenience view of the same content, for callers that do not need anchors. */
  facts: F;
  /** The source reports more results than this response holds. The caller decides what that means. */
  truncated?: { returned: number; total: number };
  warnings: string[];
}

export class FieldCollector {
  readonly fields: FieldInput[] = [];
  readonly proposals: ProposedAssertion[] = [];
  private readonly index = new Map<string, number>();

  constructor(
    private readonly subjectId: string,
    private readonly assertionType: ProposedAssertion["assertionType"],
  ) {}

  /** Register a field and return its 1-based "page" number. A blank field is not registered. */
  field(path: string, text: string | number | boolean | undefined | null, label?: string): number | undefined {
    if (text === undefined || text === null) return undefined;
    const s = String(text);
    if (s.trim().length === 0) return undefined;
    const known = this.index.get(path);
    if (known !== undefined) return known;
    this.fields.push({ path, text: s, ...(label ? { label } : {}) });
    const n = this.fields.length;
    this.index.set(path, n);
    return n;
  }

  /** One assertion whose passage is the whole field. */
  scalar(
    path: string,
    text: string | number | boolean | undefined | null,
    predicate: string,
    value: ProposedAssertion["value"] | undefined,
    extra: {
      unit?: string;
      assertionType?: ProposedAssertion["assertionType"];
      numbers?: NumberClaim[];
      detail?: ResultDetail;
      subjectId?: string;
      label?: string;
    } = {},
  ): void {
    if (value === undefined) return;
    const page = this.field(path, text, extra.label);
    if (page === undefined) return;
    const f = this.fields[page - 1] as FieldInput;
    this.proposals.push({
      subjectId: extra.subjectId ?? this.subjectId,
      predicate,
      value,
      ...(extra.unit ? { unit: extra.unit } : {}),
      assertionType: extra.assertionType ?? this.assertionType,
      extractionMethod: "structured",
      quote: f.text,
      page,
      ...(extra.numbers ? { numbers: extra.numbers } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    });
  }

  /** An assertion whose passage is a part of a longer field (a bullet of an eligibility list, a sentence). */
  excerpt(
    path: string,
    fieldText: string,
    quote: string,
    predicate: string,
    value: ProposedAssertion["value"],
    extra: { unit?: string; assertionType?: ProposedAssertion["assertionType"]; numbers?: NumberClaim[]; detail?: ResultDetail; label?: string; subjectId?: string } = {},
  ): void {
    const page = this.field(path, fieldText, extra.label);
    if (page === undefined) return;
    this.proposals.push({
      subjectId: extra.subjectId ?? this.subjectId,
      predicate,
      value,
      ...(extra.unit ? { unit: extra.unit } : {}),
      assertionType: extra.assertionType ?? this.assertionType,
      extractionMethod: "structured",
      quote,
      page,
      ...(extra.numbers ? { numbers: extra.numbers } : {}),
      ...(extra.detail ? { detail: extra.detail } : {}),
    });
  }

  async finish<F>(recordId: string, facts: F, health: "OK" | "EMPTY", options: Pick<VerifyOptions, "model"> = {}): Promise<StructuredExtraction<F>> {
    const document = documentFromFields(recordId, this.fields);
    const extraction = await verifyProposals(document, this.proposals, options.model ? { model: options.model } : {});
    return { recordId, health, document, extraction, facts, warnings: [] };
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function parseJson(raw: string | unknown, source: string): unknown {
  if (typeof raw !== "string") return raw;
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw new PortError("INVALID", `${source} response is not JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function drifted(source: string, what: string, detail?: Record<string, unknown>): PortError {
  return new PortError("DRIFTED", `${source} response changed shape: ${what}`, detail);
}

/** "YYYY-MM-DD" or "YYYY-MM"; anything else is left out. */
export function isoOrPartialDate(value: unknown): string | undefined {
  return typeof value === "string" && /^\d{4}-\d{2}(-\d{2})?$/.test(value) ? value : undefined;
}
