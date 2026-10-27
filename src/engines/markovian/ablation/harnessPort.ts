/**
 * A minimal chat-completions ModelPort for the MA-3 measurement only.
 *
 * The product's own client (src/models) enforces the 32 KB prompt rule, the egress policy and the role map, which
 * is right for the product and wrong for an ablation whose full-context arm exists to show what a prompt over
 * that limit does. This port sends exactly what it is given, to one named model, so all arms are treated alike.
 * It is not used anywhere in the product. Constructed documents only: it carries no data class check.
 *
 * Failure classes follow src/ports: 429, 5xx, timeouts and transport errors are UNAVAILABLE; 401 and 403 are
 * FORBIDDEN; any other 4xx (including an over-long context) is BLOCKED and is not retried by callers.
 */
import { PortError, type ModelPort, type ModelRequest, type ModelResponse } from "../../../ports/index.ts";

export interface HarnessPortOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs?: number;
  /** Minimum gap between requests, to stay inside the free tier's rate limit. */
  minGapMs?: number;
  fetchImpl?: typeof fetch;
}

interface ChatBody {
  model?: string;
  choices?: { message?: { content?: string | null }; finish_reason?: string }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

export class HarnessChatPort implements ModelPort {
  private last = 0;
  readonly requests: { status: number; ms: number; promptBytes: number }[] = [];
  constructor(private readonly o: HarnessPortOptions) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const wait = this.last + (this.o.minGapMs ?? 0) - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.last = Date.now();
    const f = this.o.fetchImpl ?? fetch;
    const t0 = Date.now();
    const promptBytes = Buffer.byteLength(req.system, "utf8") + Buffer.byteLength(req.user, "utf8");
    let res: Response;
    try {
      res = await f(`${this.o.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model: this.o.model,
          messages: [
            { role: "system", content: req.system },
            { role: "user", content: req.user },
          ],
          max_tokens: req.maxTokens ?? 1600,
          temperature: 0,
          chat_template_kwargs: { enable_thinking: false },
        }),
        signal: AbortSignal.timeout(req.timeoutMs ?? this.o.timeoutMs ?? 180_000),
      });
    } catch (err) {
      this.requests.push({ status: 0, ms: Date.now() - t0, promptBytes });
      throw new PortError("UNAVAILABLE", `transport error: ${(err as Error).name}`, { promptBytes });
    }
    this.requests.push({ status: res.status, ms: Date.now() - t0, promptBytes });
    if (res.status === 401 || res.status === 403) throw new PortError("FORBIDDEN", `HTTP ${res.status}`);
    if (res.status === 429 || res.status >= 500) throw new PortError("UNAVAILABLE", `HTTP ${res.status}`, { promptBytes });
    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      throw new PortError("BLOCKED", `HTTP ${res.status}`, { promptBytes, detail });
    }
    let body: ChatBody;
    try {
      body = (await res.json()) as ChatBody;
    } catch {
      throw new PortError("UNAVAILABLE", "the response body was not JSON", { promptBytes });
    }
    const choice = body.choices?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string" || text.length === 0) throw new PortError("INVALID", "the reply had no content", { finish: choice?.finish_reason });
    const p = body.usage?.prompt_tokens;
    const c = body.usage?.completion_tokens;
    const measured = typeof p === "number" && typeof c === "number";
    return {
      text,
      requestedModel: this.o.model,
      routedModel: body.model ?? this.o.model,
      provider: "nvidia",
      usage: measured ? { promptTokens: p, completionTokens: c, measured: true } : { measured: false },
      recorded: false,
    };
  }
}
