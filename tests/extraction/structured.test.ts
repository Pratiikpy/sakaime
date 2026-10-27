import { describe, expect, it } from "vitest";
import { parseClinicalTrials, parseCriteria } from "../../src/extraction/structured/ctgov.ts";
import { cleanEpmcTitle, parseEuropePmc } from "../../src/extraction/structured/europepmc.ts";
import { parseOpenFda510k, parseOpenFdaClassification, parseOpenFdaPma, parseOpenFdaUdi } from "../../src/extraction/structured/openfda.ts";
import { parsePubMedXml } from "../../src/extraction/structured/pubmed.ts";
import { isUsable } from "../../src/extraction/verify.ts";
import { PortError } from "../../src/ports/index.ts";
import { fixture } from "./helpers.ts";

const usable = (r: { extraction: { kept: Parameters<typeof isUsable>[0][] } }, predicate: string) =>
  r.extraction.kept.filter((k) => k.assertion.predicate === predicate && isUsable(k));
const vals = (r: Parameters<typeof usable>[0], p: string) => usable(r, p).map((k) => k.assertion.value);

async function failure(p: Promise<unknown>): Promise<PortError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(PortError);
    return e as PortError;
  }
  throw new Error("expected a PortError");
}

describe("openFDA", () => {
  it("reads a 510(k) record into anchored fields", async () => {
    const r = await parseOpenFda510k(fixture("openfda", "510k_K200667.json"), "510k_K200667");
    expect(r.health).toBe("OK");
    expect(r.facts.clearances[0]).toMatchObject({ number: "K200667", deviceName: "EyeArt", applicant: "Eyenuk, Inc.", decisionDate: "2020-08-03", productCode: "PIB", regulationNumber: "886.1100" });
    expect(vals(r, "authorization.decision_date")).toEqual(["2020-08-03"]);
    const a = usable(r, "authorization.decision_date")[0]?.anchor;
    expect(a?.jsonPath).toBe("$.results[0].decision_date");
    expect(a?.text).toBe("2020-08-03");
    expect(r.extraction.counts.quote.failed).toBe(0);
  });

  it("recognises a De Novo number in the same endpoint", async () => {
    const r = await parseOpenFda510k(fixture("openfda", "510k_DEN170073.json"), "den");
    expect(r.facts.clearances[0]?.number).toBe("DEN170073");
    expect(r.facts.clearances[0]?.decisionCode).toBe("DENG");
  });

  it("returns every GUDID version label and ties it to the submission", async () => {
    const r = await parseOpenFdaUdi(fixture("openfda", "udi_DEN170073.json"), "udi");
    expect(r.facts.devices).toHaveLength(11);
    expect(new Set(r.facts.devices.map((d) => d.versionOrModel))).toEqual(new Set(["1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.8", "1.9", "1.10", "1.11"]));
    expect(r.facts.devices.every((d) => d.premarketSubmissions[0]?.number === "DEN170073")).toBe(true);
    expect(vals(r, "device.premarket_submission")).toHaveLength(11);
    expect(usable(r, "device.version")[0]?.assertion.assertionType).toBe("vendor");
  });

  it("leaves an unfiled GUDID version absent", async () => {
    const r = await parseOpenFdaUdi(fixture("openfda", "udi_DEN190040.json"), "udi2");
    expect(r.facts.devices.length).toBeGreaterThan(0);
    for (const d of r.facts.devices) if (d.versionOrModel === undefined) expect(usable(r, "device.version").length).toBeLessThan(r.facts.devices.length);
  });

  it("reads a PMA record and reports that the response is truncated", async () => {
    const r = await parseOpenFdaPma(fixture("openfda", "pma_P130020.json"), "pma");
    expect(r.facts.records[0]?.number).toBe("P130020");
    expect(r.truncated).toEqual({ returned: 2, total: 6 });
    expect(vals(r, "authorization.change_statement")[0]).toContain("algorithm updates");
  });

  it("reads a classification and counts, but does not carry, its clearance list", async () => {
    const r = await parseOpenFdaClassification(fixture("openfda", "classification_QAS.json"), "cls");
    expect(r.facts.classifications[0]).toMatchObject({ productCode: "QAS", regulationNumber: "892.2080", deviceClass: "2" });
    expect(r.facts.classifications[0]?.clearanceCount).toBeGreaterThan(50);
  });

  it("keeps EMPTY, UNAVAILABLE, DRIFTED and INVALID apart", async () => {
    const empty = await parseOpenFdaPma(fixture("openfda", "pma_QDQ.json"), "none");
    expect(empty.health).toBe("EMPTY");
    expect(empty.extraction.kept).toHaveLength(0);
    expect((await failure(parseOpenFda510k('{"error":{"code":"SERVER_ERROR","message":"boom"}}', "x"))).failure).toBe("UNAVAILABLE");
    expect((await failure(parseOpenFda510k('{"hello":"world"}', "x"))).failure).toBe("DRIFTED");
    expect((await failure(parseOpenFda510k('{"meta":{"results":{"total":1}},"results":[{"applicant":"x"}]}', "x"))).failure).toBe("DRIFTED");
    expect((await failure(parseOpenFda510k("<html>gateway timeout</html>", "x"))).failure).toBe("INVALID");
    expect((await failure(parseOpenFda510k("", "x"))).failure).toBe("INVALID");
  });
});

describe("ClinicalTrials.gov", () => {
  it("reads the EyeArt study: enrolment, ages, sex, conditions, sites and status", async () => {
    const r = await parseClinicalTrials(fixture("ctgov", "study_NCT03112005.json"), "NCT03112005");
    const s = r.facts.studies[0];
    expect(s).toMatchObject({ nctId: "NCT03112005", status: "COMPLETED", enrollment: { count: 942, type: "ACTUAL" }, sponsor: "Eyenuk, Inc.", siteCount: 1 });
    expect(s?.population).toMatchObject({ ageMin: 18, sex: "ALL", stdAges: ["ADULT", "OLDER_ADULT"] });
    expect(s?.population.ageMax).toBeUndefined();
    expect(s?.conditions).toContain("Diabetic Retinopathy");
    expect(vals(r, "study.sample_size")).toEqual([942]);
    expect(usable(r, "study.sample_size")[0]?.detail.qualifiers).toEqual(["actual"]);
    expect(usable(r, "population.age_max")).toHaveLength(0);
    expect(r.extraction.counts.quote.failed).toBe(0);
  });

  it("splits eligibility into inclusion and exclusion items, each quoted from the text", async () => {
    const r = await parseClinicalTrials(fixture("ctgov", "study_NCT03112005.json"), "NCT03112005");
    expect(r.facts.studies[0]?.inclusion).toEqual(["A diagnosis of diabetes mellitus;", "Understanding of study and provision of written informed consent; and", "18 years of age or older."]);
    expect(r.facts.studies[0]?.exclusion).toHaveLength(7);
    expect(r.facts.studies[0]?.exclusion[0]).toBe("Persistent visual impairment in one or both eyes;");
    const ex = usable(r, "population.exclusion_criterion")[0];
    expect(ex?.anchor.jsonPath).toBe("$.protocolSection.eligibilityModule.eligibilityCriteria");
    expect(ex?.anchor.text).toBe("Persistent visual impairment in one or both eyes;");
  });

  it("reads a two-sided age range and the sex restriction of the MASAI trial", async () => {
    const r = await parseClinicalTrials(fixture("ctgov", "study_NCT04838756.json"), "NCT04838756");
    expect(r.facts.studies[0]?.population).toMatchObject({ ageMin: 40, ageMax: 74, sex: "FEMALE" });
    expect(r.facts.studies[0]?.references.map((x) => x.pmid)).toContain("37541274");
    expect(vals(r, "document.cites_pmid")).toContain("37541274");
  });

  it("finds a K or DEN number written in the intervention text", async () => {
    const r = await parseClinicalTrials(fixture("ctgov", "study_NCT04608617.json"), "NCT04608617");
    expect(r.facts.studies[0]?.submissionsMentioned).toContain("DEN170073");
    expect(vals(r, "document.cites_submission")).toContain("DEN170073");
  });

  it("flags a study with results rather than reading what it does not parse", async () => {
    const r = await parseClinicalTrials(fixture("ctgov", "study_NCT02963441.json"), "NCT02963441");
    expect(r.facts.studies[0]?.hasResults).toBe(true);
    expect(r.warnings.join(" ")).toContain("results section");
  });

  it("separates an empty search from a truncated one", async () => {
    const empty = await parseClinicalTrials(fixture("ctgov", "search_caption_intr.json"), "empty");
    expect(empty.health).toBe("EMPTY");
    const big = await parseClinicalTrials(fixture("ctgov", "search_contact_stroke.json"), "big");
    expect(big.health).toBe("OK");
    expect(big.truncated?.total).toBeGreaterThan(big.truncated?.returned ?? 0);
  });

  it("leaves a minimum age of N/A open and flags an unreadable one", async () => {
    const study = JSON.parse(fixture("ctgov", "study_NCT03112005.json"));
    study.protocolSection.eligibilityModule.minimumAge = "N/A";
    const open = await parseClinicalTrials(study, "open");
    expect(open.facts.studies[0]?.population.ageMin).toBeUndefined();
    expect(open.warnings).toEqual([]);
    study.protocolSection.eligibilityModule.minimumAge = "adults";
    const odd = await parseClinicalTrials(study, "odd");
    expect(odd.facts.studies[0]?.population.ageMin).toBeUndefined();
    expect(odd.warnings.join(" ")).toContain("not understood");
  });

  it("fails typed on junk", async () => {
    expect((await failure(parseClinicalTrials("not json", "x"))).failure).toBe("INVALID");
    expect((await failure(parseClinicalTrials('{"foo":1}', "x"))).failure).toBe("DRIFTED");
    expect((await failure(parseClinicalTrials('{"studies":[{"protocolSection":{"identificationModule":{"nctId":"BAD"}}}],"totalCount":1}', "x"))).failure).toBe("DRIFTED");
    expect((await failure(parseClinicalTrials('{"studies":[]}', "x"))).failure).toBe("DRIFTED");
  });

  it("splits unbulleted criteria by line and ignores criteria with no headings", () => {
    const c = parseCriteria("Inclusion Criteria:\n\nWomen eligible for population-based mammography screening.\n\nExclusion Criteria:\n\nNone.");
    expect(c.inclusion.map((x) => x.text)).toEqual(["Women eligible for population-based mammography screening."]);
    expect(c.exclusion.map((x) => x.text)).toEqual(["None."]);
    expect(parseCriteria("Any adult").inclusion).toEqual([]);
  });

  it("joins a bullet that continues on the next line", () => {
    const text = "Inclusion Criteria:\n\n* First item that runs\n  over a second line;\n* Second item.\n\nExclusion Criteria:\n\n* Third.";
    const c = parseCriteria(text);
    expect(c.inclusion).toHaveLength(2);
    expect(c.inclusion[0]?.text).toBe("First item that runs\n  over a second line;");
    expect(text.slice(c.inclusion[0]?.start, c.inclusion[0]?.end)).toBe(c.inclusion[0]?.text);
  });
});

describe("PubMed XML", () => {
  it("reads the EyeArt pivotal paper: identifiers, trial id, version, sample, figures, erratum", async () => {
    const r = await parsePubMedXml(fixture("pubmed", "ef_eyeart.xml"), "ef_eyeart");
    const a = r.facts.articles.find((x) => x.pmid === "34779843");
    expect(a).toMatchObject({ doi: "10.1001/jamanetworkopen.2021.34254", pmcid: "PMC8593763", year: 2021, date: "2021-11-01", corrected: true, retracted: false });
    expect(a?.nctIds).toEqual(["NCT03112005"]);
    expect(a?.abstractSections.map((s) => s.label)).toContain("RESULTS");
    const mine = (p: string) => r.extraction.kept.filter((k) => k.assertion.subjectId === "publication:pmid:34779843" && k.assertion.predicate === p && isUsable(k));
    expect(mine("device.version").map((k) => k.assertion.value)).toContain("2.1.0");
    expect(mine("study.sample_size").map((k) => k.assertion.value)).toEqual(expect.arrayContaining([942, 893]));
    expect(mine("population.age_min").map((k) => k.assertion.value)).toContain(18);
    expect(mine("result.sensitivity").map((k) => k.assertion.value)).toEqual(expect.arrayContaining([0.955, 0.951]));
    expect(mine("publication.correction").map((k) => k.assertion.value)).toEqual(["ErratumIn"]);
    expect(mine("publication.title")[0]?.anchor.jsonPath).toContain("Article.ArticleTitle");
  });

  it("keeps figures from different papers in one response under their own PMID", async () => {
    const r = await parsePubMedXml(fixture("pubmed", "ef_eyeart.xml"), "ef_eyeart");
    expect(new Set(r.facts.articles.map((x) => x.pmid)).size).toBe(r.facts.articles.length);
    const subjects = new Set(r.extraction.kept.map((k) => k.assertion.subjectId));
    expect(subjects.size).toBe(r.facts.articles.length);
  });

  it("reads a book entry (StatPearls, the 'Contact Dermatitis' collision) as a book, not a trial paper", async () => {
    const r = await parsePubMedXml(fixture("pubmed", "ef_viz.xml"), "ef_viz");
    const book = r.facts.articles.find((x) => x.kind === "book");
    expect(book?.title).toBe("Contact Dermatitis");
    expect(book?.publicationTypes).toContain("Study Guide");
  });

  it("decodes entities once and keeps inline markup out of the text", async () => {
    const xml = `<?xml version="1.0"?><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>1</PMID><Article><ArticleTitle>AI &amp; CAD: a &lt;5% error in <i>vivo</i> &#946; cells</ArticleTitle><Abstract><AbstractText Label="RESULTS">Sensitivity was <b>94.2%</b> (95% CI, 89.6%-97.2%).</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    const r = await parsePubMedXml(xml, "t");
    expect(r.facts.articles[0]?.title).toBe("AI & CAD: a <5% error in vivo \u03B2 cells");
    expect(vals(r, "result.sensitivity")).toEqual([0.942]);
  });

  it("marks a retracted paper from either signal", async () => {
    const xml = `<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>7</PMID><CommentsCorrectionsList><CommentsCorrections RefType="RetractionIn"><RefSource>J Foo. 2020</RefSource><PMID Version="1">8</PMID></CommentsCorrections></CommentsCorrectionsList><Article><ArticleTitle>T</ArticleTitle><PublicationTypeList><PublicationType UI="D016441">Retracted Publication</PublicationType></PublicationTypeList></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    const r = await parsePubMedXml(xml, "t");
    expect(r.facts.articles[0]).toMatchObject({ retracted: true, corrected: false });
    expect(vals(r, "publication.correction")).toEqual(["RetractionIn"]);
  });

  it("refuses a DOCTYPE that declares an external entity instead of resolving it", async () => {
    const xml = `<?xml version="1.0"?><!DOCTYPE PubmedArticleSet [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>3</PMID><Article><ArticleTitle>&xxe;</ArticleTitle></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>`;
    expect((await failure(parsePubMedXml(xml, "t"))).failure).toBe("INVALID");
  });

  it("reads the real DOCTYPE line of an efetch response (a DTD reference, no entities) without fetching it", async () => {
    const r = await parsePubMedXml(fixture("pubmed", "ef_caption.xml"), "caption");
    expect(r.health).toBe("OK");
  });

  it("separates an empty set from a wrong document and from text that is not XML", async () => {
    expect((await parsePubMedXml("<PubmedArticleSet></PubmedArticleSet>", "e")).health).toBe("EMPTY");
    expect((await failure(parsePubMedXml("<html><body>hi</body></html>", "x"))).failure).toBe("DRIFTED");
    expect((await failure(parsePubMedXml("<eFetchResult><ERROR>no such id</ERROR></eFetchResult>", "x"))).failure).toBe("UNAVAILABLE");
    expect((await failure(parsePubMedXml("<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>abc</PMID></MedlineCitation></PubmedArticle></PubmedArticleSet>", "x"))).failure).toBe("DRIFTED");
  });

  it("passes check 1 on every fixture file", async () => {
    for (const f of ["ef_anumana", "ef_gigenius", "ef_transpara", "ef_idxdr", "ef_misc2"]) {
      const r = await parsePubMedXml(fixture("pubmed", `${f}.xml`), f);
      expect(r.extraction.counts.quote.failed, f).toBe(0);
      expect(r.extraction.counts.support.fail, f).toBe(0);
    }
  });
});

describe("Europe PMC", () => {
  it("reads hits and stores the query as a search hit, not as a link", async () => {
    const r = await parseEuropePmc(fixture("europepmc", "ep_K232699.json"), "ep");
    expect(r.facts.hitCount).toBe(1);
    expect(r.facts.hits[0]).toMatchObject({ pmid: "42707377", pmcid: "PMC13547825", year: 2026, openAccess: true });
    const hit = usable(r, "publication.search_hit")[0];
    expect(hit?.assertion.value).toBe('"K232699"');
    expect(hit?.detail.qualifiers).toContain("match_location_not_verified");
  });

  it("cleans index markup for display and keeps the record's own characters in the anchor", async () => {
    expect(cleanEpmcTitle("Q&lt;sub&gt;AI/ML-SaMD&lt;/sub&gt;: A Hybrid &amp; Metric")).toBe("QAI/ML-SaMD: A Hybrid & Metric");
    const r = await parseEuropePmc(fixture("europepmc", "ep_DEN180001.json"), "ep");
    const title = usable(r, "publication.title")[0];
    expect(title?.anchor.text).toContain("&lt;sub&gt;");
  });

  it("separates empty, truncated, error and drifted answers", async () => {
    expect((await parseEuropePmc(fixture("europepmc", "ep_K211733.json"), "e")).health).toBe("EMPTY");
    expect((await parseEuropePmc(fixture("europepmc", "ep_viz.json"), "t")).truncated?.total).toBeGreaterThan(10);
    expect((await failure(parseEuropePmc('{"errCode":500,"errMsg":"down"}', "x"))).failure).toBe("UNAVAILABLE");
    expect((await failure(parseEuropePmc('{"hitCount":1}', "x"))).failure).toBe("DRIFTED");
    expect((await failure(parseEuropePmc("nope", "x"))).failure).toBe("INVALID");
  });
});
