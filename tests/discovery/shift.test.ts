/**
 * DiscoveryShift (T1, C-04) as a regression test. The first run called the model and recorded every reply
 * (data/discovery-shift/model-cassettes); this replays those replies offline and checks three things:
 *
 *   1. the suite on disk is the one that was sealed;
 *   2. replay reproduces the recorded outcome of every case (the offline judge path, O-09);
 *   3. the invariants that must never break: no false accept of a semantic mutation, and a baseline that fails the altered layouts.
 *
 * It asserts no accuracy threshold. The measured rates, with intervals, are in data/discovery-shift/RESULTS.md.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CASSETTE_DIR, SHIFT_DIR, loadSealed, runSuite, type CaseResult } from "./shift/suite.ts";

const sealed = loadSealed();
const results = join(SHIFT_DIR, "results.json");
const recorded = existsSync(CASSETTE_DIR) && existsSync(results);

describe("the sealed suite", () => {
  it("is exactly what was sealed", () => {
    expect(sealed.problems).toEqual([]);
    expect(sealed.cases.length).toBeGreaterThanOrEqual(100);
    expect(Object.keys(sealed.expected).sort()).toEqual(sealed.cases.map((c) => c.id).sort());
  });
  it("covers every mutation class the protocol names", () => {
    const classes = new Set(sealed.cases.map((c) => c.class));
    for (const c of ["rename", "unit", "meaning", "identifier", "duplicates", "truncation", "null codes", "dates", "injection"]) expect(classes.has(c), c).toBe(true);
  });
  it("was written without looking at the pipeline: every case has a single policy-derived expectation", () => {
    for (const [id, e] of Object.entries(sealed.expected)) {
      expect(e.expect.length, id).toBeGreaterThan(0);
      if (e.expect.includes("mapped")) expect(e.mapping, id).toBeDefined();
    }
  });
});

describe.skipIf(!recorded)("replay of the recorded run", () => {
  const prior = recorded ? (JSON.parse(readFileSync(results, "utf8")) as { runs: { arm: string; label: string; results: CaseResult[] }[] }).runs.find((r) => r.arm === "full" && r.label === "run2") : undefined;

  it("reproduces the recorded outcome of every case, offline", async () => {
    const { results: now } = await runSuite({ mode: "replay", arm: "full" });
    expect(now.map((r) => [r.id, r.label])).toEqual(prior!.results.map((r) => [r.id, r.label]));
    // Every mapping that came from a model came from a recorded reply: nothing was called.
    expect(now.filter((r) => r.proposer === "model").every((r) => r.recorded)).toBe(true);
    expect(now.filter((r) => r.proposer === "model").length).toBeGreaterThan(80);
  }, 300_000);

  it("never registers a semantic mutation it should not, and the baseline does", () => {
    const scored = prior!.results.filter((r) => !sealed.expected[r.id]!.knownLimit);
    expect(scored.filter((r) => r.category === "false_accept").map((r) => r.id)).toEqual([]);
    const base = scored.filter((r) => r.baseline.category === "false_accept");
    expect(base.length).toBeGreaterThan(0);
    const altered = scored.filter((r) => r.class !== "control");
    expect(altered.filter((r) => r.baseline.label === "declined").length).toBeGreaterThan(10);
  });
});
