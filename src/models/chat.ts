import { PortError } from "../ports/index.ts";
import type { TraceSink } from "./trace.ts";

/**
 * One OpenAI-compatible chat endpoint (NVIDIA's API or a Nightshift URL) reached over HTTP, with the failure handling
 * both need: a timeout per attempt, a cap on attempts, capped exponential backoff with jitter on 429 and 5xx, a total
 * deadline, a concurrency limit, and cancellation. It knows nothing about roles, receipts or schemas.
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatSpec {
  model: string;
  messages: ChatMessage[];
  maxTokens: number;
  temperature: number;
  /** Reasoning on or off. Off by default: reasoning counts against max_tokens and made a 32-token call return no content. */
  thinking: boolean;
  /** Ask the endpoint for a JSON object. The reply is still validated by the caller. */
  jsonObject: boolean;
}

export interface ChatUsage {
  promptTokens?: number;
  completionTokens?: number;
  reasoningTokens?: number;
}

export interface ChatReply {
  status: number;
  id?: string;
  model?: string;
  content: string;
  finishReason?: string;
  usage?: ChatUsage;
  /** The parsed body, for provider-specific fields such as Nightshift's `meterless` object. */
  body: Record<string, unknown>;
  latencyMs: number;
  attempts: number;
  /** The exact request body that produced this reply; it is what the request hash is taken over. */
  requestJson: string;
}

export interface TransportOptions {
  provider: string;
  baseUrl: string;
  apiKey: string;
  trace: TraceSink;
  fetchImpl?: typeof fetch;
  /** Waits `ms`, rejecting early if `signal` aborts. Injected so tests do not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  maxAttempts?: number;
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** Time allowed for all attempts of one call, backoff included. */
  deadlineMs?: number;
  /** Time allowed for one attempt unless the request names its own. */
  timeoutMs?: number;
  maxConcurrent?: number;
  /** Permit plain http to a non-loopback host (a private network). Off by default. */
  allowInsecureHttp?: boolean;
}

export interface ChatContext {
  role: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Headers for attempt n (1-based). Nightshift gets a distinct memory scope per attempt. */
  headers?: (attempt: number) => Record<string, string>;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

export function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase());
}

export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

class Limiter {
  private active = 0;
  private readonly waiting: (() => void)[] = [];
  constructor(private readonly max: number) {}

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve, reject) => {
        const entry = (): void => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          const i = this.waiting.indexOf(entry);
          if (i >= 0) this.waiting.splice(i, 1);
          reject(signal?.reason);
        };
        if (signal?.aborted) return reject(signal.reason);
        signal?.addEventListener("abort", onAbort, { once: true });
        this.waiting.push(entry);
      });
    }
    this.active += 1;
    try {
      return await fn();
    } finally {
      this.active -= 1;
      this.waiting.shift()?.();
    }
  }
}

function cancelled(): PortError {
  return new PortError("UNAVAILABLE", "the call was cancelled by the caller", { cancelled: true });
}

export class ChatTransport {
  private readonly base: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: Limiter;

  constructor(private readonly opts: TransportOptions) {
    let url: URL;
    try {
      url = new URL(opts.baseUrl);
    } catch {
      throw new PortError("INVALID", `${opts.provider}: the base URL is not a URL`);
    }
    const loopback = isLoopbackHost(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && (loopback || opts.allowInsecureHttp))) {
      throw new PortError("REFUSED", `${opts.provider}: ${url.protocol}//${url.hostname} is refused. A bearer key is only sent over https, or over http to a loopback address.`);
    }
    if (url.username || url.password) throw new PortError("REFUSED", `${opts.provider}: credentials in the URL are refused`);
    this.base = url;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.limiter = new Limiter(Math.max(1, opts.maxConcurrent ?? 4));
  }

  get host(): string {
    return this.base.host;
  }

  get hostname(): string {
    return this.base.hostname;
  }

  private url(path: string): string {
    return `${this.base.toString().replace(/\/+$/, "")}${path}`;
  }

  /** Removes the key, and anything shaped like a bearer token, from text that may be logged. */
  scrub(text: string): string {
    let out = text;
    if (this.opts.apiKey.length >= 8) out = out.split(this.opts.apiKey).join("[KEY]");
    return out.replace(/Bearer\s+[A-Za-z0-9._~+/=-]{12,}/g, "Bearer [KEY]").replace(/nvapi-[A-Za-z0-9_-]{12,}/g, "[KEY]");
  }

  /** `GET /models`: the ids the endpoint says it serves. */
  async listModels(timeoutMs = 20_000, signal?: AbortSignal): Promise<string[]> {
    const signals = [AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])];
    let res: Response;
    try {
      res = await this.fetchImpl(this.url("/models"), {
        method: "GET",
        headers: { authorization: `Bearer ${this.opts.apiKey}` },
        redirect: "manual",
        signal: AbortSignal.any(signals),
      });
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw new PortError("UNAVAILABLE", this.scrub(`${this.opts.provider}: model list not reachable: ${(error as Error).message}`));
    }
    if (!res.ok) {
      throw new PortError(res.status === 401 || res.status === 403 ? "FORBIDDEN" : "UNAVAILABLE", `${this.opts.provider}: model list returned HTTP ${res.status}`, { status: res.status });
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new PortError("DRIFTED", `${this.opts.provider}: model list was not JSON`);
    }
    const data = (body as { data?: unknown } | null)?.data;
    if (!Array.isArray(data)) throw new PortError("DRIFTED", `${this.opts.provider}: model list has no "data" array`);
    return data.map((m) => (m as { id?: unknown } | null)?.id).filter((id): id is string => typeof id === "string");
  }

  async chat(spec: ChatSpec, ctx: ChatContext): Promise<ChatReply> {
    const o = this.opts;
    const now = o.now ?? Date.now;
    const maxAttempts = Math.max(1, o.maxAttempts ?? 4);
    const started = now();
    const deadline = started + (o.deadlineMs ?? 300_000);
    const requestJson = JSON.stringify({
      model: spec.model,
      messages: spec.messages,
      max_tokens: spec.maxTokens,
      temperature: spec.temperature,
      // Stated, not left to the endpoint: Nightshift fills in top_p 0.95 when a request omits it, NVIDIA uses 1.
      top_p: 1,
      chat_template_kwargs: { enable_thinking: spec.thinking },
      ...(spec.jsonObject ? { response_format: { type: "json_object" } } : {}),
    });
    let last: PortError | undefined;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (ctx.signal?.aborted) throw cancelled();
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const perAttempt = Math.min(ctx.timeoutMs ?? o.timeoutMs ?? 90_000, remaining);
      const t0 = now();
      try {
        const reply = await this.limiter.run(() => this.once(requestJson, perAttempt, ctx, attempt), ctx.signal);
        o.trace.emit("model.attempt", { provider: o.provider, model: spec.model, role: ctx.role, attempt, outcome: "ok", ms: now() - t0 });
        return { ...reply, attempts: attempt, requestJson, latencyMs: now() - t0 };
      } catch (error) {
        if (!(error instanceof PortError)) {
          if (ctx.signal?.aborted) throw cancelled();
          throw error;
        }
        const retryable = error.detail?.["retryable"] === true;
        o.trace.emit("model.attempt", {
          provider: o.provider,
          model: spec.model,
          role: ctx.role,
          attempt,
          outcome: retryable ? "retry" : "fail",
          failure: error.failure,
          ...(error.detail?.["status"] !== undefined ? { status: error.detail["status"] } : {}),
          ms: now() - t0,
        });
        if (!retryable) throw error;
        last = error;
        attempts = attempt;
        if (attempt === maxAttempts) break;
        const wait = this.backoff(attempt, error.detail?.["retryAfterMs"]);
        if (now() + wait >= deadline) break;
        try {
          await (o.sleep ?? defaultSleep)(wait, ctx.signal);
        } catch {
          throw cancelled();
        }
      }
    }
    const { retryable: _r, retryAfterMs: _a, ...kept } = last?.detail ?? {};
    throw new PortError(
      "UNAVAILABLE",
      last ? `${last.message}; gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}` : `${o.provider}: no attempt could be made before the deadline`,
      { ...kept, attempts },
    );
  }

  private backoff(attempt: number, retryAfterMs: unknown): number {
    const o = this.opts;
    const cap = o.backoffCapMs ?? 20_000;
    const ceiling = Math.min(cap, (o.backoffBaseMs ?? 1_000) * 2 ** (attempt - 1));
    // Equal jitter: at least half the ceiling, so a burst of callers still spreads out without hammering at zero delay.
    const jittered = ceiling / 2 + (o.random ?? Math.random)() * (ceiling / 2);
    const asked = typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) ? Math.min(retryAfterMs, cap) : 0;
    return Math.round(Math.max(jittered, asked));
  }

  private async once(requestJson: string, timeoutMs: number, ctx: ChatContext, attempt: number): Promise<Omit<ChatReply, "attempts" | "requestJson" | "latencyMs">> {
    const o = this.opts;
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(ctx.signal ? [ctx.signal] : [])]);
    let res: Response;
    let text: string;
    try {
      res = await this.fetchImpl(this.url("/chat/completions"), {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${o.apiKey}`,
          ...(ctx.headers ? ctx.headers(attempt) : {}),
        },
        body: requestJson,
        redirect: "manual",
        signal,
      });
      text = await res.text();
    } catch (error) {
      if (ctx.signal?.aborted) throw cancelled();
      const timedOut = signal.aborted;
      throw new PortError("UNAVAILABLE", this.scrub(timedOut ? `${o.provider}: no reply within ${timeoutMs} ms` : `${o.provider}: network error: ${(error as Error).message}`), {
        retryable: true,
        timeout: timedOut,
      });
    }

    const status = res.status;
    if (status >= 300 && status < 400) {
      throw new PortError("REFUSED", `${o.provider}: the endpoint redirected (HTTP ${status}); redirects are refused so the key is never forwarded`, { status });
    }
    if (status === 429 || status >= 500 || status === 408 || status === 425) {
      throw new PortError("UNAVAILABLE", `${o.provider}: HTTP ${status}`, { status, retryable: true, retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), Date.now()) });
    }
    if (status === 401 || status === 403) {
      throw new PortError("FORBIDDEN", `${o.provider}: HTTP ${status}, the key was not accepted`, { status });
    }
    if (status === 404 || status === 410) {
      throw new PortError("UNAVAILABLE", this.scrub(`${o.provider}: HTTP ${status}, the model is not served: ${shorten(errorMessage(text))}`), { status, modelGone: true });
    }
    if (status >= 400) {
      throw new PortError("INVALID", this.scrub(`${o.provider}: HTTP ${status}: ${shorten(errorMessage(text))}`), { status });
    }

    let body: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(text);
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
      body = parsed as Record<string, unknown>;
    } catch {
      throw new PortError("DRIFTED", `${o.provider}: HTTP ${status} reply was not a JSON object`, { status });
    }
    if (body["error"] !== undefined && body["choices"] === undefined) {
      throw new PortError("INVALID", this.scrub(`${o.provider}: ${shorten(errorMessage(text))}`), { status });
    }
    const choice = (body["choices"] as { message?: Record<string, unknown>; finish_reason?: unknown }[] | undefined)?.[0];
    const message = choice?.message;
    if (!message) throw new PortError("DRIFTED", `${o.provider}: the reply has no choices[0].message`, { status });

    const content = contentText(message["content"]);
    const finishReason = typeof choice?.finish_reason === "string" ? choice.finish_reason : undefined;
    if (content.trim() === "") {
      const reasoning = typeof message["reasoning_content"] === "string" && message["reasoning_content"].length > 0;
      if (reasoning || finishReason === "length") {
        throw new PortError("TRUNCATED", `${o.provider}: the reply holds no answer, only reasoning or a cut-off; raise maxTokens`, { status, finishReason });
      }
      // A hosted model now and then returns nothing for a request it answered a moment before. Worth another try.
      throw new PortError("UNAVAILABLE", `${o.provider}: empty reply`, { status, retryable: true });
    }
    const usage = readUsage(body["usage"]);
    return {
      status,
      ...(typeof body["id"] === "string" ? { id: body["id"] } : {}),
      ...(typeof body["model"] === "string" ? { model: body["model"] } : {}),
      content,
      ...(finishReason ? { finishReason } : {}),
      ...(usage ? { usage } : {}),
      body,
    };
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (part !== null && typeof part === "object" && typeof (part as { text?: unknown }).text === "string" ? (part as { text: string }).text : ""))
      .join("");
  }
  return "";
}

function readUsage(raw: unknown): ChatUsage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const u = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; completion_tokens_details?: { reasoning_tokens?: unknown } | null };
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined);
  const promptTokens = num(u.prompt_tokens);
  const completionTokens = num(u.completion_tokens);
  const reasoningTokens = num(u.completion_tokens_details?.reasoning_tokens);
  if (promptTokens === undefined && completionTokens === undefined) return undefined;
  return {
    ...(promptTokens !== undefined ? { promptTokens } : {}),
    ...(completionTokens !== undefined ? { completionTokens } : {}),
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

export function parseRetryAfter(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(header);
  return Number.isFinite(at) ? Math.max(0, at - nowMs) : undefined;
}

function errorMessage(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: unknown } | string; detail?: unknown; message?: unknown };
    if (typeof j.error === "string") return j.error;
    if (typeof j.error?.message === "string") return j.error.message;
    if (typeof j.detail === "string") return j.detail;
    if (typeof j.message === "string") return j.message;
  } catch {
    /* not JSON */
  }
  return text;
}

function shorten(text: string): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > 200 ? `${one.slice(0, 200)}...` : one;
}
