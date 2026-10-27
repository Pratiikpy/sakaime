/**
 * SSRF-safe HTTP GET (requirement C-03).
 *
 * A pasted or discovered URL is untrusted input. This fetcher is the only door through which the product
 * reaches the network for source data, and it applies the same rules to the first request and to every
 * redirect hop:
 *
 *   1. https only, method GET only, no credentials in the URL, no IP-literal host, port 443 unless a card says
 *      otherwise;
 *   2. the host (and, where the card says so, the path prefix) must be on the allowlist built from source
 *      cards. Anything else is REFUSED with a reason a reviewer can read;
 *   3. DNS is resolved here, and the request is refused if ANY returned address is private, loopback,
 *      link-local, unique-local, multicast, unspecified, carrier-grade NAT, reserved or a cloud metadata address;
 *   4. the socket is pinned to a vetted address, so a second DNS answer cannot redirect the connection;
 *   5. redirects are followed by hand, never more than `maxRedirects`, each hop going through 1 to 4 again;
 *   6. the body is read as a stream with a byte cap and an idle cap, and the whole call has a total time cap;
 *   7. no cookies, authorization or API-key headers are accepted from callers or kept from responses.
 */
import { PortError } from "../ports/index.ts";
import { vetAddress, isIpLiteralHost } from "./address.ts";
import type { FetchInit, FetchResult, Fetcher, RedirectHop } from "./fetcher.ts";
import { httpsTransport, TransportError, type Transport, type TransportResponse } from "./https-transport.ts";
import { lookup as dnsLookup } from "node:dns/promises";

// ---------------------------------------------------------------- allowlist

export interface AllowedHost {
  /** Lower-case DNS name, exact match. No wildcards: a new subdomain is a new decision. */
  host: string;
  /** Defaults to [443]. */
  ports?: number[];
  /** If present, the request path must start with one of these. */
  pathPrefixes?: string[];
  /** Which card granted this entry, for the refusal message and the audit trail. */
  grantedBy?: string;
}

export type AllowDecision = { ok: true; entry: AllowedHost } | { ok: false; reason: string };

export class HostAllowlist {
  private readonly byHost = new Map<string, AllowedHost[]>();

  constructor(entries: AllowedHost[]) {
    for (const entry of entries) {
      const host = entry.host.toLowerCase();
      if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
        throw new TypeError(`allowlist host "${entry.host}" is not a plain DNS name`);
      }
      const list = this.byHost.get(host) ?? [];
      list.push({ ...entry, host });
      this.byHost.set(host, list);
    }
  }

  hosts(): string[] {
    return [...this.byHost.keys()].sort();
  }

  check(host: string, port: number, pathname: string): AllowDecision {
    const entries = this.byHost.get(host);
    if (!entries) return { ok: false, reason: `host "${host}" is not on the source allowlist` };
    const portMatches = entries.filter((e) => (e.ports ?? [443]).includes(port));
    if (portMatches.length === 0) return { ok: false, reason: `port ${port} is not allowed for host "${host}"` };
    for (const entry of portMatches) {
      if (!entry.pathPrefixes || entry.pathPrefixes.some((p) => pathname.startsWith(p))) return { ok: true, entry };
    }
    return { ok: false, reason: `path "${pathname}" is outside the allowed path prefixes for host "${host}"` };
  }
}

// ---------------------------------------------------------------- URL validation

const MAX_URL_LENGTH = 2048;

export interface ValidatedUrl {
  url: URL;
  host: string;
  port: number;
  grantedBy?: string;
}

/** Parse and judge a URL before any DNS or network activity. Throws PortError REFUSED or INVALID. */
export function validateUrl(raw: string, allowlist: HostAllowlist): ValidatedUrl {
  if (typeof raw !== "string" || raw.length === 0) throw new PortError("INVALID", "URL is empty");
  if (raw.length > MAX_URL_LENGTH) throw new PortError("REFUSED", `URL is longer than ${MAX_URL_LENGTH} characters`);
  // The WHATWG parser silently drops tabs and newlines; refuse them so the text we judged is the text we send.
  if (/[\u0000- \u007f]/.test(raw)) throw new PortError("REFUSED", "URL contains whitespace or control characters");

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new PortError("INVALID", "URL could not be parsed", { url: raw.slice(0, 200) });
  }
  if (url.protocol !== "https:") {
    throw new PortError("REFUSED", `only https is allowed; got "${url.protocol.replace(":", "")}"`, { url: raw.slice(0, 200) });
  }
  if (url.username !== "" || url.password !== "") {
    throw new PortError("REFUSED", "URLs with embedded credentials (user:password@host) are refused");
  }
  if (url.hostname === "") throw new PortError("INVALID", "URL has no host");
  if (isIpLiteralHost(url.hostname)) {
    throw new PortError("REFUSED", `IP-literal hosts are refused (host resolves to the literal "${url.hostname}"); use a registered source host`);
  }
  // "api.fda.gov." and "api.fda.gov" are the same host; normalise so the allowlist, SNI and Host header agree.
  const host = url.hostname.endsWith(".") ? url.hostname.slice(0, -1) : url.hostname;
  const port = url.port === "" ? 443 : Number(url.port);

  const decision = allowlist.check(host, port, url.pathname);
  if (!decision.ok) throw new PortError("REFUSED", decision.reason, { url: raw.slice(0, 200), allowlisted: allowlist.hosts() });

  const clean = new URL(url.href);
  clean.hostname = host;
  clean.hash = "";
  return { url: clean, host, port, grantedBy: decision.entry.grantedBy };
}

// ---------------------------------------------------------------- DNS

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export const systemResolver: Resolver = async (hostname) => {
  const records = await dnsLookup(hostname, { all: true, verbatim: true });
  return records.map((r) => ({ address: r.address, family: r.family === 6 ? 6 : 4 }));
};

/** Every returned address must pass. One private answer among public ones is still a refusal. */
export function vetResolution(host: string, resolved: ResolvedAddress[]): ResolvedAddress[] {
  if (resolved.length === 0) throw new PortError("UNAVAILABLE", `DNS returned no addresses for "${host}"`, { host, retryable: true });
  for (const entry of resolved) {
    const verdict = vetAddress(entry.address);
    if (!verdict.allowed) {
      throw new PortError("REFUSED", `"${host}" resolves to a blocked address: ${verdict.reason}`, {
        host,
        address: entry.address,
        category: verdict.category,
      });
    }
  }
  return resolved;
}

// ---------------------------------------------------------------- fetcher

/** Headers a caller may set. Credential-bearing headers are deliberately absent. */
export const ALLOWED_REQUEST_HEADERS = new Set(["accept", "accept-language", "range"]);

/**
 * Identifies the client without a URL: on 2026-10-27 www.accessdata.fda.gov redirected a request whose User-Agent
 * contained a link to the abuse-detection page, and served the same request with "sakaime-evidence-reader/0.1".
 */
export const DEFAULT_USER_AGENT = "sakaime-evidence-reader/0.1 (read-only)";

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export interface SafeFetcherOptions {
  allowlist: HostAllowlist;
  resolver?: Resolver;
  transport?: Transport;
  /** PEM trust anchors added to the system store. For private test servers only. */
  extraCa?: string | string[];
  userAgent?: string;
  maxBytes?: number;
  timeoutMs?: number;
  /** Abort if no body bytes arrive for this long. */
  idleTimeoutMs?: number;
  maxRedirects?: number;
}

const TLS_ERROR_CODES = new Set([
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_WRONG_VERSION_NUMBER",
  "ERR_SSL_PROTOCOL_VERSION",
]);

class Deadline extends Error {
  constructor(public readonly ms: number) {
    super(`deadline of ${ms} ms exceeded`);
  }
}

export class SafeFetcher implements Fetcher {
  readonly servedFrom = "live" as const;
  private readonly opts: Required<Omit<SafeFetcherOptions, "extraCa">> & { extraCa?: string | string[] };

  constructor(options: SafeFetcherOptions) {
    this.opts = {
      allowlist: options.allowlist,
      resolver: options.resolver ?? systemResolver,
      transport: options.transport ?? httpsTransport,
      extraCa: options.extraCa,
      userAgent: options.userAgent ?? DEFAULT_USER_AGENT,
      maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
      timeoutMs: options.timeoutMs ?? 30_000,
      idleTimeoutMs: options.idleTimeoutMs ?? 10_000,
      maxRedirects: options.maxRedirects ?? 5,
    };
  }

  async get(rawUrl: string, init: FetchInit = {}): Promise<FetchResult> {
    const started = performance.now();
    const timeoutMs = init.timeoutMs ?? this.opts.timeoutMs;
    const maxBytes = init.maxBytes ?? this.opts.maxBytes;
    const follow = (init.redirect ?? "follow") === "follow";
    const headers = this.requestHeaders(init.headers);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Deadline(timeoutMs)), timeoutMs);
    const redirects: RedirectHop[] = [];
    const visited = new Set<string>();
    let current = rawUrl;

    try {
      for (;;) {
        let checked: ValidatedUrl;
        try {
          checked = validateUrl(current, this.opts.allowlist);
        } catch (err) {
          if (err instanceof PortError && redirects.length > 0) {
            const last = redirects[redirects.length - 1]!;
            throw new PortError(err.failure, `redirect from ${last.from} was refused: ${err.message}`, { ...err.detail, redirectedFrom: last.from, hop: redirects.length });
          }
          throw err;
        }
        if (visited.has(checked.url.href)) throw new PortError("REFUSED", "redirect loop detected", { url: checked.url.href });
        visited.add(checked.url.href);

        const resolved = vetResolution(checked.host, await this.resolve(checked.host, controller.signal));
        const { response, address } = await this.connect(checked, resolved, headers, controller.signal);

        if (follow && REDIRECT_STATUSES.has(response.status) && response.headers["location"]) {
          response.destroy();
          if (redirects.length >= this.opts.maxRedirects) {
            throw new PortError("REFUSED", `more than ${this.opts.maxRedirects} redirects`, { url: checked.url.href });
          }
          let next: URL;
          try {
            next = new URL(response.headers["location"]!, checked.url);
          } catch {
            throw new PortError("INVALID", "redirect Location header could not be parsed", { location: response.headers["location"]!.slice(0, 200) });
          }
          redirects.push({ from: checked.url.href, to: next.href, status: response.status });
          current = next.href; // checked at the top of the loop, exactly like the first URL
          continue;
        }

        const { bytes, truncated } = await this.readBody(response, {
          maxBytes,
          peekBytes: init.peekBytes,
          idleMs: this.opts.idleTimeoutMs,
          signal: controller.signal,
          url: checked.url.href,
        });
        return {
          requestedUrl: rawUrl,
          finalUrl: checked.url.href,
          status: response.status,
          headers: withoutCookies(response.headers),
          body: bytes,
          truncated,
          redirects,
          servedFrom: "live",
          resolvedAddress: address,
          elapsedMs: Math.round(performance.now() - started),
        };
      }
    } catch (err) {
      throw this.toPortError(err, rawUrl, controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  private requestHeaders(custom: Record<string, string> | undefined): Record<string, string> {
    const out: Record<string, string> = {
      "user-agent": this.opts.userAgent,
      accept: "*/*",
      "accept-encoding": "gzip, deflate, br",
    };
    for (const [name, value] of Object.entries(custom ?? {})) {
      const key = name.toLowerCase();
      if (!ALLOWED_REQUEST_HEADERS.has(key)) {
        throw new PortError("REFUSED", `request header "${name}" is not permitted; credentials and cookies are never forwarded`);
      }
      if (/[\r\n]/.test(value)) throw new PortError("REFUSED", `request header "${name}" contains a line break`);
      out[key] = value;
    }
    return out;
  }

  private async resolve(host: string, signal: AbortSignal): Promise<ResolvedAddress[]> {
    return raceAbort(this.opts.resolver(host), signal);
  }

  /** Try each vetted address in turn, moving on only when the connection itself could not be made. */
  private async connect(
    checked: ValidatedUrl,
    addresses: ResolvedAddress[],
    headers: Record<string, string>,
    signal: AbortSignal,
  ): Promise<{ response: TransportResponse; address: string }> {
    let lastError: unknown;
    for (const candidate of addresses) {
      try {
        const response = await raceAbort(
          this.opts.transport({
            url: checked.url,
            address: candidate.address,
            family: candidate.family,
            headers,
            signal,
            extraCa: this.opts.extraCa,
          }),
          signal,
        );
        return { response, address: candidate.address };
      } catch (err) {
        lastError = err;
        if (err instanceof TransportError && err.phase === "connect" && !signal.aborted) continue;
        throw err;
      }
    }
    throw lastError;
  }

  private async readBody(
    response: TransportResponse,
    limits: { maxBytes: number; peekBytes?: number; idleMs: number; signal: AbortSignal; url: string },
  ): Promise<{ bytes: Uint8Array; truncated: boolean }> {
    const declared = Number(response.headers["content-length"]);
    if (limits.peekBytes === undefined && Number.isFinite(declared) && declared > limits.maxBytes) {
      response.destroy();
      throw new PortError("REFUSED", `response declares ${declared} bytes, over the ${limits.maxBytes}-byte cap`, { url: limits.url });
    }

    const chunks: Uint8Array[] = [];
    let total = 0;
    let truncated = false;
    const iterator = response.body[Symbol.asyncIterator]();
    try {
      for (;;) {
        const next = await raceAbort(withIdleTimeout(iterator.next(), limits.idleMs), limits.signal);
        if (next.done) break;
        const chunk = next.value;
        if (limits.peekBytes !== undefined) {
          const room = limits.peekBytes - total;
          if (chunk.length >= room) {
            chunks.push(chunk.subarray(0, room));
            total += room;
            truncated = true;
            break;
          }
        } else if (total + chunk.length > limits.maxBytes) {
          throw new PortError("REFUSED", `response is larger than the ${limits.maxBytes}-byte cap`, { url: limits.url, readBytes: total + chunk.length });
        }
        chunks.push(chunk);
        total += chunk.length;
      }
    } finally {
      // Always close: on a cap hit, a timeout or a peek this stops the transfer rather than draining it.
      response.destroy();
    }
    return { bytes: concat(chunks, total), truncated };
  }

  private toPortError(err: unknown, url: string, signal: AbortSignal): PortError {
    if (err instanceof PortError) return err;
    if (signal.aborted && signal.reason instanceof Deadline) {
      return new PortError("UNAVAILABLE", `timed out after ${signal.reason.ms} ms`, { url, timeout: true, retryable: true });
    }
    if (err instanceof IdleTimeout) {
      return new PortError("UNAVAILABLE", `no data for ${err.ms} ms; connection abandoned`, { url, timeout: true, retryable: true });
    }
    if (err instanceof TransportError) {
      const tls = err.code !== undefined && TLS_ERROR_CODES.has(err.code);
      return new PortError("UNAVAILABLE", tls ? `TLS verification failed: ${err.message}` : `network error: ${err.message}`, {
        url,
        code: err.code,
        phase: err.phase,
        tls,
        retryable: !tls && err.phase !== "decode",
      });
    }
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    const message = err instanceof Error ? err.message : String(err);
    return new PortError("UNAVAILABLE", `network error: ${message}`, { url, code, retryable: true });
  }
}

class IdleTimeout extends Error {
  constructor(public readonly ms: number) {
    super(`idle for ${ms} ms`);
  }
}

function withIdleTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new IdleTimeout(ms)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function withoutCookies(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (key !== "set-cookie" && key !== "set-cookie2") out[key] = value;
  }
  return out;
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
