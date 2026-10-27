import { createHash } from "node:crypto";
import type { Attachment, ChunkConfig, Mode, StepInput } from "./types.ts";

export const MARKER_RULES =
  "End every chunk except the last with [STATE_CHECKPOINT] followed by a concise state block:\n" +
  "COMPLETED: ...\nREMAINING: ...\nDECISIONS: ...\nCONTEXT: ...\n" +
  "End the final chunk with [TASK_COMPLETE]. Use exactly one marker per chunk and never describe the markers.";

export interface PromptArgs {
  mode: Mode;
  goal: string;
  /** 1-based. */
  step: number;
  /** Total steps when known (document mode). */
  totalSteps?: number;
  carryover: string;
  /** Pre-sliced overlap text; empty when overlapTokens is 0. */
  overlapText: string;
  memoryContext?: string;
  attachments: Attachment[];
  input?: StepInput;
  instructions?: string;
}

/** Truncate a goal for continuation steps, on a word boundary where one exists. */
export function truncateGoal(goal: string, max = 200): string {
  if (goal.length <= max) return goal;
  const cut = goal.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return `${space > max * 0.6 ? cut.slice(0, space) : cut}...`;
}

/**
 * A boundary that text inside a document cannot forge: it is derived from the text itself and the step, so a
 * document that tried to close the block early would have to contain the hash of its own content.
 */
export function boundaryFor(step: number, text: string): string {
  return createHash("sha256").update(`${step}\n${text}`).digest("hex").slice(0, 12);
}

export function buildPrompt(a: PromptArgs): string {
  const parts: string[] = [];
  const first = a.step === 1;
  if (first && a.memoryContext) parts.push(a.memoryContext.trim(), "");

  if (a.mode === "DOCUMENT") {
    const of = a.totalSteps ? ` of ${a.totalSteps}` : "";
    parts.push(first ? `Reading a long document in bounded chunks (step ${a.step}${of}).` : `Continuing a chunked document read (step ${a.step}${of}).`);
    parts.push(`Task${first ? "" : " (truncated)"}: ${first ? a.goal : truncateGoal(a.goal)}`);
    parts.push("", `[CARRYOVER STATE]\n${a.carryover || "(none yet: this is the first chunk)"}`);
    if (a.overlapText) parts.push("", `[OVERLAP]\n${a.overlapText}`);
    if (a.input) {
      const b = boundaryFor(a.step, a.input.text);
      parts.push("", `[DOCUMENT CHUNK ${a.step}${of} | ${a.input.label} | boundary ${b}]`, `<<<${b}`, a.input.text, `>>>${b}`);
    }
  } else if (first) {
    parts.push(
      a.mode === "ARCHITECT"
        ? "You are executing a long build task in bounded chunks. Analyse the goal, produce a plan and start the work."
        : "You are executing recursive research in bounded chunks. Log every action as '>> action' and keep a short state snapshot.",
    );
    parts.push("", `User Request: ${a.goal}`);
    for (const att of a.attachments) parts.push("", `[ATTACHMENT ${att.name}]\n${att.content}`);
  } else {
    parts.push(`Continuing a chunked ${a.mode.toLowerCase()} run. Goal (truncated): ${truncateGoal(a.goal)}`);
    parts.push("", `[CARRYOVER STATE]\n${a.carryover}`);
    if (a.overlapText) parts.push("", `[OVERLAP]\n${a.overlapText}`);
    parts.push("", "Continue exactly where the state leaves off. Do not repeat completed work.");
  }

  parts.push("", a.instructions ?? MARKER_RULES);
  return parts.join("\n");
}

/** The final overlapTokens*4 characters of the previous text, or nothing when overlap is off. */
export function overlapSlice(previous: string, config: ChunkConfig): string {
  if (config.overlapTokens <= 0 || !previous) return "";
  return previous.slice(-config.overlapTokens * 4);
}

// ---------------------------------------------------------------- provider usage

export interface Usage {
  promptTokens: number;
  completionTokens: number;
}

/**
 * Read provider-reported usage out of generator metadata. Accepts the three spellings in common use and
 * nothing else. Returns undefined when usage is absent, negative or not numeric: a number the provider did
 * not report is never invented here.
 */
export function readUsage(metadata: unknown): Usage | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const m = metadata as Record<string, unknown>;
  const u = (m.usage && typeof m.usage === "object" ? m.usage : m) as Record<string, unknown>;
  const pick = (...keys: string[]): number | undefined => {
    for (const k of keys) {
      const v = u[k];
      if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
    }
    return undefined;
  };
  const promptTokens = pick("input_tokens", "prompt_tokens", "promptTokens");
  const completionTokens = pick("output_tokens", "completion_tokens", "completionTokens");
  if (promptTokens === undefined || completionTokens === undefined) return undefined;
  if (m.measured === false) return undefined;
  return { promptTokens, completionTokens };
}
