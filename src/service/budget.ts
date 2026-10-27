import { PortError } from "../ports/index.ts";
import type { InvestigationLimits } from "./config.ts";

/** Model calls kept back from evidence reading for the planner, the critic and the reporter. */
export const MODEL_RESERVE = 3;

export type BudgetKind = "source" | "model" | "federation" | "turn";

/** Per-case call allowance. Spending past a cap is a REFUSED failure the caller turns into a visible degradation. */
export class Budget {
  private readonly spent: Record<BudgetKind, number> = { source: 0, model: 0, federation: 0, turn: 0 };
  private readonly caps: Record<BudgetKind, number>;

  constructor(limits: InvestigationLimits) {
    this.caps = { source: limits.maxSourceCalls, model: limits.maxModelCalls, federation: limits.maxFederationCalls, turn: limits.maxTurns };
  }

  spend(kind: BudgetKind, what: string): void {
    if (this.spent[kind] >= this.caps[kind]) {
      throw new PortError("REFUSED", `the per-case ${kind} budget of ${this.caps[kind]} is used up; ${what} was not attempted`, { budget: kind, cap: this.caps[kind], retryable: false });
    }
    this.spent[kind] += 1;
  }

  /**
   * Like `spend`, but leaves `reserve` calls untouched. The model calls that read evidence (support checks, identity
   * adjudication) use this form, so they can never use up the calls the planner, the critic and the reporter need.
   */
  spendKeeping(kind: BudgetKind, reserve: number, what: string): void {
    if (this.caps[kind] - this.spent[kind] <= reserve) {
      throw new PortError("REFUSED", `the per-case ${kind} budget keeps its last ${reserve} call${reserve === 1 ? "" : "s"} for the planner, critic and reporter; ${what} was not attempted`, { budget: kind, cap: this.caps[kind], reserve, retryable: false });
    }
    this.spent[kind] += 1;
  }

  remaining(kind: BudgetKind): number {
    return this.caps[kind] - this.spent[kind];
  }

  snapshot(): Record<BudgetKind, { spent: number; cap: number }> {
    return Object.fromEntries((Object.keys(this.caps) as BudgetKind[]).map((k) => [k, { spent: this.spent[k], cap: this.caps[k] }])) as Record<BudgetKind, { spent: number; cap: number }>;
  }
}
