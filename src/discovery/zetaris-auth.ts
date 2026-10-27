/**
 * Connecting the federation port to the local Zetaris stack (infra/zetaris/README.md).
 *
 * The stack authenticates every identity with a password login that returns a JWT; the vendor guide asks that API keys are
 * created by hand in the UI and never by a script, so no key is created here. The JWT is used as the bearer credential of
 * the port. Two identities are opened: the read-only agent identity (the port's default) and the administrator, which only
 * runs the DDL of registration. Passwords are read from the environment by name and are never logged or returned.
 */
import { randomUUID } from "node:crypto";
import { ZetarisPort } from "../federation/zetaris-port.ts";
import { PortError } from "../ports/index.ts";

export interface ZetarisAuthConfig {
  /** Base of the REST route, for example http://127.0.0.1:8988/api/v1.0 */
  restUrl: string;
  orgId: string;
  admin: { email: string; password: string };
  reader: { email: string; password: string };
}

/** Reads the connection settings by variable name. Returns null, naming what is missing, when the stack is not configured. */
export function zetarisAuthFromEnv(env: Record<string, string | undefined>): { config: ZetarisAuthConfig } | { missing: string[] } {
  const port = env["API_PORT"] ?? "8988";
  const need = {
    ZETARIS_ADMIN_EMAIL: env["ZETARIS_ADMIN_EMAIL"] ?? "admin@sakaime.example",
    SAKAIME_ZETARIS_ADMIN_PASSWORD: env["SAKAIME_ZETARIS_ADMIN_PASSWORD"],
    SAKAIME_ZETARIS_READER_EMAIL: env["SAKAIME_ZETARIS_READER_EMAIL"],
    SAKAIME_ZETARIS_READER_PASSWORD: env["SAKAIME_ZETARIS_READER_PASSWORD"],
  };
  const missing = Object.entries(need).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length > 0) return { missing };
  return {
    config: {
      restUrl: env["ZETARIS_REST_URL"] ?? `http://127.0.0.1:${port}/api/v1.0`,
      orgId: env["ZETARIS_ORG_ID"] ?? "1",
      admin: { email: need.ZETARIS_ADMIN_EMAIL, password: need.SAKAIME_ZETARIS_ADMIN_PASSWORD! },
      reader: { email: need.SAKAIME_ZETARIS_READER_EMAIL!, password: need.SAKAIME_ZETARIS_READER_PASSWORD! },
    },
  };
}

export async function login(restUrl: string, orgId: string, who: { email: string; password: string }, fetchImpl: typeof fetch = fetch): Promise<string> {
  let res: Response;
  try {
    res = await fetchImpl(`${restUrl.replace(/\/+$/, "")}/auth/login`, {
      headers: { Authorization: `Basic ${Buffer.from(`${who.email}:${who.password}`).toString("base64")}`, "X-Org-ID": orgId, "X-Request-ID": randomUUID() },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    throw new PortError("UNAVAILABLE", `Zetaris did not answer the login request: ${(e as Error).message}`, { retryable: true });
  }
  const body = (await res.json().catch(() => ({}))) as { idToken?: string };
  if (!res.ok || typeof body.idToken !== "string") {
    // The status is enough to act on. The response body is not echoed: it can hold the account name.
    throw new PortError(res.status === 401 || res.status === 403 ? "FORBIDDEN" : "UNAVAILABLE", `Zetaris refused the login for ${who.email} (HTTP ${res.status})`, { status: res.status });
  }
  return body.idToken;
}

/** A federation port with two identities: `default` (read-only) and `admin` (registration DDL). */
export async function openZetaris(config: ZetarisAuthConfig, fetchImpl: typeof fetch = fetch): Promise<ZetarisPort> {
  const [reader, admin] = await Promise.all([login(config.restUrl, config.orgId, config.reader, fetchImpl), login(config.restUrl, config.orgId, config.admin, fetchImpl)]);
  return new ZetarisPort({
    restUrl: config.restUrl,
    orgId: config.orgId,
    identities: { default: { apiKey: reader }, admin: { apiKey: admin } },
    defaultIdentity: "default",
    fetch: fetchImpl,
    maxAttempts: 2,
  });
}
