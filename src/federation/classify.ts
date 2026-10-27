/**
 * Failure classification for the Zetaris REST route.
 *
 * Observed behaviour this table is built from (docs/11-channel-intel.md s2 and the local install, 2026-10-27):
 *  - a stopped Spark context leaves the container healthcheck green while every query returns HTTP 400;
 *  - HTTP 400 "Could not create ResultSet: null" and thrift transport errors appear intermittently on clusters;
 *  - a missing Authorization header returns HTTP 401 with a plain-text body;
 *  - a wrong API key returns HTTP 400 with {"msg":"Not Allowed"}, not 401, and does so before the body is checked;
 *  - non-admin users with grants have seen "does not have access to USL" on USL tables;
 *  - a non-administrator who sends an administrator-only statement (COMPILE USL) gets HTTP 400 "User is not permitted to run this command";
 *  - SHOW TABLES / SHOW SCHEMAS without a target are refused with HTTP 400 "... are disabled".
 *
 * The rule that matters most: an infrastructure fault must never be read as "no access" or as "nothing found".
 * Message text is matched before the status code because the engine reports infrastructure faults as HTTP 400.
 */
import type { FailureClass } from "../ports/index.ts";

export interface FailureInput {
  /** HTTP status, when a response arrived. */
  status?: number;
  /** Response body text. */
  body?: string;
  /** Node/undici error code, for example ECONNREFUSED. */
  code?: string;
  /** Error message when no response arrived. */
  message?: string;
  timedOut?: boolean;
}

export interface Classified {
  failure: FailureClass;
  /** Stable machine-readable cause, kept in PortError.detail.reason. */
  reason: string;
  retryable: boolean;
  /** Short human text with secrets already removed. */
  text: string;
}

const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "EPIPE",
  "UND_ERR_SOCKET", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_CLOSED",
]);

const TRANSIENT: ReadonlyArray<readonly [RegExp, string]> = [
  [/stopped\s+sparkcontext|sparkcontext\s+(was|has been|is)\s+(shut\s?down|stopped|closed)/i, "SPARK_CONTEXT_STOPPED"],
  [/could not create resultset/i, "RESULTSET_NOT_CREATED"],
  [/ttransportexception|tprotocolexception|org\.apache\.thrift|thrift\s*(transport|protocol|exception|error)/i, "THRIFT_TRANSPORT"],
  [/outofmemoryerror|java heap space|gc overhead limit/i, "OUT_OF_MEMORY"],
  [/broken pipe|connection reset|connection refused|socket (is )?closed|sockettimeoutexception|read timed out|eofexception|unexpected end of stream/i, "CONNECTION_LOST"],
  [/timed? ?out|timeout/i, "TIMEOUT"],
  [/service unavailable|temporar(il)?y unavailable|try again later|too many requests|rate limit|server is (busy|overloaded)/i, "OVERLOADED"],
];

const FORBIDDEN: ReadonlyArray<readonly [RegExp, string]> = [
  [/does not have access to usl/i, "NO_USL_ACCESS"],
  [/(does not have|has no|lacks?|without)\s+(the\s+)?(access|permission|privilege)s?\b/i, "NO_ACCESS"],
  // What the engine says to a non-administrator who sends an administrator-only statement ("User is not permitted to run this command").
  [/\b(?:is|are)\s+not\s+permitted\b|\bnot\s+permitted\s+to\b/i, "NOT_PERMITTED"],
  [/access denied|permission denied|not authori[sz]ed|unauthori[sz]ed|forbidden|insufficient privilege/i, "ACCESS_DENIED"],
  [/administrators?\s+only|requires?\s+administrator|admin(istrator)?\s+(role|privilege|access)\s+(is\s+)?required/i, "ADMIN_ONLY"],
  // The whole message, not a substring: Spark's parser also says "Operation not allowed: ..." for unsupported SQL.
  [/^\s*not allowed\.?\s*$/i, "NOT_ALLOWED"],
  [/invalid value for: header authorization|authorization header missing|invalid (api )?(key|token)|(api )?(key|token) (is )?(expired|invalid|revoked)/i, "BAD_CREDENTIAL"],
];

const INVALID: ReadonlyArray<readonly [RegExp, string]> = [
  [/parseexception|mismatched input|no viable alternative|syntax error|extraneous input/i, "SYNTAX"],
  [/table or view not found|cannot resolve|unresolved|analysisexception|does not exist|not found/i, "UNRESOLVED"],
  [/are disabled|is disabled/i, "DISABLED_STATEMENT"],
];

/** Pull readable text out of a JSON or plain body. Never returns more than 400 characters. */
export function extractMessage(body: string | undefined): string {
  if (!body) return "";
  const text = body.trim();
  try {
    const json: unknown = JSON.parse(text);
    const parts: string[] = [];
    const walk = (v: unknown, depth: number): void => {
      if (depth > 3 || parts.join(" ").length > 400) return;
      if (typeof v === "string") parts.push(v);
      else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
      else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) if (/^(msg|message|error|errors|detail|details|reason|cause)$/i.test(k)) walk(x, depth + 1);
    };
    walk(json, 0);
    if (parts.length > 0) return parts.join(" ").slice(0, 400);
  } catch {
    /* not JSON: use the text as is */
  }
  return text.slice(0, 400);
}

/** Replace every secret and any bearer token in text. Applied to everything that can reach a log or an error. */
export function scrub(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join("(key)");
  return out.replace(/bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, "Bearer (key)");
}

function firstMatch(table: ReadonlyArray<readonly [RegExp, string]>, text: string): string | undefined {
  return table.find(([re]) => re.test(text))?.[1];
}

export function classifyFailure(input: FailureInput): Classified {
  const text = extractMessage(input.body) || input.message || "";
  const { status } = input;

  if (input.timedOut) return { failure: "UNAVAILABLE", reason: "TIMEOUT", retryable: true, text: "the engine did not answer in time" };
  if (status === undefined) {
    if (input.code && NETWORK_CODES.has(input.code)) {
      return { failure: "UNAVAILABLE", reason: input.code === "ECONNREFUSED" ? "CONNECTION_REFUSED" : "NETWORK", retryable: true, text: `${input.code}` };
    }
    return { failure: "UNAVAILABLE", reason: "NETWORK", retryable: true, text: text || input.code || "network failure" };
  }

  if (status === 401 || status === 403) {
    return { failure: "FORBIDDEN", reason: firstMatch(FORBIDDEN, text) ?? `HTTP_${status}`, retryable: false, text };
  }
  const transient = firstMatch(TRANSIENT, text);
  if (transient) return { failure: "UNAVAILABLE", reason: transient, retryable: true, text };
  const forbidden = firstMatch(FORBIDDEN, text);
  if (forbidden) return { failure: "FORBIDDEN", reason: forbidden, retryable: false, text };
  const invalid = firstMatch(INVALID, text);
  if (invalid) return { failure: "INVALID", reason: invalid, retryable: false, text };

  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    return { failure: "UNAVAILABLE", reason: `HTTP_${status}`, retryable: true, text };
  }
  return { failure: "INVALID", reason: `HTTP_${status}`, retryable: false, text };
}
