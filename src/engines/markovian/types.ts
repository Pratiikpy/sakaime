/**
 * Markovian: bounded-carryover chunked reasoning.
 *
 * Shapes follow the engine specification (a run is a sequence of bounded chunks; each chunk sees the goal,
 * a compact carryover state and its own material, never the history). Where the reference implementation
 * falls short, the shapes here carry the missing information: provider-measured token counts, the prompt
 * size actually sent, the carryover size and the cascade level used at every chunk.
 */

export interface ChunkConfig {
  /** Total token budget of one step: framing + carryover + new material + model output. */
  chunkSize: number;
  /** Cap on chain length. */
  maxChunks: number;
  /** Token budget of the state passed from one step to the next. */
  carryoverTokens: number;
  /** Size of the [OVERLAP] window, in tokens, carried from one step to the next. */
  overlapTokens: number;
}

export const DEFAULT_CONFIG: Readonly<ChunkConfig> = Object.freeze({
  chunkSize: 8000,
  maxChunks: 24,
  carryoverTokens: 800,
  overlapTokens: 0,
});

export const BOUNDS = {
  chunkSize: { min: 1000, max: 128000 },
  maxChunks: { min: 1, max: 32 },
  carryoverTokens: { min: 128, max: 32768 },
  overlapTokens: { min: 0, max: 4096 },
} as const;

/** Engine constants from the specification: template overhead and the room kept for the model's answer. */
export const FRAMING_TOKENS = 400;
export const OUTPUT_BUDGET = 1200;

/** No prompt the engine builds may exceed this many UTF-8 bytes (the product rule for every model call). */
export const MAX_PROMPT_BYTES = 32 * 1024;

export type TokenLabel = "estimated" | "measured";

/** Estimator used wherever provider usage is absent. Anything derived from it is labelled "estimated". */
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

export class ConfigValidationError extends Error {
  constructor(
    message: string,
    public readonly field?: keyof ChunkConfig | "maxPromptBytes",
  ) {
    super(`Markovian config: ${message}`);
    this.name = "ConfigValidationError";
  }
}

export class PromptTooLargeError extends Error {
  constructor(
    public readonly bytes: number,
    public readonly limit: number,
    public readonly step: number,
  ) {
    super(`Markovian: the prompt for step ${step} is ${bytes} bytes, over the ${limit}-byte limit`);
    this.name = "PromptTooLargeError";
  }
}

export class CarryoverOverflowError extends Error {
  constructor(
    public readonly tokens: number,
    public readonly budget: number,
    public readonly step: number,
  ) {
    super(`Markovian: the carryover for step ${step} is ${tokens} tokens, over the ${budget}-token budget`);
    this.name = "CarryoverOverflowError";
  }
}

export type Mode = "ARCHITECT" | "RESEARCH" | "DOCUMENT";

/** Which rung of the compression cascade produced the state that leaves a chunk. "reducer" is a caller-owned reducer. */
export type CascadeLevel = "marker" | "llm" | "heuristic" | "truncation" | "reducer";

export interface ChunkInfo {
  /** 1-based step index. */
  id: number;
  /** Tokens of the model's output for this step: provider-reported when measured, ceil(chars/4) otherwise. */
  tokens: number;
  /** State passed INTO this step. */
  carryover: string;
  /** Display-safe output (markers stripped). */
  content: string;
  /** Tokens of the prompt actually sent at this step. */
  promptTokens: number;
  /** Provider-reported (measured) or estimated; applies to promptTokens and tokens together. */
  tokenSource: TokenLabel;
  /** UTF-8 bytes of the prompt plus system prompt actually sent. */
  promptBytes: number;
  /** Estimated size of the state passed in. */
  carryoverInTokens: number;
  /** Estimated size of the state that leaves this step. */
  carryoverOutTokens: number;
  /** Rung of the cascade that produced the outgoing state. */
  cascadeLevel: CascadeLevel;
  /** Name given by a caller-owned reducer when cascadeLevel is "reducer". */
  reducerLabel?: string;
  /** Label of the material this step consumed (document mode). */
  inputLabel?: string;
  /** Present when the model call failed and the run continued (continueOnChunkError). */
  failure?: { message: string; failureClass?: string };
  warnings: string[];
}

export type RunStatus = "completed" | "max-chunks" | "errored" | "aborted";

export interface RunAccounting {
  promptTokensTotal: number;
  completionTokensTotal: number;
  peakPromptTokens: number;
  meanPromptTokens: number;
  peakPromptBytes: number;
  measuredChunks: number;
  estimatedChunks: number;
}

export interface MarkovianRun {
  /** UUID. */
  id: string;
  timestamp: number;
  /** Truncated for storage. */
  prompt: string;
  mode: Mode;
  /** Mandatory per-run snapshot. Efficiency is always computed against it, never against current config. */
  chunkConfig: ChunkConfig;
  chunks: ChunkInfo[];
  totalTokensUsed: number;
  totalTokensSaved: number;
  efficiencyPercent: number;
  durationMs: number;
  status: RunStatus;
  /** "measured" only when every chunk carries provider-reported usage; otherwise "estimated". */
  tokenLabel: TokenLabel;
  accounting: RunAccounting;
  /** Document mode: inputs never reached because the run stopped early. */
  unreadInputs: number;
  /** Chunks whose model call failed after retries and were skipped. */
  failedChunks: number;
  output: string;
  reflection?: string;
  /** Set when the reflection pass failed. The run itself is preserved. */
  reflectionError?: string;
  error?: string;
}

export interface Attachment {
  name: string;
  content: string;
}

export interface GeneratorResult {
  text: string;
  /** Provider usage, read as { usage: { input_tokens | prompt_tokens | promptTokens, ... } }. */
  metadata?: unknown;
}

export type Generator = (
  prompt: string,
  attachments: Attachment[],
  systemPrompt?: string,
  onStream?: (delta: string) => void,
  abortSignal?: AbortSignal,
) => Promise<GeneratorResult>;

export type StepFn = (args: { goal: string; carryover: string; step: number; prompt: string }) => Promise<{ content: string }> | { content: string };

/** One unit of material for document mode. The run takes exactly one input per step. */
export interface StepInput {
  label: string;
  text: string;
}

export interface ReducerArgs {
  step: number;
  input?: StepInput;
  rawOutput: string;
  previousCarryover: string;
  config: ChunkConfig;
  /** Set when the model call for this step failed after retries; the reducer must not treat rawOutput as an answer. */
  failure?: { message: string; failureClass?: string };
}

export interface ReducerResult {
  carryover: string;
  label: string;
  warnings?: string[];
}

/** A caller-owned replacement for the marker/LLM/heuristic/truncation cascade. Must return a state within the budget. */
export type CarryoverReducer = (args: ReducerArgs) => Promise<ReducerResult> | ReducerResult;

export interface RunOptions {
  prompt?: string;
  /** Alias of prompt. */
  goal?: string;
  mode?: Mode;
  stepFn?: StepFn;
  generator?: Generator;
  stopWhen?: (args: { step: number; carryover: string }) => boolean;
  memoryContext?: string;
  attachments?: Attachment[];
  abortSignal?: AbortSignal;
  onStream?: (delta: string) => void;
  /** Default true. Reflection runs once, after a completed run, and can never fail the run. */
  reflect?: boolean;
  /** Document mode: one input per step; the run ends when they are exhausted. */
  inputs?: StepInput[];
  reducer?: CarryoverReducer;
  /** Rules appended to every step's prompt. Defaults to the marker rules. */
  instructions?: string;
  /** System prompt sent with every chunk call. */
  systemPrompt?: string;
  /** Record a failed model call and go on to the next step instead of ending the run. Default false. */
  continueOnChunkError?: boolean;
  /** Called after each chunk is recorded (for traces). An exception thrown here is ignored. */
  onChunk?: (chunk: ChunkInfo) => void;
}

export interface MarkovianOptions {
  chunkConfig?: Partial<ChunkConfig>;
  generator?: Generator;
  compressorFn?: (prompt: string, systemPrompt: string) => Promise<string>;
  /** Milliseconds since epoch. Injected so tests are deterministic. */
  clock?: () => number;
  /** Default MAX_PROMPT_BYTES. */
  maxPromptBytes?: number;
}
