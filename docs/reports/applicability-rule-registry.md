# Sakaime Applicability Rule Registry (source-cited)

Compiled 2026-10-27 for the Applicability Compiler. Tags: [PRIMARY-VERIFIED] = I read the text and quote it (<=25 words per quote). [SECONDARY] = reported by a non-primary source. [NOT VERIFIED] = not read. [DESIGN] = our inference, not stated by any standard.
HONESTY NOTE: no standard below prescribes deterministic applicability checks. The rule *concepts* are cited; the executable logic and thresholds are [DESIGN] inferences, open to clinician challenge. Labels: S=SUPPORTED_FOR_SCOPE, N=SUPPORTED_ONLY_FOR_NARROWER_SCOPE, C=CONTRADICTED_BY_SPECIFIED_EVIDENCE, I=INSUFFICIENT_EVIDENCE, R=REQUIRES_DOMAIN_REVIEW.

## 0. Access ledger (what was actually read)

| Document | Access path | Read | NOT read |
|---|---|---|---|
| PROBAST+AI (BMJ 2025;388:e082505) | bmj.com via r.jina.ai (full text); Table 2 from Europe PMC PMC11931409 XML; Suppl. Tables 3+4 PDFs from Europe PMC | main text, Table 2, Suppl T3 (all 13pp), Suppl T4 (E&E Light) domains 1-3 + eval items | Suppl T4 domain 4 detail, Suppl T1/T2/T5 [NOT VERIFIED] |
| STARD-AI (Nat Med 2025, s41591-025-03953-8) | nature.com full text + /tables/2 | full 40-item checklist verbatim, rationale text | Suppl T3 item rationale; E&E is unpublished ("We intend to release...") |
| TRIPOD+AI (BMJ 2024;385:e078378) | bmj.com BLOCKED (Cloudflare CAPTCHA); read via Europe PMC PMC11019967 XML (same article, CC BY) | Table 2 checklist verbatim, scope statements | E&E document [NOT VERIFIED] |
| IMDRF SaMD N41 (2017) | imdrf.org PDF via r.jina.ai, 30pp | s5, s6.1, s7, s7.1, s8, s9 | Appendix, glossary detail |
| FDA PCCP final guidance, AI-enabled DSFs | fda.gov/media/166704 via r.jina.ai (direct curl: "Not found"). Header: "Document issued on August 18, 2025. Document originally issued on December 4, 2024." | s IV, V, VI.B-C, VII.B; 49pp | s VIII, Appendix A/B scenarios |
| GMLP | IMDRF N88 (Jan 2025, 9pp) full; FDA/Health Canada/MHRA Oct 2021 (2pp) full; FDA Transparency principles page partial | all 10 principles in both versions | PCCP guiding-principles page (fetched, unread) |
| HAIP AI Vendor Disclosure Framework | healthaipartnership.org page + Framework PDF (8pp) + Excel form (same question list) | all of it | NEJM AI paper (paywalled/unread) |
| FDA examples | accessdata.fda.gov via direct curl with browser UA (r.jina.ai is blocked for that domain) | DEN170073 (Viz.AI ContaCT) decision summary; K250694 (Scaida BrainCT-ICH v1.0) | DEN240019 URL 404 (not used); no PCCP-bearing summary found [NOT VERIFIED] |
| eCFR (2026-10-01 version) | ecfr.gov API | 21 CFR 801.4, 807.92, 814.20(b)(3)(i) | rest of parts 807/814 |

## 1. PROBAST+AI: PICOTS and applicability  [PRIMARY-VERIFIED]

1.1 Structure. "four domains, 34 signalling questions (16 for model development, 18 for model evaluation), and six applicability items (three each...)". KEY FINDING: applicability has NO signalling questions. It is 3 judgement items per phase (participants, predictors, outcome). There is no applicability item for Domain 4 (analysis). Setting is folded into participants.
1.2 Definition: "Whether the study in question is relevant (applicable) to the assessor's review question or the assessor's intended use of a model, including target population and setting." (Glossary)
1.3 Scope of the three items (Step 3): any concern that "the included data of the participants and setting (domain 1)", the predictors' "definition, preprocessing, assessment, or timing" (domain 2), or the outcome's "definition, assessment, or timing" (domain 3) "do not match" the review question or intended use.
1.4 PICOTS (Step 1; Suppl T3). Main text: "Population, Index model, Comparator model, Outcome, Timing, Setting, and intended use of the prediction model".
- P: "Define the target population (e.g., patients) in whom the assessed prediction models are to be applied."
- I: "Define the targeted prediction models to be assessed, which may be a single prediction model (the index model)".
- C: "Define the other prediction models whose predictive ability is compared to that of the index model."
- O: "Define the outcomes or endpoints that are predicted by the index (and possibly comparator) prediction models in the target population."
- T (two parts): "Define the moment or time-point (e.g., in the patient work-up) at which the prediction... is made"; and "Define the time or follow-up period in which the outcomes are being predicted... (prediction horizon)."
- S + intended use: "Define the healthcare setting or context to which the index prediction models apply. The prediction ability of models may change across healthcare settings or contexts."
1.5 The three applicability items, verbatim (Table 2, both phases). Answer options: low / high / unclear.
- D1: "Concern that the data of the included participants do not match the review question or the assessor's intended use of the prediction model". (Suppl T4 evaluation wording adds: "participants and setting".)
- D2: "Concern that the definition, preprocessing, assessment, or timing of assessment of the predictors in the model do not match the review question or the assessor's intended use"
- D3: "Concern that the outcome, its definition, assessment, or timing of assessment do not match the review question or the assessor's intended use"
1.6 Extraction prompts that Suppl T3 attaches to applicability (these are the real structured fields): D1 "Describe included data sources, participants, setting, and dates"; D2 "List and describe predictors... their timing of assessment"; D3 "At what time point was the outcome determined" and "If a composite outcome was used, describe the relative frequency/distribution of each contributing outcome".
1.7 Roll-up: "Low concern for applicability If all three domains were rated low"; "High... If at least one domain was rated high"; "Unclear... at least one domain was rated unclear and no domains were rated high".
1.8 Signalling-question answers (not applicability): "yes, probably yes, no, probably no, no information, or, when appropriate, not applicable". "If a signalling question is answered with no, it does not automatically result in a high concern." "The no information category should be used only when reported information is insufficient to permit a judgment."
1.9 Signalling questions that carry applicability-relevant facts (Table 2, verbatim): 1.1 "Were appropriate data sources used?"; 1.2 "Was an appropriate study design used?"; 1.3 "Did the inclusions and exclusions of study participants result in a representative dataset?"; 2.1 "Were predictors defined and assessed in a similar way for all participants?"; 2.4 "Were the predictors included in the model available at the time the model was intended to be used?"; 3.1 "Were outcomes defined and assessed appropriately?"; 3.4 "Was the time interval between predictor assessment and outcome assessment appropriate?"; eval 4.1 "Was model evaluation based on only apparent performance avoided?"; 4.2 "Was there evidence that the sample size was reasonable?"; 4.4 "If methods to address class imbalance were used, was the evaluation done in a dataset without correction for imbalance?"; 4.5 "...was there evidence that data leakage was avoided?"; 4.7 "Was the predictive performance of the model evaluated appropriately—for example, calibration, discrimination, and net benefit?"
1.10 E&E Light applicability guidance (Suppl T4): children vs adults example: "Studies that included only children have low applicability concerns, whereas studies in which adults and children were combined receive higher applicability concerns." RCT-derived models "need careful applicability consideration, due to, e.g., typically stricter in- and exclusion criteria, fewer predictors, shorter follow-up times." D2 example: point-of-care dichotomous D-dimer vs quantitative ELISA. D3: "a composite outcome that consisted of components different from the components of the outcome definition of the review question"; "no applicability concern, if the explicit aim... is to include all developed models". Evaluation: "External validation studies do not have the purpose to compare or find similar performance as found in the development study."
1.11 Bias vs imprecision: "bias must not be confused with imprecision, which arises when a model's performance estimate is based on a small evaluation sample".
1.12 Applicability is relative to the ASSESSOR's intended use: a model can have low quality concern "but a high concern for applicability if either does not match how the reviewer intends to use that model." This is the Sakaime claim-vs-evidence frame.

## 2. Reporting items that carry applicability facts  [PRIMARY-VERIFIED]

STARD-AI: 40 items; items 7, 25 modified; 6, 11-15b, 15d, 23, 28, 29, 35, 39, 40a/b new. TRIPOD+AI: "The checklist is not a quality appraisal tool." STARD-AI aim: "to improve completeness and transparency in study reporting". Reporting presence is not validity.

| Fact | STARD-AI item (verbatim, trimmed) | TRIPOD+AI item (verbatim, trimmed) |
|---|---|---|
| Intended use / user | 3 "intended use of the index test... its integration into an existing or new workflow"; 15d "The specified end-user of the index test and the level of expertise required" | 3b "target population and the intended purpose... in the context of the care pathway, including its intended users"; 27b "level of expertise is required of users" |
| Eligibility | 7 "listing separate inclusion and exclusion criteria... at both participant level and data level"; 8 "On what basis potentially eligible participants were identified" | 6b "Describe the eligibility criteria for study participants"; 6c treatments received |
| Setting / site | 9 "Where and when potentially eligible participants were identified (setting, location and dates)" | 6a "key elements of the study setting... including the number and location of centres" |
| Dates / timing | 9 (dates); 27 "Time interval and any clinical interventions between index test and reference standard" | 5b "dates of the collected participant data, including start and end of participant accrual"; 8a "outcome... and the time horizon" |
| Software/device version | 13 "Devices (manufacturer and model)... software (with version number) used to engineer the index test, highlighting the intended use" | NO version item. 12g "how the model predictions were calculated (eg, formula, code... application programming interface)"; 22 full model specification (development only) |
| Data provenance | 11 "Source of the data and whether they have been routinely collected, specifically collected... or acquired from an open-source repository"; 5 prospective vs retrospective; 10 consecutive/random/convenience | 5a "sources of data separately for the development and evaluation datasets... and representativeness of the data" |
| Acquisition/preprocessing | 14 "Data acquisition protocols... and details of data preprocessing" | 7 "data pre-processing and quality checking, including whether this was similar across relevant sociodemographic groups" |
| Index test dev + independence | 15a index test; 15b "How the index test was developed, including any training, validation, testing and external evaluation, detailing sample sizes" | 12a data partitioning; 12c model type and building steps; 16 "Identify any differences between the development and evaluation data in healthcare setting, eligibility criteria, outcome, and predictors" |
| Threshold / operating point | 15c "Definition of and rationale for test positivity cutoffs or result categories of the index test, distinguishing prespecified from exploratory" | 15 "Provide details and rationale for any classification and how the thresholds were identified" (development only) |
| Reference standard / outcome | 16a-c reference standard, rationale, cutoffs; 17a/b blinding | 8a outcome definition, how/when assessed; 8b-c assessor qualifications, blinding |
| Case mix | 25 "Baseline demographic, clinical and technical characteristics of training, validation and test sets"; 26a severity; 26b alternative diagnoses; 28 "Whether the datasets represent the distribution of the target condition that one would expect from the intended use population" | 20b characteristics "for each data source or setting, including the key dates... Report any differences across key demographic groups"; 20c (evaluation) comparison with development data |
| External evaluation gap | 29 "For external evaluation on an independent dataset, an assessment of how this differs from the training, validation and test sets" | 16; 20c |
| Estimates + subgroups | 21 "analyses of variability in diagnostic accuracy, distinguishing prespecified from exploratory"; 23 "performance error analysis and algorithmic bias and fairness"; 31 "Estimates of diagnostic accuracy and their precision" | 23a "performance estimates with confidence intervals, including for any key subgroups (eg, sociodemographic)"; 23b heterogeneity across clusters; 12d |
| Limitations / generalisability | 33 "Study limitations, including sources of potential bias, statistical uncertainty and generalizability" | 26; 27c "next steps... applicability and generalisability" |
| Provenance / independence | 38 funding; 39 "Commercial interests, if applicable"; 40a data/code availability; 40b "outputs are stored, auditable" | 18a funding and role of funders; 18b conflicts; 18e-f data/code sharing |

## 3. Concepts that bound a claim (IMDRF, FDA, GMLP)  [PRIMARY-VERIFIED]

C1 Intended use is legal and broader than the label text: 21 CFR 801.4 "refer to the objective intent of the persons legally responsible for the labeling of an article". Intent "may... be shown by labeling claims, advertising matter, or oral or written statements". So vendor marketing is itself intended-use evidence.
C2 Indications for use (IFU), 21 CFR 814.20(b)(3)(i): "A general description of the disease or condition the device will diagnose, treat, prevent, cure, or mitigate, including a description of the patient population". 510(k) summary, 807.92(a)(5): "A statement of the intended use... including a description, where appropriate, of the patient population". PCCP fn 93: FDA applies the 814.20 IFU definition to 510(k).
C3 Two separate bounds in PCCP: modifications "must maintain the device within the device's intended use" but only "should also maintain the device within the device's indications for use" (VI.C). Intended-use change is never PCCP material; IFU change is "difficult for FDA to assess prospectively".
C4 IMDRF definition statement (6.1): identifies "the intended medical purpose of the SaMD (treat, diagnose, drive clinical management, inform clinical management)" and situation "(critical, serious, non-serious)". Gives an ordinal purpose scale.
C5 Three evidence layers (N41 s5): valid clinical association "corresponds accurately in the real world to the healthcare situation and condition identified in the SaMD definition statement"; analytical validation: "accurately, reliably and precisely generate the intended technical output from the input data"; clinical validation: "ability of a SaMD to yield a clinically meaningful output associated to the target use". Clinically meaningful = "meaningful, measurable, patient-relevant clinical outcome(s)".
C6 Clinical validation evidence must be "tested in your target population and for your intended use" (s7). Allowed routes: "Referencing existing data from studies conducted for the same intended use; ... for a different intended use, where extrapolation of such data can be justified; or Generating new clinical data". Extrapolation is a human justification step.
C7 Novelty (s7.1): "Novel clinical association: ...new inputs, algorithms or outputs, new intended target population, or new intended use."
C8 If evidence is missing (s7): "Modify your intended use to one that can be supported by available evidence". Legitimises the NARROWER label.
C9 Independent review (s8): "more important for SaMD that 'Treats/Diagnoses Serious and Critical' health care situations and conditions and SaMD that 'Drives Critical'..." Reviewer: "has not been significantly involved in the development of the SaMD, and who does not have anything to gain".
C10 Change (s9): post-market assessment "may also lead to a change of intended use (e.g., expansion, modification, or restriction)"; "Real world performance data... may not be sufficient to generate complete clinical evidence necessary for a change to the SaMD definition statement".
C11 PCCP (FDA 2025): "An authorized PCCP is a technological characteristic of the authorized device". Consistent modification = "specified in the Description of Modifications... and implemented in accordance with the Modification Protocol". Otherwise "likely require a new marketing submission". PCCP identified by "title and version number" in the authorization letter (V.F). Permitted types (VI.C): quantitative performance specs via re-training "within the intended use population from the same type and range of input signal"; new input sources e.g. "different makes, models, or versions of a data/imaging acquisition system"; "use for... a specific subpopulation within the originally indicated population".
C12 What a version change implies: no standard says a version string alone settles applicability. FDA: with an authorized PCCP and conforming change, no new submission, but labeling "should reflect information about the current version(s)... including information regarding site-specific modifications" and a new version may need a new UDI (VII.B(4)). 510(k) must compare to "the version of the predicate device cleared or approved prior to changes made under the PCCP" (V.F). Local (site-specific) adaptation must be declared separately (VI.B).
C13 Test data must be sequestered: "Training data, tuning data, and test data are sequestered" (VII.B(1)); test data "never shown to the algorithm during training" (IV.B). Datasets "should be representative of the proposed intended use populations... and intended environments".
C14 GMLP (IMDRF N88 2025; same numbering in 2021 joint FDA/HC/MHRA doc): #3 representative data incl. "geographical location"; #4 "The extent of external validation is proportionate to risk" (2025 only); #8 "relevant subgroups, clinical environment and use by the human-AI team"; #9 users told "performance of the model for appropriate subgroups... acceptable inputs, known limitations" and "the scope and timing of device modifications and updates"; #10 monitoring and "dataset drift". 2021 #3: "so that results can be reasonably generalized to the population of interest".
C15 FDA transparency principles list as communicable limitations "known circumstances or use cases where the device input will not align with the data used to develop and validate the device" and "populations that are not well represented".

## 4. HAIP AI Vendor Disclosure Framework  [PRIMARY-VERIFIED]

Five domains (verbatim names): System Capabilities and Intended Use; System Performance and Compliance; Data Stewardship; Integration Requirements; Lifecycle Management. Scope: "commercially available, vendor-developed AI systems"; a disclosure checklist with no scoring or pass thresholds. Evidence-scope-relevant groups:
- D1 Intended Use "What is the AI system used for?"; Intended User; Limitations "What does the AI system not do?"; Inclusion/Exclusion Criteria "when the AI system should or should not be used, including patient characteristics and clinical scenarios"; Implementation Context (care setting Inpatient/Outpatient/Virtual/Direct to patient; level of care Urgent Care/Emergency/Intensive Care Unit); Cadence "At what point is this AI system used?"; Maturity Experimental vs Well-established, backed by "validation studies conducted beyond the development context".
- D2 Model Performance "what performance metrics were used, how was the model evaluated, and what were the resulting values?" (with "external validation data"; Model Facts label cited); Subgroup Performance Assessments; Risk (incl. "off-label system use, varying model performance from testing data"); Regulatory Status ("If a vendor asserts that an AI system does not require regulatory clearance, the vendor should provide a rationale", HDO "should validate this").
- D5 System Maintenance ("criteria for model updates", "performance distributions across models"; LLM: "prompt and response changes resulting from model updates"); System Performance Monitoring (drift thresholds).
- Limits: D1 "it is the HDO's responsibility to validate these claims within the intended local use context"; post-procurement "requires complementary local validation".

## 5. FDA public-document structure a parser can use  [PRIMARY-VERIFIED, 2 examples]

Example A: De Novo DEN170073 decision summary (ContaCT, product code QAS, 21 CFR 892.2080). Stable lettered headings: "A. De Novo Number", "B. Purpose for Submission", "C. Applicant", "D. Proprietary and Established Names", "E. Regulatory Information" (regulation, class, product code, panel), "F. Indications for Use" (1 IFU, 2 Special Conditions "For prescription use only", 3 Warnings, precautions, and limitations), "G. Device Description", "H. Standard/Guidance Document Referenced", "I. Performance Characteristics" (a Data Characteristics with "Inclusion Criteria"/"Exclusion Criteria", b Test Protocol, c Endpoints, d Test Results), "J. Summary of Clinical Information", "K. Proposed Labeling", "L. Identified Risks", "M. Benefit/Risk", "N. Conclusion" incl. special controls ("Labeling must include... A detailed description of the patient population for which the device is indicated").
- Usable facts: IFU states scope AND limits: "Identification of suspected findings is not for diagnostic use beyond notification." Input spec: "CT angiogram images of the brain acquired in the acute setting"; exclusion list incl. "slices thicker than 0.625mm". Test set: "300 CT angiogram (CTA) images (studies)... two clinical sites in the U.S.", "approximately equal numbers of positive and negative cases" (enriched, so predictive values not transportable). Result: sensitivity 87.8% (95% CI 81.2-92.5), specificity 89.6% (83.7-93.9), AUC 0.91. Comparator covered only a subset: "Standard of Care CTA-to-notification time was available in 85 reports of these 300 cases".
- Parser hazards: performance goals redacted as "(b) (4)"; OCR ligature damage ("Ground Trnth", "repo1ts", "ti�iage"); no software version string and no data-collection dates (grep: none); threshold appears only in G ("fixed optimum threshold, 60mm"), not restated in results.
Example B: 510(k) K250694, "Scaida BrainCT-ICH (v1.0)" (cleared 2025-11-25). Letter: "Trade/Device Name: Scaida BrainCT-ICH (v1.0)", "Regulation Number", "Product Code: QAS"; key scope clause: "substantially equivalent (for the indications for use stated in the enclosure)". Enclosure follows 21 CFR 807.92 order: (a)(1) contact, (a)(2) device name (version DROPPED: "Scaida BrainCT-ICH"), (a)(3) predicate K211179, (a)(4) description, (a)(5) "Intended use/Indications for Use", (a)(6) technological comparison, (b) "Non-Clinical and/or Clinical Tests Summary", "Performance Data".
- Usable facts: IFU "non-contrast head CT images of adult patients (ages 22 and above)", "assist trained radiologists in workflow triage", "not intended to be used as a diagnostic device or for use in patients under 22 years of age". Study: "294 cases... three institutions in the United States (two of which independent of the development set)", 63.9% ICH, scanners 53.4% GE / 9.9% Siemens / 36.7% Toshiba, 85.0% aged >40. Sensitivity 0.867 (95% CI 0.811-0.908), specificity 0.887 (0.812-0.934), AUC 0.926. "Clinical tests were not conducted".
- Missing in B (real examples of INSUFFICIENT triggers): no collection dates, no operating threshold, no per-subgroup sensitivity, no care setting, no software build; ICH expanded inconsistently ("intracranial" vs "intracerebral"). Its SE conclusion is relative: "as safe and effective as the legally marketed predicate".
- Letter caveat (verbatim): "FDA's issuance of a substantial equivalence determination does not mean that FDA has made a determination that your device complies with other requirements of the Act".

## 6. Typed field schema (JSON-schema-like) [DESIGN, fields traced to sources]

Common: every field is {value, status: stated|inferred|absent, source_span, source_doc_id}. Absent never defaults to a value. "src" = where the field comes from.

DeviceIdentity
- manufacturer, product_name: string | src: 807.92(a)(1)-(2); STARD-AI 13
- version.label: string; version.scheme: enum[semver, vendor_label, build_hash, none]; version.resolvable: enum[exact, family, unknown] | src: STARD-AI 13 "software (with version number)"; K250694 letter "(v1.0)"; PCCP VII.B(4) "current version(s)"
- identifiers: {k_number|den_number|pma_number, udi_di, product_code, regulation_number} | src: DEN170073 E; K250694 letter
- input_spec: {modality, acquisition_devices[{maker, model}], protocol_constraints[], technical_exclusions[]} | src: STARD-AI 13-14; DEN170073 I.a; PCCP VI.C
- output_spec: {type: enum[binary_flag, score, probability, ranked_list, text], threshold: {value, unit, prespecified: bool|unknown}} | src: STARD-AI 15c; TRIPOD 15
- model_basis: enum[traditional_ml, deep_learning, llm, rule_based, unknown]; llm: {base_model, prompt_version} | src: HAIP D2, D5
- pccp: {present: bool|unknown, title, version, modification_classes[]: enum[performance_retraining, new_input_source, subpopulation_use, other]} | src: PCCP V.C, V.F, VI.C
- adaptation_mode: enum[global, local_site_specific, mixed, unknown] | src: PCCP VI.B

AuthorizationScope
- pathway: enum[510k, de_novo, pma, exempt, claimed_not_device, none, unknown]; number; decision_date: date; regulation; class; product_code
- device_name_as_authorized: string (version retained if present in letter)
- indications_for_use: {raw_text, condition, purpose_class: enum[inform, drive, diagnose_or_treat], population: {age_min, age_max, sex, other[]}, user_roles[], settings[], input_modality} | src: 814.20(b)(3)(i); 807.92(a)(5); IMDRF s6.1
- intended_use_raw: string (labeling + marketing) | src: 801.4
- limitations[]: {text, kind: enum[excluded_population, not_for_diagnostic_use, input_requirement, user_restriction, other]} | src: DEN170073 F.3
- special_conditions: enum[prescription_only, other, none] | src: DEN170073 F.2
- predicate: {number, ifu_same: bool}; clinical_tests: enum[conducted, not_conducted, unknown] | src: 807.92(a)(3),(b)(2); K250694
- authorized_scope_clause: string, e.g. "for the indications for use stated in the enclosure"

EvidenceScope
- source_type: enum[peer_reviewed_study, preprint, regulatory_summary, vendor_whitepaper, vendor_claim, model_facts_label]; doc_date
- provenance: {independent_of_vendor: yes|no|unknown, funder, conflicts, data_code_available} | src: STARD-AI 38-40a; TRIPOD 18a-f; IMDRF s8
- design: {prospective: bool|unknown, evaluation_type: enum[apparent, internal, external], series: enum[consecutive, random, convenience, unknown]} | src: STARD-AI 5, 10; PROBAST+AI Box 1
- device_version_evaluated[]: DeviceIdentity.version (all versions tested)
- data: {accrual_start, accrual_end, sites_n, countries[], care_settings[], sampling: enum[consecutive, enriched_case_control, unknown], capture_devices[]} | src: TRIPOD 5b, 6a; STARD-AI 9, 13
- population: {inclusion[], exclusion[], age_range, sex_dist, race_ethnicity_dist, condition_prevalence, n, n_events, subgroups[]} | src: STARD-AI 7, 25, 26a/b, 28; TRIPOD 6b, 20b
- independence: {train_test_independent: yes|no|unknown, independence_level: enum[patient, site, temporal, none], external_differences_reported: bool} | src: GMLP 4; PROBAST+AI 4.5; STARD-AI 29
- outcome: {name, definition, reference_standard, assessor_blinded, time_horizon, composite_components[]} | src: PROBAST+AI D3; STARD-AI 16a-c; TRIPOD 8a
- comparator: {kind: enum[none, standard_of_care, other_device, clinician, human_ai_team], n_compared} | src: PROBAST+AI PICOTS-C; DEN170073 secondary analysis
- role_evaluated: enum[standalone, human_ai_team] | src: GMLP 7/8
- results[]: {metric, value, ci_lo, ci_hi, n, threshold, subgroup, prespecified: bool|unknown} | src: STARD-AI 31, 15c, 21; TRIPOD 23a
- evidence_level: enum[analytical, accuracy_clinical_validation, clinical_utility_outcome] | src: IMDRF s5.3-5.4
- appraisal (optional, if a human did it): {probast_ai: {rob, applicability_by_domain[3]}, assessor, date}

ClaimedUse
- device: DeviceIdentity subset (exact version required or family); deployment_date
- purpose: {purpose_class: enum[inform, drive, diagnose_or_treat], healthcare_situation: enum[non_serious, serious, critical], target_condition, role: enum[standalone, human_ai_team, autonomous]} | src: IMDRF s6.1; PROBAST+AI "intended use"
- population: {age_min, age_max, sex, inclusion[], exclusion[], required_subgroups[]} | src: PROBAST+AI PICOTS-P
- setting: {care_setting, level_of_care, sites[], countries[], user_roles[], integration: enum[standalone, partial, full]} | src: TRIPOD 6a; HAIP D1, D4
- timing: {t0_stage: enum on ordered care pathway, horizon, cadence} | src: PROBAST+AI PICOTS-T; HAIP Cadence
- outcome_metric: {outcome, metric, operating_point, minimum_value, comparator} | src: PROBAST+AI PICOTS-O,C; STARD-AI 15c
- claim_level: same enum as evidence_level
- claim_sources[]: {text, origin: enum[vendor_marketing, label, contract, internal]}  (801.4: marketing = intended-use evidence)

## 7. Rule registry (38 rules)  [PRIMARY-VERIFIED citations; rule logic = DESIGN]

Aggregation [DESIGN]: split the claim into atoms (population slice x setting x metric x version). Evaluate each atom. Overall = worst atom by C > I > R > N > S; always also return the per-atom map. Absent evidence NEVER yields S. "JUDGMENT" = must return R, tool must not decide.

Identity and version
R01 VER-DISJOINT | claim.version, evidence.device_version_evaluated[] | claimed set and evaluated set disjoint -> I. Overlap but claimed set larger (e.g. "v2.x" vs tested v2.0) -> N. | JUDGMENT no | Refines "version not in evidence -> narrower": a wholly different version supports nothing. Cite STARD-AI 13; PCCP V.D (modification must be specified AND implemented per protocol); K250694 letter "(v1.0)" [PRIMARY-VERIFIED]
R02 VER-UNRECORDED | evidence.version absent | -> I | no | STARD-AI 13 requires "software (with version number)"; TRIPOD+AI has no such item, so a TRIPOD-only paper will often fire this; K250694 enclosure drops the version [PRIMARY-VERIFIED]
R03 VER-PCCP-POSTDATES | claim.version newer than evidence version AND device.pccp.present AND change class in authorized classes | -> R | YES | Whether a change was "implemented in accordance with the Modification Protocol" is not knowable from public documents; FDA itself advises "discussion with the appropriate FDA review division". PCCP V.D [PRIMARY-VERIFIED]
R04 VER-PCCP-PERF | evidence date < change date, claim.version post-change, no post-change performance summary | performance atoms -> I | no | PCCP V.C: labeling should carry "a summary of current device performance... relevant data (training, tuning, and test data)" for implemented modifications; absence = no evidence for new version [PRIMARY-VERIFIED]
R05 VER-LOCAL-ADAPT | device.adaptation_mode in {local_site_specific, mixed} and evidence is pooled/global | -> R | YES | PCCP VI.B distinguishes global vs "heterogenous or local changes"; performance of a locally adapted model at the claimed site is not given by global testing [PRIMARY-VERIFIED]
R06 LLM-DRIFT | model_basis=llm AND (base_model or prompt_version differ or unknown) | -> I | no | HAIP D5: "LLM: Detail prompt and response changes resulting from model updates, including the impact" [PRIMARY-VERIFIED]
R07 INPUT-SOURCE | claim.integration scanner/EHR/hardware not in evidence.capture_devices | listed alternatives tested -> N; capture devices unreported -> I; claimed input matches an IFU/evidence technical exclusion (e.g. slices >0.625 mm) -> C | no | STARD-AI 13-14; DEN170073 I.a exclusions; PCCP VI.C treats new acquisition makes/models as a modification type; FDA transparency: "device input will not align with the data used to develop and validate" [PRIMARY-VERIFIED]

Population
R08 POP-SUBSET | claim.population (age, sex, condition) vs evidence.inclusion | claimed region partly outside studied inclusion, overlap non-empty -> N | no | PROBAST+AI E&E: children-only vs adults+children example; STARD-AI 7; PCCP IV.B representativeness [PRIMARY-VERIFIED]
R09 POP-DISJOINT | claimed slice entirely excluded from study | -> I (not C: a study exclusion shows absence of evidence, not contrary evidence) | no | STARD-AI 7; PROBAST+AI 1.3 [PRIMARY-VERIFIED]
R10 POP-LABEL-EXCLUDED | claimed slice contradicts authorization IFU/limitation text (e.g. claim age 18+, IFU "not... under 22 years of age") | -> C | no | K250694 IFU; DEN170073 F.3; 814.20(b)(3)(i). Only fires on explicit negation or numeric age bound, never on silence [PRIMARY-VERIFIED]
R11 POP-UNDESCRIBED | evidence reports no demographic/case-mix table | population atoms -> I | no | STARD-AI 25; TRIPOD 20b; PROBAST+AI uses "no information" only "when reported information is insufficient" [PRIMARY-VERIFIED]
R12 SUBGROUP-MISSING | claim.required_subgroups[s] and no results[] with subgroup=s | atom(s) -> I; remaining atoms evaluated normally -> N overall | no | TRIPOD 23a "including for any key subgroups"; STARD-AI 21; GMLP #9 "performance of the model for appropriate subgroups"; K250694 reports age mix but no age-stratified sensitivity [PRIMARY-VERIFIED]
R13 SUBGROUP-IMPRECISE | subgroup result exists but n or CI width above user policy | -> R | YES | PROBAST+AI glossary "Imprecision... wide confidence intervals"; no standard sets the sample-size threshold [PRIMARY-VERIFIED]
R14 PREVALENCE-TRANSPORT | metric in {PPV, NPV, alert_rate, NNT} AND (sampling=enriched OR prevalence unreported) | -> I; both prevalences known but differ by more than policy -> R | partly YES | STARD-AI 28 and 26a/b; DEN170073 test set "approximately equal numbers of positive and negative cases" [PRIMARY-VERIFIED]

Setting and place
R15 SETTING-NOT-STUDIED | claim.care_setting/level_of_care not in evidence.care_settings | -> N if other settings studied, I if setting unreported | no | TRIPOD 6a; HAIP D1 Implementation Context; PROBAST+AI PICOTS: "The prediction ability of models may change across healthcare settings" [PRIMARY-VERIFIED]
R16 SITE-COUNT | evidence.sites_n=1 AND claim spans multiple sites | -> N (single-site only); adequacy of N sites -> R | YES (adequacy) | TRIPOD 6a "number and location of centres", 12d heterogeneity across clusters; GMLP N88 #4 "extent of external validation is proportionate to risk" [PRIMARY-VERIFIED]
R17 GEOGRAPHY | claim.countries not subset of evidence.countries | -> N; transportability across health systems -> R | YES | GMLP N88 #3 "geographical location"; K250694 US-only sites; no standard defines when transport is acceptable [PRIMARY-VERIFIED]
R18 USER-ROLE | claim.user_roles not subset of IFU/evidence users | -> N; claim OTC/patient use where IFU "For prescription use only" -> C | no | STARD-AI 15d; TRIPOD 27b; DEN170073 F.1-F.2 [PRIMARY-VERIFIED]

Timing
R19 DATES-MISSING | evidence.accrual_start/end absent | -> I | no | TRIPOD 5b; STARD-AI 9. K250694 gives none [PRIMARY-VERIFIED]
R20 STALENESS | deployment_date - accrual_end > policy window, or known practice/protocol change in between | -> R | YES | No standard sets a window. GMLP #10 names "dataset drift" as a risk; window must be a user-configured policy, default none [PRIMARY-VERIFIED for concept; threshold NOT VERIFIED]
R21 PREDATES-AUTH | claim_date < authorization.decision_date (e.g. "FDA cleared" asserted before the letter date) | -> C | no | K250694 letter date 2025-11-25 vs received 2025-10-28 shows distinct dates [PRIMARY-VERIFIED for dates; logic DESIGN]
R22 T0-AVAILABILITY | evidence-declared earliest availability of an input > claim.t0_stage on the ordered pathway | -> C; stage not mappable -> R | partly YES | PROBAST+AI 2.4 "available at the time the model was intended to be used"; PICOTS-T "start point or T0" [PRIMARY-VERIFIED]
R23 HORIZON | claim.horizon vs evaluated horizon | equal -> pass; claimed set larger but includes evaluated -> N; otherwise -> I | no | PROBAST+AI D3 ("short- or long-term prognosis"), 3.4; TRIPOD 8a [PRIMARY-VERIFIED]

Purpose and role
R24 PURPOSE-EXPLICIT-LIMIT | claim.purpose_class > authorized/evidenced class AND label contains explicit negation ("not for diagnostic use beyond notification") | -> C | no | DEN170073 F.1/F.3; K250694 "not intended to be used as a diagnostic device"; IMDRF s6.1 ordinal classes [PRIMARY-VERIFIED]
R25 PURPOSE-ESCALATION | claim.purpose_class > evidenced class, no explicit negation | -> N (evidenced class only) | no | IMDRF s7 "Modify your intended use to one that can be supported by available evidence" [PRIMARY-VERIFIED]
R26 ROLE-STANDALONE-VS-TEAM | claim.role in {human_ai_team, autonomous} but evidence.role_evaluated=standalone (or reverse) | -> I | no | GMLP #7 "performance of the Human-AI team, rather than just the performance of the model in isolation"; IMDRF clinical validation "Users can achieve clinically meaningful outcomes" [PRIMARY-VERIFIED]
R27 CLAIM-LEVEL | claim_level > evidence_level (e.g. outcome/time-saving claim, accuracy-only evidence) | -> N (supports the lower level only); no evidence at the lower level either -> I | no | IMDRF s5.3-5.4 distinguishes analytical vs clinical validation and "patient-relevant clinical outcome(s)"; DEN170073 time-to-notification is a surrogate, not outcome [PRIMARY-VERIFIED]
R28 AUTH-NOT-EVIDENCE | claim cites clearance/authorization as proof of performance or benefit AND (clinical_tests=not_conducted OR no performance data) | -> N (supports "legally marketed for the stated IFU" only) | no | K250694 "Clinical tests were not conducted"; 807.92(b) SE is relative to predicate; letter caveat [PRIMARY-VERIFIED]
R29 REG-STATUS-ASSERTION | vendor asserts not-a-device/exempt | -> R | YES | HAIP D2 Regulatory Status: HDO "should validate this through due diligence" [PRIMARY-VERIFIED]

Outcome, metric, comparator
R30 OUTCOME-DEF | claim.outcome vs evidence.outcome (normalized code, composite_components) | identical -> pass; claimed is a component of a composite, or definition/assessment method differs, no mapping -> R | YES | PROBAST+AI D3 applicability (composite components; PHQ-9 vs CIDI example) [PRIMARY-VERIFIED]
R31 REFERENCE-STANDARD | claim reference standard != evidence reference standard | -> R | YES | STARD-AI 16a-b; GMLP #5 (N88: "Selected reference standards are fit-for-purpose") [PRIMARY-VERIFIED for concept]
R32 METRIC-ABSENT | claim.metric not in evidence.results[] | -> I; risk-probability use with no calibration reported -> I | no | PROBAST+AI 4.7 "calibration, discrimination, and net benefit"; TRIPOD 12e; DEN170073 reports AUC separately from sens/spec [PRIMARY-VERIFIED]
R33 OPERATING-POINT | claim.operating_point != result.threshold, or result.threshold unreported | -> I for that metric; threshold flagged exploratory -> R | partly YES | STARD-AI 15c "distinguishing prespecified from exploratory"; TRIPOD 15; K250694 states no threshold [PRIMARY-VERIFIED]
R34 CLAIMED-VALUE-VS-CI | claim.minimum_value vs result CI | minimum > ci_hi -> C; ci_lo < minimum <= ci_hi -> I; minimum <= ci_lo -> pass | no | STARD-AI 31 "precision (such as 95% confidence intervals)". e.g. K250694 sens 0.867 (0.811-0.908) vs claim 0.90 -> I; vs 0.95 -> C. CI method and multiplicity are NOT stated; contestable [PRIMARY-VERIFIED for inputs; logic DESIGN]
R35 COMPARATOR | claim has comparative language (better than clinician/SoC/predicate) | evidence comparator none -> I; comparator on a subset -> N (subset); SE-only evidence -> I for superiority | no | PROBAST+AI PICOTS-C; DEN170073 comparator n=85 of 300; K250694 "as safe and effective as" predicate [PRIMARY-VERIFIED]

Evidence quality and provenance
R36 EVAL-TYPE | claim generalises beyond development site AND evaluation_type in {apparent, internal} | -> I | no | PROBAST+AI 4.1 "only apparent performance avoided"; Box 1 definitions; GMLP N88 #4 [PRIMARY-VERIFIED]
R37 LEAKAGE | independence unreported -> I; partial dependence disclosed (shared patients/sites) -> R | partly YES | PROBAST+AI 4.5 "data leakage was avoided"; GMLP #4 sources of dependence "patient, data acquisition, and site"; PCCP VII.B(1) sequestration [PRIMARY-VERIFIED]
R38 NON-INDEPENDENT-HIGH-RISK | provenance.independent_of_vendor in {no, unknown} AND (purpose=diagnose_or_treat AND situation in {serious, critical}) OR (purpose=drive AND situation=critical) | -> R; lower-risk categories -> note only | YES | IMDRF s8 independent review "more important" for exactly those categories; HAIP D1 maturity needs validation "beyond the development context"; STARD-AI 39 [PRIMARY-VERIFIED]
Also: pure vendor_claim or whitepaper with no design, n, dates or CI -> I (STARD-AI items 5, 9, 31 all absent) [DESIGN].

Human-judgment rules (always R): R03, R05, R13, R14 (prevalence gap), R16 (adequacy), R17, R20, R22 (unmappable), R29, R30, R31, R33 (exploratory), R37 (partial), R38. Everything else is set arithmetic, string/enum comparison, date comparison or interval arithmetic.

## 8. What the standards say a tool must NOT conclude automatically  [PRIMARY-VERIFIED]

1. Safety or effectiveness. PROBAST+AI rates concern, never safety; K250694 letter: SE "does not mean that FDA has made a determination that your device complies with other requirements". Output wording must never be "safe", "approved for you", "validated".
2. A final applicability rating from item answers. "assessors need to use their judgment"; one "no" "does not automatically result in a high concern". Tool outputs flags plus evidence, not the PROBAST+AI judgement, unless a human supplies it.
3. That lower performance in a new setting contradicts the original study. "External validation studies do not have the purpose to compare or find similar performance as found in the development study."
4. That a study's inclusion/exclusion criteria are the label's limits (R09 vs R10), or that silence in the IFU is a prohibition.
5. That a different version is covered or not covered by a PCCP (FDA: discuss with review division); that a new version is "the same device". No standard defines version equivalence.
6. That evidence extrapolates to a different intended use. IMDRF allows it only "where extrapolation of such data can be justified": a human justification.
7. Local performance. HAIP: local validation is the HDO's job; FDA transparency principles list "plans for ongoing performance monitoring". Static documents cannot show drift (GMLP #10).
8. That missing reporting means poor quality, or complete reporting means good quality. TRIPOD+AI: "not a quality appraisal tool"; STARD-AI targets "completeness and transparency".
9. Fairness. No subgroup result means "no information", not "fair" or "unfair" (PROBAST+AI embeds fairness; STARD-AI 23).
10. That the tool is an independent reviewer (IMDRF s8 independence requires someone without "anything to gain").
11. That real-world post-market data are enough to change scope: IMDRF s9 "may not be sufficient".
12. Regulatory status of an unauthorized product: HAIP says the HDO must verify exemption claims.

## 9. Open items, conflicts and NOT VERIFIED

- Prompt said "FDA/Health Canada/MHRA GMLP": the 2021 trilateral doc was read; the 2025 IMDRF N88 version (adopted by FDA page) differs in wording (adds #4 risk-proportionate external validation, "intended use/ intended purpose") [PRIMARY-VERIFIED].
- PROBAST+AI main text and Suppl T3 word the D1 evaluation item differently ("participants" vs "participants and setting"); Table 2 shows the shorter form [PRIMARY-VERIFIED]. Suppl T4 domain 4 detail not read [NOT VERIFIED].
- IMDRF s6.1 cites SaMD N12 for the purpose/situation matrix; N12 itself not read, so the ordinal inform < drive < treat/diagnose is the N41 listing order, not a stated ranking [NOT VERIFIED as an ordering].
- No PCCP-bearing public summary was fetched; how PCCP appears in real 510(k)/De Novo summaries is documented only via the guidance (V.C bullets) [NOT VERIFIED in practice].
- DEN170073 and K250694 are one De Novo and one 510(k): a sample of two cannot establish the field stability of other divisions/years [NOT VERIFIED beyond the two].
- Deterministic thresholds (staleness window, subgroup n, prevalence gap, CI-vs-claim rule R34, aggregation order) have no source standard; each needs clinician sign-off before the compiler claims them.
- Clinician-contested candidates: R25 (narrower-by-purpose), R34 (CI rule), R01 (disjoint version = I, not N).
