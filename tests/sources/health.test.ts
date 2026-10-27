import { describe, expect, it } from "vitest";
import { PortError } from "../../src/ports/index.ts";
import { classifyError, classifyMessage, classifyResponse, toPortError, type SourceFamily } from "../../src/sources/health.ts";
import { recorded } from "./helpers.ts";

/**
 * The table in docs/02-architecture.md section 5, one test per row and state. Bodies come from the recorded
 * cassette wherever the real response exists; a case marked "constructed" has no recording (the probe did not
 * provoke that state) and is written from the documented shape.
 */

const FDA = "https://api.fda.gov/device";
const CT = "https://clinicaltrials.gov/api/v2";
const EUT = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";
const encoder = new TextEncoder();

function row(family: SourceFamily, url: string, expected: string, why: string) {
  return { family, url, expected, why };
}

const RECORDED_ROWS = [
  // openFDA
  row("openfda", `${FDA}/510k.json?search=k_number:K200667`, "OK", "200 with results"),
  row("openfda", `${FDA}/udi.json?search=premarket_submissions.submission_number:"K253265"&limit=100`, "EMPTY", "404 with NOT_FOUND body is an empty result"),
  row("openfda", `${FDA}/510k.json?search=k_number:K000000`, "EMPTY", "404 NOT_FOUND for an unknown K number"),
  row("openfda", `${FDA}/pma.json?search=product_code:QDQ&limit=1`, "EMPTY", "404 NOT_FOUND on the PMA endpoint"),
  row("openfda", `${FDA}/notanendpoint.json?search=k_number:K200667`, "INVALID", "404 with an HTML body is a wrong path, not an empty result"),
  row("openfda", `${FDA}/510k.json?search=device_name:(`, "INVALID", "500 whose details name a parse exception is a malformed query"),
  row("openfda", `${FDA}/510k.json?search=k_number:K253265&limit=abc`, "INVALID", "400 bad limit"),
  // ClinicalTrials.gov
  row("ctgov", `${CT}/studies/NCT03112005`, "OK", "200 study record"),
  row("ctgov", `${CT}/studies?query.term=EyeArt&pageSize=15&countTotal=true&fields=NCTId,BriefTitle,InterventionName,LeadSponsorName,EnrollmentCount,StartDate,OverallStatus`, "OK", "200 with studies"),
  row("ctgov", `${CT}/studies/NCT99999999`, "EMPTY", "404 'NCT number ... not found'"),
  row("ctgov", `${CT}/studies?pageSize=abc`, "INVALID", "400 plain-text message"),
  // PubMed
  row("pubmed-esearch", `${EUT}/esearch.fcgi?db=pubmed&term=EyeArt[tiab]&retmax=20&retmode=json&sort=relevance`, "OK", "200 count > 0"),
  row("pubmed-esearch", `${EUT}/esearch.fcgi?db=pubmed&term="NCT03112005"[si]&retmax=20&retmode=json&sort=relevance`, "EMPTY", "200 count 0"),
  row("pubmed-esearch", `${EUT}/esearch.fcgi?db=pubmed&term=NCT03705650[si]&retmax=20&retmode=json&sort=relevance`, "EMPTY", "count 0 with a phrasesnotfound note is still empty"),
  row("pubmed-efetch", `${EUT}/efetch.fcgi?db=pubmed&id=34779843&retmode=xml`, "OK", "200 with an article"),
  row("pubmed-efetch", `${EUT}/efetch.fcgi?db=pubmed&id=99999999&retmode=xml`, "EMPTY", "200 with an empty PubmedArticleSet"),
  // Europe PMC
  row("europepmc", `${EPMC}/search?query=%22K200667%22&format=json&pageSize=10&resultType=lite`, "OK", "200 hitCount > 0"),
  row("europepmc", `${EPMC}/search?query=%22K211733%22&format=json&pageSize=10&resultType=lite`, "EMPTY", "200 hitCount 0"),
  // Crossref
  row("crossref-work", "https://api.crossref.org/works/10.1001/jamacardio.2021.0185", "OK", "200 work"),
  row("crossref-search", "https://api.crossref.org/works?query.bibliographic=EyeArt%20pivotal%20evaluation%20referrable%20diabetic%20retinopathy&rows=3&select=DOI,title,issued,relation", "OK", "200 items"),
  row("crossref-work", "https://api.crossref.org/works/10.1001/jamanetworkopen.2021.34281", "EMPTY", "404 'Resource not found.'"),
  // FDA documents
  row("fda-pdf", "https://www.accessdata.fda.gov/cdrh_docs/reviews/DEN180001.pdf", "OK", "starts with %PDF"),
  row("fda-pdf", "https://www.accessdata.fda.gov/cdrh_docs/pdfs20/K200667.pdf", "EMPTY", "404 HTML not-found page: no document at the URL, and not a PDF"),
  row("fda-list", "https://www.fda.gov/media/178541/download?attachment", "OK", "200 CSV with the pinned header"),
];

describe("recorded responses classify as the architecture table says", () => {
  it.each(RECORDED_ROWS)("$family $url -> $expected ($why)", ({ family, url, expected }) => {
    const r = recorded(url);
    const c = classifyResponse({ family, status: r.status, headers: r.headers, body: r.body });
    expect(c.health, c.reason).toBe(expected);
  });

  it("recorded EMPTY rows are never retryable and OK rows carry no retry hint", () => {
    for (const { family, url } of RECORDED_ROWS) {
      const r = recorded(url);
      const c = classifyResponse({ family, status: r.status, headers: r.headers, body: r.body });
      expect(c.retryable).toBe(false);
    }
  });
});

const json = (v: unknown) => encoder.encode(JSON.stringify(v));
const text = (v: string) => encoder.encode(v);

describe("states the probe did not provoke (constructed from the documented shape)", () => {
  const cases: Array<[string, SourceFamily, number, Uint8Array, Record<string, string> | undefined, string]> = [
    // openFDA
    ["openFDA 500 with no parse detail is a server fault", "openfda", 500, json({ error: { code: "SERVER_ERROR", message: "Check your request and try again" } }), undefined, "UNAVAILABLE"],
    ["openFDA 502 gateway", "openfda", 502, text("<html>Bad Gateway</html>"), undefined, "UNAVAILABLE"],
    ["openFDA 503", "openfda", 503, text(""), undefined, "UNAVAILABLE"],
    ["openFDA 504", "openfda", 504, text(""), undefined, "UNAVAILABLE"],
    ["openFDA 429 over the rate limit", "openfda", 429, json({ error: { code: "OVER_RATE_LIMIT", message: "slow down" } }), { "retry-after": "30" }, "UNAVAILABLE"],
    ["openFDA 403 invalid key", "openfda", 403, json({ error: { code: "API_KEY_INVALID", message: "bad key" } }), undefined, "FORBIDDEN"],
    ["openFDA 200 without results", "openfda", 200, json({ hello: "world" }), undefined, "DRIFTED"],
    ["openFDA 200 with an HTML page", "openfda", 200, text("<html>maintenance</html>"), undefined, "DRIFTED"],
    ["openFDA 200 with an empty results array", "openfda", 200, json({ meta: { results: { total: 0 } }, results: [] }), undefined, "EMPTY"],
    ["openFDA 404 JSON with another code is not an empty result", "openfda", 404, json({ error: { code: "ROUTE_NOT_FOUND" } }), undefined, "INVALID"],
    // ClinicalTrials.gov
    ["CT.gov 404 with some other body", "ctgov", 404, text("Not Found"), undefined, "INVALID"],
    ["CT.gov 200 empty studies", "ctgov", 200, json({ totalCount: 0, studies: [] }), undefined, "EMPTY"],
    ["CT.gov 200 HTML", "ctgov", 200, text("<html>maintenance</html>"), undefined, "DRIFTED"],
    ["CT.gov 200 other JSON", "ctgov", 200, json({ moved: true }), undefined, "DRIFTED"],
    ["CT.gov 500", "ctgov", 500, text("oops"), undefined, "UNAVAILABLE"],
    ["CT.gov 429", "ctgov", 429, text("slow"), undefined, "UNAVAILABLE"],
    // PubMed
    ["NCBI 429", "pubmed-esearch", 429, json({ error: "API rate limit exceeded", count: "3" }), undefined, "UNAVAILABLE"],
    ["NCBI esearch 200 with an error key", "pubmed-esearch", 200, json({ error: "Invalid db name specified: pubmd" }), undefined, "INVALID"],
    ["NCBI esearch with an unknown field tag", "pubmed-esearch", 200, json({ esearchresult: { count: "0", idlist: [], errorlist: { phrasesnotfound: [], fieldsnotfound: ["tiabb"] } } }), undefined, "INVALID"],
    ["NCBI esearch count not numeric", "pubmed-esearch", 200, json({ esearchresult: { count: "many", idlist: [] } }), undefined, "DRIFTED"],
    ["NCBI efetch ERROR element", "pubmed-efetch", 200, text("<eFetchResult><ERROR>Empty id list - nothing todo</ERROR></eFetchResult>"), undefined, "INVALID"],
    ["NCBI efetch HTML", "pubmed-efetch", 200, text("<html>down</html>"), undefined, "DRIFTED"],
    ["NCBI efetch 502", "pubmed-efetch", 502, text(""), undefined, "UNAVAILABLE"],
    // Europe PMC
    ["Europe PMC error body", "europepmc", 200, json({ version: "6.9", errCode: 400, errMsg: "syntax error" }), undefined, "INVALID"],
    ["Europe PMC 500", "europepmc", 500, text("error"), undefined, "UNAVAILABLE"],
    ["Europe PMC 200 without hitCount", "europepmc", 200, json({ resultList: { result: [] } }), undefined, "DRIFTED"],
    // Crossref
    ["Crossref search with no items", "crossref-search", 200, json({ status: "ok", "message-type": "work-list", message: { items: [] } }), undefined, "EMPTY"],
    ["Crossref 404 with another body", "crossref-work", 404, text("<html>no</html>"), undefined, "INVALID"],
    ["Crossref 200 status failed", "crossref-work", 200, json({ status: "failed", message: {} }), undefined, "DRIFTED"],
    ["Crossref 503", "crossref-work", 503, text(""), undefined, "UNAVAILABLE"],
    // FDA documents
    ["PDF path answered with a 200 HTML page", "fda-pdf", 200, text("<!DOCTYPE html><html><title>Page Not Found</title></html>"), { "content-type": "text/html" }, "DRIFTED"],
    ["PDF request redirected to the abuse page", "fda-pdf", 302, text(""), { location: "https://www.accessdata.fda.gov/apology_objects/abuse-detection-apology.html" }, "BLOCKED"],
    ["PDF request answered 200 with the abuse page", "fda-pdf", 200, text("<html><a href='/apology_objects/abuse-detection-apology.html'>x</a></html>"), { "content-type": "text/html" }, "BLOCKED"],
    ["PDF request redirected somewhere unexpected", "fda-pdf", 302, text(""), { location: "https://www.accessdata.fda.gov/elsewhere" }, "INVALID"],
    ["PDF 206 partial content with %PDF", "fda-pdf", 206, text("%PDF-1.7\n..."), undefined, "OK"],
    ["PDF 500", "fda-pdf", 500, text("x"), undefined, "UNAVAILABLE"],
    ["FDA list redirected to the abuse page", "fda-list", 302, text(""), { location: "https://www.fda.gov/apology_objects/abuse-detection-apology.html" }, "BLOCKED"],
    ["FDA list 301 to the abuse page", "fda-list", 301, text(""), { location: "/apology_objects/abuse-detection-apology.html" }, "BLOCKED"],
    ["FDA list 404 from the bot layer", "fda-list", 404, text("Not Found"), undefined, "BLOCKED"],
    ["FDA list 200 HTML interstitial", "fda-list", 200, text("<html><title>Pardon Our Interruption</title></html>"), { "content-type": "text/html" }, "BLOCKED"],
    ["FDA list CSV with another header", "fda-list", 200, text("Submission,Name\nK1,x\n"), { "content-type": "text/csv" }, "DRIFTED"],
    ["FDA list 503", "fda-list", 503, text(""), undefined, "UNAVAILABLE"],
  ];
  it.each(cases)("%s -> %s", (_name, family, status, body, headers, expected) => {
    expect(classifyResponse({ family, status, headers, body }).health).toBe(expected);
  });

  it("carries Retry-After as milliseconds", () => {
    const c = classifyResponse({ family: "openfda", status: 429, headers: { "retry-after": "30" }, body: text("") });
    expect(c.retryAfterMs).toBe(30_000);
    expect(c.retryable).toBe(true);
  });
});

describe("outcomes that must never be confused", () => {
  it("a wrong-path 404 is not EMPTY, and an NCT 404 on another path text is not EMPTY", () => {
    const html = recorded(`${FDA}/notanendpoint.json?search=k_number:K200667`);
    expect(classifyResponse({ family: "openfda", status: html.status, body: html.body }).health).not.toBe("EMPTY");
  });

  it("every non-OK, non-EMPTY HTTP outcome is turned into a PortError, and OK and EMPTY are not", () => {
    for (const [family, status, body] of [
      ["openfda", 500, json({ error: { code: "SERVER_ERROR" } })],
      ["openfda", 403, json({ error: { code: "X" } })],
      ["openfda", 400, json({ error: {} })],
      ["fda-list", 302, text("")],
      ["ctgov", 200, text("<html>")],
    ] as Array<[SourceFamily, number, Uint8Array]>) {
      const c = classifyResponse({ family, status, headers: { location: "/apology_objects/x" }, body });
      expect(["OK", "EMPTY"]).not.toContain(c.health);
      const err = toPortError(c);
      expect(err).toBeInstanceOf(PortError);
      expect(["UNAVAILABLE", "FORBIDDEN", "DRIFTED", "BLOCKED", "INVALID"]).toContain(err!.failure);
    }
    expect(toPortError({ health: "OK", reason: "x", retryable: false })).toBeUndefined();
    expect(toPortError({ health: "EMPTY", reason: "x", retryable: false })).toBeUndefined();
  });

  it("maps each health to the matching failure class", () => {
    const pairs: Array<[string, string]> = [
      ["UNAVAILABLE", "UNAVAILABLE"],
      ["FORBIDDEN", "FORBIDDEN"],
      ["DRIFTED", "DRIFTED"],
      ["BLOCKED", "BLOCKED"],
      ["INVALID", "INVALID"],
    ];
    for (const [health, failure] of pairs) {
      expect(toPortError({ health: health as never, reason: "r", retryable: false })!.failure).toBe(failure);
    }
  });
});

describe("Zetaris-style failures", () => {
  it.each([
    "Cannot call methods on a stopped SparkContext.",
    "java.lang.IllegalStateException: Cannot call methods on a stopped SparkContext. This stopped SparkContext was created at:",
    "Could not create ResultSet: null",
    "org.apache.thrift.transport.TTransportException",
    "TTransportException: java.net.SocketException: Broken pipe",
    "Could not open client transport with JDBC Uri: jdbc:hive2://localhost:10000: Connection refused",
    "java.net.SocketTimeoutException: Read timed out",
    "java.lang.OutOfMemoryError: Java heap space",
  ])("treats %j as UNAVAILABLE and retryable", (message) => {
    const c = classifyMessage(message);
    expect(c.health).toBe("UNAVAILABLE");
    expect(c.retryable).toBe(true);
    // The same text arrives as HTTP 400 from the REST layer, which must not turn it into an INVALID statement.
    expect(classifyResponse({ family: "zetaris", status: 400, body: text(message) }).health).toBe("UNAVAILABLE");
  });

  it("separates an identity refusal and a malformed statement from an outage", () => {
    expect(classifyMessage("User 'agent' does not have access to USL 'sakaime_usl'").health).toBe("FORBIDDEN");
    expect(classifyMessage("ParseException: mismatched input 'FORM' expecting {<EOF>, ';'}").health).toBe("INVALID");
    expect(classifyMessage("Table or view not found: hospital.requirements").health).toBe("INVALID");
    expect(classifyResponse({ family: "zetaris", status: 403, body: text("") }).health).toBe("FORBIDDEN");
  });

  it("treats an unrecognised failure as UNAVAILABLE, never as OK or EMPTY", () => {
    const c = classifyMessage("something nobody has seen before", 500);
    expect(c.health).toBe("UNAVAILABLE");
    expect(c.reason).toMatch(/unrecognised/);
  });

  it("an HTTP 200 from the engine is OK at this level", () => {
    expect(classifyResponse({ family: "zetaris", status: 200, body: text("{}") }).health).toBe("OK");
  });
});

describe("thrown errors", () => {
  it.each([
    ["ETIMEDOUT", "connect ETIMEDOUT"],
    ["ECONNRESET", "read ECONNRESET"],
    ["ECONNREFUSED", "connect ECONNREFUSED"],
    ["ENOTFOUND", "getaddrinfo ENOTFOUND api.fda.gov"],
    ["EAI_AGAIN", "getaddrinfo EAI_AGAIN"],
  ])("%s is UNAVAILABLE", (code, message) => {
    const err = Object.assign(new Error(message), { code });
    const c = classifyError(err);
    expect(c.health).toBe("UNAVAILABLE");
    expect(c.retryable).toBe(true);
  });

  it("an abort or timeout is UNAVAILABLE", () => {
    expect(classifyError(Object.assign(new Error("aborted"), { name: "AbortError" })).health).toBe("UNAVAILABLE");
    expect(classifyError(Object.assign(new Error("t"), { name: "TimeoutError" })).health).toBe("UNAVAILABLE");
  });

  it("keeps the meaning of a PortError", () => {
    expect(classifyError(new PortError("REFUSED", "host not allowed")).health).toBe("FORBIDDEN");
    expect(classifyError(new PortError("BLOCKED", "x")).health).toBe("BLOCKED");
    expect(classifyError(new PortError("DRIFTED", "x")).health).toBe("DRIFTED");
    expect(classifyError(new PortError("INVALID", "x")).health).toBe("INVALID");
    expect(classifyError(new PortError("UNAVAILABLE", "x", { retryable: false })).retryable).toBe(false);
    expect(classifyError(new PortError("TRUNCATED", "x")).health).toBe("UNAVAILABLE");
  });

  it("uses the federation rules for a thrown Zetaris error and treats the unknown as UNAVAILABLE", () => {
    expect(classifyError(new Error("Cannot call methods on a stopped SparkContext"), "zetaris").health).toBe("UNAVAILABLE");
    expect(classifyError(new Error("who knows")).health).toBe("UNAVAILABLE");
    expect(classifyError("a bare string").health).toBe("UNAVAILABLE");
  });
});
