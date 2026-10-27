import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DecideContext, UserRef } from "../../src/engines/scout/types.ts";

/**
 * One labelled prompt. Everything under `expected` is a claim the grader checks; a field left out is not scored.
 *
 *   decision        proceed | clarify | block | quarantine
 *   intent          the top-1 intent (for a refused guarded request, the guarded intent)
 *   intents         the full set, for a multi-intent request
 *   injection       whether the injection layer should judge it a block-level injection
 *   blockedBy       injection | policy | pii | guarded-intent: the layer that should refuse it
 *   clarificationKind  low-confidence | tie | missing-parameter | confirm-high-risk
 *   risk            the risk level on the decision
 *   redacts         the decision should carry a redaction
 *   dataClass       the model profile's data class
 */
export interface Expected {
  decision: "proceed" | "clarify" | "block" | "quarantine";
  intent?: string;
  intents?: string[];
  injection?: boolean;
  blockedBy?: "injection" | "policy" | "pii" | "guarded-intent" | "rate";
  clarificationKind?: "low-confidence" | "tie" | "missing-parameter" | "confirm-high-risk";
  risk?: "low" | "medium" | "high" | "block";
  redacts?: boolean;
  dataClass?: "public" | "vendor-confidential" | "phi";
}

export interface CorpusRow {
  id: string;
  split: "dev" | "heldout";
  prompt: string;
  user?: Partial<UserRef>;
  surface?: string;
  context?: DecideContext;
  expected: Expected;
  /** A genuine request that resembles an attack and must not be refused. */
  lookalike?: boolean;
  hard?: boolean;
  /** For attacks: what it tries to achieve and where the text came from. */
  attack?: { goal: "override" | "verdict" | "exfiltrate" | "tool" | "role" | "conceal" | "hide-limits"; source: "user" | "document" };
  tags?: string[];
  /** The file it came from. */
  file?: string;
}

export function loadCorpus(dir: string): CorpusRow[] {
  const rows: CorpusRow[] = [];
  const ids = new Set<string>();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".jsonl")).sort()) {
    const lines = readFileSync(join(dir, f), "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.trim()) return;
      let row: CorpusRow;
      try {
        row = JSON.parse(line) as CorpusRow;
      } catch (err) {
        throw new Error(`${f}:${i + 1} is not valid JSON: ${(err as Error).message}`);
      }
      if (!row.id || typeof row.prompt !== "string" || !row.expected?.decision || (row.split !== "dev" && row.split !== "heldout")) throw new Error(`${f}:${i + 1} (${row.id}) is missing id, prompt, split or expected.decision`);
      if (ids.has(row.id)) throw new Error(`${f}:${i + 1} duplicate id ${row.id}`);
      ids.add(row.id);
      rows.push({ ...row, file: f });
    });
  }
  return rows;
}
