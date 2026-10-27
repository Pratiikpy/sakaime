import { randomUUID } from "node:crypto";
import { CarryoverService } from "./carryover.ts";
import { resolveConfig, runEfficiency } from "./config.ts";
import { cleanMarkers, parseMarkers, type ParsedMarkers } from "./markers.ts";
import { buildPrompt, overlapSlice, readUsage } from "./prompt.ts";
import {
  CarryoverOverflowError,
  ConfigValidationError,
  MAX_PROMPT_BYTES,
  PromptTooLargeError,
  estimateTokens,
  type CascadeLevel,
  type ChunkConfig,
  type ChunkInfo,
  type Generator,
  type MarkovianOptions,
  type MarkovianRun,
  type Mode,
  type RunAccounting,
  type RunOptions,
  type StepFn,
  type TokenLabel,
} from "./types.ts";

const EMPTY_PARSE: ParsedMarkers = { done: false, cleaned: "" };

/**
 * The Markovian chain runner. Each step sends the goal (shortened after step 1), a bounded carryover state and
 * the step's own material; the chain never re-sends its history. What the engine adds to the reference
 * behaviour: provider usage is read and labelled "measured" only when every chunk has it; the prompt size,
 * carryover size and cascade level of every chunk are recorded; a prompt over the byte limit is refused;
 * a caller-owned reducer can replace the cascade (the document reader keeps a verified ledger there).
 */
export class Markovian {
  readonly config: ChunkConfig;
  readonly maxPromptBytes: number;
  private readonly carryoverService: CarryoverService;
  private readonly clock: () => number;
  private readonly defaultGenerator?: Generator;

  constructor(opts: MarkovianOptions = {}) {
    this.config = resolveConfig(opts.chunkConfig);
    const limit = opts.maxPromptBytes ?? MAX_PROMPT_BYTES;
    if (!Number.isInteger(limit) || limit < 2048) throw new ConfigValidationError(`maxPromptBytes=${limit} must be an integer of at least 2048`, "maxPromptBytes");
    this.maxPromptBytes = limit;
    this.clock = opts.clock ?? Date.now;
    this.carryoverService = new CarryoverService(opts.compressorFn);
    this.defaultGenerator = opts.generator;
  }

  async run(options: RunOptions): Promise<MarkovianRun> {
    const goal = options.goal ?? options.prompt;
    if (!goal) throw new TypeError("Markovian: run needs a goal or prompt");
    const inputs = options.inputs;
    const mode: Mode = options.mode ?? (inputs ? "DOCUMENT" : "ARCHITECT");
    const config = this.config;
    const generator = this.normaliseGenerator(options, goal);
    const start = this.clock();

    const run: MarkovianRun = {
      id: randomUUID(),
      timestamp: start,
      prompt: goal.slice(0, 500),
      mode,
      chunkConfig: { ...config },
      chunks: [],
      totalTokensUsed: 0,
      totalTokensSaved: 0,
      efficiencyPercent: 0,
      durationMs: 0,
      status: "completed",
      tokenLabel: "estimated",
      accounting: emptyAccounting(),
      unreadInputs: 0,
      failedChunks: 0,
      output: "",
    };

    const cleanedParts: string[] = [];
    let carryover = "";
    let previousText = "";
    let done = false;

    try {
      while (run.chunks.length < config.maxChunks && !done) {
        if (inputs && run.chunks.length >= inputs.length) break;
        if (options.abortSignal?.aborted) {
          run.status = "aborted";
          break;
        }
        const step = run.chunks.length + 1;
        const input = inputs?.[step - 1];
        const prompt = buildPrompt({
          mode,
          goal,
          step,
          totalSteps: inputs?.length,
          carryover,
          overlapText: overlapSlice(previousText, config),
          memoryContext: options.memoryContext,
          attachments: step === 1 ? (options.attachments ?? []) : [],
          input,
          instructions: options.reducer ? (options.instructions ?? "") : options.instructions,
        });
        const promptBytes = Buffer.byteLength(prompt, "utf8") + Buffer.byteLength(options.systemPrompt ?? "", "utf8");
        if (promptBytes > this.maxPromptBytes) throw new PromptTooLargeError(promptBytes, this.maxPromptBytes, step);

        let text = "";
        let metadata: unknown;
        let failure: ChunkInfo["failure"];
        try {
          const out = await generator(prompt, step === 1 ? (options.attachments ?? []) : [], options.systemPrompt, options.onStream, options.abortSignal);
          text = out.text;
          metadata = out.metadata;
        } catch (err) {
          if (options.abortSignal?.aborted) {
            run.status = "aborted";
            break;
          }
          if (!options.continueOnChunkError) throw err;
          failure = { message: (err as Error).message, failureClass: (err as { failure?: string }).failure };
        }

        const parsed = failure ? EMPTY_PARSE : parseMarkers(text);
        const content = parsed.cleaned;
        const usage = failure ? undefined : readUsage(metadata);
        const tokenSource: TokenLabel = usage ? "measured" : "estimated";
        const warnings: string[] = failure ? ["model-call-failed"] : [];

        let next: { carryover: string; level: CascadeLevel; label?: string };
        if (options.abortSignal?.aborted) {
          run.status = "aborted";
          // The generated chunk is already paid for; keep it, but do not spend on compression.
          pushChunk(run, cleanedParts, {
            id: step, tokens: usage ? usage.completionTokens : estimateTokens(content), carryover, content,
            promptTokens: usage ? usage.promptTokens : estimateTokens(prompt) + estimateTokens(options.systemPrompt ?? ""),
            tokenSource, promptBytes, carryoverInTokens: estimateTokens(carryover), carryoverOutTokens: estimateTokens(carryover),
            cascadeLevel: "truncation", inputLabel: input?.label, failure, warnings: [...warnings, "aborted-before-compression"],
          }, options.onChunk);
          break;
        }

        if (options.reducer) {
          const r = await options.reducer({ step, input, rawOutput: text, previousCarryover: carryover, config, failure });
          const size = estimateTokens(r.carryover);
          if (size > config.carryoverTokens) throw new CarryoverOverflowError(size, config.carryoverTokens, step);
          next = { carryover: r.carryover, level: "reducer", label: r.label };
          warnings.push(...(r.warnings ?? []));
        } else if (failure) {
          next = { carryover, level: "truncation" };
          warnings.push("carryover-unchanged");
        } else {
          const c = await this.carryoverService.next({ markerState: parsed.state, previousCarryover: carryover, chunkText: text, config });
          next = { carryover: c.carryover, level: c.level };
          warnings.push(...c.warnings);
        }

        const chunk: ChunkInfo = {
          id: step,
          tokens: usage ? usage.completionTokens : estimateTokens(content),
          carryover,
          content,
          promptTokens: usage ? usage.promptTokens : estimateTokens(prompt) + estimateTokens(options.systemPrompt ?? ""),
          tokenSource,
          promptBytes,
          carryoverInTokens: estimateTokens(carryover),
          carryoverOutTokens: estimateTokens(next.carryover),
          cascadeLevel: next.level,
          reducerLabel: next.label,
          inputLabel: input?.label,
          failure,
          warnings,
        };
        pushChunk(run, cleanedParts, chunk, options.onChunk);
        carryover = next.carryover;
        previousText = input ? input.text : content;

        if (parsed.done && !inputs) done = true;
        if (!done && !inputs && options.stopWhen?.({ step, carryover })) done = true;
      }

      if (run.status === "completed") {
        const exhausted = inputs ? run.chunks.length >= inputs.length : done;
        if (!exhausted && run.chunks.length >= config.maxChunks) run.status = "max-chunks";
      }
    } catch (err) {
      run.status = "errored";
      run.error = (err as Error).message;
    }

    run.output = cleanedParts.join("\n\n");
    run.failedChunks = run.chunks.filter((c) => c.failure).length;
    run.unreadInputs = inputs ? Math.max(0, inputs.length - run.chunks.length) : 0;
    const eff = runEfficiency(run.chunks, run.chunkConfig);
    run.totalTokensUsed = eff.totalTokensUsed;
    run.totalTokensSaved = eff.tokensSaved;
    run.efficiencyPercent = eff.efficiencyPercent;
    run.accounting = accountingOf(run.chunks);
    run.tokenLabel = run.chunks.length > 0 && run.chunks.every((c) => c.tokenSource === "measured") ? "measured" : "estimated";

    const reflect = options.reflect ?? !inputs;
    if (reflect && run.status === "completed" && run.chunks.length > 0) {
      try {
        const finalState = run.chunks[run.chunks.length - 1]?.carryover ?? "";
        const prompt =
          `Reflect on this completed run.\nGoal: ${goal.slice(0, 200)}\nFinal state: ${finalState}\n` +
          `Output (truncated): ${run.output.slice(0, 4000)}\nVerdict: ratify if the goal is met, otherwise refine with concrete gaps.`;
        const { text } = await generator(prompt, [], "You are the reflection pass. Be brief and concrete.", undefined, options.abortSignal);
        run.reflection = cleanMarkers(text);
      } catch (err) {
        run.reflectionError = (err as Error).message;
      }
    }

    run.durationMs = this.clock() - start;
    return run;
  }

  private normaliseGenerator(options: RunOptions, goal: string): Generator {
    if (options.generator) return options.generator;
    if (options.stepFn) {
      const stepFn: StepFn = options.stepFn;
      let step = 0;
      return async (prompt) => {
        const result = await stepFn({ goal, carryover: carryoverFromPrompt(prompt), step, prompt });
        step += 1;
        return { text: result.content };
      };
    }
    if (this.defaultGenerator) return this.defaultGenerator;
    throw new TypeError("Markovian: provide a generator or a stepFn");
  }
}

function carryoverFromPrompt(prompt: string): string {
  const m = prompt.match(/\[CARRYOVER STATE\]\n([\s\S]*?)(?:\n\n|$)/);
  return m?.[1]?.trim() ?? "";
}

function pushChunk(run: MarkovianRun, parts: string[], chunk: ChunkInfo, onChunk?: (c: ChunkInfo) => void): void {
  run.chunks.push(chunk);
  parts.push(chunk.content);
  if (onChunk) {
    try {
      onChunk(chunk);
    } catch {
      // An observer must not be able to fail the run.
    }
  }
}

function emptyAccounting(): RunAccounting {
  return { promptTokensTotal: 0, completionTokensTotal: 0, peakPromptTokens: 0, meanPromptTokens: 0, peakPromptBytes: 0, measuredChunks: 0, estimatedChunks: 0 };
}

function accountingOf(chunks: ChunkInfo[]): RunAccounting {
  if (chunks.length === 0) return emptyAccounting();
  const promptTokensTotal = chunks.reduce((s, c) => s + c.promptTokens, 0);
  return {
    promptTokensTotal,
    completionTokensTotal: chunks.reduce((s, c) => s + c.tokens, 0),
    peakPromptTokens: Math.max(...chunks.map((c) => c.promptTokens)),
    meanPromptTokens: promptTokensTotal / chunks.length,
    peakPromptBytes: Math.max(...chunks.map((c) => c.promptBytes)),
    measuredChunks: chunks.filter((c) => c.tokenSource === "measured").length,
    estimatedChunks: chunks.filter((c) => c.tokenSource === "estimated").length,
  };
}
