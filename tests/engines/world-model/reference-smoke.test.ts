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
  const start = r.stdout.indexOf("{");
  const report = JSON.parse(r.stdout.slice(start));
  const tests: { title: string; status: string }[] = report.testResults.flatMap((f: any) => f.assertionResults);
  return { passed: tests.filter((t) => t.status === "passed").map((t) => t.title), failed: tests.filter((t) => t.status === "failed").map((t) => t.title) };
}

describe("the sponsor's own smoke tests, run unmodified", () => {
  it("pass 10 of 10 against the sponsor's reference", () => {
    const r = runReferenceSmoke("reference");
    expect({ passed: r.passed.length, failed: r.failed }).toEqual({ passed: 10, failed: [] });
  }, 60_000);

  /**
   * Seven of the ten pass against this engine. The three that do not each assert a behaviour this
   * engine changes on purpose; they are listed here so that the set of departures is explicit and
   * any new failure is noticed.
   */
  it("pass 7 of 10 against Sakaime's engine; the three departures are deliberate", () => {
    const r = runReferenceSmoke("ours");
    expect(r.passed).toHaveLength(7);
    expect(r.failed.sort()).toEqual(
      [
        // Auto-merges a 0.92-similar name; this engine sends every name-similarity match to review.
        "name resolution: near-duplicates auto-merge or queue by band",
        // Expects the report to carry `clusters` (news-story clustering, which Sakaime does not use).
        "ingest is idempotent: same batch twice, empty diff; a mutation changes the shape",
        // Relates to an entity that was never upserted; this engine rejects dangling edges by default.
        "custom views fold over matching events",
      ].sort(),
    );
  }, 60_000);
});
