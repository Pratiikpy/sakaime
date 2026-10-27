-- Loads the CSV files into the tables created by schema.sql. Runs inside the Postgres container, where the data
-- directory is mounted read-only at /seed. Order follows the foreign keys.
\set ON_ERROR_STOP on
\copy vendors          FROM '/seed/vendors.csv'          WITH (FORMAT csv, HEADER true)
\copy reviewers        FROM '/seed/reviewers.csv'        WITH (FORMAT csv, HEADER true)
\copy requirements     FROM '/seed/requirements.csv'     WITH (FORMAT csv, HEADER true)
\copy submissions      FROM '/seed/submissions.csv'      WITH (FORMAT csv, HEADER true)
\copy cases            FROM '/seed/cases.csv'            WITH (FORMAT csv, HEADER true)
\copy case_assignments FROM '/seed/case_assignments.csv' WITH (FORMAT csv, HEADER true)
\copy decisions        FROM '/seed/decisions.csv'        WITH (FORMAT csv, HEADER true)
\copy precedents       FROM '/seed/precedents.csv'       WITH (FORMAT csv, HEADER true)
\copy evidence_links   FROM '/seed/evidence_links.csv'   WITH (FORMAT csv, HEADER true)
