/**
 * A ModelPort that keeps what it was asked and what came back, for the dossier and the trace.
 *
 * It also enforces two rules the rest of the product relies on: every call carries its own memory scope (so the provider's
 * memory cannot carry one case's text into another's), and no call is made past the per-case budget. The model's reply is
 * never trusted here; callers validate it.
 */
import { PortError, type ModelPort, type ModelRequest, type ModelResponse } from "../ports/index.ts";
import type { DataClass } from "../schemas/index.ts";
import type { Budget } from "./budget.ts";
import { raceAbort, throwIfCancelled, withTimeout } from "./util.ts";
import type { Clock } from "../ports/index.ts";

export interface ModelCall {
  id: string;
  at: string;
  role: string;
  dataClass: DataClass;
  promptBytes: number;
  response?: ModelResponse;
  failure?: { failure: string; message: string };
}

export class LoggedModelPort implements ModelPort {
  readonly calls: ModelCall[] = [];
  private readonly scopes = new Set<string>();
  private n = 0;

  constructor(
    private readonly inner: ModelPort,
    private readonly opts: { clock: Clock; timeoutMs: number; signal?: AbortSignal; idPrefix?: string },
  ) {}

  async complete(request: ModelRequest): Promise<ModelResponse> {
    throwIfCancelled(this.opts.signal);
    if (this.scopes.has(request.memoryScope)) {
      throw new PortError("INVALID", "a memory scope was reused: every model call needs its own, so provider memory cannot cross calls", { role: request.role });
    }
    this.scopes.add(request.memoryScope);
    const call: ModelCall = {
      id: `${this.opts.idPrefix ?? "model"}-${++this.n}`,
      at: this.opts.clock.now().toISOString(),
      role: request.role,
      dataClass: request.dataClass,
      promptBytes: Buffer.byteLength(request.system) + Buffer.byteLength(request.user),
    };
    this.calls.push(call);
    try {
      const response = await raceAbort(withTimeout(this.inner.complete(request), this.opts.timeoutMs, `model role ${request.role}`), this.opts.signal);
      call.response = response;
      return response;
    } catch (error) {
      call.failure = error instanceof PortError ? { failure: error.failure, message: error.message } : { failure: "UNAVAILABLE", message: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  }
}

/** A fresh, unique memory scope for each call. Deterministic within a run so a replay asks identical questions. */
export function scopeFactory(runId: string): () => string {
  let n = 0;
  return () => `${runId}:call-${++n}`;
}

export type { Budget };
