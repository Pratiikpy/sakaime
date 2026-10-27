// Normalises the recorded public-record fixtures (openFDA, ClinicalTrials.gov v2, PubMed) into flat, single-line CSV
// files for the registry silo. Zetaris reads these through filestore tables, which cannot unnest JSON, so the nesting is
// resolved here once and every output row keeps the hash of the file it came from.
//
// Usage (from the repository root):
//   node data/silos/build/normalise-registry.mjs [fixtures-dir]
// The default fixtures directory is research/feasibility/fixtures (local only, not committed). The generated CSV files
// under data/silos/registry are committed together with registry/MANIFEST.json, which records every source hash.

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { XMLParser } from 'fast-xml-parser';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');
const fixtures = resolve(process.argv[2] ?? join(root, 'research', 'feasibility', 'fixtures'));
const outDir = join(root, 'data', 'silos', 'registry');
mkdirSync(outDir, { recursive: true });

const RETRIEVED_ON = '2026-10-27';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
const readJson = (path) => {
  const raw = readFileSync(path);
  return { data: JSON.parse(raw.toString('utf8')), sha: sha256(raw) };
};
const rel = (path) => path.slice(fixtures.length + 1).replaceAll('\\', '/');

// One physical line per record: CSV readers in Spark treat embedded newlines as record breaks unless multiLine is set.
const oneLine = (value) =>
  String(value ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();

const csvCell = (value) => {
  const text = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const writeCsv = (name, columns, rows) => {
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((c) => csvCell(row[c])).join(','));
  const body = `${lines.join('\n')}\n`;
  writeFileSync(join(outDir, name), body, 'utf8');
  return { file: name, rows: rows.length, sha256: sha256(Buffer.from(body, 'utf8')) };
};

// '18 Years' -> 18, '6 Months' -> 0.5, 'N/A' or empty -> '' (unknown, never 0).
const ageInYears = (value) => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(Year|Month|Week|Day)s?\s*$/i.exec(String(value ?? ''));
  if (!m) return '';
  const n = Number(m[1]);
  const per = { year: 1, month: 1 / 12, week: 1 / 52, day: 1 / 365 }[m[2].toLowerCase()];
  return Number((n * per).toFixed(3));
};

const files = (dir, prefix) =>
  readdirSync(join(fixtures, dir))
    .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
    .sort()
    .map((f) => join(fixtures, dir, f));

const sourceUrlOf = (kind, key) =>
  ({
    '510k': `https://api.fda.gov/device/510k.json?search=k_number:${key}`,
    udi: `https://api.fda.gov/device/udi.json?search=premarket_submissions.submission_number:"${key}"&limit=100`,
    classification: `https://api.fda.gov/device/classification.json?search=product_code:${key}`,
    ctgov: `https://clinicaltrials.gov/api/v2/studies/${key}`,
    pubmed: `https://pubmed.ncbi.nlm.nih.gov/${key}/`,
  })[kind];

const manifest = { generated_by: 'data/silos/build/normalise-registry.mjs', retrieved_on: RETRIEVED_ON, outputs: [], sources: [] };

// ---- openFDA 510(k) ----------------------------------------------------------------------------------------------
const k510 = [];
for (const path of files('openfda', '510k_')) {
  const { data, sha } = readJson(path);
  manifest.sources.push({ file: rel(path), sha256: sha });
  for (const r of data.results ?? []) {
    k510.push({
      k_number: r.k_number,
      applicant: r.applicant,
      device_name: r.device_name,
      product_code: r.product_code,
      device_class: r.openfda?.device_class ?? '',
      regulation_number: r.openfda?.regulation_number ?? '',
      decision_date: r.decision_date,
      date_received: r.date_received,
      decision_code: r.decision_code,
      decision_description: r.decision_description,
      clearance_type: r.clearance_type,
      statement_or_summary: r.statement_or_summary,
      advisory_committee_description: r.advisory_committee_description,
      openfda_last_updated: data.meta?.last_updated ?? '',
      source_url: sourceUrlOf('510k', r.k_number),
      source_sha256: sha,
      retrieved_on: RETRIEVED_ON,
    });
  }
}
k510.sort((a, b) => a.k_number.localeCompare(b.k_number));
manifest.outputs.push(
  writeCsv(
    'fda_510k.csv',
    ['k_number', 'applicant', 'device_name', 'product_code', 'device_class', 'regulation_number', 'decision_date', 'date_received', 'decision_code', 'decision_description', 'clearance_type', 'statement_or_summary', 'advisory_committee_description', 'openfda_last_updated', 'source_url', 'source_sha256', 'retrieved_on'],
    k510,
  ),
);

// ---- openFDA UDI --------------------------------------------------------------------------------------------------
const udi = [];
for (const path of files('openfda', 'udi_')) {
  const { data, sha } = readJson(path);
  manifest.sources.push({ file: rel(path), sha256: sha });
  const key = path.replace(/^.*udi_/, '').replace(/\.json$/, '');
  for (const r of data.results ?? []) {
    const submissions = (r.premarket_submissions ?? []).map((s) => s.submission_number);
    for (const submission of submissions.includes(key) ? [key] : submissions) {
      udi.push({
        submission_number: submission,
        public_device_record_key: r.public_device_record_key,
        brand_name: r.brand_name,
        company_name: r.company_name,
        version_or_model_number: r.version_or_model_number ?? '',
        catalog_number: r.catalog_number ?? '',
        device_description: oneLine(r.device_description),
        commercial_distribution_status: r.commercial_distribution_status,
        public_version_number: r.public_version_number,
        public_version_date: r.public_version_date,
        publish_date: r.publish_date,
        product_code: r.product_codes?.[0]?.code ?? '',
        source_url: sourceUrlOf('udi', key),
        source_sha256: sha,
        retrieved_on: RETRIEVED_ON,
      });
    }
  }
}
udi.sort((a, b) => a.submission_number.localeCompare(b.submission_number) || a.public_device_record_key.localeCompare(b.public_device_record_key));
manifest.outputs.push(
  writeCsv(
    'fda_udi.csv',
    ['submission_number', 'public_device_record_key', 'brand_name', 'company_name', 'version_or_model_number', 'catalog_number', 'device_description', 'commercial_distribution_status', 'public_version_number', 'public_version_date', 'publish_date', 'product_code', 'source_url', 'source_sha256', 'retrieved_on'],
    udi,
  ),
);

// ---- openFDA classification --------------------------------------------------------------------------------------
const classification = [];
for (const path of files('openfda', 'classification_')) {
  const { data, sha } = readJson(path);
  manifest.sources.push({ file: rel(path), sha256: sha });
  for (const r of data.results ?? []) {
    classification.push({
      product_code: r.product_code,
      device_name: r.device_name,
      device_class: r.device_class,
      regulation_number: r.regulation_number,
      medical_specialty_description: r.medical_specialty_description,
      definition: oneLine(r.definition ?? ''),
      source_url: sourceUrlOf('classification', r.product_code),
      source_sha256: sha,
      retrieved_on: RETRIEVED_ON,
    });
  }
}
classification.sort((a, b) => a.product_code.localeCompare(b.product_code));
manifest.outputs.push(
  writeCsv('fda_classification.csv', ['product_code', 'device_name', 'device_class', 'regulation_number', 'medical_specialty_description', 'definition', 'source_url', 'source_sha256', 'retrieved_on'], classification),
);

// ---- ClinicalTrials.gov v2 ---------------------------------------------------------------------------------------
// Full study records win over search summaries for the same NCT id.
const studies = new Map();
const fromSummary = (s, sha, file) => {
  const p = s.protocolSection ?? {};
  return {
    nct_id: p.identificationModule?.nctId,
    brief_title: oneLine(p.identificationModule?.briefTitle),
    official_title: '',
    overall_status: p.statusModule?.overallStatus ?? '',
    study_type: '',
    enrollment_count: p.designModule?.enrollmentInfo?.count ?? '',
    start_date: p.statusModule?.startDateStruct?.date ?? '',
    primary_completion_date: '',
    last_update_post_date: '',
    lead_sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name ?? '',
    conditions: '',
    interventions: (p.armsInterventionsModule?.interventions ?? []).map((i) => i.name).join(' | '),
    minimum_age: '',
    minimum_age_years: '',
    maximum_age: '',
    std_ages: '',
    sex: '',
    eligibility_summary: '',
    record_kind: 'search_summary',
    source_file: file,
    source_sha256: sha,
    retrieved_on: RETRIEVED_ON,
  };
};
for (const path of files('ctgov', 'search_')) {
  const { data, sha } = readJson(path);
  manifest.sources.push({ file: rel(path), sha256: sha });
  for (const s of data.studies ?? []) {
    const row = fromSummary(s, sha, rel(path));
    if (row.nct_id && !studies.has(row.nct_id)) studies.set(row.nct_id, row);
  }
}
for (const path of files('ctgov', 'study_')) {
  const { data, sha } = readJson(path);
  manifest.sources.push({ file: rel(path), sha256: sha });
  const p = data.protocolSection;
  const row = {
    nct_id: p.identificationModule.nctId,
    brief_title: oneLine(p.identificationModule.briefTitle),
    official_title: oneLine(p.identificationModule.officialTitle),
    overall_status: p.statusModule?.overallStatus ?? '',
    study_type: p.designModule?.studyType ?? '',
    enrollment_count: p.designModule?.enrollmentInfo?.count ?? '',
    start_date: p.statusModule?.startDateStruct?.date ?? '',
    primary_completion_date: p.statusModule?.primaryCompletionDateStruct?.date ?? '',
    last_update_post_date: p.statusModule?.lastUpdatePostDateStruct?.date ?? '',
    lead_sponsor: p.sponsorCollaboratorsModule?.leadSponsor?.name ?? '',
    conditions: (p.conditionsModule?.conditions ?? []).join(' | '),
    interventions: (p.armsInterventionsModule?.interventions ?? []).map((i) => i.name).join(' | '),
    minimum_age: p.eligibilityModule?.minimumAge ?? '',
    minimum_age_years: ageInYears(p.eligibilityModule?.minimumAge),
    maximum_age: p.eligibilityModule?.maximumAge ?? '',
    std_ages: (p.eligibilityModule?.stdAges ?? []).join(' | '),
    sex: p.eligibilityModule?.sex ?? '',
    eligibility_summary: oneLine(p.eligibilityModule?.eligibilityCriteria ?? '').slice(0, 1200),
    record_kind: 'full_study',
    source_file: rel(path),
    source_sha256: sha,
    retrieved_on: RETRIEVED_ON,
  };
  studies.set(row.nct_id, row);
}
const studyRows = [...studies.values()].sort((a, b) => a.nct_id.localeCompare(b.nct_id));
manifest.outputs.push(
  writeCsv(
    'ctgov_studies.csv',
    ['nct_id', 'brief_title', 'official_title', 'overall_status', 'study_type', 'enrollment_count', 'start_date', 'primary_completion_date', 'last_update_post_date', 'lead_sponsor', 'conditions', 'interventions', 'minimum_age', 'minimum_age_years', 'maximum_age', 'std_ages', 'sex', 'eligibility_summary', 'record_kind', 'source_file', 'source_sha256', 'retrieved_on'],
    studyRows,
  ),
);

// ---- PubMed efetch XML -------------------------------------------------------------------------------------------
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true, parseTagValue: false });
const asArray = (v) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v === undefined || v === null ? '' : typeof v === 'object' ? (v['#text'] ?? Object.values(v).map(text).join(' ')) : String(v));
const articles = new Map();
const pubmedDir = join(fixtures, 'pubmed');
for (const f of readdirSync(pubmedDir).filter((n) => n.startsWith('ef_') && n.endsWith('.xml')).sort()) {
  const raw = readFileSync(join(pubmedDir, f));
  const sha = sha256(raw);
  manifest.sources.push({ file: `pubmed/${f}`, sha256: sha });
  const doc = parser.parse(raw.toString('utf8'));
  for (const a of asArray(doc.PubmedArticleSet?.PubmedArticle)) {
    const c = a.MedlineCitation;
    const art = c.Article;
    const pmid = text(c.PMID);
    if (articles.has(pmid)) continue;
    const ids = asArray(art.ELocationID).filter((e) => e['@_EIdType'] === 'doi').map(text);
    const pubDate = art.Journal?.JournalIssue?.PubDate ?? {};
    const year = text(pubDate.Year) || text(pubDate.MedlineDate).slice(0, 4);
    const databanks = asArray(art.DataBankList?.DataBank).flatMap((d) => asArray(d.AccessionNumberList?.AccessionNumber).map(text));
    articles.set(pmid, {
      pmid,
      title: oneLine(text(art.ArticleTitle)),
      journal: oneLine(text(art.Journal?.Title)),
      pub_year: year,
      doi: ids[0] ?? '',
      nct_ids: databanks.filter((d) => /^NCT\d{8}$/.test(d)).join(' | '),
      publication_types: asArray(art.PublicationTypeList?.PublicationType).map(text).join(' | '),
      abstract_text: oneLine(asArray(art.Abstract?.AbstractText).map(text).join(' ')),
      source_url: sourceUrlOf('pubmed', pmid),
      source_file: `pubmed/${f}`,
      source_sha256: sha,
      retrieved_on: RETRIEVED_ON,
    });
  }
}
const articleRows = [...articles.values()].sort((a, b) => Number(a.pmid) - Number(b.pmid));
manifest.outputs.push(
  writeCsv('pubmed_articles.csv', ['pmid', 'title', 'journal', 'pub_year', 'doi', 'nct_ids', 'publication_types', 'abstract_text', 'source_url', 'source_file', 'source_sha256', 'retrieved_on'], articleRows),
);

manifest.sources.sort((a, b) => a.file.localeCompare(b.file));
writeFileSync(join(outDir, 'MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
for (const o of manifest.outputs) console.log(`${o.file}: ${o.rows} rows`);
