// The Sakaime Unified Semantic Layer: one DDL, sent as a single COMPILE USL statement (a multi-table compile must not be
// split at semicolons), and one ACTIVATE USL TABLE per table. Every activation query casts each column explicitly to the
// declared type because Zetaris rejects a query column that would have to be downcast.
//
// Tables and where each comes from:
//   authorization_record   files   openFDA 510(k) snapshot
//   device_version         files   openFDA UDI snapshot, one row per device record
//   study_record           files   ClinicalTrials.gov snapshot
//   vendor_claim           files   constructed vendor packet export (confidential columns left out on purpose)
//   case_context           JDBC    constructed hospital review database
//   evidence_matrix        all     the headline join, one row per case and vendor claim

export const USL_NAME = 'sakaime_evidence';
export const USL_NAMESPACE = 'lightning.metastore.sakaime';
export const uslTable = (name) => `${USL_NAMESPACE}.${USL_NAME}.${name}`;

export const compileStatement = `COMPILE USL ${USL_NAME} DEPLOY NAMESPACE ${USL_NAMESPACE} DDL
CREATE TABLE authorization_record (
  k_number varchar(20) NOT NULL PRIMARY KEY,
  applicant varchar(200),
  device_name varchar(200),
  product_code varchar(10),
  decision_date date,
  clearance_type varchar(40)
);
CREATE TABLE device_version (
  device_record_key varchar(64) NOT NULL PRIMARY KEY,
  submission_number varchar(20) FOREIGN KEY REFERENCES authorization_record(k_number),
  brand_name varchar(200),
  version_or_model_number varchar(100),
  public_version_date date
);
CREATE TABLE study_record (
  nct_id varchar(20) NOT NULL PRIMARY KEY,
  brief_title varchar(500),
  overall_status varchar(40),
  start_date varchar(20),
  enrollment_count int,
  minimum_age_years decimal(6,2),
  record_kind varchar(20)
);
CREATE TABLE vendor_claim (
  claim_id varchar(20) NOT NULL PRIMARY KEY,
  packet_id varchar(20),
  cited_submission varchar(20) FOREIGN KEY REFERENCES authorization_record(k_number),
  claimed_version varchar(20),
  claimed_min_age_years int,
  claimed_setting varchar(100),
  claimed_purpose varchar(60)
);
CREATE TABLE case_context (
  case_id varchar(30) NOT NULL PRIMARY KEY,
  submission_id varchar(20),
  packet_id varchar(20),
  regulator_submission_cited varchar(20) FOREIGN KEY REFERENCES authorization_record(k_number),
  intended_purpose varchar(60),
  intended_setting varchar(60),
  intended_min_age int
);
CREATE TABLE evidence_matrix (
  matrix_key varchar(60) NOT NULL PRIMARY KEY,
  case_id varchar(30),
  claim_id varchar(20),
  product_name varchar(100),
  k_number varchar(20),
  udi_versions varchar(400),
  confirmed_studies int,
  study_min_age_years decimal(6,2),
  version_in_device_record varchar(20),
  claim_age_vs_study varchar(40),
  case_age_vs_study varchar(40)
)`;

const t = (n) => uslTable(n);

export const activations = {
  authorization_record: `ACTIVATE USL TABLE ${t('authorization_record')} AS
SELECT CAST(COALESCE(k_number, '') AS VARCHAR(20)) AS k_number,
       CAST(applicant AS VARCHAR(200)) AS applicant,
       CAST(device_name AS VARCHAR(200)) AS device_name,
       CAST(product_code AS VARCHAR(10)) AS product_code,
       CAST(decision_date AS DATE) AS decision_date,
       CAST(clearance_type AS VARCHAR(40)) AS clearance_type
FROM sk_registry.fda_510k`,
  device_version: `ACTIVATE USL TABLE ${t('device_version')} AS
SELECT CAST(COALESCE(public_device_record_key, '') AS VARCHAR(64)) AS device_record_key,
       CAST(submission_number AS VARCHAR(20)) AS submission_number,
       CAST(brand_name AS VARCHAR(200)) AS brand_name,
       CAST(version_or_model_number AS VARCHAR(100)) AS version_or_model_number,
       CAST(public_version_date AS DATE) AS public_version_date
FROM sk_registry.fda_udi`,
  study_record: `ACTIVATE USL TABLE ${t('study_record')} AS
SELECT CAST(COALESCE(nct_id, '') AS VARCHAR(20)) AS nct_id,
       CAST(brief_title AS VARCHAR(500)) AS brief_title,
       CAST(overall_status AS VARCHAR(40)) AS overall_status,
       CAST(start_date AS VARCHAR(20)) AS start_date,
       CAST(enrollment_count AS INT) AS enrollment_count,
       CAST(minimum_age_years AS DECIMAL(6,2)) AS minimum_age_years,
       CAST(record_kind AS VARCHAR(20)) AS record_kind
FROM sk_registry.ctgov_studies`,
  vendor_claim: `ACTIVATE USL TABLE ${t('vendor_claim')} AS
SELECT CAST(COALESCE(claim_id, '') AS VARCHAR(20)) AS claim_id,
       CAST(packet_id AS VARCHAR(20)) AS packet_id,
       CAST(cited_submission AS VARCHAR(20)) AS cited_submission,
       CAST(claimed_version AS VARCHAR(20)) AS claimed_version,
       CAST(claimed_min_age_years AS INT) AS claimed_min_age_years,
       CAST(claimed_setting AS VARCHAR(100)) AS claimed_setting,
       CAST(claimed_purpose AS VARCHAR(60)) AS claimed_purpose
FROM sk_vendor.vendor_claims`,
  case_context: `ACTIVATE USL TABLE ${t('case_context')} AS
SELECT CAST(COALESCE(c.case_id, '') AS VARCHAR(30)) AS case_id,
       CAST(c.submission_id AS VARCHAR(20)) AS submission_id,
       CAST(s.packet_id AS VARCHAR(20)) AS packet_id,
       CAST(s.regulator_submission_cited AS VARCHAR(20)) AS regulator_submission_cited,
       CAST(c.intended_purpose AS VARCHAR(60)) AS intended_purpose,
       CAST(c.intended_setting AS VARCHAR(60)) AS intended_setting,
       CAST(c.intended_min_age AS INT) AS intended_min_age
FROM hospital.cases c
JOIN hospital.submissions s ON s.submission_id = c.submission_id`,
  evidence_matrix: `ACTIVATE USL TABLE ${t('evidence_matrix')} AS
SELECT CAST(COALESCE(concat(c.case_id, '|', vc.claim_id), '') AS VARCHAR(60)) AS matrix_key,
       CAST(c.case_id AS VARCHAR(30)) AS case_id,
       CAST(vc.claim_id AS VARCHAR(20)) AS claim_id,
       CAST(s.product_name AS VARCHAR(100)) AS product_name,
       CAST(k.k_number AS VARCHAR(20)) AS k_number,
       CAST(u.udi_versions AS VARCHAR(400)) AS udi_versions,
       CAST(st.confirmed_studies AS INT) AS confirmed_studies,
       CAST(st.study_min_age_years AS DECIMAL(6,2)) AS study_min_age_years,
       CAST(CASE WHEN instr(concat('|', coalesce(u.udi_versions, ''), '|'), concat('|', vc.claimed_version, '|')) > 0
                 THEN 'LISTED' ELSE 'NOT_LISTED' END AS VARCHAR(20)) AS version_in_device_record,
       CAST(CASE WHEN st.study_min_age_years IS NULL THEN 'UNKNOWN'
                 WHEN CAST(vc.claimed_min_age_years AS DOUBLE) < st.study_min_age_years THEN 'CLAIM_BELOW_STUDY_MINIMUM'
                 ELSE 'WITHIN_STUDY' END AS VARCHAR(40)) AS claim_age_vs_study,
       CAST(CASE WHEN st.study_min_age_years IS NULL THEN 'UNKNOWN'
                 WHEN CAST(c.intended_min_age AS DOUBLE) >= st.study_min_age_years THEN 'COVERED_BY_STUDY'
                 ELSE 'NOT_COVERED_BY_STUDY' END AS VARCHAR(40)) AS case_age_vs_study
FROM hospital.cases c
JOIN hospital.submissions s ON s.submission_id = c.submission_id
JOIN sk_vendor.vendor_claims vc ON vc.packet_id = s.packet_id
JOIN sk_registry.fda_510k k ON k.k_number = s.regulator_submission_cited
LEFT JOIN (
  SELECT submission_number, concat_ws('|', sort_array(collect_set(version_or_model_number))) AS udi_versions
  FROM sk_registry.fda_udi GROUP BY submission_number
) u ON u.submission_number = k.k_number
LEFT JOIN (
  SELECT l.case_id, COUNT(DISTINCT t.nct_id) AS confirmed_studies, MIN(CAST(t.minimum_age_years AS DOUBLE)) AS study_min_age_years
  FROM hospital.evidence_links l JOIN sk_registry.ctgov_studies t ON t.nct_id = l.right_id
  WHERE l.link_class = 'CONFIRMED' AND l.right_type = 'ctgov_study'
  GROUP BY l.case_id
) st ON st.case_id = c.case_id`,
};

// Data-quality rules. The first is the completeness gate: a ClinicalTrials.gov record that came from a search summary
// carries no eligibility block, so its minimum age is unknown; such a record must not feed an applicability decision.
export const dqRules = [
  { rule: 'has_eligibility', table: 'study_record', expression: 'minimum_age_years IS NOT NULL' },
  { rule: 'age_in_range', table: 'vendor_claim', expression: 'claimed_min_age_years BETWEEN 0 AND 120' },
  { rule: 'cites_a_submission', table: 'vendor_claim', expression: "cited_submission IS NOT NULL AND cited_submission <> ''" },
  { rule: 'has_version', table: 'device_version', expression: "version_or_model_number IS NOT NULL AND version_or_model_number <> ''" },
];
