#!/usr/bin/env node
// Runs the verification gates of docs/03-zetaris-plan.md section 5 against the running stack and writes the evidence to
// infra/zetaris/.runtime/results/<timestamp>-gates.json.
//
//   node infra/zetaris/scripts/verify.mjs                 all gates except the destructive kill drill
//   node infra/zetaris/scripts/verify.mjs Z-POL Z-AUD     selected gates
//   node infra/zetaris/scripts/verify.mjs --kill-drill    also run the kill drill (stops and restarts the API container)

import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext } from '../gates/context.mjs';
import { repoRoot } from './zt.mjs';

const order = ['z-head', 'z-rest', 'z-pol', 'z-cat', 'z-aud', 'z-tt', 'z-usl', 'z-pdf', 'z-nl', 'kill-drill'];
const args = process.argv.slice(2);
const withKill = args.includes('--kill-drill');
const wanted = args.filter((a) => !a.startsWith('--')).map((a) => a.toLowerCase());
const selected = order.filter((id) => (wanted.length ? wanted.includes(id) : id !== 'kill-drill' || withKill));

const ctx = createContext();
const results = [];
for (const id of selected) {
  process.stdout.write(`running ${id} ... `);
  try {
    const gate = await import(`../gates/${id}.mjs`);
    const result = await gate.run(ctx);
    results.push(result);
    console.log(`${result.verdict} (${result.seconds} s)`);
  } catch (error) {
    results.push({ id: id.toUpperCase(), title: id, verdict: 'FAIL', seconds: 0, checks: [{ name: 'gate ran to completion', ok: false, detail: String(error?.stack ?? error).slice(0, 600) }], notes: [], evidence: [] });
    console.log('FAIL (exception)');
  }
}

console.log('');
for (const r of results) {
  console.log(`${r.verdict.padEnd(8)} ${r.id.padEnd(10)} ${r.title}`);
  for (const c of r.checks) console.log(`           ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}${c.detail ? `  [${c.detail.slice(0, 200)}]` : ''}`);
  for (const n of r.notes) console.log(`           note ${n}`);
}

const dir = join(repoRoot, 'infra', 'zetaris', '.runtime', 'results');
mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
writeFileSync(join(dir, `${stamp}-gates.json`), JSON.stringify({ at: new Date().toISOString(), results, trace: ctx.trace }, null, 2));
console.log(`\nevidence written to infra/zetaris/.runtime/results/${stamp}-gates.json (${ctx.trace.length} statements traced)`);
process.exit(results.some((r) => r.verdict === 'FAIL') ? 1 : 0);
