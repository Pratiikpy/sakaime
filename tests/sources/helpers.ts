/**
 * Test doubles for the source layer. Everything here is a named double: it stands in for the network so the
 * safe fetcher's own logic can be exercised, and none of it is imported from src/.
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import https from "node:https";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { CassetteStore } from "../../src/sources/cassette.ts";
import { PortError } from "../../src/ports/index.ts";
import type { Fetcher, FetchInit, FetchResult } from "../../src/sources/fetcher.ts";
import { HostAllowlist, type AllowedHost, type Resolver, type ResolvedAddress } from "../../src/sources/safe-fetch.ts";
import type { Transport, TransportRequest, TransportResponse } from "../../src/sources/https-transport.ts";

export const PUBLIC_IP = "93.184.216.34";

export const allowlistOf = (...hosts: Array<string | AllowedHost>): HostAllowlist =>
  new HostAllowlist(hosts.map((h) => (typeof h === "string" ? { host: h, grantedBy: "test" } : h)));

export interface ResolverDouble {
  resolver: Resolver;
  calls: string[];
}

/** A resolver that answers from a table, or from a function (for rebinding simulations). */
export function resolverDouble(answer: Record<string, ResolvedAddress[]> | ((host: string, call: number) => ResolvedAddress[])): ResolverDouble {
  const calls: string[] = [];
  const resolver: Resolver = async (host) => {
    calls.push(host);
    if (typeof answer === "function") return answer(host, calls.length);
    const hit = answer[host];
    if (!hit) {
      const err = new Error(`getaddrinfo ENOTFOUND ${host}`) as NodeJS.ErrnoException;
      err.code = "ENOTFOUND";
      throw err;
    }
    return hit;
  };
  return { resolver, calls };
}

export const pub = (address = PUBLIC_IP): ResolvedAddress => ({ address, family: address.includes(":") ? 6 : 4 });

export type ScriptedChunk = string | Uint8Array | { delayMs: number; data?: string | Uint8Array };

export interface ScriptedResponse {
  status?: number;
  headers?: Record<string, string>;
  chunks?: ScriptedChunk[];
  /** Never resolve the response (a server that accepts and then says nothing). */
  hang?: boolean;
  /** Reject the transport call instead of answering. */
  fail?: Error;
}

export interface TransportDouble {
  transport: Transport;
  calls: TransportRequest[];
  destroyed: number;
}

const bytesOf = (data: string | Uint8Array): Uint8Array => (typeof data === "string" ? new TextEncoder().encode(data) : data);

export function scriptedTransport(script: (request: TransportRequest, callIndex: number) => ScriptedResponse): TransportDouble {
  const state: TransportDouble = { transport: undefined as never, calls: [], destroyed: 0 };
  state.transport = async (request) => {
    const index = state.calls.length;
    state.calls.push(request);
    const scripted = script(request, index);
    if (scripted.fail) throw scripted.fail;
    if (scripted.hang) {
      return new Promise<TransportResponse>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    }
    let stopped = false;
    async function* body(): AsyncGenerator<Uint8Array> {
      for (const chunk of scripted.chunks ?? []) {
        if (stopped) return;
        if (typeof chunk === "object" && "delayMs" in chunk) {
          await new Promise((r) => setTimeout(r, chunk.delayMs));
          if (stopped) return;
          if (chunk.data !== undefined) yield bytesOf(chunk.data);
        } else {
          yield bytesOf(chunk);
        }
      }
    }
    return {
      status: scripted.status ?? 200,
      headers: scripted.headers ?? {},
      body: body(),
      destroy: () => {
        stopped = true;
        state.destroyed++;
      },
    };
  };
  return state;
}

// ---------------------------------------------------------------- local TLS server (requires openssl)

export interface TlsFixture {
  cert: string;
  key: string;
  dir: string;
}

let cachedFixture: TlsFixture | null | undefined;

/** Generates a throwaway certificate for `pinned.test` at test time. Nothing secret is committed. Null if openssl is absent. */
export function tlsFixture(): TlsFixture | null {
  if (cachedFixture !== undefined) return cachedFixture;
  try {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sakaime-tls-"));
    execFileSync(
      "openssl",
      [
        "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2",
        "-keyout", path.join(dir, "key.pem"), "-out", path.join(dir, "cert.pem"),
        "-subj", "/CN=pinned.test", "-addext", "subjectAltName=DNS:pinned.test",
      ],
      { stdio: "ignore" },
    );
    cachedFixture = { cert: fs.readFileSync(path.join(dir, "cert.pem"), "utf8"), key: fs.readFileSync(path.join(dir, "key.pem"), "utf8"), dir };
  } catch {
    cachedFixture = null;
  }
  return cachedFixture;
}

export interface TlsServer {
  port: number;
  connections: number;
  requests: Array<{ url: string; headers: Record<string, string | string[] | undefined> }>;
  close(): Promise<void>;
}

export async function startTlsServer(fixture: TlsFixture): Promise<TlsServer> {
  const state = { connections: 0, requests: [] as TlsServer["requests"] };
  const server = https.createServer({ key: fixture.key, cert: fixture.cert }, (req, res) => {
    state.requests.push({ url: req.url ?? "", headers: req.headers });
    const url = new URL(req.url ?? "/", "https://pinned.test");
    switch (url.pathname) {
      case "/ok":
        res.writeHead(200, { "content-type": "application/json", "set-cookie": "session=abc; Path=/" });
        res.end(JSON.stringify({ ok: true }));
        return;
      case "/echo":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(req.headers));
        return;
      case "/gzip":
        res.writeHead(200, { "content-encoding": "gzip", "content-type": "text/plain" });
        res.end(zlib.gzipSync("hello gzip"));
        return;
      case "/br":
        res.writeHead(200, { "content-encoding": "br", "content-type": "text/plain" });
        res.end(zlib.brotliCompressSync("hello brotli"));
        return;
      case "/bomb": {
        // 20 MB of zeros compresses to a few KB: the cap must apply to the decoded size.
        res.writeHead(200, { "content-encoding": "gzip" });
        res.end(zlib.gzipSync(Buffer.alloc(20 * 1024 * 1024)));
        return;
      }
      case "/big": {
        res.writeHead(200, { "content-type": "application/octet-stream" });
        const chunk = Buffer.alloc(64 * 1024, 97);
        let sent = 0;
        const pump = () => {
          while (sent < 6 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) {
              res.once("drain", pump);
              return;
            }
          }
          res.end();
        };
        pump();
        return;
      }
      case "/stall":
        res.writeHead(200, { "content-type": "text/plain" });
        res.write("first");
        return; // never ends
      case "/trickle": {
        res.writeHead(200, { "content-type": "text/plain" });
        const timer = setInterval(() => res.write("x"), 30);
        res.on("close", () => clearInterval(timer));
        return;
      }
      case "/silent":
        return; // accepts the request and never answers
      case "/redirect-ok":
        res.writeHead(302, { location: "/ok" });
        res.end();
        return;
      default:
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("nope");
    }
  });
  server.on("secureConnection", () => {
    state.connections++;
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    get connections() {
      return state.connections;
    },
    requests: state.requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------- recorded responses

export const CASSETTE_DIR = fileURLToPath(new URL("../../data/cassettes/public-evidence-2026-10-27", import.meta.url));

let cachedStore: CassetteStore | undefined;
export const cassette = (): CassetteStore => (cachedStore ??= CassetteStore.load(CASSETTE_DIR));

export interface Recorded {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
  text: string;
}

/** A response recorded in the cassette, by the exact URL it was requested with. Throws if there is none. */
export function recorded(url: string): Recorded {
  const hit = cassette().find(url);
  if (!hit) throw new Error(`no recording for ${url}`);
  return { status: hit.entry.response.status, headers: hit.entry.response.headers, body: hit.body, text: new TextDecoder().decode(hit.body) };
}

// ---------------------------------------------------------------- fetcher doubles for the connector tests

export interface FetchCall {
  url: string;
  init?: FetchInit;
}

export interface LiveDouble extends Fetcher {
  calls: FetchCall[];
}

export type Answer = { status: number; headers?: Record<string, string>; body: string | Uint8Array } | Error;

const bytes = (b: string | Uint8Array): Uint8Array => (typeof b === "string" ? new TextEncoder().encode(b) : b);

/**
 * A fetcher that claims to be live (so the request budget applies) and answers from a function. Used to make an
 * outage, a 429 or a changed response shape happen on demand; the bodies it returns are either recorded or
 * written inline and named as constructed in the test that uses them.
 */
export function liveDouble(answer: (url: string, call: number, init?: FetchInit) => Answer): LiveDouble {
  const calls: FetchCall[] = [];
  return {
    servedFrom: "live",
    calls,
    async get(url, init) {
      calls.push({ url, init });
      const a = answer(url, calls.length, init);
      if (a instanceof Error) throw a;
      const body = bytes(a.body);
      return {
        requestedUrl: url,
        finalUrl: url,
        status: a.status,
        headers: { ...(a.headers ?? {}) },
        body: init?.peekBytes !== undefined ? body.slice(0, init.peekBytes) : body,
        truncated: init?.peekBytes !== undefined && body.length > init.peekBytes,
        redirects: [],
        servedFrom: "live",
        elapsedMs: 1,
      } satisfies FetchResult;
    },
  };
}

/** Answers with the recorded response for the URL, optionally rewritten by `edit` (for drift cases). */
export function liveFromCassette(edit?: (url: string, r: Recorded) => Recorded | Error | undefined): LiveDouble {
  return liveDouble((url) => {
    const r = recorded(url);
    const edited = edit?.(url, r);
    if (edited instanceof Error) return edited;
    const used = edited ?? r;
    return { status: used.status, headers: used.headers, body: used.body };
  });
}

export const unavailable = (message = "connect ETIMEDOUT"): PortError => new PortError("UNAVAILABLE", message, { retryable: true });

export const noSleep = async (): Promise<void> => undefined;
