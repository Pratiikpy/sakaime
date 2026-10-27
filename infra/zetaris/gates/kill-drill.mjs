// Kill drill: what the product sees when the platform fails, and how long a failure takes to show.
//   Part A  the API container is stopped: time to failure of a dependent command, time to recovery.
//   Part B  the query engine runs out of memory: does the container health check notice, and what does a query return?
// Part B is destructive for this stack (the driver may need a restart) and only runs with --kill-drill.

import { spawnSync } from 'node:child_process';
import { Gate } from './context.mjs';

const docker = (...args) => spawnSync('docker', args, { encoding: 'utf8' });
const health = (container) => docker('inspect', container, '--format', '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}').stdout.trim();

async function realCheck(ctx, who = 'reader') {
  // The probe the product uses: a real SELECT 1 through the REST route, classified. A container health check is not it.
  const started = performance.now();
  const r = await ctx.q(who, 'SELECT 1', { timeoutMs: 20_000 });
  return { outcome: r.outcome, status: r.status, ms: Math.round(performance.now() - started), message: r.message };
}

async function waitForOk(ctx, limitMs = 600_000) {
  const started = performance.now();
  while (performance.now() - started < limitMs) {
    const c = await realCheck(ctx, 'admin');
    if (c.outcome === 'OK') return Math.round(performance.now() - started);
    await new Promise((r) => setTimeout(r, 3000));
  }
  return -1;
}

export async function run(ctx) {
  const gate = new Gate('KILL', 'Kill drill: API container stopped, engine out of memory');
  const project = 'sakaime-zetaris';

  // Part A ------------------------------------------------------------------------------------------------------------
  const before = await realCheck(ctx);
  gate.check('before: SELECT 1 answers for the agent identity', before.outcome === 'OK', `${before.ms} ms`);
  const stopStarted = performance.now();
  docker('stop', '-t', '5', `${project}-api-1`);
  gate.note(`docker stop of the API container took ${Math.round(performance.now() - stopStarted)} ms.`);
  // Five probes, three seconds apart, each timed on its own: a stopped service does not always fail the same way.
  const probes = [];
  for (let i = 0; i < 5; i += 1) {
    probes.push(await realCheck(ctx));
    if (i < 4) await new Promise((r) => setTimeout(r, 3000));
  }
  gate.check('during: every probe reports UNAVAILABLE (never FORBIDDEN, never an empty OK)', probes.every((p) => p.outcome === 'UNAVAILABLE'), probes.map((p) => `${p.outcome} ${p.ms} ms`).join(', '));
  gate.note(`Time to failure of SELECT 1 with the API stopped, five probes 3 s apart (client timeout 20 s): ${probes.map((p) => `${p.ms} ms`).join(', ')}. Reason given: ${probes.map((p) => p.message).filter((m, i, a) => a.indexOf(m) === i).join(' / ')}. The failure is immediate because nothing listens on the API port; a service that accepts the connection and never answers would instead run to the client timeout, which was not observed here, so every Sakaime call still carries its own timeout.`);
  const during = probes[0];
  const duringHeadline = await ctx.q('reader', 'SELECT count(*) AS n FROM hospital.cases', { timeoutMs: 20_000 });
  gate.check('during: a data query also reports UNAVAILABLE with zero rows', duringHeadline.outcome === 'UNAVAILABLE' && duringHeadline.rows.length === 0, `${duringHeadline.outcome} after ${duringHeadline.ms} ms`);
  const driverDuringApiStop = health(`${project}-driver-1`);
  gate.note(`While the API was stopped the driver container reported ${driverDuringApiStop}: the engine and the REST layer fail independently, and only the REST layer is on the product's path.`);
  const startAt = performance.now();
  docker('start', `${project}-api-1`);
  const recoveredMs = await waitForOk(ctx);
  gate.check('after start: SELECT 1 answers again', recoveredMs > 0, recoveredMs > 0 ? `${Math.round(performance.now() - startAt)} ms after docker start` : 'did not recover within 10 minutes');
  gate.show('API container stop and start', { downFailureMs: during.ms, dataQueryFailureMs: duringHeadline.ms, recoveryMsAfterStart: recoveredMs });

  // Part B ------------------------------------------------------------------------------------------------------------
  if (!process.argv.includes('--kill-drill')) {
    gate.note('Part B (engine out of memory) was not run: pass --kill-drill to run it. It can force a driver restart.');
    return gate.finish();
  }
  const healthBefore = health(`${project}-driver-1`);
  const heavy = "SELECT size(collect_list(concat(cast(x AS string), repeat('a', 200)))) AS n FROM (SELECT explode(sequence(1, 40000000)) AS x) t";
  const startedAt = Date.now();
  const oom = await ctx.q('admin', heavy, { timeoutMs: 120_000 });
  gate.show('memory-hungry statement (collect_list of 40 million 200-character strings, driver heap 1536m)', { outcome: oom.outcome, status: oom.status, ms: oom.ms, message: ctx.clip(oom.message, 300) });
  gate.check('the failing statement is reported as UNAVAILABLE (a transport error), never as an empty or forbidden result', oom.outcome === 'UNAVAILABLE', `${oom.outcome} HTTP ${oom.status} after ${oom.ms} ms: ${ctx.clip(oom.message, 80)}`);

  // Timeline without intervention: container state, health and a real SELECT 1 every 3 seconds until service returns.
  const timeline = [];
  let recoveredAfter = -1;
  const limit = Date.now() + 600_000;
  while (Date.now() < limit) {
    const c = await realCheck(ctx, 'admin');
    timeline.push({ t: Math.round((Date.now() - startedAt) / 1000), container: health(`${project}-driver-1`), select1: c.outcome, status: c.status });
    if (c.outcome === 'OK') {
      recoveredAfter = Math.round((Date.now() - startedAt) / 1000);
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
  const compact = timeline.filter((p, i, a) => i === 0 || p.container !== a[i - 1].container || p.select1 !== a[i - 1].select1).map((p) => `${p.t}s ${p.container} SELECT1=${p.select1}${p.status ? `/${p.status}` : ''}`);
  gate.show('timeline after the memory-hungry statement (state changes only)', compact);
  const restarts = docker('inspect', `${project}-driver-1`, '--format', '{{.RestartCount}} oomkilled={{.State.OOMKilled}} exit={{.State.ExitCode}}').stdout.trim();
  gate.note(`Driver container before the statement: ${healthBefore}. After it: restart count / OOM flag / exit code = ${restarts}. Service returned ${recoveredAfter > 0 ? `${recoveredAfter} s after the statement was sent, without manual action` : 'NOT within 10 minutes'}.`);
  gate.check('service returns without manual action (the container restart policy brings the engine back)', recoveredAfter > 0, recoveredAfter > 0 ? `${recoveredAfter} s` : 'no recovery');
  const greenWhileFailing = timeline.some((p) => p.select1 !== 'OK' && /healthy/.test(p.container));
  gate.check(greenWhileFailing ? 'RECORDED: the container health check was green while queries failed' : 'RECORDED: the container health check was not green while queries failed in this run', true, greenWhileFailing ? 'a health check cannot be the readiness probe' : 'the stopped-context case (healthy container, failing queries) was NOT reproduced; this build exits the JVM on out-of-memory instead');
  return gate.finish();
}
