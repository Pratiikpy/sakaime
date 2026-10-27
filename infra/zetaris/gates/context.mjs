// Shared context for the gate scripts: a recording SQL runner, REST access and small assertion helpers.
// Every statement a gate sends is kept with its request id, query id, identity, outcome and timing so the audit gate can
// cross-check them and the leak sweep can scan everything an identity received.

import * as zt from '../scripts/zt.mjs';

export function createContext() {
  const trace = [];
  const received = { reader: [], reviewer: [], assigned: [], admin: [] };

  async function q(who, statement, options = {}) {
    const r = await zt.sql(who, statement, options);
    trace.push({ who, sql: statement.replace(/\s+/g, ' ').trim().slice(0, 240), requestId: r.requestId, queryId: r.queryId, outcome: r.outcome, status: r.status, ms: r.ms, rows: r.rows?.length ?? 0, at: new Date().toISOString() });
    if (received[who]) received[who].push({ headers: r.headers, rows: r.rows, message: r.message });
    return r;
  }

  const clip = (value, n = 160) => {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    return text.length > n ? `${text.slice(0, n)}...` : text;
  };

  return { q, trace, received, clip, zt };
}

/** A gate result: verdict is PASS, FAIL, PENDING or BLOCKED; evidence lines carry the real command and output. */
export class Gate {
  constructor(id, title) {
    this.id = id;
    this.title = title;
    this.checks = [];
    this.notes = [];
    this.evidence = [];
    this.startedAt = Date.now();
  }

  check(name, ok, detail = '') {
    this.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
    return ok;
  }

  note(text) {
    this.notes.push(text);
  }

  show(command, output) {
    this.evidence.push({ command: String(command).replace(/\s+/g, ' ').trim(), output: typeof output === 'string' ? output : JSON.stringify(output) });
  }

  finish(forced) {
    const failed = this.checks.filter((c) => !c.ok);
    const verdict = forced ?? (this.checks.length === 0 ? 'PENDING' : failed.length === 0 ? 'PASS' : 'FAIL');
    return { id: this.id, title: this.title, verdict, seconds: Math.round((Date.now() - this.startedAt) / 100) / 10, checks: this.checks, notes: this.notes, evidence: this.evidence };
  }
}
