/**
 * The corpus is only worth measuring against if it is what it says it is: real records, honestly labelled.
 * These tests re-read the pinned fixtures and check every record against them, check the labelling metadata,
 * and hold the measured behaviour of the resolver on the corpus to its recorded floor.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "csv-parse/sync";
import { describe, expect, it } from "vitest";
import { crossFamilySweep, fitModel, outcomeOf, runInSample, runLeaveOneFamilyOut, summarise } from "../../src/identity/evaluate.ts";
import { loadReference } from "../../src/identity/run-eval.ts";
import { hashOf } from "../../src/util/canonical.ts";
import { FIXTURES, MODEL, REPO, corpus, readFixture } from "./helpers.ts";

const ws = (s: string) => s.replace(/\s+/g, " ").trim();

function xmlArticle(file: string, pmid: string): string {
  const xml = readFixture(`pubmed/${file}`);
  for (const block of xml.split("<PubmedArticle>").slice(1)) {
    if (new RegExp(`<PMID[^>]*>${pmid}</PMID>`).test(block)) return block;
  }
  throw new Error(`PMID ${pmid} not in ${file}`);
}

describe("every record matches the pinned public data it cites", () => {
  const c = corpus();
  const csv = parse(readFixture("fda/ai-enabled-devices.csv"), { columns: true }) as Record<string, string>[];
  const bySub = new Map(csv.map((r) => [r["Submission Number"]!, r]));
  const isoDate = (us: string) => `${us.slice(6, 10)}-${us.slice(0, 2)}-${us.slice(3, 5)}`;

  for (const { record: r } of c.records.values()) {
    it(`${r.id}`, () => {
      expect(r.fixtureRef, "a record must say where it came from").toBeTruthy();
      const [path, selector = ""] = r.fixtureRef!.split("#");
      if (path === "fda/ai-enabled-devices.csv") {
        const row = bySub.get(selector)!;
        expect(row, `row ${selector}`).toBeDefined();
        expect(r.name).toBe(row["Device"]);
        expect(r.manufacturer).toBe(row["Company"]);
        expect(r.productCode).toBe(row["Primary Product Code"]);
        expect(r.date).toBe(isoDate(row["Date of Final Decision"]!));
        expect(r.ids.submission).toEqual([selector]);
      } else if (/^openfda\/510k_/.test(path!)) {
        const x = (JSON.parse(readFixture(path!)) as { results: Record<string, string>[] }).results[0]!;
        expect(r.name).toBe(x["device_name"]);
        expect(r.manufacturer).toBe(x["applicant"]);
        expect(r.productCode).toBe(x["product_code"]);
        expect(r.date).toBe(x["decision_date"]);
        expect(r.ids.submission).toEqual([x["k_number"]]);
      } else if (/^openfda\/udi_/.test(path!)) {
        const i = Number(/results\[(\d+)\]/.exec(selector)![1]);
        const x = (JSON.parse(readFixture(path!)) as { results: Record<string, any>[] }).results[i]!;
        expect(r.name).toBe(x["brand_name"]);
        expect(r.version).toBe(x["version_or_model_number"]);
        expect(r.manufacturer).toBe(x["company_name"]);
        expect(r.ids.udiDi).toEqual(x["identifiers"].filter((d: any) => d.type === "Primary").map((d: any) => d.id));
        expect(r.ids.submission.map((s) => s.split("/")[0])).toEqual(x["premarket_submissions"].map((p: any) => p.submission_number));
      } else if (/^ctgov\/study_/.test(path!)) {
        const p = (JSON.parse(readFixture(path!)) as any).protocolSection;
        expect(r.name).toBe(p.identificationModule.briefTitle);
        expect(r.sponsor).toBe(p.sponsorCollaboratorsModule.leadSponsor.name);
        expect(r.ids.nct).toEqual([p.identificationModule.nctId]);
        if (r.enrollment !== undefined) expect(r.enrollment).toBe(p.designModule.enrollmentInfo.count);
        for (const m of r.mentions.filter((m) => m.type === "pmid")) {
          const ref = p.referencesModule.references.find((x: any) => x.pmid === m.value);
          expect(ref, `reference ${m.value}`).toBeDefined();
          expect(m.role).toBe(({ RESULT: "report", DERIVED: "report", BACKGROUND: "background" } as Record<string, string>)[ref.type]);
        }
      } else if (/^ctgov\/search_/.test(path!)) {
        const studies = (JSON.parse(readFixture(path!)) as any).studies as any[];
        const p = studies.find((s) => s.protocolSection.identificationModule.nctId === selector).protocolSection;
        expect(r.name).toBe(p.identificationModule.briefTitle);
        expect(r.sponsor).toBe(p.sponsorCollaboratorsModule.leadSponsor.name);
      } else if (/^pubmed\//.test(path!)) {
        const block = xmlArticle(path!.split("/")[1]!, selector);
        const title = /<ArticleTitle[^>]*>([\s\S]*?)<\/ArticleTitle>/.exec(block)![1]!.replace(/<[^>]+>/g, "");
        expect(ws(r.text!).startsWith(ws(title).slice(0, 60))).toBe(true);
        expect(r.ids.pmid).toEqual([selector]);
        for (const m of r.mentions.filter((m) => m.type === "nct" && m.channel === "field")) expect(block).toContain(`<AccessionNumber>${m.value}</AccessionNumber>`);
      } else if (/^fda\/.*_summary_text\.txt$/.test(path!)) {
        expect(ws(readFixture(path!))).toContain(selector);
        expect(r.source).toBe("derived-from-fda-summary");
      } else {
        throw new Error(`unrecognised fixtureRef ${r.fixtureRef}`);
      }
    });
  }

  it("every quoted passage in a text mention occurs in the document it was taken from", () => {
    let checked = 0;
    for (const { record: r } of c.records.values()) {
      for (const m of r.mentions.filter((m) => m.channel === "text")) {
        const source = r.kind === "Publication" ? r.text! : readFixture(`fda/${r.ids.submission[0]}_summary_text.txt`);
        expect(ws(source), `${r.id} ${m.value}`).toContain(ws(m.context!));
        expect(ws(m.context!)).toContain(m.value);
        checked++;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(4);
  });

  it("the Viz LVO releases are the real GUDID records", () => {
    const gudid = [...c.records.values()].map((r) => r.record).filter((r) => r.id.startsWith("gudid:DEN170073:"));
    expect(gudid.length).toBeGreaterThanOrEqual(7);
    expect(new Set(gudid.map((r) => r.ids.udiDi[0])).size).toBe(gudid.length);
  });
});

describe("labelling is stated honestly", () => {
  const c = corpus();

  it("every pair has a reason, a report section, one builder reader and no claim of independence", () => {
    for (const p of c.pairs) {
      expect(p.reason.length, p.id).toBeGreaterThan(15);
      expect(["s2", "s4", "s5", "s6"], p.id).toContain(p.reportSection);
      expect(p.labelling).toEqual({ reader: "builder", readers: 1, independent: false });
    }
  });

  it("no pair is listed twice and none links a record to itself", () => {
    const seen = new Set<string>();
    for (const p of c.pairs) {
      expect(p.a).not.toBe(p.b);
      const key = `${p.linkType}|${[p.a, p.b].sort().join("|")}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("identifier-labelled pairs are the ones an identifier settles", () => {
    for (const p of c.pairs.filter((p) => p.expectConfirmed)) expect(p.labelBasis, p.id).toBe("identifier");
    for (const p of c.pairs.filter((p) => p.truth === "AMBIGUOUS")) expect(p.labelBasis, p.id).toBe("reading");
  });

  it("contains the collisions the feasibility report names", () => {
    const has = (a: string, b: string) => c.pairs.some((p) => [p.a, p.b].sort().join() === [a, b].sort().join());
    expect(has("list:K251153", "list:K231355")).toBe(true); // Aurora, GE and EnsoData
    expect(has("list:K243349", "list:K192732")).toBe(true); // BodyGuardian
    expect(has("510k:K221347", "list:K210404")).toBe(true); // Transpara 1.7.2 and 1.7.0
    expect(has("gudid:DEN170073:1.5", "gudid:DEN170073:1.6")).toBe(true); // Viz LVO releases
    expect(has("pubmed:35183401", "510k:DEN170073")).toBe(true); // ContaCT collision
    expect(has("ctgov:NCT04996316", "510k:K240301")).toBe(true); // second MammoScreen
    expect(has("pubmed:41444826", "510k:K253265")).toBe(true); // BriefCase ICH against abdominal
    expect(has("pubmed:40233023", "510k:K211733")).toBe(true); // Lunit TB against triage
    expect(has("pubmed:32393768", "510k:DEN200080")).toBe(true); // Paige Alpha build
    expect(has("ctgov:NCT01694966", "510k:DEN200055")).toBe(true); // GI Genius training-data trial
  });

  it("covers all five identity-bearing link types and all three truths", () => {
    expect(new Set(c.pairs.map((p) => p.linkType))).toEqual(new Set(["SAME_SUBMISSION", "SAME_PRODUCT", "SAME_MARKETED_VERSION", "STUDY_EVALUATES", "PUBLICATION_REPORTS"]));
    expect(new Set(c.pairs.map((p) => p.truth))).toEqual(new Set(["MATCH", "NON_MATCH", "AMBIGUOUS"]));
    expect(new Set(c.pairs.map((p) => p.family)).size).toBeGreaterThanOrEqual(12);
  });
});

describe("measured behaviour on the corpus", () => {
  const c = corpus();
  const reference = loadReference();
  const cv = runLeaveOneFamilyOut(c, reference);
  const inSample = runInSample(c, reference);

  it("never confirms a link whose truth is not MATCH, in either run", () => {
    expect(summarise(cv.outcomes).falseConfirms).toBe(0);
    expect(summarise(inSample.outcomes).falseConfirms).toBe(0);
  });

  it("merges no non-match and leaves no ambiguous pair as a link on unseen devices", () => {
    const m = summarise(cv.outcomes);
    expect(m.falseMergeRate.k).toBe(0);
    expect(m.overconfidentOnAmbiguous.k).toBe(0);
    expect(cv.outcomes.filter((o) => o.pair.family === "easy" && o.verdict === "LINK")).toEqual([]);
  });

  it("calls nothing a link across device families, over thousands of unlabelled combinations", () => {
    const sweep = crossFamilySweep(c, MODEL);
    expect(sweep.combinations).toBeGreaterThan(5000);
    expect(sweep.links).toEqual([]);
  });

  it("reaches CONFIRMED for every pair an exact identifier should settle", () => {
    const expected = cv.outcomes.filter((o) => o.pair.expectConfirmed);
    expect(expected.length).toBeGreaterThanOrEqual(15);
    for (const o of expected) expect(o.state, o.pair.id).toBe("CONFIRMED");
  });

  it("shows the mismatch flags a reviewer needs on every pair that expects them", () => {
    for (const o of cv.outcomes.filter((o) => o.flagsHit === false)) expect.fail(`${o.pair.id} is missing a flag: ${o.pair.expectedFlags.join(", ")} (got ${o.flags.join("; ")})`);
  });

  it("keeps recall and abstention above the recorded floor (leave-one-family-out)", () => {
    const m = summarise(cv.outcomes.filter((o) => o.pair.family !== "easy"));
    expect(m.precision.rate).toBe(1);
    expect(m.recall.rate!).toBeGreaterThan(0.7);
    expect(m.surfacedRecall.rate!).toBeGreaterThan(0.9);
    expect(m.correctAbstention.rate!).toBeGreaterThan(0.8);
  });

  it("every disagreement about a true link is an abstention or a silent miss, never a rejection", () => {
    for (const o of cv.outcomes.filter((o) => o.pair.truth === "MATCH" && o.verdict !== "LINK")) expect(["ABSTAIN", "SILENT"], o.pair.id).toContain(o.verdict);
  });

  it("the committed default model is the one this corpus and reference list produce", () => {
    const fresh = fitModel(c, reference);
    expect(fresh.training.contentHash).toBe(MODEL.training.contentHash);
    expect(JSON.parse(JSON.stringify(fresh))).toEqual(JSON.parse(JSON.stringify(MODEL)));
  });

  it("RESULTS.md was produced from the current corpus and model", () => {
    const text = readFileSync(join(REPO, "data", "identity-corpus", "RESULTS.md"), "utf8");
    const corpusHash = hashOf({ records: [...c.records.values()], pairs: c.pairs }).slice(0, 16);
    expect(text).toContain(`Corpus hash ${corpusHash}`);
    expect(text).toContain(`model hash ${MODEL.training.contentHash.slice(0, 16)}`);
  });

  it("a single pair resolves to the same outcome through the evaluation path and directly", () => {
    const pair = c.pairs.find((p) => p.expectConfirmed)!;
    expect(outcomeOf(pair, c, MODEL).state).toBe("CONFIRMED");
  });

  it("reads fixtures only under the repository's pinned folder", () => {
    expect(FIXTURES.endsWith(join("research", "feasibility", "fixtures"))).toBe(true);
  });
});
