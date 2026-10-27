// Z-TT: Iceberg time travel. A table in a local-storage data lake holds two snapshots of a registry record (status
// RECRUITING, then COMPLETED). A query pinned to the first snapshot must return the earlier state.

import { Gate } from './context.mjs';

export async function run(ctx) {
  const gate = new Gate('Z-TT', 'Iceberg time travel on registry snapshots');
  const table = 'sk_lake.evidence.registry_snapshot';

  const snaps = await ctx.q('admin', `SELECT snapshot_id, operation, committed_at FROM ${table}.snapshots ORDER BY committed_at`);
  gate.check('the table has at least two snapshots', snaps.outcome === 'OK' && snaps.rows.length >= 2, snaps.outcome === 'OK' ? `${snaps.rows.length} snapshots` : snaps.message);
  if (snaps.outcome !== 'OK' || snaps.rows.length < 2) return gate.finish();
  const first = snaps.rows[0];
  const second = snaps.rows[1];
  gate.show(`SELECT ... FROM ${table}.snapshots`, snaps.rows);

  const now = await ctx.q('admin', `SELECT nct_id, overall_status FROM ${table} WHERE nct_id = 'NCT03112005'`);
  const asOfVersion = await ctx.q('admin', `SELECT nct_id, overall_status FROM ${table} VERSION AS OF ${first.snapshot_id} WHERE nct_id = 'NCT03112005'`);
  const afterVersion = await ctx.q('admin', `SELECT nct_id, overall_status FROM ${table} VERSION AS OF ${second.snapshot_id} WHERE nct_id = 'NCT03112005'`);
  gate.check('current state is COMPLETED', now.rows?.[0]?.overall_status === 'COMPLETED', JSON.stringify(now.rows));
  gate.check('VERSION AS OF the first snapshot returns the earlier state (RECRUITING)', asOfVersion.rows?.[0]?.overall_status === 'RECRUITING', asOfVersion.outcome === 'OK' ? JSON.stringify(asOfVersion.rows) : asOfVersion.message);
  gate.check('VERSION AS OF the second snapshot returns the later state (COMPLETED)', afterVersion.rows?.[0]?.overall_status === 'COMPLETED', afterVersion.outcome === 'OK' ? JSON.stringify(afterVersion.rows) : afterVersion.message);
  gate.show(`SELECT ... FROM ${table} VERSION AS OF ${first.snapshot_id}`, asOfVersion.rows);

  // Timestamp form: a moment between the first and second commits.
  const t1 = new Date(`${first.committed_at.replace(' ', 'T')}Z`).getTime();
  const t2 = new Date(`${second.committed_at.replace(' ', 'T')}Z`).getTime();
  const between = new Date(t1 + Math.max(1, Math.floor((t2 - t1) / 2))).toISOString().replace('T', ' ').replace('Z', '');
  const asOfTime = await ctx.q('admin', `SELECT nct_id, overall_status FROM ${table} TIMESTAMP AS OF '${between}' WHERE nct_id = 'NCT03112005'`);
  gate.check('TIMESTAMP AS OF a moment between the two commits returns the earlier state', asOfTime.rows?.[0]?.overall_status === 'RECRUITING', asOfTime.outcome === 'OK' ? `${between} -> ${JSON.stringify(asOfTime.rows)}` : asOfTime.message);

  // Failure semantics: a time before the table existed is an error, not an empty result.
  const tooEarly = await ctx.q('admin', `SELECT * FROM ${table} TIMESTAMP AS OF '2000-01-01 00:00:00'`);
  gate.check('a time before the first snapshot is an error, not an empty answer', tooEarly.outcome !== 'OK', `${tooEarly.outcome}: ${ctx.clip(tooEarly.message, 140)}`);
  const badVersion = await ctx.q('admin', `SELECT * FROM ${table} VERSION AS OF 123`);
  gate.check('an unknown snapshot id is an error', badVersion.outcome !== 'OK', `${badVersion.outcome}: ${ctx.clip(badVersion.message, 120)}`);

  // Who may read the lake?
  const readerBefore = await ctx.q('reader', `SELECT count(*) AS n FROM ${table}`);
  gate.note(`The agent identity, with no assignment or grant on the data lake: ${readerBefore.outcome} (${ctx.clip(readerBefore.message ?? JSON.stringify(readerBefore.rows), 120)}). Deny by default also applies to lakes.`);
  gate.note('CREATE DATALAKE on the S3Mock bucket was rejected ("Path does not exist or is not allowed") even with an object under the prefix, so the lake uses LOCAL storage on the driver and API shared volume. Why the S3 form failed (the plain-HTTP endpoint, the mock, or a missing option) is NOT VERIFIED. Granting the agent identity read access to a lake was not tested.');
  gate.note('Time travel here covers Iceberg tables only. The registry snapshot files registered as CSV file-store tables have no history; Sakaime must write snapshots into the lake to ask what the evidence said on an earlier date.');
  return gate.finish();
}
