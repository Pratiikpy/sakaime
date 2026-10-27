import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..", "..", "..");
const vitestCli = path.join(root, "node_modules", "vitest", "vitest.mjs");

function runReferenceSmoke(impl: "reference" | "ours") {
  const r = spawnSync(process.execPath, [vitestCli, "run", "--config", path.join(here, "reference-smoke.vitest.config.mjs"), "--reporter=json"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, SAKAIME_IMPL: impl },
  });
  const report = JSON.parse(r.stdout.slice(r.stdout.indexOf("{")));
  const tests: { title: string; status: string }[] = report.testResults.flatMap((f: any) => f.assertionResults);
  return { passed: tests.filter((t) => t.status === "passed").length, failed: tests.filter((t) => t.status === "failed").map((t) => t.title) };
}

describe("the sponsor's own smoke tests, run unmodified", () => {
  it("pass 10 of 10 against the sponsor's reference", () => {
    expect(runReferenceSmoke("reference")).toEqual({ passed: 10, failed: [] });
  }, 60_000);

  it("pass 10 of 10 against Sakaime's engine", () => {
    expect(runReferenceSmoke("ours")).toEqual({ passed: 10, failed: [] });
  }, 60_000);
});
