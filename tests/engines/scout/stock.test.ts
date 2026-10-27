/**
 * Runs the sponsor's stock Scout evaluation harness, unmodified, against src/engines/scout through SCOUT_IMPL.
 * The harness is read from the vendored copy when present, otherwise from the local study clone, and is copied
 * into node_modules/.cache first because its runner writes a report next to itself. Neither present: the test fails.
 *
 * Passing here is necessary and says little: the stock corpus is 32 examples, many of them verbatim registry
 * examples. The stricter grader (evals/scout/grader.ts) is the measurement; see RESULTS.md.
 */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");
const sources = [resolve(root, "third_party/meterless/scout-intent/evals"), resolve(root, "research/hackathon/repos/Meterless/engines/scout-intent/evals")];

describe("stock sponsor harness", () => {
  it("runs to completion with zero skipped prompts and clears every hard floor", () => {
    const src = sources.find((p) => existsSync(p));
    expect(src, `no stock harness found in: ${sources.join(", ")}`).toBeDefined();
    const work = resolve(root, "node_modules/.cache/sakaime-scout-stock");
    rmSync(work, { recursive: true, force: true });
    mkdirSync(work, { recursive: true });
    cpSync(src as string, resolve(work, "evals"), { recursive: true });
    const res = spawnSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), resolve(work, "evals/runner/index.ts"), "all"], {
      cwd: work,
      env: { ...process.env, SCOUT_IMPL: resolve(root, "src/engines/scout/index.ts") },
      encoding: "utf8",
      timeout: 120_000,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    expect(res.status, out).toBe(0);
    expect(out).toMatch(/Loaded 32 examples/);
    expect(out.match(/^Skipped /gm) ?? []).toHaveLength(0);
    const m = (k: string): number => Number(out.match(new RegExp(`│\\s*${k}\\s*│\\s*([0-9.]+)\\s*│`))?.[1]);
    expect(m("intent_top1")).toBeGreaterThanOrEqual(0.85);
    expect(m("intent_top3_recall")).toBeGreaterThanOrEqual(0.94);
    expect(m("injection_precision")).toBeGreaterThanOrEqual(0.9);
    expect(m("injection_recall")).toBeGreaterThanOrEqual(0.82);
    expect(m("tool_precision")).toBeGreaterThanOrEqual(0.8);
    expect(m("clarification_rate")).toBeLessThanOrEqual(0.25);
  });
});
