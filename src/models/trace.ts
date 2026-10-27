import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Structured trace of the model layer. One JSON object per line when written to disk. Events name what was
 * decided and why (an egress decision, a receipt verdict, a fallback), never the prompt or reply text.
 */
export interface TraceEvent {
  ts: string;
  kind: string;
  [field: string]: unknown;
}

export interface TraceSink {
  emit(kind: string, detail?: Record<string, unknown>): void;
}

/** Keeps events in memory. Used by the evaluation harness to read a run back, and by tests. */
export class MemoryTraceSink implements TraceSink {
  readonly events: TraceEvent[] = [];
  constructor(private readonly now: () => Date = () => new Date()) {}

  emit(kind: string, detail: Record<string, unknown> = {}): void {
    this.events.push({ ...detail, ts: this.now().toISOString(), kind });
  }

  of(kind: string): TraceEvent[] {
    return this.events.filter((e) => e.kind === kind);
  }
}

/** Appends JSON lines to a file. A failing disk must never stop a model call, so write errors are counted, not thrown. */
export class JsonlTraceSink implements TraceSink {
  writeErrors = 0;
  constructor(
    private readonly path: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    mkdirSync(dirname(path), { recursive: true });
  }

  emit(kind: string, detail: Record<string, unknown> = {}): void {
    try {
      appendFileSync(this.path, `${JSON.stringify({ ...detail, ts: this.now().toISOString(), kind })}\n`, "utf8");
    } catch {
      this.writeErrors += 1;
    }
  }
}

export class FanoutTraceSink implements TraceSink {
  constructor(private readonly sinks: readonly TraceSink[]) {}
  emit(kind: string, detail: Record<string, unknown> = {}): void {
    for (const sink of this.sinks) {
      try {
        sink.emit(kind, detail);
      } catch {
        /* one sink failing does not silence the others */
      }
    }
  }
}
