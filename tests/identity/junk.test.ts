/** Junk input: malformed records, impossible pairs, empty records, hostile strings. Unknown is never false and never safe. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { generatePairs } from "../../src/identity/blocking.ts";
import { loadCorpus } from "../../src/identity/corpus.ts";
import { rankCandidates, resolveDeterministic } from "../../src/identity/resolver.ts";
import { parseRecord } from "../../src/identity/types.ts";
import { PortError } from "../../src/ports/index.ts";
import { LINK_TYPES } from "../../src/schemas/index.ts";
import { MODEL, blank, corpus, rec } from "./helpers.ts";

const opts = { model: MODEL };
const invalid = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(PortError);
    expect((e as PortError).failure).toBe("INVALID");
    return;
  }
  throw new Error("expected an INVALID PortError");
};

describe("malformed records are refused loudly", () => {
  const good = rec("510k:K200667");
  for (const [label, junk] of [
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["a string", "K200667"],
    ["an array", []],
    ["an empty object", {}],
    ["an empty id", blank({ id: "" })],
    ["an unknown kind", { id: "x", kind: "Device", source: "t" }],
    ["a missing source", { id: "x", kind: "Study" }],
    ["an unknown field", { ...blank({ id: "x" }), safe: true }],
    ["a negative enrolment", blank({ id: "x", enrollment: -3 })],
    ["a fractional enrolment", blank({ id: "x", enrollment: 2.5 })],
    ["a malformed date", blank({ id: "x", date: "last Tuesday" })],
    ["a one-million-character name", blank({ id: "x", name: "A".repeat(1_000_000) })],
    ["a non-array identifier list", blank({ id: "x", ids: { submission: "K200667" as never } })],
    ["a mention of an unknown type", blank({ id: "x", mentions: [{ type: "isbn" as never, value: "1", channel: "text" }] })],
  ] as const) {
    it(`refuses ${label}`, () => {
      invalid(() => resolveDeterministic(junk as never, good, "SAME_PRODUCT", opts));
      invalid(() => resolveDeterministic(good, junk as never, "SAME_PRODUCT", opts));
      invalid(() => parseRecord(junk));
    });
  }

  it("refuses an unknown link type, a record linked to itself, and kinds the link type cannot carry", () => {
    invalid(() => resolveDeterministic(rec("510k:K200667"), rec("list:K223357"), "SAME_AS" as never, opts));
    invalid(() => resolveDeterministic(rec("510k:K200667"), rec("510k:K200667"), "SAME_PRODUCT", opts));
    invalid(() => resolveDeterministic(rec("510k:K200667"), rec("pubmed:34779843"), "SAME_SUBMISSION", opts));
    invalid(() => resolveDeterministic(rec("ctgov:NCT03112005"), rec("pubmed:34779843"), "STUDY_EVALUATES", opts));
    invalid(() => rankCandidates(rec("510k:K200667"), [], "NOPE" as never, opts));
  });
});

describe("empty and hostile content is handled, not guessed", () => {
  const empty = (id: string) => blank({ id });

  it("two records with nothing to compare are AMBIGUOUS with the reason stated, never rejected and never linked", () => {
    for (const t of ["SAME_PRODUCT", "STUDY_EVALUATES"] as const) {
      const a = t === "STUDY_EVALUATES" ? blank({ id: "a", kind: "Study" }) : empty("a");
      const r = resolveDeterministic(a, empty("b"), t, opts);
      expect(r.link?.state).toBe("AMBIGUOUS");
      expect(r.link?.basis.join(" ")).toMatch(/nothing can be said/);
      expect(r.presentation).toBe("WEAK_CANDIDATE");
    }
  });

  it("garbage identifiers are ignored, not matched", () => {
    const a = blank({ id: "a", name: "Alpha", ids: { submission: ["??", "K1", "K 221347"], nct: ["NCT1"], pmid: ["x"], doi: ["y"], udiDi: ["12"] } });
    const b = blank({ id: "b", name: "Alpha", ids: { submission: ["??", "K1", "K 221347"], nct: ["NCT1"], pmid: ["x"], doi: ["y"], udiDi: ["12"] } });
    for (const t of ["SAME_SUBMISSION", "SAME_MARKETED_VERSION"] as const) {
      expect(resolveDeterministic(a, b, t, opts).link?.state).not.toBe("CONFIRMED");
    }
  });

  it("treats a mention whose value is not an identifier as nothing", () => {
    const study = blank({ id: "s", kind: "Study", name: "Trial", ids: { nct: ["NCT03112005"] } });
    const product = blank({ id: "p", name: "Device", mentions: [{ type: "nct", value: "NCT0311200", channel: "field" }, { type: "nct", value: "see above", channel: "text" }] });
    expect(resolveDeterministic(study, product, "STUDY_EVALUATES", opts).link?.state).not.toBe("CONFIRMED");
  });

  it("survives unicode, control characters, emoji and right-to-left text in every field", () => {
    const nasty = "A\u0000\u202eB\ud83d\ude00\u200b\ufffd\u0301 \"'<>&%$#@!";
    const a = blank({ id: "a", name: nasty, manufacturer: nasty, text: nasty, aliases: [nasty], purposeTags: [nasty], version: nasty, module: nasty });
    const b = blank({ id: "b", name: nasty, manufacturer: nasty, text: nasty, aliases: [nasty], purposeTags: [nasty], version: nasty, module: nasty });
    for (const t of LINK_TYPES) {
      try {
        resolveDeterministic(a, b, t, opts);
      } catch (e) {
        expect((e as PortError).failure).toBe("INVALID");
      }
    }
  });

  it("an enormous but valid text field is accepted and compared", () => {
    const text = "Paige Prostate ".repeat(1300);
    const r = resolveDeterministic(blank({ id: "a", kind: "Publication", text }), rec("510k:DEN200080"), "STUDY_EVALUATES", opts);
    expect(r.link).not.toBeNull();
  });

  it("any generated record shape either parses or throws INVALID, and a parsed record always resolves", () => {
    const text = fc.oneof(fc.string({ maxLength: 40 }), fc.constantFrom("Transpara 1.7.2", "K221347", "NCT03112005", "(3)", "Viz.Al, Inc.", ""));
    const arb = fc.record(
      {
        id: fc.string({ minLength: 1, maxLength: 12 }),
        kind: fc.constantFrom("Study", "Publication", "AuthorizationSubmission", "SoftwareRelease", "MarketedDevice", "Manufacturer"),
        source: fc.constant("t"),
        name: text,
        manufacturer: text,
        version: text,
        text,
        productCode: fc.string({ maxLength: 4 }),
        date: fc.constantFrom("2020", "2020-05", "2020-05-17", "nope"),
        enrollment: fc.oneof(fc.nat(), fc.constant(-1)),
      },
      { requiredKeys: ["id", "kind", "source"] },
    );
    fc.assert(
      fc.property(arb, arb, fc.constantFrom(...LINK_TYPES), (a, b, t) => {
        try {
          const r = resolveDeterministic(a as never, b as never, t, opts);
          return r.link === null || ["CONFIRMED", "CANDIDATE", "AMBIGUOUS", "REJECTED"].includes(r.link.state);
        } catch (e) {
          return e instanceof PortError && e.failure === "INVALID";
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("blocking and corpus loading", () => {
  it("returns no pairs for an empty pool or a single record, and refuses a duplicate id", () => {
    expect(generatePairs([]).pairs).toEqual([]);
    expect(generatePairs([rec("510k:K200667")]).pairs).toEqual([]);
    expect(() => generatePairs([rec("510k:K200667"), rec("510k:K200667")])).toThrow(/duplicate record id/);
  });

  it("refuses a malformed pool member", () => {
    invalid(() => generatePairs([rec("510k:K200667"), { id: "" } as never]));
  });

  it("fails loudly on a missing or corrupted corpus", () => {
    expect(() => loadCorpus("C:/definitely/not/here")).toThrow();
  });
});

describe("blocking reaches every true link in the corpus", () => {
  const c = corpus();
  const blocked = generatePairs([...c.records.values()].map((r) => r.record));
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const reach = new Set(blocked.pairs.map((p) => key(p.a.id, p.b.id)));

  it("keeps every MATCH pair, since a link blocked out is a link never seen", () => {
    const lost = c.pairs.filter((p) => p.truth === "MATCH" && !reach.has(key(p.a, p.b))).map((p) => p.id);
    expect(lost).toEqual([]);
  });

  it("avoids most comparisons and names the rule that put each pair together", () => {
    expect(blocked.reduction).toBeGreaterThan(0.5);
    expect(blocked.pairs.every((p) => p.rules.length > 0 && p.linkTypes.length > 0)).toBe(true);
  });

  it("brings an identifier-only pair together even with no name in common", () => {
    const a = blank({ id: "a", kind: "Study", ids: { nct: ["NCT03112005"] }, name: "zzz" });
    const b = blank({ id: "b", name: "qqq", mentions: [{ type: "nct", value: "NCT03112005", channel: "text" }] });
    const r = generatePairs([a, b]);
    expect(r.pairs).toHaveLength(1);
    expect(r.pairs[0]!.rules).toContain("nct");
  });
});
