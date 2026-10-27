/** Properties that must hold for any input, checked with generated records and generated model output. */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { applicableLinkTypes, orient } from "../../src/identity/exact.ts";
import { rankCandidates, resolveDeterministic, resolveLink, validateProposal, type AdjudicateHook } from "../../src/identity/resolver.ts";
import type { ScorerModel } from "../../src/identity/scorer.ts";
import { LINK_TYPES, type LinkType } from "../../src/schemas/index.ts";
import type { IdentityRecord } from "../../src/identity/types.ts";
import { foldText } from "../../src/identity/normalize.ts";
import { MODEL, corpus, rec } from "./helpers.ts";

const WIDE: ScorerModel = { ...MODEL, thresholds: { pooled: { lower: -100, upper: 100 }, byLinkType: {} } };
const ALL = [...corpus().records.values()].map((r) => r.record);
const recordArb = fc.constantFrom(...ALL);
const linkTypeArb = fc.constantFrom(...LINK_TYPES);

/** Resolves a pair, or returns undefined when the link type cannot apply to the kinds. */
function tryResolve(a: IdentityRecord, b: IdentityRecord, t: LinkType, model: ScorerModel = MODEL) {
  try {
    return resolveDeterministic(a, b, t, { model });
  } catch {
    return undefined;
  }
}

describe("I-4: a model hint can never produce CONFIRMED", () => {
  const proposalArb = fc.record({
    verdict: fc.constantFrom("SAME", "DIFFERENT", "UNSURE", "CONFIRMED", "yes"),
    citations: fc.array(
      fc.record({
        record: fc.constantFrom("from", "to"),
        field: fc.constantFrom("name", "text", "manufacturer", "version", "ids"),
        quote: fc.oneof(fc.constantFrom("Paige", "Transpara", "EyeArt", "Viz"), fc.string({ maxLength: 20 })),
      }),
      { maxLength: 4 },
    ),
    rationale: fc.string({ maxLength: 40 }),
  });

  it("whatever the hook returns, the state equals the state without a hook", async () => {
    await fc.assert(
      fc.asyncProperty(recordArb, recordArb, linkTypeArb, fc.oneof(proposalArb, fc.anything()), async (a, b, t, proposal) => {
        if (a.id === b.id) return true;
        const base = tryResolve(a, b, t, WIDE);
        if (!base) return true;
        const hook: AdjudicateHook = async () => proposal;
        const withHook = await resolveLink(a, b, t, { model: WIDE, adjudicate: hook });
        expect(withHook.link?.state).toBe(base.link?.state);
        if (base.link?.state !== "CONFIRMED") expect(withHook.link?.state).not.toBe("CONFIRMED");
        return true;
      }),
      { numRuns: 200 },
    );
  });

  it("a proposal validates exactly when its quote occurs in the cited field", () => {
    fc.assert(
      fc.property(recordArb, recordArb, fc.oneof(fc.string({ minLength: 1, maxLength: 12 }), fc.constantFrom("Paige", "Transpara", "EyeArt", "Viz", "ambulatory")), (a, b, quote) => {
        const v = validateProposal({ verdict: "SAME", citations: [{ record: "from", field: "name", quote }], rationale: "" }, a, b);
        const haystack = foldText(a.name ?? "").replace(/\s+/g, " ");
        const needle = foldText(quote).replace(/\s+/g, " ").trim();
        return v.accepted === (needle !== "" && haystack.includes(needle));
      }),
      { numRuns: 300 },
    );
  });

  it("CONFIRMED never comes from the score: every CONFIRMED result has an exact identifier behind it", () => {
    fc.assert(
      fc.property(recordArb, recordArb, linkTypeArb, (a, b, t) => {
        if (a.id === b.id) return true;
        const r = tryResolve(a, b, t);
        if (!r || r.link?.state !== "CONFIRMED") return true;
        return r.candidateClass === "EXACT-IDENTIFIER" && r.exact.kind === "CONFIRMED";
      }),
      { numRuns: 400 },
    );
  });

  it("with identifiers removed from both records, no link type can reach CONFIRMED", () => {
    const strip = (r: IdentityRecord): IdentityRecord => ({
      ...r,
      ids: { submission: [], nct: [], pmid: [], doi: [], udiDi: [] },
      mentions: [],
      supersedes: [],
    });
    fc.assert(
      fc.property(recordArb, recordArb, linkTypeArb, (a, b, t) => {
        if (a.id === b.id) return true;
        const r = tryResolve(strip(a), strip(b), t, WIDE);
        return !r || r.link?.state !== "CONFIRMED";
      }),
      { numRuns: 400 },
    );
  });

  it("the uncertain band never auto-merges: scored results are CANDIDATE only above the band and with corroboration", () => {
    fc.assert(
      fc.property(recordArb, recordArb, linkTypeArb, (a, b, t) => {
        if (a.id === b.id) return true;
        const r = tryResolve(a, b, t);
        if (!r || r.exact.kind !== "NONE" || !r.link) return true;
        if (r.score?.band === "UNCERTAIN") return r.link.state === "AMBIGUOUS";
        if (r.link.state === "CANDIDATE") return r.score?.band === "ABOVE" && r.gate?.strong === true && r.candidateClass === "STRONG-TEXT";
        return r.link.state === "AMBIGUOUS" || r.link.state === "REJECTED";
      }),
      { numRuns: 400 },
    );
  });
});

describe("link types never cross", () => {
  it("a record pair sharing only one kind of identifier is confirmed for no other link type", () => {
    const submission = fc.constantFrom("K221347", "DEN170073", "K200667", "P130020/S001");
    const nct = fc.constantFrom("NCT03112005", "NCT04079478");
    const bare = (id: string, kind: IdentityRecord["kind"], extra: Partial<IdentityRecord>): IdentityRecord => ({
      id, kind, source: "test", aliases: [], purposeTags: [], mentions: [], supersedes: [],
      ids: { submission: [], nct: [], pmid: [], doi: [], udiDi: [] }, ...extra,
    });
    fc.assert(
      fc.property(submission, fc.constantFrom("AuthorizationSubmission", "SoftwareRelease", "MarketedDevice") as fc.Arbitrary<IdentityRecord["kind"]>, (sub, kind) => {
        const a = bare("a", kind, { name: "Alpha", ids: { submission: [sub], nct: [], pmid: [], doi: [], udiDi: [] } });
        const b = bare("b", kind, { name: "Alpha", ids: { submission: [sub], nct: [], pmid: [], doi: [], udiDi: [] } });
        for (const t of LINK_TYPES) {
          const r = tryResolve(a, b, t, WIDE);
          if (t === "SAME_SUBMISSION") expect(r?.link?.state).toBe("CONFIRMED");
          else expect(r?.link?.state).not.toBe("CONFIRMED");
        }
        return true;
      }),
    );
    fc.assert(
      fc.property(nct, (n) => {
        const study = bare("s", "Study", { name: "A trial", ids: { submission: [], nct: [n], pmid: [], doi: [], udiDi: [] } });
        const product = bare("p", "AuthorizationSubmission", { name: "A device", mentions: [{ type: "nct", value: n, channel: "field" }] });
        const other = bare("q", "AuthorizationSubmission", { name: "A device", mentions: [{ type: "nct", value: n, channel: "field" }] });
        expect(tryResolve(study, product, "STUDY_EVALUATES")?.link?.state).toBe("CONFIRMED");
        for (const t of ["SAME_SUBMISSION", "SAME_PRODUCT", "SAME_MARKETED_VERSION"] as const) {
          expect(tryResolve(product, other, t)?.link?.state).not.toBe("CONFIRMED");
        }
        return true;
      }),
    );
  });

  it("an exact-identifier result is always for the link type that identifier supports", () => {
    const supports: Record<LinkType, string> = {
      SAME_SUBMISSION: "submission",
      SAME_MARKETED_VERSION: "device identifier or submission with equal version",
      SAME_PRODUCT: "never",
      STUDY_EVALUATES: "nct or structured submission mention",
      PUBLICATION_REPORTS: "nct mention or structured reference",
      SUPERSEDES: "explicit statement",
    };
    fc.assert(
      fc.property(recordArb, recordArb, linkTypeArb, (a, b, t) => {
        if (a.id === b.id) return true;
        const r = tryResolve(a, b, t);
        if (!r || r.exact.kind !== "CONFIRMED") return true;
        return t !== "SAME_PRODUCT" && supports[t] !== "never";
      }),
      { numRuns: 400 },
    );
  });

  it("a link type that the kinds cannot carry is refused, never answered", () => {
    fc.assert(
      fc.property(recordArb, recordArb, linkTypeArb, (a, b, t) => {
        if (a.id === b.id) return true;
        const applicable = applicableLinkTypes(a, b).includes(t);
        let threw = false;
        try {
          orient(t, a, b);
        } catch {
          threw = true;
        }
        return applicable !== threw;
      }),
      { numRuns: 400 },
    );
  });

  it("orientation puts the study before the product and the publication before the study", () => {
    fc.assert(
      fc.property(recordArb, recordArb, (a, b) => {
        if (a.id === b.id) return true;
        for (const t of ["STUDY_EVALUATES", "PUBLICATION_REPORTS"] as const) {
          const r = tryResolve(a, b, t);
          const r2 = tryResolve(b, a, t);
          if (!r) continue;
          if (r.link?.from !== r2?.link?.from || r.link?.to !== r2?.link?.to) return false;
          const from = rec(r.orientation.from);
          if (t === "PUBLICATION_REPORTS" && from.kind !== "Publication") return false;
          if (t === "STUDY_EVALUATES" && !["Study", "RegistryEntry", "Publication"].includes(from.kind)) return false;
        }
        return true;
      }),
      { numRuns: 300 },
    );
  });
});

describe("score order is stable", () => {
  it("the evidence weight of a pair does not depend on the order it is given in, for undirected link types", () => {
    fc.assert(
      fc.property(recordArb, recordArb, fc.constantFrom(...(["SAME_SUBMISSION", "SAME_PRODUCT", "SAME_MARKETED_VERSION"] as const)), (a, b, t) => {
        if (a.id === b.id) return true;
        const x = tryResolve(a, b, t);
        const y = tryResolve(b, a, t);
        if (!x || !y) return !x && !y;
        return x.score?.weight === y.score?.weight && x.link?.state === y.link?.state && x.link?.id === y.link?.id;
      }),
      { numRuns: 400 },
    );
  });

  it("ranking is identical for any permutation of the pool", () => {
    const pool = ALL.filter((r) => r.kind === "AuthorizationSubmission" || r.kind === "SoftwareRelease").slice(0, 60);
    const target = rec("pubmed:37541274");
    const reference = rankCandidates(target, pool, "STUDY_EVALUATES", { model: MODEL }).map((c) => c.other.id);
    fc.assert(
      fc.property(fc.shuffledSubarray(pool, { minLength: pool.length, maxLength: pool.length }), (shuffled) => {
        const ranked = rankCandidates(target, shuffled, "STUDY_EVALUATES", { model: MODEL }).map((c) => c.other.id);
        return JSON.stringify(ranked) === JSON.stringify(reference);
      }),
      { numRuns: 25 },
    );
  });

  it("the same input always gives the same link id and the same result", () => {
    fc.assert(
      fc.property(recordArb, recordArb, linkTypeArb, (a, b, t) => {
        if (a.id === b.id) return true;
        const x = tryResolve(a, b, t);
        const y = tryResolve(a, b, t);
        return JSON.stringify(x) === JSON.stringify(y);
      }),
      { numRuns: 200 },
    );
  });
});

describe("flags never change a state", () => {
  it("supplying the other known records adds flags but leaves every state as it was", () => {
    fc.assert(
      fc.property(recordArb, recordArb, linkTypeArb, (a, b, t) => {
        if (a.id === b.id) return true;
        let plain, rich;
        try {
          plain = resolveDeterministic(a, b, t, { model: MODEL });
          rich = resolveDeterministic(a, b, t, { model: MODEL, knownRecords: ALL });
        } catch {
          return true;
        }
        return plain.link?.state === rich.link?.state && rich.flags.length >= plain.flags.length && plain.candidateClass === rich.candidateClass;
      }),
      { numRuns: 300 },
    );
  });
});
