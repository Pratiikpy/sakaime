/**
 * B3 and B4: generic Nemotron arms (docs/06 section 4). Same model, same documents, same label definitions as every other arm;
 * no compiler and no identity layer.
 *
 *   B3  one call. All retrieved documents are in the prompt.
 *   B4  a tool-using agent. It can list documents, search them and read a page, then must answer. Same documents, same tools a
 *       reviewer's assistant would have, up to MAX_STEPS tool calls.
 *
 * These calls go through the harness chat port used for the MA-3 comparator, not through the product's client, because the
 * product's 32 KB prompt rule would truncate B3 and the egress policy is built for the product. The records are public FDA documents.
 * Temperature 0, as the product's own roles use. Each (arm, case, run) is cached so a repeat run replays the recorded reply, labelled recorded.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { HarnessChatPort } from "../../src/engines/markovian/ablation/harnessPort.ts";
import { extractJson } from "../../src/models/structured.ts";
import { NEMOTRON_LIGHTNING } from "../../src/models/roles.ts";
import { NVIDIA_DEFAULT_BASE_URL } from "../../src/models/nvidia.ts";
import { readEnvFile } from "../../src/models/stack.ts";
import { LABELS } from "../../src/schemas/common.ts";
import type { ModelPort } from "../../src/ports/index.ts";
import { PortError } from "../../src/ports/index.ts";
import { ROOT, RESULTS_DIR, quoteInText, sha256 } from "./core.ts";
import type { ArmInput } from "./cases.ts";
import type { Doc } from "./documents.ts";
import type { ArmOutput, Label } from "./types.ts";

export const MODEL = NEMOTRON_LIGHTNING;
export const MAX_STEPS = 8;
export const OBSERVATION_CHARS = 6000;
export const PAGE_CHARS = 5000;

export const SYSTEM_PROMPT = `You are an evidence reviewer for a hospital AI-evaluation committee. A reviewer states a CLAIM about how a medical AI product would be used. You are given RECORDS (regulator documents, registry records, publications). Decide whether the records support exactly that use.

Answer with ONE JSON object and nothing else:
{"label": "<one of the five labels>", "mismatches": [{"dimension": "product|version|population|setting|purpose|timing|metric", "claimed": "<what the claim asks for>", "established": "<what the records establish>", "quote": "<a verbatim passage copied from the records that shows it>"}], "supportedScope": "<only for SUPPORTED_ONLY_FOR_NARROWER_SCOPE: the part that is covered>", "reason": "<one or two sentences>"}

The five labels, and the only ones you may use:
- SUPPORTED_FOR_SCOPE: every aspect of the use the claim states (product and software version, population, care setting, purpose, dates) lies inside what the records establish for THIS product and version.
- SUPPORTED_ONLY_FOR_NARROWER_SCOPE: a defined part of the claimed use is covered and the rest is wider than the records; say which part in supportedScope.
- CONTRADICTED_BY_SPECIFIED_EVIDENCE: the records state a limit, an exclusion, a "not intended" statement, a date or a result that the claim exceeds or contradicts.
- INSUFFICIENT_EVIDENCE: the records do not establish a stated aspect (it is not mentioned, or the records concern another version, product, population, setting or purpose).
- REQUIRES_DOMAIN_REVIEW: the question needs a judgement the records do not settle, or the hospital policy below says it must go to a reviewer.

Rules:
- Only what the claim states is in play. An aspect the claim does not state is not asserted.
- Unknown is never "supported". If the records are silent on a stated aspect, that aspect is not covered.
- Records about a different product, a different version or a different study of a shared brand name are not evidence for this claim.
- A version string that belongs to a predicate device or to another product is not the version of the product in the claim.
- List every aspect that is not covered in "mismatches", with a verbatim quote that shows the records' side. For a supported claim use an empty list.
- Never write "safe", "cleared" or "compliant" as a conclusion. Use only the five labels.`;

export function claimBlock(c: ArmInput): string {
  const policy = c.policy?.stalenessWindowDays
    ? `\nHOSPITAL POLICY: evidence that is more than ${c.policy.stalenessWindowDays} days older than the date a use begins must go to a reviewer.`
    : `\nHOSPITAL POLICY: evidence that is more than ${DEFAULT_WINDOW} days older than the date a use begins must go to a reviewer.`;
  return `CLAIM (text): ${c.text}\nCLAIMED USE (structured): ${JSON.stringify(c.claim.use)}${c.claim.performance ? `\nCLAIMED PERFORMANCE: ${JSON.stringify(c.claim.performance)}` : ""}${policy}`;
}

const DEFAULT_WINDOW = 1095;

export function renderDocs(docs: readonly Doc[]): string {
  return docs.map((d) => `=== RECORD ${d.id}: ${d.label} ===\n${d.text.replace(/\f/g, "\n\n--- page break ---\n\n")}`).join("\n\n");
}

export function b3Prompt(c: ArmInput, docs: readonly Doc[]): { system: string; user: string } {
  return { system: SYSTEM_PROMPT, user: `${claimBlock(c)}\n\nRECORDS:\n${renderDocs(docs)}\n\nReturn the JSON object.` };
}

// ------------------------------------------------------------------------------------------ answer parsing

export interface ParsedAnswer {
  label: Label | null;
  mismatches: { dimension: string; claimed?: string; established?: string; quote?: string }[];
  problem?: string;
}

export function parseAnswer(text: string): ParsedAnswer {
  const ex = extractJson(text);
  if (!ex.ok) return { label: null, mismatches: [], problem: `no JSON: ${ex.message}` };
  const v = ex.value as Record<string, unknown>;
  if (!v || typeof v !== "object" || Array.isArray(v)) return { label: null, mismatches: [], problem: "the JSON is not an object" };
  const label = typeof v["label"] === "string" ? (v["label"] as string).trim() : "";
  if (!(LABELS as readonly string[]).includes(label)) return { label: null, mismatches: [], problem: `label "${label.slice(0, 60)}" is not one of the five` };
  const raw = Array.isArray(v["mismatches"]) ? (v["mismatches"] as unknown[]) : [];
  const mismatches = raw
    .filter((m): m is Record<string, unknown> => !!m && typeof m === "object")
    .map((m) => ({
      dimension: String(m["dimension"] ?? "").trim().toLowerCase(),
      ...(typeof m["claimed"] === "string" ? { claimed: m["claimed"] as string } : {}),
      ...(typeof m["established"] === "string" ? { established: m["established"] as string } : {}),
      ...(typeof m["quote"] === "string" ? { quote: m["quote"] as string } : {}),
    }));
  return { label: label as Label, mismatches };
}

/** A quote counts as an anchor only if it exists, verbatim after whitespace collapse, in a record the arm was given. */
export function toOutput(parsed: ParsedAnswer, docs: readonly Doc[]): ArmOutput {
  if (parsed.label === null) return { label: null, status: "none", mismatches: [], detail: parsed.problem ?? "no answer" };
  return {
    label: parsed.label,
    status: "ok",
    mismatches: parsed.mismatches.map((m) => ({
      dimension: m.dimension,
      ...(m.claimed ? { claimed: m.claimed } : {}),
      ...(m.established ? { established: m.established } : {}),
      anchored: !!m.quote && m.quote.trim().length >= 12 && docs.some((d) => quoteInText(m.quote as string, d.text)),
    })),
    citations: parsed.mismatches.flatMap((m) => (m.quote ? [m.quote] : [])),
  };
}

// ------------------------------------------------------------------------------------------ port and cache

export function liveKey(): string | undefined {
  const env = readEnvFile(join(ROOT, ".env"));
  // The repository .env wins over the shell: a stale NVIDIA_API_KEY in the shell environment returned HTTP 403 on 2026-10-27 while the file key worked.
  return env["NVIDIA_API_KEY"] ?? process.env["NVIDIA_API_KEY"];
}

export function livePort(): ModelPort | undefined {
  const apiKey = liveKey();
  if (!apiKey) return undefined;
  return new HarnessChatPort({ apiKey, baseUrl: NVIDIA_DEFAULT_BASE_URL, model: MODEL, timeoutMs: 240_000, minGapMs: Number(process.env["EVAL_MODEL_GAP_MS"] ?? 3000) });
}

const CACHE_DIR = join(RESULTS_DIR, "model-runs");
// The free tier shares one rate limit with every other process using the key; on 2026-10-27 it allowed about two calls a minute.
const RETRY_WAITS_MS = [10_000, 20_000, 40_000, 60_000, 90_000, 120_000, 180_000, 240_000, 300_000, 300_000];

interface CacheLine {
  key: string;
  arm: string;
  caseId: string;
  run: number;
  model: string;
  promptSha: string;
  reply: string;
  promptTokens?: number;
  completionTokens?: number;
  at: string;
}

function cachePath(arm: string, dir: string): string {
  return join(dir, `${arm}.jsonl`);
}

function loadCache(arm: string, dir: string): Map<string, CacheLine> {
  const map = new Map<string, CacheLine>();
  const p = cachePath(arm, dir);
  if (!existsSync(p)) return map;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as CacheLine;
    // The earliest recorded reply for a key is the one used, so a replay is the same whatever lines were appended later.
    if (!map.has(row.key)) map.set(row.key, row);
  }
  return map;
}

export interface CallRecord {
  recorded: boolean;
  promptTokens?: number;
  completionTokens?: number;
  promptBytes: number;
}

export class CachedModel {
  private cache: Map<string, CacheLine>;
  calls = 0;
  replays = 0;
  retries = 0;
  tokens = { prompt: 0, completion: 0, unmeasured: 0 };
  constructor(
    private readonly arm: string,
    private readonly port: ModelPort | undefined,
    private readonly mode: "live" | "recorded-only" = "live",
    private readonly cacheDir: string = CACHE_DIR,
  ) {
    mkdirSync(cacheDir, { recursive: true });
    this.cache = loadCache(arm, cacheDir);
  }

  async ask(caseId: string, run: number, step: number, system: string, user: string): Promise<{ text: string; recorded: boolean }> {
    const promptSha = sha256(system + "\u0000" + user);
    const key = `${this.arm}|${caseId}|${run}|${step}|${promptSha.slice(0, 16)}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.replays++;
      return { text: hit.reply, recorded: true };
    }
    if (this.mode === "recorded-only" || !this.port) throw new PortError("UNAVAILABLE", `no recorded reply for ${key} and no live model is available`);
    // Transient transport failures (HTTP 429, 5xx, timeouts) are retried with backoff; the question is not re-asked for a different answer.
    let res: Awaited<ReturnType<ModelPort["complete"]>> | undefined;
    for (let attempt = 0; attempt <= RETRY_WAITS_MS.length; attempt++) {
      try {
        res = await this.port.complete({
          role: "evaluation-baseline",
          system,
          user,
          maxTokens: 1800,
          dataClass: "public",
          memoryScope: `${this.arm}-${caseId}-${run}-${step}-${promptSha.slice(0, 8)}-${attempt}`,
          timeoutMs: 240_000,
        });
        break;
      } catch (err) {
        const transient = err instanceof PortError && err.failure === "UNAVAILABLE";
        if (!transient || attempt === RETRY_WAITS_MS.length) throw err;
        this.retries++;
        await new Promise((r) => setTimeout(r, RETRY_WAITS_MS[attempt]));
      }
    }
    if (!res) throw new PortError("UNAVAILABLE", "no reply");
    this.calls++;
    if (res.usage.measured) {
      this.tokens.prompt += res.usage.promptTokens ?? 0;
      this.tokens.completion += res.usage.completionTokens ?? 0;
    } else this.tokens.unmeasured++;
    const line: CacheLine = {
      key,
      arm: this.arm,
      caseId,
      run,
      model: res.routedModel,
      promptSha,
      reply: res.text,
      ...(res.usage.promptTokens !== undefined ? { promptTokens: res.usage.promptTokens } : {}),
      ...(res.usage.completionTokens !== undefined ? { completionTokens: res.usage.completionTokens } : {}),
      at: new Date().toISOString(),
    };
    appendFileSync(cachePath(this.arm, this.cacheDir), JSON.stringify(line) + "\n");
    this.cache.set(key, line);
    return { text: res.text, recorded: false };
  }
}

// ------------------------------------------------------------------------------------------ B3

export async function runB3(model: CachedModel, c: ArmInput, docs: readonly Doc[], run: number): Promise<ArmOutput> {
  const { system, user } = b3Prompt(c, docs);
  try {
    const { text } = await model.ask(c.id, run, 0, system, user);
    return toOutput(parseAnswer(text), docs);
  } catch (err) {
    return unavailable(err);
  }
}

export function unavailable(err: unknown): ArmOutput {
  const detail = err instanceof PortError ? `${err.failure}: ${err.message}` : err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  return { label: null, status: "unavailable", mismatches: [], detail: detail.slice(0, 300) };
}

// ------------------------------------------------------------------------------------------ B4

export const B4_SYSTEM = `${SYSTEM_PROMPT}

You do not have the records in front of you. You have three tools. Reply with ONE JSON object per turn and nothing else. To use a tool:
{"action": "list"}                                  lists the records with their ids and page counts
{"action": "search", "query": "<words>"}            returns up to 5 passages that contain the words, with record id and page
{"action": "read", "record": "<id>", "page": <n>}  returns the text of one page (pages count from 1)
When you have enough, give the final answer in the format above, with "action": "answer" added as the first key. You have at most ${MAX_STEPS} tool calls; after that you must answer.`;

interface PageIndex {
  doc: Doc;
  pages: string[];
}

function pagesOf(doc: Doc): string[] {
  if (doc.kind === "fda-summary") {
    const byForm = doc.text.split("\f");
    return byForm.length > 1 ? byForm : chunk(doc.text, PAGE_CHARS);
  }
  return chunk(doc.text, PAGE_CHARS);
}

function chunk(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out.length ? out : [""];
}

const wordsOf = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9.]+/).filter((w) => w.length > 2);

export function searchPassages(index: readonly PageIndex[], query: string, limit = 5): string {
  const q = [...new Set(wordsOf(query))];
  if (q.length === 0) return "no searchable words in the query";
  const scored: { score: number; id: string; page: number; text: string }[] = [];
  for (const { doc, pages } of index) {
    pages.forEach((p, i) => {
      const lower = p.toLowerCase();
      const hits = q.filter((w) => lower.includes(w));
      if (hits.length === 0) return;
      // The densest 700-character window around the first hit is returned, not the whole page.
      const at = lower.indexOf(hits[0] as string);
      const start = Math.max(0, at - 250);
      scored.push({ score: hits.length / q.length + hits.length * 0.001, id: doc.id, page: i + 1, text: p.slice(start, start + 700).replace(/\s+/g, " ") });
    });
  }
  scored.sort((a, b) => b.score - a.score);
  if (scored.length === 0) return "no passage contains any of those words";
  return scored.slice(0, limit).map((s) => `[${s.id} page ${s.page}] ${s.text}`).join("\n\n");
}

export async function runB4(model: CachedModel, c: ArmInput, docs: readonly Doc[], run: number): Promise<ArmOutput & { steps: number }> {
  const index: PageIndex[] = docs.map((doc) => ({ doc, pages: pagesOf(doc) }));
  let transcript = "";
  let tools = 0;
  for (let step = 0; step <= MAX_STEPS + 1; step++) {
    const forced = tools >= MAX_STEPS;
    const user = `${claimBlock(c)}\n\n${transcript ? `STEPS SO FAR:\n${transcript}\n\n` : ""}${forced ? "You have used all tool calls. Give the final answer now." : "Next action (JSON)."}`;
    let text: string;
    try {
      ({ text } = await model.ask(c.id, run, step, B4_SYSTEM, user));
    } catch (err) {
      return { ...unavailable(err), steps: tools };
    }
    const ex = extractJson(text);
    const v = ex.ok && ex.value && typeof ex.value === "object" ? (ex.value as Record<string, unknown>) : undefined;
    const action = typeof v?.["action"] === "string" ? (v["action"] as string) : v && "label" in v ? "answer" : "";
    if (action === "answer" || (v && "label" in v)) return { ...toOutput(parseAnswer(text), docs), steps: tools };
    if (forced) return { label: null, status: "none", mismatches: [], detail: "no final answer after the tool budget", steps: tools };
    let obs: string;
    if (action === "list") obs = index.map((i) => `${i.doc.id}: ${i.doc.label}, ${i.pages.length} pages`).join("\n");
    else if (action === "search") obs = searchPassages(index, String(v?.["query"] ?? ""));
    else if (action === "read") {
      const rec = index.find((i) => i.doc.id === String(v?.["record"] ?? ""));
      const page = Number(v?.["page"]);
      obs = !rec ? `no record with that id; ids are ${index.map((i) => i.doc.id).join(", ")}` : !Number.isInteger(page) || page < 1 || page > rec.pages.length ? `${rec.doc.id} has pages 1 to ${rec.pages.length}` : (rec.pages[page - 1] as string).slice(0, OBSERVATION_CHARS);
    } else obs = "not a valid action; use list, search, read or answer";
    tools++;
    transcript += `STEP ${tools}: ${JSON.stringify(v ?? { unparsed: text.slice(0, 120) })}\nRESULT: ${obs.slice(0, OBSERVATION_CHARS)}\n\n`;
  }
  return { label: null, status: "none", mismatches: [], detail: "loop ended without an answer", steps: tools };
}

export const PROMPT_HASH = createHash("sha256").update(SYSTEM_PROMPT + B4_SYSTEM + String(MAX_STEPS) + String(OBSERVATION_CHARS) + String(PAGE_CHARS) + MODEL).digest("hex");
