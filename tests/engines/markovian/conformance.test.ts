/**
 * Runs the sponsor's Markovian conformance runner, unmodified, against our module through MARKOVIAN_IMPL.
 * The runner is the vendored copy under third_party/meterless (hash-pinned by vendor-integrity.test.ts), so the test
 * runs in a clean clone. If it is missing the test fails: a missing runner is not a pass.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..", "..", "..");
const runner = resolve(root, "third_party/meterless/markovian/conformance/runner.ts");

describe("Markovian conformance runner (sponsor, unmodified)", () => {
  it("passes every check against src/engines/markovian", () => {
    expect(existsSync(runner), `no conformance runner at ${runner}`).toBe(true);
    const impl = resolve(root, "src/engines/markovian/index.ts").replace(/\\/g, "/");
    const res = spawnSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), runner], {
      env: { ...process.env, MARKOVIAN_IMPL: impl },
      encoding: "utf8",
      timeout: 120_000,
    });
    const out = `${res.stdout}\n${res.stderr}`;
    const m = out.match(/(\d+)\/(\d+) checks passed/);
    expect(m, out).not.toBeNull();
    expect(Number(m?.[2]), out).toBe(8);
    expect(Number(m?.[1]), out).toBe(8);
    expect(res.status, out).toBe(0);
    for (const id of ["eff-001", "snap-001", "snap-002", "ovl-001", "lab-001", "ref-001", "mrk-001", "cfg-001"]) {
      expect(out, `check ${id} missing or failed`).toMatch(new RegExp(`PASS ${id}\\b`));
    }
  });
});
