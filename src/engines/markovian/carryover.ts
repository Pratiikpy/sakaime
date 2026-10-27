import { estimateTokens, type CascadeLevel, type ChunkConfig } from "./types.ts";

export interface CarryoverResult {
  carryover: string;
  level: Exclude<CascadeLevel, "reducer">;
  warnings: string[];
}

export type Compressor = (prompt: string, systemPrompt: string) => Promise<string>;

const MIN_STATE_CHARS = 24;
const KEY_PHRASE = /(?:^|\n|\.\s+)((?:Therefore|Key insight|Status|Decision|Decided|Next|Remaining|Completed)[^.\n]*)/gi;

/**
 * The compression cascade, in strict order. Each rung falls through on failure so the chain survives an
 * unreliable model:
 *   1 marker      the state the model wrote after its checkpoint marker, if it is long enough and within budget
 *   2 llm         an injected compressor over the previous state and the tail of the chunk
 *   3 heuristic   the first few key phrases of the chunk
 *   4 truncation  the tail of the chunk, cut to the budget
 * The level used is returned so a drift towards the lower rungs (the model stopped following the protocol) is visible.
 */
export class CarryoverService {
  constructor(private readonly compressor?: Compressor) {}

  async next(args: { markerState: string | undefined; previousCarryover: string; chunkText: string; config: ChunkConfig }): Promise<CarryoverResult> {
    const budget = args.config.carryoverTokens;
    const warnings: string[] = [];

    if (args.markerState !== undefined) {
      const state = args.markerState.trim();
      if (state.length >= MIN_STATE_CHARS && estimateTokens(state) <= budget) return { carryover: state, level: "marker", warnings };
      warnings.push(state.length < MIN_STATE_CHARS ? "marker-state-too-short" : "marker-state-over-budget");
    }

    if (this.compressor) {
      try {
        const preview = args.chunkText.slice(-2000);
        const prompt =
          `Previous state:\n${args.previousCarryover || "(none)"}\n\nLatest chunk (tail):\n${preview}\n\n` +
          "Compress into 3 to 5 critical points as a labelled block:\nCOMPLETED: ...\nREMAINING: ...\nDECISIONS: ...\nCONTEXT: ...";
        const compressed = (await this.compressor(prompt, "You compress reasoning state. Be terse and keep every decision with its value.")).trim();
        if (compressed.length >= MIN_STATE_CHARS && estimateTokens(compressed) <= budget) return { carryover: compressed, level: "llm", warnings };
        warnings.push("compressor-output-rejected");
      } catch {
        warnings.push("compressor-failed");
      }
    }

    // Take key phrases in order while they fit; a phrase too long to fit is skipped rather than ending the rung.
    const kept: string[] = [];
    for (const m of args.chunkText.matchAll(KEY_PHRASE)) {
      const phrase = (m[1] ?? "").trim();
      if (!phrase) continue;
      if (estimateTokens([...kept, phrase].join("; ")) > budget) continue;
      kept.push(phrase);
      if (kept.length === 5) break;
    }
    if (kept.length > 0) return { carryover: kept.join("; "), level: "heuristic", warnings };

    const words = (args.chunkText || args.previousCarryover).split(/\s+/).filter(Boolean);
    let tail = "";
    for (let i = words.length - 1; i >= 0; i--) {
      const candidate = (words[i] ?? "") + (tail ? ` ${tail}` : "");
      if (estimateTokens(candidate) > budget) break;
      tail = candidate;
    }
    return { carryover: tail, level: "truncation", warnings };
  }
}

/** The structured state block the protocol asks for. */
export function canonicalBlock(parts: { completed: string; remaining: string; decisions: string; context: string }): string {
  return `COMPLETED: ${parts.completed}\nREMAINING: ${parts.remaining}\nDECISIONS: ${parts.decisions}\nCONTEXT: ${parts.context}`;
}
