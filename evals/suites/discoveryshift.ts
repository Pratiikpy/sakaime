/**
 * DiscoveryShift adapter (docs/06 section 3, T1). The suite itself (cases, sealed expectations, the onboarding pipeline run, the
 * baselines) belongs to src/discovery and tests/discovery/shift; this file does not run or re-implement it. It reads the results that
 * runner wrote to data/discovery-shift/results.json and reports them in the same shape as the other suites: rates with Wilson
 * intervals, cluster bootstrap over base sources, effective sample size, class tag.
 *
 * If results.json does not exist, the adapter says so and writes a "not run" result; it never fills in numbers.
 *
 *   npx tsx evals/suites/discoveryshift.ts
 */
import { join } from "node:path";
import { clusterBootstrap, effectiveSampleSize, wilson, zeroErrorUpperBound } from "../stats/index.ts";
import { ROOT, exists, readJson, stamp } from "../lib/core.ts";
import { rateRow, writeResult } from "../lib/results.ts";
import { loadSealed, SHIFT_DIR, type CaseResult } from "../../tests/discovery/shift/suite.ts";

const SEED = 20261027;

interface ArmRun {
  arm: string;
  mode: string;
  label: string;
  at: string;
  results: CaseResult[];
}

function main(): void {
  const started = stamp("discoveryshift", SEED);
  const resultsPath = join(SHIFT_DIR, "results.json");
  if (!exists(resultsPath)) {
    writeResult("discoveryshift.json", {
      meta: { ...started, class: ["consistency"], description: "DiscoveryShift adapter. NOT RUN: data/discovery-shift/results.json does not exist, so the suite's runner has not produced results yet." },
      summaries: { status: "NOT RUN", reason: "data/discovery-shift/results.json is absent; run `npx tsx tests/discovery/shift/run.ts --mode replay` (or record) first." },
    });
    console.log("DiscoveryShift: results.json absent, wrote a NOT RUN result");
    return;
  }
  const sealed = loadSealed();
  const file = readJson<{ sealed: unknown; runs: ArmRun[] }>(resultsPath);
  const summaries: Record<string, unknown> = { sourceFile: "data/discovery-shift/results.json", sealedHashes: sealed.hashes, runsInFile: file.runs.map((r) => `${r.arm}/${r.label}/${r.mode}`) };
  const exp = sealed.expected;
  for (const run of file.runs) {
    const scored = run.results.filter((r) => !exp[r.id]?.knownLimit);
    const key = `${run.arm}.${run.label}`;
    const rows = scored.map((r) => ({ cluster: r.cluster, ok: r.category === "correct" }));
    const boot = clusterBootstrap(rows, (s) => (s.length ? s.filter((x) => x.ok).length / s.length : NaN), { seed: SEED, resamples: 2000 });
    const correct = rows.filter((r) => r.ok).length;
    const mayNotMap = scored.filter((r) => !exp[r.id]!.expect.includes("mapped"));
    const falseAccepts = scored.filter((r) => r.category === "false_accept");
    const mustMap = scored.filter((r) => exp[r.id]!.expect.length === 1 && exp[r.id]!.expect[0] === "mapped");
    const w = (k: number, n: number) => rateRow({ ...wilson(k, n), ...(k === 0 && n > 0 ? { zeroUpper: zeroErrorUpperBound(n) } : {}) } as never);
    summaries[`${key}.cases`] = { scored: scored.length, knownLimitExcluded: run.results.length - scored.length, effective: effectiveSampleSize(rows) };
    summaries[`${key}.correct`] = { ...w(correct, scored.length), clusterLo: boot.lo, clusterHi: boot.hi, clusters: boot.clusters };
    summaries[`${key}.mappedCorrectlyWhenItMustMap`] = w(mustMap.filter((r) => r.category === "correct").length, mustMap.length);
    summaries[`${key}.falseAcceptRate`] = w(falseAccepts.length, mayNotMap.length + mustMap.length);
    summaries[`${key}.falseAcceptsIds`] = falseAccepts.map((r) => r.id);
    summaries[`${key}.mode`] = run.mode;
  }
  writeResult("discoveryshift.json", {
    meta: { ...started, class: ["consistency"], description: "DiscoveryShift, read from the runner's results.json. Labels follow from the construction of each mutation (data/discovery-shift/SEALED.md); engineering consistency, not clinical correctness. The runner and the sealed expectations are not mine; this adapter only reports them." },
    summaries,
  });
  console.log(`DiscoveryShift: ${file.runs.length} runs read from ${resultsPath.replace(ROOT, "")}`);
}

main();
