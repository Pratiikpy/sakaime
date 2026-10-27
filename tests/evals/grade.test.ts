import { describe, expect, it } from "vitest";
import { exactVector, scoreCase, summarise } from "../../evals/lib/grade.ts";
import type { ArmOutput, CaseKey, Label } from "../../evals/lib/types.ts";

const key = (expectedLabel: Label, over: Partial<CaseKey> = {}): CaseKey => ({ expectedLabel, acceptableLabels: [], keyConfidence: "clear", mismatches: [], ...over });
const out = (label: Label | null, over: Partial<ArmOutput> = {}): ArmOutput => ({ label, status: label === null ? "none" : "ok", mismatches: [], ...over });
const c = (id: string, cluster: string, k: CaseKey, kind: "positive control" | "mismatch" = k.expectedLabel === "SUPPORTED_FOR_SCOPE" ? "positive control" : "mismatch") => ({ id, cluster, kind, key: k });

describe("false-supported", () => {
  it("SUPPORTED_FOR_SCOPE where the key is anything lower is false-supported", () => {
    for (const expected of ["SUPPORTED_ONLY_FOR_NARROWER_SCOPE", "CONTRADICTED_BY_SPECIFIED_EVIDENCE", "INSUFFICIENT_EVIDENCE", "REQUIRES_DOMAIN_REVIEW"] as Label[]) {
      expect(scoreCase(c("x", "a", key(expected)), out("SUPPORTED_FOR_SCOPE")).falseSupported).toBe(true);
    }
  });
  it("a narrower-scope answer is false-supported when the key withholds support, and an under-claim when the key is full", () => {
    expect(scoreCase(c("x", "a", key("INSUFFICIENT_EVIDENCE")), out("SUPPORTED_ONLY_FOR_NARROWER_SCOPE")).falseSupported).toBe(true);
    expect(scoreCase(c("x", "a", key("CONTRADICTED_BY_SPECIFIED_EVIDENCE")), out("SUPPORTED_ONLY_FOR_NARROWER_SCOPE")).falseSupported).toBe(true);
    const underclaim = scoreCase(c("x", "a", key("SUPPORTED_FOR_SCOPE")), out("SUPPORTED_ONLY_FOR_NARROWER_SCOPE"));
    expect(underclaim.falseSupported).toBe(false);
    expect(underclaim.falseAlarm).toBe(true);
  });
  it("withholding labels are never false-supported, and a missing verdict is wrong but not false-supported", () => {
    expect(scoreCase(c("x", "a", key("SUPPORTED_FOR_SCOPE")), out("INSUFFICIENT_EVIDENCE")).falseSupported).toBe(false);
    const none = scoreCase(c("x", "a", key("INSUFFICIENT_EVIDENCE")), { label: null, status: "unavailable", mismatches: [] });
    expect(none.falseSupported).toBe(false);
    expect(none.exact).toBe(false);
    expect(none.acceptable).toBe(false);
  });
  it("an unavailable arm that happens to carry a label is still scored as no verdict", () => {
    const s = scoreCase(c("x", "a", key("SUPPORTED_FOR_SCOPE")), { label: "SUPPORTED_FOR_SCOPE", status: "unavailable", mismatches: [] });
    expect(s.emitted).toBeNull();
    expect(s.correctSupported).toBe(false);
  });
});

describe("exact, acceptable and abstention", () => {
  const contestable = key("INSUFFICIENT_EVIDENCE", { keyConfidence: "contestable", acceptableLabels: ["REQUIRES_DOMAIN_REVIEW", "CONTRADICTED_BY_SPECIFIED_EVIDENCE"] });
  it("an acceptable label is acceptable but not exact", () => {
    const s = scoreCase(c("x", "a", contestable), out("REQUIRES_DOMAIN_REVIEW"));
    expect(s.exact).toBe(false);
    expect(s.acceptable).toBe(true);
    expect(s.abstained).toBe(true);
  });
  it("contestable and abstain-expected keys are abstention cases; clear supported keys are not", () => {
    expect(scoreCase(c("x", "a", contestable), out("INSUFFICIENT_EVIDENCE")).abstentionCase).toBe(true);
    expect(scoreCase(c("x", "a", key("SUPPORTED_FOR_SCOPE")), out("SUPPORTED_FOR_SCOPE")).abstentionCase).toBe(false);
    expect(scoreCase(c("x", "a", key("REQUIRES_DOMAIN_REVIEW")), out("REQUIRES_DOMAIN_REVIEW")).abstentionCase).toBe(true);
  });
});

describe("critical-mismatch recall needs the dimension, both values and a valid anchor", () => {
  const k = key("INSUFFICIENT_EVIDENCE", { mismatches: [{ dimension: "version", claimed: "1.7.2", established: "1.7.0" }] });
  it("full credit", () => {
    const s = scoreCase(c("x", "a", k), out("INSUFFICIENT_EVIDENCE", { mismatches: [{ dimension: "version", claimed: "1.7.2", established: "1.7.0", anchored: true }] }));
    expect([s.dimensionNamed, s.fullyNamed, s.allFullyNamed]).toEqual([1, 1, true]);
  });
  it("the right dimension without an anchor is only dimension credit", () => {
    const s = scoreCase(c("x", "a", k), out("INSUFFICIENT_EVIDENCE", { mismatches: [{ dimension: "version", claimed: "1.7.2", established: "1.7.0", anchored: false }] }));
    expect([s.dimensionNamed, s.fullyNamed]).toEqual([1, 0]);
  });
  it("a missing established value is only dimension credit; the wrong dimension is none", () => {
    expect(scoreCase(c("x", "a", k), out("INSUFFICIENT_EVIDENCE", { mismatches: [{ dimension: "version", claimed: "1.7.2", anchored: true }] })).fullyNamed).toBe(0);
    expect(scoreCase(c("x", "a", k), out("INSUFFICIENT_EVIDENCE", { mismatches: [{ dimension: "population", claimed: "a", established: "b", anchored: true }] })).dimensionNamed).toBe(0);
  });
  it("a case with two key mismatches needs both", () => {
    const k2 = key("INSUFFICIENT_EVIDENCE", { mismatches: [{ dimension: "version", claimed: "", established: "" }, { dimension: "purpose", claimed: "", established: "" }] });
    const one = scoreCase(c("x", "a", k2), out("INSUFFICIENT_EVIDENCE", { mismatches: [{ dimension: "version", claimed: "a", established: "b", anchored: true }] }));
    expect([one.fullyNamed, one.allFullyNamed]).toEqual([1, false]);
  });
});

describe("a refuse-everything arm cannot look good", () => {
  const cases = [
    c("p1", "a", key("SUPPORTED_FOR_SCOPE")),
    c("p2", "b", key("SUPPORTED_FOR_SCOPE")),
    c("m1", "a", key("INSUFFICIENT_EVIDENCE", { mismatches: [{ dimension: "version", claimed: "", established: "" }] })),
    c("m2", "c", key("CONTRADICTED_BY_SPECIFIED_EVIDENCE", { mismatches: [{ dimension: "population", claimed: "", established: "" }] })),
  ];
  const refuse = summarise(cases.map((k) => scoreCase(k, out("INSUFFICIENT_EVIDENCE"))), 1);
  it("zero false-supported beside a false-alarm rate of one and zero correct-SUPPORTED", () => {
    expect([refuse.falseSupported.k, refuse.falseSupported.n]).toEqual([0, 2]);
    expect(refuse.falseSupported.zeroUpper).toBeGreaterThan(0.2);
    expect([refuse.falseAlarm.k, refuse.falseAlarm.n]).toEqual([2, 2]);
    expect(refuse.correctSupported.k).toBe(0);
    expect(refuse.emittedLabels).toEqual({ INSUFFICIENT_EVIDENCE: 4 });
  });
  it("an accept-everything arm is caught by false-supported", () => {
    const accept = summarise(cases.map((k) => scoreCase(k, out("SUPPORTED_FOR_SCOPE"))), 1);
    expect([accept.falseSupported.k, accept.falseSupported.n]).toEqual([2, 2]);
    expect(accept.correctSupported.k).toBe(2);
  });
  it("summaries count clusters and cases, and report the labels emitted", () => {
    expect(refuse.clusters).toBe(3);
    expect(refuse.n).toBe(4);
    expect(refuse.noVerdict).toEqual({ k: 0, n: 4 });
  });
  it("no-verdict outputs are counted in the denominator, not dropped", () => {
    const s = summarise(cases.map((k) => scoreCase(k, { label: null, status: "unavailable", mismatches: [] })), 1);
    expect(s.exact.n).toBe(4);
    expect(s.exact.k).toBe(0);
    expect(s.noVerdict.k).toBe(4);
  });
  it("exactVector follows the order given", () => {
    const rows = cases.map((k) => scoreCase(k, out(k.key.expectedLabel)));
    expect(exactVector(["m2", "p1"], rows)).toEqual([true, true]);
    expect(exactVector(["unknown"], rows)).toEqual([false]);
  });
});
