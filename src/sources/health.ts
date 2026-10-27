/**
 * Source health classification: one place that turns a response or an error into a typed outcome.
 *
 * The rule that matters most: only EMPTY may be read as "none found in source X on date D". A 404 that is really
 * a wrong path, an HTTP 200 that is really an error page, a stopped query engine and a rate-limit answer are all
 * different things, and none of them is EMPTY. Where the HTTP status alone cannot tell them apart (openFDA
 * answers "no matches" with a 404), the body decides.
 *
 * The table this implements is in docs/02-architecture.md section 5; each row has a test in
 * tests/sources/health.test.ts built from recorded responses where they exist.
 */
import { PortError, type FailureClass } from "../ports/index.ts";
import type { SourceHealth } from "../schemas/common.ts";
import { textOf } from "./fetcher.ts";

/** INVALID is the one outcome that is not a source-health state: the request or the response was malformed. */
export type ClassifiedHealth = SourceHealth | "INVALID";

export interface Classification {
  health: ClassifiedHealth;
  reason: string;
  /** Worth another attempt after a pause. Never true for EMPTY, INVALID, FORBIDDEN, BLOCKED or DRIFTED. */
  retryable: boolean;
  retryAfterMs?: number;
}

export const SOURCE_FAMILIES = [
  "openfda",
  "ctgov",
  "pubmed-esearch",
  "pubmed-efetch",
  "europepmc",
  "crossref-work",
  "crossref-search",
  "fda-pdf",
  "fda-list",
  "zetaris",
  "generic",
] as const;
export type SourceFamily = (typeof SOURCE_FAMILIES)[number];

export interface HttpObservation {
  family: SourceFamily;
  status: number;
  headers?: Record<string, string>;
  body: Uint8Array | string;
  /** The body is only the first bytes of the response (a bounded probe). */
  truncated?: boolean;
}

const ok = (reason: string): Classification => ({ health: "OK", reason, retryable: false });
const empty = (reason: string): Classification => ({ health: "EMPTY", reason, retryable: false });
const invalid = (reason: string): Classification => ({ health: "INVALID", reason, retryable: false });
const drifted = (reason: string): Classification => ({ health: "DRIFTED", reason, retryable: false });
const blocked = (reason: string): Classification => ({ health: "BLOCKED", reason, retryable: false });
const forbidden = (reason: string): Classification => ({ health: "FORBIDDEN", reason, retryable: false });
const unavailable = (reason: string, retryAfterMs?: number): Classification => ({ health: "UNAVAILABLE", reason, retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) });

const asText = (body: Uint8Array | string): string => (typeof body === "string" ? body : textOf(body));

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch {
    return { ok: false };
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function retryAfter(headers: Record<string, string> | undefined): number | undefined {
  const raw = headers?.["retry-after"];
  if (raw === undefined) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

// ---------------------------------------------------------------- statuses every HTTP source shares

/** Handles the statuses whose meaning does not depend on the source. Returns undefined when the family must decide. */
function commonStatus(obs: HttpObservation): Classification | undefined {
  const { status } = obs;
  const wait = retryAfter(obs.headers);
  if (status === 429) return unavailable("rate limited (HTTP 429)", wait);
  if (status === 408 || status === 425) return unavailable(`request timed out at the server (HTTP ${status})`, wait);
  if (status === 502 || status === 503 || status === 504) return unavailable(`source unavailable (HTTP ${status})`, wait);
  if (status === 401 || status === 403) return forbidden(`access refused by the source (HTTP ${status})`);
  return undefined;
}

// ---------------------------------------------------------------- families

function openfda(obs: HttpObservation): Classification {
  const text = asText(obs.body);
  const json = parseJson(text);
  const error = json.ok && isRecord(json.value) && isRecord(json.value["error"]) ? (json.value["error"] as Record<string, unknown>) : undefined;
  const code = typeof error?.["code"] === "string" ? (error["code"] as string) : undefined;

  if (obs.status === 200) {
    if (!json.ok || !isRecord(json.value) || !Array.isArray(json.value["results"]) || !isRecord(json.value["meta"])) {
      return drifted("openFDA answered 200 without a meta object and a results array");
    }
    return (json.value["results"] as unknown[]).length === 0 ? empty("openFDA answered 200 with no results") : ok("openFDA results");
  }
  // openFDA reports "no matches" as a 404 whose body is {"error":{"code":"NOT_FOUND","message":"No matches found!"}}.
  // A 404 for a path that does not exist is an HTML page, so the body is what separates the two.
  if (obs.status === 404) {
    if (code === "NOT_FOUND") return empty("openFDA NOT_FOUND: no matches found");
    return invalid("HTTP 404 without the NOT_FOUND body: the endpoint path is wrong, which is not an empty result");
  }
  if (obs.status === 400) return invalid(`openFDA rejected the request${error?.["message"] ? `: ${String(error["message"])}` : ""}`);
  const common = commonStatus(obs);
  if (common) return common.health === "FORBIDDEN" && code === "API_KEY_INVALID" ? forbidden("openFDA rejected the API key") : common;
  if (obs.status >= 500) {
    // A malformed Lucene query surfaces as a 500 whose details name a parse exception; a plain server fault does not.
    const details = typeof error?.["details"] === "string" ? (error["details"] as string) : "";
    if (/parse_exception|Failed to parse|query_shard_exception/i.test(details)) return invalid("openFDA could not parse the search expression");
    return unavailable(`openFDA server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  }
  return invalid(`unexpected HTTP ${obs.status} from openFDA`);
}

function ctgov(obs: HttpObservation): Classification {
  const text = asText(obs.body);
  if (obs.status === 200) {
    const json = parseJson(text);
    if (!json.ok || !isRecord(json.value)) return drifted("ClinicalTrials.gov answered 200 with a body that is not a JSON object");
    if (Array.isArray(json.value["studies"])) {
      return (json.value["studies"] as unknown[]).length === 0 ? empty("ClinicalTrials.gov search returned no studies") : ok("ClinicalTrials.gov studies");
    }
    if (isRecord(json.value["protocolSection"])) return ok("ClinicalTrials.gov study record");
    return drifted("ClinicalTrials.gov answered 200 with neither a studies array nor a protocolSection");
  }
  if (obs.status === 404) {
    return /^NCT number \S+ not found/.test(text.trim()) ? empty("ClinicalTrials.gov: no study with that NCT number") : invalid("HTTP 404 from ClinicalTrials.gov without the 'NCT number ... not found' message");
  }
  if (obs.status === 400) return invalid(`ClinicalTrials.gov rejected the request: ${text.trim().slice(0, 160)}`);
  const common = commonStatus(obs);
  if (common) return common;
  if (obs.status >= 500) return unavailable(`ClinicalTrials.gov server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  return invalid(`unexpected HTTP ${obs.status} from ClinicalTrials.gov`);
}

function pubmedSearch(obs: HttpObservation): Classification {
  const common = obs.status === 200 ? undefined : commonStatus(obs);
  if (common) return common;
  if (obs.status >= 500) return unavailable(`NCBI server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  const json = parseJson(asText(obs.body));
  if (obs.status !== 200) return invalid(`unexpected HTTP ${obs.status} from NCBI`);
  if (!json.ok || !isRecord(json.value)) return drifted("NCBI answered 200 with a body that is not a JSON object");
  if (typeof json.value["error"] === "string") return invalid(`NCBI error: ${json.value["error"]}`);
  const result = json.value["esearchresult"];
  if (!isRecord(result)) return drifted("NCBI esearch response has no esearchresult object");
  if (typeof result["ERROR"] === "string") return invalid(`NCBI esearch error: ${result["ERROR"]}`);
  const errorList = result["errorlist"];
  if (isRecord(errorList) && Array.isArray(errorList["fieldsnotfound"]) && errorList["fieldsnotfound"].length > 0) {
    return invalid(`NCBI did not recognise the field tag(s) ${JSON.stringify(errorList["fieldsnotfound"])}; the search was not run as written`);
  }
  const count = typeof result["count"] === "string" ? Number(result["count"]) : NaN;
  if (!Number.isInteger(count)) return drifted("NCBI esearch count is missing or not a numeric string");
  return count === 0 ? empty("PubMed search returned count 0") : ok("PubMed search results");
}

function pubmedFetch(obs: HttpObservation): Classification {
  const common = obs.status === 200 ? undefined : commonStatus(obs);
  if (common) return common;
  if (obs.status >= 500) return unavailable(`NCBI server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  if (obs.status !== 200) return invalid(`unexpected HTTP ${obs.status} from NCBI`);
  const text = asText(obs.body);
  if (/<ERROR>/.test(text) || /^\s*\{\s*"error"/.test(text)) return invalid("NCBI efetch reported an error in the body");
  if (!/<PubmedArticleSet[\s>]/.test(text)) return drifted("NCBI efetch answered 200 without a PubmedArticleSet element");
  return /<PubmedArticle[\s>]|<PubmedBookArticle[\s>]/.test(text) ? ok("PubMed article records") : empty("PubmedArticleSet is empty: no article for that id");
}

function europepmc(obs: HttpObservation): Classification {
  if (obs.status === 200) {
    const json = parseJson(asText(obs.body));
    if (!json.ok || !isRecord(json.value)) return drifted("Europe PMC answered 200 with a body that is not a JSON object");
    if (typeof json.value["errCode"] !== "undefined" || typeof json.value["errMsg"] === "string") return invalid(`Europe PMC rejected the query: ${String(json.value["errMsg"] ?? json.value["errCode"])}`);
    const hits = json.value["hitCount"];
    if (typeof hits !== "number") return drifted("Europe PMC response has no numeric hitCount");
    return hits === 0 ? empty("Europe PMC hitCount 0") : ok("Europe PMC results");
  }
  const common = commonStatus(obs);
  if (common) return common;
  if (obs.status === 400 || obs.status === 404) return invalid(`Europe PMC rejected the request (HTTP ${obs.status})`);
  if (obs.status >= 500) return unavailable(`Europe PMC server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  return invalid(`unexpected HTTP ${obs.status} from Europe PMC`);
}

function crossref(obs: HttpObservation, lookup: boolean): Classification {
  const text = asText(obs.body);
  if (obs.status === 200) {
    const json = parseJson(text);
    if (!json.ok || !isRecord(json.value) || json.value["status"] !== "ok" || !isRecord(json.value["message"])) {
      return drifted("Crossref answered 200 without status ok and a message object");
    }
    if (lookup) return ok("Crossref work record");
    const items = (json.value["message"] as Record<string, unknown>)["items"];
    if (!Array.isArray(items)) return drifted("Crossref search response has no items array");
    return items.length === 0 ? empty("Crossref search returned no items") : ok("Crossref search results");
  }
  if (obs.status === 404) {
    return lookup && /Resource not found/i.test(text) ? empty("Crossref holds no work with that DOI") : invalid("HTTP 404 from Crossref without the 'Resource not found' message");
  }
  if (obs.status === 400) return invalid(`Crossref rejected the request: ${text.trim().slice(0, 160)}`);
  const common = commonStatus(obs);
  if (common) return common;
  if (obs.status >= 500) return unavailable(`Crossref server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  return invalid(`unexpected HTTP ${obs.status} from Crossref`);
}

const BLOCK_MARKERS = /abuse-detection|apology_objects|Access Denied|Request unsuccessful|Pardon Our Interruption/i;

function isPdf(body: Uint8Array | string): boolean {
  if (typeof body === "string") return body.startsWith("%PDF");
  return body.length >= 4 && body[0] === 0x25 && body[1] === 0x50 && body[2] === 0x44 && body[3] === 0x46;
}

function fdaPdf(obs: HttpObservation): Classification {
  const location = obs.headers?.["location"] ?? "";
  if ([301, 302, 303, 307, 308].includes(obs.status)) {
    return BLOCK_MARKERS.test(location) ? blocked("redirected to the FDA abuse-detection page: scripted access refused") : invalid(`unexpected redirect (HTTP ${obs.status}) where a PDF was expected`);
  }
  if (obs.status === 200 || obs.status === 206) {
    if (isPdf(obs.body)) return ok("PDF (starts with %PDF)");
    const head = asText(obs.body).slice(0, 4000);
    if (BLOCK_MARKERS.test(head)) return blocked("HTTP 200 with a bot-protection page instead of a PDF");
    return drifted("HTTP 200 whose body does not start with %PDF: the source served something other than a PDF");
  }
  if (obs.status === 404) {
    // The server answers a missing path with an HTML "Page Not Found" page, so a 404 never carries PDF bytes.
    return isPdf(obs.body) ? invalid("HTTP 404 with PDF bytes: inconsistent response") : empty("no document at that URL (HTTP 404, HTML not-found page)");
  }
  const common = commonStatus(obs);
  if (common) return common;
  if (obs.status === 400) return invalid("request rejected (HTTP 400)");
  if (obs.status >= 500) return unavailable(`FDA server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  return invalid(`unexpected HTTP ${obs.status} for a PDF`);
}

function fdaList(obs: HttpObservation): Classification {
  const location = obs.headers?.["location"] ?? "";
  if ([301, 302, 303, 307, 308].includes(obs.status)) {
    return BLOCK_MARKERS.test(location) ? blocked("scripted fetch redirected to the FDA abuse-detection page (BLOCKED_FOR_SCRIPTS)") : invalid(`unexpected redirect (HTTP ${obs.status}) from the FDA list URL`);
  }
  // The media URL is known to exist; the bot-protection layer answers it with a 404 or 403 to scripted clients.
  if (obs.status === 404 || obs.status === 403) return blocked(`HTTP ${obs.status} from a URL known to exist: the bot-protection layer refused the scripted request`);
  if (obs.status === 200 || obs.status === 206) {
    const contentType = obs.headers?.["content-type"] ?? "";
    const text = asText(obs.body);
    if (BLOCK_MARKERS.test(text.slice(0, 4000)) && /html/i.test(contentType || "html")) return blocked("HTTP 200 with a bot-protection page instead of the CSV");
    if (!/csv|octet-stream|text\/plain/i.test(contentType) && /<html/i.test(text.slice(0, 500))) return drifted("HTTP 200 HTML where the CSV was expected");
    return text.startsWith("Date of Final Decision,Submission Number,Device,Company,Panel (Lead),Primary Product Code") ? ok("FDA AI list CSV") : drifted("CSV header differs from the pinned column set");
  }
  const common = commonStatus(obs);
  if (common) return common;
  if (obs.status >= 500) return unavailable(`FDA server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  return invalid(`unexpected HTTP ${obs.status} from the FDA list URL`);
}

// ---------------------------------------------------------------- Zetaris and generic messages

const ZETARIS_UNAVAILABLE = [
  /stopped SparkContext/i,
  /Could not create ResultSet/i,
  /TTransportException/i,
  /org\.apache\.thrift/i,
  /thrift/i,
  /Could not open client transport/i,
  /Connection refused/i,
  /Connection reset/i,
  /Broken pipe/i,
  /Read timed out/i,
  /SocketException/i,
  /java\.lang\.OutOfMemoryError/i,
];
const ZETARIS_FORBIDDEN = [/does not have access/i, /access denied/i, /permission denied/i, /not authori[sz]ed/i, /not allowed to/i];
const ZETARIS_INVALID = [/ParseException/i, /mismatched input/i, /cannot resolve/i, /Table or view not found/i, /AnalysisException/i];

/**
 * Classify a Zetaris error text. UNAVAILABLE patterns are tested first because a stopped Spark context arrives
 * as HTTP 400, indistinguishable by status from a malformed statement. Text that matches nothing is treated as
 * UNAVAILABLE, never as EMPTY or OK: the safe reading of an unrecognised failure is "do not trust an answer".
 */
export function classifyMessage(message: string, status?: number): Classification {
  if (ZETARIS_UNAVAILABLE.some((r) => r.test(message))) return unavailable(`federation engine unavailable: ${message.slice(0, 160)}`);
  if (ZETARIS_FORBIDDEN.some((r) => r.test(message))) return forbidden(`federation engine refused the identity: ${message.slice(0, 160)}`);
  if (ZETARIS_INVALID.some((r) => r.test(message))) return invalid(`federation engine rejected the statement: ${message.slice(0, 160)}`);
  if (status === 401 || status === 403) return forbidden(`federation engine refused the identity (HTTP ${status})`);
  return unavailable(`unrecognised failure from the federation engine${status ? ` (HTTP ${status})` : ""}: ${message.slice(0, 160)}`);
}

function genericHttp(obs: HttpObservation): Classification {
  if (obs.status >= 200 && obs.status < 300) return ok(`HTTP ${obs.status}`);
  const common = commonStatus(obs);
  if (common) return common;
  if (obs.status >= 500) return unavailable(`server error (HTTP ${obs.status})`, retryAfter(obs.headers));
  if (obs.status >= 400) return invalid(`request rejected (HTTP ${obs.status})`);
  return invalid(`unexpected HTTP ${obs.status}`);
}

/** Classify a received HTTP response for a given source family. */
export function classifyResponse(obs: HttpObservation): Classification {
  switch (obs.family) {
    case "openfda":
      return openfda(obs);
    case "ctgov":
      return ctgov(obs);
    case "pubmed-esearch":
      return pubmedSearch(obs);
    case "pubmed-efetch":
      return pubmedFetch(obs);
    case "europepmc":
      return europepmc(obs);
    case "crossref-work":
      return crossref(obs, true);
    case "crossref-search":
      return crossref(obs, false);
    case "fda-pdf":
      return fdaPdf(obs);
    case "fda-list":
      return fdaList(obs);
    case "zetaris":
      return obs.status >= 200 && obs.status < 300 ? ok("federation engine answered") : classifyMessage(asText(obs.body), obs.status);
    case "generic":
      return genericHttp(obs);
  }
}

const NETWORK_CODES = new Set(["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ECONNABORTED", "EHOSTUNREACH", "ENETUNREACH", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

/** Classify a thrown error (network, timeout, guard refusal, or a federation message). */
export function classifyError(err: unknown, family: SourceFamily = "generic"): Classification {
  if (err instanceof PortError) {
    const failure: FailureClass = err.failure;
    switch (failure) {
      case "UNAVAILABLE":
        return { health: "UNAVAILABLE", reason: err.message, retryable: err.detail?.["retryable"] !== false };
      case "TRUNCATED":
        return { health: "UNAVAILABLE", reason: `result truncated: ${err.message}`, retryable: false };
      case "FORBIDDEN":
      case "REFUSED":
        return forbidden(err.message);
      case "BLOCKED":
        return blocked(err.message);
      case "DRIFTED":
        return drifted(err.message);
      case "INVALID":
        return invalid(err.message);
    }
  }
  const e = err as { name?: string; code?: string; message?: string } | undefined;
  const message = e?.message ?? String(err);
  if (family === "zetaris") return classifyMessage(message);
  if (e?.name === "AbortError" || e?.name === "TimeoutError") return unavailable(`timed out: ${message}`);
  if (e?.code && NETWORK_CODES.has(e.code)) return unavailable(`network error ${e.code}: ${message}`);
  return unavailable(`unexpected error: ${message}`);
}

/** Map a non-success classification to the PortError the Connector contract promises. OK and EMPTY give undefined. */
export function toPortError(c: Classification, detail: Record<string, unknown> = {}): PortError | undefined {
  const failureOf: Partial<Record<ClassifiedHealth, FailureClass>> = {
    UNAVAILABLE: "UNAVAILABLE",
    FORBIDDEN: "FORBIDDEN",
    DRIFTED: "DRIFTED",
    BLOCKED: "BLOCKED",
    INVALID: "INVALID",
    STALE: "UNAVAILABLE",
  };
  const failure = failureOf[c.health];
  if (!failure) return undefined;
  return new PortError(failure, c.reason, { ...detail, health: c.health, retryable: c.retryable, ...(c.retryAfterMs !== undefined ? { retryAfterMs: c.retryAfterMs } : {}) });
}
