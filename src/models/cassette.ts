import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PortError, type ComputeReceipt, type ModelPort, type ModelRequest, type ModelResponse } from "../ports/index.ts";
import { hashOf } from "../util/canonical.ts";
import type { ForbiddenValues } from "./egress.ts";
import { promptKey } from "./keys.ts";
import { verifyStoredReceipt, type ReceiptLedger, type ReceiptPolicy } from "./receipt.ts";
import type { TraceSink } from "./trace.ts";
import type { SakaimeModelRequest } from "./types.ts";

/*
 * Cassettes: recorded model replies keyed by request hash.
 *
 * A cassette holds the prompt and the reply, so it may hold only public-class content. The recorder refuses everything
 * else. Replay never invents: a request with no recording fails with UNAVAILABLE and the reason "no recording".
 * Replayed answers are labelled `recorded: true` and `provider: "recorded"` everywhere they are shown.
 */

export const CASSETTE_SCHEMA = "sakaime.model-cassette/1";

const ReceiptSchema = z
  .object({
    receiptId: z.string(),
    decisionId: z.string().optional(),
    routedModel: z.string(),
    provider: z.string().optional(),
    latencyMs: z.number().optional(),
    hmem: z.number().optional(),
    signature: z.string().optional(),
    keyId: z.string().optional(),
    requestHash: z.string().optional(),
    responseHash: z.string().optional(),
    raw: z.record(z.unknown()),
  })
  .strict();

const CassetteSchema = z
  .object({
    schema: z.literal(CASSETTE_SCHEMA),
    recordedAt: z.string(),
    role: z.string(),
    requestHash: z.string().regex(/^[0-9a-f]{64}$/),
    request: z
      .object({
        system: z.string(),
        user: z.string(),
        jsonSchema: z.record(z.unknown()).optional(),
        maxTokens: z.number().optional(),
        dataClass: z.literal("public"),
      })
      .strict(),
    response: z
      .object({
        text: z.string(),
        json: z.unknown().optional(),
        requestedModel: z.string(),
        routedModel: z.string(),
        /** The provider that answered when this was recorded. */
        recordedFrom: z.enum(["nightshift", "nvidia"]),
        usage: z.object({ promptTokens: z.number().optional(), completionTokens: z.number().optional(), measured: z.boolean() }).strict(),
        receipt: ReceiptSchema.optional(),
      })
      .strict(),
    /** SHA-256 of the canonical `response`. An edited cassette fails this. */
    responseHash: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();

export type CassetteFile = z.infer<typeof CassetteSchema>;

function fileNameFor(role: string, key: string): string {
  return `${role.replace(/[^A-Za-z0-9_-]/g, "_")}-${key.slice(0, 32)}.json`;
}

/** Replays recorded replies. */
export class RecordedModelPort implements ModelPort {
  constructor(
    private readonly options: {
      dir: string;
      trace: TraceSink;
      /** Key ids a stored receipt must have been signed by to be re-attached. Without a match the receipt is dropped. */
      receiptPolicy?: Pick<ReceiptPolicy, "trustedKeyIds" | "allowUnpinnedKey">;
      /** When given, recorded receipts that re-verify are entered here as verified (origin recorded). */
      ledger?: ReceiptLedger;
    },
  ) {}

  has(request: Pick<ModelRequest, "role" | "system" | "user" | "jsonSchema" | "maxTokens">): boolean {
    return existsSync(join(this.options.dir, fileNameFor(request.role, promptKey(request))));
  }

  /** The request keys held in the directory, for a coverage report of what a sample run can answer. */
  keys(): string[] {
    if (!existsSync(this.options.dir)) return [];
    return readdirSync(this.options.dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        try {
          return (JSON.parse(readFileSync(join(this.options.dir, f), "utf8")) as { requestHash?: string }).requestHash;
        } catch {
          return undefined;
        }
      })
      .filter((k): k is string => typeof k === "string");
  }

  async complete(request: SakaimeModelRequest): Promise<ModelResponse> {
    const key = promptKey(request);
    const path = join(this.options.dir, fileNameFor(request.role, key));
    if (!existsSync(path)) {
      this.options.trace.emit("cassette.miss", { role: request.role, promptKey: key });
      throw new PortError("UNAVAILABLE", `no recording for role ${request.role} (request ${key.slice(0, 12)}); a recorded run does not invent an answer`, {
        reason: "no recording",
        role: request.role,
        promptKey: key,
      });
    }
    let file: CassetteFile;
    try {
      file = CassetteSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    } catch (error) {
      throw new PortError("DRIFTED", `the recording ${path} is not a valid cassette entry: ${error instanceof Error ? error.message.slice(0, 200) : "unreadable"}`, { reason: "invalid cassette" });
    }
    if (file.requestHash !== key || promptKey({ role: file.role, ...file.request }) !== key) {
      throw new PortError("DRIFTED", `the recording ${path} does not match its own request hash; it was edited`, { reason: "request hash mismatch" });
    }
    if (hashOf(file.response) !== file.responseHash) {
      throw new PortError("DRIFTED", `the recording ${path} does not match its response hash; it was edited`, { reason: "response hash mismatch" });
    }

    let receipt: ComputeReceipt | undefined;
    if (file.response.receipt) {
      const stored = file.response.receipt as ComputeReceipt;
      const policy = this.options.receiptPolicy;
      const check = policy ? verifyStoredReceipt(stored, { requestedModel: file.response.requestedModel }, policy) : undefined;
      if (check?.ok) {
        receipt = { ...stored, raw: { ...stored.raw, replayVerification: { verifiedAt: new Date().toISOString(), origin: "recorded", checks: check.checks } } };
        this.options.ledger?.accept({
          receiptId: stored.receiptId,
          ...(stored.decisionId ? { decisionId: stored.decisionId } : {}),
          keyId: check.keyId,
          model: stored.routedModel,
          tier: String(stored.raw["tier"] ?? ""),
          at: new Date().toISOString(),
          requestHash: stored.requestHash ?? "",
          responseHash: stored.responseHash ?? "",
          origin: "recorded",
          role: request.role,
        });
      } else {
        // The reply is still shown, but not as receipted: its receipt did not survive re-checking.
        const why = check && !check.ok ? check.reason : "no receipt policy was given to re-check it";
        this.options.trace.emit("cassette.receipt_dropped", { role: request.role, promptKey: key, reason: why });
      }
    }
    this.options.trace.emit("cassette.hit", { role: request.role, promptKey: key, recordedFrom: file.response.recordedFrom, receiptKept: receipt !== undefined });
    return {
      text: file.response.text,
      ...(file.response.json !== undefined ? { json: file.response.json } : {}),
      requestedModel: file.response.requestedModel,
      routedModel: file.response.routedModel,
      provider: "recorded",
      usage: file.response.usage,
      ...(receipt ? { receipt } : {}),
      recorded: true,
    };
  }
}

export interface RecordingStats {
  recorded: number;
  skipped: { promptKey: string; reason: string }[];
}

/** Wraps a live port and writes each public-class exchange to a cassette directory. Anything else passes through unrecorded. */
export class RecordingModelPort implements ModelPort {
  readonly stats: RecordingStats = { recorded: 0, skipped: [] };

  constructor(
    private readonly inner: ModelPort,
    private readonly options: {
      dir: string;
      trace: TraceSink;
      forbidden: ForbiddenValues;
      now?: () => Date;
    },
  ) {}

  async complete(request: SakaimeModelRequest): Promise<ModelResponse> {
    const response = await this.inner.complete(request);
    const key = promptKey(request);
    const skip = (reason: string): ModelResponse => {
      this.stats.skipped.push({ promptKey: key, reason });
      this.options.trace.emit("cassette.skipped", { role: request.role, promptKey: key, reason });
      return response;
    };
    if (response.recorded) return skip("the reply was itself a replay");
    if (response.provider === "recorded") return skip("the reply was itself a replay");
    if (request.dataClass !== "public") return skip(`the request is ${request.dataClass}; a cassette holds public content only`);
    const texts = [request.system, request.user, response.text, JSON.stringify(response.json ?? null)];
    if (texts.some((t) => this.options.forbidden.scan(t).length > 0)) return skip("the exchange holds a value that must not be written to disk");

    const body: CassetteFile["response"] = {
      text: response.text,
      ...(response.json !== undefined ? { json: response.json } : {}),
      requestedModel: response.requestedModel,
      routedModel: response.routedModel,
      recordedFrom: response.provider === "nightshift" ? "nightshift" : "nvidia",
      usage: response.usage,
      ...(response.receipt ? { receipt: response.receipt } : {}),
    };
    const file: CassetteFile = {
      schema: CASSETTE_SCHEMA,
      recordedAt: (this.options.now ?? (() => new Date()))().toISOString(),
      role: request.role,
      requestHash: key,
      request: {
        system: request.system,
        user: request.user,
        ...(request.jsonSchema ? { jsonSchema: request.jsonSchema } : {}),
        ...(request.maxTokens !== undefined ? { maxTokens: request.maxTokens } : {}),
        dataClass: "public",
      },
      response: body,
      responseHash: hashOf(body),
    };
    mkdirSync(this.options.dir, { recursive: true });
    const path = join(this.options.dir, fileNameFor(request.role, key));
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(file, null, 2)}\n`, "utf8");
    renameSync(tmp, path);
    this.stats.recorded += 1;
    this.options.trace.emit("cassette.recorded", { role: request.role, promptKey: key, file: fileNameFor(request.role, key), receipt: response.receipt?.receiptId ?? null });
    return response;
  }
}
