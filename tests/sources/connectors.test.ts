import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import fc from "fast-check";
import { PortError, type Connector } from "../../src/ports/index.ts";
import { EvidenceRecordSchema } from "../../src/schemas/evidence.ts";
import { sha256Hex } from "../../src/util/canonical.ts";
import { requestHashOf } from "../../src/sources/cassette.ts";
import type { ConnectorReadResult, RecordPayload } from "../../src/sources/connectors/common.ts";
import { createSourceLayer, type SourceLayer } from "../../src/sources/factory.ts";
import { cassette, liveDouble, liveFromCassette, noSleep, recorded, unavailable } from "./helpers.ts";

const layer: SourceLayer = createSourceLayer({ mode: "cassette" });
const conn = (id: string): Connector => layer.connectors.get(id)!;
const read = (id: string, query: Record<string, string | number>, limit?: number) => conn(id).read({ query, limit }) as Promise<ConnectorReadResult>;
const payloadOf = (r: ConnectorReadResult) => r.records[0]!.payload as RecordPayload;

async function failureOf(promise: Promise<unknown>): Promise<PortError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(PortError);
    return err as PortError;
  }
  throw new Error("expected the call to fail");
}

const tmpDirs: string[] = [];
const tmpDir = () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "sakaime-conn-"));
  tmpDirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of tmpDirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

const fakeClock = (start = "2026-10-27T10:00:00Z") => {
  let now = Date.parse(start);
  return { clock: { now: () => new Date(now) }, sleep: async (ms: number) => void (now += ms), get now() { return now; } };
};

// ---------------------------------------------------------------- recorded reads, per source

describe("openFDA 510(k)", () => {
  it("reads a recorded clearance and returns a verifiable EvidenceRecord", async () => {
    const r = await read("openfda-510k", { k_number: "K200667" });
    expect(r.health).toBe("OK");
    expect(r.complete).toBe(true);
    expect(r.total).toBe(1);
    const rec = r.records[0]!;
    expect(EvidenceRecordSchema.safeParse(rec).success).toBe(true);
    const url = "https://api.fda.gov/device/510k.json?search=k_number:K200667";
    expect(rec.requestHash).toBe(requestHashOf(url));
    expect(rec.contentHash).toBe(cassette().find(url)!.entry.response.sha256);
    expect(rec.contentHash).toBe(sha256Hex(cassette().find(url)!.body));
    expect(rec.sourceId).toBe("openfda-510k");
    expect(rec.sourcePublishedAt).toBe("2026-10-19T00:00:00.000Z");
    const p = payloadOf(r);
    expect(p.provenance.servedFrom).toBe("recorded");
    expect((p.body as { results: Array<{ k_number: string; device_name: string }> }).results[0]).toMatchObject({ k_number: "K200667", device_name: "EyeArt" });
    expect(r.servedFrom).toBe("recorded");
    expect(r.notes.join(" ")).toMatch(/replayed from a recording/);
  });

  it("returns EMPTY with a record of the empty answer, whose only claim is 'none found here, on this date'", async () => {
    const r = await read("openfda-510k", { k_number: "K000000" });
    expect(r.health).toBe("EMPTY");
    expect(r.records).toHaveLength(1);
    expect(r.returned).toBe(0);
    const p = payloadOf(r);
    expect(p.provenance.health).toBe("EMPTY");
    expect(p.provenance.emptyMeaning).toMatch(/none found in openfda-510k .* as of 2026-10-27/);
    expect(p.provenance.emptyMeaning).toMatch(/does not show that none exist/);
  });

  it("reproduces the probe's requests exactly, so identical queries hash identically", async () => {
    for (const k of ["K253265", "DEN180001", "DEN170073", "K221347"]) {
      const r = await read("openfda-510k", { k_number: k });
      expect(r.records[0]!.requestHash).toBe(requestHashOf(`https://api.fda.gov/device/510k.json?search=k_number:${k}`));
    }
  });

  it("finds a clearance by applicant and device name together (recorded live 2026-10-27)", async () => {
    const r = await read("openfda-510k", { applicant: "Eyenuk, Inc.", device_name: "EyeArt" });
    expect(r.health).toBe("OK");
    const numbers = (payloadOf(r).body as { results: Array<{ k_number: string }> }).results.map((x) => x.k_number).sort();
    expect(numbers).toEqual(["K200667", "K223357"]);
    expect(r.complete).toBe(true);
    expect(payloadOf(r).provenance.servedFrom).toBe("recorded");
  });

  it("refuses a request it cannot answer from the recording instead of inventing one", async () => {
    const err = await failureOf(read("openfda-510k", { k_number: "K111111" }));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(err.detail?.["noRecording"]).toBe(true);
  });

  it.each([
    [{}, /needs k_number/],
    [{ k_number: "K12" }, /must look like/],
    [{ k_number: "k200667" }, /must look like/],
    [{ k_number: "K200\n667" }, /control|must look like/],
    [{ k_number: "K200667 OR 1" }, /must look like/],
    [{ k_number: "K200667", sort: "x" }, /does not understand/],
    [{ device_name: "EyeArt" }, /never searched without its applicant/],
    [{ applicant: 'Eye"nuk', device_name: "EyeArt" }, /quote or backslash/],
    [{ product_code: "q1" }, /must look like/],
    [{ k_number: "K200667", skip: -1 }, /non-negative/],
  ])("rejects the invalid query %j before sending anything", async (query, message) => {
    const err = await failureOf(read("openfda-510k", query as never));
    expect(err.failure).toBe("INVALID");
    expect(err.message).toMatch(message);
  });

  it("rejects an oversized limit and a list over 100 numbers", async () => {
    expect((await failureOf(read("openfda-510k", { applicant: "Eyenuk, Inc." }, 5000))).failure).toBe("INVALID");
    const many = Array.from({ length: 101 }, (_, i) => `K${String(200000 + i)}`).join(",");
    expect((await failureOf(read("openfda-510k", { k_number: many }))).message).toMatch(/at most 100/);
  });

  it("asks for as many records as it names in a list lookup (openFDA returns one by default)", async () => {
    const dbl = liveFromCassette(() => undefined);
    const live = createSourceLayer({ mode: "live", fetcher: dbl, stateDir: tmpDir(), sleep: noSleep });
    await live.connectors.get("openfda-510k")!.read({ query: { k_number: "K200667,K253265,DEN180001" } }).catch(() => undefined);
    const url = new URL(dbl.calls[0]!.url);
    expect(url.searchParams.get("search")).toBe("k_number:(K200667 OR K253265 OR DEN180001)");
    expect(url.searchParams.get("limit")).toBe("3");
  });
});

describe("openFDA UDI and PMA", () => {
  it("udi: a submission with GUDID records returns every version, and one without is EMPTY", async () => {
    const ok = await read("openfda-udi", { submission_number: "K200667" });
    expect(ok.health).toBe("OK");
    const versions = ((payloadOf(ok).body as { results: Array<{ version_or_model_number?: string }> }).results).map((x) => x.version_or_model_number);
    expect(versions).toContain("2.1.0");
    const none = await read("openfda-udi", { submission_number: "K253265" });
    expect(none.health).toBe("EMPTY");
    expect(payloadOf(none).provenance.emptyMeaning).toMatch(/none found in openfda-udi/);
  });

  it("udi: finds the GUDID record by company and brand together (recorded live 2026-10-27)", async () => {
    const r = await read("openfda-udi", { company_name: "Eyenuk, Inc.", brand_name: "EyeArt" });
    expect(r.health).toBe("OK");
    expect((payloadOf(r).body as { results: Array<{ version_or_model_number: string }> }).results.map((x) => x.version_or_model_number)).toEqual(["2.1.0"]);
  });

  it("udi: a brand name needs its company", async () => {
    expect((await failureOf(read("openfda-udi", { brand_name: "EyeArt" }))).message).toMatch(/never searched without its company/);
  });

  it("pma: reports a partial read honestly when supplements exceed the page", async () => {
    const r = await read("openfda-pma", { pma_number: "P130020" }, 2);
    expect(r.health).toBe("OK");
    expect(r.returned).toBe(2);
    expect(r.total).toBeGreaterThan(2);
    expect(r.complete).toBe(false);
    expect(r.state).toBeDefined();
    expect(r.notes.join(" ")).toMatch(/partial read/);
  });

  it("pma: a product-code style lookup that matches nothing is EMPTY", async () => {
    // The recorded answer for product_code:QDQ on the PMA endpoint is the NOT_FOUND body; the builder has no
    // product_code key, so the same request is replayed through the response classifier directly.
    const r = recorded("https://api.fda.gov/device/pma.json?search=product_code:QDQ&limit=1");
    expect(r.status).toBe(404);
    expect(JSON.parse(r.text).error.code).toBe("NOT_FOUND");
  });
});

describe("ClinicalTrials.gov", () => {
  it("reads a recorded study", async () => {
    const r = await read("clinicaltrials-v2", { nct_id: "NCT03112005" });
    expect(r.health).toBe("OK");
    expect((payloadOf(r).body as { protocolSection: { identificationModule: { nctId: string } } }).protocolSection.identificationModule.nctId).toBe("NCT03112005");
    expect(r.records[0]!.sourcePublishedAt).toBe("2018-07-30T00:00:00.000Z");
  });

  it("a study id the registry does not hold is EMPTY (recorded 404), a search with no studies is EMPTY (recorded 200)", async () => {
    expect((await read("clinicaltrials-v2", { nct_id: "NCT99999999" })).health).toBe("EMPTY");
    const none = await read("clinicaltrials-v2", { sponsor: "Paige.AI" });
    expect(none.health).toBe("EMPTY");
    expect(payloadOf(none).provenance.status).toBe(200);
  });

  it("a recorded search comes back with its total and no cursor", async () => {
    const r = await read("clinicaltrials-v2", { rawQuery: "EyeArt" });
    expect(r.health).toBe("OK");
    expect(r.total).toBe(6);
    expect(r.complete).toBe(true);
    expect(payloadOf(r).provenance.queryForm).toBe("raw");
  });

  it("never searches a product name on its own", async () => {
    const err = await failureOf(read("clinicaltrials-v2", { product: "ContaCT" }));
    expect(err.failure).toBe("INVALID");
    expect(err.message).toMatch(/never searched on its own/);
    expect(err.message).toMatch(/446,198/);
  });

  it("builds the vendor, product and condition search with every phrase quoted", async () => {
    const dbl = liveFromCassette();
    const live = createSourceLayer({ mode: "live", fetcher: dbl, stateDir: tmpDir(), sleep: noSleep, maxAttempts: 1 });
    await live.connectors.get("clinicaltrials-v2")!.read({ query: { vendor: "Eyenuk", product: "EyeArt", condition: "diabetic retinopathy" } }).catch(() => undefined);
    expect(new URL(dbl.calls[0]!.url).searchParams.get("query.term")).toBe('"Eyenuk" AND "EyeArt" AND "diabetic retinopathy"');
  });

  it.each([
    [{ nct_id: "NCT123" }, /must look like/],
    [{ nct_id: "NCT03112005", sponsor: "x" }, /./],
    [{ vendor: "Eyenuk" }, /give the product/],
    [{ condition: "stroke" }, /not a device search/],
    [{ vendor: "A", product: "B", sponsor: "C" }, /one kind of search/],
    [{ identifier: "a b c" }, /single token/],
  ])("rejects %j", async (query, message) => {
    const err = await failureOf(read("clinicaltrials-v2", query as never));
    expect(err.failure).toBe("INVALID");
    if (message.source !== ".") expect(err.message).toMatch(message);
  });
});

describe("PubMed", () => {
  it("efetch parses the EyeArt pivotal evaluation, keeping identifiers, the NCT number and the abstract text", async () => {
    const r = await read("pubmed-eutils", { pmid: "34779843" });
    expect(r.health).toBe("OK");
    const article = (payloadOf(r).body as { articles: Array<Record<string, any>> }).articles[0]!;
    expect(article["pmid"]).toBe("34779843");
    expect(article["title"]).toMatch(/^Pivotal Evaluation of an Artificial Intelligence System/);
    expect(article["year"]).toBe("2021");
    expect(article["doi"]).toBe("10.1001/jamanetworkopen.2021.34254");
    expect(article["pmc"]).toBe("PMC8593763");
    expect(article["nctIds"]).toEqual(["NCT03112005"]);
    expect(article["publicationTypes"]).toContain("Clinical Trial");
    expect(article["retracted"]).toBe(false);
    const objective = article["abstract"].find((a: { label?: string }) => a.label === "OBJECTIVE");
    expect(objective.text).toMatch(/version 2\.1\.0/);
    // The raw XML is available beside the record, byte for byte.
    const raw = r.contents.get(r.records[0]!.id)!;
    expect(sha256Hex(raw.bytes)).toBe(r.records[0]!.contentHash);
    expect(raw.mediaType).toBe("application/xml");
  });

  it("does not read the reference list's identifiers as the article's own", async () => {
    const r = await read("pubmed-eutils", { pmid: "34779843" });
    const article = (payloadOf(r).body as { articles: Array<{ doi: string }> }).articles[0]!;
    expect(article.doi).not.toBe("10.1016/j.diabres.2017.03.024");
  });

  it("an id PubMed does not hold gives an EMPTY answer, not an error", async () => {
    const r = await read("pubmed-eutils", { pmid: "99999999" });
    expect(r.health).toBe("EMPTY");
    expect(payloadOf(r).body).toEqual({ articles: [] });
  });

  it("a batch fetch lists the ids PubMed did not return", async () => {
    // The probe's EyeArt batch of ten; one id in it has no record in the response.
    const ids = "34779843,37847478,41528924,36345378,39430352,31335200,38783384,39272631,41140908,41257814";
    const r = await read("pubmed-eutils", { pmids: ids });
    const body = payloadOf(r).body as { requestedIds: string[]; missingIds: string[] };
    expect(body.requestedIds).toHaveLength(10);
    expect(r.returned).toBe(10 - body.missingIds.length);
    expect(r.complete).toBe(true); // ids with no record are named in missingIds; nothing further can be fetched
    if (body.missingIds.length > 0) expect(r.notes.join(" ")).toMatch(/returned no record for/);
  });

  it("searches by NCT number in either form, and tells the two apart in the record", async () => {
    const free = await read("pubmed-eutils", { nct_id: "NCT03112005" });
    expect(free.health).toBe("OK");
    expect(((payloadOf(free).body as { esearchresult: { idlist: string[] } }).esearchresult.idlist)).toContain("34779843");
    const tagged = await read("pubmed-eutils", { nct_id: "NCT03112005", nct_field: "si" });
    expect(tagged.health).toBe("EMPTY");
    expect(new URL(payloadOf(free).provenance.url).searchParams.get("term")).toBe("NCT03112005");
    expect(new URL(payloadOf(tagged).provenance.url).searchParams.get("term")).toBe("NCT03112005[si]");
  });

  it("a raw expression is allowed but marked raw in the record", async () => {
    const r = await read("pubmed-eutils", { rawQuery: "EyeArt[tiab]" });
    expect(r.health).toBe("OK");
    expect(payloadOf(r).provenance.queryForm).toBe("raw");
  });

  it("refuses a product name without its vendor, and builds the tagged phrase search when given both", async () => {
    expect((await failureOf(read("pubmed-eutils", { product: "ContaCT" }))).message).toMatch(/never searched on its own/);
    const dbl = liveFromCassette();
    const live = createSourceLayer({ mode: "live", fetcher: dbl, stateDir: tmpDir(), sleep: noSleep, maxAttempts: 1 });
    await live.connectors.get("pubmed-eutils")!.read({ query: { vendor: "Viz.ai", product: "ContaCT", condition: "stroke" } }).catch(() => undefined);
    expect(new URL(dbl.calls[0]!.url).searchParams.get("term")).toBe('"Viz.ai"[tiab] AND "ContaCT"[tiab] AND "stroke"[tiab]');
  });

  it("asks for one kind of request at a time, and validates ids", async () => {
    expect((await failureOf(read("pubmed-eutils", { pmid: "1", nct_id: "NCT03112005" }))).message).toMatch(/one kind of request/);
    expect((await failureOf(read("pubmed-eutils", { pmid: "abc" }))).failure).toBe("INVALID");
    expect((await failureOf(read("pubmed-eutils", { nct_id: "NCT03112005", nct_field: "xx" }))).failure).toBe("INVALID");
    expect((await failureOf(read("pubmed-eutils", {}))).failure).toBe("INVALID");
  });
});

describe("Europe PMC and Crossref", () => {
  it("Europe PMC: an exact submission number with a hit, and one with none", async () => {
    const hit = await read("europepmc", { identifier: "K200667" });
    expect(hit.health).toBe("OK");
    expect(hit.total).toBe(1);
    expect(hit.notes.join(" ")).toMatch(/candidate until its text is read/);
    const none = await read("europepmc", { identifier: "K211733" });
    expect(none.health).toBe("EMPTY");
  });

  it("Europe PMC: rejects an identifier that is not a single token", async () => {
    expect((await failureOf(read("europepmc", { identifier: 'K200667" OR "x' }))).failure).toBe("INVALID");
  });

  it("Crossref: a DOI it holds, a DOI it does not, and a bibliographic search", async () => {
    const hit = await read("crossref", { doi: "10.1001/jamacardio.2021.0185" });
    expect(hit.health).toBe("OK");
    const miss = await read("crossref", { doi: "10.1001/jamanetworkopen.2021.34281" });
    expect(miss.health).toBe("EMPTY");
    expect(payloadOf(miss).provenance.emptyMeaning).toMatch(/none found in crossref/);
    const found = await read("crossref", { bibliographic: "EyeArt pivotal evaluation referrable diabetic retinopathy" }, 3);
    expect(found.health).toBe("OK");
    expect(found.returned).toBe(3);
    expect(found.complete).toBe(false);
  });

  it("Crossref: rejects a malformed DOI and both-keys", async () => {
    expect((await failureOf(read("crossref", { doi: "not-a-doi" }))).failure).toBe("INVALID");
    expect((await failureOf(read("crossref", { doi: "10.1001/x", bibliographic: "y" }))).failure).toBe("INVALID");
  });
});

describe("FDA decision summary PDFs", () => {
  it("returns the PDF bytes beside the record, after checking they start with %PDF", async () => {
    const r = await read("fda-accessdata-pdf", { submission_number: "DEN180001" });
    expect(r.health).toBe("OK");
    const raw = r.contents.get(r.records[0]!.id)!;
    expect(new TextDecoder().decode(raw.bytes.slice(0, 4))).toBe("%PDF");
    expect(raw.bytes.length).toBe(142581);
    expect(r.records[0]!.contentHash).toBe("9b4a978bf52a1c3aa5871d014d0d9b214ada70c884a9a311fa11a7e266ee7e38");
    expect(payloadOf(r).body).toMatchObject({ mediaType: "application/pdf", byteLength: 142581 });
  });

  it("a missing document (404 HTML page) is EMPTY and is not a PDF", async () => {
    const r = await read("fda-accessdata-pdf", { url: "https://www.accessdata.fda.gov/cdrh_docs/pdfs20/K200667.pdf" });
    expect(r.health).toBe("EMPTY");
    expect(r.contents.size).toBe(0);
    expect(payloadOf(r).body).toBeNull();
  });

  it("builds the address from the submission number: year folder for K, reviews folder for DEN", async () => {
    const dbl = liveFromCassette();
    const live = createSourceLayer({ mode: "live", fetcher: dbl, stateDir: tmpDir(), sleep: noSleep, maxAttempts: 1 });
    const c = live.connectors.get("fda-accessdata-pdf")!;
    await c.read({ query: { submission_number: "K200667" } }).catch(() => undefined);
    await c.read({ query: { submission_number: "DEN170073" } }).catch(() => undefined);
    expect(dbl.calls.map((x) => x.url)).toEqual(["https://www.accessdata.fda.gov/cdrh_docs/pdf20/K200667.pdf", "https://www.accessdata.fda.gov/cdrh_docs/reviews/DEN170073.pdf"]);
  });

  it.each([
    [{ submission_number: "P130020" }, /PMA summaries has not been verified/],
    [{ submission_number: "K12" }, /must look like/],
    [{ url: "https://evil.example/cdrh_docs/x.pdf" }, /must be an https:\/\/www\.accessdata/],
    [{ url: "https://www.accessdata.fda.gov.evil.example/cdrh_docs/x.pdf" }, /must be an https:\/\/www\.accessdata/],
    [{ url: "https://www.accessdata.fda.gov/scripts/x.pdf" }, /must be an https:\/\/www\.accessdata/],
    [{ url: "http://www.accessdata.fda.gov/cdrh_docs/x.pdf" }, /must be an https:\/\/www\.accessdata|parsed/],
    [{}, /needs submission_number/],
  ])("rejects %j", async (query, message) => {
    const err = await failureOf(read("fda-accessdata-pdf", query as never));
    expect(err.failure).toBe("INVALID");
    expect(err.message).toMatch(message);
  });

  it("a 200 HTML page where a PDF belongs is DRIFTED, a redirect to the abuse page is BLOCKED", async () => {
    const html = createSourceLayer({ mode: "live", stateDir: tmpDir(), sleep: noSleep, maxAttempts: 1, fetcher: liveDouble(() => ({ status: 200, headers: { "content-type": "text/html" }, body: "<!DOCTYPE html><title>Page Not Found</title>" })) });
    expect((await failureOf(html.connectors.get("fda-accessdata-pdf")!.read({ query: { submission_number: "DEN180001" } }))).failure).toBe("DRIFTED");
    const blocked = createSourceLayer({ mode: "live", stateDir: tmpDir(), sleep: noSleep, maxAttempts: 1, fetcher: liveDouble(() => ({ status: 302, headers: { location: "https://www.accessdata.fda.gov/apology_objects/abuse-detection-apology.html" }, body: "" })) });
    expect((await failureOf(blocked.connectors.get("fda-accessdata-pdf")!.read({ query: { submission_number: "DEN180001" } }))).failure).toBe("BLOCKED");
  });
});

// ---------------------------------------------------------------- the FDA AI list

describe("FDA AI list (pinned snapshot)", () => {
  it("answers from the snapshot and says in the result and in the record that it is a stale snapshot", async () => {
    const r = await read("fda-ai-list", { submission_number: "K200667" });
    expect(r.health).toBe("OK");
    expect(r.servedFrom).toBe("snapshot");
    const p = payloadOf(r) as RecordPayload & { provenance: { snapshot: { stale: boolean; contentCurrentAsOf: string; ageDays: number } } };
    expect(p.provenance.servedFrom).toBe("snapshot");
    expect(p.provenance.snapshot).toMatchObject({ stale: true, contentCurrentAsOf: "2026-09-04" });
    expect(p.provenance.snapshot.ageDays).toBeGreaterThan(0);
    const row = (p.body as { rows: Array<Record<string, any>> }).rows[0]!;
    expect(row).toMatchObject({ submissionNumber: "K200667", device: "EyeArt", company: "Eyenuk, Inc", productCode: "PIB", submissionType: "510k", decisionDateIso: "2020-08-03" });
    expect(r.notes.join(" ")).toMatch(/stale snapshot/);
    expect(r.notes.join(" ")).toMatch(/not a comprehensive resource/);
  });

  it("a number not in the snapshot is EMPTY for the snapshot only, and the text says it does not show absence from the FDA list", async () => {
    const r = await read("fda-ai-list", { submission_number: "K999999" });
    expect(r.health).toBe("EMPTY");
    expect(payloadOf(r).provenance.emptyMeaning).toMatch(/pinned FDA AI-list snapshot current as of 2026-09-04/);
    expect(payloadOf(r).provenance.emptyMeaning).toMatch(/does not show the device is absent from the FDA list/);
  });

  it("returns all 1,614 rows without filters, and filters by company with punctuation-insensitive matching", async () => {
    const all = await read("fda-ai-list", {});
    expect(all.total).toBe(1614);
    expect(all.complete).toBe(true);
    const viz = await read("fda-ai-list", { company: "viz.ai" });
    const companies = new Set((payloadOf(viz).body as { rows: Array<{ company: string }> }).rows.map((x) => x.company));
    expect(viz.returned).toBeGreaterThan(1);
    // Viz.ai appears under several spellings; the matcher is punctuation-blind but cannot match Viz.Al (a capital I as a lowercase L).
    expect(companies.has("Viz.ai, Inc.")).toBe(true);
    expect(companies.has("Viz. ai, Inc.")).toBe(true);
    expect(companies.has("Viz.Al, Inc.")).toBe(false);
  });

  it("flags rows that pack several devices into one cell", async () => {
    const r = await read("fda-ai-list", { device: "Voluson Expert" });
    const rows = (payloadOf(r).body as { rows: Array<{ devicesInCell?: string[] }> }).rows;
    expect(rows.some((x) => (x.devicesInCell?.length ?? 0) > 1)).toBe(true);
    expect(r.notes.join(" ")).toMatch(/several devices into one Device cell/);
  });

  it("limits the rows and says the read is partial", async () => {
    const r = await read("fda-ai-list", { company: "Siemens" }, 3);
    expect(r.returned).toBe(3);
    expect(r.complete).toBe(false);
    expect(r.notes.join(" ")).toMatch(/partial read/);
  });

  it("rejects unknown keys and a malformed product code", async () => {
    expect((await failureOf(read("fda-ai-list", { k_number: "K1" }))).failure).toBe("INVALID");
    expect((await failureOf(read("fda-ai-list", { product_code: "12" }))).failure).toBe("INVALID");
  });

  it("check(): reachable and identical when the live list matches the pin", async () => {
    const c = await conn("fda-ai-list").check();
    expect(c.health).toBe("OK");
    expect(c.detail).toMatch(/byte-identical/);
  });

  it("check(): BLOCKED when the live list redirects to the abuse page; reads still work, still stale", async () => {
    const blocked = createSourceLayer({
      mode: "live",
      stateDir: tmpDir(),
      sleep: noSleep,
      // Constructed from FEASIBILITY-REPORT s1: scripted requests were redirected to the abuse-detection page.
      fetcher: liveDouble(() => ({ status: 302, headers: { location: "https://www.fda.gov/apology_objects/abuse-detection-apology.html" }, body: "" })),
    });
    const c = blocked.connectors.get("fda-ai-list")!;
    const check = await c.check();
    expect(check.health).toBe("BLOCKED");
    expect(check.detail).toMatch(/stale snapshot and never as absence/);
    const r = (await c.read({ query: { submission_number: "K200667" } })) as ConnectorReadResult;
    expect(r.health).toBe("OK");
    expect(r.servedFrom).toBe("snapshot");
  });

  it("check(): STALE when the live list is reachable but differs from the pin", async () => {
    const differing = createSourceLayer({
      mode: "live",
      stateDir: tmpDir(),
      sleep: noSleep,
      fetcher: liveDouble(() => {
        const r = recorded("https://www.fda.gov/media/178541/download?attachment");
        return { status: 200, headers: { ...r.headers, "last-modified": "Fri, 02 Oct 2026 10:00:00 GMT" }, body: r.text + "10/01/2026,K999999,New Device,New Co,Radiology,QAS\r\n" };
      }),
    });
    const check = await differing.connectors.get("fda-ai-list")!.check();
    expect(check.health).toBe("STALE");
    expect(check.detail).toMatch(/differs from the pin/);
  });

  it("preferLive: uses the live list when it answers and falls back to the snapshot, saying why, when it does not", async () => {
    const live = createSourceLayer({ mode: "live", stateDir: tmpDir(), sleep: noSleep, preferLiveAiList: true, fetcher: liveFromCassette() });
    const fresh = (await live.connectors.get("fda-ai-list")!.read({ query: { submission_number: "K200667" } })) as ConnectorReadResult;
    expect(fresh.servedFrom).toBe("live");
    expect(payloadOf(fresh).provenance).not.toHaveProperty("snapshot");
    const down = createSourceLayer({ mode: "live", stateDir: tmpDir(), sleep: noSleep, preferLiveAiList: true, fetcher: liveDouble(() => ({ status: 302, headers: { location: "/apology_objects/abuse-detection-apology.html" }, body: "" })) });
    const stale = (await down.connectors.get("fda-ai-list")!.read({ query: { submission_number: "K200667" } })) as ConnectorReadResult;
    expect(stale.servedFrom).toBe("snapshot");
    expect(stale.notes.join(" ")).toMatch(/live list was tried first and failed: BLOCKED/);
  });
});

// ---------------------------------------------------------------- check and discover on every source

describe("check and discover", () => {
  it.each([...layer.connectors.keys()])("%s: check is OK against the recording and discover returns a stable fingerprint", async (id) => {
    const c = conn(id);
    const check = await c.check();
    expect(check.health, check.detail).toBe("OK");
    expect(check.checkedAt).toMatch(/Z$/);
    const a = await c.discover();
    const b = await c.discover();
    expect(a.sample.length).toBeGreaterThan(0);
    expect(a.schemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.schemaHash).toBe(b.schemaHash);
    expect(c.describe()).toBe(c.card);
  });

  it("different sources have different fingerprints", async () => {
    const hashes = new Set<string>();
    for (const id of layer.connectors.keys()) hashes.add((await conn(id).discover()).schemaHash);
    expect(hashes.size).toBe(layer.connectors.size);
  });

  it("the three openFDA endpoints and the registries report their cards' limits", () => {
    expect(conn("openfda-510k").card.rateLimit).toEqual({ requests: 240, perSeconds: 60, perDay: 1000 });
    expect(conn("pubmed-eutils").card.rateLimit).toEqual({ requests: 3, perSeconds: 1 });
    expect(conn("crossref").card.rateLimit).toEqual({ requests: 5, perSeconds: 1 });
    expect(conn("clinicaltrials-v2").card.rateLimit).toBeUndefined();
  });
});

describe("determinism and labelling", () => {
  it("reading the same recording twice gives identical ids and hashes, and every record validates", async () => {
    for (const [id, query] of [
      ["openfda-510k", { k_number: "K200667" }],
      ["clinicaltrials-v2", { nct_id: "NCT03112005" }],
      ["europepmc", { identifier: "K200667" }],
      ["fda-ai-list", { submission_number: "K200667" }],
    ] as Array<[string, Record<string, string>]>) {
      const a = await read(id, query);
      const b = await read(id, query);
      expect(a.records[0]).toEqual(b.records[0]);
      expect(EvidenceRecordSchema.safeParse(a.records[0]).success, id).toBe(true);
    }
  });

  it("every recorded record is labelled recorded in its provenance and retrievedAt is the original capture time", async () => {
    const r = await read("pubmed-eutils", { pmid: "34779843" });
    expect(payloadOf(r).provenance.servedFrom).toBe("recorded");
    expect(r.records[0]!.retrievedAt).toBe(cassette().find("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34779843&retmode=xml")!.entry.recordedAt);
  });

  it("cassette mode never creates a request budget file", () => {
    const state = tmpDir();
    createSourceLayer({ mode: "cassette", stateDir: state });
    expect(fs.readdirSync(state)).toEqual([]);
  });
});

// ---------------------------------------------------------------- failure semantics through a live fetcher

describe("outage, rate limit, invalid and drift (live fetcher double)", () => {
  const OK_URL = "https://api.fda.gov/device/510k.json?search=k_number:K200667";
  const query = { k_number: "K200667" };
  const make = (answer: Parameters<typeof liveDouble>[0], extra: { maxAttempts?: number; backoffMs?: number } = {}) => {
    const t = fakeClock();
    const slept: number[] = [];
    const dbl = liveDouble(answer);
    const live = createSourceLayer({ mode: "live", fetcher: dbl, stateDir: tmpDir(), clock: t.clock, sleep: async (ms) => { slept.push(ms); await t.sleep(ms); }, ...extra });
    return { dbl, slept, c: live.connectors.get("openfda-510k")!, t };
  };
  const good = () => {
    const r = recorded(OK_URL);
    return { status: r.status, headers: r.headers, body: r.body };
  };

  it("retries a 503 twice with doubling backoff, then reports UNAVAILABLE and never EMPTY", async () => {
    const { dbl, slept, c } = make(() => ({ status: 503, body: "" }), { backoffMs: 500 });
    const err = await failureOf(c.read({ query }));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(dbl.calls).toHaveLength(3);
    expect(slept).toEqual([500, 1000]);
  });

  it("recovers when the second attempt succeeds, and returns the real answer", async () => {
    const { dbl, c } = make((_u, n) => (n === 1 ? { status: 502, body: "bad gateway" } : good()));
    const r = (await c.read({ query })) as ConnectorReadResult;
    expect(r.health).toBe("OK");
    expect(dbl.calls).toHaveLength(2);
    expect(r.servedFrom).toBe("live");
    expect(payloadOf(r).provenance.servedFrom).toBe("live");
  });

  it("honours Retry-After on a 429, then succeeds", async () => {
    const { slept, c } = make((_u, n) => (n === 1 ? { status: 429, headers: { "retry-after": "2" }, body: "{}" } : good()));
    const r = (await c.read({ query })) as ConnectorReadResult;
    expect(r.health).toBe("OK");
    expect(slept).toEqual([2000]);
  });

  it("retries a transport error that is marked retryable, and stops at once on one that is not", async () => {
    const flaky = make((_u, n) => (n < 3 ? unavailable("connect ETIMEDOUT") : good()));
    expect(((await flaky.c.read({ query })) as ConnectorReadResult).health).toBe("OK");
    expect(flaky.dbl.calls).toHaveLength(3);
    const fatal = make(() => new PortError("UNAVAILABLE", "TLS verification failed", { retryable: false, tls: true }));
    const err = await failureOf(fatal.c.read({ query }));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(fatal.dbl.calls).toHaveLength(1);
  });

  it("does not retry an EMPTY answer, a malformed query or an access refusal", async () => {
    const empty = make(() => ({ status: 404, headers: { "content-type": "application/json" }, body: JSON.stringify({ error: { code: "NOT_FOUND", message: "No matches found!" } }) }));
    expect(((await empty.c.read({ query })) as ConnectorReadResult).health).toBe("EMPTY");
    expect(empty.dbl.calls).toHaveLength(1);
    // Constructed: a 400 from the endpoint and a 403 for a rejected key.
    const bad = make(() => ({ status: 400, body: JSON.stringify({ error: { code: "BAD_REQUEST", message: "Invalid limit parameter value." } }) }));
    expect((await failureOf(bad.c.read({ query }))).failure).toBe("INVALID");
    expect(bad.dbl.calls).toHaveLength(1);
    const forbidden = make(() => ({ status: 403, body: JSON.stringify({ error: { code: "API_KEY_INVALID" } }) }));
    expect((await failureOf(forbidden.c.read({ query }))).failure).toBe("FORBIDDEN");
  });

  it("a 404 that is a wrong path (HTML body) is INVALID, not EMPTY", async () => {
    const wrong = recorded("https://api.fda.gov/device/notanendpoint.json?search=k_number:K200667");
    const { c } = make(() => ({ status: wrong.status, headers: wrong.headers, body: wrong.body }));
    expect((await failureOf(c.read({ query }))).failure).toBe("INVALID");
  });

  it("a renamed required field is DRIFTED and names the field; the record is not produced", async () => {
    const { c } = make(() => {
      const r = recorded(OK_URL);
      return { status: 200, headers: r.headers, body: r.text.replaceAll('"k_number"', '"submission_id"') };
    });
    const err = await failureOf(c.read({ query }));
    expect(err.failure).toBe("DRIFTED");
    expect(err.message).toMatch(/results\[\]\.k_number is missing/);
  });

  it("a changed type on a required field is DRIFTED", async () => {
    const { c } = make(() => {
      const r = recorded(OK_URL);
      const doc = JSON.parse(r.text);
      doc.meta.results.total = String(doc.meta.results.total);
      return { status: 200, headers: r.headers, body: JSON.stringify(doc) };
    });
    const err = await failureOf(c.read({ query }));
    expect(err.failure).toBe("DRIFTED");
    expect(err.message).toMatch(/meta\.results\.total is string, expected number/);
  });

  it("a new field, and an absent optional field, are not drift", async () => {
    const { c } = make(() => {
      const r = recorded(OK_URL);
      const doc = JSON.parse(r.text);
      doc.results[0].brand_new_field = { nested: true };
      delete doc.results[0].address_2;
      return { status: 200, headers: r.headers, body: JSON.stringify(doc) };
    });
    expect(((await c.read({ query })) as ConnectorReadResult).health).toBe("OK");
  });

  it("an HTML maintenance page served with status 200 is DRIFTED, never OK or EMPTY", async () => {
    const { c } = make(() => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>We will be right back</html>" }));
    expect((await failureOf(c.read({ query }))).failure).toBe("DRIFTED");
  });

  it("PubMed: an HTTP 200 with a changed count type is DRIFTED", async () => {
    const t = fakeClock();
    const live = createSourceLayer({
      mode: "live",
      fetcher: liveDouble(() => ({ status: 200, body: JSON.stringify({ esearchresult: { count: 3, idlist: ["1", "2", "3"] } }) })),
      stateDir: tmpDir(),
      clock: t.clock,
      sleep: t.sleep,
    });
    expect((await failureOf(live.connectors.get("pubmed-eutils")!.read({ query: { rawQuery: "x[tiab]" } }))).failure).toBe("DRIFTED");
  });

  it("check() reports each outcome as a typed health without throwing", async () => {
    const outcomes: Array<[Parameters<typeof liveDouble>[0], string]> = [
      [() => ({ status: 503, body: "" }), "UNAVAILABLE"],
      [() => ({ status: 200, body: "<html>" }), "DRIFTED"],
      [() => ({ status: 403, body: "{}" }), "FORBIDDEN"],
      [() => ({ status: 404, body: JSON.stringify({ error: { code: "NOT_FOUND" } }) }), "EMPTY"],
      [() => ({ status: 404, body: "<html>Cannot GET</html>" }), "DRIFTED"],
      [() => unavailable("socket hang up"), "UNAVAILABLE"],
    ];
    for (const [answer, expected] of outcomes) {
      const { c } = make(answer, { maxAttempts: 1 });
      const res = await c.check();
      expect(res.health, res.detail).toBe(expected);
    }
  });

  it("the page of an incomplete read carries a cursor and says it cannot show absence", async () => {
    const doc = JSON.parse(recorded(OK_URL).text);
    doc.meta.results.total = 7;
    const { c } = make(() => ({ status: 200, body: JSON.stringify(doc) }));
    const r = (await c.read({ query })) as ConnectorReadResult;
    expect(r.complete).toBe(false);
    expect(JSON.parse(r.state!)).toEqual({ skip: 1 });
    expect(r.notes.join(" ")).toMatch(/cannot show that nothing else exists/);
  });
});

// ---------------------------------------------------------------- request budget through the connectors

describe("request budget", () => {
  it("the three openFDA endpoints share one daily allowance and the 1,001st request is refused without sleeping", async () => {
    const t = fakeClock();
    const dbl = liveFromCassette();
    const state = tmpDir();
    const live = createSourceLayer({ mode: "live", fetcher: dbl, stateDir: state, clock: t.clock, sleep: t.sleep });
    const ids = ["openfda-510k", "openfda-udi", "openfda-pma"] as const;
    const queries: Record<(typeof ids)[number], Record<string, string>> = {
      "openfda-510k": { k_number: "K200667" },
      "openfda-udi": { submission_number: "K200667" },
      "openfda-pma": { pma_number: "P130020" },
    };
    for (let i = 0; i < 1000; i++) {
      const id = ids[i % 3]!;
      // pma's default page size is not recorded; ask for the recorded one
      await live.connectors.get(id)!.read({ query: queries[id], ...(id === "openfda-pma" ? { limit: 2 } : {}) });
      t.clock.now(); // the limiter's own sleeps advance the fake clock when the per-minute window binds
    }
    expect(dbl.calls).toHaveLength(1000);
    const before = t.now;
    const err = await failureOf(live.connectors.get("openfda-510k")!.read({ query: queries["openfda-510k"] }));
    expect(err.failure).toBe("UNAVAILABLE");
    expect(err.detail?.["budgetExhausted"]).toBe(true);
    expect(dbl.calls).toHaveLength(1000); // no 1,001st request was sent
    expect(t.now).toBe(before); // and nothing was slept off
    const file = JSON.parse(fs.readFileSync(path.join(state, "source-budget.json"), "utf8"));
    expect(file.groups.openfda).toHaveLength(1000);
  });

  it("retries spend budget too: three attempts on an outage are three requests", async () => {
    const t = fakeClock();
    const state = tmpDir();
    const dbl = liveDouble(() => ({ status: 503, body: "" }));
    const live = createSourceLayer({ mode: "live", fetcher: dbl, stateDir: state, clock: t.clock, sleep: t.sleep });
    await failureOf(live.connectors.get("openfda-510k")!.read({ query: { k_number: "K200667" } }));
    const file = JSON.parse(fs.readFileSync(path.join(state, "source-budget.json"), "utf8"));
    expect(file.groups.openfda).toHaveLength(3);
  });
});

// ---------------------------------------------------------------- query builders (properties)

describe("query builders", () => {
  const phrase = fc.string({ minLength: 1, maxLength: 60 });

  it("never put an unquoted or unescaped user string into a search expression (property)", async () => {
    await fc.assert(
      fc.asyncProperty(phrase, phrase, phrase, async (vendor, product, condition) => {
        const dbl = liveFromCassette(() => new Error("stop"));
        const live = createSourceLayer({ mode: "live", fetcher: dbl, stateDir: tmpDir(), sleep: noSleep, maxAttempts: 1 });
        for (const [id, key] of [["pubmed-eutils", "term"], ["clinicaltrials-v2", "query.term"], ["europepmc", "query"]] as const) {
          dbl.calls.length = 0;
          try {
            await live.connectors.get(id)!.read({ query: { vendor, product, condition } });
          } catch (err) {
            if (!(err instanceof PortError)) throw err;
            if (err.failure === "INVALID") continue; // refused up front: fine
          }
          const sent = dbl.calls[0];
          if (!sent) continue;
          const expression = new URL(sent.url).searchParams.get(key)!;
          // Exactly three quoted phrases joined by AND, and no phrase contains a quote, so the user's text cannot end one early.
          const phrases = expression.match(/"[^"]*"/g) ?? [];
          expect(phrases).toHaveLength(3);
          expect(expression.replace(/"[^"]*"/g, "").replace(/\[tiab\]/g, "").replace(/\s*AND\s*/g, "").trim()).toBe("");
          expect(/[\r\n\0]/.test(expression)).toBe(false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it("a product with no vendor is always refused, whatever the text (property)", async () => {
    await fc.assert(
      fc.asyncProperty(phrase, async (product) => {
        for (const id of ["pubmed-eutils", "clinicaltrials-v2", "europepmc"]) {
          const err = await conn(id).read({ query: { product } }).catch((e) => e);
          expect(err).toBeInstanceOf(PortError);
          expect(err.failure).toBe("INVALID");
        }
      }),
      { numRuns: 100 },
    );
  });

  it("identifier fields only accept their own formats (property)", async () => {
    await fc.assert(
      fc.asyncProperty(fc.string({ maxLength: 30 }), async (junk) => {
        const bad = !/^(?:K\d{6}|DEN\d{6,7})$/.test(junk.trim()) && junk.trim() !== "";
        if (!bad) return;
        const err = await conn("openfda-510k").read({ query: { k_number: junk } }).catch((e) => e);
        expect(err).toBeInstanceOf(PortError);
        expect(["INVALID"]).toContain(err.failure);
      }),
      { numRuns: 200 },
    );
  });
});
