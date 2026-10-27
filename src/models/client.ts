import { PortError, type ComputeReceipt, type ModelPort, type ModelResponse } from "../ports/index.ts";
import { ModelHealth, selectUsable, type AvailabilitySnapshot } from "./availability.ts";
import { ChatTransport, type ChatMessage, type ChatReply, type TransportOptions } from "./chat.ts";
import { EgressPolicy, PromptLog } from "./egress.ts";
import { promptKey, textHash } from "./keys.ts";
import { RoleMap, type RoleSpec } from "./roles.ts";
import { combineUsage, parseAgainstSchema, repairMessage, schemaInstruction, SchemaValidator, stripReasoning } from "./structured.ts";
import type { TraceSink } from "./trace.ts";
import { MAX_PROMPT_BYTES, type LaneDescriptor, type SakaimeModelRequest } from "./types.ts";

export interface ChatClientOptions {
  baseUrl: string;
  apiKey: string;
  trace: TraceSink;
  egress: EgressPolicy;
  roles?: RoleMap;
  promptLog?: PromptLog;
  health?: ModelHealth;
  validator?: SchemaValidator;
  /** Cancels every call this client makes. A request may add its own signal. */
  signal?: AbortSignal;
  /** Per-attempt timeout when a request names none. */
  timeoutMs?: number;
  /** Test and tuning seams for the HTTP layer: fetch, sleep, random, clock, attempt and backoff limits. */
  transport?: Partial<Omit<TransportOptions, "provider" | "baseUrl" | "apiKey" | "trace">>;
  now?: () => Date;
}

export interface ReplyContext {
  model: string;
  role: string;
  /** The `meterless-scope` sent on the attempt that succeeded. */
  scope: string;
  reply: ChatReply;
  lastUserText: string;
  /** The contents of every non-system message sent on this attempt, in order. */
  conversation: readonly string[];
  requestHash: string;
  responseHash: string;
  lane: LaneDescriptor;
  now: Date;
}

interface CallResult {
  reply: ChatReply;
  receipt?: ComputeReceipt;
  promptChars: number;
}

const SCOPE_PATTERN = /^[\x21-\x7e]{1,200}$/;
const REPAIR_ECHO_CHARS = 4000;

function bytesOf(...parts: string[]): number {
  return parts.reduce((n, p) => n + Buffer.byteLength(p, "utf8"), 0);
}

/**
 * What both providers share: request validation, the 32 KB cap, role to model resolution with fallback, the egress
 * check, structured-output validation with one repair, usage accounting and the trace. A provider supplies its lane, the
 * extra headers it needs, and what it does with a reply (Nightshift verifies the receipt).
 */
export abstract class ChatModelClient implements ModelPort {
  abstract readonly provider: "nvidia" | "nightshift";
  protected readonly roles: RoleMap;
  protected readonly health: ModelHealth;
  protected readonly validator: SchemaValidator;
  protected readonly transport: ChatTransport;
  private readonly usedScopes = new Set<string>();
  private snapshot: AvailabilitySnapshot | undefined;

  protected constructor(
    providerName: string,
    protected readonly opts: ChatClientOptions,
  ) {
    this.roles = opts.roles ?? new RoleMap();
    this.health = opts.health ?? new ModelHealth();
    this.validator = opts.validator ?? new SchemaValidator();
    this.transport = new ChatTransport({
      ...opts.transport,
      provider: providerName,
      baseUrl: opts.baseUrl,
      apiKey: opts.apiKey,
      trace: opts.trace,
      timeoutMs: opts.timeoutMs ?? opts.transport?.timeoutMs ?? 90_000,
    });
  }

  /** The lane a call to `model` is processed on. */
  protected abstract laneFor(model: string): LaneDescriptor;
  /** Which lane's models the role map should offer. */
  protected abstract readonly lanePreference: "remote" | "local";
  protected abstract headersFor(scope: string, timeoutMs: number): Record<string, string>;
  /** Called with each successful chat reply. Returns the receipt to attach, or throws to reject the reply. */
  protected abstract verifyReply(ctx: ReplyContext, role: string): ComputeReceipt | undefined;

  availability(): AvailabilitySnapshot | undefined {
    return this.snapshot;
  }

  /** Re-reads `GET /models` and clears the failure memory. Call at the start of each run. */
  async beginRun(signal?: AbortSignal): Promise<AvailabilitySnapshot> {
    this.health.reset();
    const probedAt = (this.opts.now ?? (() => new Date()))().toISOString();
    const endpoint = this.transport.host;
    let snapshot: AvailabilitySnapshot;
    try {
      const listed = await this.transport.listModels(20_000, signal ?? this.opts.signal);
      const set = new Set(listed);
      const roles: AvailabilitySnapshot["roles"] = {};
      for (const role of this.roles.roles()) {
        const spec = this.roles.spec(role);
        const chain = this.lanePreference === "local" ? (spec.localModel ? [spec.localModel] : []) : [spec.model, ...spec.fallbacks];
        const entries = chain.map((model) => ({ model, listed: set.has(model) }));
        roles[role] = { model: entries.find((e) => e.listed)?.model ?? null, chain: entries };
      }
      snapshot = { probedAt, endpoint, status: "ok", listed, roles };
    } catch (error) {
      // An unreadable list says nothing about any model. Calls go ahead and meet whatever is true.
      const message = error instanceof Error ? error.message : String(error);
      snapshot = { probedAt, endpoint, status: "failed", listed: [], error: message, roles: {} };
    }
    this.snapshot = snapshot;
    this.opts.trace.emit("model.availability", {
      provider: this.provider,
      endpoint,
      status: snapshot.status,
      listedCount: snapshot.listed.length,
      roles: Object.fromEntries(Object.entries(snapshot.roles).map(([r, v]) => [r, v.model])),
      ...(snapshot.error ? { error: snapshot.error } : {}),
    });
    return snapshot;
  }

  async complete(request: SakaimeModelRequest): Promise<ModelResponse> {
    const spec = this.roles.spec(request.role);
    if (typeof request.system !== "string" || typeof request.user !== "string" || request.user.trim() === "") {
      throw new PortError("INVALID", "a model request needs a system string and a non-empty user string");
    }
    if (typeof request.memoryScope !== "string" || !SCOPE_PATTERN.test(request.memoryScope)) {
      throw new PortError("INVALID", "memoryScope must be a printable ASCII string of 1 to 200 characters, unique to this call");
    }
    if (this.usedScopes.has(request.memoryScope)) {
      throw new PortError("INVALID", `memoryScope "${request.memoryScope}" was already used by an earlier call. Every call needs its own so that remembered context cannot leak between cases; make a new one before retrying.`);
    }
    const maxTokens = request.maxTokens ?? spec.maxTokens;
    if (!Number.isInteger(maxTokens) || maxTokens < 16 || maxTokens > 16_384) {
      throw new PortError("INVALID", `maxTokens must be an integer from 16 to 16384, not ${String(maxTokens)}`);
    }
    if (request.jsonSchema !== undefined) this.validator.compile(request.jsonSchema);

    const system = request.jsonSchema ? `${request.system}\n\n${schemaInstruction(request.jsonSchema)}` : request.system;
    const promptBytes = bytesOf(system, request.user);
    if (promptBytes >= MAX_PROMPT_BYTES) {
      throw new PortError(
        "INVALID",
        `the prompt is ${promptBytes} bytes; a prompt must stay under ${MAX_PROMPT_BYTES} bytes (32 KB). Split the input into chunks and call once per chunk.`,
        { promptBytes, limit: MAX_PROMPT_BYTES },
      );
    }

    const key = promptKey(request);
    const candidates = this.roles.candidates(request.role, promptBytes, this.lanePreference);
    const lane = this.laneFor(candidates[0] as string);
    const decision = this.opts.egress.authorize({
      lane,
      dataClass: request.dataClass,
      role: request.role,
      system,
      user: request.user,
      requestHash: key,
      ...(request.consentToken ? { consentToken: request.consentToken } : {}),
      ...(request.consentSubject ? { consentSubject: request.consentSubject } : {}),
    });
    this.opts.promptLog?.record({ role: request.role, dataClass: request.dataClass, system, user: request.user, requestHash: key, outcome: decision.allowed ? "sent" : "refused" });
    if (!decision.allowed) {
      throw new PortError("REFUSED", `egress refused: ${decision.reason}`, { basis: decision.basis, dataClass: decision.dataClass, lane: lane.id, ...(decision.hits ? { hits: decision.hits } : {}) });
    }
    this.usedScopes.add(request.memoryScope);

    const { usable, skipped } = selectUsable(candidates, this.snapshot, this.health);
    for (const s of skipped) this.opts.trace.emit("model.skip", { provider: this.provider, role: request.role, model: s.model, reason: s.reason });

    const signal = request.signal && this.opts.signal ? AbortSignal.any([request.signal, this.opts.signal]) : (request.signal ?? this.opts.signal);
    let last: PortError | undefined;
    for (const [index, model] of usable.entries()) {
      try {
        const response = await this.runModel({ request, spec, model, system, maxTokens, key, signal, fallbackIndex: index });
        if (lane.location === "local") this.opts.egress.markLaneVerified(lane.id);
        return response;
      } catch (error) {
        if (!(error instanceof PortError)) throw error;
        last = error;
        if (error.detail?.["modelGone"] === true) this.health.markGone(model, error.message);
        else if (error.failure === "UNAVAILABLE" && error.detail?.["cancelled"] !== true) this.health.recordFailure(model, error.message);
        const mayFallBack = error.failure === "UNAVAILABLE" && error.detail?.["cancelled"] !== true && index < usable.length - 1;
        if (!mayFallBack) throw error;
        this.opts.trace.emit("model.fallback", { provider: this.provider, role: request.role, from: model, to: usable[index + 1], reason: error.message });
      }
    }
    throw last ?? new PortError("UNAVAILABLE", "no model could be tried");
  }

  private async runModel(args: {
    request: SakaimeModelRequest;
    spec: RoleSpec;
    model: string;
    system: string;
    maxTokens: number;
    key: string;
    signal: AbortSignal | undefined;
    fallbackIndex: number;
  }): Promise<ModelResponse> {
    const { request, spec, model, system, maxTokens, key, signal } = args;
    const started = Date.now();
    const schema = request.jsonSchema;
    let messages: ChatMessage[] = [
      { role: "system", content: system },
      { role: "user", content: request.user },
    ];
    const calls: CallResult[] = [];
    let repaired = false;

    for (let pass = 0; pass < (schema ? 2 : 1); pass += 1) {
      const call = await this.callOnce({ request, spec, model, messages, maxTokens, signal, pass });
      calls.push(call);
      const text = call.reply.content;
      if (!schema) {
        return this.finish({ request, model, calls, key, started, text: stripReasoning(text), repaired, fallbackIndex: args.fallbackIndex });
      }
      const parsed = parseAgainstSchema(text, schema, this.validator);
      if (parsed.ok) {
        return this.finish({ request, model, calls, key, started, text: parsed.result.json, json: parsed.result.value, repaired, fallbackIndex: args.fallbackIndex });
      }
      this.opts.trace.emit("model.structured", { provider: this.provider, role: request.role, model, pass: pass + 1, ok: false, problem: parsed.message });
      if (pass === 1) {
        throw new PortError("INVALID", `the model's reply did not satisfy the schema after one repair attempt: ${parsed.message}`, {
          model,
          attempts: calls.length,
          lastReplyHash: textHash(text),
          lastReplyChars: text.length,
        });
      }
      // One bounded repair: the model sees what was wrong. The echo of its own reply is cut, and dropped if it would breach the cap.
      repaired = true;
      const echo = text.length > REPAIR_ECHO_CHARS ? text.slice(0, REPAIR_ECHO_CHARS) : text;
      const withEcho: ChatMessage[] = [...messages, { role: "assistant", content: echo }, { role: "user", content: repairMessage(parsed.message) }];
      const withoutEcho: ChatMessage[] = [...messages, { role: "user", content: repairMessage(parsed.message) }];
      const total = (m: ChatMessage[]): number => bytesOf(...m.map((x) => x.content));
      messages = total(withEcho) < MAX_PROMPT_BYTES ? withEcho : withoutEcho;
      if (total(messages) >= MAX_PROMPT_BYTES) {
        throw new PortError("INVALID", "the repair request would exceed the 32 KB prompt cap; the reply could not be corrected", { model });
      }
    }
    throw new PortError("INVALID", "unreachable: the structured loop ended without a result");
  }

  private async callOnce(args: {
    request: SakaimeModelRequest;
    spec: RoleSpec;
    model: string;
    messages: ChatMessage[];
    maxTokens: number;
    signal: AbortSignal | undefined;
    pass: number;
  }): Promise<CallResult> {
    const { request, spec, model, messages, maxTokens, signal, pass } = args;
    const timeoutMs = request.timeoutMs ?? this.opts.timeoutMs ?? 90_000;
    const base = pass === 0 ? request.memoryScope : `${request.memoryScope}~repair`;
    const lane = this.laneFor(model);
    const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? request.user;
    const reply = await this.transport.chat(
      { model, messages, maxTokens, temperature: spec.temperature, thinking: spec.thinking, jsonObject: request.jsonSchema !== undefined },
      {
        role: request.role,
        timeoutMs,
        ...(signal ? { signal } : {}),
        // A distinct scope per attempt: a retry after an empty reply must not meet the cached empty reply.
        headers: (attempt) => this.headersFor(`${base}.a${attempt}`, timeoutMs),
      },
    );
    if (reply.finishReason === "length") {
      throw new PortError("TRUNCATED", `the reply was cut off at maxTokens (${maxTokens}); raise maxTokens or ask for less`, { model, maxTokens });
    }
    const receipt = this.verifyReply(
      {
        model,
        role: request.role,
        scope: `${base}.a${reply.attempts}`,
        reply,
        lastUserText: lastUser,
        conversation: messages.filter((m) => m.role !== "system").map((m) => m.content),
        requestHash: textHash(reply.requestJson),
        responseHash: textHash(reply.content),
        lane,
        now: (this.opts.now ?? (() => new Date()))(),
      },
      request.role,
    );
    this.health.recordSuccess(model);
    return { reply, ...(receipt ? { receipt } : {}), promptChars: messages.reduce((n, m) => n + m.content.length, 0) };
  }

  private finish(args: {
    request: SakaimeModelRequest;
    model: string;
    calls: CallResult[];
    key: string;
    started: number;
    text: string;
    json?: unknown;
    repaired: boolean;
    fallbackIndex: number;
  }): ModelResponse {
    const { request, model, calls, key, started, text, json, repaired } = args;
    const final = calls[calls.length - 1] as CallResult;
    const usage = combineUsage(calls.map((c) => ({ ...(c.reply.usage ? { usage: c.reply.usage } : {}), promptChars: c.promptChars, completionChars: c.reply.content.length })));
    const routed = final.receipt?.routedModel ?? final.reply.model ?? model;
    const response: ModelResponse = {
      text,
      ...(json !== undefined ? { json } : {}),
      requestedModel: model,
      routedModel: routed,
      provider: this.provider,
      usage: { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens, measured: usage.measured },
      ...(final.receipt ? { receipt: this.withEarlierReceipts(final.receipt, calls) } : {}),
      recorded: false,
    };
    this.opts.trace.emit("model.call", {
      provider: this.provider,
      role: request.role,
      model,
      routedModel: routed,
      promptKey: key,
      attempts: calls.reduce((n, c) => n + c.reply.attempts, 0),
      repaired,
      structured: request.jsonSchema !== undefined,
      fallbackIndex: args.fallbackIndex,
      usageMeasured: usage.measured,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      ms: Date.now() - started,
      receiptId: final.receipt?.receiptId ?? null,
    });
    return response;
  }

  /** A repaired answer rests on two calls; the first call's receipt is kept beside the second so neither is lost. */
  private withEarlierReceipts(receipt: ComputeReceipt, calls: CallResult[]): ComputeReceipt {
    const earlier = calls.slice(0, -1).flatMap((c) => (c.receipt ? [c.receipt.receiptId] : []));
    return earlier.length === 0 ? receipt : { ...receipt, raw: { ...receipt.raw, earlierReceiptIds: earlier } };
  }
}
