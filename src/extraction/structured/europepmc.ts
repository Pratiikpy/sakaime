/**
 * Europe PMC REST search parser (resultType "lite" and "core").
 *
 * A hit means the search engine matched the query text somewhere in the record or its full text. It does NOT mean the
 * publication evaluated the product the query names, so the matched query is stored as a search hit and nothing here
 * links a paper to a device. Titles can carry markup and entities from the index; they are cleaned for display, and
 * the anchor keeps the characters the record holds.
 */
import { PortError } from "../../ports/index.ts";
import type { VerifyOptions } from "../verify.ts";
import { asNumber, asRecord, asString, drifted, FieldCollector, parseJson, type StructuredExtraction } from "./collector.ts";

const SOURCE = "Europe PMC";

export interface EpmcHit {
  source?: string;
  id: string;
  pmid?: string;
  pmcid?: string;
  doi?: string;
  title?: string;
  journal?: string;
  year?: number;
  firstPublished?: string;
  pubTypes: string[];
  citedByCount?: number;
  openAccess?: boolean;
}

export interface EpmcFacts {
  query?: string;
  hitCount: number;
  hits: EpmcHit[];
}

type Opts = Pick<VerifyOptions, "model">;

/** Titles come back with HTML entities and inline tags (&lt;sub&gt;). Returns plain text for display. */
export function cleanEpmcTitle(raw: string): string {
  const decoded = raw.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x")) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith("#")) return String.fromCodePoint(parseInt(body.slice(1), 10));
    const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
    return named[body] ?? whole;
  });
  return decoded.replace(/<\/?[a-zA-Z][^>]*>/g, "").replace(/\s+/g, " ").trim();
}

export async function parseEuropePmc(raw: unknown, recordId: string, opts: Opts = {}): Promise<StructuredExtraction<EpmcFacts>> {
  const json = asRecord(parseJson(raw, SOURCE));
  if (!json) throw drifted(SOURCE, "the body is not an object");
  if (asRecord(json.errCode) || asString(json.errMsg)) {
    throw new PortError("UNAVAILABLE", `${SOURCE} returned an error: ${String(json.errMsg ?? json.errCode)}`);
  }
  const hitCount = asNumber(json.hitCount);
  const list = asRecord(json.resultList);
  if (hitCount === undefined || !list || !Array.isArray(list.result)) {
    throw drifted(SOURCE, "expected hitCount and resultList.result", { keys: Object.keys(json) });
  }
  const query = asString(asRecord(json.request)?.queryString);
  const c = new FieldCollector(`record:${recordId}`, "study");
  const hits: EpmcHit[] = [];

  list.result.forEach((x, i) => {
    const r = asRecord(x);
    const id = asString(r?.id);
    if (!r || !id) throw drifted(SOURCE, `resultList.result[${i}] has no id`);
    const p = `$.resultList.result[${i}]`;
    const pmid = asString(r.pmid);
    const subject = pmid ? `publication:pmid:${pmid}` : `publication:${asString(r.source) ?? "epmc"}:${id}`;
    const s = { subjectId: subject };
    const hit: EpmcHit = { id, pubTypes: [] };
    const set = <K extends keyof EpmcHit>(k: K, v: EpmcHit[K] | undefined) => {
      if (v !== undefined) hit[k] = v;
    };
    set("source", asString(r.source));
    set("pmid", pmid);
    set("pmcid", asString(r.pmcid));
    set("doi", asString(r.doi));
    const rawTitle = asString(r.title);
    if (rawTitle) set("title", cleanEpmcTitle(rawTitle));
    set("journal", asString(r.journalTitle));
    const year = asString(r.pubYear);
    if (year && /^\d{4}$/.test(year)) set("year", Number(year));
    set("firstPublished", /^\d{4}-\d{2}-\d{2}$/.test(asString(r.firstPublicationDate) ?? "") ? asString(r.firstPublicationDate) : undefined);
    set("pubTypes", (asString(r.pubType) ?? "").split(";").map((t) => t.trim()).filter(Boolean));
    set("citedByCount", asNumber(r.citedByCount));
    if (r.isOpenAccess === "Y" || r.isOpenAccess === "N") set("openAccess", r.isOpenAccess === "Y");
    hits.push(hit);

    c.scalar(`${p}.id`, id, "document.identifier", id, s);
    c.scalar(`${p}.pmid`, pmid, "publication.pmid", pmid, s);
    c.scalar(`${p}.pmcid`, hit.pmcid, "publication.pmcid", hit.pmcid, s);
    c.scalar(`${p}.doi`, hit.doi, "publication.doi", hit.doi, s);
    // the anchor keeps the record's own characters; the cleaned form is in facts
    c.scalar(`${p}.title`, rawTitle, "publication.title", rawTitle, s);
    c.scalar(`${p}.journalTitle`, hit.journal, "publication.journal", hit.journal, s);
    if (hit.year !== undefined) c.scalar(`${p}.pubYear`, year, "publication.year", hit.year, { ...s, numbers: [{ value: hit.year, form: "count" }] });
    c.scalar(`${p}.firstPublicationDate`, hit.firstPublished, "publication.first_published", hit.firstPublished, s);
    c.scalar(`${p}.pubType`, asString(r.pubType), "publication.type", hit.pubTypes, s);
    if (query) {
      // The query text is part of the request, not of the record; the hit is stored with the query that produced it.
      c.scalar(`$.request.queryString`, query, "publication.search_hit", query, { ...s, detail: { qualifiers: ["match_location_not_verified"] } });
    }
  });

  const health = hits.length === 0 ? "EMPTY" : "OK";
  const out = await c.finish(recordId, { ...(query ? { query } : {}), hitCount, hits }, health, opts);
  return hitCount > hits.length ? { ...out, truncated: { returned: hits.length, total: hitCount } } : out;
}
