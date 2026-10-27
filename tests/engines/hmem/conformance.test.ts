import { describe, expect, it } from "vitest";
import { runConformance } from "../meterless-runner.ts";

describe("H-MEM against the sponsor's unmodified conformance runner", () => {
  it("the sponsor's own reference passes 13 of 13 (baseline)", () => {
    const r = runConformance("hmem");
    expect(r.stdout).toMatch(/third_party[\\/]meterless[\\/]hmem[\\/]reference/);
    expect({ exit: r.exitCode, passed: r.passed, total: r.total }).toEqual({ exit: 0, passed: 13, total: 13 });
  }, 60_000);

  it("Sakaime's engine passes 13 of 13", () => {
    const r = runConformance("hmem", { env: "HMEM_IMPL", file: "src/engines/hmem/index.ts" });
    expect(r.failures).toEqual([]);
    expect({ exit: r.exitCode, passed: r.passed, total: r.total }).toEqual({ exit: 0, passed: 13, total: 13 });
    expect(r.stdout).toMatch(/src[\\/]engines[\\/]hmem[\\/]index\.ts/);
  }, 60_000);

  it("the runner fails when pointed at a module that exports no HMEM class", () => {
    const r = runConformance("hmem", { env: "HMEM_IMPL", file: "src/engines/hmem/types.ts" });
    expect(r.exitCode).toBe(2);
  }, 60_000);
});
