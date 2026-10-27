-- Evidence Matrix, one statement over the three silos. Every silo is aggregated in its own subquery before any join,
-- because joining raw rows repeats amounts and counts once per match (the fan-out seen in an earlier project).
--   hospital.*      JDBC     synthetic hospital review database (constructed)
--   sk_registry.*   files    snapshots of recorded openFDA and ClinicalTrials.gov responses
--   sk_vendor.*     files    constructed vendor packet export
-- Grain: one row per (case, vendor claim).
SELECT
  c.case_id,
  c.intended_purpose,
  c.intended_setting,
  CAST(c.intended_min_age AS INT)               AS intended_min_age,
  s.product_name,
  vc.claim_id,
  vc.claimed_version,
  CAST(vc.claimed_min_age_years AS INT)         AS claimed_min_age_years,
  vc.claimed_setting,
  vc.claimed_purpose,
  k.k_number,
  k.decision_date,
  k.clearance_type,
  u.udi_versions,
  st.confirmed_studies,
  st.study_min_age_years,
  rq.requirement_count,
  rq.required_min_age,
  CASE WHEN instr(concat('|', coalesce(u.udi_versions, ''), '|'), concat('|', vc.claimed_version, '|')) > 0
       THEN 'LISTED' ELSE 'NOT_LISTED' END      AS version_in_device_record,
  CASE WHEN st.study_min_age_years IS NULL THEN 'UNKNOWN'
       WHEN CAST(vc.claimed_min_age_years AS DOUBLE) < st.study_min_age_years THEN 'CLAIM_BELOW_STUDY_MINIMUM'
       ELSE 'WITHIN_STUDY' END                  AS claim_age_vs_study,
  CASE WHEN st.study_min_age_years IS NULL THEN 'UNKNOWN'
       WHEN CAST(c.intended_min_age AS DOUBLE) >= st.study_min_age_years THEN 'COVERED_BY_STUDY'
       ELSE 'NOT_COVERED_BY_STUDY' END          AS case_age_vs_study
FROM hospital.cases c
JOIN hospital.submissions s ON s.submission_id = c.submission_id
JOIN sk_vendor.vendor_claims vc ON vc.packet_id = s.packet_id
JOIN sk_registry.fda_510k k ON k.k_number = s.regulator_submission_cited
LEFT JOIN (
  SELECT submission_number,
         concat_ws('|', sort_array(collect_set(version_or_model_number))) AS udi_versions
  FROM sk_registry.fda_udi
  GROUP BY submission_number
) u ON u.submission_number = k.k_number
LEFT JOIN (
  SELECT l.case_id,
         COUNT(DISTINCT t.nct_id)                           AS confirmed_studies,
         MIN(CAST(t.minimum_age_years AS DOUBLE))           AS study_min_age_years
  FROM hospital.evidence_links l
  JOIN sk_registry.ctgov_studies t ON t.nct_id = l.right_id
  WHERE l.link_class = 'CONFIRMED' AND l.right_type = 'ctgov_study'
  GROUP BY l.case_id
) st ON st.case_id = c.case_id
LEFT JOIN (
  SELECT applies_to_purpose,
         COUNT(*)                                                                                    AS requirement_count,
         MAX(CASE WHEN dimension = 'population_min_age' THEN CAST(required_value AS INT) END)        AS required_min_age
  FROM hospital.requirements
  GROUP BY applies_to_purpose
) rq ON rq.applies_to_purpose = c.intended_purpose
ORDER BY c.case_id, vc.claim_id
