/**
 * The two checks, run in order and reported apart.
 *
 *   1. quote-exists (code): the passage is in the stored page text and every number the assertion states is in it.
 *      A failure drops the assertion and is counted. An extraction without a quote is discarded and counted.
 *   2. semantic support: the passage states what the assertion claims. Deterministic rules decide what they can;
 *      an optional second opinion from a separate model call (seeing only passage and assertion) can lower a PASS to
 *      a FAIL or resolve an UNCHECKED, and its answer is stored next to the rules, never merged into them.
 *
 * Counters keep the checks apart: a quote failure is never added to a support failure.
 */
import type { EvidenceAssertion } from "../schemas/evidence.ts";
import { hashOf } from "../util/canonical.ts";
import { checkQuoteExists, makeAnchor, pageByNumber, pageSpans } from "./document.ts";
import { askModelForSupport, type ModelSupportDeps } from "./model-check.ts";
import { assessStructuredSupport, assessSupport, type SupportContext } from "./support.ts";
import type {
  CheckCounts,
  CheckedAssertion,
  DocumentText,
  DroppedAssertion,
  ExtractionResult,
  ProposedAssertion,
  QuoteCheck,
  SupportReport,
  SupportState,
} from "./types.ts";

export interface VerifyOptions {
  context?: SupportContext;
  /** A separate model call for the second opinion. Omit to run the rules only. */
  model?: ModelSupportDeps;
}

export function emptyCounts(): CheckCounts {
  return {
    proposed: 0,
    discardedUnquoted: 0,
    quote: { passed: 0, failed: 0, byReason: {} },
    support: { pass: 0, fail: 0, unchecked: 0 },
  };
}

/** The sentence(s) around a located quote: what a reader needs to judge whether the quote says the thing. */
export function contextAround(doc: DocumentText, page: number, start: number, end: number): string {
  const p = pageByNumber(doc, page);
  if (!p) return "";
  const spans = pageSpans(p).filter((s) => s.end > start && s.start < end);
  if (spans.length === 0) return p.text.slice(start, end);
  const from = Math.min(start, ...spans.map((s) => s.start));
  const to = Math.max(end, ...spans.map((s) => s.end));
  return p.text.slice(from, to);
}

function combine(det: SupportState, model: SupportReport["model"] | undefined): SupportState {
  if (det === "FAIL") return "FAIL";
  if (!model || model.state === "UNCHECKED") return det;
  if (model.state === "FAIL") return "FAIL";
  // the model supports it: it can resolve an UNCHECKED, but it never overrides a rule that said FAIL
  return "PASS";
}

export function assertionId(a: Pick<ProposedAssertion, "subjectId" | "predicate" | "value" | "appliesToVersion">, anchorId: string): string {
  return `asr_${hashOf({ s: a.subjectId, p: a.predicate, v: a.value, ver: a.appliesToVersion ?? null, a: anchorId }).slice(0, 20)}`;
}

export async function verifyProposals(
  doc: DocumentText,
  proposals: ProposedAssertion[],
  options: VerifyOptions = {},
): Promise<ExtractionResult> {
  const counts = emptyCounts();
  const kept: CheckedAssertion[] = [];
  const dropped: DroppedAssertion[] = [];

  for (const proposal of proposals) {
    counts.proposed++;
    const check: QuoteCheck = checkQuoteExists(doc, {
      ...(proposal.quote !== undefined ? { quote: proposal.quote } : {}),
      ...(proposal.page !== undefined ? { page: proposal.page } : {}),
      ...(proposal.numbers ? { numbers: proposal.numbers } : {}),
    });
    if (!check.exists) {
      if (check.reason === "UNQUOTED") counts.discardedUnquoted++;
      counts.quote.failed++;
      counts.quote.byReason[check.reason] = (counts.quote.byReason[check.reason] ?? 0) + 1;
      dropped.push({ proposal, reason: check.reason, ...(check.detail ? { detail: check.detail } : {}) });
      continue;
    }
    counts.quote.passed++;

    const anchor = makeAnchor(doc, check.page, check.start, check.end);
    const context = contextAround(doc, check.page, check.start, check.end);
    const assess = proposal.extractionMethod === "structured" ? (p: string, c: Parameters<typeof assessSupport>[1]) => assessStructuredSupport(p, c) : (p: string, c: Parameters<typeof assessSupport>[1]) => assessSupport(p, c, options.context);
    const deterministic = assess(
      context,
      {
        predicate: proposal.predicate,
        value: proposal.value,
        ...(proposal.unit ? { unit: proposal.unit } : {}),
        ...(proposal.appliesToVersion ? { appliesToVersion: proposal.appliesToVersion } : {}),
        ...(proposal.detail ? { detail: proposal.detail } : {}),
      },
    );
    let model: SupportReport["model"] | undefined;
    if (options.model) {
      model = await askModelForSupport(options.model, { passage: context, proposal });
    }
    const support: SupportReport = { deterministic, ...(model ? { model } : {}), final: combine(deterministic.state, model) };
    if (support.final === "PASS") counts.support.pass++;
    else if (support.final === "FAIL") counts.support.fail++;
    else counts.support.unchecked++;

    const assertion: EvidenceAssertion = {
      id: assertionId(proposal, anchor.id),
      subjectId: proposal.subjectId,
      predicate: proposal.predicate,
      value: proposal.value,
      ...(proposal.unit ? { unit: proposal.unit } : {}),
      ...(proposal.appliesToVersion ? { appliesToVersion: proposal.appliesToVersion } : {}),
      assertionType: proposal.assertionType,
      anchorId: anchor.id,
      extractionMethod: proposal.extractionMethod,
      quoteVerified: true,
      supportVerified: support.final,
    };
    kept.push({ assertion, anchor, quote: check, support, detail: proposal.detail ?? {} });
  }
  return { recordId: doc.recordId, kept, dropped, counts };
}

/** An assertion may feed an evidence item only if both checks passed. UNCHECKED is not support. */
export function isUsable(item: CheckedAssertion): boolean {
  return item.assertion.quoteVerified && item.assertion.supportVerified === "PASS";
}
