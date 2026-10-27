#!/usr/bin/env node
// Waits until the Zetaris platform answers a real query as the administrator. A container health check is not enough:
// after an out-of-memory event the Spark context can stop while the container stays healthy and every query returns
// HTTP 400, so readiness is defined as `SELECT 1` succeeding through the REST route.
//
// Usage: node infra/zetaris/scripts/wait-ready.mjs [timeoutSeconds]   (default 900)

import { sleep, sql } from './zt.mjs';

const timeoutSeconds = Number(process.argv[2] ?? 900);
const deadline = Date.now() + timeoutSeconds * 1000;
let lastMessage = '';
let attempt = 0;

while (Date.now() < deadline) {
  attempt += 1;
  const r = await sql('admin', 'SELECT 1', { timeoutMs: 20_000 }).catch((e) => ({ outcome: 'UNAVAILABLE', message: String(e) }));
  if (r.outcome === 'OK' && r.rows[0] && Object.values(r.rows[0])[0] === '1') {
    console.log(`ready: SELECT 1 answered in ${r.ms} ms after ${attempt} attempt(s)`);
    process.exit(0);
  }
  const message = `${r.outcome}${r.status ? ` HTTP ${r.status}` : ''} ${r.message ?? ''}`.trim().slice(0, 160);
  if (message !== lastMessage) console.log(`waiting: ${message}`);
  lastMessage = message;
  await sleep(5000);
}
console.error(`not ready after ${timeoutSeconds} s: ${lastMessage}`);
process.exit(1);
