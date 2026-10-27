import { describe, expect, it } from "vitest";
import { PubmedXmlError, parsePubmedXml } from "../../src/sources/connectors/pubmed-xml.ts";
import { cassette } from "./helpers.ts";

describe("PubMed XML on every recorded efetch response", () => {
  const efetch = cassette()
    .entries()
    .filter((e) => e.request.url.includes("efetch.fcgi") && e.response.status === 200 && e.response.bytes > 300);

  it("covers the recorded batches", () => {
    expect(efetch.length).toBeGreaterThanOrEqual(10);
  });

  it.each(efetch.map((e) => [e.request.url.slice(-60), e] as const))("parses %s: as many articles as the XML holds, each with a PMID and title", (_name, entry) => {
    const xml = new TextDecoder().decode(cassette().find(entry.request.url)!.body);
    const articles = parsePubmedXml(xml);
    // Oracle: count the elements with a plain pattern, independent of the parser.
    expect(articles.length).toBe((xml.match(/<PubmedArticle>/g) ?? []).length);
    for (const a of articles) {
      expect(a.pmid).toMatch(/^\d+$/);
      expect(a.title.length).toBeGreaterThan(0);
      expect(a.title).not.toMatch(/<|>/);
      // No numeric or named character reference may survive into the text that quotes are checked against.
      expect([a.title, ...a.abstract.map((x) => x.text)].join(" ")).not.toMatch(/&#x?[0-9a-f]+;/i);
    }
  });

  it("reads each article's own DOI, not a cited paper's", () => {
    const entry = efetch.find((e) => e.request.url.includes("id=34779843%2C37847478"))!;
    const articles = parsePubmedXml(new TextDecoder().decode(cassette().find(entry.request.url)!.body));
    const pivotal = articles.find((a) => a.pmid === "34779843")!;
    expect(pivotal.doi).toBe("10.1001/jamanetworkopen.2021.34254");
    expect(pivotal.nctIds).toEqual(["NCT03112005"]);
  });
});

describe("PubMed XML edge cases (constructed documents)", () => {
  const wrap = (inner: string) => `<?xml version="1.0"?><PubmedArticleSet>${inner}</PubmedArticleSet>`;
  const article = (body: string, pmid = "1") => `<PubmedArticle><MedlineCitation><PMID Version="1">${pmid}</PMID>${body}</MedlineCitation></PubmedArticle>`;

  it("keeps inline markup in reading order and decodes entities", () => {
    const xml = wrap(
      article(
        `<Article><Journal><Title>J</Title><JournalIssue><PubDate><Year>2024</Year></PubDate></JournalIssue></Journal><ArticleTitle>Sensitivity of <i>E. coli</i> assays &amp; H<sub>2</sub>O detection.</ArticleTitle><Abstract><AbstractText Label="RESULTS" NlmCategory="RESULTS">AUC was 0.95 (95% CI, 0.93&#x2013;0.97) in <b>n</b> = 120 &lt; 200 cases.</AbstractText></Abstract></Article>`,
      ),
    );
    const [a] = parsePubmedXml(xml);
    expect(a!.title).toBe("Sensitivity of E. coli assays & H2O detection.");
    expect(a!.abstract).toEqual([{ label: "RESULTS", nlmCategory: "RESULTS", text: "AUC was 0.95 (95% CI, 0.93–0.97) in n = 120 < 200 cases." }]);
    expect(a!.year).toBe("2024");
  });

  it("finds NCT numbers in the abstract and in DataBank accession lists, once each", () => {
    const xml = wrap(
      article(
        `<Article><ArticleTitle>T</ArticleTitle><Abstract><AbstractText>Registered as NCT01234567 and NCT01234567.</AbstractText></Abstract><DataBankList><DataBank><DataBankName>ClinicalTrials.gov</DataBankName><AccessionNumberList><AccessionNumber>NCT07654321</AccessionNumber></AccessionNumberList></DataBank></DataBankList></Article>`,
      ),
    );
    const [a] = parsePubmedXml(xml);
    expect(a!.nctIds.sort()).toEqual(["NCT01234567", "NCT07654321"]);
    expect(a!.databanks).toEqual([{ name: "ClinicalTrials.gov", accessions: ["NCT07654321"] }]);
  });

  it("marks a retracted paper from either signal, and keeps the correction links", () => {
    const viaType = parsePubmedXml(wrap(article(`<Article><ArticleTitle>T</ArticleTitle><PublicationTypeList><PublicationType UI="D016441">Retracted Publication</PublicationType></PublicationTypeList></Article>`)));
    expect(viaType[0]!.retracted).toBe(true);
    const viaLink = parsePubmedXml(wrap(article(`<Article><ArticleTitle>T</ArticleTitle></Article><CommentsCorrectionsList><CommentsCorrections RefType="RetractionIn"><PMID Version="1">99</PMID></CommentsCorrections><CommentsCorrections RefType="ErratumIn"><PMID Version="1">98</PMID></CommentsCorrections></CommentsCorrectionsList>`)));
    expect(viaLink[0]!.retracted).toBe(true);
    expect(viaLink[0]!.corrections).toEqual([{ refType: "RetractionIn", pmid: "99" }, { refType: "ErratumIn", pmid: "98" }]);
    const plain = parsePubmedXml(wrap(article(`<Article><ArticleTitle>T</ArticleTitle></Article>`)));
    expect(plain[0]!.retracted).toBe(false);
  });

  it("leaves the year out when the journal gives only a free-text date, and an abstract-less record has an empty abstract", () => {
    const [a] = parsePubmedXml(wrap(article(`<Article><Journal><JournalIssue><PubDate><MedlineDate>2019 Dec-2020 Jan</MedlineDate></PubDate></JournalIssue></Journal><ArticleTitle>T</ArticleTitle></Article>`)));
    expect(a!.year).toBeUndefined();
    expect(a!.abstract).toEqual([]);
  });

  it("returns no articles for an empty set", () => {
    expect(parsePubmedXml('<?xml version="1.0" ?><PubmedArticleSet></PubmedArticleSet>')).toEqual([]);
  });

  it("rejects a document that is not a PubmedArticleSet, and an article with no PMID", () => {
    expect(() => parsePubmedXml("<html><body>down</body></html>")).toThrow(PubmedXmlError);
    expect(() => parsePubmedXml("<html><body>down</body></html>")).toThrow(/no PubmedArticleSet/);
    expect(() => parsePubmedXml(wrap(`<PubmedArticle><MedlineCitation></MedlineCitation></PubmedArticle>`))).toThrow(/no PMID/);
  });
});
