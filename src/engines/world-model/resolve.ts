import { normalizeName } from "./ids.ts";

/**
 * Identity resolution.
 *
 * Two layers, deliberately separate:
 *  - `decide()` is the sponsor's merge-band function, kept pure and with the sponsor's defaults
 *    because the conformance runner pins its boundaries (0.85 and above merges, 0.82 and above
 *    queues for review).
 *  - `IdentityResolver` is what the World Model actually consults. It is injected. The default
 *    resolver built from `decide()` never merges on string similarity alone: everything that
 *    falls in or above the review band goes to a human. A product that has a better signal (an
 *    authoritative identifier, a trained linkage model) injects its own resolver.
 */

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  let curr = new Array<number>(n + 1).fill(0);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n] ?? 0;
}

/** 1 - distance / longest length, on normalised names. */
export function nameSimilarity(rawA: string, rawB: string): number {
  const a = normalizeName(rawA);
  const b = normalizeName(rawB);
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1;
  return 1 - levenshtein(a, b) / maxLen;
}

export type ResolutionDecision = "auto-merge" | "review" | "new";

export function decide(similarity: number, autoMergeAt = 0.85, reviewLower = 0.82): ResolutionDecision {
  if (similarity >= autoMergeAt) return "auto-merge";
  if (similarity >= reviewLower) return "review";
  return "new";
}

export interface IdentityCandidate {
  id: string;
  type: string;
  name: string;
  aliases: readonly string[];
}

export interface IdentityQuery {
  type: string;
  name: string;
}

export type IdentityOutcome =
  | { action: "new" }
  | { action: "match"; entityId: string; similarity: number; reason: string }
  | { action: "review"; candidates: { entityId: string; similarity: number; reason: string }[] };

/** Called for name-keyed entities only; externally keyed entities carry their own authoritative id. */
export interface IdentityResolver {
  resolve(query: IdentityQuery, existing: readonly IdentityCandidate[]): IdentityOutcome;
}

export interface BandResolverOptions {
  autoMergeAt?: number;
  reviewLower?: number;
  /**
   * Entity types for which a similarity at or above `autoMergeAt` may merge without a reviewer.
   * Empty by default: the cost of a wrong merge (two different devices fused into one) is higher
   * than the cost of one extra review, so nothing merges on name similarity alone.
   */
  autoMergeTypes?: readonly string[];
}

export function createBandResolver(opts: BandResolverOptions = {}): IdentityResolver {
  const autoMergeAt = opts.autoMergeAt ?? 0.85;
  const reviewLower = opts.reviewLower ?? 0.82;
  const autoTypes = new Set(opts.autoMergeTypes ?? []);
  if (![autoMergeAt, reviewLower].every((x) => Number.isFinite(x) && x >= 0 && x <= 1) || reviewLower > autoMergeAt) {
    throw new RangeError(`createBandResolver: need 0 <= reviewLower <= autoMergeAt <= 1, got reviewLower ${reviewLower}, autoMergeAt ${autoMergeAt}`);
  }
  return {
    resolve(query, existing) {
      const scored: { entityId: string; similarity: number; decision: ResolutionDecision }[] = [];
      for (const other of existing) {
        if (other.type !== query.type) continue;
        const names = [other.name, ...other.aliases];
        const similarity = Math.max(...names.map((n) => nameSimilarity(query.name, n)));
        const decision = decide(similarity, autoMergeAt, reviewLower);
        if (decision !== "new") scored.push({ entityId: other.id, similarity, decision });
      }
      if (scored.length === 0) return { action: "new" };
      scored.sort((a, b) => b.similarity - a.similarity || a.entityId.localeCompare(b.entityId));
      const leader = scored[0]!;
      if (leader.decision === "auto-merge" && autoTypes.has(query.type)) {
        return {
          action: "match",
          entityId: leader.entityId,
          similarity: leader.similarity,
          reason: `name similarity ${leader.similarity.toFixed(3)} at or above auto-merge threshold ${autoMergeAt} for type ${query.type}`,
        };
      }
      return {
        action: "review",
        candidates: scored.map((s) => ({
          entityId: s.entityId,
          similarity: s.similarity,
          reason:
            s.decision === "auto-merge"
              ? `name similarity ${s.similarity.toFixed(3)} is in the auto-merge band, but ${query.type} entities are never merged without review`
              : `name similarity ${s.similarity.toFixed(3)} in review band [${reviewLower}, ${autoMergeAt})`,
        })),
      };
    },
  };
}
