/**
 * Result files. Every file in evals/results/ has the same outer shape so RESULTS.md can link a number to a row:
 *
 *   { meta, summaries: { "<key>": { ...numbers } }, ...suite-specific detail }
 *
 * A link in RESULTS.md looks like `results/scopeshift-b.json#dev.V.falseSupported` and names a key of `summaries`.
 */
import { join } from "node:path";
import { RESULTS_DIR, writeJson, type RunStamp } from "./core.ts";
import type { Rate } from "./grade.ts";
import type { ResultClass } from "./types.ts";

export interface Meta extends RunStamp {
  class: ResultClass[];
  description: string;
  [extra: string]: unknown;
}

export interface ResultFile {
  meta: Meta;
  summaries: Record<string, unknown>;
  [detail: string]: unknown;
}

export function writeResult(name: string, file: ResultFile): string {
  const path = join(RESULTS_DIR, name);
  writeJson(path, file);
  return path;
}

/** A compact, link-friendly record of a proportion. */
export function rateRow(r: Rate): Record<string, unknown> {
  return {
    k: r.k,
    n: r.n,
    rate: Number.isFinite(r.rate) ? r.rate : null,
    wilsonLo: r.lo,
    wilsonHi: r.hi,
    ...(r.zeroUpper !== undefined ? { zeroErrorUpper95: r.zeroUpper } : {}),
    ...(r.cluster ? { clusterLo: r.cluster.lo, clusterHi: r.cluster.hi, clusters: r.cluster.clusters, resamples: r.cluster.resamples, seed: r.cluster.seed } : {}),
  };
}
