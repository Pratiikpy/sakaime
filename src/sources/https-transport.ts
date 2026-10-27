/**
 * The real network transport: one HTTPS GET to one address the caller has already vetted.
 *
 * The address was resolved and vetted by the caller. This module connects to exactly that address, whatever
 * the hostname would resolve to now, by supplying a `lookup` that returns the pinned address. That closes the
 * DNS-rebinding window between "we checked it" and "we connected to it". The hostname is still used for the
 * TLS server name and the Host header, so certificate verification is unchanged.
 */
import https from "node:https";
import { pipeline, type Readable } from "node:stream";
import zlib from "node:zlib";

export interface TransportRequest {
  url: URL;
  /** The vetted address to connect to. */
  address: string;
  family: 4 | 6;
  headers: Record<string, string>;
  signal: AbortSignal;
  /** Extra trust anchors (PEM). Adds to, never replaces, the system store; used for private test servers. */
  extraCa?: string | string[];
}

export interface TransportResponse {
  status: number;
  /** Lower-case names, values joined with ", ", Set-Cookie dropped, content-encoding/length removed after decoding. */
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array>;
  destroy(): void;
}

export type Transport = (request: TransportRequest) => Promise<TransportResponse>;

export type TransportPhase = "connect" | "response" | "decode";

export class TransportError extends Error {
  constructor(
    message: string,
    public readonly code: string | undefined,
    public readonly phase: TransportPhase,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "TransportError";
  }
}

const SUPPORTED_ENCODINGS = new Set(["", "identity", "gzip", "x-gzip", "deflate", "br"]);

function flattenHeaders(raw: import("node:http").IncomingHttpHeaders, decoded: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    const key = name.toLowerCase();
    if (key === "set-cookie") continue;
    if (decoded && (key === "content-encoding" || key === "content-length")) continue;
    if (value === undefined) continue;
    out[key] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

export const httpsTransport: Transport = (request) =>
  new Promise<TransportResponse>((resolve, reject) => {
    const { url, address, family, headers, signal } = request;
    let phase: TransportPhase = "connect";

    const pinnedLookup = (_hostname: string, options: unknown, callback: (...args: unknown[]) => void): void => {
      if ((options as { all?: boolean } | undefined)?.all) callback(null, [{ address, family }]);
      else callback(null, address, family);
    };

    const req = https.request(
      {
        protocol: "https:",
        host: url.hostname,
        servername: url.hostname,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        method: "GET",
        headers: { ...headers, Host: url.host },
        lookup: pinnedLookup as never,
        // A private agent per request: no connection reuse, so no socket can outlive its address check.
        agent: false,
        minVersion: "TLSv1.2",
        ...(request.extraCa ? { ca: request.extraCa } : {}),
        signal,
      },
      (res) => {
        phase = "response";
        const encoding = String(res.headers["content-encoding"] ?? "").toLowerCase().trim();
        if (!SUPPORTED_ENCODINGS.has(encoding)) {
          res.destroy();
          reject(new TransportError(`unsupported content-encoding "${encoding}"`, undefined, "decode"));
          return;
        }
        let stream: Readable = res;
        const decoded = encoding !== "" && encoding !== "identity";
        if (decoded) {
          const decoder = encoding === "br" ? zlib.createBrotliDecompress() : encoding === "deflate" ? zlib.createInflate() : zlib.createGunzip();
          stream = pipeline(res, decoder, () => undefined) as unknown as Readable;
        }
        resolve({
          status: res.statusCode ?? 0,
          headers: flattenHeaders(res.headers, decoded),
          body: stream as AsyncIterable<Uint8Array>,
          destroy: () => {
            stream.destroy();
            res.destroy();
            req.destroy();
          },
        });
      },
    );
    req.once("socket", (socket) => {
      socket.once("secureConnect", () => {
        phase = "response";
      });
    });
    // `on`, not `once`: after the response has been handed over, a late socket error must not become an
    // unhandled 'error' event. The body stream reports its own failure to whoever is reading it.
    req.on("error", (err: NodeJS.ErrnoException) => {
      reject(new TransportError(err.message, err.code, phase, { cause: err }));
    });
    req.end();
  });
