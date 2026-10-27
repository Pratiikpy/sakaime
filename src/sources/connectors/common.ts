/**
 * The shared engine behind every HTTP connector.
 *
 * A connector is a small spec (how to build a request from a query, how to read the answer) plus a source card.
 * This class does everything that must be identical across sources, in one place and in every mode (live,
 * recorded): spend the request budget, fetch, retry transient failures, classify the response, check the
 * response against the card's contract, and wrap the answer in an immutable EvidenceRecord with its request
 * and content hashes.
 */
import { PortError, systemClock, type CheckResult, type Clock, type Connector, type ReadRequest, type ReadResult, type SourceCard } from "../../ports/index.ts";
import type { EvidenceRecord } from "../../schemas/evidence.ts";
import { sha256Hex } from "../../util/canonical.ts";
import type { LoadedCard } from "../cards.ts";
import { requestHashOf } from "../cassette.ts";
import { checkContract, describeViolations, type ContractPath } from "../contract.ts";
import type { FetchInit, FetchResult, Fetcher } from "../fetcher.ts";
import { textOf } from "../fetcher.ts";
import { classifyError, classifyResponse, toPortError, type Classification, type SourceFamily } from "../health.ts";
import type { RateLimiter } from "../limiter.ts";

// ---------------------------------------------------------------- shapes

export type ServedFromMode = "live" | "recorded" | "snapshot";

export interface RawContent {
  mediaType: string;
  bytes: Uint8Array;
}

export interface RecordProvenance {
  sourceId: string;
  operation: string;
  /** The URL that was requested. */
  url: string;
  finalUrl: string;
  status: number;
  contentType?: string;
  servedFrom: ServedFromMode;
  health: "OK" | "EMPTY";
  /** "structured" when built from vendor, product and condition fields; "raw" when the caller supplied the expression. */
  queryForm?: "structured" | "raw";
  /** For an EMPTY answer: the only claim it supports. */
  emptyMeaning?: string;
  recordedAt?: string;
  resolvedAddress?: string;
}

/** What `EvidenceRecord.payload` holds for every record these connectors produce. */
export interface RecordPayload {
  provenance: RecordProvenance;
  /** The parsed answer: JSON as returned, a normalised summary for XML, or null where the body is a PDF. */
  body: unknown;
}

export interface ConnectorReadResult extends ReadResult {
  servedFrom: ServedFromMode;
  /** False when the source holds more than was returned. An incomplete read must never support "none exist". */
  complete: boolean;
  total?: number;
  returned: number;
  /** Plain statements a reviewer should see next to the result. */
  notes: string[];
  /** Raw response bytes per record id, for content too large or too structured to inline (PDFs, XML). */
  contents: Map<string, RawContent>;
}

export interface RequestPlan {
  url: string;
  family: SourceFamily;
  /** Names the contract in the card (`responseContracts.<operation>`) and appears in provenance. */
  operation: string;
  format: "json" | "xml" | "pdf";
  queryForm?: "structured" | "raw";
  init?: FetchInit;
}

export interface Parsed {
  body: unknown;
  /** Number of result items in this response. */
  returned: number;
  /** Total the source reports, when it does. */
  total?: number;
  /** Cursor for the next page, when there is one. */
  next?: string;
  /** The source's own freshness date for this answer, if the response carries one. */
  publishedAt?: string;
  /** A few items to show in `discover()`. */
  sample: unknown[];
  notes?: string[];
}

export interface ConnectorSpec {
  readonly key: string;
  plan(query: Record<string, string | number>, limit: number | undefined): RequestPlan;
  /** Read an answer already classified OK or EMPTY. */
  parse(args: { json: unknown; text: string; res: FetchResult; plan: RequestPlan; health: "OK" | "EMPTY" }): Parsed;
  /** The request `check()` and `discover()` send, from the card's probe. May ask for only the first bytes. */
  probe(card: LoadedCard): { plan: RequestPlan; peekBytes?: number };
}

export interface ConnectorContext {
  fetcher: Fetcher;
  /** Present for live fetchers; recorded responses cost nothing and are not limited. */
  limiter?: RateLimiter;
  clock?: Clock;
  sleep?: (ms: number) => Promise<void>;
  /** Total attempts for transient failures. Default 3. */
  maxAttempts?: number;
  /** Pause before the second attempt; doubles after. Default 500 ms. */
  backoffMs?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const MAX_RETRY_AFTER_MS = 60_000;

export class HttpConnector implements Connector {
  readonly card: SourceCard;
  protected readonly clock: Clock;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    protected readonly loaded: LoadedCard,
    protected readonly spec: ConnectorSpec,
    protected readonly ctx: ConnectorContext,
  ) {
    this.card = loaded.card;
    this.clock = ctx.clock ?? systemClock;
    this.sleep = ctx.sleep ?? defaultSleep;
  }

  describe(): SourceCard {
    return this.card;
  }

  // ---------------------------------------------------------------- the four verbs

  /** A real, bounded request. Never throws: every outcome is a typed health. */
  async check(): Promise<CheckResult> {
    const started = performance.now();
    const checkedAt = this.clock.now().toISOString();
    const finish = (health: CheckResult["health"], detail: string): CheckResult => ({ health, detail, latencyMs: Math.round(performance.now() - started), checkedAt });
    try {
      const { plan, peekBytes } = this.spec.probe(this.loaded);
      const { classification, res } = await this.execute(plan, peekBytes);
      return finish(classification.health as CheckResult["health"], `${classification.reason} (${res.servedFrom} ${plan.operation} probe, HTTP ${res.status})`);
    } catch (err) {
      const c = err instanceof PortError ? healthOfPortError(err) : classifyError(err, "generic");
      // A probe our own request builder got rejected for means the API no longer accepts what the card says.
      const health = c.health === "INVALID" ? "DRIFTED" : c.health;
      return finish(health as CheckResult["health"], c.health === "INVALID" ? `the probe request was rejected: ${c.reason}` : c.reason);
    }
  }

  async discover(): Promise<{ sample: unknown[]; schemaHash: string }> {
    const { plan, peekBytes } = this.spec.probe(this.loaded);
    const outcome = await this.run(plan, peekBytes);
    if (outcome.health === "EMPTY") {
      throw new PortError("DRIFTED", `the probe for ${this.card.id} returned no rows, so there is nothing to fingerprint; the identifier it uses may have changed`, { probe: this.loaded.file.probe });
    }
    return { sample: outcome.parsed.sample, schemaHash: outcome.fingerprint };
  }

  async read(request: ReadRequest): Promise<ConnectorReadResult> {
    const plan = this.spec.plan(request.query, request.limit);
    const { record, parsed, res, health, content } = await this.run(plan);
    const complete = parsed.next === undefined && (parsed.total === undefined || parsed.total <= (this.skipOf(request) + parsed.returned));
    const notes = [...(parsed.notes ?? [])];
    if (!complete) notes.push(`partial read: ${parsed.returned}${parsed.total !== undefined ? ` of ${parsed.total}` : ""} returned; continue with the state cursor or narrow the query. An incomplete read cannot show that nothing else exists.`);
    if (health === "EMPTY") notes.push((record.payload as RecordPayload).provenance.emptyMeaning!);
    if (res.servedFrom === "recorded") notes.push(`replayed from a recording made ${res.recordedAt}; not a live answer`);
    const contents = new Map<string, RawContent>();
    if (content) contents.set(record.id, content);
    return {
      health,
      records: [record],
      ...(parsed.next !== undefined ? { state: parsed.next } : {}),
      servedFrom: res.servedFrom,
      complete,
      ...(parsed.total !== undefined ? { total: parsed.total } : {}),
      returned: parsed.returned,
      notes,
      contents,
    };
  }

  protected skipOf(request: ReadRequest): number {
    const skip = request.query["skip"];
    return typeof skip === "number" ? skip : 0;
  }

  // ---------------------------------------------------------------- engine

  protected async run(plan: RequestPlan, peekBytes?: number) {
    const { res, classification } = await this.execute(plan, peekBytes);
    const health = classification.health as "OK" | "EMPTY";
    const text = plan.format === "pdf" ? "" : textOf(res.body);
    let json: unknown = undefined;
    if (plan.format === "json") {
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined; // EMPTY answers from some sources are plain text; the parser handles it
      }
    }
    if (plan.format === "json" && res.status === 200) this.enforceContract(plan, json);

    const parsed = this.spec.parse({ json, text, res, plan, health });
    const fingerprint = this.fingerprintOf(plan, json);
    const retrievedAt = res.servedFrom === "recorded" ? res.recordedAt! : this.clock.now().toISOString();
    const requestHash = requestHashOf(plan.url);
    const contentHash = sha256Hex(res.body);
    const emptyMeaning = health === "EMPTY" ? `none found in ${this.card.id} for this request as of ${retrievedAt.slice(0, 10)}${res.servedFrom === "recorded" ? " (recorded answer)" : ""}; this does not show that none exist` : undefined;
    const publishedAt = parsed.publishedAt ?? lastModifiedIso(res.headers["last-modified"]);

    const record: EvidenceRecord = {
      id: `${this.card.id}:${requestHash.slice(0, 12)}:${contentHash.slice(0, 12)}:${retrievedAt.replace(/\D/g, "").slice(0, 14)}`,
      sourceId: this.card.id,
      retrievedAt,
      ...(publishedAt ? { sourcePublishedAt: publishedAt } : {}),
      requestHash,
      contentHash,
      schemaVersion: `${this.card.id}/v${this.loaded.file.schemaVersion}`,
      license: this.card.license,
      payload: {
        provenance: {
          sourceId: this.card.id,
          operation: plan.operation,
          url: plan.url,
          finalUrl: res.finalUrl,
          status: res.status,
          ...(res.headers["content-type"] ? { contentType: res.headers["content-type"] } : {}),
          servedFrom: res.servedFrom,
          health,
          ...(plan.queryForm ? { queryForm: plan.queryForm } : {}),
          ...(emptyMeaning ? { emptyMeaning } : {}),
          ...(res.recordedAt ? { recordedAt: res.recordedAt } : {}),
          ...(res.resolvedAddress ? { resolvedAddress: res.resolvedAddress } : {}),
        },
        body: parsed.body,
      } satisfies RecordPayload,
    };
    // Raw bytes are attached only to an answer that has content: an empty set or a not-found page is not a document.
    const content: RawContent | undefined = plan.format === "json" || health !== "OK" ? undefined : { mediaType: plan.format === "pdf" ? "application/pdf" : "application/xml", bytes: res.body };
    return { record, parsed, res, health, fingerprint, content };
  }

  private fingerprintOf(plan: RequestPlan, json: unknown): string {
    const contract = this.loaded.file.responseContracts[plan.operation];
    if (contract && json !== undefined) return checkContract(json, contract as ContractPath[]).fingerprint;
    return sha256Hex(`${this.card.id}:${plan.operation}:${plan.format}`);
  }

  private enforceContract(plan: RequestPlan, json: unknown): void {
    const contract = this.loaded.file.responseContracts[plan.operation] as ContractPath[] | undefined;
    if (!contract) return;
    const check = checkContract(json, contract);
    if (!check.ok) {
      throw new PortError("DRIFTED", `${this.card.id} response no longer matches its source card: ${describeViolations(check.violations)}`, {
        health: "DRIFTED",
        operation: plan.operation,
        violations: check.violations,
        retryable: false,
      });
    }
  }

  /**
   * Spend budget, fetch, retry transient failures with backoff, classify. Returns only OK and EMPTY outcomes;
   * everything else throws the PortError the Connector contract promises.
   */
  protected async execute(plan: RequestPlan, peekBytes?: number): Promise<{ res: FetchResult; classification: Classification }> {
    const maxAttempts = this.ctx.maxAttempts ?? 3;
    let backoff = this.ctx.backoffMs ?? 500;
    let lastError: PortError | undefined;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: FetchResult | undefined;
      let classification: Classification;
      const limiter = this.ctx.fetcher.servedFrom === "live" ? this.ctx.limiter : undefined;
      if (limiter) await limiter.acquire(); // may throw: an exhausted budget is final, not retried
      try {
        res = await this.ctx.fetcher.get(plan.url, { ...plan.init, ...(peekBytes !== undefined ? { peekBytes } : {}) });
        classification = classifyResponse({ family: plan.family, status: res.status, headers: res.headers, body: res.body, truncated: res.truncated });
      } catch (err) {
        if (err instanceof PortError && !(err.failure === "UNAVAILABLE" && err.detail?.["retryable"] !== false)) throw err;
        classification = err instanceof PortError ? healthOfPortError(err) : classifyError(err);
        lastError = err instanceof PortError ? err : (toPortError(classification, { url: plan.url }) as PortError);
      } finally {
        limiter?.release();
      }

      if (res && (classification.health === "OK" || classification.health === "EMPTY")) return { res, classification };
      if (res) lastError = toPortError(classification, { url: plan.url, status: res.status, family: plan.family }) as PortError;
      if (!classification.retryable || attempt === maxAttempts) throw lastError!;
      const pause = Math.min(classification.retryAfterMs ?? backoff, MAX_RETRY_AFTER_MS);
      await this.sleep(pause);
      backoff *= 2;
    }
    throw lastError ?? new PortError("UNAVAILABLE", "request failed");
  }
}

function healthOfPortError(err: PortError): Classification {
  return classifyError(err);
}

export function lastModifiedIso(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const t = Date.parse(header);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

// ---------------------------------------------------------------- query helpers shared by the specs

const CONTROL = /[\u0000-\u001f\u007f]/;

export function invalid(message: string, detail?: Record<string, unknown>): PortError {
  return new PortError("INVALID", message, detail);
}

/** Reject keys the connector does not understand: a typo must not silently widen a search. */
export function expectKeys(query: Record<string, string | number>, allowed: string[], source: string): void {
  const extra = Object.keys(query).filter((k) => !allowed.includes(k));
  if (extra.length > 0) throw invalid(`${source} does not understand the query key(s) ${extra.map((k) => `"${k}"`).join(", ")}; it accepts ${allowed.join(", ")}`);
}

export function textValue(query: Record<string, string | number>, key: string, max = 200): string | undefined {
  const raw = query[key];
  if (raw === undefined) return undefined;
  const value = String(raw).trim();
  if (value === "") throw invalid(`"${key}" is empty`);
  if (value.length > max) throw invalid(`"${key}" is longer than ${max} characters`);
  if (CONTROL.test(value)) throw invalid(`"${key}" contains control characters`);
  return value;
}

/** A phrase safe to place inside a quoted search term. */
export function quoted(value: string): string {
  // Backslash escaping of a quote is read differently by Lucene, PubMed and Europe PMC, so a quote or backslash
  // inside a name is refused instead of escaped: the search that runs must be the search that was meant.
  if (/["\\]/.test(value)) throw invalid(`"${value.slice(0, 40)}" contains a quote or backslash, which cannot be searched safely as a phrase`);
  return `"${value}"`;
}

export const ID_PATTERNS = {
  k: /^K\d{6}$/,
  den: /^DEN\d{6,7}$/,
  submission: /^(?:K\d{6}|DEN\d{6,7})$/,
  pma: /^P\d{6}$/,
  nct: /^NCT\d{8}$/,
  pmid: /^\d{1,9}$/,
  doi: /^10\.\d{4,9}\/[-._;()/:A-Za-z0-9]+$/,
  productCode: /^[A-Z]{3}$/,
} as const;

export function identifier(query: Record<string, string | number>, key: string, pattern: RegExp, example: string, max = 40): string | undefined {
  const value = textValue(query, key, max);
  if (value === undefined) return undefined;
  if (!pattern.test(value)) throw invalid(`"${key}" must look like ${example}; got "${value.slice(0, 40)}"`);
  return value;
}

export function identifierList(query: Record<string, string | number>, key: string, pattern: RegExp, example: string, maxItems: number): string[] | undefined {
  const value = textValue(query, key, 2000);
  if (value === undefined) return undefined;
  const parts = value.split(",").map((p) => p.trim());
  if (parts.length > maxItems) throw invalid(`"${key}" accepts at most ${maxItems} identifiers`);
  for (const p of parts) if (!pattern.test(p)) throw invalid(`"${key}" entries must look like ${example}; got "${p.slice(0, 40)}"`);
  return [...new Set(parts)];
}

export interface VendorProduct {
  vendor?: string;
  product?: string;
  condition?: string;
}

/**
 * Product names are common words (ContaCT matched 446,198 PubMed records, Caption 683, BriefCase a palliative-care
 * paper). A product therefore may only be searched together with its vendor. Condition narrows further.
 * Returns undefined when none of the three keys is present.
 */
export function vendorProduct(query: Record<string, string | number>, source: string): VendorProduct | undefined {
  const vendor = textValue(query, "vendor");
  const product = textValue(query, "product");
  const condition = textValue(query, "condition");
  if (vendor === undefined && product === undefined && condition === undefined) return undefined;
  if (product !== undefined && vendor === undefined) {
    throw invalid(
      `${source}: a product name is never searched on its own. Product names collide with common words (ContaCT matches 446,198 PubMed records), so give the vendor as well, for example vendor="Eyenuk" product="EyeArt" condition="diabetic retinopathy".`,
    );
  }
  if (vendor === undefined) throw invalid(`${source}: a condition alone is not a device search; give vendor and product`);
  if (product === undefined) throw invalid(`${source}: give the product with the vendor`);
  return { vendor, product, ...(condition !== undefined ? { condition } : {}) };
}

export function limitOf(limit: number | undefined, fallback: number, max: number): number {
  if (limit === undefined) return fallback;
  if (!Number.isInteger(limit) || limit < 1) throw invalid(`limit must be a positive integer; got ${limit}`);
  if (limit > max) throw invalid(`limit may not exceed ${max}; got ${limit}`);
  return limit;
}

export function buildUrl(base: string, params: Array<[string, string]>): string {
  if (params.length === 0) return base;
  const search = new URLSearchParams();
  for (const [k, v] of params) search.append(k, v);
  return `${base}?${search.toString()}`;
}

export function rawQueryOf(query: Record<string, string | number>): string | undefined {
  return textValue(query, "rawQuery", 500);
}
