/**
 * The seam between connectors and the network. A connector asks a Fetcher for a URL and gets bytes and a status;
 * it neither knows nor cares whether they came from a live socket (SafeFetcher), from a recording
 * (CassetteFetcher) or from a recording wrapper. Everything that interprets a response, including the
 * empty / unavailable / drifted decision, runs identically in every mode.
 */

export type ServedFrom = "live" | "recorded";

export interface FetchInit {
  /** Only a short list of non-credential headers is accepted (see ALLOWED_REQUEST_HEADERS in safe-fetch.ts). */
  headers?: Record<string, string>;
  /** Hard cap on response body bytes after content decoding. Exceeding it is a REFUSED failure. */
  maxBytes?: number;
  /** Total wall-clock cap including DNS, connect, TLS, redirects and body. */
  timeoutMs?: number;
  /** "manual" returns a 3xx response as is instead of following it. */
  redirect?: "follow" | "manual";
  /**
   * Read at most this many body bytes, then close the connection and return what was read with
   * `truncated: true`. Used by `check()` to look at the first bytes of a large document without downloading it.
   */
  peekBytes?: number;
}

export interface RedirectHop {
  from: string;
  to: string;
  status: number;
}

export interface FetchResult {
  requestedUrl: string;
  /** The URL that produced the response after any redirects. */
  finalUrl: string;
  status: number;
  /** Lower-case header names. Set-Cookie is never kept. */
  headers: Record<string, string>;
  body: Uint8Array;
  /** True only when `peekBytes` stopped the read early. */
  truncated: boolean;
  redirects: RedirectHop[];
  servedFrom: ServedFrom;
  /** For recorded responses: when the original response was captured. */
  recordedAt?: string;
  /** For live responses: the address the socket was pinned to. */
  resolvedAddress?: string;
  elapsedMs: number;
}

export interface Fetcher {
  readonly servedFrom: ServedFrom;
  get(url: string, init?: FetchInit): Promise<FetchResult>;
}

export const textOf = (bytes: Uint8Array): string => new TextDecoder("utf-8", { fatal: false }).decode(bytes);
