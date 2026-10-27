import { PortError } from "../ports/index.ts";

/** What `GET /models` said at the start of a run, and which model each role would use as a result. */
export interface AvailabilitySnapshot {
  probedAt: string;
  endpoint: string;
  /** `failed` means the listing could not be read. It does not mean any model is absent. */
  status: "ok" | "failed";
  listed: string[];
  error?: string;
  roles: Record<string, { model: string | null; chain: { model: string; listed: boolean | null }[] }>;
}

interface HealthRecord {
  consecutiveFailures: number;
  openUntil: number;
  gone?: string;
  lastReason?: string;
}

/**
 * Remembers which models are failing so a role does not keep sending work to one that is down. Super VL fails in
 * waves (D-025); after a few failures in a row it is skipped for a cool-down and the role's fallback is used. A model
 * the endpoint says is not enabled (404 or 410) is skipped until the next run's probe. The breaker is advisory: if every
 * candidate is open, the first is tried anyway, because refusing all work is worse than a slow try.
 */
export class ModelHealth {
  private readonly records = new Map<string, HealthRecord>();

  constructor(
    private readonly options: { failureThreshold?: number; cooldownMs?: number; now?: () => number } = {},
  ) {}

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private record(model: string): HealthRecord {
    let r = this.records.get(model);
    if (!r) {
      r = { consecutiveFailures: 0, openUntil: 0 };
      this.records.set(model, r);
    }
    return r;
  }

  recordSuccess(model: string): void {
    const r = this.record(model);
    r.consecutiveFailures = 0;
    r.openUntil = 0;
  }

  recordFailure(model: string, reason: string): void {
    const r = this.record(model);
    r.consecutiveFailures += 1;
    r.lastReason = reason;
    if (r.consecutiveFailures >= (this.options.failureThreshold ?? 3)) {
      r.openUntil = this.now() + (this.options.cooldownMs ?? 60_000);
    }
  }

  /** The endpoint said this model is not served. Not retried until `reset`. */
  markGone(model: string, reason: string): void {
    const r = this.record(model);
    r.gone = reason;
    r.lastReason = reason;
  }

  isGone(model: string): boolean {
    return this.records.get(model)?.gone !== undefined;
  }

  isOpen(model: string): boolean {
    const r = this.records.get(model);
    return r !== undefined && r.openUntil > this.now();
  }

  reset(): void {
    this.records.clear();
  }

  state(): Record<string, { consecutiveFailures: number; open: boolean; gone?: string; lastReason?: string }> {
    const out: Record<string, { consecutiveFailures: number; open: boolean; gone?: string; lastReason?: string }> = {};
    for (const [model, r] of this.records) {
      out[model] = {
        consecutiveFailures: r.consecutiveFailures,
        open: r.openUntil > this.now(),
        ...(r.gone !== undefined ? { gone: r.gone } : {}),
        ...(r.lastReason !== undefined ? { lastReason: r.lastReason } : {}),
      };
    }
    return out;
  }
}

export interface UsableModels {
  usable: string[];
  skipped: { model: string; reason: string }[];
}

/**
 * Orders the candidates for one call. A model the listing omits, or the endpoint disowned, is dropped; models with an
 * open breaker are moved after the healthy ones.
 */
export function selectUsable(candidates: readonly string[], snapshot: AvailabilitySnapshot | undefined, health: ModelHealth): UsableModels {
  const skipped: { model: string; reason: string }[] = [];
  const present: string[] = [];
  for (const model of candidates) {
    if (health.isGone(model)) {
      skipped.push({ model, reason: "the endpoint reported it is not enabled" });
    } else if (snapshot?.status === "ok" && !snapshot.listed.includes(model)) {
      skipped.push({ model, reason: "not in the endpoint's model list at the start of the run" });
    } else {
      present.push(model);
    }
  }
  if (present.length === 0) {
    throw new PortError("UNAVAILABLE", `none of the candidate models is available (${skipped.map((s) => `${s.model}: ${s.reason}`).join("; ")})`, { skipped });
  }
  const healthy = present.filter((m) => !health.isOpen(m));
  const open = present.filter((m) => health.isOpen(m));
  for (const model of open) skipped.push({ model, reason: "recent failures; tried only after the healthy models" });
  return { usable: [...healthy, ...open], skipped };
}
