// Z-HEAD: the headline cross-silo join (Postgres + registry snapshot files + vendor packet files in one statement, each
// silo aggregated in a subquery first) must return the same rows as the same logic on DuckDB over the same CSV files.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOracle, compareRows } from '../scripts/oracle.mjs';
import { repoRoot } from '../scripts/zt.mjs';
import { Gate } from './context.mjs';

const sqlDir = join(repoRoot, 'infra', 'zetaris', 'sql');
const stripComments = (text) => text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');

export async function run(ctx) {
  const gate = new Gate('Z-HEAD', 'Headline cross-silo join against an independent engine');
  const zetarisSql = stripComments(readFileSync(join(sqlDir, 'headline.zetaris.sql'), 'utf8'));
  const duckSql = readFileSync(join(sqlDir, 'headline.duckdb.sql'), 'utf8');

  const oracle = await createOracle();
  const expected = await oracle.rows(duckSql);
  gate.check('oracle returns rows', expected.length > 0, `${expected.length} rows`);

  const admin = await ctx.q('admin', zetarisSql);
  gate.check('Zetaris statement succeeds as admin', admin.outcome === 'OK', admin.outcome === 'OK' ? `${admin.rows.length} rows in ${admin.ms} ms (engine ${admin.serverMs} ms)` : admin.message);
  gate.show('headline.zetaris.sql as admin (one REST request)', { queryId: admin.queryId, rows: admin.rows?.length, total: admin.total, ms: admin.ms, truncated: admin.truncated });
  if (admin.outcome === 'OK') {
    const cmp = compareRows(expected, admin.rows, ['case_id', 'claim_id']);
    gate.check('Zetaris rows equal DuckDB rows, cell by cell', cmp.equal, cmp.equal ? `${cmp.actualRows} rows identical` : cmp.problems.slice(0, 5).join('; '));
    gate.check('result not truncated (total equals rows returned)', admin.total === admin.rows.length, `total ${admin.total}`);

    // Negative control: the comparison must notice a wrong cell and a missing row, or "equal" proves nothing.
    const tampered = admin.rows.map((r) => ({ ...r }));
    tampered[0].claim_age_vs_study = 'WITHIN_STUDY_TAMPERED';
    const cmpBad = compareRows(expected, tampered.slice(1).concat(tampered.slice(0, 1)), ['case_id', 'claim_id']);
    const cmpMissing = compareRows(expected, admin.rows.slice(1), ['case_id', 'claim_id']);
    gate.check('negative control: a changed cell is detected', !cmpBad.equal, cmpBad.problems[0] ?? '');
    gate.check('negative control: a missing row is detected', !cmpMissing.equal, cmpMissing.problems[0] ?? '');

    const eye = admin.rows.filter((r) => r.case_id === 'CASE-2026-014');
    const byClaim = Object.fromEntries(eye.map((r) => [r.claim_id, r]));
    gate.check('EyeArt packet: claim of version 3.0 is not in the device record', byClaim['CLM-EA-04']?.version_in_device_record === 'NOT_LISTED', `udi_versions=${byClaim['CLM-EA-04']?.udi_versions}`);
    gate.check('EyeArt packet: claim for all ages is below the study minimum age', byClaim['CLM-EA-02']?.claim_age_vs_study === 'CLAIM_BELOW_STUDY_MINIMUM', `claimed ${byClaim['CLM-EA-02']?.claimed_min_age_years}, study ${byClaim['CLM-EA-02']?.study_min_age_years}`);
    gate.check('EyeArt packet: in-scope claim stays within the study', byClaim['CLM-EA-01']?.claim_age_vs_study === 'WITHIN_STUDY' && byClaim['CLM-EA-01']?.version_in_device_record === 'LISTED', '');
    gate.show('EyeArt rows of the answer', eye.map((r) => `${r.claim_id} v${r.claimed_version} age>=${r.claimed_min_age_years} | version ${r.version_in_device_record} | age ${r.claim_age_vs_study}`));
  }

  // Same statement for the read-only agent identity.
  const reader = await ctx.q('reader', zetarisSql);
  gate.check('read-only agent identity runs the same statement', reader.outcome === 'OK', reader.outcome === 'OK' ? `${reader.rows.length} rows in ${reader.ms} ms` : reader.message);
  if (reader.outcome === 'OK' && admin.outcome === 'OK') gate.check('agent identity result equals admin result', compareRows(admin.rows, reader.rows, ['case_id', 'claim_id']).equal, '');

  // The reviewer who is not assigned to the EyeArt cases has a row filter on hospital.cases; it must apply inside the join.
  const reviewer = await ctx.q('reviewer', zetarisSql);
  if (reviewer.outcome === 'OK') {
    const expectedFiltered = expected.filter((r) => !['CASE-2026-014', 'CASE-2026-021'].includes(r.case_id));
    const cmp = compareRows(expectedFiltered, reviewer.rows, ['case_id', 'claim_id']);
    gate.check('row filter on hospital.cases applies inside the join for the unassigned reviewer', cmp.equal, cmp.equal ? `${reviewer.rows.length} rows, EyeArt cases absent` : cmp.problems.slice(0, 3).join('; '));
  } else gate.check('unassigned reviewer can run the join', false, reviewer.message);

  oracle.close();
  return gate.finish();
}
