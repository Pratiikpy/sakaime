import { PortError } from "../ports/index.ts";
import { hashOf } from "../util/canonical.ts";

/** Raised when an investigation is cancelled. Callers stop; nothing is retried. */
export class CancelledError extends Error {
  constructor(message = "the investigation was cancelled") {
    super(message);
    this.name = "CancelledError";
  }
}

/** Rejects with UNAVAILABLE when `ms` pass first. The underlying call is abandoned, not aborted: connectors have no signal. */
export function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PortError("UNAVAILABLE", `${label} did not answer within ${ms} ms`, { timeout: true, retryable: true })), ms);
  });
  return Promise.race([work, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/** Rejects with CancelledError as soon as the signal aborts. */
export function raceAbort<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return work;
  if (signal.aborted) return Promise.reject(new CancelledError());
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CancelledError());
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return Promise.race([work, aborted]).finally(() => {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  });
}

export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

/** A short, stable key for an external effect, derived from what the effect is. Repeating the effect repeats the key. */
export function effectKey(kind: string, payload: unknown): string {
  return `${kind}:${hashOf(payload).slice(0, 24)}`;
}

export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

export const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The first `max` characters of a message with line breaks flattened, for traces and notes. */
export function brief(text: string, max = 240): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}...`;
}

/**
 * A short identifier made of letters only. Rendered text that names an evidence item is read by the number tracer, which
 * must not mistake the digits of a hash for a figure that has no anchor.
 */
export function alphaId(payload: unknown, length = 10): string {
  const hex = hashOf(payload).slice(0, length);
  return [...hex].map((c) => (c >= "0" && c <= "9" ? String.fromCharCode("g".charCodeAt(0) + Number(c)) : c)).join("");
}
