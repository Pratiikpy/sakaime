-- Synthetic hospital review database for Sakaime. Every row is CONSTRUCTED: no patient data, no real hospital policy,
-- no statement by any real company. The CSV files next to this script are the single source of truth; this script and
-- load.sql only give them types and keys so that Postgres and the in-process DuckDB oracle hold identical rows.

CREATE TABLE vendors (
  vendor_id               text PRIMARY KEY,
  vendor_name             text NOT NULL,
  registry_applicant_name text NOT NULL,
  relationship_status     text NOT NULL,
  contract_status         text NOT NULL,
  provenance              text NOT NULL CHECK (provenance = 'CONSTRUCTED')
);

CREATE TABLE reviewers (
  reviewer_id  text PRIMARY KEY,
  display_name text NOT NULL,
  role         text NOT NULL,
  org_unit     text NOT NULL,
  provenance   text NOT NULL CHECK (provenance = 'CONSTRUCTED')
);

CREATE TABLE requirements (
  requirement_id      text PRIMARY KEY,
  applies_to_purpose  text NOT NULL,
  dimension           text NOT NULL,
  comparator          text NOT NULL,
  required_value      text NOT NULL,
  rationale           text NOT NULL,
  policy_ref          text NOT NULL,
  policy_version      text NOT NULL,
  effective_date      date NOT NULL,
  provenance          text NOT NULL CHECK (provenance = 'CONSTRUCTED')
);

CREATE TABLE submissions (
  submission_id             text PRIMARY KEY,
  vendor_id                 text NOT NULL REFERENCES vendors,
  product_name              text NOT NULL,
  product_version_claimed   text NOT NULL,
  packet_id                 text NOT NULL,
  received_date             date NOT NULL,
  regulator_submission_cited text NOT NULL,
  status                    text NOT NULL,
  provenance                text NOT NULL CHECK (provenance = 'CONSTRUCTED')
);

CREATE TABLE cases (
  case_id             text PRIMARY KEY,
  submission_id       text NOT NULL REFERENCES submissions,
  intended_purpose    text NOT NULL,
  intended_setting    text NOT NULL,
  intended_min_age    integer NOT NULL,
  intended_population text NOT NULL,
  intended_camera     text NOT NULL,
  deployment_date     date NOT NULL,
  opened_on           date NOT NULL,
  state               text NOT NULL,
  provenance          text NOT NULL CHECK (provenance = 'CONSTRUCTED')
);

CREATE TABLE case_assignments (
  case_id     text NOT NULL REFERENCES cases,
  reviewer_id text NOT NULL REFERENCES reviewers,
  assigned_on date NOT NULL,
  provenance  text NOT NULL CHECK (provenance = 'CONSTRUCTED'),
  PRIMARY KEY (case_id, reviewer_id)
);

CREATE TABLE decisions (
  decision_id text PRIMARY KEY,
  case_id     text NOT NULL REFERENCES cases,
  decision    text NOT NULL CHECK (decision IN ('PROCEED_TO_CLINICAL_REVIEW', 'NEEDS_EVIDENCE', 'ON_HOLD')),
  rationale   text NOT NULL,
  decided_by  text NOT NULL REFERENCES reviewers,
  decided_on  date NOT NULL,
  provenance  text NOT NULL CHECK (provenance = 'CONSTRUCTED')
);

CREATE TABLE precedents (
  precedent_id      text PRIMARY KEY,
  scope_org         text NOT NULL,
  topic             text NOT NULL,
  statement         text NOT NULL,
  created_from_case text NOT NULL REFERENCES cases,
  created_on        date NOT NULL,
  provenance        text NOT NULL CHECK (provenance = 'CONSTRUCTED')
);

-- Reviewer-confirmed and candidate identity links between records in different silos. A key match alone never creates
-- a CONFIRMED row; confirmed_by is required for CONFIRMED and forbidden for the other classes.
CREATE TABLE evidence_links (
  link_id      text PRIMARY KEY,
  case_id      text NOT NULL REFERENCES cases,
  left_type    text NOT NULL,
  left_id      text NOT NULL,
  right_type   text NOT NULL,
  right_id     text NOT NULL,
  link_class   text NOT NULL CHECK (link_class IN ('CONFIRMED', 'CANDIDATE', 'AMBIGUOUS')),
  basis        text NOT NULL,
  confirmed_by text REFERENCES reviewers,
  confirmed_on date,
  provenance   text NOT NULL CHECK (provenance = 'CONSTRUCTED'),
  CHECK ((link_class = 'CONFIRMED') = (confirmed_by IS NOT NULL))
);
