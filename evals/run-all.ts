/**
 * Runs every suite in order, then builds evals/RESULTS.md. Seeded and repeatable: all resampling uses fixed seeds, the held-out key is
 * checked against its seal first, and model replies are replayed from evals/results/model-runs when they exist (a missing reply is a
 * live call unless --no-model is given, in which case that case has no verdict and is counted as wrong).
 *
 *   npx tsx evals/run-all.ts [--no-model] [--no-docker] [--only scopeshift-a,timeshift,...] [--runs 3]
 *
 * --no-docker skips the drill that stops the real local Zetaris API container (it is restarted and checked afterwards when it runs).
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { EVALS, ROOT } from "./lib/core.ts";
import { verifySeal } from "./lib/seal.ts";

const args = process.argv.slice(2);
const flag = (n: string): boolean => args.includes(`--${n}`);
const value = (n: string, d: string): string => (args.includes(`--${n}`) ? (args[args.indexOf(`--${n}`) + 1] as string) : d);
const only = args.includes("--only") ? value("only", "").split(",") : undefined;

const seal = verifySeal();
console.log(`held-out seal holds (sealed ${seal.sealedAt})`);

const model = flag("no-model") ? ["--no-model"] : [];
const steps: { id: string; file: string; args: string[] }[] = [
  { id: "scopeshift-a", file: "suites/scopeshift-a.ts", args: [] },
  { id: "scopeshift-b-dev", file: "suites/scopeshift-b.ts", args: ["--partition", "dev", "--runs", value("runs", "3"), "--concurrency", "2", ...model] },
  { id: "scopeshift-b-held-out", file: "suites/scopeshift-b.ts", args: ["--partition", "held-out", "--runs", value("runs", "3"), "--concurrency", "2", ...model] },
  { id: "identityshift", file: "suites/identityshift.ts", args: [] },
  { id: "timeshift", file: "suites/timeshift.ts", args: [] },
  { id: "failureshift", file: "suites/failureshift.ts", args: flag("no-docker") ? ["--no-docker"] : [] },
  { id: "discoveryshift", file: "suites/discoveryshift.ts", args: [] },
  { id: "adapter-log", file: "suites/adapter-log.ts", args: [] },
  { id: "report", file: "report.ts", args: [] },
];

const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
for (const s of steps) {
  if (only && !only.includes(s.id) && s.id !== "report") continue;
  console.log(`\n== ${s.id}`);
  const r = spawnSync(process.execPath, [tsx, join(EVALS, s.file), ...s.args], { cwd: ROOT, stdio: "inherit", env: process.env });
  if (r.status !== 0) {
    console.error(`${s.id} failed with exit code ${r.status}`);
    process.exit(r.status ?? 1);
  }
}
