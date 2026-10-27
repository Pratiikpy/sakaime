import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { buildKey, findAll, numericTokens } from "../../src/extraction/normalize.ts";

const key = (s: string, tier: "normalized" | "damage_tolerant" = "normalized") => buildKey(s, tier).key;

describe("matching keys: what they ignore", () => {
  it("ignores line breaks, runs of spaces and tabs", () => {
    expect(key("sensitivity  was\n   87.8%\t(95% CI)")).toBe(key("sensitivity was 87.8% (95% CI)"));
  });

  it("joins a word hyphenated at a line end, and an ordinary compound, to the same key", () => {
    expect(key("non-\nproliferative retinopathy")).toBe(key("nonproliferative retinopathy"));
    expect(key("non-proliferative retinopathy")).toBe(key("nonproliferative retinopathy"));
  });

  it("treats typographic dashes in a numeric range as the same range", () => {
    const want = key("81.2-92.5");
    for (const v of ["81.2\u201392.5", "81.2\u201492.5", "81.2 - 92.5", "81.2 \u2013 92.5", "81.2\u221292.5"]) expect(key(v)).toBe(want);
  });

  it("maps ligature glyphs, curly quotes and non-breaking spaces", () => {
    expect(key("\uFB01ndings of the patient\u2019s exam")).toBe(key("findings of the patient's exam"));
    expect(key("87.8%\u00A0of cases")).toBe(key("87.8% of cases"));
  });

  it("does not fold case", () => {
    expect(key("Sensitivity")).not.toBe(key("sensitivity"));
  });

  it("keeps a minus sign that follows a word", () => {
    expect(key("changed by -3 points")).toContain("-3");
    expect(key("changed by - 3 points")).not.toBe(key("changed by -3 points"));
  });

  it("tolerates glyph damage only in the damage-tolerant tier", () => {
    const damaged = "Transpara\u00AE software and meti\uFFFDic";
    expect(key(damaged)).not.toBe(key("Transpara software and metiic"));
    expect(key(damaged, "damage_tolerant")).toBe(key("Transpara software and metiic", "damage_tolerant"));
    expect(key("Transpara@ 1.7.2", "damage_tolerant")).toBe(key("Transpara 1.7.2", "damage_tolerant"));
  });
});

describe("matching keys: the digit invariant", () => {
  const noise = fc.constantFrom(" ", "  ", "\n", "\t", "\u00A0", "-", "\u2013", "\u2212", ".", ",", "%", "(", ")", "a", "b", "e", "\uFB01", "@", "\uFFFD");
  const piece = fc.oneof(
    fc.integer({ min: 0, max: 99999 }).map(String),
    fc.tuple(fc.integer({ min: 0, max: 999 }), fc.integer({ min: 0, max: 9999 })).map(([a, b]) => `${a}.${b}`),
    noise,
  );

  it("never adds, removes or reorders a digit or decimal point", () => {
    fc.assert(
      fc.property(fc.array(piece, { minLength: 1, maxLength: 40 }), fc.constantFrom("normalized" as const, "damage_tolerant" as const), (parts, tier) => {
        const text = parts.join("");
        const k = buildKey(text, tier).key;
        const digitsOf = (s: string) => s.replace(/[^0-9]/g, "");
        expect(digitsOf(k)).toBe(digitsOf(text));
        // a decimal point survives wherever it sat between two digits
        const dots = (s: string) => (s.match(/(?<=\d)\.(?=\d)/g) ?? []).length;
        expect(dots(k)).toBe(dots(text));
      }),
      { numRuns: 400 },
    );
  });

  it("removes a hyphen only between two letters", () => {
    fc.assert(
      fc.property(fc.array(piece, { minLength: 1, maxLength: 30 }), (parts) => {
        const text = parts.join("");
        const hyphens = (s: string) => (s.match(/[-\u2013\u2212]/g) ?? []).length;
        const betweenLetters = (text.match(/(?<=\p{L})[-\u2013\u2212](?=\s*\p{L})/gu) ?? []).length;
        expect(hyphens(buildKey(text).key)).toBeGreaterThanOrEqual(hyphens(text) - betweenLetters);
      }),
      { numRuns: 300 },
    );
  });

  it("maps a match back to the original characters", () => {
    const text = "The  sensitivity\nwas 87.8% (95% CI 81.2\u201392.5) in the test set.";
    const hay = buildKey(text);
    const hits = findAll(hay, key("sensitivity was 87.8%"));
    expect(hits).toHaveLength(1);
    expect(text.slice(hits[0]?.start, hits[0]?.end)).toBe("sensitivity\nwas 87.8%");
  });

  it("lists numeric tokens including a leading-dot proportion", () => {
    expect(numericTokens("AUC is .91 and 0.945 (0.935-0.954), n=1,234")).toEqual([".91", "0.945", "0.935", "0.954", "1,234"]);
  });
});
