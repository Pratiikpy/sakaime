#!/usr/bin/env node
// Seeds the running Zetaris stack with the three Sakaime silos, the identities and policies, the Unified Semantic Layer
// and the gate fixtures. Idempotent: every step checks the current state first and reports created, kept or failed.
//
//   node infra/zetaris/scripts/seed.mjs
//
// Steps: (1) hospital database, (2) object store contents, (3) Zetaris sources, (4) roles, users and grants, (5) column
// and row policies, (6) USL with data-quality rules, (7) catalog tags, (8) REST, PDF and Iceberg fixtures.

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import * as usl from '../sql/usl.mjs';
import * as zt from './zt.mjs';

const siloDir = join(zt.repoRoot, 'data', 'silos');
const project = zt.cfg('COMPOSE_PROJECT_NAME') ?? 'sakaime-zetaris';
const s3Port = zt.cfg('SAKAIME_S3_PORT') ?? '19190';
const s3Url = `http://127.0.0.1:${s3Port}`;
const s3Options = 'isS3BucketPublic "true", s3Endpoint "http://object-store:9090", useS3PathStyleAccess "true"';
const csvOptions = `header "true", inferSchema "true", ${s3Options}`;

let failures = 0;
const say = (state, label, detail = '') => console.log(`${state.padEnd(8)} ${label}${detail ? `  ${detail}` : ''}`);

/** Runs a statement as the admin; returns the result without throwing. */
const ALREADY = /already (exists?|been granted|assigned|registered)/i;
async function exec(label, statement, { tolerate = ALREADY } = {}) {
  const r = await zt.sql('admin', statement);
  if (r.outcome === 'OK') return r;
  if (tolerate.test(r.message ?? '')) return { ...r, kept: true };
  failures += 1;
  say('FAILED', label, `${r.outcome} ${r.message?.slice(0, 220) ?? ''}`);
  return r;
}
const exists = async (statement) => (await zt.sql('admin', statement)).outcome === 'OK';
const names = (r) => new Set(r.rows.map((row) => String(Object.values(row)[0]).toLowerCase()));

// (1) Hospital database -------------------------------------------------------------------------------------------
function dockerExec(args, input) {
  return execFileSync('docker', ['exec', ...(input ? ['-i'] : []), ...args], { encoding: 'utf8', input, stdio: ['pipe', 'pipe', 'pipe'] });
}
async function hospital() {
  const container = `${project}-hospital-db-1`;
  const user = zt.cfg('SAKAIME_HOSPITAL_PG_USER') ?? 'sakaime';
  const probe = () => {
    try {
      return dockerExec([container, 'psql', '-U', user, '-d', 'hospital', '-At', '-c', "select to_regclass('public.cases') is not null"]).trim() === 't';
    } catch {
      return false;
    }
  };
  if (probe()) return say('kept', 'hospital database', 'tables already loaded');
  dockerExec([container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', user, '-d', 'hospital', '-f', '/seed/schema.sql']);
  dockerExec([container, 'psql', '-v', 'ON_ERROR_STOP=1', '-q', '-U', user, '-d', 'hospital', '-f', '/seed/load.sql']);
  say('created', 'hospital database', 'schema and rows loaded from data/silos/hospital');
}

// (2) Object store ------------------------------------------------------------------------------------------------
async function put(path, body) {
  const res = await fetch(`${s3Url}/${path}`, { method: 'PUT', body, signal: AbortSignal.timeout(60_000) });
  // Creating a bucket that already exists answers 409; that is the idempotent case.
  if (!res.ok && !(body === undefined && res.status === 409)) throw new Error(`PUT ${path} -> HTTP ${res.status}`);
}
async function objectStore() {
  // S3Mock keeps objects in memory, so every run re-uploads everything; PUT is idempotent.
  for (const bucket of ['sakaime-registry', 'sakaime-vendor', 'sakaime-documents', 'sakaime-lake']) await put(bucket);
  let count = 0;
  for (const f of readdirSync(join(siloDir, 'registry')).filter((n) => n.endsWith('.csv'))) {
    const table = f.replace(/\.csv$/, '');
    await put(`sakaime-registry/${table}/${f}`, readFileSync(join(siloDir, 'registry', f)));
    count += 1;
  }
  for (const f of readdirSync(join(siloDir, 'vendor_packets')).filter((n) => n.endsWith('.csv'))) {
    const table = f.replace(/\.csv$/, '');
    await put(`sakaime-vendor/${table}/${f}`, readFileSync(join(siloDir, 'vendor_packets', f)));
    count += 1;
  }
  for (const f of readdirSync(join(siloDir, 'documents', 'fda_summaries')).filter((n) => n.endsWith('.pdf'))) {
    await put(`sakaime-documents/fda_summaries/${f}`, readFileSync(join(siloDir, 'documents', 'fda_summaries', f)));
    count += 1;
  }
  await put('sakaime-lake/lake/.keep', 'x');
  say('uploaded', 'object store', `${count} objects in sakaime-registry, sakaime-vendor, sakaime-documents`);
}

// (3) Zetaris sources ---------------------------------------------------------------------------------------------
async function sources() {
  const datasources = names(await zt.sql('admin', 'SHOW DATASOURCES'));
  if (datasources.has('hospital')) say('kept', 'datasource hospital');
  else {
    const user = zt.cfg('SAKAIME_HOSPITAL_PG_USER') ?? 'sakaime';
    const password = zt.cfg('SAKAIME_HOSPITAL_PG_PASSWORD');
    await exec('create datasource hospital', `CREATE DATASOURCE hospital DESCRIBE BY "Synthetic_hospital_review_database_constructed" OPTIONS (jdbcdriver "org.postgresql.Driver", jdbcurl "jdbc:postgresql://hospital-db:5432/hospital", username "${user}", password "${password}")`);
    await exec('register hospital tables', 'REGISTER DATASOURCE TABLES FROM hospital');
    say('created', 'datasource hospital', '9 tables');
  }

  const databases = names(await zt.sql('admin', 'SHOW LIGHTNING DATABASES'));
  const ensureDb = async (name, description) => {
    if (databases.has(name)) return;
    await exec(`create database ${name}`, `CREATE LIGHTNING DATABASE ${name} DESCRIBE BY "${description}"`);
    say('created', `lightning database ${name}`);
  };
  const ensureTable = async (database, table, createStatement) => {
    if (await exists(`SELECT 1 FROM ${database}.${table} LIMIT 1`)) return say('kept', `${database}.${table}`);
    await exec(`create ${database}.${table}`, createStatement);
    say('created', `${database}.${table}`);
  };

  await ensureDb('sk_registry', 'Regulator_and_registry_snapshots_normalised_from_recorded_public_records');
  for (const t of ['fda_510k', 'fda_udi', 'fda_classification', 'ctgov_studies', 'pubmed_articles']) {
    await ensureTable('sk_registry', t, `CREATE LIGHTNING FILESTORE TABLE ${t} FROM sk_registry FORMAT CSV OPTIONS (path "s3a://sakaime-registry/${t}/${t}.csv", ${csvOptions})`);
  }
  await ensureDb('sk_vendor', 'Vendor_packet_exports_constructed');
  for (const t of ['vendor_packets', 'vendor_claims']) {
    await ensureTable('sk_vendor', t, `CREATE LIGHTNING FILESTORE TABLE ${t} FROM sk_vendor FORMAT CSV OPTIONS (path "s3a://sakaime-vendor/${t}/${t}.csv", ${csvOptions})`);
  }
  await ensureDb('sk_docs', 'FDA_summary_PDFs_read_through_the_PDF_filestore_format');
  // preview_len is the option this build reads (found in the driver classes); pdf_preview_len and eight other spellings
  // are stored without error and ignored, so the preview silently stays at 1000 characters.
  const stored = await zt.rest('admin', 'GET', '/lightning-database/databases/sk_docs/file-store-tables/fda_summaries');
  if (stored.status === 200 && stored.body?.parameters?.preview_len === undefined) {
    // Registered earlier with an option name this build ignores; drop it so the correct option takes effect.
    await exec('drop fda_summaries (wrong preview option)', 'DROP LIGHTNING DATABASE TABLE sk_docs.fda_summaries');
    say('dropped', 'sk_docs.fda_summaries', 'was registered without preview_len');
  }
  await ensureTable('sk_docs', 'fda_summaries', `CREATE LIGHTNING FILESTORE TABLE fda_summaries FROM sk_docs FORMAT PDF OPTIONS (path "s3a://sakaime-documents/fda_summaries/", preview_len "2000000", ${s3Options})`);
  await ensureTable('sk_docs', 'fda_summaries_default', `CREATE LIGHTNING FILESTORE TABLE fda_summaries_default FROM sk_docs FORMAT PDF OPTIONS (path "s3a://sakaime-documents/fda_summaries/", ${s3Options})`);

  await ensureDb('sk_rest', 'Small_bounded_JSON_endpoints_for_the_REST_table_gate');
  const req = (endpoint) => `REQUEST (endpoint "${endpoint}", method "GET", http_encoding "URLENCODED", response_type "JSON", insecure_ssl "false") HEADER () BODY ()`;
  await ensureTable('sk_rest', 'ctgov_eyeart_static', `CREATE LIGHTNING REST TABLE ctgov_eyeart_static FROM sk_rest ${req('http://rest-silo:8080/ctgov_eyeart_studies.json')}`);
  await ensureTable('sk_rest', 'fda_510k_k200667_static', `CREATE LIGHTNING REST TABLE fda_510k_k200667_static FROM sk_rest ${req('http://rest-silo:8080/openfda_510k_K200667.json')}`);
  await ensureTable('sk_rest', 'ctgov_eyeart_live', `CREATE LIGHTNING REST TABLE ctgov_eyeart_live FROM sk_rest ${req('https://clinicaltrials.gov/api/v2/studies?query.intr=EyeArt&pageSize=15&countTotal=true&fields=NCTId%2CBriefTitle%2CInterventionName%2CLeadSponsorName%2CEnrollmentCount%2CStartDate%2COverallStatus')}`);
  await ensureTable('sk_rest', 'fda_510k_k200667_live', `CREATE LIGHTNING REST TABLE fda_510k_k200667_live FROM sk_rest ${req('https://api.fda.gov/device/510k.json?search=k_number:K200667')}`);
}

// (4) Roles, users, grants ----------------------------------------------------------------------------------------
const roleOf = { reader: 'agent_readonly', assigned: 'case_reviewer_assigned', reviewer: 'case_reviewer_unassigned' };
const displayName = { reader: 'Agent Reader', assigned: 'Reviewer Assigned', reviewer: 'Reviewer Unassigned' };

async function identities() {
  const roles = await zt.rest('admin', 'GET', '/roles');
  const have = new Set((roles.body ?? []).map((r) => r.name.toLowerCase()));
  for (const [who, role] of Object.entries(roleOf)) {
    if (!have.has(role)) {
      const r = await zt.rest('admin', 'POST', '/roles', { body: { name: role, description: `Sakaime ${displayName[who]} role`.replaceAll(' ', '_'), level: 'GENERAL', status: 'Active' } });
      say(r.status === 200 ? 'created' : 'FAILED', `role ${role}`, r.status === 200 ? '' : `HTTP ${r.status}`);
      if (r.status !== 200) failures += 1;
    } else say('kept', `role ${role}`);
  }
  const users = await zt.rest('admin', 'GET', '/users');
  const haveUsers = new Set((users.body ?? []).map((u) => u.email.toLowerCase()));
  for (const who of Object.keys(roleOf)) {
    const id = zt.identities[who];
    if (!haveUsers.has(id.email.toLowerCase())) {
      const r = await zt.rest('admin', 'POST', '/users', { body: { email: id.email, name: displayName[who], level: 'GENERAL', password: id.password, isLdap: false, status: 'Active' } });
      say(r.status === 200 ? 'created' : 'FAILED', `user ${who}`, r.status === 200 ? '(general level, no admin rights)' : `HTTP ${r.status}`);
      if (r.status !== 200) failures += 1;
    } else say('kept', `user ${who}`);
    await exec(`assign ${who} to role`, `ASSIGN USER '${id.email}' TO ROLE '${roleOf[who]}'`, { tolerate: /already/i });
  }
}

async function grants() {
  for (const role of Object.values(roleOf)) {
    await exec(`assign hospital to ${role}`, `ASSIGN DATASOURCE hospital TO ROLE '${role}'`, { tolerate: /already/i });
    await exec(`grant hospital to ${role}`, `GRANT SELECT ON DATASOURCE NAMESPACE hospital TO ROLE '${role}'`);
    for (const db of ['sk_registry', 'sk_vendor', 'sk_docs', 'sk_rest']) {
      await exec(`assign ${db} to ${role}`, `ASSIGN LIGHTNING DATABASE ${db} TO ROLE '${role}'`, { tolerate: /already/i });
      await exec(`grant ${db} to ${role}`, `GRANT SELECT ON LIGHTNING DATABASE NAMESPACE ${db} TO ROLE '${role}'`);
    }
  }
  say('granted', 'SELECT on hospital, sk_registry, sk_vendor, sk_docs, sk_rest to the three roles', '(no INSERT, no admin commands)');
}

// (5) Policies ----------------------------------------------------------------------------------------------------
const field = (name, policy, type, options = []) => ({ name, dataType: { json: JSON.stringify(type), simpleString: type, typeName: type }, isNullable: true, metadata: { policy, policy_source: 'USER', options } });

async function postPolicy(tableType, database, table, build) {
  const path = `/access-control/cbac/generic/${tableType}/${database}/${table}`;
  const current = await zt.rest('admin', 'GET', path);
  const version = (current.body?.version ?? 0) + 1;
  const body = { id: table, partitionColumns: [], version, ...build() };
  const r = await zt.rest('admin', 'POST', path, { body });
  say(r.status === 200 ? 'set' : 'FAILED', `policy ${database}.${table}`, `version ${version}`);
  if (r.status !== 200) failures += 1;
}

async function policies() {
  const upper = (who) => zt.identities[who].email.toUpperCase();
  // Vendor-confidential columns are nulled (Deny) or masked (Masked) for the agent identity and for a reviewer who is not
  // assigned to the case. The assigned reviewer has no policy and sees everything. Hide is NOT used: on a file-store (CSV)
  // table Hide removes the column name from SELECT * but not its values, which then appear under the neighbouring column
  // names (gate Z-POL reproduces this).
  await postPolicy('FILESTORE', 'sk_vendor', 'vendor_claims', () => ({
    users: ['reader', 'reviewer'].map((who) => ({ username: upper(who), roleSelected: '', userLevelPolicy: 'confidential_hidden' })),
    roles: [],
    policies: [
      {
        policyName: 'confidential_hidden',
        filter: 'true',
        fields: [field('confidential_unit_price_usd', 'Deny', 'integer'), field('confidential_reference_site', 'Masked', 'string', [{ key: 'regex', value: '.*' }, { key: 'replacement', value: 'XXXX' }])],
      },
    ],
  }));
  // Row filter: a reviewer who is not assigned to the EyeArt case does not see its row in the hospital case table.
  await postPolicy('DATASOURCE', 'hospital', 'cases', () => ({
    users: [{ username: upper('reviewer'), roleSelected: '', userLevelPolicy: 'not_assigned_to_eyeart_case' }],
    roles: [],
    policies: [{ policyName: 'not_assigned_to_eyeart_case', filter: "case_id NOT IN ('CASE-2026-014','CASE-2026-021')", fields: [] }],
  }));
}

// (6) Unified Semantic Layer ---------------------------------------------------------------------------------------
async function semanticLayer() {
  await exec('namespace parent', 'CREATE NAMESPACE IF NOT EXISTS lightning.metastore');
  await exec('namespace', `CREATE NAMESPACE IF NOT EXISTS ${usl.USL_NAMESPACE}`);
  const listing = await zt.sql('admin', `SHOW NAMESPACES OR TABLES IN ${usl.USL_NAMESPACE}`);
  if (!listing.rows.some((r) => r.name === usl.USL_NAME)) {
    const r = await exec('compile USL', usl.compileStatement);
    if (r.outcome === 'OK') say('created', `USL ${usl.USL_NAME}`, `${Object.keys(usl.activations).length} tables compiled in one request`);
  } else say('kept', `USL ${usl.USL_NAME}`);

  const tables = await zt.sql('admin', `SHOW NAMESPACES OR TABLES IN ${usl.USL_NAMESPACE}.${usl.USL_NAME}`);
  const active = new Set(tables.rows.filter((r) => r.activated === 'true').map((r) => r.name));
  for (const [name, statement] of Object.entries(usl.activations)) {
    if (active.has(name)) {
      say('kept', `USL table ${name}`, 'activated');
      continue;
    }
    const r = await exec(`activate ${name}`, statement);
    if (r.outcome === 'OK') say('activated', `USL table ${name}`);
  }
  const dq = await zt.sql('admin', `LIST DQ USL ${usl.USL_NAMESPACE}.${usl.USL_NAME}`);
  const haveRules = new Set(dq.rows.map((r) => r.name));
  for (const rule of usl.dqRules) {
    if (haveRules.has(rule.rule)) continue;
    const r = await exec(`dq ${rule.rule}`, `REGISTER DQ ${rule.rule} TABLE ${usl.uslTable(rule.table)} AS ${rule.expression}`);
    if (r.outcome === 'OK') say('created', `DQ rule ${rule.rule}`, rule.table);
  }

  // Non-admin access to a USL needs both the SQL grant and the REST-side assignment of the USL instance to the role.
  const listing2 = await zt.sql('admin', `SHOW NAMESPACES OR TABLES IN ${usl.USL_NAMESPACE}`);
  const uslId = Number(listing2.rows.find((r) => r.name === usl.USL_NAME)?.usl_id);
  for (const role of Object.values(roleOf)) {
    await exec(`grant USL to ${role}`, `GRANT SELECT ON USL NAMESPACE ${usl.USL_NAMESPACE} TO ROLE '${role}'`);
    const r = await zt.rest('admin', 'POST', '/access-control/assign/role/usl', { body: { roleNames: [role.toUpperCase()], uslId } });
    if (r.status !== 200) {
      failures += 1;
      say('FAILED', `assign USL to ${role}`, `HTTP ${r.status}`);
    }
  }
  say('granted', 'USL sakaime_evidence to the three roles');
}

// (7) Catalog tags -------------------------------------------------------------------------------------------------
async function catalog() {
  const tagTable = async (database, table, tag) => {
    const have = await zt.rest('admin', 'GET', `/catalog/databases/${database}/tables/${table}/tags`);
    if ((have.body ?? []).includes(tag)) return;
    const r = await zt.rest('admin', 'POST', `/catalog/databases/${database}/tables/${table}/tags`, { body: { tag } });
    if (r.status !== 200) {
      failures += 1;
      say('FAILED', `tag ${database}.${table} ${tag}`, `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 160)}`);
    }
  };
  for (const t of ['fda_510k', 'fda_udi', 'fda_classification']) {
    await tagTable('sk_registry', t, 'authority_tier:regulator');
    await tagTable('sk_registry', t, 'licence:public_domain');
  }
  await tagTable('sk_registry', 'ctgov_studies', 'authority_tier:registry');
  await tagTable('sk_registry', 'pubmed_articles', 'authority_tier:literature');
  await tagTable('sk_vendor', 'vendor_claims', 'authority_tier:vendor_claim');
  const colPath = '/catalog/databases/sk_vendor/tables/vendor_claims/columns/confidential_unit_price_usd/tags';
  const haveColTags = await zt.rest('admin', 'GET', colPath);
  if (!(haveColTags.body ?? []).includes('vendor_confidential')) {
    const col = await zt.rest('admin', 'POST', colPath, { body: { tag: 'vendor_confidential' } });
    if (col.status !== 200) {
      failures += 1;
      say('FAILED', 'column tag vendor_confidential', `HTTP ${col.status} ${JSON.stringify(col.body).slice(0, 160)}`);
    }
  }
  say('tagged', 'catalog tags', 'authority tier, licence, vendor_confidential');
}

// (8) Iceberg fixture for time travel ----------------------------------------------------------------------------------
async function lake() {
  const lakes = await zt.sql('admin', 'SHOW DATALAKES');
  if (!lakes.rows.some((r) => r.name === 'sk_lake')) {
    // A path outside the shared customer-data tree is rejected ("Path does not exist or is not allowed"), and so is an
    // S3Mock bucket, so the lake lives in the shared volume that the driver and API both mount.
    execFileSync('docker', ['exec', `${project}-driver-1`, 'bash', '-c', 'mkdir -p /home/zetaris/customer-data/shared/lake && chmod 2775 /home/zetaris/customer-data/shared/lake']);
    await exec('create datalake', 'CREATE DATALAKE sk_lake OPTIONS (storageType "LOCAL", storagePath "/home/zetaris/customer-data/shared/lake")');
  }
  await exec('lake namespace', 'CREATE NAMESPACE IF NOT EXISTS sk_lake.evidence');
  if (!(await exists('SELECT 1 FROM sk_lake.evidence.registry_snapshot LIMIT 1'))) {
    await exec('create iceberg table', 'CREATE TABLE sk_lake.evidence.registry_snapshot (nct_id string, overall_status string, minimum_age_years double) USING iceberg');
    await exec('snapshot 1', "INSERT INTO sk_lake.evidence.registry_snapshot VALUES ('NCT03112005','RECRUITING',18.0)");
    await exec('snapshot 2', "UPDATE sk_lake.evidence.registry_snapshot SET overall_status = 'COMPLETED' WHERE nct_id = 'NCT03112005'");
    say('created', 'iceberg table sk_lake.evidence.registry_snapshot', 'two snapshots');
  } else say('kept', 'iceberg table sk_lake.evidence.registry_snapshot');
}

await hospital();
await objectStore();
await sources();
await identities();
await grants();
await policies();
await semanticLayer();
await catalog();
await lake();
if (failures > 0) {
  console.error(`seed finished with ${failures} failure(s)`);
  process.exit(1);
}
console.log('seed complete');
