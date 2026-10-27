// Z-AUD: is a per-query audit record readable, and does it list the queries we traced? The product keeps a trace line per
// statement with the request id it sent; this gate checks those request ids against the platform's own records.

import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { Gate } from './context.mjs';

function auditDb(sql, pw) {
  const r = spawnSync('docker', ['exec', '-e', `PGPASSWORD=${pw}`, 'sakaime-zetaris-postgres-1', 'psql', '-U', 'zetaris', '-d', 'audit', '-At', '-F', '|', '-c', sql], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : `ERROR ${r.stderr.trim()}`;
}

export async function run(ctx) {
  const gate = new Gate('Z-AUD', 'Per-query audit record against our trace');
  const z = ctx.zt;
  const from = new Date(Date.now() - 5_000).toISOString();

  // A known set of statements from the agent identity: successes, a refusal, an error.
  const plan = [
    ['SELECT 1', 'OK'],
    ['SELECT count(*) AS n FROM hospital.cases', 'OK'],
    ['SELECT count(*) AS n FROM sk_registry.fda_510k', 'OK'],
    ['SELECT count(*) AS n FROM sk_vendor.vendor_claims', 'OK'],
    ['SELECT k_number FROM sk_registry.fda_510k WHERE k_number = \'K200667\'', 'OK'],
    ['SELECT * FROM hospital.no_such_table', 'ERROR'],
    ['CREATE LIGHTNING DATABASE agent_must_not_create', 'FORBIDDEN'],
    ['SELECT count(*) AS n FROM sk_lake.evidence.registry_snapshot', null],
  ];
  const sent = [];
  for (const [statement, expected] of plan) {
    const r = await ctx.q('reader', statement);
    sent.push({ statement, expected, requestId: r.requestId, queryId: r.queryId, outcome: r.outcome });
  }
  // One statement as admin so the log must tell the identities apart.
  const adminCall = await ctx.q('admin', 'SELECT count(*) AS n FROM hospital.requirements');
  sent.push({ statement: 'admin: SELECT count(*) FROM hospital.requirements', requestId: adminCall.requestId, queryId: adminCall.queryId, outcome: adminCall.outcome, who: 'admin' });
  const to = new Date(Date.now() + 5_000).toISOString();
  gate.check('every statement got a distinct request id from the client', new Set(sent.map((s) => s.requestId)).size === sent.length, `${sent.length} statements`);

  // (a) The administrator's REST activity log.
  const records = [];
  for (let page = 1; page <= 10; page += 1) {
    const r = await z.rest('admin', 'GET', '/audit/logs', { query: { startTime: from, endTime: to, pageLimit: 100, pageNumber: page } });
    if (r.status !== 200) {
      gate.check('admin can read /audit/logs', false, `HTTP ${r.status}`);
      break;
    }
    records.push(...r.body.records);
    if (page >= r.body.totalPages) break;
  }
  const byRequest = new Map(records.map((r) => [r.requestId, r]));
  const missing = sent.filter((s) => !byRequest.has(s.requestId));
  gate.check('admin REST audit log lists every traced request id', missing.length === 0, `${sent.length - missing.length} of ${sent.length} found${missing.length ? `; missing: ${missing.map((m) => m.statement).join(' | ')}` : ''}`);
  const identityOk = sent.every((s) => !byRequest.has(s.requestId) || String(byRequest.get(s.requestId).userEmail).toUpperCase().includes((s.who === 'admin' ? z.identities.admin.email : z.identities.reader.email).toUpperCase()));
  gate.check('each audit record names the identity that sent it (admin versus agent)', identityOk, '');
  const successMismatch = sent.filter((s) => byRequest.has(s.requestId) && (byRequest.get(s.requestId).finishSuccessfully === true) !== (s.outcome === 'OK'));
  gate.check('the success flag in the audit record agrees with the outcome we saw', successMismatch.length === 0, successMismatch.length ? successMismatch.map((m) => `${m.statement}: we saw ${m.outcome}, log says ${byRequest.get(m.requestId).finishSuccessfully}`).join('; ') : `refusal and error rows flagged unsuccessful`);
  const sample = byRequest.get(sent[6].requestId);
  gate.show('GET /audit/logs (admin) record for the refused CREATE LIGHTNING DATABASE', sample ?? 'not found');
  gate.check('the audit record carries no SQL text (documented limitation, recorded)', sample ? !('sql' in sample) && !('query' in sample) : false, `fields: ${sample ? Object.keys(sample).join(', ') : 'n/a'}`);

  // Alarm logic the product will use: a request id that was never sent to Zetaris must not be found.
  const forged = randomUUID();
  gate.check('a request id that was never sent (a replayed cassette posing as live) is not found', !byRequest.has(forged), forged);

  // (b) Non-admin access to the audit log.
  const readerAudit = await z.rest('reader', 'GET', '/audit/logs', { query: { startTime: from, endTime: to, pageLimit: 5, pageNumber: 1 } });
  gate.check('the agent identity cannot read the audit log', readerAudit.status >= 400, `HTTP ${readerAudit.status} ${JSON.stringify(readerAudit.body)}`);

  // (c) The per-user query history lists query ids, including refused and failed ones.
  const history = await z.rest('reader', 'GET', '/sql-editor/sqls/history');
  const histIds = new Map((history.body ?? []).map((h) => [h.id, h]));
  const histMissing = sent.filter((s) => !s.who && !histIds.has(s.queryId));
  gate.check('the agent identity query history lists every query id it sent', history.status === 200 && histMissing.length === 0, `${sent.filter((s) => !s.who).length - histMissing.length} of ${sent.filter((s) => !s.who).length} found`);
  gate.show('GET /sql-editor/sqls/history (agent) entry for the failed statement', histIds.get(sent[5].queryId) ?? 'not found');
  const adminSeesReader = (await z.rest('admin', 'GET', '/sql-editor/sqls/history')).body ?? [];
  gate.note(`The administrator's own history shows ${adminSeesReader.filter((h) => sent.some((s) => s.queryId === h.id && !s.who)).length} of the agent's query ids: history is per user, so only the REST activity log (admin) is an independent witness.`);

  // (d) Operator view of the metastore audit database, for completeness.
  const pw = z.cfg('SAKAIME_ZETARIS_PG_PASSWORD');
  const auditCount = auditDb(`select count(*) from sql_audit_log where user_email = '${z.identities.reader.email.toUpperCase()}' and start_time > now() - interval '3 minutes'`, pw);
  gate.note(`Operator read of audit.sql_audit_log: ${auditCount} rows for the agent identity in the last 3 minutes, against ${sent.filter((s) => !s.who).length} statements sent. The table keys on a hash of the SQL text and carries start and end time, identity and a success flag, but not our request or query ids and not row counts; the counts do not line up one to one, so it was not used for the cross-check.`);
  gate.note('The /audit/logs endpoint records the HTTP call (request id from the X-Request-ID header we send, identity, api name, time, success), not the SQL text or row counts. The vendor page promises "which sources were touched, row count and latency"; the REST log has timing only, and the operator-side SQL log has timing and the SQL text but neither sources touched nor row counts. The cross-check therefore matches on request id and identity, and cannot confirm which statement ran.');
  gate.note('Not tested: the DELETE /audit/logs/clear endpoint (described as deleting logs older than 30 days; whether it can remove newer entries is unknown) and tamper evidence.');
  return gate.finish();
}
