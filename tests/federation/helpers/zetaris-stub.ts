/**
 * A local HTTP server that speaks the Zetaris REST route as documented and observed (see src/federation/zetaris-port.ts).
 * It is a test double: it stands in for the engine so the live port's request shape, retry, timeout and
 * error-classification code run for real over a socket. It makes no claim about engine behaviour beyond what the
 * sponsor notes record, and the live-engine checks live in live.test.ts.
 */
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { ZetarisPort, type ZetarisPortConfig } from "../../../src/federation/zetaris-port.ts";

export interface StubRequest {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
  json: Record<string, unknown> | undefined;
}

export interface StubReply {
  status?: number;
  /** Serialised as JSON unless `text` is given. */
  body?: unknown;
  text?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Close the socket without answering. */
  destroy?: boolean;
}

export type StubHandler = (req: StubRequest, index: number) => StubReply | Promise<StubReply>;

export interface Stub {
  /** Base URL including /api/v1.0, the value a deployment sets as ZETARIS_REST_URL. */
  url: string;
  requests: StubRequest[];
  handler: StubHandler;
  reset(): void;
  close(): Promise<void>;
}

/** The documented success body. Values are strings or null, as on the wire. */
export function wire(headers: string[], data: (string | null)[][], total = data.length): Record<string, unknown> {
  return { headers, data, total, timeUsed: 12 };
}

export async function startStub(): Promise<Stub> {
  const requests: StubRequest[] = [];
  const stub: Stub = {
    url: "",
    requests,
    handler: () => ({ status: 500, text: "no handler set" }),
    reset() {
      requests.length = 0;
      stub.handler = () => ({ status: 500, text: "no handler set" });
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      let json: Record<string, unknown> | undefined;
      try {
        json = JSON.parse(body) as Record<string, unknown>;
      } catch {
        json = undefined;
      }
      const record: StubRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, body, json };
      const index = requests.push(record) - 1;
      const reply = await stub.handler(record, index);
      if (reply.destroy) {
        req.socket.destroy();
        return;
      }
      const send = (): void => {
        const text = reply.text ?? JSON.stringify(reply.body ?? {});
        res.writeHead(reply.status ?? 200, { "Content-Type": reply.text !== undefined ? "text/plain" : "application/json", ...reply.headers });
        res.end(text);
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stub.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1.0`;
  return stub;
}

export const KEY_DEFAULT = ["test", "default", "key", "0123456789"].join("-");
export const KEY_REVIEWER = ["test", "reviewer", "key", "9876543210"].join("-");

/** A port config pointing at the stub, with sleeping disabled and recorded so retries run instantly and are observable. */
export function portConfig(stub: Stub, over: Partial<ZetarisPortConfig> = {}): ZetarisPortConfig & { sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    restUrl: stub.url,
    orgId: "1",
    identities: { default: { apiKey: KEY_DEFAULT }, reviewer: { apiKey: KEY_REVIEWER } },
    defaultIdentity: "default",
    attemptTimeoutMs: 1_500,
    random: () => 0.5, // jitter factor 1.0, so backoff is exactly base * 2^(attempt-1)
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...over,
    sleeps,
  };
}

export function livePort(stub: Stub, over: Partial<ZetarisPortConfig> = {}): { port: ZetarisPort; sleeps: number[] } {
  const config = portConfig(stub, over);
  return { port: new ZetarisPort(config), sleeps: config.sleeps };
}
