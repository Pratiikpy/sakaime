import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * TEST DOUBLE. A local HTTP server that speaks enough of the OpenAI-compatible chat API for the model clients to be
 * exercised over a real socket: models list, chat completions, programmable status codes, delays, hangs and redirects.
 * It lives in tests/ and is never imported by src/.
 */

export interface RecordedRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  raw: string;
  body: Record<string, unknown>;
}

export interface ServerReply {
  status?: number;
  body?: unknown;
  rawBody?: string;
  headers?: Record<string, string>;
  delayMs?: number;
  /** Never answer; the connection stays open until the server stops. */
  hang?: boolean;
}

export type Behaviour = (req: RecordedRequest, n: number) => ServerReply | Promise<ServerReply>;

export function completion(opts: {
  content: string | null;
  model?: string;
  id?: string;
  finish?: string;
  usage?: Record<string, unknown> | null;
  reasoning?: string | null;
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    id: opts.id ?? `chatcmpl-${Math.random().toString(16).slice(2)}`,
    object: "chat.completion",
    created: 1793000000,
    model: opts.model ?? "test-model",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: opts.content, ...(opts.reasoning !== undefined ? { reasoning_content: opts.reasoning } : {}) },
        finish_reason: opts.finish ?? "stop",
      },
    ],
    ...(opts.usage === null ? {} : { usage: opts.usage ?? { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }),
    ...(opts.extra ?? {}),
  };
}

export class TestChatServer {
  readonly requests: RecordedRequest[] = [];
  models: string[] = [];
  modelsStatus = 200;
  chat: Behaviour = () => ({ body: completion({ content: "ok" }) });
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();
  private chatCount = 0;

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", async () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let body: Record<string, unknown> = {};
        try {
          body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        } catch {
          /* leave empty */
        }
        const recorded: RecordedRequest = { method: req.method ?? "", url: req.url ?? "", headers: req.headers, raw, body };
        this.requests.push(recorded);
        let reply: ServerReply;
        if (req.method === "GET" && recorded.url.endsWith("/models")) {
          reply = this.modelsStatus === 200 ? { body: { object: "list", data: this.models.map((id) => ({ id, object: "model" })) } } : { status: this.modelsStatus, body: { error: "nope" } };
        } else if (req.method === "POST" && recorded.url.endsWith("/chat/completions")) {
          this.chatCount += 1;
          reply = await this.chat(recorded, this.chatCount);
        } else {
          reply = { status: 404, body: { error: { message: "not_found" } } };
        }
        if (reply.hang) return; // leave the socket open
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        res.statusCode = reply.status ?? 200;
        for (const [k, v] of Object.entries(reply.headers ?? {})) res.setHeader(k, v);
        if (reply.rawBody !== undefined) {
          res.end(reply.rawBody);
        } else {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify(reply.body ?? {}));
        }
      });
    });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    return this;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}/v1`;
  }

  get chatRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.method === "POST");
  }

  reset(): void {
    this.requests.length = 0;
    this.chatCount = 0;
    this.chat = () => ({ body: completion({ content: "ok" }) });
  }

  async stop(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
  }
}
