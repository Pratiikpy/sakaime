/** I-4: a model hypothesis is not a verified link. The hook may annotate; it cannot change a state. */
import { describe, expect, it, vi } from "vitest";
import { resolveDeterministic, resolveLink, validateProposal, type AdjudicateHook } from "../../src/identity/resolver.ts";
import type { ScorerModel } from "../../src/identity/scorer.ts";
import { MODEL, rec } from "./helpers.ts";

/** The committed model with a wide band, so any pair with some evidence sits in the uncertain band. */
const WIDE: ScorerModel = { ...MODEL, thresholds: { pooled: { lower: -100, upper: 100 }, byLinkType: {} } };

const a = rec("pubmed:33904171"); // Paige Prostate independent study
const b = rec("510k:DEN200080"); // Paige Prostate De Novo

const goodProposal = {
  verdict: "SAME",
  citations: [
    { record: "from", field: "text", quote: "Paige Prostate" },
    { record: "to", field: "name", quote: "Paige Prostate" },
  ],
  rationale: "Both name Paige Prostate.",
};

describe("model adjudication inside the uncertain band", () => {
  it("is offered only for pairs in the uncertain band without an exact identifier", async () => {
    const hook = vi.fn<AdjudicateHook>(async () => goodProposal);
    const exactPair = await resolveLink(rec("ctgov:NCT03112005"), rec("510k:K200667"), "STUDY_EVALUATES", { model: WIDE, adjudicate: hook });
    expect(exactPair.link?.state).toBe("CONFIRMED");
    expect(hook).not.toHaveBeenCalled();

    const base = resolveDeterministic(a, b, "STUDY_EVALUATES", { model: WIDE });
    expect(base.adjudicable).toBe(true);
    await resolveLink(a, b, "STUDY_EVALUATES", { model: WIDE, adjudicate: hook });
    expect(hook).toHaveBeenCalledTimes(1);
    const request = hook.mock.calls[0]![0];
    expect(request.from.id).toBe(a.id);
    expect(request.citableFields).toContain("name");
  });

  it("attaches a valid proposal and leaves the state exactly as the deterministic steps set it", async () => {
    const base = resolveDeterministic(a, b, "STUDY_EVALUATES", { model: WIDE });
    const res = await resolveLink(a, b, "STUDY_EVALUATES", { model: WIDE, adjudicate: async () => goodProposal });
    expect(res.modelProposal).toMatchObject({ verdict: "SAME", accepted: true });
    expect(res.link?.state).toBe(base.link?.state);
    expect(res.link?.state).not.toBe("CONFIRMED");
    expect(res.link?.flags.some((f) => f.startsWith("model-hint-same"))).toBe(true);
  });

  it("does not let a DIFFERENT proposal lower a state either", async () => {
    const base = resolveDeterministic(a, b, "STUDY_EVALUATES", { model: WIDE });
    const res = await resolveLink(a, b, "STUDY_EVALUATES", { model: WIDE, adjudicate: async () => ({ ...goodProposal, verdict: "DIFFERENT" }) });
    expect(res.link?.state).toBe(base.link?.state);
  });

  it("rejects a proposal that cites a passage the record does not contain", async () => {
    const res = await resolveLink(a, b, "STUDY_EVALUATES", {
      model: WIDE,
      adjudicate: async () => ({ ...goodProposal, citations: [{ record: "to", field: "name", quote: "Totally Different Device" }] }),
    });
    expect(res.modelProposal?.accepted).toBe(false);
    expect(res.modelProposal?.rejection).toMatch(/not found/);
    expect(res.link?.flags.some((f) => f.startsWith("model-hint-rejected"))).toBe(true);
  });

  it("rejects a proposal with no citations, a malformed shape, or a field outside the allowed list", () => {
    expect(validateProposal({ verdict: "SAME", citations: [], rationale: "x" }, a, b).accepted).toBe(false);
    expect(validateProposal("same", a, b).accepted).toBe(false);
    expect(validateProposal(null, a, b).accepted).toBe(false);
    expect(validateProposal({ verdict: "SAME", citations: [{ record: "to", field: "ids", quote: "x" }], rationale: "" }, a, b).accepted).toBe(false);
    expect(validateProposal({ ...goodProposal, extra: 1 }, a, b).accepted).toBe(false);
  });

  it("reports a failing or hanging hook as unavailable and does not trust it", async () => {
    const failed = await resolveLink(a, b, "STUDY_EVALUATES", { model: WIDE, adjudicate: async () => Promise.reject(new Error("model down")) });
    expect(failed.modelProposal).toBeUndefined();
    expect(failed.link?.flags.some((f) => f.startsWith("adjudication-unavailable: model down"))).toBe(true);

    const slow = await resolveLink(a, b, "STUDY_EVALUATES", {
      model: WIDE,
      adjudicate: () => new Promise(() => undefined),
      adjudicateTimeoutMs: 20,
    });
    expect(slow.link?.flags.some((f) => f.startsWith("adjudication-unavailable"))).toBe(true);
    expect(slow.link?.state).toBe(resolveDeterministic(a, b, "STUDY_EVALUATES", { model: WIDE }).link?.state);
  });

  it("a text quote matches regardless of case, spacing and marks", () => {
    const ok = validateProposal({ verdict: "SAME", citations: [{ record: "from", field: "text", quote: "paige   PROSTATE" }], rationale: "" }, a, b);
    expect(ok.accepted).toBe(true);
  });
});
