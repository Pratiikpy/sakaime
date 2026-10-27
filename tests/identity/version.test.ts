import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compareVersions, isFullySpecified, parseVersion, VERSION_RELATIONS } from "../../src/identity/version.ts";

const rel = (a: string | undefined | null, b: string | undefined | null) => compareVersions(a, b).relation;

describe("version comparison on the real labels in the feasibility report", () => {
  it("keeps Transpara 1.7.0 and 1.7.2 apart but on one release line", () => {
    expect(rel("1.7.0", "1.7.2")).toBe("SAME_RELEASE_LINE");
    expect(rel("1.7.2", "2.1.0")).toBe("DIFFERENT");
  });

  it("does not treat 1.1 as a prefix of 1.10 (Viz LVO releases)", () => {
    expect(rel("1.1", "1.10")).toBe("DIFFERENT");
    expect(rel("1.10", "1.11")).toBe("DIFFERENT");
    expect(rel("1.2", "1.9")).toBe("DIFFERENT");
  });

  it("separates the De Novo's initial version 1.0 from the later GUDID releases", () => {
    for (let i = 1; i <= 11; i++) expect(rel("1.0", `1.${i}`)).toBe("DIFFERENT");
  });

  it("treats trailing zeros as padding between full labels", () => {
    expect(rel("1.0", "1.0.0")).toBe("EXACT");
    expect(rel("1.1.0.0", "1.1.0")).toBe("EXACT");
    expect(rel("2.1.0", "v2.1.0")).toBe("EXACT");
  });

  it("does not equate a coarse label with a fuller one", () => {
    expect(rel("V2", "2.3")).toBe("UNKNOWN");
    expect(rel("V2", "2.0.0")).toBe("UNKNOWN");
    expect(rel("V3", "2.3")).toBe("DIFFERENT");
    expect(rel("V2", "V2")).toBe("EXACT");
  });

  it("separates the independent studies' builds (3.1.0.0 against 3.9.0.1) and the vendor's 2.0.0 against 2.3", () => {
    expect(rel("3.1.0.0", "3.9.0.1")).toBe("DIFFERENT");
    expect(rel("2.0.0", "2.3")).toBe("DIFFERENT");
  });

  it("handles wildcard labels without claiming equality", () => {
    expect(rel("1.X", "1.3.4")).toBe("UNKNOWN");
    expect(rel("1.7.y", "1.7.2")).toBe("SAME_RELEASE_LINE");
    expect(rel("1.X", "2.1.501")).toBe("DIFFERENT");
    expect(rel("2.Y.Z", "2.1.0")).toBe("UNKNOWN");
    expect(isFullySpecified("1.X")).toBe(false);
    expect(isFullySpecified("2.1.501")).toBe(true);
  });

  it("compares product generations only with generations", () => {
    expect(rel("(3)", "(3)")).toBe("EXACT");
    expect(rel("(3)", "(4)")).toBe("DIFFERENT");
    expect(rel("(3)", "2.0")).toBe("UNKNOWN");
  });

  it("compares algorithm identifiers only with algorithm identifiers", () => {
    expect(rel("alg:1010", "1010")).toBe("EXACT");
    expect(rel("1010", "1040")).toBe("DIFFERENT");
    expect(rel("1010", "1.0.1")).toBe("UNKNOWN");
  });

  it("calls a research build different from a locked release and flags it as a build difference", () => {
    const c = compareVersions("Alpha", "2.1.501");
    expect(c.relation).toBe("DIFFERENT");
    expect(c.buildDiffers).toBe(true);
    expect(rel("Alpha", "Alpha")).toBe("EXACT");
    expect(rel("Alpha", "Beta")).toBe("UNKNOWN");
    expect(rel("Alpha", "1.X")).toBe("UNKNOWN");
  });

  it("compares build hashes by equality only", () => {
    expect(rel("3f9a1c7b2d", "3f9a1c7b2d")).toBe("EXACT");
    expect(rel("3f9a1c7b2d", "9aa01c7b2d")).toBe("DIFFERENT");
    expect(rel("3f9a1c7b2d", "2.1.0")).toBe("UNKNOWN");
  });

  it("does not compare free-text labels such as Guidance and AI", () => {
    expect(rel("Guidance", "AI")).toBe("UNKNOWN");
    expect(rel("Guidance", "guidance")).toBe("EXACT");
    expect(rel("FFRct version 3", "FFRct version 3")).toBe("EXACT");
    expect(rel("FFRct version 3", "3")).toBe("UNKNOWN");
  });

  it("separates a revision from the number it revises", () => {
    expect(rel("v2.1.0 rev005", "v2.1.0 rev006")).toBe("SAME_RELEASE_LINE");
    expect(rel("v2.1.0 rev005", "2.1.0")).toBe("SAME_RELEASE_LINE");
    expect(rel("v2.1.0 rev006", "v2.1.0 rev006")).toBe("EXACT");
  });

  it("returns UNKNOWN for a missing label, never a guess", () => {
    expect(rel(undefined, "1.0")).toBe("UNKNOWN");
    expect(rel("", "1.0")).toBe("UNKNOWN");
    expect(rel(undefined, undefined)).toBe("UNKNOWN");
    expect(rel(null, "  ")).toBe("UNKNOWN");
  });
});

describe("version comparison properties", () => {
  const label = fc.oneof(
    fc.array(fc.nat({ max: 30 }), { minLength: 1, maxLength: 4 }).map((p) => p.join(".")),
    fc.constantFrom("V2", "1.X", "(3)", "(4)", "1010", "Alpha", "Guidance", "FFRct version 3", "2.1.0 rev005", ""),
    fc.string({ maxLength: 12 }),
  );

  it("is symmetric", () => {
    fc.assert(fc.property(label, label, (a, b) => rel(a, b) === rel(b, a)));
  });

  it("always returns one of the four relations and never throws", () => {
    fc.assert(fc.property(label, label, (a, b) => VERSION_RELATIONS.includes(compareVersions(a, b).relation)));
  });

  it("a fully specified numeric label equals itself, and differs from any label with another major or minor", () => {
    const parts = fc.array(fc.nat({ max: 30 }), { minLength: 2, maxLength: 4 });
    fc.assert(fc.property(parts, (p) => rel(p.join("."), p.join(".")) === "EXACT"));
    fc.assert(
      fc.property(parts, fc.nat({ max: 30 }), (p, bump) => {
        const q = [...p];
        q[1] = (q[1]! + bump + 1) % 31;
        if (q[1] === p[1]) return true;
        return rel(p.join("."), q.join(".")) === "DIFFERENT";
      }),
    );
  });

  it("parsing is total", () => {
    fc.assert(fc.property(fc.string(), (s) => parseVersion(s).kind.length > 0));
  });
});
