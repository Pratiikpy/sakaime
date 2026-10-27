/**
 * Request-rate limiter with an on-disk record, so a daily cap holds across processes and restarts.
 *
 * Every request a live connector makes first calls `acquire()`. The limiter keeps the timestamps of recent
 * requests per group (the three openFDA endpoints share one per-IP allowance, so they share one group) and
 * admits a request only if it fits every window at once: per second or minute, and per day. The daily window
 * is rolling, not a calendar day: the source does not say when its day resets, and a rolling 24 hours can
 * never exceed the cap on any boundary.
 *
 * Short waits (a per-minute window) are slept off. A wait longer than `maxWaitMs`, which is what an exhausted
 * daily cap amounts to, is not slept: the call fails with UNAVAILABLE and the time at which it would fit, so
 * the caller degrades instead of hanging for hours.
 *
 * Requests made by other programs from the same address cannot be seen here; the cap protects against this
 * product exceeding the limit, and a margin is the caller's choice (`reserve`).
 */
import fs from "node:fs";
import path from "node:path";
import { PortError, type Clock } from "../ports/index.ts";

export interface RateWindow {
  requests: number;
  perSeconds: number;
}

export interface LimiterOptions {
  group: string;
  windows: RateWindow[];
  /** JSON file holding the request log for all groups. Omit for a process-local limiter (tests, cassette mode). */
  stateFile?: string;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** Longest pause worth sleeping. Default 70 s, so a per-minute window is waited out and a daily cap is not. */
  maxWaitMs?: number;
  /** Requests held back from every window as a margin for traffic this process cannot see. Default 0. */
  reserve?: number;
  /** Most requests in flight at once (Crossref's public pool allows one). */
  maxConcurrent?: number;
}

interface StateFile {
  version: 1;
  groups: Record<string, number[]>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RateLimiter {
  private readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxWaitMs: number;
  private memory: number[] = [];
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];
  private readonly retention: number;

  constructor(private readonly options: LimiterOptions) {
    if (options.windows.length === 0) throw new RangeError("a limiter needs at least one window");
    for (const w of options.windows) {
      if (!(w.requests - (options.reserve ?? 0) >= 1)) throw new RangeError(`window of ${w.requests} per ${w.perSeconds}s leaves no capacity after reserve ${options.reserve ?? 0}`);
    }
    this.clock = options.clock ?? { now: () => new Date() };
    this.sleep = options.sleep ?? defaultSleep;
    this.maxWaitMs = options.maxWaitMs ?? 70_000;
    this.retention = Math.max(...options.windows.map((w) => w.perSeconds)) * 1000;
  }

  /** Reserve one request slot. Resolves when the request may be sent. Pair with `release()` when it finishes. */
  async acquire(): Promise<{ waitedMs: number }> {
    await this.takeConcurrencySlot();
    let waited = 0;
    try {
      for (;;) {
        const wait = this.tryReserve();
        if (wait === 0) return { waitedMs: waited };
        if (wait > this.maxWaitMs) {
          throw new PortError("UNAVAILABLE", `request budget for "${this.options.group}" is used up; the next slot opens at ${new Date(this.clock.now().getTime() + wait).toISOString()}`, {
            group: this.options.group,
            retryAfterMs: wait,
            budgetExhausted: true,
            retryable: false,
          });
        }
        await this.sleep(wait);
        waited += wait;
      }
    } catch (err) {
      this.release();
      throw err;
    }
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
    this.waiters.shift()?.();
  }

  /** Requests recorded inside the longest window, for display. */
  used(): number {
    return this.load(this.clock.now().getTime()).length;
  }

  private async takeConcurrencySlot(): Promise<void> {
    const max = this.options.maxConcurrent;
    if (max === undefined) {
      this.inFlight++;
      return;
    }
    while (this.inFlight >= max) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.inFlight++;
  }

  /** Returns 0 after recording a request, otherwise the milliseconds until one would fit. */
  private tryReserve(): number {
    return this.withState((log, now) => {
      let wait = 0;
      for (const w of this.options.windows) {
        const cap = w.requests - (this.options.reserve ?? 0);
        const windowStart = now - w.perSeconds * 1000;
        const inside = log.filter((t) => t > windowStart);
        if (inside.length >= cap) {
          // The slot opens when the request that is `cap` places from the newest leaves the window.
          const blocker = inside[inside.length - cap]!;
          wait = Math.max(wait, blocker + w.perSeconds * 1000 - now + 1);
        }
      }
      if (wait > 0) return { result: wait, log };
      return { result: 0, log: [...log, now] };
    });
  }

  private load(now: number): number[] {
    const cutoff = now - this.retention;
    if (!this.options.stateFile) return this.memory.filter((t) => t > cutoff);
    const state = this.readState();
    return (state.groups[this.options.group] ?? []).filter((t) => t > cutoff);
  }

  private withState(fn: (log: number[], now: number) => { result: number; log: number[] }): number {
    const now = this.clock.now().getTime();
    if (!this.options.stateFile) {
      const { result, log } = fn(this.load(now), now);
      this.memory = log;
      return result;
    }
    return this.withLock(() => {
      const state = this.readState();
      const cutoff = now - this.retention;
      const current = (state.groups[this.options.group] ?? []).filter((t) => t > cutoff);
      const { result, log } = fn(current, now);
      state.groups[this.options.group] = log;
      // Drop other groups' entries that have aged out so the file does not grow without bound.
      for (const [group, times] of Object.entries(state.groups)) {
        if (group !== this.options.group) state.groups[group] = times.filter((t) => t > now - 24 * 3600 * 1000 - 1000);
      }
      this.writeState(state);
      return result;
    });
  }

  private readState(): StateFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.options.stateFile!, "utf8")) as StateFile;
      if (raw && raw.version === 1 && typeof raw.groups === "object") return raw;
    } catch {
      // Missing or unreadable: start empty. An unreadable file must not stop the product, but it also must not
      // be mistaken for "no requests made": the next write replaces it with a correct record from here on.
    }
    return { version: 1, groups: {} };
  }

  private writeState(state: StateFile): void {
    const file = this.options.stateFile!;
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state));
    fs.renameSync(tmp, file);
  }

  /** Cross-process mutual exclusion through an atomically created lock directory. */
  private withLock<T>(fn: () => T): T {
    const file = this.options.stateFile!;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const lock = `${file}.lock`;
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        fs.mkdirSync(lock);
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        // A holder that died leaves its lock behind; a lock this old is stale.
        try {
          if (Date.now() - fs.statSync(lock).mtimeMs > 5_000) fs.rmSync(lock, { recursive: true, force: true });
        } catch {
          // Someone else released it first.
        }
        if (Date.now() > deadline) throw new PortError("UNAVAILABLE", "could not obtain the request-budget lock", { retryable: true });
        // The critical section is a few milliseconds of synchronous file work; sleep briefly and retry.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    }
    try {
      return fn();
    } finally {
      fs.rmSync(lock, { recursive: true, force: true });
    }
  }
}
