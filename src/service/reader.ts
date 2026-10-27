/**
 * The Retriever's mechanism: run one read step against one connector with a timeout, capped retries, a request cache and
 * an idempotency key, and say plainly what happened.
 *
 * Outcomes are kept apart. OK and EMPTY are answers: only EMPTY may be read as "none found in X on date D". Every other
 * status is a failure of the source, never an empty result. The caller decides what a failure costs the claim.
 */
import { PortError, type Clock, type Connector, type FailureClass } from "../ports/index.ts";
import type { AssertionType, EvidenceRecord } from "../schemas/index.ts";
import type { ConnectorReadResult, RawContent } from "../sources/index.ts";
import type { Budget } from "./budget.ts";
import type { InvestigationLimits } from "./config.ts";
import { FaultInjectingConnector, SOURCE_TYPES, type FaultPlan } from "./faults.ts";
import { CancelledError, brief, effectKey, errorMessage, raceAbort, throwIfCancelled, withTimeout } from "./util.ts";

export type StepStatus = "OK" | "EMPTY" | FailureClass;

export interface ReadStep {
  /** Stable within a plan. */
  id: string;
  /** Connector id (a source card id). */
  source: string;
  query: Record<string, string | number>;
  /** Why this step is in the plan, in a sentence. */
  why: string;
  kind: "primary" | "followup" | "discovery" | "candidate";
}

export interface StepOutcome {
  step: ReadStep;
  idempotencyKey: string;
  status: StepStatus;
  detail: string;
  records: EvidenceRecord[];
  contents: Map<string, RawContent>;
  servedFrom: "live" | "recorded" | "snapshot" | "none";
  notes: string[];
  attempts: number;
  ms: number;
  /** Set when the answer came from this run's cache rather than a new request. */
  cached: boolean;
}

export function stepKey(step: Pick<ReadStep, "source" | "query">): string {
  return effectKey("read", { source: step.source, query: step.query });
}

export const assertionTypesOf = (source: string): readonly AssertionType[] => SOURCE_TYPES[source] ?? [];

export interface ReaderDeps {
  connectors: ReadonlyMap<string, Connector>;
  limits: InvestigationLimits;
  clock: Clock;
  budget: Budget;
  faults?: FaultPlan;
  /** Shared across runs of one service so drills and recomputes do not ask the sources again. Only answers are cached. */
  cache?: Map<string, StepOutcome>;
  signal?: AbortSignal;
}

export class SourceReader {
  /** Outcomes of this run by idempotency key: a resumed or repeated step returns the stored outcome. */
  readonly completed = new Map<string, StepOutcome>();

  constructor(private readonly deps: ReaderDeps) {}

  private faulted(source: string): "off" | "empty" | undefined {
    const f = this.deps.faults;
    if (!f?.target || !f.target.sources.has(source)) return undefined;
    if (f.drill === "source_off") return "off";
    if (f.drill === "source_empty") return "empty";
    return undefined;
  }

  async run(step: ReadStep): Promise<StepOutcome> {
    throwIfCancelled(this.deps.signal);
    const key = stepKey(step);
    const done = this.completed.get(key);
    if (done) return { ...done, cached: true };

    const fault = this.faulted(step.source);
    const base = this.deps.connectors.get(step.source);
    if (!base) {
      const outcome = this.failure(step, key, "INVALID", `no connector named ${step.source} is registered`, 0, 0);
      this.completed.set(key, outcome);
      return outcome;
    }
    const connector = fault ? new FaultInjectingConnector(base, fault) : base;

    if (!fault) {
      const hit = this.deps.cache?.get(key);
      if (hit) {
        const outcome = { ...hit, step, cached: true };
        this.completed.set(key, outcome);
        return outcome;
      }
    }

    const started = performance.now();
    const maxAttempts = 1 + this.deps.limits.maxRetries;
    let last: PortError | undefined;
    let made = 0;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      throwIfCancelled(this.deps.signal);
      made = attempt;
      try {
        if (!fault) this.deps.budget.spend("source", `${step.source} ${JSON.stringify(step.query).slice(0, 80)}`);
        const read = (await raceAbort(withTimeout(connector.read({ query: step.query }), this.deps.limits.callTimeoutMs, `${step.source} read`), this.deps.signal)) as ConnectorReadResult;
        const status: StepStatus = read.health === "EMPTY" ? "EMPTY" : "OK";
        const outcome: StepOutcome = {
          step,
          idempotencyKey: key,
          status,
          detail: status === "EMPTY" ? (read.notes.find((n) => /none found/i.test(n)) ?? `none found in ${step.source}`) : `${read.returned} record(s) from ${step.source}`,
          records: read.records as EvidenceRecord[],
          contents: read.contents,
          servedFrom: read.servedFrom,
          notes: read.notes,
          attempts: attempt,
          ms: Math.round(performance.now() - started),
          cached: false,
        };
        if (!fault && read.complete) this.deps.cache?.set(key, outcome);
        this.completed.set(key, outcome);
        return outcome;
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        last = error instanceof PortError ? error : new PortError("UNAVAILABLE", errorMessage(error));
        const retryable = last.failure === "UNAVAILABLE" && last.detail?.["retryable"] !== false && last.detail?.["noRecording"] !== true;
        if (!retryable) break;
      }
    }
    const e = last ?? new PortError("UNAVAILABLE", "the step did not run");
    const outcome = this.failure(step, key, e.failure, e.message, made, Math.round(performance.now() - started));
    this.completed.set(key, outcome);
    return outcome;
  }

  private failure(step: ReadStep, key: string, status: FailureClass, message: string, attempts: number, ms: number): StepOutcome {
    return {
      step,
      idempotencyKey: key,
      status,
      detail: brief(message),
      records: [],
      contents: new Map(),
      servedFrom: "none",
      notes: [],
      attempts,
      ms,
      cached: false,
    };
  }
}
