// Z-REST: can a REST table read small bounded openFDA and ClinicalTrials.gov JSON with nested arrays, do the counts
// match a direct call, and how long does a query take? Also records that the request is re-issued on every query.

import { spawnSync } from 'node:child_process';
import { Gate } from './context.mjs';

const UA = { 'User-Agent': 'sakaime-research/1.0 (read-only)' };
const CT_LIVE = 'https://clinicaltrials.gov/api/v2/studies?query.intr=EyeArt&pageSize=15&countTotal=true&fields=NCTId%2CBriefTitle%2CInterventionName%2CLeadSponsorName%2CEnrollmentCount%2CStartDate%2COverallStatus';
const FDA_LIVE = 'https://api.fda.gov/device/510k.json?search=k_number:K200667';

async function direct(url) {
  const started = performance.now();
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(30_000) });
  const body = await res.json();
  return { status: res.status, body, ms: Math.round(performance.now() - started) };
}

const getCount = (containerName) => {
  // http.server writes its access log to stderr, which `docker logs` relays on stderr.
  const r = spawnSync('docker', ['logs', containerName], { encoding: 'utf8' });
  if (r.status !== 0) return -1;
  return ((r.stdout + r.stderr).match(/"GET \/ctgov_eyeart_studies\.json/g) ?? []).length;
};

export async function run(ctx) {
  const gate = new Gate('Z-REST', 'REST tables over bounded openFDA and ClinicalTrials.gov JSON');

  // Static copy served by the REST silo: stable, so the comparison is exact.
  const staticDirect = await direct('http://127.0.0.1:18080/ctgov_eyeart_studies.json');
  const flat = await ctx.q('admin', 'SELECT s.protocolSection.identificationModule.nctId AS nct_id, s.protocolSection.statusModule.overallStatus AS status, s.protocolSection.designModule.enrollmentInfo.count AS enrolled FROM sk_rest.ctgov_eyeart_static LATERAL VIEW explode(studies) x AS s ORDER BY nct_id');
  gate.check('static: nested studies array unnests into rows', flat.outcome === 'OK', flat.outcome === 'OK' ? `${flat.rows.length} rows in ${flat.ms} ms` : flat.message);
  if (flat.outcome === 'OK') {
    const expectedIds = staticDirect.body.studies.map((s) => s.protocolSection.identificationModule.nctId).sort();
    gate.check('static: row count equals the direct call', flat.rows.length === staticDirect.body.studies.length && flat.rows.length === staticDirect.body.totalCount, `zetaris ${flat.rows.length}, direct ${staticDirect.body.studies.length}, totalCount ${staticDirect.body.totalCount}`);
    gate.check('static: NCT ids equal the direct call', JSON.stringify(flat.rows.map((r) => r.nct_id).sort()) === JSON.stringify(expectedIds), expectedIds.join(','));
    const eyeart = flat.rows.find((r) => r.nct_id === 'NCT03112005');
    const directEyeart = staticDirect.body.studies.find((s) => s.protocolSection.identificationModule.nctId === 'NCT03112005');
    gate.check('static: a sampled field matches (NCT03112005 enrollment)', eyeart && Number(eyeart.enrolled) === directEyeart.protocolSection.designModule.enrollmentInfo.count, `${eyeart?.enrolled}`);
    gate.show("SELECT ... FROM sk_rest.ctgov_eyeart_static LATERAL VIEW explode(studies) ...", flat.rows.slice(0, 3));
  }

  // Re-issue on every query: count requests that reach the REST silo.
  const container = 'sakaime-zetaris-rest-silo-1';
  const before = getCount(container);
  await ctx.q('admin', 'SELECT size(studies) AS n FROM sk_rest.ctgov_eyeart_static');
  await ctx.q('admin', 'SELECT size(studies) AS n FROM sk_rest.ctgov_eyeart_static');
  const after = getCount(container);
  gate.check('static: the endpoint is requested again by each query', before >= 0 && after - before >= 2, `GET count ${before} -> ${after} after two queries`);

  // Live endpoints.
  try {
    const live = await direct(CT_LIVE);
    const t = await ctx.q('admin', 'SELECT size(studies) AS n, totalCount FROM sk_rest.ctgov_eyeart_live');
    gate.check('live ClinicalTrials.gov: count equals a direct call', t.outcome === 'OK' && Number(t.rows[0].n) === live.body.studies.length && Number(t.rows[0].totalCount) === live.body.totalCount, t.outcome === 'OK' ? `zetaris ${t.rows[0].n}/${t.rows[0].totalCount} in ${t.ms} ms, direct ${live.body.studies.length}/${live.body.totalCount} in ${live.ms} ms` : t.message);
    const ids = await ctx.q('admin', 'SELECT s.protocolSection.identificationModule.nctId AS nct_id FROM sk_rest.ctgov_eyeart_live LATERAL VIEW explode(studies) x AS s ORDER BY nct_id');
    gate.check('live ClinicalTrials.gov: NCT ids equal a direct call', ids.outcome === 'OK' && JSON.stringify(ids.rows.map((r) => r.nct_id)) === JSON.stringify(live.body.studies.map((s) => s.protocolSection.identificationModule.nctId).sort()), `${ids.rows?.length} ids`);
  } catch (error) {
    gate.check('live ClinicalTrials.gov reachable from this machine', false, String(error));
  }
  try {
    const live = await direct(FDA_LIVE);
    const t = await ctx.q('admin', 'SELECT size(results) AS n, meta.results.total AS total, results[0].k_number AS k, results[0].openfda.device_class AS device_class FROM sk_rest.fda_510k_k200667_live');
    gate.check('live openFDA: count and nested fields equal a direct call', t.outcome === 'OK' && Number(t.rows[0].n) === live.body.results.length && t.rows[0].k === live.body.results[0].k_number && t.rows[0].device_class === live.body.results[0].openfda.device_class, t.outcome === 'OK' ? `zetaris n=${t.rows[0].n} k=${t.rows[0].k} class=${t.rows[0].device_class} in ${t.ms} ms; direct ${live.ms} ms` : t.message);
  } catch (error) {
    gate.check('live openFDA reachable from this machine', false, String(error));
  }

  // Timing over repeated queries, to give a latency figure rather than one sample.
  const samples = [];
  for (let i = 0; i < 5; i += 1) samples.push((await ctx.q('admin', 'SELECT size(studies) AS n FROM sk_rest.ctgov_eyeart_live')).ms);
  samples.sort((a, b) => a - b);
  gate.note(`live ClinicalTrials.gov REST table, 5 repeated queries: min ${samples[0]} ms, median ${samples[2]} ms, max ${samples[4]} ms`);
  gate.note('Not tested here: a large response (earlier teams reported 40 to 50 s for 1.5 MB of JSON) and wide nested JSON against the driver heap. The snapshot route stays the default for large public JSON.');
  return gate.finish();
}
