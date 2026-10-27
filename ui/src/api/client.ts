import { z } from "zod";
import {
  CaseDetailSchema,
  CaseSummarySchema,
  DrillResponseSchema,
  ErrorBodySchema,
  GuardResponseSchema,
  HealthResponseSchema,
  OnboardingResultSchema,
  RecomputeResponseSchema,
  SourceRowSchema,
  TimelineEventSchema,
  TraceEventSchema,
  VerifyResponseSchema,
  type TraceEvent,
} from "@contract";

/**
 * The failure taxonomy as the reader sees it. UNAVAILABLE (we could not get an answer), EMPTY (we got an answer and it
 * was empty), FORBIDDEN (a rule said no) and the rest are different situations and are never collapsed into one message.
 */
export class ApiError extends Error {
  constructor(
    readonly failure: string,
    message: string,
    readonly status: number,
    readonly detail?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let text = "";
  try {
    text = await res.text();
  } catch {
    // fall through to the generic message
  }
  try {
    const body = ErrorBodySchema.parse(JSON.parse(text));
    // An HTTP 404 means the thing is not there, whatever failure word the body carries; it reads as "not found", never as an outage.
    return new ApiError(res.status === 404 ? "NOT_FOUND" : body.error.failure, body.error.message, res.status, body.error.detail);
  } catch {
    // Not our error body. A proxy error page or an empty reply means the service did not answer.
    if (res.status >= 500 || res.status === 0) {
      return new ApiError("UNAVAILABLE", "The Sakaime service did not answer. This is on our side, not a finding about the evidence.", res.status);
    }
    if (res.status === 404) return new ApiError("NOT_FOUND", "That item does not exist.", res.status);
    return new ApiError("INVALID", `The service refused the request (HTTP ${res.status}).`, res.status);
  }
}

async function call<S extends z.ZodTypeAny>(method: "GET" | "POST", path: string, schema: S, body?: unknown, signal?: AbortSignal): Promise<z.infer<S>> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      signal,
      headers: body === undefined ? { Accept: "application/json" } : { Accept: "application/json", "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("UNAVAILABLE", "The Sakaime service could not be reached. This is on our side, not a finding about the evidence.", 0);
  }
  if (!res.ok) throw await parseError(res);
  let json: unknown;
  try {
    json = await res.json();
  } catch {
    throw new ApiError("UNAVAILABLE", "The service replied with something that is not JSON.", res.status);
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) {
    // A reply that does not match the contract is shown as such, never rendered as nulls.
    throw new ApiError(
      "CONTRACT",
      "The service answered in a shape this app does not recognise.",
      res.status,
      { issues: parsed.error.issues.slice(0, 6).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) },
    );
  }
  return parsed.data;
}

const enc = encodeURIComponent;

/** The timeline route has no response schema in the contract; both an array and { events } are accepted. */
const TimelineResponseSchema = z.union([z.array(TimelineEventSchema), z.object({ events: z.array(TimelineEventSchema) }).passthrough()]);

export const ResultRowSchema = z.object({
  id: z.string(),
  measure: z.string(),
  status: z.enum(["measured", "to_be_measured"]),
  value: z.string().optional(),
  denominator: z.string().optional(),
  interval: z.string().optional(),
  limits: z.string().optional(),
  source: z.string().optional(),
  group: z.string().optional(),
});
export const ResultsFileSchema = z.object({
  generatedAt: z.string().optional(),
  note: z.string().optional(),
  rows: z.array(ResultRowSchema),
});
export type ResultsFile = z.infer<typeof ResultsFileSchema>;

export const api = {
  health: (signal?: AbortSignal) => call("GET", "/api/health", HealthResponseSchema, undefined, signal),
  sources: (signal?: AbortSignal) => call("GET", "/api/sources", z.array(SourceRowSchema), undefined, signal),
  proposeSource: (body: { description: string; url: string }, signal?: AbortSignal) => call("POST", "/api/sources/propose", OnboardingResultSchema, body, signal),
  cases: (signal?: AbortSignal) => call("GET", "/api/cases", z.array(CaseSummarySchema), undefined, signal),
  caseDetail: (id: string, signal?: AbortSignal) => call("GET", `/api/cases/${enc(id)}`, CaseDetailSchema, undefined, signal),
  recompute: (id: string, body: unknown, signal?: AbortSignal) => call("POST", `/api/cases/${enc(id)}/recompute`, RecomputeResponseSchema, body, signal),
  drill: (id: string, body: { drill: string; target?: string }, signal?: AbortSignal) => call("POST", `/api/cases/${enc(id)}/drill`, DrillResponseSchema, body, signal),
  timeline: async (id: string, asOf?: string, signal?: AbortSignal) => {
    const q = asOf ? `?asOf=${enc(asOf)}` : "";
    const r = await call("GET", `/api/cases/${enc(id)}/timeline${q}`, TimelineResponseSchema, undefined, signal);
    return Array.isArray(r) ? r : r.events;
  },
  decision: (id: string, body: { findingId: string; action: string; note?: string; idempotencyKey: string }, signal?: AbortSignal) =>
    call("POST", `/api/cases/${enc(id)}/decision`, z.unknown(), body, signal),
  dossier: (id: string, signal?: AbortSignal) => call("GET", `/api/cases/${enc(id)}/dossier`, z.record(z.string(), z.unknown()), undefined, signal),
  verify: (dossier: unknown, signal?: AbortSignal) => call("POST", "/api/dossier/verify", VerifyResponseSchema, dossier, signal),
  guard: (body: { text: string; origin: "reviewer" | "document" }, signal?: AbortSignal) => call("POST", "/api/guard", GuardResponseSchema, body, signal),
  results: (signal?: AbortSignal) => call("GET", "/results.json", ResultsFileSchema, undefined, signal),
  traceUrl: (runId: string) => `/api/runs/${enc(runId)}/trace`,
};

/**
 * Reads the investigation stream. A fetch reader is used instead of EventSource so that an error body is read as an
 * error (EventSource hides the status) and so that a dropped connection is reported once instead of silently retried,
 * which would repeat work on the server.
 */
export async function streamInvestigation(
  caseId: string,
  onEvent: (e: TraceEvent) => void,
  signal: AbortSignal,
): Promise<{ complete: boolean }> {
  let res: Response;
  try {
    res = await fetch(`/api/cases/${enc(caseId)}/investigate`, { headers: { Accept: "text/event-stream" }, signal });
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    throw new ApiError("UNAVAILABLE", "The Sakaime service could not be reached. This is on our side, not a finding about the evidence.", 0);
  }
  if (!res.ok || !res.body) throw await parseError(res);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let complete = false;
  const flush = (block: string) => {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).replace(/^ /, ""))
      .join("\n");
    if (!data) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      throw new ApiError("CONTRACT", "A stream event was not valid JSON.", 200);
    }
    const parsed = TraceEventSchema.safeParse(json);
    if (!parsed.success) throw new ApiError("CONTRACT", "A stream event did not match the trace contract.", 200, { issues: parsed.error.issues.slice(0, 4).map((i) => `${i.path.join(".")}: ${i.message}`) });
    onEvent(parsed.data);
    if (parsed.data.done) complete = true;
  };
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let at: number;
      while ((at = buffer.search(/\r?\n\r?\n/)) >= 0) {
        const block = buffer.slice(0, at);
        buffer = buffer.slice(at).replace(/^\r?\n\r?\n/, "");
        flush(block);
      }
    }
    if (buffer.trim()) flush(buffer);
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    if (e instanceof ApiError) throw e;
    throw new ApiError("UNAVAILABLE", "The stream was interrupted before the run finished.", 0);
  }
  return { complete };
}
