/**
 * MA-3: does the Markovian reader reach a scope restriction that sits deep in a long document, and at what
 * context cost, compared with one truncated prompt and one full-context prompt?
 *
 * Arms (each reads the same constructed documents with the same instructions, the same output schema and the
 * same verification, so only the way the text reaches the model differs):
 *   markovian              chunked read with the verified-ledger carryover
 *   markovian_ids          the same, with the carryover listing recorded facts by id, field and page but not by value
 *   markovian_no_carryover chunked read, carryover withheld (isolates what the carryover itself adds)
 *   single_truncated       one prompt, document cut at the product's prompt limit
 *   single_full            one prompt with the whole document, only when it fits fullContextMaxBytes
 *
 * A failed model call is reported as a failure, never as a miss: recall is shown over all documents (failure
 * counts as not found) and over the documents the arm completed.
 */
import type { ModelPort } from "../../../ports/index.ts";
import type { DataClass } from "../../../schemas/common.ts";
import { Reader, READER_GOAL, READER_INSTRUCTIONS, READER_SYSTEM_PROMPT } from "../reader.ts";
import { FactLedger, factsDropped, type LedgerFact } from "../ledger.ts";
import { MODEL_OUTPUT_JSON_SCHEMA, parseModelOutput } from "../facts.ts";
import { buildPrompt } from "../prompt.ts";
import { MAX_PROMPT_BYTES, estimateTokens, type ChunkConfig } from "../types.ts";
import { PortError } from "../../../ports/index.ts";
import type { SyntheticDocument } from "./corpus.ts";
import { fmtRate, mean, wilson } from "./stats.ts";

export const ARMS = ["markovian", "markovian_ids", "markovian_no_carryover", "single_truncated", "single_full"] as const;
export type ArmName = (typeof ARMS)[number];

export interface DocResult {
  docId: string;
  arm: ArmName;
  status: "OK" | "FAILED" | "NOT_RUN";
  reason?: string;
  restrictionFound: boolean;
  /** The restriction's text was extracted but anchored to another page. */
  restrictionElsewhere: boolean;
  plantedFound: number;
  plantedTotal: number;
  /** Restriction-type facts anchored on a decoy page. */
  decoyHits: number;
  factsVerified: number;
  dropped: number;
  calls: number;
  promptTokensTotal: number;
  promptTokensPeak: number;
  promptBytesPeak: number;
  tokenLabel: "measured" | "estimated";
  wallMs: number;
}

export interface ArmSummary {
  arm: ArmName;
  documents: number;
  completed: number;
  failed: number;
  notRun: number;
  restrictionRecallAll: ReturnType<typeof wilson>;
  restrictionRecallCompleted: ReturnType<typeof wilson>;
  restrictionElsewhere: number;
  plantedFactRecall: ReturnType<typeof wilson>;
  decoyHits: number;
  meanPromptTokensTotal: number;
  meanPromptTokensPeak: number;
  meanPromptBytesPeak: number;
  tokenLabel: "measured" | "estimated" | "mixed";
  meanCalls: number;
}

export interface MA3Report {
  generatedAt: string;
  corpus: { documents: number; pages: number; meanBytes: number; constructed: true; seeds: number[] };
  model: { label: string; live: boolean };
  config: { chunk: Partial<ChunkConfig>; truncateBytes: number; fullContextMaxBytes: number };
  results: DocResult[];
  summaries: ArmSummary[];
}

export interface MA3Options {
  model: ModelPort;
  modelLabel: string;
  live: boolean;
  documents: SyntheticDocument[];
  arms?: ArmName[];
  chunk?: Partial<ChunkConfig>;
  /** Bytes the truncated arm may send. Default: the product limit less the fixed framing. */
  truncateBytes?: number;
  /** The full-context arm is not run for documents larger than this. */
  fullContextMaxBytes?: number;
  role?: string;
  dataClass?: DataClass;
  retryDelayMs?: number;
  clock?: () => Date;
  onProgress?: (line: string) => void;
  /** Called with each per-document result as soon as it exists, so a long run leaves a record if it is interrupted. */
  onResult?: (result: DocResult) => void;
}

const RESTRICTION_FIELDS = new Set(["limitation", "population_exclusion", "age_range"]);
const flat = (s: string): string => s.toLowerCase().replace(/,/g, "");

export function scoreFacts(doc: SyntheticDocument, facts: ReadonlyArray<LedgerFact>): Pick<DocResult, "restrictionFound" | "restrictionElsewhere" | "plantedFound" | "plantedTotal" | "decoyHits"> {
  const textOf = (f: LedgerFact, page: number): string => flat(`${f.value} ${f.anchors.filter((a) => a.page === page).map((a) => a.quote).join(" ")}`);
  const hasKeys = (t: string, keys: string[]): boolean => keys.every((k) => t.includes(flat(k)));
  const r = doc.restriction;
  const restrictionFound = facts.some((f) => hasKeys(textOf(f, r.page), r.keys) && f.anchors.some((a) => a.page === r.page));
  const restrictionElsewhere =
    !restrictionFound && facts.some((f) => f.anchors.some((a) => a.page !== r.page && !doc.decoyPages.includes(a.page) && hasKeys(flat(`${f.value} ${a.quote}`), r.keys) && RESTRICTION_FIELDS.has(f.field)));
  const plantedFound = doc.planted.filter((p) => facts.some((f) => f.field === p.field && f.anchors.some((a) => a.page === p.page) && hasKeys(textOf(f, p.page), p.keys))).length;
  const decoyHits = facts.filter((f) => RESTRICTION_FIELDS.has(f.field) && f.anchors.some((a) => doc.decoyPages.includes(a.page))).length;
  return { restrictionFound, restrictionElsewhere, plantedFound, plantedTotal: doc.planted.length, decoyHits };
}

function cutToBytes(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid), "utf8") <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

interface SinglePassOutcome {
  facts: LedgerFact[];
  dropped: number;
  promptTokens: number;
  promptBytes: number;
  measured: boolean;
}

async function singlePass(o: MA3Options, doc: SyntheticDocument, maxBytes: number | undefined): Promise<SinglePassOutcome> {
  const whole = doc.pages.map((p) => `[PAGE ${p.page}]\n${p.text.trim()}`).join("\n\n");
  const text = maxBytes === undefined ? whole : cutToBytes(whole, maxBytes);
  const shown = doc.pages.filter((p) => text.includes(`[PAGE ${p.page}]\n`)).map((p) => p.page);
  const prompt = buildPrompt({
    mode: "DOCUMENT",
    goal: READER_GOAL,
    step: 1,
    totalSteps: 1,
    carryover: "",
    overlapText: "",
    attachments: [],
    input: { label: shown.length ? `pages ${shown[0]}-${shown[shown.length - 1]}` : "no pages", text },
    instructions: READER_INSTRUCTIONS,
  });
  const attempts = 3;
  let last: unknown;
  for (let a = 1; a <= attempts; a++) {
    try {
      const resp = await o.model.complete({
        role: o.role ?? "extractor",
        system: READER_SYSTEM_PROMPT,
        user: prompt,
        jsonSchema: MODEL_OUTPUT_JSON_SCHEMA,
        maxTokens: 2400,
        dataClass: o.dataClass ?? "public",
        memoryScope: `${doc.id}:single:${maxBytes ?? "full"}:${a}:${Math.random().toString(36).slice(2, 10)}`,
      });
      const parsed = parseModelOutput(typeof resp.json === "object" && resp.json !== null ? JSON.stringify(resp.json) : resp.text);
      if (!parsed) throw new PortError("INVALID", "the reply did not contain a facts array");
      const ledger = new FactLedger(new Map(doc.pages.map((p) => [p.page, p.text] as const)));
      ledger.ingest(parsed.facts, parsed.definitions, { step: 1, shownPages: shown });
      const bytes = Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(READER_SYSTEM_PROMPT, "utf8");
      const measured = resp.usage.measured && resp.usage.promptTokens !== undefined;
      return {
        facts: [...ledger.facts],
        dropped: factsDropped(ledger.drops),
        promptTokens: measured ? (resp.usage.promptTokens as number) : estimateTokens(prompt) + estimateTokens(READER_SYSTEM_PROMPT),
        promptBytes: bytes,
        measured,
      };
    } catch (err) {
      last = err;
      const retry = err instanceof PortError && (err.failure === "UNAVAILABLE" || err.failure === "TRUNCATED" || err.failure === "INVALID");
      if (!retry || a === attempts) break;
      await new Promise((r) => setTimeout(r, (o.retryDelayMs ?? 1000) * a));
    }
  }
  throw last;
}

export async function runArm(o: MA3Options, arm: ArmName, doc: SyntheticDocument): Promise<DocResult> {
  const blank = (status: DocResult["status"], reason?: string): DocResult => ({
    docId: doc.id, arm, status, reason, restrictionFound: false, restrictionElsewhere: false, plantedFound: 0, plantedTotal: doc.planted.length,
    decoyHits: 0, factsVerified: 0, dropped: 0, calls: 0, promptTokensTotal: 0, promptTokensPeak: 0, promptBytesPeak: 0, tokenLabel: "estimated", wallMs: 0,
  });
  const t0 = Date.now();
  try {
    if (arm === "markovian" || arm === "markovian_ids" || arm === "markovian_no_carryover") {
      const reader = new Reader({
        model: o.model,
        config: o.chunk,
        role: o.role,
        dataClass: o.dataClass,
        carryover: arm === "markovian" ? "ledger" : arm === "markovian_ids" ? "ids" : "none",
        retryDelayMs: o.retryDelayMs ?? 1000,
      });
      const out = await reader.read({ documentId: doc.id, pages: doc.pages });
      if (out.status === "FAILED") return { ...blank("FAILED", "every chunk failed"), calls: out.calls.length, wallMs: Date.now() - t0 };
      const acc = out.run.accounting;
      return {
        ...blank("OK"),
        ...scoreFacts(doc, out.facts),
        reason: out.status === "PARTIAL" ? `partial: ${out.coverage.chunksFailed} of ${out.coverage.chunks} chunks failed, ${out.salvagedChunks.length} replies cut off` : undefined,
        factsVerified: out.facts.length,
        dropped: factsDropped(out.dropped),
        calls: out.calls.length,
        promptTokensTotal: acc.promptTokensTotal,
        promptTokensPeak: acc.peakPromptTokens,
        promptBytesPeak: acc.peakPromptBytes,
        tokenLabel: out.run.tokenLabel,
        wallMs: Date.now() - t0,
      };
    }
    if (arm === "single_full" && doc.bytes > (o.fullContextMaxBytes ?? 120_000)) {
      return blank("NOT_RUN", `document is ${doc.bytes} bytes, over the ${o.fullContextMaxBytes ?? 120_000}-byte full-context limit set for this run`);
    }
    const framing = Buffer.byteLength(READER_INSTRUCTIONS, "utf8") + Buffer.byteLength(READER_SYSTEM_PROMPT, "utf8") + 1200;
    const cut = arm === "single_truncated" ? (o.truncateBytes ?? MAX_PROMPT_BYTES - framing) : undefined;
    const s = await singlePass(o, doc, cut);
    return {
      ...blank("OK"),
      ...scoreFacts(doc, s.facts),
      factsVerified: s.facts.length,
      dropped: s.dropped,
      calls: 1,
      promptTokensTotal: s.promptTokens,
      promptTokensPeak: s.promptTokens,
      promptBytesPeak: s.promptBytes,
      tokenLabel: s.measured ? "measured" : "estimated",
      wallMs: Date.now() - t0,
    };
  } catch (err) {
    return { ...blank("FAILED", (err as Error).message), wallMs: Date.now() - t0 };
  }
}

export function summarise(arm: ArmName, results: DocResult[]): ArmSummary {
  const rs = results.filter((r) => r.arm === arm);
  const ok = rs.filter((r) => r.status === "OK");
  const labels = new Set(ok.map((r) => r.tokenLabel));
  return {
    arm,
    documents: rs.length,
    completed: ok.length,
    failed: rs.filter((r) => r.status === "FAILED").length,
    notRun: rs.filter((r) => r.status === "NOT_RUN").length,
    restrictionRecallAll: wilson(ok.filter((r) => r.restrictionFound).length, rs.filter((r) => r.status !== "NOT_RUN").length),
    restrictionRecallCompleted: wilson(ok.filter((r) => r.restrictionFound).length, ok.length),
    restrictionElsewhere: ok.filter((r) => r.restrictionElsewhere).length,
    plantedFactRecall: wilson(ok.reduce((s, r) => s + r.plantedFound, 0), ok.reduce((s, r) => s + r.plantedTotal, 0)),
    decoyHits: ok.reduce((s, r) => s + r.decoyHits, 0),
    meanPromptTokensTotal: mean(ok.map((r) => r.promptTokensTotal)),
    meanPromptTokensPeak: mean(ok.map((r) => r.promptTokensPeak)),
    meanPromptBytesPeak: mean(ok.map((r) => r.promptBytesPeak)),
    tokenLabel: labels.size === 0 ? "estimated" : labels.size === 1 ? ([...labels][0] as "measured" | "estimated") : "mixed",
    meanCalls: mean(ok.map((r) => r.calls)),
  };
}

export async function runMA3(o: MA3Options): Promise<MA3Report> {
  const arms = o.arms ?? [...ARMS];
  const results: DocResult[] = [];
  for (const doc of o.documents) {
    for (const arm of arms) {
      const r = await runArm(o, arm, doc);
      results.push(r);
      o.onResult?.(r);
      o.onProgress?.(`${doc.id} ${arm}: ${r.status}${r.status === "OK" ? ` restriction=${r.restrictionFound} peakPromptTokens=${r.promptTokensPeak}` : r.reason ? ` (${r.reason})` : ""}`);
    }
  }
  const truncateBytes = o.truncateBytes ?? MAX_PROMPT_BYTES - (Buffer.byteLength(READER_INSTRUCTIONS, "utf8") + Buffer.byteLength(READER_SYSTEM_PROMPT, "utf8") + 1200);
  return {
    generatedAt: (o.clock?.() ?? new Date()).toISOString(),
    corpus: {
      documents: o.documents.length,
      pages: o.documents[0]?.pages.length ?? 0,
      meanBytes: Math.round(mean(o.documents.map((d) => d.bytes))),
      constructed: true,
      seeds: o.documents.map((d) => d.seed),
    },
    model: { label: o.modelLabel, live: o.live },
    config: { chunk: o.chunk ?? {}, truncateBytes, fullContextMaxBytes: o.fullContextMaxBytes ?? 120_000 },
    results,
    summaries: arms.map((a) => summarise(a, results)),
  };
}

export function formatMA3(report: MA3Report): string {
  const lines: string[] = [];
  lines.push(`MA-3 planted-restriction ablation (${report.model.live ? "LIVE model" : "TEST DOUBLE: validates the harness, measures no model"}: ${report.model.label})`);
  lines.push(`corpus: ${report.corpus.documents} constructed documents, ${report.corpus.pages} pages, mean ${report.corpus.meanBytes} bytes; truncation limit ${report.config.truncateBytes} bytes`);
  for (const s of report.summaries) {
    lines.push("");
    lines.push(`${s.arm}: completed ${s.completed}/${s.documents}, failed ${s.failed}, not run ${s.notRun}`);
    lines.push(`  restriction recall, all documents: ${fmtRate(s.restrictionRecallAll)}`);
    lines.push(`  restriction recall, completed only: ${fmtRate(s.restrictionRecallCompleted)}; found only on another page: ${s.restrictionElsewhere}`);
    lines.push(`  planted-fact recall: ${fmtRate(s.plantedFactRecall)}; decoy confusions: ${s.decoyHits}`);
    lines.push(`  context cost (${s.tokenLabel}): mean total prompt tokens ${Math.round(s.meanPromptTokensTotal)}, mean peak per call ${Math.round(s.meanPromptTokensPeak)}, peak bytes ${Math.round(s.meanPromptBytesPeak)}, calls ${s.meanCalls.toFixed(1)}`);
  }
  return lines.join("\n");
}
