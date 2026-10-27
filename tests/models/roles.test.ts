import { describe, expect, it } from "vitest";
import { ModelHealth, selectUsable, type AvailabilitySnapshot } from "../../src/models/availability.ts";
import { LOCAL_LIGHTNING, MODEL_PROFILES, NEMOTRON_LIGHTNING, NEMOTRON_SUPER_VL, NEMOTRON_ULTRA, RoleMap, type RoleSpec } from "../../src/models/roles.ts";
import { PortError } from "../../src/ports/index.ts";

describe("default role map (D-025)", () => {
  const map = new RoleMap();
  it("puts high-volume roles on Lightning and critic and identity adjudication on Ultra", () => {
    for (const role of ["planner", "discoverer", "extractor", "support_checker", "reporter"]) expect(map.spec(role).model).toBe(NEMOTRON_LIGHTNING);
    expect(map.spec("critic").model).toBe(NEMOTRON_ULTRA);
    expect(map.spec("resolver").model).toBe(NEMOTRON_ULTRA);
  });
  it("gives every role a fallback different from its primary", () => {
    for (const role of map.roles()) {
      const s = map.spec(role);
      expect(s.fallbacks.length).toBeGreaterThan(0);
      expect(s.fallbacks).not.toContain(s.model);
    }
  });
  it("never uses Super VL by default, and only ever behind a fallback", () => {
    for (const role of map.roles()) expect([map.spec(role).model, ...map.spec(role).fallbacks]).not.toContain(NEMOTRON_SUPER_VL);
  });
  it("throws INVALID for an unknown role rather than guess a model", () => {
    expect(() => map.spec("oracle")).toThrowError(PortError);
    try {
      map.spec("oracle");
    } catch (e) {
      expect((e as PortError).failure).toBe("INVALID");
      expect((e as PortError).message).toMatch(/known roles/);
    }
  });
  it("turns reasoning off for every default role", () => {
    for (const role of map.roles()) expect(map.spec(role).thinking).toBe(false);
  });
  it("records the receipt tier it observed for each remote model", () => {
    expect(MODEL_PROFILES.find((p) => p.id === NEMOTRON_LIGHTNING)?.receiptTier).toBe("A");
    expect(MODEL_PROFILES.find((p) => p.id === NEMOTRON_ULTRA)?.receiptTier).toBe("C");
  });
});

describe("candidates", () => {
  const map = new RoleMap();
  it("returns the primary then the fallbacks for the remote lane", () => {
    expect(map.candidates("critic", 1000, "remote")).toEqual([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING]);
  });
  it("returns only the local model for the local lane", () => {
    expect(map.candidates("planner", 1000, "local")).toEqual([LOCAL_LIGHTNING]);
  });
  it("refuses a prompt above the local model's cap rather than send it", () => {
    expect(() => map.candidates("planner", 20_000, "local")).toThrowError(/Chunk the input/);
  });
  it("skips Super VL for a large prompt and uses its fallback", () => {
    const m = new RoleMap().withOverrides({ planner: { model: NEMOTRON_SUPER_VL, fallbacks: [NEMOTRON_LIGHTNING] } });
    expect(m.candidates("planner", 5_000, "remote")).toEqual([NEMOTRON_SUPER_VL, NEMOTRON_LIGHTNING]);
    expect(m.candidates("planner", 28_000, "remote")).toEqual([NEMOTRON_LIGHTNING]);
  });
  it("throws for a local lane on a role with no local model", () => {
    const specs: RoleSpec[] = [{ role: "x", model: NEMOTRON_LIGHTNING, fallbacks: [NEMOTRON_ULTRA], thinking: false, temperature: 0, maxTokens: 100, rationale: "t" }];
    expect(() => new RoleMap(specs).candidates("x", 10, "local")).toThrowError(/no local model/);
  });
});

describe("overrides (SAKAIME_ROLE_MODELS)", () => {
  it("replaces a role's model with a plain id and drops fallbacks chosen for another primary", () => {
    const m = RoleMap.fromEnv({ SAKAIME_ROLE_MODELS: JSON.stringify({ reporter: NEMOTRON_ULTRA }) });
    expect(m.spec("reporter").model).toBe(NEMOTRON_ULTRA);
    expect(m.spec("reporter").fallbacks).toEqual([]);
    expect(m.spec("planner").model).toBe(NEMOTRON_LIGHTNING);
  });
  it("accepts a full object with fallbacks and options", () => {
    const m = new RoleMap().withOverrides({ critic: { model: NEMOTRON_ULTRA, fallbacks: [NEMOTRON_LIGHTNING], thinking: true, maxTokens: 4096 } });
    expect(m.spec("critic")).toMatchObject({ thinking: true, maxTokens: 4096 });
  });
  it("rejects an unknown role, a bad id, an unknown key and non-JSON", () => {
    expect(() => new RoleMap().withOverrides({ nobody: NEMOTRON_ULTRA })).toThrowError(/unknown role/);
    expect(() => new RoleMap().withOverrides({ critic: "has space" })).toThrowError(PortError);
    expect(() => new RoleMap().withOverrides({ critic: { model: NEMOTRON_ULTRA, colour: "red" } })).toThrowError(PortError);
    expect(() => new RoleMap().withOverrides("{not json")).toThrowError(/not valid JSON/);
  });
  it("uses the defaults when the variable is absent or blank", () => {
    expect(RoleMap.fromEnv({}).spec("critic").model).toBe(NEMOTRON_ULTRA);
    expect(RoleMap.fromEnv({ SAKAIME_ROLE_MODELS: "  " }).spec("critic").model).toBe(NEMOTRON_ULTRA);
  });
  it("refuses Super VL without a fallback, and as the last resort", () => {
    expect(() => new RoleMap().withOverrides({ planner: NEMOTRON_SUPER_VL })).toThrowError(/fallback/);
    expect(() => new RoleMap().withOverrides({ planner: { model: NEMOTRON_LIGHTNING, fallbacks: [NEMOTRON_SUPER_VL] } })).toThrowError(/fallback/);
  });
  it("refuses a local model in a remote chain and a remote model as the local model", () => {
    expect(() => new RoleMap().withOverrides({ planner: { model: LOCAL_LIGHTNING, fallbacks: [NEMOTRON_ULTRA] } })).toThrowError(/local/);
    expect(() => new RoleMap().withOverrides({ planner: { model: NEMOTRON_LIGHTNING, localModel: NEMOTRON_ULTRA } })).toThrowError(/remote model/);
  });
});

describe("model health and availability", () => {
  const snapshot = (listed: string[], status: "ok" | "failed" = "ok"): AvailabilitySnapshot => ({ probedAt: "t", endpoint: "e", status, listed, roles: {} });

  it("drops a model the listing omits, but only when the listing was read", () => {
    const health = new ModelHealth();
    const some = selectUsable([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING], snapshot([NEMOTRON_LIGHTNING]), health);
    expect(some.usable).toEqual([NEMOTRON_LIGHTNING]);
    expect(some.skipped[0]?.model).toBe(NEMOTRON_ULTRA);
    // An unreadable list is not evidence that any model is absent.
    const unknown = selectUsable([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING], snapshot([], "failed"), health);
    expect(unknown.usable).toEqual([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING]);
  });
  it("throws UNAVAILABLE when nothing is usable", () => {
    expect(() => selectUsable([NEMOTRON_ULTRA], snapshot([]), new ModelHealth())).toThrowError(/none of the candidate/);
  });
  it("opens a breaker after repeated failures, puts that model last, and recovers after the cool-down", () => {
    let now = 1000;
    const health = new ModelHealth({ failureThreshold: 2, cooldownMs: 500, now: () => now });
    health.recordFailure(NEMOTRON_ULTRA, "503");
    expect(health.isOpen(NEMOTRON_ULTRA)).toBe(false);
    health.recordFailure(NEMOTRON_ULTRA, "503");
    expect(health.isOpen(NEMOTRON_ULTRA)).toBe(true);
    expect(selectUsable([NEMOTRON_ULTRA, NEMOTRON_LIGHTNING], undefined, health).usable).toEqual([NEMOTRON_LIGHTNING, NEMOTRON_ULTRA]);
    now += 600;
    expect(health.isOpen(NEMOTRON_ULTRA)).toBe(false);
  });
  it("a success clears the failure count", () => {
    const health = new ModelHealth({ failureThreshold: 2 });
    health.recordFailure("m", "x");
    health.recordSuccess("m");
    health.recordFailure("m", "x");
    expect(health.isOpen("m")).toBe(false);
  });
  it("a model the endpoint disowns stays out until reset", () => {
    const health = new ModelHealth();
    health.markGone(NEMOTRON_SUPER_VL, "404");
    expect(selectUsable([NEMOTRON_SUPER_VL, NEMOTRON_LIGHTNING], undefined, health).usable).toEqual([NEMOTRON_LIGHTNING]);
    health.reset();
    expect(selectUsable([NEMOTRON_SUPER_VL, NEMOTRON_LIGHTNING], undefined, health).usable).toEqual([NEMOTRON_SUPER_VL, NEMOTRON_LIGHTNING]);
  });
});
