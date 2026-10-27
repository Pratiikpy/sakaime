/**
 * Stage 3: the bounded probe. One request through the SSRF-safe fetcher, classified before it is parsed, parsed into a
 * flat table, checked for truncation, and fingerprinted.
 *
 * Outcomes stay distinct, because they mean different things to the person reading them:
 *   empty    the source answered and has no records (never read as "none exist")
 *   failed   the source could not be asked, refused, blocked or answered with something that is not data
 *   ok       a table
 */
import { PortError, type FailureClass } from "../ports/index.ts";
import { classifyResponse, type SourceFamily } from "../sources/health.ts";
import type { LoadedCard } from "../sources/cards.ts";
import type { Fetcher } from "../sources/fetcher.ts";
import { fingerprintOf, type Fingerprint } from "./fingerprint.ts";
import { parseProbe, type ProbeTable } from "./tabular.ts";

export interface Fetched {
  finalUrl: string;
  status: number;
  sha256: string;
  at: string;
  redirects: number;
  resolvedAddress?: string;
  servedFrom: "live" | "recorded";
}

export type ProbeOutcome =
  | { kind: "ok"; table: ProbeTable; fingerprint: Fingerprint; fetched: Fetched; classification: string }
  | { kind: "empty"; reason: string; fetched: Fetched }
  | { kind: "failed"; failure: FailureClass; message: string; retryable: boolean; fetched?: Fetched };

export function familyOf(card: LoadedCard | undefined): SourceFamily {
  switch (card?.file.connector) {
    case "openfda-510k":
    case "openfda-udi":
    case "openfda-pma":
      return "openfda";
    case "clinicaltrials-v2":
      return "ctgov";
    default:
      return "generic";
  }
}

const HEALTH_FAILURE: Record<string, FailureClass> = {
  UNAVAILABLE: "UNAVAILABLE",
  FORBIDDEN: "FORBIDDEN",
  BLOCKED: "BLOCKED",
  DRIFTED: "DRIFTED",
  INVALID: "INVALID",
  STALE: "UNAVAILABLE",
};

/** A bounded endpoint says how many records it returns; one that does not, and reports more than it sent, was cut. */
function declaresBound(url: string): boolean {
  try {
    const q = new URL(url).searchParams;
    return ["limit", "pageSize", "page_size", "rows", "per_page", "max", "count", "size", "top", "$top"].some((k) => q.has(k));
  } catch {
    return false;
  }
}

export interface ProbeOptions {
  fetcher: Fetcher;
  url: string;
  family: SourceFamily;
  maxBytes: number;
  maxRows: number;
  now: Date;
}

export async function probe(o: ProbeOptions): Promise<ProbeOutcome> {
  let res;
  try {
    res = await o.fetcher.get(o.url, { maxBytes: o.maxBytes });
  } catch (e) {
    if (e instanceof PortError) return { kind: "failed", failure: e.failure, message: e.message, retryable: e.failure === "UNAVAILABLE" && e.detail?.["retryable"] !== false };
    throw e;
  }
  const fetched: Fetched = {
    finalUrl: res.finalUrl,
    status: res.status,
    sha256: "",
    at: o.now.toISOString(),
    redirects: res.redirects.length,
    ...(res.resolvedAddress ? { resolvedAddress: res.resolvedAddress } : {}),
    servedFrom: res.servedFrom,
  };
  const c = classifyResponse({ family: o.family, status: res.status, headers: res.headers, body: res.body });
  if (c.health === "EMPTY") return { kind: "empty", reason: c.reason, fetched };
  if (c.health !== "OK") return { kind: "failed", failure: HEALTH_FAILURE[c.health] ?? "INVALID", message: c.reason, retryable: c.retryable, fetched };
  let table: ProbeTable;
  try {
    table = parseProbe(res.body, res.headers["content-type"]);
  } catch (e) {
    if (e instanceof PortError) return { kind: "failed", failure: e.failure, message: e.message, retryable: false, fetched };
    throw e;
  }
  fetched.sha256 = table.sha256;
  if (table.rows.length === 0) return { kind: "empty", reason: "the source answered with a table that has no records", fetched };
  if (table.rows.length > o.maxRows) {
    return { kind: "failed", failure: "INVALID", message: `the response holds ${table.rows.length} records; a bounded probe accepts at most ${o.maxRows}. Add a limit to the request.`, retryable: false, fetched };
  }
  if (table.declaredTotal !== undefined && table.rows.length < table.declaredTotal && !declaresBound(o.url)) {
    return {
      kind: "failed",
      failure: "TRUNCATED",
      message: `the source declares ${table.declaredTotal} records but sent ${table.rows.length} and the request names no limit; the response was cut short`,
      retryable: false,
      fetched,
    };
  }
  return { kind: "ok", table, fingerprint: fingerprintOf(table), fetched, classification: c.reason };
}
