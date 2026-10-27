/**
 * Layer 5: rate limit. A token bucket per user and bucket class, with the clock injected so a decision can be
 * replayed. High-risk intents draw on a smaller bucket, which is what stops a misclassified prompt from
 * launching many writes.
 */
export interface BucketConfig {
  capacity: number;
  refillPerMinute: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  constructor(private readonly now: () => number) {}

  /** Take one token. When there is none, returns how long until there is one. */
  take(key: string, cfg: BucketConfig): { ok: true } | { ok: false; retryAfterMs: number } {
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: cfg.capacity, at: t };
    const elapsed = Math.max(0, t - b.at);
    b.tokens = Math.min(cfg.capacity, b.tokens + (elapsed / 60_000) * cfg.refillPerMinute);
    b.at = t;
    this.buckets.set(key, b);
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { ok: true };
    }
    const perMs = cfg.refillPerMinute / 60_000;
    return { ok: false, retryAfterMs: Math.ceil((1 - b.tokens) / perMs) };
  }

  /** Forget buckets idle long enough to be full again, so a long-running process does not grow without bound. */
  prune(cfg: BucketConfig): void {
    const t = this.now();
    const fullAfterMs = (cfg.capacity / cfg.refillPerMinute) * 60_000;
    for (const [k, b] of this.buckets) if (t - b.at > fullAfterMs) this.buckets.delete(k);
  }

  get size(): number {
    return this.buckets.size;
  }
}
