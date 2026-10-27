import { describe, expect, it } from "vitest";
import { measureStaleFlagging } from "../../../src/engines/world-model/ablation.ts";
import { buildMa1Session } from "./ablation-session.ts";

/**
 * MA-1 measurement. The expected numbers are pinned so that tests/engines/ABLATIONS.md cannot drift
 * from what the code produces. The session is constructed (see ablation-session.ts).
 */
describe("MA-1: stale findings, with and without the World Model", () => {
  it("measures the three arms on the constructed session", async () => {
    const report = await measureStaleFlagging(buildMa1Session());
    const [absent, present, everything] = report.arms;
    expect(absent).toMatchObject({ arm: "absent", findings: 36, stale: 7, flagged: 0, staleUnflagged: 7, flaggedUnnecessarily: 0 });
    expect(present).toMatchObject({ arm: "present", findings: 36, stale: 7, flagged: 9, staleUnflagged: 0, flaggedUnnecessarily: 2 });
    expect(everything).toMatchObject({ arm: "recompute-everything", flagged: 36, staleUnflagged: 0, flaggedUnnecessarily: 29 });
  });

  it("explains every unnecessary flag: a second source restated a value, so the winning fact changed but the value did not", async () => {
    const { overFlagging } = await measureStaleFlagging(buildMa1Session());
    expect(overFlagging.map((o) => o.findingId).sort()).toEqual(["D05:scope", "D05:version"]);
    expect(overFlagging.every((o) => o.reasons.join() === "winner-changed")).toBe(true);
  });

  it("flags a superset of the really stale findings and never misses one", async () => {
    const report = await measureStaleFlagging(buildMa1Session());
    expect(report.arms.find((a) => a.arm === "present")!.staleUnflagged).toBe(0);
  });
});
