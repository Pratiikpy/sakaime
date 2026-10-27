import { describe, expect, it } from "vitest";
import { runConformance } from "../meterless-runner.ts";

describe("World Model against the sponsor's unmodified conformance runner", () => {
  it("the sponsor's own reference passes 8 of 8 (baseline)", () => {
    const r = runConformance("world-model");
    expect(r.stdout).toMatch(/third_party[\\/]meterless[\\/]world-model[\\/]reference/);
    expect({ exit: r.exitCode, passed: r.passed, total: r.total }).toEqual({ exit: 0, passed: 8, total: 8 });
  }, 60_000);

  it("Sakaime's engine passes 8 of 8", () => {
    const r = runConformance("world-model", { env: "WORLD_MODEL_IMPL", file: "src/engines/world-model/index.ts" });
    expect(r.failures).toEqual([]);
    expect({ exit: r.exitCode, passed: r.passed, total: r.total }).toEqual({ exit: 0, passed: 8, total: 8 });
    expect(r.stdout).toMatch(/src[\\/]engines[\\/]world-model[\\/]index\.ts/);
  }, 60_000);

  it("the runner fails when pointed at a module that does not export the required names", () => {
    const r = runConformance("world-model", { env: "WORLD_MODEL_IMPL", file: "src/engines/world-model/types.ts" });
    expect(r.exitCode).toBe(2);
  }, 60_000);
});
