# Same-input test: answer key (Gate 0, G2)

All 26 claims are **CONSTRUCTED**: written for this test in the style of a vendor claim. None is a statement by any vendor and none says anything about any vendor. Every device, identifier, version, population, setting, endpoint and number they rely on is a real record from `research/feasibility/fixtures` or `evals/gate0/raw`, anchored below with a verbatim quote, a printed page where the source is a PDF, and the record's sha256. Machine-readable twin: `claims.jsonl` (claim and evidence shapes validate against `src/schemas/scope.ts`; `evidence-sets.json` holds the evidence items).

Label: **single builder, two passes, not independent.** The claims, the scopes and the pass-1 key were written by one agent; pass 2 is a mechanical oracle (`tools/build-claims.mjs`) over the same structured scopes, which checks the key's internal consistency, not its truth. No clinician or second human has read the key (docs/05 G6 open).

## Coverage of the requested mismatch kinds

| kind | claims |
|---|---|
| narrower indication | EA-05 (v2.2.0 indication excludes prior DR), LU-03 (target findings) |
| different software version | TR-02, VZ-02, PG-01, HF-01, LU-02 |
| different age range | EA-02, GI-01, CP-01 |
| different setting | ID-02 |
| superseded submission | EA-03 (K223357 follows K200667) |
| shared device name across K-numbers | BC-02 (35 AI-list rows are named BriefCase) |
| missing study | MS-01 (registry protocol, no results), HF-01 |
| version mismatch, Transpara 1.7.2 vs 1.7.0 | TR-02 |
| intended-use mismatch, Lunit triage vs TB screening | LU-02 |
| De Novo with many GUDID versions, Viz LVO | VZ-02 (11 GUDID versions under DEN170073) |
| intended-use mismatch, other | EA-04, MS-02 |
| exclusion criterion | AN-02 |
| clean positive controls | EA-01, TR-01, LU-01, VZ-01, BC-01, PG-02, GI-02, AN-01, ID-01 (9 claims, 35%) |

## Label distribution

| label | claims |
|---|---|
| SUPPORTED_FOR_SCOPE | 9 |
| SUPPORTED_ONLY_FOR_NARROWER_SCOPE | 7 |
| REQUIRES_DOMAIN_REVIEW | 1 |
| INSUFFICIENT_EVIDENCE | 8 |
| CONTRADICTED_BY_SPECIFIED_EVIDENCE | 1 |

Contestable keys: 12 of 26. For a contestable key, `acceptableLabels` lists the other labels that withhold support; scoring reports the exact label and the acceptable-or-exact label separately (PROTOCOL.md). SUPPORTED_FOR_SCOPE or SUPPORTED_ONLY_FOR_NARROWER_SCOPE on any claim whose key is lower is a false-supported error, never acceptable.

## Semantics the key assumes (the lead's compiler must match or the key is not applicable)

1. A dimension is in play only if the claim specifies it. A claim silent on a dimension makes no assertion on it. If the compiler instead treats a claim-unspecified dimension as UNKNOWN, no positive control can ever be SUPPORTED_FOR_SCOPE.
2. Evidence silent on a dimension the claim specifies is UNKNOWN, which yields INSUFFICIENT_EVIDENCE (docs/02 s10).
3. Evidence exclusions the claim does not also exclude widen the claimed population (PARTIAL). That is why positive controls list the evidence's exclusions.
4. A different release string is DISJOINT unless a source states equivalence; GUDID labels establish marketed releases, not studied ones.
5. Evidence about another version is not used for the other dimensions of a claim that names a version.
6. A claim that specifies a date against older evidence needs a reviewer (no source threshold): REQUIRES_DOMAIN_REVIEW.
7. Setting, purpose and condition strings are the key's own vocabulary; the lead maps them. Country is not a scored dimension (GI-02 is an Italian study).

## Pass 2 (oracle) result

Oracle agrees with the pass-1 key on 25 of 26 claims. Disagreements:

- **MS-02**: key CONTRADICTED_BY_SPECIFIED_EVIDENCE, oracle INSUFFICIENT_EVIDENCE. The oracle cannot emit CONTRADICTED_BY_SPECIFIED_EVIDENCE (it has no rule for a text that negates a use); the key's acceptable labels include the oracle's label. Resolution: kept as a contestable key.

### Key defects found and fixed while doing pass 2

These were errors in the first draft of the key, found when the oracle or a re-read disagreed. They are listed because they show the key is fallible and because the same defects could recur in other keys.

- **ID-02** was first written with a claim limited to eye-care clinics. A narrower scope must lie inside the claimed scope, so no narrower scope existed and the key was wrong. The claim now covers primary care and eye care.
- **PG-01** first listed FDA's own reader study as evidence next to the published Alpha-build paper; with it the claim is simply supported. The evidence set is now the cited paper only, and the note says that a system answering from FDA's study answers a different question.
- **Invented values** in three evidence items (a clearance date for Transpara, a 'pathology lab' setting for Paige, a 2014 date for the NXT trial) were not in any anchored quote. They were removed; nothing in the key rests on a value without an anchor.
- `EA-02` was written with age 12 from the start on purpose: the FDA indication says 'adults', which leaves 18 to 21 ambiguous, so the key avoids that edge. The 18-to-21 ambiguity is recorded as discrepancy D4 in EYEART-CHAIN.md and is not scored.

### Changes made after seeing a system output (disclosed because they could bias the key toward that system)

On 2026-10-27, after the key and the evidence items were written, a throwaway dry run fed the key's claims and evidence items to the in-progress `src/compiler` (unmapped vocabulary, `requiredDimensions` set to the dimensions each claim specifies). It is not the Sakaime arm and is not scored. It changed the key in two ways, and it was kept to these two:

1. **Evidence typing.** The first encoding put analysis-population facts (age floor 22, pacing exclusion, 40-80 study ages) inside `authorization` items although the FDA indications say only 'adults' or name no age. That was a modelling error of mine, found because the compiler read the age as an explicit authorization limit. The items are now split into an `authorization` item (what the indication says) and a `study` item (what the pivotal or validation study covered) for EA (K200667, K223357), GI-Genius, Anumana and IDx-DR. No label was changed. On the corrected encoding the compiler dry run returned INSUFFICIENT_EVIDENCE for 10 claims whose key differs (EA-01, EA-02, EA-03, EA-05, GI-01, GI-02, AN-01, AN-02, ID-01, ID-02), including the positive controls EA-01, GI-02, AN-01 and ID-01; I kept the faithful encoding rather than reshape it to please the compiler, and that divergence is a finding for the lead, not a key edit (see PROTOCOL.md section 7).
2. **CP-01** acceptable set widened to include CONTRADICTED_BY_SPECIFIED_EVIDENCE, because an explicit 'adult patients' limit can reasonably be read as contradicting a claim for children. Both labels withhold support; the exact label stays SUPPORTED_ONLY_FOR_NARROWER_SCOPE.

## The key, claim by claim

### EA-01: EyeArt K200667 (positive control)

**CONSTRUCTED claim.** At our primary-care and eye-clinic sites we screen adults aged 22 and older with diabetes, with no previous diagnosis of more than mild diabetic retinopathy, using EyeArt v2.1.0. FDA reviewed a prospective pivotal study of this use and cleared it in August 2020.

Claimed use: product `device:fda:K200667`, version 2.1.0, population {"age":{"min":22},"conditions":["diabetes mellitus"],"exclusions":["previously diagnosed with more than mild diabetic retinopathy"]}, setting ["primary_care","eye_care"], purpose `dr_screening_detection`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

Every stated dimension equals the FDA indication and the pivotal analysis population. Numbers in the text: 22 years, 'more than mild', August 2020 (decision 2020-08-03).

Evidence for the key:

- `ea.ifu` (fixtures/fda/K200667_summary_text.txt, printed page 1 of 21, sha256 d8b8d5d8e438): "EyeArt is indicated for use by healthcare providers to automatically detect more than mild diabetic retinopathy and vision-threatening diabetic retinopathy [...] in eyes of adults diagnosed with diabetes who have not been previously diagnosed with more than m..."
- `ea.version` (fixtures/fda/K200667_summary_text.txt, printed page 3 of 21, sha256 d8b8d5d8e438): "EyeArt (software version v2.1.0) was identified as having a major level of concern"
- `ea.age22` (fixtures/fda/K200667_summary_text.txt, printed page 4 of 21, sha256 d8b8d5d8e438): "The target population of the EyeArt pivotal clinical trial analysis was asymptomatic persons aged 22 years and older who were diagnosed with diabetes and not diagnosed with more than mild diabetic retinopathy."

### EA-02: EyeArt K200667 (narrower population (age range))

**CONSTRUCTED claim.** EyeArt v2.1.0 can be used to screen patients with diabetes from age 12 upward in our primary-care clinics, based on the FDA-reviewed pivotal study.

Claimed use: product `device:fda:K200667`, version 2.1.0, population {"age":{"min":12},"conditions":["diabetes mellitus"],"exclusions":["previously diagnosed with more than mild diabetic retinopathy"]}, setting ["primary_care"], purpose `dr_screening_detection`, date unspecified.

**Expected: SUPPORTED_ONLY_FOR_NARROWER_SCOPE**. Key confidence: clear. Mismatch dimension(s): population. Supported narrower scope: adults aged 22 and older (FDA analysis population); the published study enrolled from 18.

Minimal counterexample: claimed age 12 and over, established 22 and over (FDA) / 18 and over (JAMA Netw Open).

Evidence for the key:

- `ea.ifu` (fixtures/fda/K200667_summary_text.txt, printed page 1 of 21, sha256 d8b8d5d8e438): "EyeArt is indicated for use by healthcare providers to automatically detect more than mild diabetic retinopathy and vision-threatening diabetic retinopathy [...] in eyes of adults diagnosed with diabetes who have not been previously diagnosed with more than m..."
- `ea.age22` (fixtures/fda/K200667_summary_text.txt, printed page 4 of 21, sha256 d8b8d5d8e438): "The target population of the EyeArt pivotal clinical trial analysis was asymptomatic persons aged 22 years and older who were diagnosed with diabetes and not diagnosed with more than mild diabetic retinopathy."
- `ea.jama.age` (fixtures/pubmed/ef_eyeart.xml, sha256 6cf769a3ca8c): "A total of 942 individuals aged 18 years or older who had diabetes gave consent to participate at 15 primary care and eye care facilities."

### EA-03: EyeArt K200667 (superseded submission / date)

**CONSTRUCTED claim.** From 1 November 2026 our screening program will run EyeArt v2.1.0 as cleared under K200667; the evidence behind it is current.

Claimed use: product `device:fda:K200667`, version 2.1.0, population {"age":{"min":22},"conditions":["diabetes mellitus"],"exclusions":["previously diagnosed with more than mild diabetic retinopathy"]}, setting ["primary_care","eye_care"], purpose `dr_screening_detection`, date 2026-11-01.

**Expected: REQUIRES_DOMAIN_REVIEW**. Key confidence: contestable. Mismatch dimension(s): timing.

Evidence is from 2017-2020; a later clearance (K223357, v2.2.0, 2023-06-16) changes the software version and narrows the indication wording to 'not been previously diagnosed with diabetic retinopathy'. No source states a staleness window, so the rule table returns domain review; a system that returns SUPPORTED_FOR_SCOPE here has ignored the successor clearance.

Evidence for the key:

- `ea.k2.update` (evals/gate0/raw/fda/K223357_summary_text.txt, printed page 3 of 10, sha256 76adc2d64177): "The purpose of this 510(k) notification is to modify EyeArt (software version 2.1.0) and update it to"
- `ea.k2.ifu` (evals/gate0/raw/fda/K223357_summary_text.txt, printed page 1 of 1, sha256 76adc2d64177): "who have not been previously diagnosed with diabetic retinopathy. EyeArt is indicated for use with Canon CR-2 AF, Canon CR-2 Plus AF, and Topcon NW400 cameras."

### EA-04: EyeArt K200667 (intended-use mismatch)

**CONSTRUCTED claim.** We use EyeArt v2.1.0 to monitor disease progression in patients already treated for diabetic retinopathy at our retina clinic.

Claimed use: product `device:fda:K200667`, version 2.1.0, population {"conditions":["diabetes mellitus","previously diagnosed diabetic retinopathy under treatment"]}, setting ["eye_care"], purpose `dr_progression_monitoring`, date unspecified.

**Expected: INSUFFICIENT_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW, CONTRADICTED_BY_SPECIFIED_EVIDENCE). Key confidence: contestable. Mismatch dimension(s): purpose.

Cleared use is detection in patients not previously diagnosed with more than mild DR; the pivotal study excluded prior macular edema, retinal laser and injections. No source reports monitoring performance.

Evidence for the key:

- `ea.ifu` (fixtures/fda/K200667_summary_text.txt, printed page 1 of 21, sha256 d8b8d5d8e438): "EyeArt is indicated for use by healthcare providers to automatically detect more than mild diabetic retinopathy and vision-threatening diabetic retinopathy [...] in eyes of adults diagnosed with diabetes who have not been previously diagnosed with more than m..."
- `ea.ct.excl` (fixtures/ctgov/study_NCT03112005.json, sha256 f7fad8837f85): "History of macular edema or retinal vascular (vein or artery) occlusion;"

### EA-05: EyeArt v2.2.0 K223357 (narrower indication (successor clearance))

**CONSTRUCTED claim.** EyeArt v2.2.0 with the Topcon NW400 can screen adults with diabetes in our clinics, including those with a prior diagnosis of mild diabetic retinopathy, as in the original EyeArt clearance.

Claimed use: product `device:fda:K223357`, version 2.2.0, population {"age":{"min":22},"conditions":["diabetes mellitus","prior mild diabetic retinopathy"]}, setting null, purpose `dr_screening_detection`, date unspecified.

**Expected: SUPPORTED_ONLY_FOR_NARROWER_SCOPE**. Key confidence: clear. Mismatch dimension(s): population. Supported narrower scope: adults aged 22 and older with diabetes and no previous diagnosis of diabetic retinopathy.

The v2.1.0 indication allowed prior mild DR ('more than mild'); the v2.2.0 indication says 'not been previously diagnosed with diabetic retinopathy'. Evidence universe is restricted to K223357 because the claim names v2.2.0.

Evidence for the key:

- `ea.k2.ifu` (evals/gate0/raw/fda/K223357_summary_text.txt, printed page 1 of 1, sha256 76adc2d64177): "who have not been previously diagnosed with diabetic retinopathy. EyeArt is indicated for use with Canon CR-2 AF, Canon CR-2 Plus AF, and Topcon NW400 cameras."
- `ea.ifu` (fixtures/fda/K200667_summary_text.txt, printed page 1 of 21, sha256 d8b8d5d8e438): "EyeArt is indicated for use by healthcare providers to automatically detect more than mild diabetic retinopathy and vision-threatening diabetic retinopathy [...] in eyes of adults diagnosed with diabetes who have not been previously diagnosed with more than m..."

### TR-01: Transpara K221347 (positive control)

**CONSTRUCTED claim.** Transpara 1.7.2 is our concurrent reading aid for physicians interpreting screening mammography and tomosynthesis exams in the hospital. In the FDA-reviewed standalone test, sensitivity was 95.0% on 2D and 93.2% on DBT.

Claimed use: product `device:fda:K221347`, version 1.7.2, population {"conditions":["women undergoing screening mammography"]}, setting ["hospital"], purpose `concurrent_reading_aid`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

Numbers in the text equal the FDA summary standalone results.

Evidence for the key:

- `tr.ifu` (fixtures/fda/K221347_summary_text.txt, printed page 1 of 1, sha256 65d7939a6b54): "software is intended for use as a concurrent reading aid for physicians interpreting screening full-field digital mammography exams and digital breast tomosynthesis exams"
- `tr.pop` (fixtures/fda/K221347_summary_text.txt, sha256 65d7939a6b54): "The device is intended to be used in the population of women undergoing screening mammography and digital breast tomosynthesis."
- `tr.version` (fixtures/fda/K221347_summary_text.txt, sha256 65d7939a6b54): "Based on standalone testing it was concluded that Transpara 1.7.2 breast cancer"
- `tr.perf` (fixtures/fda/K221347_summary_text.txt, sha256 65d7939a6b54): "For 2D, the sensitivity is 95.0% (93.5-96.4) at 0.30 FP/image. For DBT, sensitivity is 93.2% (91.0-95.1) at 0.34 FP/volume."

### TR-02: Transpara K221347 (version mismatch (1.7.2 vs 1.7.0))

**CONSTRUCTED claim.** Transpara 1.7.2 reduced screen-reading workload by 44.3% while keeping cancer detection in the MASAI randomised trial of 80,033 women.

Claimed use: product `device:fda:K221347`, version 1.7.2, population {"conditions":["women undergoing screening mammography"]}, setting ["screening_program"], purpose `ai_supported_reading_triage`, date unspecified.

**Expected: INSUFFICIENT_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW). Key confidence: contestable. Mismatch dimension(s): version, purpose.

The trial used Transpara 1.7.0 and used the score to route exams to single or double reading; FDA reviewed 1.7.2 as a concurrent reading aid with standalone data only. Planted mismatch is the version; the purpose difference is real and recorded as a second dimension.

Evidence for the key:

- `tr.masai.version` (fixtures/pubmed/ef_transpara.xml, sha256 7d7dc46d6bfb): "The AI system (Transpara version 1.7.0) provided an examination-based malignancy risk score on a 10-level scale that was used to triage screening examinations to single reading (score 1-9) or double reading (score 10)"
- `tr.version` (fixtures/fda/K221347_summary_text.txt, sha256 65d7939a6b54): "Based on standalone testing it was concluded that Transpara 1.7.2 breast cancer"
- `tr.ifu` (fixtures/fda/K221347_summary_text.txt, printed page 1 of 1, sha256 65d7939a6b54): "software is intended for use as a concurrent reading aid for physicians interpreting screening full-field digital mammography exams and digital breast tomosynthesis exams"

### LU-01: Lunit INSIGHT CXR Triage K211733 (positive control)

**CONSTRUCTED claim.** Lunit INSIGHT CXR Triage v1.0 flags adult chest X-rays with suspected pleural effusion or pneumothorax for worklist prioritisation. In FDA's review, pleural-effusion sensitivity was 94.29%.

Claimed use: product `device:fda:K211733`, version 1.0, population {"conditions":["pleural effusion","pneumothorax"]}, setting null, purpose `triage_notification`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

Version 1.0 comes from GUDID (the FDA summary text itself names no version): record as identity-by-GUDID.

Evidence for the key:

- `lu.ifu` (fixtures/fda/K211733_summary_text.txt, printed page 3 of 10, sha256 8978191cdbcd): "software that analyzes adult chest X-ray images for the presence of pre-specified suspected critical findings (pleural effusion and/or pneumothorax)"
- `lu.gudid` (fixtures/openfda/udi_K211733.json, sha256 9e2f4f4e5f01): ""version_or_model_number":"1.0""
- `lu.sens` (fixtures/fda/K211733_summary_text.txt, printed page 4 of 10, sha256 8978191cdbcd): "94.29% sensitivity and 95.72% specificity for pleural effusion"

### LU-02: Lunit INSIGHT CXR Triage K211733 (intended-use mismatch (triage vs TB screening))

**CONSTRUCTED claim.** Lunit INSIGHT CXR is FDA-cleared to screen for tuberculosis in adults, with the newest release (3.9.0.1) reaching an AUC of 0.78 in a community screening programme.

Claimed use: product `device:fda:K211733`, version 3.9.0.1, population {"conditions":["tuberculosis"]}, setting null, purpose `tb_screening`, date unspecified.

**Expected: INSUFFICIENT_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW, CONTRADICTED_BY_SPECIFIED_EVIDENCE). Key confidence: contestable. Mismatch dimension(s): purpose, version, population.

K211733 is cleared for pleural effusion and pneumothorax triage. The tuberculosis studies use the same brand at releases 3.1.0.0 and 3.9.0.1 (PMID 40233023); that paper is a candidate link at WEAK-NAME-ONLY level and is not evidence about K211733. The AUC value (0.78) is quoted in the paper's abstract.

Evidence for the key:

- `lu.ifu` (fixtures/fda/K211733_summary_text.txt, printed page 3 of 10, sha256 8978191cdbcd): "software that analyzes adult chest X-ray images for the presence of pre-specified suspected critical findings (pleural effusion and/or pneumothorax)"
- `lu.gudid` (fixtures/openfda/udi_K211733.json, sha256 9e2f4f4e5f01): ""version_or_model_number":"1.0""
- `lu.tb.versions` (fixtures/pubmed/ef_lunitcxr.xml, sha256 91e4cb8e0122): "The performance of Lunit CAD software versions 3.1.0.0 and 3.9.0.1 (newer version) were compared by measuring the area under the receiver operating characteristic curve (AUC)"
- `lu.tb.auc` (fixtures/pubmed/ef_lunitcxr.xml, sha256 91e4cb8e0122): "The newer software version had a significantly higher AUC than its predecessor (AUC 0.76 vs 0.78, p = 0.029)"

### LU-03: Lunit INSIGHT CXR Triage K211733 (narrower population (target findings))

**CONSTRUCTED claim.** Lunit INSIGHT CXR Triage v1.0 flags adult chest X-rays with pleural effusion, pneumothorax or pulmonary nodules for worklist prioritisation.

Claimed use: product `device:fda:K211733`, version 1.0, population {"conditions":["pleural effusion","pneumothorax","pulmonary nodule"]}, setting null, purpose `triage_notification`, date unspecified.

**Expected: SUPPORTED_ONLY_FOR_NARROWER_SCOPE**. Key confidence: clear. Mismatch dimension(s): population. Supported narrower scope: pleural effusion and pneumothorax only.

Nodules are not among the pre-specified critical findings.

Evidence for the key:

- `lu.ifu` (fixtures/fda/K211733_summary_text.txt, printed page 3 of 10, sha256 8978191cdbcd): "software that analyzes adult chest X-ray images for the presence of pre-specified suspected critical findings (pleural effusion and/or pneumothorax)"

### VZ-01: Viz LVO DEN170073 (positive control)

**CONSTRUCTED claim.** Viz LVO (version 1.0) notifies a neurovascular specialist of suspected large vessel occlusion on head and neck CT angiograms acquired in the acute setting, for patients 40 and older. FDA's standalone study of 300 CTAs reported 87.8% sensitivity.

Claimed use: product `device:fda:DEN170073`, version 1.0, population {"age":{"min":40},"conditions":["suspected large vessel occlusion"]}, setting ["hospital"], purpose `triage_notification`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

Age 40 and over lies inside 'older than 22 years'.

Evidence for the key:

- `vz.ifu` (fixtures/fda/DEN170073_summary_text.txt, sha256 78ebb295a618): "the device analyzes CT angiogram images of the brain acquired in the acute setting, and sends notifications to a neurovascular specialist that a suspected large vessel occlusion has been identified"
- `vz.age` (fixtures/fda/DEN170073_summary_text.txt, sha256 78ebb295a618): "ContaCT is indicated for patients older than 22 years of age."
- `vz.version` (fixtures/fda/DEN170073_summary_text.txt, sha256 78ebb295a618): "This is the initial version 1.0 for the device. The standalone testing study was completed with this version of the device."
- `vz.perf` (fixtures/fda/DEN170073_summary_text.txt, sha256 78ebb295a618): "sensitivity and specificity are 87.8% (81.2% - 92.5%) and 89.6% (83.7% - 93.9%), respectively."

### VZ-02: Viz LVO DEN170073 (De Novo with many GUDID versions)

**CONSTRUCTED claim.** Viz LVO 1.11, the release we run, is covered by the FDA De Novo study showing 87.8% sensitivity for suspected large vessel occlusion.

Claimed use: product `device:fda:DEN170073`, version 1.11, population {"age":{"min":40},"conditions":["suspected large vessel occlusion"]}, setting ["hospital"], purpose `triage_notification`, date unspecified.

**Expected: INSUFFICIENT_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW). Key confidence: contestable. Mismatch dimension(s): version.

The De Novo summary says the standalone study used the initial version 1.0; GUDID lists eleven versions (1.1 to 1.11) under the same De Novo number, so release 1.11 is marketed under DEN170073 but no source says the study covers it.

Evidence for the key:

- `vz.version` (fixtures/fda/DEN170073_summary_text.txt, sha256 78ebb295a618): "This is the initial version 1.0 for the device. The standalone testing study was completed with this version of the device."
- `vz.gudid111` (fixtures/openfda/udi_DEN170073.json, sha256 a2652e072d58): ""version_or_model_number":"1.11""
- `vz.gudid11` (fixtures/openfda/udi_DEN170073.json, sha256 a2652e072d58): ""total":11"

### BC-01: BriefCase-Triage K253265 (positive control)

**CONSTRUCTED claim.** BriefCase-Triage flags suspected intra-abdominal free gas on abdominal CT for adults, to prioritise the radiologist worklist in our hospital network. In FDA's review of 394 cases from 6 US sites, sensitivity was 94.2%.

Claimed use: product `device:fda:K253265`, version unspecified, population {"age":{"min":18},"conditions":["intra-abdominal free gas"]}, setting ["hospital"], purpose `triage_notification`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

No software version is stated in the summary or in GUDID for K253265, so the claim names none.

Evidence for the key:

- `bc.ifu` (fixtures/fda/K253265_summary_text.txt, sha256 299603798b4e): "BriefCase-Triage is a radiological computer aided triage and notification software indicated for use in the analysis of abdominal CT images in adults or transitional adolescents aged 18 and older."
- `bc.ifg` (fixtures/fda/K253265_summary_text.txt, sha256 299603798b4e): "flagging and communication of suspected positive findings of Intra-abdominal free gas (IFG) pathologies."
- `bc.study` (fixtures/fda/K253265_summary_text.txt, sha256 299603798b4e): "evaluate the software's performance in identifying abdominal CT images in 394 cases from 6 US-based clinical sites."
- `bc.perf` (fixtures/fda/K253265_summary_text.txt, sha256 299603798b4e): "Sensitivity was 94.2% (95% CI: 89.6%, 97.2%) and Specificity was 94.6% (95% CI: 90.7%, 97.2%)"

### BC-02: BriefCase-Triage K253265 (shared device name across K-numbers)

**CONSTRUCTED claim.** BriefCase-Triage (K253265) detects intracranial hemorrhage on non-contrast head CT with 82.2% sensitivity, shown in a 101,944-scan real-world evaluation.

Claimed use: product `device:fda:K253265`, version unspecified, population {"age":{"min":18},"conditions":["intracranial hemorrhage"]}, setting ["hospital"], purpose `triage_notification`, date unspecified.

**Expected: INSUFFICIENT_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW, CONTRADICTED_BY_SPECIFIED_EVIDENCE). Key confidence: contestable. Mismatch dimension(s): population.

The FDA AI list has 35 rows named BriefCase; the name alone does not say which indication. K253265 is the free-gas module; the cited study (PMID 41444826) is the ICH module, a different submission. The 82.2% is real but belongs to another product.

Evidence for the key:

- `bc.ifg` (fixtures/fda/K253265_summary_text.txt, sha256 299603798b4e): "flagging and communication of suspected positive findings of Intra-abdominal free gas (IFG) pathologies."
- `bc.ich` (fixtures/pubmed/ef_briefcase2.xml, sha256 d9e4cccc5846): "We retrospectively evaluated a commercial AI model (Aidoc Medical Briefcase ICH Triage) across 101,944 non-contrast head CT examinations from 74,142 patients in a 17-facility academic health system (April 2023-April 2025)."
- `bc.ich.sens` (fixtures/pubmed/ef_briefcase2.xml, sha256 d9e4cccc5846): "Overall, the Aidoc model demonstrated 82.2% sensitivity, 97.6% specificity, and 96.6% accuracy."
- `bc.list` (fixtures/fda/ai-enabled-devices.csv, sha256 315672a00715): "11/06/2025,K253265,BriefCase-Triage,"Aidoc Medical , Ltd.",Radiology,QAS"
- `bc.list2` (fixtures/fda/ai-enabled-devices.csv, sha256 315672a00715): "05/14/2026,K261317,BriefCase-Triage,"Aidoc Medical , Ltd.",Radiology,QAS"

### MS-01: MammoScreen 3 K240301 (missing study)

**CONSTRUCTED claim.** MammoScreen 3 lowers the recall rate when used as an AI-assisted second reader in organised screening, according to the 5,000-woman Therapixel trial.

Claimed use: product `device:fda:K240301`, version 3, population {"age":{"min":50,"max":74},"conditions":["women undergoing screening mammography"]}, setting null, purpose `ai_assisted_second_reading`, date unspecified.

**Expected: INSUFFICIENT_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW). Key confidence: clear. Mismatch dimension(s): metric.

The registry record is a protocol (recruiting, estimated enrolment, no results, no software version). FDA's indication is concurrent reading aid, not second reader.

Evidence for the key:

- `ms.ct.status` (fixtures/ctgov/study_NCT05800132.json, sha256 59a28e29b98d): ""overallStatus":"RECRUITING""
- `ms.ct.noresults` (fixtures/ctgov/study_NCT05800132.json, sha256 59a28e29b98d): ""hasResults":false"
- `ms.ct.outcome` (fixtures/ctgov/study_NCT05800132.json, sha256 59a28e29b98d): ""measure":"Recall rate""
- `ms.ct.enrol` (fixtures/ctgov/study_NCT05800132.json, sha256 59a28e29b98d): ""enrollmentInfo":{"count":5000,"type":"ESTIMATED"}"

### MS-02: MammoScreen 3 K240301 (intended-use mismatch (autonomous reading))

**CONSTRUCTED claim.** MammoScreen 3 can read screening mammograms on its own, so no radiologist review is needed for exams it scores as normal.

Claimed use: product `device:fda:K240301`, version 3, population {"conditions":["women undergoing screening mammography"]}, setting null, purpose `autonomous_reading`, date unspecified.

**Expected: CONTRADICTED_BY_SPECIFIED_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW, INSUFFICIENT_EVIDENCE). Key confidence: contestable. Mismatch dimension(s): purpose.

FDA's text says decisions should not rest solely on the device's analysis, which contradicts the claimed autonomous use.

Evidence for the key:

- `ms.ifu` (fixtures/fda/K240301_summary_text.txt, sha256 5fe2584f36fb): "is a concurrent reading and reporting aid for physicians interpreting screening mammograms."
- `ms.notsolely` (fixtures/fda/K240301_summary_text.txt, sha256 5fe2584f36fb): "Patient management decisions should not be made solely based on the analysis by MammoScreen 3."

### PG-01: Paige Prostate DEN200080 (version / build mismatch)

**CONSTRUCTED claim.** Paige Prostate 2.1.501 increased pathologists' detection of prostate cancer on core needle biopsy whole-slide images in a published reader study.

Claimed use: product `device:fda:DEN200080`, version 2.1.501, population {"conditions":["prostate needle biopsy whole slide images"]}, setting null, purpose `assistive_detection_after_initial_review`, date unspecified.

**Expected: INSUFFICIENT_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW). Key confidence: contestable. Mismatch dimension(s): version.

The published reader study evaluated 'Paige Prostate Alpha', a research build. FDA's own reader study used the locked v2.1.501, but the claim cites the published paper. The evidence set is the cited paper only: a claim resting on FDA's own reader study (locked v2.1.501) would be a different claim and would be supported. A system that holds both and answers from the FDA study has answered a different question than the one asked; record that if it happens.

Evidence for the key:

- `pg.version` (fixtures/fda/DEN200080_summary_text.txt, sha256 638f177ff353): "Version (v) 2.1.501 was released prior to its use in all the performance studies"
- `pg.alpha` (fixtures/pubmed/ef_paige.xml, sha256 fecd609d4b91): "we investigated how pathologists interact with Paige Prostate Alpha"

### PG-02: Paige Prostate DEN200080 (positive control)

**CONSTRUCTED claim.** Paige Prostate v2.1.501 assists pathologists after their initial review of prostate needle-biopsy whole-slide images, by marking the location most likely to contain cancer. FDA's clinical study used 610 whole-slide images.

Claimed use: product `device:fda:DEN200080`, version 2.1.501, population {"conditions":["prostate needle biopsy whole slide images"]}, setting null, purpose `assistive_detection_after_initial_review`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

The text says 'originally consisted of 610' slides; the final analysed set was smaller (the summary states exclusions). The number in the claim text is the original sample, as the quote says.

Evidence for the key:

- `pg.ifu` (fixtures/fda/DEN200080_summary_text.txt, sha256 638f177ff353): "Paige Prostate is a software only device intended to assist pathologists in the detection of foci that are suspicious for cancer during the review of scanned whole slide images (WSI)"
- `pg.after` (fixtures/fda/DEN200080_summary_text.txt, sha256 638f177ff353): "After initial diagnostic review of the WSI by the pathologist, if Paige Prostate detects tissue morphology suspicious for cancer"
- `pg.version` (fixtures/fda/DEN200080_summary_text.txt, sha256 638f177ff353): "Version (v) 2.1.501 was released prior to its use in all the performance studies"
- `pg.n` (fixtures/fda/DEN200080_summary_text.txt, sha256 638f177ff353): "The sample set originally consisted of 610 whole slide images of prostate needle biopsy slides (190 cancer and 420 benign)"

### GI-01: GI Genius DEN200055 (narrower population (age range))

**CONSTRUCTED claim.** GI Genius can assist endoscopists in detecting colonic lesions in all adult patients (18 and older) undergoing screening or surveillance colonoscopy.

Claimed use: product `device:fda:DEN200055`, version unspecified, population {"age":{"min":18},"conditions":["colorectal cancer screening or post-polypectomy surveillance"]}, setting ["endoscopy_unit"], purpose `computer_assisted_lesion_detection`, date unspecified.

**Expected: SUPPORTED_ONLY_FOR_NARROWER_SCOPE**. Key confidence: clear. Mismatch dimension(s): population. Supported narrower scope: patients aged 40 to 80.

The FDA indication names no age; the randomised study enrolled 40 to 80 at three Italian centres.

Evidence for the key:

- `gi.ifu` (fixtures/fda/DEN200055_summary_text.txt, sha256 d87aa4e3c1d3): "The GI Genius System is a computer-assisted reading tool designed to aid endoscopists in detecting colonic mucosal lesions (such as polyps and adenomas) in real time during standard white-light endoscopy examinations of patients undergoing screening and surve..."
- `gi.age` (fixtures/fda/DEN200055_summary_text.txt, sha256 d87aa4e3c1d3): "The study enrolled subjects between 40 and 80 years of age who were undergoing colonoscopies for primary colorectal cancer (CRC) screening or post-polypectomy surveillance"

### GI-02: GI Genius DEN200055 (positive control)

**CONSTRUCTED claim.** GI Genius assists our endoscopists in detecting polyps and adenomas during white-light screening colonoscopy of patients aged 45 to 75, as in the FDA-reviewed randomised study.

Claimed use: product `device:fda:DEN200055`, version unspecified, population {"age":{"min":45,"max":75},"conditions":["colorectal cancer screening or post-polypectomy surveillance"]}, setting ["endoscopy_unit"], purpose `computer_assisted_lesion_detection`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

45 to 75 lies inside 40 to 80. The study was run in Italy; country is not a scored dimension in this key (see PROTOCOL.md).

Evidence for the key:

- `gi.ifu` (fixtures/fda/DEN200055_summary_text.txt, sha256 d87aa4e3c1d3): "The GI Genius System is a computer-assisted reading tool designed to aid endoscopists in detecting colonic mucosal lesions (such as polyps and adenomas) in real time during standard white-light endoscopy examinations of patients undergoing screening and surve..."
- `gi.age` (fixtures/fda/DEN200055_summary_text.txt, sha256 d87aa4e3c1d3): "The study enrolled subjects between 40 and 80 years of age who were undergoing colonoscopies for primary colorectal cancer (CRC) screening or post-polypectomy surveillance"
- `gi.sites` (fixtures/fda/DEN200055_summary_text.txt, sha256 d87aa4e3c1d3): "The study was conducted at three medical centers in Italy"

### HF-01: HeartFlow Analysis K213857 (missing study / version)

**CONSTRUCTED claim.** HeartFlow Analysis FFRct v3 has per-patient sensitivity of 86% and specificity of 79% for ischaemia, from the 254-patient NXT trial.

Claimed use: product `device:fda:K213857`, version v3, population {"conditions":["suspected stable coronary artery disease"]}, setting null, purpose `coronary_risk_and_functional_assessment`, date unspecified.

**Expected: INSUFFICIENT_EVIDENCE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW). Key confidence: contestable. Mismatch dimension(s): version.

The 2014 NXT abstract names no software version, and the K213857 summary describes no clinical study; the release in K213857 is 'v3.plus' (GUDID: 'FFRct version 3'). The numbers are quoted correctly but cannot be placed on the cleared release.

Evidence for the key:

- `hf.v3plus` (fixtures/fda/K213857_summary_text.txt, printed page 2 of 5, sha256 c94fb983149c): "Table 5-1. Predicate Device Comparison Autoplaque (predicate) FFRCT v3.plus"
- `hf.gudid` (fixtures/openfda/udi_K213857.json, sha256 bb2d1cd11dc0): ""version_or_model_number":"FFRct version 3""
- `hf.nxt.perf` (fixtures/pubmed/ef_heartflow2.xml, sha256 78702eac0656): "Per-patient sensitivity and specificity (95% CI) to identify myocardial ischemia were 86% (95% CI: 77% to 92%) and 79% (95% CI: 72% to 84%) for FFR(CT)"
- `hf.nxt.date` (fixtures/pubmed/ef_heartflow2.xml, sha256 78702eac0656): "(HeartFlowNXT-HeartFlow Analysis of Coronary Blood Flow Using Coronary CT Angiography [HFNXT]; NCT01757678)"

### AN-01: Anumana Low EF AI-ECG K232699 (positive control)

**CONSTRUCTED claim.** The Anumana Low EF AI-ECG algorithm aids screening for left ventricular ejection fraction of 40% or less in adults at risk for heart failure. In the FDA-reviewed validation of 16,000 records from 4 US health systems, sensitivity was 84.5%.

Claimed use: product `device:fda:K232699`, version unspecified, population {"age":{"min":18},"conditions":["adults at risk for heart failure"],"exclusions":["paced rhythm"]}, setting null, purpose `lvef_40_screening`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

The validation used 13,960 evaluable records of the 16,000; the claim quotes the 16,000 records as FDA does.

Evidence for the key:

- `an.ifu` (fixtures/fda/K232699_summary_text.txt, printed page 1 of 1, sha256 84425caf19cd): "software intended to aid in screening for Left Ventricular Ejection Fraction (LVEF) less than or equal to 40% in adults at risk for heart failure."
- `an.design` (fixtures/fda/K232699_summary_text.txt, printed page 3 of 9, sha256 84425caf19cd): "validated in a retrospective study of 16,000 patient records across 4 health systems across the United States"
- `an.perf` (fixtures/fda/K232699_summary_text.txt, printed page 4 of 9, sha256 84425caf19cd): "sensitivity of 84.5% (95% CI of 82.2% to 86.6%), a specificity of 83.6% (95% CI of 82.9% to 84.2%)"

### AN-02: Anumana Low EF AI-ECG K232699 (narrower population (exclusion))

**CONSTRUCTED claim.** The Anumana Low EF AI-ECG algorithm screens for low ejection fraction in all adults at risk for heart failure, including patients with ventricular pacing.

Claimed use: product `device:fda:K232699`, version unspecified, population {"age":{"min":18},"conditions":["adults at risk for heart failure","paced rhythm"]}, setting null, purpose `lvef_40_screening`, date unspecified.

**Expected: SUPPORTED_ONLY_FOR_NARROWER_SCOPE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW). Key confidence: contestable. Mismatch dimension(s): population. Supported narrower scope: adults at risk for heart failure without pacing present.

The validation paired each patient's ECG 'without pacing present'; the indication names no pacing exclusion. Whether the pairing rule is an exclusion criterion of the intended use is clinical judgement, hence contestable.

Evidence for the key:

- `an.pacing` (fixtures/fda/K232699_summary_text.txt, printed page 3 of 9, sha256 84425caf19cd): "(without pacing present)"
- `an.ifu` (fixtures/fda/K232699_summary_text.txt, printed page 1 of 1, sha256 84425caf19cd): "software intended to aid in screening for Left Ventricular Ejection Fraction (LVEF) less than or equal to 40% in adults at risk for heart failure."

### ID-01: IDx-DR DEN180001 (positive control)

**CONSTRUCTED claim.** IDx-DR 2.0.0 detects more than mild diabetic retinopathy in adults aged 22 and older with diabetes and no previous retinopathy diagnosis, in primary care, with the Topcon NW400. The pivotal study of 900 patients at 10 primary care sites reported 87.4% sensitivity.

Claimed use: product `device:fda:DEN180001`, version 2.0.0, population {"age":{"min":22},"conditions":["diabetes mellitus"],"exclusions":["previously diagnosed with diabetic retinopathy"]}, setting ["primary_care"], purpose `dr_screening_detection`, date unspecified.

**Expected: SUPPORTED_FOR_SCOPE**. Key confidence: clear. Mismatch dimension(s): none (positive control).

Version 2.0.0 is 'IDx-DR 2.0.0 US' in the summary.

Evidence for the key:

- `id.ifu` (fixtures/fda/DEN180001_summary_text.txt, printed page 1 of 13, sha256 ec5175afb062): "IDx-DR is indicated for use by health care providers to automatically detect more than mild diabetic retinopathy (mtmDR) in adults diagnosed with diabetes who have not been previously diagnosed with diabetic retinopathy. IDx-DR is indicated for use with the T..."
- `id.pivotal` (fixtures/fda/DEN180001_summary_text.txt, printed page 5 of 13, sha256 ec5175afb062): "IDx conducted a pivotal clinical study with 900 patients who were enrolled at 10 primary care sites. The target population was asymptomatic persons, ages 22 and older"
- `id.version` (fixtures/fda/DEN180001_summary_text.txt, printed page 3 of 13, sha256 ec5175afb062): "Software version IDx-DR 2.0.0 US was identified as having a major level of concern"
- `id.sens` (fixtures/fda/DEN180001_summary_text.txt, printed page 7 of 13, sha256 ec5175afb062): "observed sensitivity was at 87.4% (95%CI, 81.9% - 92.9%)"

### ID-02: IDx-DR DEN180001 (different setting)

**CONSTRUCTED claim.** IDx-DR 2.0.0 can be used in our primary-care and ophthalmology clinics to screen adults with diabetes aged 22 and older who have no previous retinopathy diagnosis.

Claimed use: product `device:fda:DEN180001`, version 2.0.0, population {"age":{"min":22},"conditions":["diabetes mellitus"],"exclusions":["previously diagnosed with diabetic retinopathy"]}, setting ["primary_care","eye_care"], purpose `dr_screening_detection`, date unspecified.

**Expected: SUPPORTED_ONLY_FOR_NARROWER_SCOPE** (also acceptable, withholding support: REQUIRES_DOMAIN_REVIEW). Key confidence: contestable. Mismatch dimension(s): setting. Supported narrower scope: primary care clinics.

Contrast with EyeArt, whose indication names both primary care and eye care. The claim covers primary care and eye care; the labelling and the study are primary care only, so primary care is the narrower scope that is supported. Whether eye-clinic use is outside the label or merely unevidenced is a judgement, hence contestable.

Evidence for the key:

- `id.label` (fixtures/fda/DEN180001_summary_text.txt, printed page 9 of 13, sha256 ec5175afb062): "The device labeling is for primary care clinics and stable visually asymptomatic patients"
- `id.pivotal` (fixtures/fda/DEN180001_summary_text.txt, printed page 5 of 13, sha256 ec5175afb062): "IDx conducted a pivotal clinical study with 900 patients who were enrolled at 10 primary care sites. The target population was asymptomatic persons, ages 22 and older"

### CP-01: Caption Guidance DEN190040 (narrower population (age range))

**CONSTRUCTED claim.** Caption Guidance helps nurses and sonographers acquire the standard transthoracic echo views in patients of all ages, including children.

Claimed use: product `device:fda:DEN190040`, version unspecified, population {"age":{"min":0}}, setting null, purpose `echo_image_acquisition_guidance`, date unspecified.

**Expected: SUPPORTED_ONLY_FOR_NARROWER_SCOPE** (also acceptable, withholding support: CONTRADICTED_BY_SPECIFIED_EVIDENCE). Key confidence: contestable. Mismatch dimension(s): population. Supported narrower scope: adult patients.

The indication says adult patients. Adult is stored as 18 and over for the oracle; the FDA text does not give a number. Whether an explicit 'adult patients' limit makes a claim for children CONTRADICTED (the authorization names the limit) or SUPPORTED_ONLY_FOR_NARROWER_SCOPE (the adult part is supported) is a labelling-policy question; both withhold full support, so the acceptable set includes CONTRADICTED_BY_SPECIFIED_EVIDENCE. This allowance was added after a dry run of src/compiler returned CONTRADICTED (see ANSWER-KEY.md, changes made after seeing a system output).

Evidence for the key:

- `cp.ifu` (fixtures/fda/DEN190040_summary_text.txt, sha256 956337bdb636): "Caption Guidance software is indicated for use in two-dimensional transthoracic echocardiography (2D-TTE) for adult patients, specifically in the acquisition of the following standard views"
