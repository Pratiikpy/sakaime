/**
 * The investigation trace: one JSON line per decision, with the reason. Matches TraceEvent in src/api/contract.ts, which is
 * what the web app streams and what output_examples/traces holds.
 *
 * Wording is checked before a line is written: a trace is public text, and the words the product does not use about
 * evidence (a verdict of safety, a claim of proof) must not appear in one that our own code wrote.
 */
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { TraceEventSchema, type TraceEvent } from "../api/contract.ts";
import type { Clock } from "../ports/index.ts";
import { lintWording } from "./policy.ts";

export type TraceRole = TraceEvent["role"];
export type TraceDraft = Omit<TraceEvent, "runId" | "seq" | "at" | "done"> & { done?: boolean };

export class TraceEmitter {
  readonly events: TraceEvent[] = [];
  private seq = 0;
  private readonly listeners = new Set<(e: TraceEvent) => void>();
  private writeErrors = 0;

  constructor(
    readonly runId: string,
    private readonly clock: Clock,
    private readonly file?: string,
  ) {
    if (file) mkdirSync(dirname(file), { recursive: true });
  }

  subscribe(fn: (e: TraceEvent) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(draft: TraceDraft): TraceEvent {
    const problems = lintWording(draft.decision);
    if (problems.length > 0) {
      // Our own wording is wrong, not the data. Say so in the line itself rather than dropping the decision.
      draft = { ...draft, decision: `[wording withheld: ${problems.join(", ")}] ${draft.role} recorded a decision`, detail: { ...(draft.detail ?? {}), wordingProblems: problems } };
    }
    const event = TraceEventSchema.parse({ ...draft, runId: this.runId, seq: this.seq++, at: this.clock.now().toISOString(), done: draft.done ?? false });
    this.events.push(event);
    if (this.file) {
      try {
        appendFileSync(this.file, `${JSON.stringify(event)}\n`, "utf8");
      } catch {
        this.writeErrors += 1;
      }
    }
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* a listener that throws must not stop the investigation */
      }
    }
    return event;
  }

  /** The trace as the JSON-lines text the API serves. */
  jsonl(): string {
    return this.events.map((e) => JSON.stringify(e)).join("\n") + (this.events.length ? "\n" : "");
  }

  get failedWrites(): number {
    return this.writeErrors;
  }
}
