import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");

export interface RunnerResult {
  exitCode: number | null;
  passed: number;
  total: number;
  stdout: string;
  stderr: string;
  failures: string[];
}

/**
 * Runs one of the vendored Meterless conformance runners in a child process, exactly as a judge
 * would (`npx tsx <runner>`), optionally against an implementation module through its environment
 * variable. The runner file is never modified.
 */
export function runConformance(engine: "hmem" | "world-model", impl?: { env: string; file: string }): RunnerResult {
  const runner = path.join(root, "third_party", "meterless", engine, "conformance", "runner.ts");
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env["HMEM_IMPL"];
  delete env["WORLD_MODEL_IMPL"];
  if (impl) env[impl.env] = path.join(root, impl.file);
  const r = spawnSync(process.execPath, [tsxCli, runner], { env, encoding: "utf8", cwd: root });
  const m = /(\d+)\/(\d+) checks passed/.exec(r.stdout);
  return {
    exitCode: r.status,
    passed: m ? Number(m[1]) : -1,
    total: m ? Number(m[2]) : -1,
    stdout: r.stdout,
    stderr: r.stderr,
    failures: r.stdout.split("\n").filter((l) => l.includes("FAIL")),
  };
}
