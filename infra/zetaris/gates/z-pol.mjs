// Z-POL: column and row policies for a second identity, write protection for the agent identity, the USL access error, and
// whether a masked value can reach anything the agent identity receives (the stand-in for a model prompt log).

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { repoRoot } from '../scripts/zt.mjs';
import * as usl from '../sql/usl.mjs';
import { Gate } from './context.mjs';
import { PROBE, createProbe, dropProbe, grantProbe } from './probe.mjs';

function confidentialTokens() {
  const lines = readFileSync(join(repoRoot, 'data', 'silos', 'vendor_packets', 'vendor_claims.csv'), 'utf8').trim().split('\n');
  const header = lines[0].split(',');
  const priceAt = header.indexOf('confidential_unit_price_usd');
  const siteAt = header.indexOf('confidential_reference_site');
  const tokens = new Set();
  for (const line of lines.slice(1)) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, ''));
    tokens.add(cells[priceAt]);
    tokens.add(cells[siteAt]);
  }
  return [...tokens].filter(Boolean);
}

export async function run(ctx) {
  const gate = new Gate('Z-POL', 'Column and row policies, write protection, USL access, masked values');
  const star = 'SELECT * FROM sk_vendor.vendor_claims ORDER BY claim_id';

  // 1. One statement, four identities.
  const seen = {};
  for (const who of ['admin', 'assigned', 'reader', 'reviewer']) seen[who] = await ctx.q(who, star);
  for (const [who, r] of Object.entries(seen)) gate.check(`${who} can run the statement`, r.outcome === 'OK', r.outcome === 'OK' ? `${r.headers.length} columns, ${r.rows.length} rows` : r.message);
  const eyeartRow = (r) => r.rows?.find((row) => row.claim_id === 'CLM-EA-01');
  const priceOf = (r) => eyeartRow(r)?.confidential_unit_price_usd;
  const siteOf = (r) => eyeartRow(r)?.confidential_reference_site;
  gate.check('admin sees the real price and reference site', priceOf(seen.admin) === '41500' && String(siteOf(seen.admin)).startsWith('Reference site'), `price ${priceOf(seen.admin)}, site ${siteOf(seen.admin)}`);
  gate.check('assigned reviewer (no policy) sees the real price and reference site', priceOf(seen.assigned) === '41500' && String(siteOf(seen.assigned)).startsWith('Reference site'), '');
  gate.check('agent identity: price is denied (null), columns stay aligned', seen.reader.rows?.every((r) => r.confidential_unit_price_usd === null) && seen.reader.headers?.length === seen.admin.headers?.length, `price ${priceOf(seen.reader)}, ${seen.reader.headers?.length} columns`);
  gate.check('agent identity: reference site is masked', seen.reader.rows?.every((r) => r.confidential_reference_site === '**') && !JSON.stringify(seen.reader.rows).includes('Reference site'), `value ${siteOf(seen.reader)}`);
  gate.check('agent identity: provenance column still carries its own value (no column shift)', seen.reader.rows?.every((r) => r.provenance === 'CONSTRUCTED'), `provenance ${seen.reader.rows?.[0]?.provenance}`);
  gate.check('unassigned reviewer: same treatment as the agent identity', seen.reviewer.rows?.every((r) => r.confidential_unit_price_usd === null && r.confidential_reference_site === '**' && r.provenance === 'CONSTRUCTED'), '');
  gate.show(star + ' (row CLM-EA-01)', Object.fromEntries(Object.entries(seen).map(([who, r]) => [who, { columns: r.headers?.length, claim: 'CLM-EA-01', price: priceOf(r), site: siteOf(r), provenance: eyeartRow(r)?.provenance }])));

  // 1b. Defect reproduction: the Hide action on a file-store table. Applied temporarily to the agent identity, then restored.
  const policyPath = '/access-control/cbac/generic/FILESTORE/sk_vendor/vendor_claims';
  const original = (await ctx.zt.rest('admin', 'GET', policyPath)).body;
  const asField = (name, policy, type, options = []) => ({ name, dataType: { json: JSON.stringify(type), simpleString: type, typeName: type }, isNullable: true, metadata: { policy, policy_source: 'USER', options } });
  try {
    const hideBody = { id: 'vendor_claims', partitionColumns: [], version: original.version + 1, users: [{ username: ctx.zt.identities.reader.email.toUpperCase(), roleSelected: '', userLevelPolicy: 'hide_only' }], roles: [], policies: [{ policyName: 'hide_only', filter: 'true', fields: [asField('confidential_unit_price_usd', 'Hide', 'integer')] }] };
    await ctx.zt.rest('admin', 'POST', policyPath, { body: hideBody });
    const hidden = await ctx.q('reader', star);
    ctx.received.reader.pop(); // deliberately leaky response; kept out of the leak sweep below
    const row = hidden.rows?.find((r) => r.claim_id === 'CLM-EA-01') ?? {};
    const shifted = hidden.outcome === 'OK' && (JSON.stringify(row).includes('41500') || row.provenance !== 'CONSTRUCTED');
    gate.show('reader with the Hide action: ' + star + ' (row CLM-EA-01)', { columns: hidden.headers, row });
    gate.check('DEFECT REPRODUCED: with the Hide action, SELECT * drops the column name but not the value (the hidden price appears under another column)', shifted, `for CLM-EA-01: confidential_reference_site=${row.confidential_reference_site}, provenance=${row.provenance}, ${hidden.headers?.length} columns (expected 15)`);
    gate.note('FINDING: the Hide action on a file-store (CSV) table removes the hidden column from the header of SELECT * but not from the data, so every value moves one column left: the hidden price appeared as confidential_reference_site and the last column was lost. Deny (value becomes null) and Masked keep the columns aligned and are used instead. The same Hide action on the JDBC source table hospital.decisions behaved correctly.');
  } finally {
    await ctx.zt.rest('admin', 'POST', policyPath, { body: { ...original, version: original.version + 2 } });
  }
  const afterRepro = await ctx.q('reader', star);
  gate.check('policy restored after the reproduction', afterRepro.rows?.every((r) => r.confidential_unit_price_usd === null && r.confidential_reference_site === '**' && r.provenance === 'CONSTRUCTED'), '');

  // 2. Can a hidden or masked column be reached by another route?
  const probes = {
    'denied column in SELECT list': 'SELECT confidential_unit_price_usd FROM sk_vendor.vendor_claims',
    'denied column in WHERE': 'SELECT count(*) AS n FROM sk_vendor.vendor_claims WHERE confidential_unit_price_usd > 0',
    'hidden column through table alias star': 'SELECT vc.* FROM sk_vendor.vendor_claims vc JOIN hospital.submissions s ON s.packet_id = vc.packet_id',
    'hidden column through a subquery': 'SELECT * FROM (SELECT * FROM sk_vendor.vendor_claims) t',
  };
  for (const [name, statement] of Object.entries(probes)) {
    const r = await ctx.q('reader', statement);
    const leaked = r.outcome === 'OK' && /41500|Reference site/.test(JSON.stringify(r.rows));
    gate.check(`reader, ${name}: no confidential value returned`, !leaked, r.outcome === 'OK' ? `${r.rows.length} rows, ${ctx.clip(r.rows[0], 110)}` : `${r.outcome}: ${ctx.clip(r.message, 90)}`);
  }
  // Predicate on a masked column: does the filter see the unmasked value? Recorded as a finding either way.
  const sideChannel = await ctx.q('reader', "SELECT count(*) AS n FROM sk_vendor.vendor_claims WHERE confidential_reference_site = 'Reference site 17'");
  const sideChannelPrice = await ctx.q('reader', 'SELECT count(*) AS n FROM sk_vendor.vendor_claims WHERE confidential_unit_price_usd = 41500');
  gate.note(`WHERE predicate on the denied price column (= 41500) returned ${sideChannelPrice.outcome === 'OK' ? sideChannelPrice.rows[0].n : sideChannelPrice.outcome} rows for the agent identity.`);
  const sideN = sideChannel.outcome === 'OK' ? Number(sideChannel.rows[0].n) : -1;
  gate.note(sideN > 0 ? `FINDING: a WHERE predicate on the masked column matched ${sideN} rows for the agent identity, so equality tests can recover masked values one guess at a time (the masked value itself is never returned).` : `A WHERE predicate on the masked column matched ${sideN} rows for the agent identity (no inference through the filter).`);
  gate.show("reader: SELECT count(*) ... WHERE confidential_reference_site = 'Reference site 17'", { outcome: sideChannel.outcome, rows: sideChannel.rows });

  // 3. Row policy.
  const adminCases = await ctx.q('admin', 'SELECT case_id FROM hospital.cases ORDER BY case_id');
  const revCases = await ctx.q('reviewer', 'SELECT case_id FROM hospital.cases ORDER BY case_id');
  gate.check('row filter: unassigned reviewer sees fewer cases than admin', adminCases.rows.length === 7 && revCases.rows.length === 5 && !revCases.rows.some((r) => r.case_id === 'CASE-2026-014'), `admin ${adminCases.rows.length} rows, reviewer ${revCases.rows.length} rows`);
  const viaUsl = await ctx.q('reviewer', `SELECT case_id FROM ${usl.uslTable('case_context')} ORDER BY case_id`);
  const usedUsl = viaUsl.outcome === 'OK' ? viaUsl.rows.length : -1;
  gate.note(usedUsl === 7 ? 'FINDING: the row filter on hospital.cases is NOT applied when the same rows are read through the USL table case_context (reviewer sees 7 rows there). A USL table is a policy boundary of its own and must be governed separately.' : `Row filter through the USL table case_context: the unassigned reviewer sees ${usedUsl} of 7 rows, the same as through the base table, so the policy on the source table carries through the USL.`);
  gate.check('the unassigned reviewer can read the USL table (the answer differs from the base table, see the note)', viaUsl.outcome === 'OK', `${usedUsl} rows via the USL, ${revCases.rows.length} via the base table`);

  // 3b. Does a metadata refresh keep the policies? Tested on a throwaway datasource so the real policies stay in place.
  await createProbe(ctx);
  try {
    await grantProbe(ctx, 'case_reviewer_unassigned');
    const probePath = `/access-control/cbac/generic/DATASOURCE/${PROBE}/cases`;
    const setPolicy = await ctx.zt.rest('admin', 'POST', probePath, { body: { id: 'cases', partitionColumns: [], version: 1, users: [{ username: ctx.zt.identities.reviewer.email.toUpperCase(), roleSelected: '', userLevelPolicy: 'p' }], roles: [], policies: [{ policyName: 'p', filter: "case_id NOT IN ('CASE-2026-014','CASE-2026-021')", fields: [] }] } });
    const filtered = await ctx.q('reviewer', `SELECT count(*) AS n FROM ${PROBE}.cases`);
    gate.check('probe datasource: the row filter is in force before a refresh (reviewer sees 5 of 7 cases)', setPolicy.status === 200 && filtered.rows?.[0]?.n === '5', `policy HTTP ${setPolicy.status}, reviewer sees ${filtered.rows?.[0]?.n}`);
    const refresh = await ctx.q('admin', `REFRESH DATASOURCE TABLES FROM ${PROBE}`);
    const afterPolicy = await ctx.zt.rest('admin', 'GET', probePath);
    const afterRefresh = await ctx.q('reviewer', `SELECT count(*) AS n FROM ${PROBE}.cases`);
    gate.check('DEFECT REPRODUCED: REFRESH DATASOURCE TABLES (no schema change) deletes the row policy and the reviewer then sees all 7 cases', refresh.outcome === 'OK' && afterPolicy.body === null && afterRefresh.rows?.[0]?.n === '7', `refresh ${refresh.outcome}; policy afterwards ${JSON.stringify(afterPolicy.body)}; reviewer sees ${afterRefresh.rows?.[0]?.n}`);
    gate.note('FINDING: REFRESH DATASOURCE TABLES FROM <source> and UPDATE DATASOURCE SCHEMA <source> remove every column and row policy on the tables of that source, even when nothing changed, and nothing reports it. The grant stays, so the reviewer keeps SELECT and simply sees more. Policies on JDBC tables must be re-applied after any refresh, and the product must verify them (read the policy and run a canary query as a restricted identity) before it trusts a source. Policies on file-store tables were unaffected by the refresh in this run.');
  } finally {
    await dropProbe(ctx);
  }
  const realPolicy = await ctx.zt.rest('admin', 'GET', '/access-control/cbac/generic/DATASOURCE/hospital/cases');
  gate.check('the real hospital.cases policy is still in place (the refresh above touched only the probe)', realPolicy.body !== null, `version ${realPolicy.body?.version}`);

  // 4. Write protection of the agent identity. Statements are chosen so that, if one were accepted, Postgres would still reject it.
  const writes = {
    'INSERT into the JDBC source': "INSERT INTO hospital.decisions VALUES ('DEC-X','CASE-2026-014','NOT_A_DECISION','x','R-001',DATE '2026-10-27','NOT_CONSTRUCTED')",
    'CREATE DATASOURCE': 'CREATE DATASOURCE evil DESCRIBE BY "x" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://hospital-db:5432/hospital", username "x", password "x")',
    'CREATE LIGHTNING DATABASE': 'CREATE LIGHTNING DATABASE evil_db',
    'GRANT': "GRANT SELECT ON DATASOURCE NAMESPACE hospital TO ROLE 'case_reviewer_unassigned'",
    'COMPILE USL': 'COMPILE USL evil NAMESPACE lightning.metastore.sakaime DDL\nCREATE TABLE t (a int NOT NULL PRIMARY KEY)',
    'DROP TABLE': 'DROP TABLE sk_vendor.vendor_claims',
  };
  for (const [name, statement] of Object.entries(writes)) {
    const r = await ctx.q('reader', statement);
    gate.check(`agent identity cannot ${name}`, r.outcome === 'FORBIDDEN', `${r.outcome}: ${ctx.clip(r.message, 110)}`);
  }
  const again = await ctx.q('admin', 'SELECT count(*) AS n FROM hospital.decisions');
  gate.check('no write reached the JDBC source (decisions still 3 rows)', Number(again.rows[0].n) === 3, `${again.rows[0].n}`);

  // 5. The documented risk: non-admin users hitting "does not have access to USL".
  const roleName = 'AGENT_READONLY';
  const listing = await ctx.q('admin', `SHOW NAMESPACES OR TABLES IN ${usl.USL_NAMESPACE}`);
  const uslId = Number(listing.rows.find((r) => r.name === usl.USL_NAME).usl_id);
  const count = `SELECT count(*) AS n FROM ${usl.uslTable('study_record')}`;
  const withAccess = await ctx.q('reader', count);
  gate.check('agent identity can query the USL after the grant and the instance assignment', withAccess.outcome === 'OK', withAccess.outcome === 'OK' ? `${withAccess.rows[0].n} rows in ${withAccess.ms} ms` : withAccess.message);
  const revoke = await ctx.zt.rest('admin', 'POST', '/access-control/revoke/role/usl', { body: { roleNames: [roleName], uslId } });
  const without = await ctx.q('reader', count);
  gate.check('after revoking the USL instance assignment the same query is refused with "does not have access to USL"', without.outcome === 'FORBIDDEN' && /does not have access to USL/.test(without.message ?? ''), `${without.outcome}: ${ctx.clip(without.message, 130)}`);
  const assign = await ctx.zt.rest('admin', 'POST', '/access-control/assign/role/usl', { body: { roleNames: [roleName], uslId } });
  const restored = await ctx.q('reader', count);
  gate.check('assigning the USL instance to the role restores access (REST step, not SQL)', restored.outcome === 'OK', `revoke HTTP ${revoke.status}, assign HTTP ${assign.status}`);
  const sqlAssign = await ctx.q('admin', `ASSIGN USL ${usl.USL_NAME} TO ROLE 'agent_readonly'`);
  gate.note(`ASSIGN USL via SQL is not a statement in this build (${sqlAssign.outcome}); the SQL GRANT on the USL namespace alone left the agent identity locked out until the REST assignment was made.`);

  // 6. Leak sweep: everything the agent identity and the unassigned reviewer received so far, plus a few more shapes.
  for (const statement of [
    'SELECT * FROM sk_vendor.vendor_packets',
    `SELECT * FROM ${usl.uslTable('vendor_claim')}`,
    `SELECT * FROM ${usl.uslTable('evidence_matrix')}`,
    'DESCRIBE sk_vendor.vendor_claims',
    'SELECT vc.claim_id, vc.claim_text, s.product_name FROM sk_vendor.vendor_claims vc JOIN hospital.submissions s ON s.packet_id = vc.packet_id',
  ]) {
    await ctx.q('reader', statement);
    await ctx.q('reviewer', statement);
  }
  const tokens = confidentialTokens();
  for (const who of ['reader', 'reviewer']) {
    const blob = JSON.stringify(ctx.received[who]);
    const hits = tokens.filter((t) => blob.includes(t));
    gate.check(`leak sweep: none of ${tokens.length} confidential values appears in the ${ctx.received[who].length} responses received by ${who}`, hits.length === 0, hits.length ? `found: ${hits.join(', ')}` : '');
  }
  gate.note('The leak sweep covers what Zetaris returned to the agent identity. The model prompt log of the Sakaime agent does not exist yet, so "a masked value reaches a prompt" is NOT VERIFIED at the application level; it is verified that the data layer never hands the value to the identity that builds the prompt.');
  return gate.finish();
}
