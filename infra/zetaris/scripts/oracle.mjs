// In-process DuckDB oracle: the same CSV files the silos are built from, queried by a second engine. A Zetaris answer is
// only accepted when this engine returns the same rows for the same logic.
//
// CLI: node infra/zetaris/scripts/oracle.mjs <file.duckdb.sql>     prints the rows as JSON

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { DuckDBInstance } from '@duckdb/node-api';
import { repoRoot } from './zt.mjs';

const silos = join(repoRoot, 'data', 'silos');
const sources = {
  hospital_vendors: 'hospital/vendors.csv',
  hospital_reviewers: 'hospital/reviewers.csv',
  hospital_requirements: 'hospital/requirements.csv',
  hospital_submissions: 'hospital/submissions.csv',
  hospital_cases: 'hospital/cases.csv',
  hospital_case_assignments: 'hospital/case_assignments.csv',
  hospital_decisions: 'hospital/decisions.csv',
  hospital_precedents: 'hospital/precedents.csv',
  hospital_evidence_links: 'hospital/evidence_links.csv',
  fda_510k: 'registry/fda_510k.csv',
  fda_udi: 'registry/fda_udi.csv',
  fda_classification: 'registry/fda_classification.csv',
  ctgov_studies: 'registry/ctgov_studies.csv',
  pubmed_articles: 'registry/pubmed_articles.csv',
  vendor_packets: 'vendor_packets/vendor_packets.csv',
  vendor_claims: 'vendor_packets/vendor_claims.csv',
};

export async function createOracle() {
  const instance = await DuckDBInstance.create(':memory:');
  const connection = await instance.connect();
  for (const [view, file] of Object.entries(sources)) {
    const path = join(silos, file).replaceAll('\\', '/').replaceAll("'", "''");
    // Everything is read as text and cast inside the statements, so type inference cannot differ from the silos.
    await connection.run(`CREATE VIEW ${view} AS SELECT * FROM read_csv('${path}', header = true, all_varchar = true)`);
  }
  return {
    async rows(statement) {
      const result = await connection.runAndReadAll(statement);
      return result.getRowObjectsJson();
    },
    close() {
      connection.closeSync?.();
    },
  };
}

const norm = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(s)) return String(Number(s));
  return s;
};

/** Cell-by-cell comparison of two result sets, order-insensitive on the given key columns. */
export function compareRows(expected, actual, keyColumns) {
  const key = (r) => keyColumns.map((c) => norm(r[c])).join('\u0001');
  const problems = [];
  const a = new Map(actual.map((r) => [key(r), r]));
  const e = new Map(expected.map((r) => [key(r), r]));
  if (a.size !== actual.length) problems.push('actual result has duplicate keys');
  if (e.size !== expected.length) problems.push('expected result has duplicate keys');
  for (const [k, row] of e) {
    const other = a.get(k);
    if (!other) {
      problems.push(`missing from actual: ${k.replaceAll('\u0001', ' / ')}`);
      continue;
    }
    for (const col of Object.keys(row)) {
      if (norm(row[col]) !== norm(other[col])) problems.push(`${k.replaceAll('\u0001', ' / ')} column ${col}: expected ${JSON.stringify(norm(row[col]))} got ${JSON.stringify(norm(other[col]))}`);
    }
  }
  for (const k of a.keys()) if (!e.has(k)) problems.push(`unexpected in actual: ${k.replaceAll('\u0001', ' / ')}`);
  return { equal: problems.length === 0, expectedRows: expected.length, actualRows: actual.length, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node oracle.mjs <file.duckdb.sql>');
    process.exit(2);
  }
  const oracle = await createOracle();
  console.log(JSON.stringify(await oracle.rows(readFileSync(file, 'utf8')), null, 2));
  oracle.close();
}
