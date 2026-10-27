/**
 * Typed error bodies (ErrorBodySchema in contract.ts) from the failures the product already names.
 *
 * Every PortError carries a failure class; the class decides the HTTP status and is repeated in the body, so a client can tell
 * a source that is down (UNAVAILABLE) from a request the product refuses (REFUSED) from malformed input (INVALID). No error
 * body carries a secret: the text is scrubbed of any configured key or token before it leaves.
 */
import { ZodError } from "zod";
import { CompilerInputError } from "../compiler/index.ts";
import { DecisionRejectedError, IdempotencyConflictError } from "../dossier/index.ts";
import { PortError, type FailureClass } from "../ports/index.ts";
import { CancelledError } from "../service/util.ts";
import type { ErrorBodySchema } from "./contract.ts";
import type { z } from "zod";

export type ErrorBody = z.infer<typeof ErrorBodySchema>;

const STATUS: Record<FailureClass, number> = {
  INVALID: 400,
  FORBIDDEN: 403,
  REFUSED: 422,
  UNAVAILABLE: 503,
  BLOCKED: 503,
  DRIFTED: 502,
  TRUNCATED: 502,
};

export interface Mapped {
  status: number;
  body: ErrorBody;
}

/** Replaces any configured secret that appears in `text`. Matching is on the exact value, never on a pattern that could eat prose. */
export function redact(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const [name, value] of Object.entries(env)) {
    if (!value || value.length < 8 || !/(KEY|TOKEN|PASSWORD|SECRET)/i.test(name)) continue;
    out = out.split(value).join("[redacted]");
  }
  return out;
}

function scrubDetail(detail: Record<string, unknown> | undefined, env: Record<string, string | undefined>): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  const text = JSON.stringify(detail, (_k, v) => (typeof v === "function" ? undefined : v));
  try {
    return JSON.parse(redact(text, env)) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * For an error nobody anticipated, the message is shown only after removing what could identify the machine or carry a
 * credential: bearer and key-shaped tokens, absolute file paths, and stack lines.
 */
export function scrubUnexpected(text: string, env: Record<string, string | undefined>): string {
  return redact(text, env)
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "[redacted]")
    .replace(/\b(?:nvapi|sk|pk|ghp|gho|xox[abp]|AKIA)[-_A-Za-z0-9]{8,}/g, "[redacted]")
    .replace(/(?:[A-Za-z]:[\/]|\/(?:Users|home|var|opt|etc|tmp|root)\/)[^\s"'`)]*/g, "[path]")
    .replace(/\s+at\s+\S+\s*\([^)]*\)/g, "");
}

export function mapError(error: unknown, env: Record<string, string | undefined>): Mapped {
  const body = (failure: string, message: string, detail?: Record<string, unknown>): ErrorBody => ({
    error: { failure, message: redact(message, env), ...(detail ? { detail: scrubDetail(detail, env) ?? {} } : {}) },
  });
  if (error instanceof PortError) {
    const reason = error.detail?.["reason"];
    const status = typeof reason === "string" && /^UNKNOWN_/.test(reason) ? 404 : STATUS[error.failure];
    const { retryable: _r, ...rest } = error.detail ?? {};
    return { status, body: body(error.failure, error.message, Object.keys(rest).length ? rest : undefined) };
  }
  if (error instanceof ZodError) {
    return { status: 400, body: body("INVALID", `the request does not match the contract: ${error.issues[0]?.path.join(".") || "(body)"}: ${error.issues[0]?.message ?? "invalid"}`, { issues: error.issues.slice(0, 8).map((i) => ({ path: i.path.join("."), message: i.message })) }) };
  }
  if (error instanceof CompilerInputError) {
    return { status: 400, body: body("INVALID", error.message, { issues: error.issues.slice(0, 8) }) };
  }
  if (error instanceof IdempotencyConflictError) {
    return { status: 409, body: body("INVALID", error.message, { reason: "IDEMPOTENCY_CONFLICT" }) };
  }
  if (error instanceof DecisionRejectedError) {
    return { status: 400, body: body("INVALID", error.message, { reason: "DECISION_REJECTED" }) };
  }
  if (error instanceof CancelledError) {
    return { status: 499, body: body("UNAVAILABLE", error.message, { reason: "CANCELLED" }) };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { status: 500, body: body("UNAVAILABLE", `an unexpected error stopped the request: ${scrubUnexpected(message, env).slice(0, 200)}`, { reason: "INTERNAL" }) };
}
