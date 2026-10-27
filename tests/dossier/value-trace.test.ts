/**
 * The tie between an assertion's value and unit and the quote it is anchored to (verifier check `assertions.values`).
 * Rule by rule on small strings, then against every assertion the real extractors produce from the tracked fixtures
 * (no false rejection), then against the same assertions with the value altered (no silent acceptance).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertionValueProblem, type TracedAssertion } from "../../src/dossier/value-trace.ts";
import { documentFromText } from "../../src/extraction/document.ts";
import { parseFdaSummary } from "../../src/extraction/fda-summary.ts";
import { parseClinicalTrials } from "../../src/extraction/structured/ctgov.ts";
import { parseEuropePmc } from "../../src/extraction/structured/europepmc.ts";
import { parseOpenFda510k, parseOpenFdaClassification, parseOpenFdaPma, parseOpenFdaUdi } from "../../src/extraction/structured/openfda.ts";
import { parsePubMedXml } from "../../src/extraction/structured/pubmed.ts";
import type { CheckedAssertion } from "../../src/extraction/types.ts";
import { FIXTURES } from "../extraction/helpers.ts";

const a = (predicate: string, value: TracedAssertion["value"], extra: Partial<TracedAssertion> = {}): TracedAssertion => ({ predicate, value, extractionMethod: "pattern", ...extra });
const problem = (x: TracedAssertion, quote: string) => assertionValueProblem(x, quote);

describe("numbers", () => {
  it("accepts a number printed in the quote, with a thousands separator, and rejects another", () => {
    expect(problem(a("study.sample_size", 1284), "A total of 1,284 patients were enrolled.")).toBeUndefined();
    expect(problem(a("study.sample_size", 9000), "A total of 90 patients were enrolled.")?.field).toBe("value");
    expect(problem(a("study.sample_size", 90), "A total of 900 patients were enrolled.")).toBeDefined();
  });

  it("accepts a proportion as its percentage and not an unrelated count as a percentage", () => {
    expect(problem(a("result.sensitivity", 0.912, { unit: "proportion" }), "sensitivity was 91.2% (95% CI 88.0-94.0)")).toBeUndefined();
    expect(problem(a("result.sensitivity", 0.912, { unit: "proportion" }), "sensitivity was 0.912")).toBeUndefined();
    expect(problem(a("result.sensitivity", 0.5, { unit: "proportion" }), "sensitivity was 91.2%")).toBeDefined();
    expect(problem(a("study.sample_size", 5), "a total of 500 patients")).toBeDefined();
  });

  it("accepts a count written as a word up to twenty, as the extractor does, and nothing above", () => {
    expect(problem(a("study.site_count", 3, { unit: "sites" }), "at three sites")).toBeUndefined();
    expect(problem(a("study.site_count", 4, { unit: "sites" }), "at three sites")).toBeDefined();
  });

  it("accepts the age bound a quote states even when the number is not printed", () => {
    expect(problem(a("population.age_min", 22), "excluding subjects 21 years old or younger")).toBeUndefined();
    expect(problem(a("population.age_min", 18), "excluding subjects 21 years old or younger")).toBeDefined();
    expect(problem(a("population.age_min", 0.5, { unit: "years" }), "6 Months")).toBeUndefined();
  });

  it("counts the lines of a structured location list, and rejects a different count", () => {
    const listing = "Clinic A, Boston, United States\nClinic B, Leeds, United Kingdom\nClinic C, Lyon, France";
    const s = (n: number) => a("study.site_count", n, { unit: "sites", extractionMethod: "structured" });
    expect(problem(s(3), listing)).toBeUndefined();
    expect(problem(s(30), listing)?.reason).toMatch(/3 lines, not 30/);
  });

  it("rejects a value that is not a number at all", () => {
    expect(problem(a("study.sample_size", Number.NaN), "n = 12")).toBeDefined();
  });
});

describe("strings", () => {
  it("accepts a product code in the quote and rejects another (the SESE to DENG forgery)", () => {
    const quote = "Decision: Substantially Equivalent (SESE). Product code QAS.";
    expect(problem(a("authorization.decision_code", "SESE", { extractionMethod: "structured" }), quote)).toBeUndefined();
    expect(problem(a("authorization.decision_code", "DENG", { extractionMethod: "structured" }), quote)?.field).toBe("value");
  });

  it("matches through whitespace, case, line-end hyphenation and typographic dashes", () => {
    expect(problem(a("device.name", "EyeArt v2.1.0"), "The  EyeArt\nV2.1.0 system")).toBeUndefined();
    expect(problem(a("device.name", "Smart-Triage"), "the Smart‑Triage module")).toBeUndefined();
    expect(problem(a("device.name", "Smart-Triage"), "the Smart Other module")).toBeDefined();
  });

  it("holds every string of a list to the quote", () => {
    expect(problem(a("indicated_versions", ["3.1", "3.2"]), "versions 3.1 and 3.2")).toBeUndefined();
    expect(problem(a("indicated_versions", ["3.1", "9.9"]), "versions 3.1 and 3.2")?.reason).toMatch(/9\.9/);
    expect(problem(a("indicated_versions", ["3.1", ""]), "versions 3.1 and 3.2")).toBeDefined();
  });

  it("accepts a date in the ordinary renderings and rejects another date", () => {
    for (const quote of ["Dated August 3, 2020.", "dated 3 August 2020", "2020-Aug-03", "8/3/2020", "20200803", "Aug. 3rd, 2020", "2020-08-03"]) {
      expect(problem(a("authorization.letter_date", "2020-08-03"), quote), quote).toBeUndefined();
    }
    expect(problem(a("authorization.letter_date", "2020-08-04"), "Dated August 3, 2020.")).toBeDefined();
    expect(problem(a("authorization.letter_date", "2019-08-03"), "Dated August 3, 2020.")).toBeDefined();
    expect(problem(a("publication.date", "2021-11"), "published November 2021")).toBeUndefined();
    expect(problem(a("publication.date", "2021-12"), "published November 2021")).toBeDefined();
    expect(problem(a("publication.date", "2021-13-01"), "published in 2021")).toBeDefined();
  });

  it("holds a controlled term to its lexicon pattern, and refuses a term that is not in the list", () => {
    expect(problem(a("indication.setting_term", "emergency department"), "used in the emergency department")).toBeUndefined();
    expect(problem(a("indication.setting_term", "primary care"), "used in the emergency department")?.reason).toMatch(/does not contain/);
    expect(problem(a("indication.setting_term", "operating theatre"), "used in the operating theatre")?.reason).toMatch(/not a term of the controlled list/);
    expect(problem(a("population.group_term", "adults"), "for adult patients")).toBeUndefined();
  });

  it("accepts the fixed exclusion word only for a sentence that excludes diagnostic use", () => {
    expect(problem(a("indication.purpose_exclusion", "diagnosis"), "The device is not intended for stand-alone diagnostic use.")).toBeUndefined();
    expect(problem(a("indication.purpose_exclusion", "diagnosis"), "The device is intended for triage.")).toBeDefined();
    expect(problem(a("indication.purpose_exclusion", "treatment"), "The device is not intended for stand-alone diagnostic use.")).toBeDefined();
  });

  it("holds a device mix to its vendor and its percentage", () => {
    expect(problem(a("study.device_mix", "Hologic 36%"), "Hologic: 36% GE: 40%")).toBeUndefined();
    expect(problem(a("study.device_mix", "Hologic 66%"), "Hologic: 36% GE: 40%")).toBeDefined();
    expect(problem(a("study.device_mix", "Siemens 36%"), "Hologic: 36% GE: 40%")).toBeDefined();
    expect(problem(a("study.device_mix", "Hologic"), "Hologic: 36%")).toBeDefined();
  });

  it("does not check a boolean, which has no text form", () => {
    expect(problem(a("population.healthy_volunteers", true), "Accepts healthy volunteers: No")).toBeUndefined();
  });
});

describe("units", () => {
  it("accepts the units the extractor emits and rejects an invented one", () => {
    expect(problem(a("study.sample_size", 412, { unit: "patients" }), "412 patients")).toBeUndefined();
    expect(problem(a("study.sample_size", 412, { unit: "eyes" }), "412 patients")?.field).toBe("unit");
    expect(problem(a("study.sample_size", 412, { unit: "banana" }), "412 banana")?.reason).toMatch(/not a unit the extractor emits/);
    expect(problem(a("population.age_min", 18, { unit: "years" }), "aged 18 and older")).toBeUndefined();
  });

  it("lets a structured field carry its unit without the word in the quote, but not a pattern", () => {
    expect(problem(a("study.sample_size", 942, { unit: "participants", extractionMethod: "structured" }), "942")).toBeUndefined();
    expect(problem(a("study.sample_size", 942, { unit: "participants" }), "942")?.field).toBe("unit");
  });

  it("keeps a proportion between 0 and 1, and rejects a unit on a text value", () => {
    expect(problem(a("result.auc", 1.4, { unit: "proportion" }), "AUC 1.4")?.reason).toMatch(/between 0 and 1/);
    expect(problem(a("device.name", "EyeArt", { unit: "patients" }), "EyeArt")?.field).toBe("unit");
  });

  it("leaves a model's or reviewer's free-text unit alone, but still ties their number to the quote", () => {
    expect(problem(a("reported_sensitivity", 0.91, { unit: "fraction", extractionMethod: "model" }), "Sensitivity 0.91")).toBeUndefined();
    expect(problem(a("reported_sensitivity", 0.99, { unit: "fraction", extractionMethod: "model" }), "Sensitivity 0.91")?.field).toBe("value");
  });
});

// ---------------------------------------------------------------- the real extractors

async function realAssertions(): Promise<{ source: string; checked: CheckedAssertion }[]> {
  const out: { source: string; checked: CheckedAssertion }[] = [];
  // An error response saved as a fixture (a 404 body) is refused by the parser, which is the right behaviour and not under test here.
  const run = async (source: string, f: () => Promise<{ extraction: { kept: CheckedAssertion[] } }>) => {
    try {
      for (const checked of (await f()).extraction.kept) out.push({ source, checked });
    } catch {
      /* refused by the parser */
    }
  };
  const read = (...p: string[]) => readFileSync(join(FIXTURES, ...p), "utf8");
  for (const f of readdirSync(join(FIXTURES, "fda")).filter((x) => x.endsWith("_summary_text.txt"))) {
    await run(`fda/${f}`, () => parseFdaSummary(documentFromText(f.split("_")[0] as string, read("fda", f))));
  }
  for (const f of readdirSync(join(FIXTURES, "ctgov"))) await run(`ctgov/${f}`, () => parseClinicalTrials(read("ctgov", f), f));
  for (const f of readdirSync(join(FIXTURES, "europepmc")).filter((x) => x.startsWith("ep_"))) await run(`europepmc/${f}`, () => parseEuropePmc(read("europepmc", f), f));
  for (const f of readdirSync(join(FIXTURES, "pubmed"))) await run(`pubmed/${f}`, () => parsePubMedXml(read("pubmed", f), f));
  for (const f of readdirSync(join(FIXTURES, "openfda"))) {
    const parse = f.startsWith("510k") ? parseOpenFda510k : f.startsWith("udi") ? parseOpenFdaUdi : f.startsWith("pma") ? parseOpenFdaPma : parseOpenFdaClassification;
    await run(`openfda/${f}`, () => parse(read("openfda", f), f));
  }
  return out;
}

describe("against the assertions the real extractors produce", () => {
  it("accepts every assertion read from the tracked FDA, registry, openFDA, PubMed and Europe PMC fixtures", async () => {
    const all = await realAssertions();
    expect(all.length).toBeGreaterThan(3000);
    const rejected = all.flatMap(({ source, checked }) => {
      const p = assertionValueProblem(checked.assertion, checked.anchor.text);
      return p ? [`${source} ${checked.assertion.predicate} ${JSON.stringify(checked.assertion.value)}: ${p.reason}`] : [];
    });
    expect(rejected).toEqual([]);
  });

  it("rejects the same assertions once their value is altered", async () => {
    const all = await realAssertions();
    let altered = 0;
    const accepted: string[] = [];
    for (const { source, checked } of all) {
      const x = checked.assertion;
      if (typeof x.value === "boolean") continue;
      const value = typeof x.value === "number" ? x.value * 7 + 13 : Array.isArray(x.value) ? [...x.value, "zq-not-in-any-quote"] : `${x.value} zq-not-in-any-quote`;
      altered++;
      if (assertionValueProblem({ ...x, value }, checked.anchor.text) === undefined) accepted.push(`${source} ${x.predicate} ${JSON.stringify(x.value)} -> ${JSON.stringify(value)}`);
    }
    expect(altered).toBeGreaterThan(3000);
    expect(accepted).toEqual([]);
  });

  it("rejects the same assertions once their unit is replaced, wherever the assertion has one", async () => {
    const all = await realAssertions();
    let withUnit = 0;
    const accepted: string[] = [];
    for (const { source, checked } of all) {
      const x = checked.assertion;
      if (x.unit === undefined || x.unit === "proportion") continue;
      withUnit++;
      if (assertionValueProblem({ ...x, unit: "zq-unit" }, checked.anchor.text) === undefined) accepted.push(`${source} ${x.predicate}`);
    }
    expect(withUnit).toBeGreaterThan(50);
    expect(accepted).toEqual([]);
  });
});
