/**
 * Cassettes: recorded real responses that tests and judge mode replay with no network.
 *
 * A cassette is a directory:
 *
 *   index.json          the entries: canonical request, status, kept headers, body hash and size, when recorded
 *   bodies/<sha256>     the exact response bytes, named by their own hash
 *
 * Bodies are addressed by hash, so a body cannot silently differ from what the index says it is: `load()`
 * re-hashes every body and fails loudly on any mismatch, missing file or unreferenced edit. Replay serves the
 * recorded bytes and status unchanged and labels them `recorded`; a request with no recording is an error
 * ("no recording"), never an invented answer.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { PortError } from "../ports/index.ts";
import { IsoDateTime, Sha256 } from "../schemas/evidence.ts";
import { hashOf, sha256Hex } from "../util/canonical.ts";
import type { FetchInit, FetchResult, Fetcher, RedirectHop } from "./fetcher.ts";
import { validateUrl, type HostAllowlist } from "./safe-fetch.ts";

// ---------------------------------------------------------------- canonical request

export interface CanonicalRequest {
  method: "GET";
  origin: string;
  path: string;
  /** Sorted by key then value; values decoded, so `+` and `%20` hash identically. */
  query: Array<[string, string]>;
}

export function canonicalRequest(rawUrl: string): CanonicalRequest {
  const url = new URL(rawUrl);
  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const origin = `${url.protocol}//${host}${url.port ? `:${url.port}` : ""}`;
  const query = [...url.searchParams.entries()].sort(([ak, av], [bk, bv]) => (ak === bk ? (av < bv ? -1 : av > bv ? 1 : 0) : ak < bk ? -1 : 1));
  return { method: "GET", origin, path: url.pathname, query };
}

/** Hash of the request that produced a record: method, origin, path and the canonical (sorted, decoded) query. */
export function requestHashOf(rawUrl: string): string {
  return hashOf(canonicalRequest(rawUrl));
}

// ---------------------------------------------------------------- format

export const CassetteEntrySchema = z.object({
  requestHash: Sha256,
  request: z.object({ method: z.literal("GET"), url: z.string().url() }),
  response: z.object({
    status: z.number().int(),
    /** Only headers that carry meaning for interpretation. Never cookies or credentials. */
    headers: z.record(z.string(), z.string()),
    sha256: Sha256,
    bytes: z.number().int().nonnegative(),
  }),
  recordedAt: IsoDateTime,
  /** "day" when the original log only kept the date. */
  recordedAtPrecision: z.enum(["instant", "day"]),
  origin: z.object({
    kind: z.enum(["feasibility-fixture", "live-recording"]),
    /** Where the bytes came from: a fixture path in the research folder, or the recording tool. */
    ref: z.string(),
  }),
});
export type CassetteEntry = z.infer<typeof CassetteEntrySchema>;

export const CassetteIndexSchema = z.object({
  version: z.literal(1),
  name: z.string().min(1),
  description: z.string(),
  entries: z.array(CassetteEntrySchema),
  /** Requests in the source material that were deliberately not included, with the reason. */
  skipped: z
    .array(z.object({ url: z.string(), reason: z.string() }))
    .default([]),
  /** Requests that were made and logged but whose bodies were never saved, counted per host. */
  unsaved: z.record(z.string(), z.number().int()).default({}),
});
export type CassetteIndex = z.infer<typeof CassetteIndexSchema>;

export const KEPT_RESPONSE_HEADERS = ["content-type", "last-modified", "location", "retry-after", "etag"] as const;

export function keptHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of KEPT_RESPONSE_HEADERS) {
    const value = headers[name];
    if (value !== undefined) out[name] = value;
  }
  return out;
}

export class CassetteIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CassetteIntegrityError";
  }
}

// ---------------------------------------------------------------- store

export class CassetteStore {
  private readonly byKey = new Map<string, CassetteEntry>();
  private readonly bodies = new Map<string, Uint8Array>();

  private constructor(
    readonly dir: string,
    private meta: { name: string; description: string; skipped: CassetteIndex["skipped"]; unsaved: Record<string, number> },
  ) {}

  static create(dir: string, name: string, description: string): CassetteStore {
    return new CassetteStore(dir, { name, description, skipped: [], unsaved: {} });
  }

  /** Read a cassette and verify every body against its hash. Throws CassetteIntegrityError on any mismatch. */
  static load(dir: string): CassetteStore {
    const indexPath = path.join(dir, "index.json");
    if (!fs.existsSync(indexPath)) throw new CassetteIntegrityError(`cassette index not found: ${indexPath}`);
    const parsed = CassetteIndexSchema.safeParse(JSON.parse(fs.readFileSync(indexPath, "utf8")));
    if (!parsed.success) throw new CassetteIntegrityError(`cassette index is malformed: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    const store = new CassetteStore(dir, {
      name: parsed.data.name,
      description: parsed.data.description,
      skipped: parsed.data.skipped,
      unsaved: parsed.data.unsaved,
    });
    for (const entry of parsed.data.entries) {
      const expectedKey = requestHashOf(entry.request.url);
      if (entry.requestHash !== expectedKey) {
        throw new CassetteIntegrityError(`entry for ${entry.request.url} carries requestHash ${entry.requestHash} but its URL hashes to ${expectedKey}`);
      }
      if (store.byKey.has(entry.requestHash)) throw new CassetteIntegrityError(`duplicate recording for ${entry.request.url}`);
      const bodyPath = path.join(dir, "bodies", entry.response.sha256);
      if (!fs.existsSync(bodyPath)) throw new CassetteIntegrityError(`body ${entry.response.sha256} for ${entry.request.url} is missing`);
      const bytes = new Uint8Array(fs.readFileSync(bodyPath));
      const actual = sha256Hex(bytes);
      if (actual !== entry.response.sha256) {
        throw new CassetteIntegrityError(`body for ${entry.request.url} hashes to ${actual}, the index says ${entry.response.sha256}`);
      }
      if (bytes.length !== entry.response.bytes) {
        throw new CassetteIntegrityError(`body for ${entry.request.url} is ${bytes.length} bytes, the index says ${entry.response.bytes}`);
      }
      store.byKey.set(entry.requestHash, entry);
      store.bodies.set(entry.response.sha256, bytes);
    }
    return store;
  }

  get name(): string {
    return this.meta.name;
  }
  get size(): number {
    return this.byKey.size;
  }

  entries(): CassetteEntry[] {
    return [...this.byKey.values()].sort((a, b) => (a.request.url < b.request.url ? -1 : 1));
  }

  find(url: string): { entry: CassetteEntry; body: Uint8Array } | undefined {
    const entry = this.byKey.get(requestHashOf(url));
    if (!entry) return undefined;
    return { entry, body: this.bodies.get(entry.response.sha256)! };
  }

  /** Add one recording. Re-adding identical content is a no-op; different content needs `overwrite`. */
  add(args: { url: string; status: number; headers: Record<string, string>; body: Uint8Array; recordedAt: string; precision: "instant" | "day"; origin: CassetteEntry["origin"] }, overwrite = false): CassetteEntry {
    const requestHash = requestHashOf(args.url);
    const sha = sha256Hex(args.body);
    const existing = this.byKey.get(requestHash);
    if (existing && !overwrite) {
      if (existing.response.sha256 === sha && existing.response.status === args.status) return existing;
      throw new CassetteIntegrityError(`a different response is already recorded for ${args.url}; pass overwrite to replace it`);
    }
    const entry: CassetteEntry = {
      requestHash,
      request: { method: "GET", url: args.url },
      response: { status: args.status, headers: keptHeaders(args.headers), sha256: sha, bytes: args.body.length },
      recordedAt: args.recordedAt,
      recordedAtPrecision: args.precision,
      origin: args.origin,
    };
    this.byKey.set(requestHash, entry);
    this.bodies.set(sha, args.body);
    return entry;
  }

  skip(url: string, reason: string): void {
    this.meta.skipped.push({ url, reason });
  }

  skipUnsaved(host: string): void {
    this.meta.unsaved[host] = (this.meta.unsaved[host] ?? 0) + 1;
  }

  /** Write index and bodies. Bodies no longer referenced are removed so the directory matches the index exactly. */
  save(): void {
    fs.mkdirSync(path.join(this.dir, "bodies"), { recursive: true });
    const referenced = new Set<string>();
    for (const entry of this.byKey.values()) {
      referenced.add(entry.response.sha256);
      const bodyPath = path.join(this.dir, "bodies", entry.response.sha256);
      if (!fs.existsSync(bodyPath)) fs.writeFileSync(bodyPath, this.bodies.get(entry.response.sha256)!);
    }
    for (const file of fs.readdirSync(path.join(this.dir, "bodies"))) {
      if (!referenced.has(file)) fs.rmSync(path.join(this.dir, "bodies", file));
    }
    const index: CassetteIndex = {
      version: 1,
      name: this.meta.name,
      description: this.meta.description,
      entries: this.entries(),
      skipped: [...this.meta.skipped].sort((a, b) => (a.url < b.url ? -1 : 1)),
      unsaved: Object.fromEntries(Object.entries(this.meta.unsaved).sort(([a], [b]) => (a < b ? -1 : 1))),
    };
    fs.writeFileSync(path.join(this.dir, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
  }
}

// ---------------------------------------------------------------- replay

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * Serves recorded responses through the same Fetcher interface as the live fetcher. URL validation (https,
 * allowlist, no IP literals) still runs, so a refusal behaves identically in replay and live.
 */
export class CassetteFetcher implements Fetcher {
  readonly servedFrom = "recorded" as const;

  constructor(
    private readonly store: CassetteStore,
    private readonly allowlist: HostAllowlist,
    private readonly maxRedirects = 5,
  ) {}

  async get(rawUrl: string, init: FetchInit = {}): Promise<FetchResult> {
    const started = performance.now();
    const follow = (init.redirect ?? "follow") === "follow";
    const redirects: RedirectHop[] = [];
    let current = rawUrl;

    for (;;) {
      const checked = validateUrl(current, this.allowlist);
      const hit = this.store.find(checked.url.href);
      if (!hit) {
        throw new PortError("UNAVAILABLE", `no recording for ${checked.url.href} in cassette "${this.store.name}"`, {
          url: checked.url.href,
          requestHash: requestHashOf(checked.url.href),
          noRecording: true,
          retryable: false,
        });
      }
      const { entry, body } = hit;
      const location = entry.response.headers["location"];
      if (follow && REDIRECT_STATUSES.has(entry.response.status) && location) {
        if (redirects.length >= this.maxRedirects) throw new PortError("REFUSED", `more than ${this.maxRedirects} redirects`);
        const next = new URL(location, checked.url);
        redirects.push({ from: checked.url.href, to: next.href, status: entry.response.status });
        current = next.href;
        continue;
      }
      const maxBytes = init.maxBytes;
      if (init.peekBytes === undefined && maxBytes !== undefined && body.length > maxBytes) {
        throw new PortError("REFUSED", `response is larger than the ${maxBytes}-byte cap`, { url: checked.url.href });
      }
      const truncated = init.peekBytes !== undefined && body.length > init.peekBytes;
      return {
        requestedUrl: rawUrl,
        finalUrl: checked.url.href,
        status: entry.response.status,
        headers: { ...entry.response.headers },
        body: truncated ? body.slice(0, init.peekBytes) : body,
        truncated,
        redirects,
        servedFrom: "recorded",
        recordedAt: entry.recordedAt,
        elapsedMs: Math.round(performance.now() - started),
      };
    }
  }
}

// ---------------------------------------------------------------- recording

/** Wraps a live fetcher and writes every final response it returns into a cassette. */
export class RecordingFetcher implements Fetcher {
  readonly servedFrom = "live" as const;

  constructor(
    private readonly inner: Fetcher,
    private readonly store: CassetteStore,
    private readonly options: { overwrite?: boolean; ref: string; now?: () => Date } = { ref: "recording-tool" },
  ) {}

  async get(url: string, init: FetchInit = {}): Promise<FetchResult> {
    // A recording must hold the whole body: peeking would store a truncated response as if it were complete.
    const { peekBytes: _ignored, ...rest } = init;
    const result = await this.inner.get(url, rest);
    // Key on the URL as requested, not the post-redirect URL: replay follows the same recorded chain.
    let current = result.requestedUrl;
    const now = (this.options.now ?? (() => new Date()))().toISOString();
    for (const hop of result.redirects) {
      this.store.add(
        { url: current, status: hop.status, headers: { location: hop.to }, body: new Uint8Array(0), recordedAt: now, precision: "instant", origin: { kind: "live-recording", ref: this.options.ref } },
        this.options.overwrite,
      );
      current = hop.to;
    }
    this.store.add(
      { url: current, status: result.status, headers: result.headers, body: result.body, recordedAt: now, precision: "instant", origin: { kind: "live-recording", ref: this.options.ref } },
      this.options.overwrite,
    );
    return result;
  }
}
