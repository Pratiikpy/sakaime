import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { PortError } from "../../src/ports/index.ts";
import { RateLimiter, type RateWindow } from "../../src/sources/limiter.ts";

const run = promisify(execFile);

/** A clock the test controls; `sleep` advances it, so waiting costs no real time. */
function fakeTime(start = Date.parse("2026-10-27T10:00:00Z")) {
  let now = start;
  return {
    clock: { now: () => new Date(now) },
    sleep: async (ms: number) => {
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    get now() {
      return now;
    },
  };
}

const tmpDirs: string[] = [];
const tmpState = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sakaime-limit-"));
  tmpDirs.push(dir);
  return path.join(dir, "limits.json");
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

/** Oracle: every admitted request must fit every window. */
function violates(admitted: number[], windows: RateWindow[]): string | undefined {
  for (const w of windows) {
    for (let i = 0; i < admitted.length; i++) {
      const inWindow = admitted.filter((t) => t > admitted[i]! - w.perSeconds * 1000 && t <= admitted[i]!).length;
      if (inWindow > w.requests) return `${inWindow} requests inside ${w.perSeconds}s (cap ${w.requests}) ending at ${admitted[i]}`;
    }
  }
  return undefined;
}

describe("rate limiter", () => {
  it("admits up to the window size at once, then waits for the oldest request to leave the window", async () => {
    const t = fakeTime();
    const slept: number[] = [];
    const limiter = new RateLimiter({ group: "pubmed", windows: [{ requests: 3, perSeconds: 1 }], clock: t.clock, sleep: async (ms) => { slept.push(ms); await t.sleep(ms); } });
    const admitted: number[] = [];
    for (let i = 0; i < 7; i++) {
      await limiter.acquire();
      limiter.release();
      admitted.push(t.now);
    }
    expect(slept.length).toBeGreaterThan(0);
    expect(violates(admitted, [{ requests: 3, perSeconds: 1 }])).toBeUndefined();
    // Seven requests at three per second cannot finish in under two seconds.
    expect(admitted[6]! - admitted[0]!).toBeGreaterThanOrEqual(2000);
  });

  it("never lets any window be exceeded, for arbitrary arrival patterns (property)", async () => {
    const windows: RateWindow[] = [
      { requests: 5, perSeconds: 10 },
      { requests: 12, perSeconds: 60 },
    ];
    await fc.assert(
      fc.asyncProperty(fc.array(fc.integer({ min: 0, max: 4000 }), { minLength: 1, maxLength: 40 }), async (gaps) => {
        const t = fakeTime();
        const limiter = new RateLimiter({ group: "g", windows, clock: t.clock, sleep: t.sleep, maxWaitMs: 70_000 });
        const admitted: number[] = [];
        for (const gap of gaps) {
          t.advance(gap);
          try {
            await limiter.acquire();
            limiter.release();
            admitted.push(t.now);
          } catch (err) {
            expect(err).toBeInstanceOf(PortError);
          }
        }
        expect(violates(admitted, windows)).toBeUndefined();
      }),
      { numRuns: 150 },
    );
  });

  it("refuses rather than sleeps when the daily cap is used up, and says when a slot opens", async () => {
    const t = fakeTime();
    const windows = [{ requests: 240, perSeconds: 60 }, { requests: 1000, perSeconds: 86_400 }];
    const limiter = new RateLimiter({ group: "openfda", windows, clock: t.clock, sleep: t.sleep });
    const admitted: number[] = [];
    // 300 ms apart stays under 240 per minute, so only the daily window can bind.
    for (let i = 0; i < 1000; i++) {
      t.advance(300);
      await limiter.acquire();
      limiter.release();
      admitted.push(t.now);
    }
    t.advance(300);
    const err = await limiter.acquire().catch((e) => e);
    expect(err).toBeInstanceOf(PortError);
    expect(err.failure).toBe("UNAVAILABLE");
    expect(err.detail.budgetExhausted).toBe(true);
    expect(err.detail.retryAfterMs).toBeGreaterThan(3600_000);
    expect(err.message).toMatch(/next slot opens at 2026-10-/);
    expect(limiter.used()).toBe(1000);
    // Once the oldest request is 24 hours old, exactly one more fits.
    t.advance(86_400_000 - (t.now - admitted[0]!) + 1);
    await limiter.acquire();
    limiter.release();
    expect(violates([...admitted, t.now], windows)).toBeUndefined();
  });

  it("honours the per-minute window first when both bind", async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ group: "openfda", windows: [{ requests: 240, perSeconds: 60 }, { requests: 1000, perSeconds: 86_400 }], clock: t.clock, sleep: t.sleep });
    const admitted: number[] = [];
    for (let i = 0; i < 500; i++) {
      await limiter.acquire();
      limiter.release();
      admitted.push(t.now);
    }
    expect(violates(admitted, [{ requests: 240, perSeconds: 60 }])).toBeUndefined();
  });

  it("keeps a reserve out of every window", async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ group: "g", windows: [{ requests: 10, perSeconds: 86_400 }], reserve: 4, clock: t.clock, sleep: t.sleep, maxWaitMs: 1 });
    for (let i = 0; i < 6; i++) {
      await limiter.acquire();
      limiter.release();
    }
    await expect(limiter.acquire()).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });

  it("rejects a configuration with no usable capacity", () => {
    expect(() => new RateLimiter({ group: "g", windows: [] })).toThrow(RangeError);
    expect(() => new RateLimiter({ group: "g", windows: [{ requests: 3, perSeconds: 1 }], reserve: 3 })).toThrow(RangeError);
  });

  it("allows one request in flight at a time when maxConcurrent is 1", async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ group: "crossref", windows: [{ requests: 5, perSeconds: 1 }], maxConcurrent: 1, clock: t.clock, sleep: t.sleep });
    const order: string[] = [];
    const job = async (name: string, hold: number) => {
      await limiter.acquire();
      order.push(`${name} start`);
      await new Promise((r) => setTimeout(r, hold));
      order.push(`${name} end`);
      limiter.release();
    };
    await Promise.all([job("a", 30), job("b", 1)]);
    expect(order).toEqual(["a start", "a end", "b start", "b end"]);
  });

  it("releases the concurrency slot when the budget is refused", async () => {
    const t = fakeTime();
    const limiter = new RateLimiter({ group: "g", windows: [{ requests: 1, perSeconds: 86_400 }], maxConcurrent: 1, clock: t.clock, sleep: t.sleep, maxWaitMs: 1 });
    await limiter.acquire();
    limiter.release();
    await expect(limiter.acquire()).rejects.toBeInstanceOf(PortError);
    await expect(limiter.acquire()).rejects.toBeInstanceOf(PortError); // would hang if the slot had leaked
  });
});

describe("on-disk budget", () => {
  it("is shared by every limiter on the same file and group, as separate processes would be", async () => {
    const file = tmpState();
    const t = fakeTime();
    const make = () => new RateLimiter({ group: "openfda", stateFile: file, windows: [{ requests: 20, perSeconds: 86_400 }], clock: t.clock, sleep: t.sleep, maxWaitMs: 1 });
    const a = make();
    const b = make();
    let granted = 0;
    await Promise.all(
      [a, b].map(async (l) => {
        for (let i = 0; i < 30; i++) {
          try {
            await l.acquire();
            l.release();
            granted++;
          } catch {
            /* budget used up */
          }
        }
      }),
    );
    expect(granted).toBe(20);
  });

  it("remembers earlier requests after a restart", async () => {
    const file = tmpState();
    const t = fakeTime();
    const opts = { group: "openfda", stateFile: file, windows: [{ requests: 5, perSeconds: 86_400 }], clock: t.clock, sleep: t.sleep, maxWaitMs: 1 };
    const first = new RateLimiter(opts);
    for (let i = 0; i < 5; i++) {
      await first.acquire();
      first.release();
    }
    const restarted = new RateLimiter(opts);
    expect(restarted.used()).toBe(5);
    await expect(restarted.acquire()).rejects.toMatchObject({ failure: "UNAVAILABLE", detail: { budgetExhausted: true } });
  });

  it("keeps groups separate", async () => {
    const file = tmpState();
    const t = fakeTime();
    const mk = (group: string) => new RateLimiter({ group, stateFile: file, windows: [{ requests: 1, perSeconds: 86_400 }], clock: t.clock, sleep: t.sleep, maxWaitMs: 1 });
    await mk("openfda").acquire();
    await expect(mk("pubmed").acquire()).resolves.toBeDefined();
    await expect(mk("openfda").acquire()).rejects.toBeInstanceOf(PortError);
  });

  it("starts fresh from an unreadable state file and leaves a valid one behind", async () => {
    const file = tmpState();
    fs.writeFileSync(file, "{ not json");
    const t = fakeTime();
    const l = new RateLimiter({ group: "g", stateFile: file, windows: [{ requests: 2, perSeconds: 60 }], clock: t.clock, sleep: t.sleep });
    await l.acquire();
    l.release();
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(state.version).toBe(1);
    expect(state.groups.g).toHaveLength(1);
  });

  it("breaks a stale lock left by a process that died", async () => {
    const file = tmpState();
    fs.mkdirSync(`${file}.lock`, { recursive: true });
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(`${file}.lock`, old, old);
    const l = new RateLimiter({ group: "g", stateFile: file, windows: [{ requests: 2, perSeconds: 60 }] });
    await l.acquire();
    l.release();
    expect(fs.existsSync(`${file}.lock`)).toBe(false);
  });

  it("holds the cap across real processes (4 workers, 12 attempts each, cap 20)", async () => {
    const file = tmpState();
    const worker = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "fixtures", "limiter-worker.ts");
    const results = await Promise.all(
      [1, 2, 3, 4].map(() => run(process.execPath, ["--import", "tsx", worker, file, "12", "20"], { cwd: process.cwd(), timeout: 60_000 })),
    );
    const granted = results.map((r) => (JSON.parse(r.stdout.trim().split("\n").pop()!) as { granted: number }).granted);
    expect(granted.reduce((a, b) => a + b, 0)).toBe(20);
  }, 90_000);
});
