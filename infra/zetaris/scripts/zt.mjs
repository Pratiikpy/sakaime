// Minimal Zetaris REST client for the Sakaime infrastructure scripts. Uses password login and the returned JWT, so no API
// key is created or read by a script (the vendor guide asks that API keys are created by hand in the UI).
//
// Identities come from the repository .env:
//   admin    SAKAIME_ZETARIS_ADMIN_EMAIL (sakaime.env) / SAKAIME_ZETARIS_ADMIN_PASSWORD
//   reader   SAKAIME_ZETARIS_READER_EMAIL / SAKAIME_ZETARIS_READER_PASSWORD        (non-admin, view only)
//   reviewer SAKAIME_ZETARIS_REVIEWER_EMAIL / SAKAIME_ZETARIS_REVIEWER_PASSWORD    (non-admin, not assigned to the case)
//   assigned SAKAIME_ZETARIS_ASSIGNED_EMAIL / SAKAIME_ZETARIS_ASSIGNED_PASSWORD    (non-admin, assigned to the case)
// Secrets are never logged.

import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const repoRoot = resolve(here, '..', '..', '..');

const parseEnv = (path) => {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) out[m[1]] = m[2].trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
};
const config = { ...parseEnv(join(here, '..', 'sakaime.env')), ...parseEnv(join(repoRoot, '.env')) };
export const cfg = (key) => config[key];

export const baseUrl = process.env.ZT_BASE_URL ?? `http://127.0.0.1:${cfg('API_PORT') ?? '8988'}`;
export const internalUrl = `http://127.0.0.1:${cfg('API_INTERNAL_PORT') ?? '8989'}`;
export const api = `${baseUrl}/api/v1.0`;

export const identities = {
  admin: { email: cfg('ZETARIS_ADMIN_EMAIL'), password: cfg('SAKAIME_ZETARIS_ADMIN_PASSWORD') },
  reader: { email: cfg('SAKAIME_ZETARIS_READER_EMAIL'), password: cfg('SAKAIME_ZETARIS_READER_PASSWORD') },
  reviewer: { email: cfg('SAKAIME_ZETARIS_REVIEWER_EMAIL'), password: cfg('SAKAIME_ZETARIS_REVIEWER_PASSWORD') },
  assigned: { email: cfg('SAKAIME_ZETARIS_ASSIGNED_EMAIL'), password: cfg('SAKAIME_ZETARIS_ASSIGNED_PASSWORD') },
};

const sessions = new Map();
let orgId = process.env.ZT_ORG_ID ?? '1';
export const setOrgId = (id) => {
  orgId = String(id);
};

const basic = ({ email, password }) => `Basic ${Buffer.from(`${email}:${password}`).toString('base64')}`;

export async function login(who) {
  const id = typeof who === 'string' ? identities[who] : who;
  if (!id?.email || !id?.password) throw new Error(`identity ${typeof who === 'string' ? who : id?.email} is not configured`);
  const cached = sessions.get(id.email);
  if (cached && cached.exp > Date.now() + 30_000) return cached.token;
  const res = await fetch(`${api}/auth/login`, {
    headers: { Authorization: basic(id), 'X-Org-ID': orgId, 'X-Request-ID': randomUUID() },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.idToken) throw new Error(`login failed for ${id.email}: HTTP ${res.status}`);
  let exp = Date.now() + 10 * 60_000;
  try {
    const payload = JSON.parse(Buffer.from(body.idToken.split('.')[1], 'base64url').toString('utf8'));
    if (payload.exp) exp = payload.exp * 1000;
  } catch {
    /* keep the default lifetime */
  }
  sessions.set(id.email, { token: body.idToken, exp });
  return body.idToken;
}

/** Raw REST call. Returns {status, body, ms}; never throws on an HTTP error status. */
export async function rest(who, method, path, { body, query, headers, timeoutMs = 60_000, requestId = randomUUID() } = {}) {
  const token = await login(who);
  const url = new URL(path.startsWith('http') ? path : `${api}${path}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const started = performance.now();
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'X-Org-ID': orgId,
      'X-Request-ID': requestId,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = text;
  }
  return { status: res.status, body: parsed, ms: Math.round(performance.now() - started), requestId };
}

/**
 * Runs one Lightning SQL statement. Values come back as strings; `rows` zips them with the headers.
 * `outcome` is OK, FORBIDDEN, UNAVAILABLE or ERROR so callers never confuse an empty result with a failure.
 */
export async function sql(who, statement, { limit = 5000, queryId = randomUUID(), requestId = randomUUID(), timeoutMs = 90_000 } = {}) {
  let r;
  const started = performance.now();
  try {
    r = await rest(who, 'POST', '/sql-editor/sqls/run', { body: { queryId, sql: statement, source: 'SqlEditor', limit }, timeoutMs, requestId });
  } catch (error) {
    // A refused connection, a reset or a client timeout: the platform could not be asked, which is not the same as "no rows".
    const cause = error?.cause?.code ? ` (${error.cause.code})` : '';
    return { outcome: 'UNAVAILABLE', queryId, requestId, status: 0, ms: Math.round(performance.now() - started), message: `${error?.name === 'TimeoutError' ? 'client timeout' : String(error?.message ?? error)}${cause}`, headers: [], rows: [], total: 0 };
  }
  const { status, body, ms } = r;
  if (status === 200 && body && Array.isArray(body.headers)) {
    const rows = (body.data ?? []).map((row) => Object.fromEntries(body.headers.map((h, i) => [h, row[i]])));
    return { outcome: 'OK', queryId, requestId, status, ms, serverMs: body.timeUsed, headers: body.headers, rows, total: Number(body.total ?? rows.length), truncated: Number(body.total ?? rows.length) > rows.length };
  }
  const message = typeof body === 'string' ? body : JSON.stringify(body);
  const outcome = status === 401 || status === 403 || /does not have (access|privileges)|not permitted to (run|execute)|permission denied|access denied|forbidden/i.test(message) ? 'FORBIDDEN' : status === 0 || status >= 500 || /stopped SparkContext|ResultSet: null|Transport/i.test(message) ? 'UNAVAILABLE' : 'ERROR';
  return { outcome, queryId, requestId, status, ms, message: message.slice(0, 600), headers: [], rows: [], total: 0 };
}

/** Same as sql() but throws unless the outcome is OK. */
export async function sqlOk(who, statement, options) {
  const r = await sql(who, statement, options);
  if (r.outcome !== 'OK') throw new Error(`${r.outcome} (HTTP ${r.status}) for: ${statement.slice(0, 120)} :: ${r.message}`);
  return r;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
