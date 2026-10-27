import { describe, expect, it } from "vitest";
import { parseAgeBounds, parseRegistryAge, summariseAge } from "../../src/extraction/age.ts";
import { scanStatements } from "../../src/extraction/stats.ts";
import { looksLikeHeading, sentenceSpans } from "../../src/extraction/text.ts";

const scan = (s: string) => scanStatements(s).bindings.map((b) => ({ m: b.metric, v: b.value, kind: b.kind, ci: b.ci, q: b.qualifiers }));

describe("performance statements: which number belongs to which metric", () => {
  it("zips a paired sentence in order", () => {
    const r = scan("Sensitivity and specificity were 87.8% (95% CI: 81.2% - 92.5% and 89.6% 95% CI: 83.7% - 93.9% respectively.");
    expect(r.map((x) => [x.m, x.v])).toEqual([["sensitivity", 0.878], ["specificity", 0.896]]);
    expect(r[0]?.ci).toEqual([0.812, 0.925]);
  });

  it("binds a value that comes before its metric word", () => {
    const r = scan("ROC AUC was 0.9864 (95% CI: 0.9815 \u2013 0.9913) with 94.29% sensitivity and 95.72% specificity.");
    expect(r.map((x) => [x.m, x.v])).toEqual([["auc", 0.9864], ["sensitivity", 0.9429], ["specificity", 0.9572]]);
  });

  it("separates a prespecified goal from the observed result", () => {
    const r = scan("Performance thresholds were defined at 85.0% for sensitivity and 82.5% for specificity.");
    expect(r.every((x) => x.kind === "goal")).toBe(true);
    expect(scan("Primary endpoints were sensitivity and specificity with an 80% performance goal.").map((x) => [x.m, x.kind])).toEqual([["sensitivity", "goal"], ["specificity", "goal"]]);
    expect(scan("Sensitivity 80% or higher")[0]?.kind).toBe("goal");
  });

  it("labels enrichment-corrected, worst-case, development and reader-arm figures", () => {
    expect(scan("Sensitivity corrected for enrichment was also high, at 87.2% (95% CI, 81.8% - 91.2%).")[0]?.q).toContain("enrichment_corrected");
    expect(scan("In the worst case scenario, the sensitivity would have been 80.7% (two-sided 95% CI, 76.7%-84.2%).")[0]?.q).toContain("worst_case");
    expect(scan("In the training set, sensitivity was 91.0%.")[0]?.q).toContain("development_set");
    expect(scan("The average sensitivity went from 0.706 [0.633 \u2013 0.780] in unaided reading conditions to 0.793 [0.725 \u2013 0.860] in assisted reading.")[0]?.q).toContain("reader_arm");
  });

  it("keeps a standalone figure out of the reader-arm group even when readers are discussed after it", () => {
    const r = scan("The AUC of the system as a standalone device was 0.883 [0.837 \u2013 0.929] and superior to radiologists in unaided reading conditions.");
    expect(r[0]?.q).not.toContain("reader_arm");
  });

  it("does not read a difference, an interval end, a prevalence or a negative figure as a result", () => {
    expect(scan("AUC=+0.085 [0.044 \u2013 0.127], p-value <0.0001")).toEqual([]);
    expect(scan("The estimated difference in sensitivity is -3.1%.")).toEqual([]);
    expect(scan("PPV and NPV were analysed with an adjusted prevalence of 4.36%.")).toEqual([]);
    expect(scan("Specificity [85.1% - 97.5%]")).toEqual([]);
  });

  it("attributes figures after the word predicate to the predicate", () => {
    const r = scan("EFAI demonstrated sensitivity of 0.928 (95% CI: 0.873\u20130.960) and specificity of 0.932 (95% CI: 0.882\u20130.961), showing equivalence to the predicate device, with sensitivity of 0.910 (95% CI: 0.815\u20130.967) and specificity of 0.889 (95% CI: 0.817\u20130.940).");
    expect(r.map((x) => x.q.includes("predicate_value"))).toEqual([false, false, true, true]);
  });

  it("reads PPA and NPA only when the document says it spells them out", () => {
    expect(scanStatements("Encounter-level PPA 79.4% (95% CI 74.2-84.6)").bindings).toHaveLength(0);
    expect(scanStatements("Encounter-level PPA 79.4% (95% CI 74.2-84.6)", { agreementAcronyms: true }).bindings[0]?.metric).toBe("ppa");
  });

  it("marks a table row with several values or a repeated metric, and does not mark prose", () => {
    const row = scan("Specificity            100.0% [74.1% - 100%]              94.9% [86.4% - 100.0%]");
    expect(row.every((x) => x.q.includes("multi_value_row"))).toBe(true);
    expect(scan("Sensitivity 89.86% (95% CI: [86.72, Sensitivity 96.74% (95% CI: [92.79;").every((x) => x.q.includes("multi_value_row"))).toBe(true);
    expect(scan("The device achieved a sensitivity of 84.5% (95% CI of 82.2% to 86.6%), a specificity of 83.6% (95% CI of 82.9% to 84.2%).").some((x) => x.q.includes("multi_value_row"))).toBe(false);
  });

  it("reports values it could not bind rather than guessing", () => {
    const r = scanStatements("Sensitivity and specificity improved. The prevalence was 23.8% in 819 participants and 7.1% had type 1 diabetes.");
    expect(r.bindings).toHaveLength(0);
    expect(scanStatements("Of those, 28 of 29 (96%; 95% CI, 83%-99%) participants with CSDME were identified, and sensitivity improved.").unbound.length).toBeGreaterThan(0);
  });
});

describe("age limits: direction decides the bound, a negation flips it", () => {
  const bounds = (t: string) => parseAgeBounds(t).map((b) => [b.kind, b.years, b.exclusive]);

  it("reads the real wordings from the FDA summaries", () => {
    expect(bounds("adult patients (ages 22 and above)")).toEqual([["min", 22, false]]);
    expect(bounds("adults or transitional adolescents aged 18 and older")).toEqual([["min", 18, false]]);
    expect(bounds("The patient is older than 22 years of age")).toEqual([["min", 22, true]]);
    expect(bounds("women aged 40 to 74 years")).toEqual([["min", 40, false], ["max", 74, false]]);
  });

  it("turns 'not intended for patients under 22' into a MINIMUM of 22", () => {
    const b = parseAgeBounds("not intended to be used as a diagnostic device or for use in patients under 22 years of age");
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ kind: "min", years: 22, exclusive: false, fromExclusion: true });
  });

  it("flips 'excluding subjects 21 years old or younger' to a minimum of 22", () => {
    expect(summariseAge(parseAgeBounds("after excluding subjects who did not meet criteria (e.g., subjects 21 years old or younger)"))).toEqual({ min: 22 });
  });

  it("reads symbolic limits and ignores a symbol whose glyph was lost", () => {
    expect(bounds("adult patients (\u226518 years old)")).toEqual([["min", 18, false]]);
    expect(bounds("age \u2265 18 with at least one dyspnea code")).toEqual([["min", 18, false]]);
    expect(bounds("age \uFFFD 18 with at least one code")).toEqual([]);
    expect(bounds("age 18 with at least one code")).toEqual([]);
  });

  it("does not read a count as an age", () => {
    expect(bounds("over 5 sites and 12 months, 300 images")).toEqual([]);
  });

  it("moves a strict bound one year inward and leaves an unstated side open", () => {
    expect(summariseAge(parseAgeBounds("older than 22 years"))).toEqual({ min: 23 });
    expect(summariseAge([])).toEqual({});
  });

  it("parses registry age fields and leaves N/A open", () => {
    expect(parseRegistryAge("18 Years")).toBe(18);
    expect(parseRegistryAge("6 Months")).toBeCloseTo(0.5, 3);
    expect(parseRegistryAge("N/A")).toBeUndefined();
    expect(parseRegistryAge(undefined)).toBeUndefined();
    expect(parseRegistryAge("adult")).toBeUndefined();
  });
});

describe("sentence spans", () => {
  const spans = (t: string) => sentenceSpans(t).map((s) => t.slice(s.start, s.end).replace(/\s+/g, " "));

  it("splits after IDx-DR. (an all-capitals word) but not after Dr. or a decimal", () => {
    expect(spans("The outcomes were measured for IDx-DR. Performance goals were 85.0% for sensitivity.")).toHaveLength(2);
    expect(spans("Seen by Dr. Smith at 94.2% sensitivity.")).toHaveLength(1);
  });

  it("keeps a table row on its own and a heading apart from the next sentence", () => {
    const t = "Study Endpoint Results\nA total of 900 participants were enrolled.\n\nSensitivity            94.2%      (89.6-97.2)\nSpecificity            94.6%";
    const s = spans(t);
    expect(s[0]).toBe("Study Endpoint Results");
    expect(s[1]).toBe("A total of 900 participants were enrolled.");
    expect(s.some((x) => x.startsWith("Sensitivity 94.2%"))).toBe(true);
  });

  it("treats a key-value line as a row", () => {
    expect(spans("Sensitivity \uFFFD 87%\nSpecificity \uFFFD 90%").length).toBe(2);
    expect(looksLikeHeading("Summary of Technological Characteristics")).toBe(true);
    expect(looksLikeHeading("the device was tested on")).toBe(false);
  });
});
