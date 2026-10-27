// Z-USL: the Unified Semantic Layer. Compiled in one request over the three silos, activated per table with explicit casts,
// queried as the read-only non-admin identity, with data-quality rules whose results are checked against DuckDB and
// against a planted violation.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareRows, createOracle } from '../scripts/oracle.mjs';
import { repoRoot } from '../scripts/zt.mjs';
import * as usl from '../sql/usl.mjs';
import { Gate } from './context.mjs';

const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
};

export async function run(ctx) {
  const gate = new Gate('Z-USL', 'Unified Semantic Layer, activation, non-admin query, data-quality rules');
  const t = usl.uslTable;
  const oracle = await createOracle();

  // 1. Compile in one request, without DEPLOY: returns the model and stores nothing.
  const dry = await ctx.q('admin', usl.compileStatement.replace('COMPILE USL sakaime_evidence DEPLOY NAMESPACE', 'COMPILE USL sakaime_evidence_dryrun NAMESPACE'));
  const model = dry.outcome === 'OK' ? JSON.parse(dry.rows[0].json) : null;
  gate.check('multi-table COMPILE USL is accepted as a single request (dry run, nothing stored)', dry.outcome === 'OK' && model?.tables?.length === Object.keys(usl.activations).length, dry.outcome === 'OK' ? `${model.tables.length} tables, ${dry.ms} ms` : dry.message);

  // 2. Deployed model and activation state.
  const listing = await ctx.q('admin', `SHOW NAMESPACES OR TABLES IN ${usl.USL_NAMESPACE}.${usl.USL_NAME}`);
  gate.check('all six tables are activated', listing.rows?.length === 6 && listing.rows.every((r) => r.activated === 'true'), listing.rows?.map((r) => `${r.name}:${r.activated}`).join(' '));
  const load = await ctx.q('reader', `LOAD USL ${usl.USL_NAME} NAMESPACE ${usl.USL_NAMESPACE}`);
  gate.check('the agent identity can load the deployed model as JSON', load.outcome === 'OK', load.outcome === 'OK' ? 'ok' : load.message);
  if (load.outcome === 'OK') {
    const raw = JSON.parse(load.rows[0].json ?? Object.values(load.rows[0])[0]);
    gate.note(`LOAD USL returned the model with ${raw.tables.length} tables; sha256 of its canonical (recursively key-sorted) JSON is ${createHash('sha256').update(canonical(raw)).digest('hex').slice(0, 16)}... (a pin for contract drift).`);
    gate.show(`LOAD USL ${usl.USL_NAME} (table names, keys)`, raw.tables.map((tb) => ({ table: tb.name, columns: tb.columnSpecs.length, activated: Boolean(tb.activateQuery) })));
  }

  // 3. Row counts through the USL as the non-admin identity, against the source files.
  const expectedCounts = { authorization_record: 12, device_version: 20, study_record: 157, vendor_claim: 14, case_context: 7, evidence_matrix: 20 };
  for (const [name, expected] of Object.entries(expectedCounts)) {
    const r = await ctx.q('reader', `SELECT count(*) AS n FROM ${t(name)}`);
    gate.check(`agent identity: ${name} has ${expected} rows through the USL`, r.outcome === 'OK' && Number(r.rows[0].n) === expected, r.outcome === 'OK' ? `${r.rows[0].n} rows in ${r.ms} ms` : `${r.outcome}: ${ctx.clip(r.message, 120)}`);
  }

  // 4. The evidence matrix through the USL equals the DuckDB oracle for the shared columns.
  const viaUsl = await ctx.q('reader', `SELECT * FROM ${t('evidence_matrix')} ORDER BY matrix_key`);
  const expected = await oracle.rows(readFileSync(join(repoRoot, 'infra', 'zetaris', 'sql', 'headline.duckdb.sql'), 'utf8'));
  if (viaUsl.outcome === 'OK') {
    const cols = ['case_id', 'claim_id', 'product_name', 'k_number', 'udi_versions', 'confirmed_studies', 'study_min_age_years', 'version_in_device_record', 'claim_age_vs_study', 'case_age_vs_study'];
    const project = (rows) => rows.map((r) => Object.fromEntries(cols.map((c) => [c, r[c]])));
    const cmp = compareRows(project(expected), project(viaUsl.rows), ['case_id', 'claim_id']);
    gate.check('evidence_matrix through the USL equals the DuckDB join, cell by cell', cmp.equal, cmp.equal ? `${cmp.actualRows} rows identical in ${viaUsl.ms} ms` : cmp.problems.slice(0, 4).join('; '));
  } else gate.check('evidence_matrix readable by the agent identity', false, viaUsl.message);

  // 5. Data-quality rules, run by the non-admin identity ("Signed-in users; assigned objects only").
  const expectedEligibility = Number((await oracle.rows("SELECT count(*) AS n FROM ctgov_studies WHERE minimum_age_years IS NOT NULL AND minimum_age_years <> ''"))[0].n);
  const totalStudies = Number((await oracle.rows('SELECT count(*) AS n FROM ctgov_studies'))[0].n);
  for (const rule of usl.dqRules) {
    const r = await ctx.q('reader', `RUN DQ ${rule.rule} TABLE ${t(rule.table)}`);
    const row = r.rows?.[0];
    gate.check(`RUN DQ ${rule.rule} runs as the agent identity`, r.outcome === 'OK' && row && Number(row.valid_record) + Number(row.invalid_record) === Number(row.total_record), r.outcome === 'OK' ? `total ${row.total_record}, valid ${row.valid_record}, invalid ${row.invalid_record} in ${r.ms} ms` : r.message);
    if (rule.rule === 'has_eligibility' && row) {
      gate.check('completeness rule counts equal an independent count (DuckDB)', Number(row.total_record) === totalStudies && Number(row.valid_record) === expectedEligibility, `zetaris ${row.valid_record}/${row.total_record} valid, duckdb ${expectedEligibility}/${totalStudies}`);
      gate.show(`RUN DQ has_eligibility TABLE ${t('study_record')}`, row);
    }
  }
  // The invalid records are exactly the search summaries (records that were cut short before they reached the silo).
  const invalid = await ctx.q('reader', `SHOW DQ INVALID RECORD has_eligibility TABLE ${t('study_record')}`);
  if (invalid.outcome === 'OK') {
    const ids = new Set(invalid.rows.map((r) => r.nct_id));
    const summaryIds = new Set((await oracle.rows("SELECT nct_id FROM ctgov_studies WHERE record_kind = 'search_summary'")).map((r) => r.nct_id));
    const same = ids.size === summaryIds.size && [...ids].every((i) => summaryIds.has(i));
    gate.check('the records the rule rejects are exactly the search summaries without an eligibility block', same, `${ids.size} rejected, ${summaryIds.size} search summaries`);
    gate.check('the evidence-linked study NCT03112005 passes the rule', !ids.has('NCT03112005'), '');
  } else gate.check('SHOW DQ INVALID RECORD works for the agent identity', false, invalid.message);
  // Constraint rules generated from keys.
  const rules = await ctx.q('reader', `LIST DQ USL ${usl.USL_NAMESPACE}.${usl.USL_NAME}`);
  gate.check('key and foreign-key constraints are listed as rules', rules.outcome === 'OK' && rules.rows.some((r) => /Foreign key/i.test(r.type)) && rules.rows.some((r) => /Primary key/i.test(r.type)), rules.outcome === 'OK' ? `${rules.rows.length} rules` : rules.message);
  const fk = await ctx.q('reader', `RUN DQ submission_number TABLE ${t('device_version')}`);
  gate.check('foreign key device_version.submission_number -> authorization_record passes (all 20 resolve)', fk.outcome === 'OK' && fk.rows.every((r) => r.invalid_record === '0'), fk.outcome === 'OK' ? JSON.stringify(fk.rows.map((r) => `${r.name}: ${r.valid_record}/${r.total_record}`)) : fk.message);

  // 6. A planted violation proves the rules can fire: replace the vendor claims object with a bad copy, run, restore.
  const original = readFileSync(join(repoRoot, 'data', 'silos', 'vendor_packets', 'vendor_claims.csv'), 'utf8');
  const lines = original.split('\n');
  lines.splice(2, 0, 'PKT-EA-01,CLM-EA-99,EyeArt,2.1.0,200,primary_care,detection_aid,Canon CR-2 Plus AF,"planted: age above 120 and no cited submission",,NCT03112005,34779843,0,Reference site 00,CONSTRUCTED');
  const s3 = `http://127.0.0.1:${ctx.zt.cfg('SAKAIME_S3_PORT') ?? '19190'}/sakaime-vendor/vendor_claims/vendor_claims.csv`;
  try {
    await fetch(s3, { method: 'PUT', body: lines.join('\n') });
    const age = await ctx.q('admin', `RUN DQ age_in_range TABLE ${t('vendor_claim')}`);
    const cites = await ctx.q('admin', `RUN DQ cites_a_submission TABLE ${t('vendor_claim')}`);
    gate.check('planted claim with age 200 is caught by age_in_range', age.outcome === 'OK' && age.rows[0].invalid_record === '1' && age.rows[0].total_record === '15', age.outcome === 'OK' ? JSON.stringify(age.rows[0]) : age.message);
    gate.check('planted claim without a cited submission is caught by cites_a_submission', cites.outcome === 'OK' && cites.rows[0].invalid_record === '1', cites.outcome === 'OK' ? JSON.stringify(cites.rows[0]) : cites.message);
  } finally {
    await fetch(s3, { method: 'PUT', body: original });
  }
  const clean = await ctx.q('admin', `RUN DQ age_in_range TABLE ${t('vendor_claim')}`);
  gate.check('original claims restored, rule back to 14 of 14 valid', clean.outcome === 'OK' && clean.rows[0].valid_record === '14' && clean.rows[0].total_record === '14', clean.outcome === 'OK' ? JSON.stringify(clean.rows[0]) : clean.message);

  // 7. Administration stays administrative.
  const activate = await ctx.q('reader', `ACTIVATE USL TABLE ${t('vendor_claim')} AS SELECT * FROM sk_vendor.vendor_claims`);
  const register = await ctx.q('reader', `REGISTER DQ agent_rule TABLE ${t('vendor_claim')} AS claim_id IS NOT NULL`);
  gate.check('the agent identity cannot ACTIVATE a USL table or REGISTER a rule', activate.outcome === 'FORBIDDEN' && register.outcome === 'FORBIDDEN', `${activate.outcome} / ${register.outcome}`);

  // 8. Measured cost of the same answer by hand, for the reflection.
  const started = performance.now();
  const hand = await ctx.q('admin', readFileSync(join(repoRoot, 'infra', 'zetaris', 'sql', 'headline.zetaris.sql'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('--')).join('\n'));
  const handMs = Math.round(performance.now() - started);
  const handLines = readFileSync(join(repoRoot, 'infra', 'zetaris', 'sql', 'headline.zetaris.sql'), 'utf8').split(String.fromCharCode(10)).filter((l) => l.trim() && !l.trim().startsWith('--')).length;
  gate.note(`Query time for the same 20-row answer: ${viaUsl.ms} ms through the USL table, ${handMs} ms as the hand-written join over the raw sources (a ${handLines}-line statement). The USL table carries the join, the casts and the declared types, so a consumer writes SELECT * FROM evidence_matrix. Elapsed engineering time was not measured here, so no time-saving figure is claimed.`);
  oracle.close();
  return gate.finish();
}
