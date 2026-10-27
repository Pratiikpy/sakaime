/**
 * The per-source part of each connector: how a query becomes a request, and how an answer is read.
 *
 * Every builder validates before anything is sent. Identifiers are matched against their formats, free text is
 * quoted and escaped, unknown keys are rejected, and a product name is never searched without its vendor.
 * Defaults (page sizes, field lists) reproduce the exact requests the feasibility probe recorded, so replaying a
 * cassette needs no special casing.
 */
import { PortError } from "../../ports/index.ts";
import type { LoadedCard } from "../cards.ts";
import { PubmedXmlError, parsePubmedXml } from "./pubmed-xml.ts";
import {
  ID_PATTERNS,
  buildUrl,
  expectKeys,
  identifier,
  identifierList,
  invalid,
  limitOf,
  quoted,
  rawQueryOf,
  textValue,
  vendorProduct,
  type ConnectorSpec,
  type Parsed,
  type RequestPlan,
} from "./common.ts";

type Query = Record<string, string | number>;
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const dateToIso = (d: unknown): string | undefined => (typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : undefined);

function nonNegativeInt(query: Query, key: string): number | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw invalid(`"${key}" must be a non-negative integer; got "${String(raw).slice(0, 20)}"`);
  return n;
}

const jsonBody = (json: unknown, text: string): unknown => json ?? (text.length > 500 ? `${text.slice(0, 500)}...` : text);

// ---------------------------------------------------------------- openFDA (510k, UDI, PMA)

type OpenfdaKind = "openfda-510k" | "openfda-udi" | "openfda-pma";

interface OpenfdaDef {
  base: string;
  /** Default and maximum page sizes. A single-identifier 510(k) lookup sends no limit, as the probe did. */
  defaultLimit: number | undefined;
  build(query: Query): { terms: string[]; listCount?: number; singleLookup: boolean };
  keys: string[];
}

const OPENFDA: Record<OpenfdaKind, OpenfdaDef> = {
  "openfda-510k": {
    base: "https://api.fda.gov/device/510k.json",
    defaultLimit: undefined,
    keys: ["k_number", "applicant", "device_name", "product_code", "skip"],
    build(query) {
      const numbers = identifierList(query, "k_number", ID_PATTERNS.submission, "K200667 or DEN170073", 100);
      const applicant = textValue(query, "applicant");
      const device = textValue(query, "device_name");
      const code = identifier(query, "product_code", ID_PATTERNS.productCode, "QAS");
      if (numbers === undefined && applicant === undefined && device === undefined && code === undefined) {
        throw invalid("openfda-510k needs k_number, or applicant (with device_name), or product_code");
      }
      if (device !== undefined && applicant === undefined) throw invalid("openfda-510k: a device name is never searched without its applicant (the vendor); product names collide with unrelated records");
      const terms: string[] = [];
      if (numbers) terms.push(numbers.length === 1 ? `k_number:${numbers[0]}` : `k_number:(${numbers.join(" OR ")})`);
      if (applicant) terms.push(`applicant:${quoted(applicant)}`);
      if (device) terms.push(`device_name:${quoted(device)}`);
      if (code) terms.push(`product_code:${code}`);
      return { terms, listCount: numbers && numbers.length > 1 ? numbers.length : undefined, singleLookup: numbers?.length === 1 && terms.length === 1 };
    },
  },
  "openfda-udi": {
    base: "https://api.fda.gov/device/udi.json",
    defaultLimit: 100,
    keys: ["submission_number", "brand_name", "company_name", "skip"],
    build(query) {
      const submission = textValue(query, "submission_number", 40);
      if (submission !== undefined && !ID_PATTERNS.submission.test(submission) && !ID_PATTERNS.pma.test(submission)) {
        throw invalid(`"submission_number" must look like K200667, DEN170073 or P130020; got "${submission.slice(0, 40)}"`);
      }
      const brand = textValue(query, "brand_name");
      const company = textValue(query, "company_name");
      if (submission === undefined && brand === undefined && company === undefined) throw invalid("openfda-udi needs submission_number, or company_name with brand_name");
      if (brand !== undefined && company === undefined) throw invalid("openfda-udi: a brand name is never searched without its company (the vendor); product names collide with unrelated records");
      const terms: string[] = [];
      if (submission) terms.push(`premarket_submissions.submission_number:${quoted(submission)}`);
      if (company) terms.push(`company_name:${quoted(company)}`);
      if (brand) terms.push(`brand_name:${quoted(brand)}`);
      return { terms, singleLookup: false };
    },
  },
  "openfda-pma": {
    base: "https://api.fda.gov/device/pma.json",
    defaultLimit: 100,
    keys: ["pma_number", "applicant", "trade_name", "skip"],
    build(query) {
      const pma = identifier(query, "pma_number", ID_PATTERNS.pma, "P130020 (the base number; supplements are returned as separate records)");
      const applicant = textValue(query, "applicant");
      const trade = textValue(query, "trade_name");
      if (pma === undefined && applicant === undefined && trade === undefined) throw invalid("openfda-pma needs pma_number, or applicant with trade_name");
      if (trade !== undefined && applicant === undefined) throw invalid("openfda-pma: a trade name is never searched without its applicant (the vendor); product names collide with unrelated records");
      const terms: string[] = [];
      if (pma) terms.push(`pma_number:${pma}`);
      if (applicant) terms.push(`applicant:${quoted(applicant)}`);
      if (trade) terms.push(`trade_name:${quoted(trade)}`);
      return { terms, singleLookup: false };
    },
  },
};

export function openfdaSpec(kind: OpenfdaKind): ConnectorSpec {
  const def = OPENFDA[kind];
  return {
    key: kind,
    plan(query, limit) {
      expectKeys(query, def.keys, kind);
      const { terms, listCount, singleLookup } = def.build(query);
      const skip = nonNegativeInt(query, "skip");
      const params: Array<[string, string]> = [["search", terms.join(" AND ")]];
      // openFDA returns one record unless told otherwise, so a list lookup must ask for as many as it named.
      const pageSize = limit !== undefined ? limitOf(limit, 1, 100) : listCount ? listCount : def.defaultLimit !== undefined ? def.defaultLimit : singleLookup ? undefined : 25;
      if (pageSize !== undefined) params.push(["limit", String(pageSize)]);
      if (skip) params.push(["skip", String(skip)]);
      return { url: buildUrl(def.base, params), family: "openfda", operation: "main", format: "json", queryForm: "structured" };
    },
    parse({ json, text, health }): Parsed {
      if (health === "EMPTY") return { body: jsonBody(json, text), returned: 0, total: 0, sample: [] };
      const doc = json as { meta: { last_updated?: string; results: { skip: number; limit: number; total: number } }; results: unknown[] };
      const skip = doc.meta.results.skip ?? 0;
      const returned = doc.results.length;
      const total = doc.meta.results.total;
      return {
        body: doc,
        returned,
        total,
        ...(total > skip + returned ? { next: JSON.stringify({ skip: skip + returned }) } : {}),
        ...(dateToIso(doc.meta.last_updated) ? { publishedAt: dateToIso(doc.meta.last_updated)! } : {}),
        sample: doc.results.slice(0, 3),
      };
    },
    probe: (card) => ({ plan: openfdaSpec(kind).plan(card.file.probe.query as Query, card.file.probe.limit) }),
  };
}

// ---------------------------------------------------------------- ClinicalTrials.gov v2

const CT_BASE = "https://clinicaltrials.gov/api/v2";
const CT_FIELDS = "NCTId,BriefTitle,InterventionName,LeadSponsorName,EnrollmentCount,StartDate,OverallStatus";

export const clinicaltrialsSpec: ConnectorSpec = {
  key: "clinicaltrials-v2",
  plan(query, limit): RequestPlan {
    expectKeys(query, ["nct_id", "identifier", "vendor", "product", "condition", "sponsor", "rawQuery", "page_token"], "clinicaltrials-v2");
    const nct = identifier(query, "nct_id", ID_PATTERNS.nct, "NCT03112005");
    const term = vendorProduct(query, "clinicaltrials-v2");
    const exact = textValue(query, "identifier", 40);
    const sponsor = textValue(query, "sponsor");
    const raw = rawQueryOf(query);
    const chosen = [nct, term, exact, sponsor, raw].filter((v) => v !== undefined).length;
    if (chosen === 0) throw invalid("clinicaltrials-v2 needs nct_id, identifier, vendor with product, sponsor, or rawQuery");
    if (chosen > 1) throw invalid("clinicaltrials-v2 takes one kind of search at a time: nct_id, identifier, vendor+product(+condition), sponsor, or rawQuery");
    if (nct) return { url: `${CT_BASE}/studies/${nct}`, family: "ctgov", operation: "study", format: "json" };

    const params: Array<[string, string]> = [];
    let queryForm: RequestPlan["queryForm"] = "structured";
    if (term) params.push(["query.term", [quoted(term.vendor!), quoted(term.product!), ...(term.condition ? [quoted(term.condition)] : [])].join(" AND ")]);
    else if (exact !== undefined) {
      if (!/^[A-Za-z0-9-]{4,40}$/.test(exact)) throw invalid(`"identifier" must be a single token such as DEN170073 or NCT03112005; got "${exact.slice(0, 40)}"`);
      params.push(["query.term", exact]);
    } else if (sponsor !== undefined) params.push(["query.spons", sponsor]);
    else {
      params.push(["query.term", raw!]);
      queryForm = "raw";
    }
    params.push(["pageSize", String(limitOf(limit, 15, 100))], ["countTotal", "true"], ["fields", CT_FIELDS]);
    const token = textValue(query, "page_token", 200);
    if (token) params.push(["pageToken", token]);
    return { url: buildUrl(`${CT_BASE}/studies`, params), family: "ctgov", operation: "search", format: "json", queryForm };
  },
  parse({ json, text, plan, health }): Parsed {
    if (health === "EMPTY") return { body: jsonBody(json, text), returned: 0, total: 0, sample: [] };
    const doc = json as Record<string, unknown>;
    if (plan.operation === "study") {
      const updated = ((doc["protocolSection"] as Record<string, any>)?.["statusModule"]?.["lastUpdatePostDateStruct"]?.["date"]) as unknown;
      return { body: doc, returned: 1, total: 1, ...(dateToIso(updated) ? { publishedAt: dateToIso(updated)! } : {}), sample: [doc] };
    }
    const studies = doc["studies"] as unknown[];
    const next = doc["nextPageToken"];
    return {
      body: doc,
      returned: studies.length,
      ...(typeof doc["totalCount"] === "number" ? { total: doc["totalCount"] as number } : {}),
      ...(typeof next === "string" ? { next } : {}),
      sample: studies.slice(0, 3),
    };
  },
  probe: (card) => ({ plan: clinicaltrialsSpec.plan(card.file.probe.query as Query, card.file.probe.limit) }),
};

// ---------------------------------------------------------------- PubMed E-utilities

const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";

export const pubmedSpec: ConnectorSpec = {
  key: "pubmed",
  plan(query, limit): RequestPlan {
    expectKeys(query, ["pmid", "pmids", "nct_id", "nct_field", "vendor", "product", "condition", "rawQuery"], "pubmed");
    const pmid = identifier(query, "pmid", ID_PATTERNS.pmid, "34779843");
    const pmids = identifierList(query, "pmids", ID_PATTERNS.pmid, "34779843", 100);
    const nct = identifier(query, "nct_id", ID_PATTERNS.nct, "NCT03112005");
    const term = vendorProduct(query, "pubmed");
    const raw = rawQueryOf(query);
    const chosen = [pmid ?? pmids, nct, term, raw].filter((v) => v !== undefined).length;
    if (chosen === 0) throw invalid("pubmed needs pmid, pmids, nct_id, vendor with product, or rawQuery");
    if (chosen > 1) throw invalid("pubmed takes one kind of request at a time: pmid(s), nct_id, vendor+product(+condition), or rawQuery");

    if (pmid !== undefined || pmids !== undefined) {
      const ids = pmids ?? [pmid!];
      return { url: buildUrl(`${EUTILS}/efetch.fcgi`, [["db", "pubmed"], ["id", ids.join(",")], ["retmode", "xml"]]), family: "pubmed-efetch", operation: "efetch", format: "xml" };
    }
    let expression: string;
    let queryForm: RequestPlan["queryForm"] = "structured";
    if (nct) {
      // A search by NCT number finds the paper only some of the time, and the two forms miss different papers:
      // the secondary-identifier tag is exact but is set only when the journal deposited the link; free text
      // finds the number wherever the abstract prints it. The caller chooses; neither is complete alone.
      const field = textValue(query, "nct_field", 3) ?? "all";
      if (field !== "all" && field !== "si") throw invalid('"nct_field" must be "all" or "si"');
      expression = field === "si" ? `${nct}[si]` : nct;
    } else if (term) {
      expression = [`${quoted(term.vendor!)}[tiab]`, `${quoted(term.product!)}[tiab]`, ...(term.condition ? [`${quoted(term.condition)}[tiab]`] : [])].join(" AND ");
    } else {
      expression = raw!;
      queryForm = "raw";
    }
    return {
      url: buildUrl(`${EUTILS}/esearch.fcgi`, [["db", "pubmed"], ["term", expression], ["retmax", String(limitOf(limit, 20, 100))], ["retmode", "json"], ["sort", "relevance"]]),
      family: "pubmed-esearch",
      operation: "esearch",
      format: "json",
      queryForm: nct ? "structured" : queryForm,
    };
  },
  parse({ json, text, res, plan, health }): Parsed {
    if (plan.operation === "esearch") {
      if (health === "EMPTY") return { body: json, returned: 0, total: 0, sample: [] };
      const result = (json as { esearchresult: { count: string; idlist: string[] } }).esearchresult;
      return { body: json, returned: result.idlist.length, total: Number(result.count), sample: result.idlist.slice(0, 5) };
    }
    if (health === "EMPTY") return { body: { articles: [] }, returned: 0, total: 0, sample: [] };
    let articles;
    try {
      articles = parsePubmedXml(text);
    } catch (err) {
      if (err instanceof PubmedXmlError) throw new PortError("DRIFTED", `PubMed efetch XML could not be read: ${err.message}`, { health: "DRIFTED", retryable: false });
      throw err;
    }
    const asked = new URL(plan.url).searchParams.get("id")?.split(",") ?? [];
    const got = new Set(articles.map((a) => a.pmid));
    const missing = asked.filter((id) => !got.has(id));
    void res;
    return {
      body: { articles, requestedIds: asked, missingIds: missing },
      returned: articles.length,
      // efetch has no total: ids PubMed holds no record for are reported in missingIds, not as an unfinished read.
      total: articles.length,
      sample: articles.slice(0, 3).map((a) => ({ pmid: a.pmid, title: a.title, year: a.year, nctIds: a.nctIds })),
      notes: missing.length > 0 ? [`PubMed returned no record for ${missing.join(", ")}`] : [],
    };
  },
  probe: (card) => ({ plan: pubmedSpec.plan(card.file.probe.query as Query, card.file.probe.limit) }),
};

// ---------------------------------------------------------------- Europe PMC

const EPMC = "https://www.ebi.ac.uk/europepmc/webservices/rest";

export const europepmcSpec: ConnectorSpec = {
  key: "europepmc",
  plan(query, limit): RequestPlan {
    expectKeys(query, ["identifier", "vendor", "product", "condition", "rawQuery"], "europepmc");
    const exact = textValue(query, "identifier", 60);
    const term = vendorProduct(query, "europepmc");
    const raw = rawQueryOf(query);
    const chosen = [exact, term, raw].filter((v) => v !== undefined).length;
    if (chosen === 0) throw invalid("europepmc needs identifier, vendor with product, or rawQuery");
    if (chosen > 1) throw invalid("europepmc takes one kind of search at a time");
    let expression: string;
    let queryForm: RequestPlan["queryForm"] = "structured";
    if (exact !== undefined) {
      if (!/^[A-Za-z0-9./_-]{4,60}$/.test(exact)) throw invalid(`"identifier" must be a single token such as K200667, DEN170073, NCT03112005 or a DOI; got "${exact.slice(0, 40)}"`);
      expression = quoted(exact);
    } else if (term) {
      expression = [quoted(term.vendor!), quoted(term.product!), ...(term.condition ? [quoted(term.condition)] : [])].join(" AND ");
    } else {
      expression = raw!;
      queryForm = "raw";
    }
    return { url: buildUrl(`${EPMC}/search`, [["query", expression], ["format", "json"], ["pageSize", String(limitOf(limit, 10, 100))], ["resultType", "lite"]]), family: "europepmc", operation: "search", format: "json", queryForm };
  },
  parse({ json, text, health }): Parsed {
    if (health === "EMPTY") return { body: jsonBody(json, text), returned: 0, total: 0, sample: [] };
    const doc = json as { hitCount: number; resultList: { result: unknown[] } };
    return {
      body: doc,
      returned: doc.resultList.result.length,
      total: doc.hitCount,
      sample: doc.resultList.result.slice(0, 3),
      notes: ["Europe PMC matches full text and can match loosely; each hit is a candidate until its text is read."],
    };
  },
  probe: (card) => ({ plan: europepmcSpec.plan(card.file.probe.query as Query, card.file.probe.limit) }),
};

// ---------------------------------------------------------------- Crossref

const CROSSREF = "https://api.crossref.org";

export const crossrefSpec: ConnectorSpec = {
  key: "crossref",
  plan(query, limit): RequestPlan {
    expectKeys(query, ["doi", "bibliographic"], "crossref");
    const doi = identifier(query, "doi", ID_PATTERNS.doi, "10.1001/jamacardio.2021.0185", 120);
    const biblio = textValue(query, "bibliographic", 300);
    if (doi === undefined && biblio === undefined) throw invalid("crossref needs doi or bibliographic");
    if (doi !== undefined && biblio !== undefined) throw invalid("crossref takes doi or bibliographic, not both");
    if (doi !== undefined) return { url: `${CROSSREF}/works/${doi}`, family: "crossref-work", operation: "work", format: "json" };
    return {
      url: buildUrl(`${CROSSREF}/works`, [["query.bibliographic", biblio!], ["rows", String(limitOf(limit, 3, 20))], ["select", "DOI,title,issued,relation"]]),
      family: "crossref-search",
      operation: "search",
      format: "json",
    };
  },
  parse({ json, text, plan, health }): Parsed {
    if (health === "EMPTY") return { body: jsonBody(json, text), returned: 0, total: 0, sample: [] };
    const message = (json as { message: Record<string, unknown> }).message;
    if (plan.operation === "work") return { body: json, returned: 1, total: 1, sample: [{ DOI: message["DOI"], title: message["title"] }] };
    const items = message["items"] as unknown[];
    return { body: json, returned: items.length, ...(typeof message["total-results"] === "number" ? { total: message["total-results"] as number } : {}), sample: items.slice(0, 3) };
  },
  probe: (card) => ({ plan: crossrefSpec.plan(card.file.probe.query as Query, card.file.probe.limit) }),
};

// ---------------------------------------------------------------- FDA decision summary PDFs

const ACCESSDATA = "https://www.accessdata.fda.gov";

export const fdaPdfSpec: ConnectorSpec = {
  key: "fda-pdf",
  plan(query): RequestPlan {
    expectKeys(query, ["submission_number", "url"], "fda-pdf");
    const number = textValue(query, "submission_number", 40);
    const url = textValue(query, "url", 500);
    if (number === undefined && url === undefined) throw invalid("fda-pdf needs submission_number (K200667 or DEN170073) or url");
    if (number !== undefined && url !== undefined) throw invalid("fda-pdf takes submission_number or url, not both");
    if (url !== undefined) {
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        throw invalid("fda-pdf: url could not be parsed");
      }
      if (parsed.protocol !== "https:" || parsed.hostname !== "www.accessdata.fda.gov" || !/^\/cdrh_docs\/.+\.pdf$/i.test(parsed.pathname)) {
        throw invalid("fda-pdf: url must be an https://www.accessdata.fda.gov/cdrh_docs/....pdf address");
      }
      return { url: parsed.href, family: "fda-pdf", operation: "pdf", format: "pdf", init: { headers: { accept: "application/pdf" } } };
    }
    if (ID_PATTERNS.k.test(number!)) {
      // 510(k) summaries sit under a folder named for the two-digit year in the K number.
      return { url: `${ACCESSDATA}/cdrh_docs/pdf${number!.slice(1, 3)}/${number}.pdf`, family: "fda-pdf", operation: "pdf", format: "pdf", init: { headers: { accept: "application/pdf" } } };
    }
    if (ID_PATTERNS.den.test(number!)) {
      return { url: `${ACCESSDATA}/cdrh_docs/reviews/${number}.pdf`, family: "fda-pdf", operation: "pdf", format: "pdf", init: { headers: { accept: "application/pdf" } } };
    }
    if (ID_PATTERNS.pma.test(number!)) {
      throw invalid("fda-pdf: the address pattern for PMA summaries has not been verified, so no URL is built for a P number; pass url explicitly if you know it");
    }
    throw invalid(`fda-pdf: submission_number must look like K200667 or DEN170073; got "${number!.slice(0, 40)}"`);
  },
  parse({ res, health }): Parsed {
    if (health === "EMPTY") return { body: null, returned: 0, total: 0, sample: [] };
    const header = new TextDecoder().decode(res.body.slice(0, 8));
    const version = /^%PDF-(\d\.\d)/.exec(header)?.[1];
    const body = { mediaType: "application/pdf", ...(res.truncated ? { bytesRead: res.body.length, truncated: true } : { byteLength: res.body.length }), ...(version ? { pdfVersion: version } : {}) };
    return { body, returned: 1, total: 1, sample: [body], notes: res.truncated ? ["only the first bytes were read; this is a probe, not the document"] : [] };
  },
  probe(card) {
    const plan = fdaPdfSpec.plan(card.file.probe.query as Query, card.file.probe.limit);
    // Ask for the first kilobyte. The server honoured a Range request on 2026-10-27; if one ignores it, the
    // fetcher still stops reading after the first 1,024 bytes.
    return { plan: { ...plan, init: { ...plan.init, headers: { ...(plan.init?.headers ?? {}), range: "bytes=0-1023" } } }, peekBytes: 1024 };
  },
};

export const specFor = (loaded: LoadedCard): ConnectorSpec => {
  switch (loaded.file.connector) {
    case "openfda-510k":
    case "openfda-udi":
    case "openfda-pma":
      return openfdaSpec(loaded.file.connector);
    case "clinicaltrials-v2":
      return clinicaltrialsSpec;
    case "pubmed":
      return pubmedSpec;
    case "europepmc":
      return europepmcSpec;
    case "crossref":
      return crossrefSpec;
    case "fda-pdf":
      return fdaPdfSpec;
    case "fda-ai-list":
      throw new Error("fda-ai-list is a snapshot connector and has no HTTP spec");
  }
};
