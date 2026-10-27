/**
 * Opt-in live checks: LIVE=1 npx vitest run tests/sources/live.test.ts
 *
 * One request per source card, through the same safe fetcher, request budget and connector code the product uses
 * (retries off, so each source sees exactly one request). Each compares what came back with the recording the
 * feasibility probe made, so a source that has changed its behaviour shows up here before it shows up in a case.
 * Skipped, and reported as skipped, unless LIVE=1.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { ConnectorReadResult, RecordPayload } from "../../src/sources/connectors/common.ts";
import { createSourceLayer } from "../../src/sources/factory.ts";
import { recorded } from "./helpers.ts";

const live = process.env["LIVE"] === "1";
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "sakaime-live-"));
afterAll(() => fs.rmSync(stateDir, { recursive: true, force: true }));

if (!live) {
  describe("live source checks", () => {
    it.skip("SKIPPED: set LIVE=1 to make one real request per source", () => undefined);
  });
} else {
  const layer = createSourceLayer({ mode: "live", stateDir, maxAttempts: 1 });
  const body = (r: ConnectorReadResult) => (r.records[0]!.payload as RecordPayload).body as any;
  const recordedJson = (url: string) => JSON.parse(recorded(url).text);
  const say = (line: string) => console.log(`LIVE: ${line}`);

  describe("live source checks (one request per source)", () => {
    it("openfda-510k: K200667 returns the same clearance as the recording", async () => {
      const r = (await layer.connectors.get("openfda-510k")!.read({ query: { k_number: "K200667" } })) as ConnectorReadResult;
      const before = recordedJson("https://api.fda.gov/device/510k.json?search=k_number:K200667").results[0];
      const now = body(r).results[0];
      say(`openfda-510k ${r.health}, servedFrom ${r.servedFrom}, meta.last_updated ${body(r).meta.last_updated}`);
      expect(r.servedFrom).toBe("live");
      expect(r.health).toBe("OK");
      for (const f of ["k_number", "device_name", "applicant", "decision_date", "product_code", "decision_description"]) expect(now[f], f).toBe(before[f]);
    });

    it("openfda-udi: a submission number with no GUDID record is still the NOT_FOUND body, read as EMPTY", async () => {
      const r = (await layer.connectors.get("openfda-udi")!.read({ query: { submission_number: "DEN999999" } })) as ConnectorReadResult;
      say(`openfda-udi DEN999999 -> ${r.health} (HTTP ${(r.records[0]!.payload as RecordPayload).provenance.status})`);
      expect(r.health).toBe("EMPTY");
      expect((r.records[0]!.payload as RecordPayload).provenance.status).toBe(404);
    });

    it("openfda-pma: P130020 still returns supplement records with the fields the contract names", async () => {
      const r = (await layer.connectors.get("openfda-pma")!.read({ query: { pma_number: "P130020" }, limit: 2 })) as ConnectorReadResult;
      const before = recordedJson("https://api.fda.gov/device/pma.json?search=pma_number:P130020&limit=2");
      say(`openfda-pma ${r.health}, returned ${r.returned} of ${r.total} (recorded total ${before.meta.results.total})`);
      expect(r.health).toBe("OK");
      expect(body(r).results[0].pma_number).toBe("P130020");
      expect(body(r).results[0].applicant).toBe(before.results[0].applicant);
    });

    it("clinicaltrials-v2: NCT03112005 is unchanged in title and status", async () => {
      const r = (await layer.connectors.get("clinicaltrials-v2")!.read({ query: { nct_id: "NCT03112005" } })) as ConnectorReadResult;
      const before = recordedJson("https://clinicaltrials.gov/api/v2/studies/NCT03112005").protocolSection;
      const now = body(r).protocolSection;
      say(`clinicaltrials-v2 ${r.health}, overallStatus ${now.statusModule.overallStatus}`);
      expect(now.identificationModule.briefTitle).toBe(before.identificationModule.briefTitle);
      expect(now.statusModule.overallStatus).toBe(before.statusModule.overallStatus);
    });

    it("pubmed-eutils: PMID 34779843 parses to the same title, DOI and NCT number", async () => {
      const r = (await layer.connectors.get("pubmed-eutils")!.read({ query: { pmid: "34779843" } })) as ConnectorReadResult;
      const a = body(r).articles[0];
      say(`pubmed-eutils ${r.health}, ${a.pmid} "${a.title.slice(0, 60)}..." nct ${a.nctIds}`);
      expect(a.title).toMatch(/^Pivotal Evaluation of an Artificial Intelligence System/);
      expect(a.doi).toBe("10.1001/jamanetworkopen.2021.34254");
      expect(a.nctIds).toEqual(["NCT03112005"]);
    });

    it("europepmc: the exact submission number K200667 still finds at least one article", async () => {
      const r = (await layer.connectors.get("europepmc")!.read({ query: { identifier: "K200667" } })) as ConnectorReadResult;
      say(`europepmc ${r.health}, hitCount ${r.total}`);
      expect(r.health).toBe("OK");
      expect(r.total).toBeGreaterThanOrEqual(1);
    });

    it("crossref: the JAMA Cardiology DOI resolves to the same title", async () => {
      const r = (await layer.connectors.get("crossref")!.read({ query: { doi: "10.1001/jamacardio.2021.0185" } })) as ConnectorReadResult;
      const before = recordedJson("https://api.crossref.org/works/10.1001/jamacardio.2021.0185").message;
      say(`crossref ${r.health}, ${body(r).message.DOI}`);
      expect(body(r).message.DOI.toLowerCase()).toBe(before.DOI.toLowerCase());
      expect(body(r).message.title).toEqual(before.title);
    });

    it("fda-accessdata-pdf: the DEN180001 summary is byte-identical to the recording", async () => {
      const r = (await layer.connectors.get("fda-accessdata-pdf")!.read({ query: { submission_number: "DEN180001" } })) as ConnectorReadResult;
      say(`fda-accessdata-pdf ${r.health}, ${r.records[0]!.contentHash}`);
      expect(r.health).toBe("OK");
      expect(r.records[0]!.contentHash).toBe("9b4a978bf52a1c3aa5871d014d0d9b214ada70c884a9a311fa11a7e266ee7e38");
    });

    it("fda-ai-list: reports what the live list does to a scripted request, typed", async () => {
      const check = await layer.connectors.get("fda-ai-list")!.check();
      say(`fda-ai-list check -> ${check.health}: ${check.detail}`);
      expect(["OK", "STALE", "BLOCKED", "UNAVAILABLE"]).toContain(check.health);
    });
  });
}
