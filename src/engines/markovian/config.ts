import {
  BOUNDS,
  ConfigValidationError,
  DEFAULT_CONFIG,
  FRAMING_TOKENS,
  OUTPUT_BUDGET,
  type ChunkConfig,
  type ChunkInfo,
} from "./types.ts";

const KEYS = ["chunkSize", "maxChunks", "carryoverTokens", "overlapTokens"] as const;

/**
 * Merge a partial config over the defaults and validate it. Out-of-range or inconsistent values throw a typed
 * ConfigValidationError; nothing is clamped or silently ignored.
 *
 * The specification lists UI step sizes (1000, 128) next to the bounds. They are slider granularity, not
 * validation: the documented default carryoverTokens=800 is not on a step-128 grid that starts at 128, so
 * enforcing the grid would reject the default.
 */
export function resolveConfig(partial?: Partial<ChunkConfig>): ChunkConfig {
  const cfg: ChunkConfig = { ...DEFAULT_CONFIG };
  for (const key of KEYS) {
    const v = partial?.[key];
    if (v !== undefined) cfg[key] = v;
  }
  for (const key of KEYS) {
    const v = cfg[key];
    const b = BOUNDS[key];
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ConfigValidationError(`${key} must be a finite number`, key);
    if (!Number.isInteger(v)) throw new ConfigValidationError(`${key}=${v} must be an integer`, key);
    if (v < b.min || v > b.max) throw new ConfigValidationError(`${key}=${v} is outside [${b.min}, ${b.max}]`, key);
  }
  if (cfg.carryoverTokens <= 0) throw new ConfigValidationError("carryoverTokens must be greater than 0", "carryoverTokens");
  const floor = FRAMING_TOKENS + cfg.carryoverTokens + OUTPUT_BUDGET;
  if (cfg.chunkSize < floor) {
    throw new ConfigValidationError(
      `chunkSize=${cfg.chunkSize} is below framing(${FRAMING_TOKENS}) + carryoverTokens(${cfg.carryoverTokens}) + outputBudget(${OUTPUT_BUDGET}) = ${floor}`,
      "chunkSize",
    );
  }
  return cfg;
}

/** Tokens of new material one step can take once framing, carryover and the model's answer are accounted for. */
export function materialBudgetTokens(cfg: ChunkConfig, framingTokens = FRAMING_TOKENS): number {
  return cfg.chunkSize - Math.max(framingTokens, FRAMING_TOKENS) - cfg.carryoverTokens - OUTPUT_BUDGET - cfg.overlapTokens;
}

/** Projected per-step cost of a standard (history-carrying) chain against a Markovian chain. */
export function projectionCurve(cfg: ChunkConfig, steps = 10): { step: number; standard: number; markovian: number }[] {
  const out: { step: number; standard: number; markovian: number }[] = [];
  for (let step = 1; step <= steps; step++) {
    out.push({
      step,
      standard: (step - 1) * cfg.chunkSize + cfg.chunkSize,
      markovian: cfg.carryoverTokens + cfg.chunkSize,
    });
  }
  return out;
}

export interface RunEfficiency {
  totalTokensUsed: number;
  standardCost: number;
  markovianCost: number;
  tokensSaved: number;
  efficiencyPercent: number;
}

/**
 * Historical efficiency of a finished run. Always evaluated against the run's own persisted config snapshot.
 * standardCost is what a chain that re-sends all earlier output would have paid (prefix sums);
 * markovianCost is one carryover plus the step's own tokens, per step.
 */
export function runEfficiency(chunks: ReadonlyArray<Pick<ChunkInfo, "tokens">>, cfg: ChunkConfig): RunEfficiency {
  const totalTokensUsed = chunks.reduce((s, c) => s + c.tokens, 0);
  let standardCost = 0;
  let prefix = 0;
  for (const c of chunks) {
    standardCost += prefix + c.tokens;
    prefix += c.tokens;
  }
  const markovianCost = chunks.length * cfg.carryoverTokens + totalTokensUsed;
  const tokensSaved = Math.max(0, standardCost - markovianCost);
  return {
    totalTokensUsed,
    standardCost,
    markovianCost,
    tokensSaved,
    efficiencyPercent: standardCost > 0 ? (tokensSaved / standardCost) * 100 : 0,
  };
}

/** Constants of the symbolic cost model: framing, goal, step input, per-step output, carryover. */
export interface CostModelConstants {
  F: number;
  G: number;
  S: number;
  O: number;
  C: number;
}
export const DOC_DEFAULTS: Readonly<CostModelConstants> = Object.freeze({ F: 400, G: 200, S: 300, O: 1200, C: 800 });

/**
 * Input-token totals over N steps:
 *   naive     = N(F+G+S) + O N(N-1)/2        (every step re-reads all earlier output)
 *   markovian = N(F+G+C+S)                   (every step reads one carryover)
 * This is a model of a chain whose outputs feed the next input. It is not a measurement of any run.
 */
export function modelTotals(
  N: number,
  k: CostModelConstants = DOC_DEFAULTS,
): { naiveTotal: number; markovianTotal: number; savings: number; efficiency: number } {
  const naiveTotal = N * (k.F + k.G + k.S) + (k.O * N * (N - 1)) / 2;
  const markovianTotal = N * (k.F + k.G + k.C + k.S);
  const savings = naiveTotal - markovianTotal;
  return { naiveTotal, markovianTotal, savings, efficiency: naiveTotal > 0 ? savings / naiveTotal : 0 };
}
