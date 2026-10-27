// Z-CAT: catalog tags and metadata change history. Tags are set and read back through REST; schema drift in a registered
// source is made on purpose and looked for in (a) the SQL surface, (b) the REST surface and (c) the metastore tables.

import { spawnSync } from 'node:child_process';
import { Gate } from './context.mjs';
import { PROBE, createProbe, dropProbe } from './probe.mjs';

function metastore(sql) {
  const pw = process.env.SAKAIME_ZETARIS_PG_PASSWORD;
  const r = spawnSync('docker', ['exec', '-e', `PGPASSWORD=${pw}`, 'sakaime-zetaris-postgres-1', 'psql', '-U', 'zetaris', '-d', 'metastore', '-At', '-F', '|', '-c', sql], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : `ERROR ${r.stderr.trim()}`;
}
function hospitalSql(sql) {
  const r = spawnSync('docker', ['exec', 'sakaime-zetaris-hospital-db-1', 'psql', '-U', 'sakaime', '-d', 'hospital', '-At', '-c', sql], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : `ERROR ${r.stderr.trim()}`;
}

export async function run(ctx) {
  const gate = new Gate('Z-CAT', 'Catalog tags and metadata change history');
  const z = ctx.zt;
  process.env.SAKAIME_ZETARIS_PG_PASSWORD = z.cfg('SAKAIME_ZETARIS_PG_PASSWORD');

  // Tags: set, read back by table, by tag search and as a non-admin.
  const table = '/catalog/databases/sk_registry/tables/fda_510k';
  const probeTag = `gate_probe_${Date.now()}`;
  const set = await z.rest('admin', 'POST', `${table}/tags`, { body: { tag: probeTag } });
  const back = await z.rest('admin', 'GET', `${table}/tags`);
  const search = await z.rest('admin', 'GET', `/catalog/tags/${probeTag}/entity`);
  gate.check('tag set on a table is read back', set.status === 200 && back.body.includes(probeTag), `tags now ${JSON.stringify(back.body)}`);
  gate.check('tag search finds the table', search.body?.some((e) => e.name === 'FDA_510K' && e.tags.includes(probeTag)), JSON.stringify(search.body).slice(0, 160));
  const asReader = await z.rest('reader', 'GET', `${table}/tags`);
  gate.check('the agent identity can read tags (authority tier is visible to it)', asReader.status === 200 && asReader.body.includes('authority_tier:regulator'), JSON.stringify(asReader.body));
  const writeAsReader = await z.rest('reader', 'POST', `${table}/tags`, { body: { tag: 'agent_wrote_this' } });
  gate.check('the agent identity cannot write tags', writeAsReader.status >= 400, `HTTP ${writeAsReader.status}`);
  await z.rest('admin', 'DELETE', `${table}/tags/${probeTag}`);
  const gone = await z.rest('admin', 'GET', `${table}/tags`);
  gate.check('untagging removes the tag', !gone.body.includes(probeTag), JSON.stringify(gone.body));
  const colTags = await z.rest('admin', 'GET', '/catalog/databases/sk_vendor/tables/vendor_claims/columns/confidential_unit_price_usd/tags');
  gate.check('a column tag (vendor_confidential) is stored', colTags.body?.includes('vendor_confidential'), JSON.stringify(colTags.body));
  gate.show('GET /catalog/databases/sk_registry/tables/fda_510k/tags', back.body);

  // Description: the allowed character set is narrow.
  const badDescription = await z.rest('admin', 'POST', `${table}/description`, { body: { description: "openFDA device 510(k) decisions, retrieved 2026-10-27" } });
  const goodDescription = await z.rest('admin', 'POST', `${table}/description`, { body: { description: 'openFDA_device_510k_decisions_snapshot_retrieved_2026-10-27' } });
  gate.note(`Table descriptions reject spaces and parentheses (HTTP ${badDescription.status} for free text, HTTP ${goodDescription.status} for underscore text).`);

  // Drift: add a column to a throwaway datasource over the same Postgres database (the real `hospital` source is left alone,
  // because a refresh also removes its policies; see gate Z-POL).
  await createProbe(ctx);
  const before = await ctx.q('admin', `DESCRIBE ${PROBE}.reviewers`);
  const historyBefore = metastore(`select count(*) from datasource_change_history where fk_datasource_id = (select id from datasource where name = '${PROBE.toUpperCase()}')`);
  const beforeCols = before.rows.map((r) => r.col_name);
  let driftSeen = false;
  let historyAfter = '?';
  let newRow = '';
  try {
    hospitalSql('alter table reviewers add column drift_probe text');
    const stale = await ctx.q('admin', `DESCRIBE ${PROBE}.reviewers`);
    const staleSees = stale.rows.some((r) => r.col_name === 'drift_probe');
    const refresh = await ctx.q('admin', `REFRESH DATASOURCE TABLES FROM ${PROBE}`);
    const afterDescribe = await ctx.q('admin', `DESCRIBE ${PROBE}.reviewers`);
    driftSeen = afterDescribe.rows.some((r) => r.col_name === 'drift_probe');
    historyAfter = metastore(`select count(*) from datasource_change_history where fk_datasource_id = (select id from datasource where name = '${PROBE.toUpperCase()}')`);
    newRow = metastore(`select operation||' | '||entity_type||' | '||update_at||' | '||description from datasource_change_history where fk_datasource_id = (select id from datasource where name = '${PROBE.toUpperCase()}') order by id desc limit 1`);
    gate.check('before REFRESH the catalog does not yet show the new column (drift is invisible until detected)', !staleSees, 'not visible before refresh');
    gate.check('REFRESH DATASOURCE TABLES succeeds', refresh.outcome === 'OK', refresh.outcome === 'OK' ? 'ok' : refresh.message);
    gate.check('DESCRIBE after the refresh shows the added column (SQL surface can detect drift by diffing columns)', driftSeen, `${beforeCols.length} columns before, ${afterDescribe.rows.length} after`);
    hospitalSql('alter table reviewers drop column if exists drift_probe');
    await ctx.q('admin', `REFRESH DATASOURCE TABLES FROM ${PROBE}`);
    const restored = await ctx.q('admin', `DESCRIBE ${PROBE}.reviewers`);
    gate.check('drift probe reverted, catalog columns back to the original set', restored.rows.length === beforeCols.length, `${restored.rows.length} columns`);
    gate.check('metastore change history gained entries for the refresh (operator read of datasource_change_history)', Number(historyAfter) > Number(historyBefore), `rows ${historyBefore} -> ${historyAfter}; newest after the add: ${newRow}`);

    // The same history through SQL: SHOW DATASOURCE CHANGE HISTORY (found in the compiled web UI; it is not in the command reference).
    const history = await ctx.q('admin', `SHOW DATASOURCE CHANGE HISTORY ${PROBE}`);
    gate.check('SHOW DATASOURCE CHANGE HISTORY returns the history through SQL', history.outcome === 'OK' && history.rows.length > 0, history.outcome === 'OK' ? `${history.rows.length} entries in ${history.ms} ms` : history.message);
    const added = history.rows?.filter((r) => /drift_probe.*was added/.test(r.description)) ?? [];
    const deleted = history.rows?.filter((r) => /drift_probe was deleted/.test(r.description)) ?? [];
    gate.check('the history lists the added column and, after the revert and a refresh, its removal', added.length === 1 && deleted.length === 1 && added[0].updatedAt <= deleted[0].updatedAt, `${added.length} addition, ${deleted.length} removal; ${added[0]?.updatedAt} then ${deleted[0]?.updatedAt}`);
    gate.show(`SHOW DATASOURCE CHANGE HISTORY ${PROBE} (all entries)`, history.rows);
    const historyAsReader = await ctx.q('reader', `SHOW DATASOURCE CHANGE HISTORY ${PROBE}`);
    gate.check('the history statement is administrator-only (the agent identity is refused)', historyAsReader.outcome === 'FORBIDDEN', `${historyAsReader.outcome}: ${ctx.clip(historyAsReader.message, 90)}`);
  } finally {
    hospitalSql('alter table reviewers drop column if exists drift_probe');
    await dropProbe(ctx);
  }
  const lakeHistory = await ctx.q('admin', 'SHOW DATASOURCE CHANGE HISTORY sk_registry');
  gate.note(`The change history covers JDBC datasources only: for the file-store database sk_registry the same statement answers "${ctx.clip(lakeHistory.message, 70)}". Drift in the snapshot files is therefore detected by hashing the snapshot, not by the catalog.`);

  const ui = spawnSync('docker', ['exec', 'sakaime-zetaris-ui-1', 'node', '-e', `
    const fs=require('fs'),path=require('path');
    const walk=(d,o=[])=>{for(const f of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,f.name);f.isDirectory()?walk(p,o):p.endsWith('.js')&&o.push(p)}return o};
    let files=0,hits=0;for(const f of walk('/app/.next')){files++;if(fs.readFileSync(f,'utf8').includes('SHOW DATASOURCE CHANGE HISTORY'))hits++}
    console.log(JSON.stringify({scriptFiles:files,usingShowDatasourceChangeHistory:hits}));`], { encoding: 'utf8' });
  gate.note(`How the statement was found: it is absent from the command reference and from the 284-path OpenAPI document, which is why an earlier run of this gate wrongly recorded "no SQL or REST route returns the history". The compiled web UI issues it for its Metadata History panel (${ui.stdout.trim()}). Lesson kept: search the client of the product, not only its documentation, before writing a negative finding.`);
  return gate.finish();
}
