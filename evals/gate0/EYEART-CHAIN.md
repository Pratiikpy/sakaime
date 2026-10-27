# EyeArt chain, hand-proven (Gate 0, C-11)

Retrieval date for every record: 2026-10-27. Label: **single builder, two passes, not independent**. Machine-readable twin: `eyeart-case-manifest.json`. Every quote below is checked by `tools/build-eyeart-manifest.mjs` against the raw record (whitespace-collapsed, ASCII-folded); page numbers and hashes are computed, not typed.

## Verdict

CHAIN PROVEN at identifier level for all hops; version equality proven at release-string level only; build-level identity NOT VERIFIED. Discrepancies D1 to D10 are recorded, none breaks the chain.

Admissible as the first authentic case for ScopeShift (B) and for the demo, with the discrepancies in section 4 shown rather than hidden. It is a clean case in the narrow sense that the identifiers chain; it is not free of ambiguity, and the ambiguity is the point of the product.

## 1. Sources

| id | record | sha256 | URL |
|---|---|---|---|
| ai_list | `research/feasibility/fixtures/fda/ai-enabled-devices.csv` | `315672a00715b7c0...` | https://www.fda.gov/media/178541/download?attachment |
| openfda_510k | `research/feasibility/fixtures/openfda/510k_K200667.json` | `7d5e109b9f6a3122...` | https://api.fda.gov/device/510k.json?search=k_number:K200667 |
| gudid | `research/feasibility/fixtures/openfda/udi_K200667.json` | `e48bf4de3d43a508...` | https://api.fda.gov/device/udi.json?search=premarket_submissions.submission_number%3A%22K2... |
| fda_summary | `research/feasibility/fixtures/fda/K200667_summary_text.txt` | `d8b8d5d8e4386cb8...` | https://www.accessdata.fda.gov/cdrh_docs/pdf20/K200667.pdf |
| ctgov | `research/feasibility/fixtures/ctgov/study_NCT03112005.json` | `f7fad8837f858972...` | https://clinicaltrials.gov/api/v2/studies/NCT03112005 |
| pubmed | `research/feasibility/fixtures/pubmed/ef_eyeart.xml` | `6cf769a3ca8cd851...` | https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34779843 (batch fil... |
| pubmed_esearch_all | `research/feasibility/fixtures/pubmed/es_all_NCT03112005.json` | `f90410efa72024e7...` | https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=NCT03112005 |
| pubmed_esearch_si | `research/feasibility/fixtures/pubmed/es_NCT03112005.json` | `5ccdd7d099983675...` | https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=%22NCT03112005%2... |
| epmc_fulltext | `evals/gate0/raw/europepmc/PMC8593763_fulltext.xml` | `393069621ddec750...` | https://www.ebi.ac.uk/europepmc/webservices/rest/PMC8593763/fullTextXML |
| erratum | `evals/gate0/raw/pubmed/ef_34935926_erratum.xml` | `be7a95b18381895b...` | https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34935926 |
| k223357_summary | `evals/gate0/raw/fda/K223357_summary_text.txt` | `76adc2d64177a1ab...` | https://www.accessdata.fda.gov/cdrh_docs/pdf22/K223357.pdf |
| k223357_openfda | `evals/gate0/raw/openfda/510k_K223357.json` | `865ac235969effc5...` | https://api.fda.gov/device/510k.json?search=k_number:K223357 |

Fixture hashes equal the rows in `research/feasibility/fixtures/MANIFEST.md` (checked). The FDA summary text is `pdftotext -layout` output; PDF page = printed summary page + 3.

## 2. The chain, hop by hop

### Hop 1: FDA AI-enabled device list row -> openFDA 510(k) record

Identifier: `K200667`. Relationship: **SAME_SUBMISSION**. State: **CONFIRMED**.

The list row's Submission Number equals openFDA k_number; device name EyeArt and applicant Eyenuk, Inc. agree (spelling 'Eyenuk, Inc' versus 'Eyenuk, Inc.').

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| list row | 08/03/2020,K200667,EyeArt,"Eyenuk, Inc",Ophthalmic,PIB | ai_list |  | `08/03/2020,K200667,EyeArt,"Eyenuk, Inc",Ophthalmic,PIB` |
| k_number | K200667 | openfda_510k |  | `"k_number":"K200667"` |
| device_name | EyeArt | openfda_510k |  | `"device_name":"EyeArt"` |
| applicant | Eyenuk, Inc. | openfda_510k |  | `"applicant":"Eyenuk, Inc."` |
| decision_date | 2020-08-03 | openfda_510k |  | `"decision_date":"2020-08-03"` |
| date_received | 2020-03-13 | openfda_510k |  | `"date_received":"2020-03-13"` |
| product_code | PIB | openfda_510k |  | `"product_code":"PIB"` |
| clearance_type / decision | Traditional / Substantially Equivalent | openfda_510k |  | `"decision_description":"Substantially Equivalent"` |
| statement_or_summary | Summary | openfda_510k |  | `"statement_or_summary":"Summary"` |
| indications text in openFDA | ABSENT | openfda_510k | | The openFDA 510(k) record has no indications, software version or study field (checked: field names in the record). |

### Hop 2: openFDA 510(k) record -> GUDID record (version label)

Identifier: `K200667 in premarket_submissions`. Relationship: **SAME_MARKETED_VERSION**. State: **CONFIRMED (label only)**.

The single GUDID record for submission K200667 carries version_or_model_number 2.1.0, brand EyeArt, company Eyenuk, Inc. GUDID states a marketed version label; it does not state which build a study used.

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| premarket_submissions.submission_number | K200667 | gudid |  | `"submission_number":"K200667"` |
| version_or_model_number | 2.1.0 | gudid |  | `"version_or_model_number":"2.1.0"` |
| brand_name | EyeArt | gudid |  | `"brand_name":"EyeArt"` |
| company_name | Eyenuk, Inc. | gudid |  | `"company_name":"Eyenuk, Inc."` |
| publish_date / public_version_date | 2020-11-09 / 2022-06-10 | gudid |  | `"public_version_date":"2022-06-10"` |
| GUDID records for K200667 | 1 | gudid |  | `"total":1` |

### Hop 3: openFDA 510(k) record -> FDA 510(k) summary PDF

Identifier: `K200667 (printed 'Re: K200667')`. Relationship: **SAME_SUBMISSION**. State: **CONFIRMED**.

PDF at accessdata cdrh_docs/pdf20/K200667.pdf; the letter names K200667, EyeArt, Eyenuk, and is dated August 3, 2020 (openFDA decision_date 2020-08-03). Source PDF sha256 matches the fixture manifest and was re-fetched.

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| indications for use | Automatic detection of more than mild DR and vision-threatening DR in eyes of adults diagnosed with diabetes who have n... | fda_summary | printed 1 of 21 (PDF 4) | `EyeArt is indicated for use by healthcare providers to automatically detect more than mild diabetic retinopathy and vision-threatening diabetic retin...` |
| software version of the cleared device | v2.1.0 | fda_summary | printed 3 of 21 (PDF 6) | `EyeArt (software version v2.1.0) was identified as having a major level of concern` |
| human-factors build | v2.1.0 rev005 validated; rev006 assessed as not adding critical tasks | fda_summary | printed 10 of 21 (PDF 13) | `a validation study using EyeArt v2.1.0 rev005` |
| predicate | IDx-DR, De Novo DEN180001 | fda_summary | printed 1 of 21 (PDF 4) | `Trade name of the device: IDx-DR` |
| dates printed on the FDA letter | Dated June 30, 2020; Received June 30, 2020; decision letter August 3, 2020 | fda_summary |  | `Dated: June 30, 2020 Received: June 30, 2020` |
| software version used in the pivotal trial | ABSENT | fda_summary | | The summary names v2.1.0 for the cleared device and for human-factors builds; it does not say which build produced the pivotal-trial results. The link to v2.1.0 for the trial comes from the PubMed record (hop 6), not from FDA. |
| operating threshold or cut-off | ABSENT | fda_summary | | No threshold, cut-off or operating point is stated in the summary (second pass searched for threshold, cut-off, cutoff, operating point and found none). |

### Hop 4: FDA 510(k) summary PDF -> ClinicalTrials.gov NCT03112005

Identifier: `NCT03112005`. Relationship: **STUDY_EVALUATES**. State: **CONFIRMED**.

FDA's own text cites the registry id as the pivotal trial.

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| trial cited by FDA | NCT03112005 | fda_summary | printed 3 of 21 (PDF 6) | `EyeArt was validated in a prospective, multi-center pivotal clinical trial (ClinicalTrials.gov ID NCT03112005). A total of 942 subjects were consente...` |
| enrolment funnel (FDA) | 942 consented; 915 met eligibility; 655 in the analysis population | fda_summary | printed 4 of 21 (PDF 7) | `analyses were presented on 655 participants after excluding subjects who did not meet certain additional prespecified criteria (e.g., subjects 21 yea...` |
| sites (FDA, analysis population) | 11 US study sites (primary care centers and general ophthalmology centers) | fda_summary | printed 4 of 21 (PDF 7) | `The 655 participants were enrolled in the study at 11 US study sites that included primary care centers and general ophthalmology centers.` |
| cohorts | sequential 235 (45 primary care, 190 ophthalmology); enrichment-permitted 420 (335 primary care, 85 ophthalmology) | fda_summary | printed 4 of 21 (PDF 7) | `(235 subjects, with 45 enrolled at primary care sites and 190 enrolled at ophthalmology sites)` |
| target population age (FDA analysis) | 22 years and older | fda_summary | printed 4 of 21 (PDF 7) | `The target population of the EyeArt pivotal clinical trial analysis was asymptomatic persons aged 22 years and older who were diagnosed with diabetes...` |
| reference standard | Fundus Photography Reading Center grading, ETDRS scale, dilated 4-wide field stereo fundus imaging | fda_summary | printed 4 of 21 (PDF 7) | `reference standard determined by experienced and certified graders at the Fundus Photography Reading Center (FPRC)` |
| primary outcomes | sensitivity and specificity for mtmDR and vtDR, per eye | fda_summary | printed 6 of 21 (PDF 9) | `The primary outcomes were the sensitivity and specificity of EyeArt for detecting mtmDR and vtDR in subject eyes.` |
| confidence interval method | clustered bootstrap; Wilson where the proportion is 100% | fda_summary | printed 7 of 21 (PDF 10) | `All the 95% confidence intervals (CIs) are computed using the clustered bootstrap method` |

### Hop 5: ClinicalTrials.gov record -> same record, fields read

Identifier: `NCT03112005`. Relationship: **SAME_PRODUCT (sponsor Eyenuk, Inc.; intervention is a fundus-photography procedure, the device name EyeArt appears only in the title)**. State: **CONFIRMED by identifier; product named only in titles**.

The record's interventions are 'Color fundus photography' and 'Mydriatic Agent'; a search by intervention name would not find it.

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| nctId | NCT03112005 | ctgov |  | `"nctId":"NCT03112005"` |
| enrollment | 942 (actual) | ctgov |  | `"enrollmentInfo":{"count":942,"type":"ACTUAL"}` |
| start date | 2017-04-17 | ctgov |  | `"startDateStruct":{"date":"2017-04-17","type":"ACTUAL"}` |
| completion date | 2018-05-31 | ctgov |  | `"completionDateStruct":{"date":"2018-05-31","type":"ACTUAL"}` |
| status / last verified | COMPLETED, verified 2018-07, no results posted | ctgov |  | `"statusVerifiedDate":"2018-07"` |
| minimum age | 18 Years | ctgov |  | `"minimumAge":"18 Years"` |
| study population / setting | Study subjects will be enrolled at eye care practices and primary/diabetes care practices | ctgov |  | `"studyPopulation":"Study subjects will be enrolled at eye care practices and primary/diabetes care practices"` |
| listed locations | 1 (Los Angeles Biomedical Research Institute) | ctgov |  | `"facility":"Los Angeles Biomedical Research Institute"` |
| primary outcome 1 | EyeArt results match reading center grading for referable diabetic eye disease (moderate NPDR or higher on ICDR, or sur... | ctgov |  | `Number of subject eyes whose EyeArt results match the reading center grading for identifying referable diabetic eye disease (moderate NPDR or higher ...` |
| software freeze statement | device frozen before first enrolment, copy kept in a version-controlled system; no version number given | ctgov |  | `The EyeArt device will be finalized and frozen before the first subject is enrolled and a copy will be placed in a version-controlled system.` |
| software version in the registry record | ABSENT | ctgov | | No version string in the registry record. |
| registry-side publication links (referencesModule) | ABSENT | ctgov | | The record has no referencesModule; the registry does not link the paper. The link exists only because the paper cites the NCT number. |

### Hop 6: ClinicalTrials.gov NCT03112005 -> PubMed PMID 34779843 (JAMA Netw Open 2021)

Identifier: `NCT03112005 in the abstract`. Relationship: **PUBLICATION_REPORTS**. State: **CONFIRMED (identifier in text, one direction only)**.

PubMed finds the paper by the NCT string as free text; the secondary-source-id field search returns 0, and the registry record lists no publication. The link exists only because the paper cites the registry id.

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| PubMed search NCT03112005 [All Fields] | PMID 34779843 | pubmed_esearch_all |  | `"idlist":["34779843"]` |
| PubMed secondary-source-id search NCT03112005[si] | 0 hits | pubmed_esearch_si |  | `"count":"0"` |
| design, dates, sites, age | prospective multicenter cross-sectional diagnostic study, 2017-04-17 to 2018-05-30, 942 consented aged 18 or older with... | pubmed |  | `A prospective multicenter cross-sectional diagnostic study was preregistered (NCT03112005) and conducted from April 17, 2017, to May 30, 2018. A tota...` |
| analysed population and age | 893 patients (1786 eyes); mean age 53.9 (SD 15.2), median 56, range 18-88 | pubmed |  | `Of 942 consenting individuals, 893 patients (1786 eyes) met the inclusion criteria and completed the study protocol.` |
| age distribution | mean 53.9 (SD 15.2); median 56; range 18-88 | pubmed |  | `Mean (SD) participant age was 53.9 (15.2) years (median, 56; range, 18-88 years)` |
| primary performance, without dilation | mtmDR sensitivity 95.5% (95% CI 92.4-98.5), specificity 85.0% (82.6-87.4); vtDR sensitivity 95.1% (90.1-100), specifici... | pubmed |  | `Sensitivity and specificity of the AI system were high in detecting mtmDR (sensitivity: 95.5%; 95% CI, 92.4%-98.5% and specificity: 85.0%; 95% CI, 82...` |
| imageability without dilation | 87.4% (95% CI 85.2-89.6) | pubmed |  | `the AI system able to grade 87.4% (95% CI, 85.2%-89.6%) of the eyes with reading center grades` |
| version in the abstract | version 2.1.0 | pubmed |  | `To evaluate the safety and accuracy of an artificial intelligence (AI) system (the EyeArt Automated DR Detection System, version 2.1.0) in detecting ...` |
| correction notice | ErratumIn: JAMA Netw Open 2021 Dec 1;4(12):e2144317 (PMID 34935926), titled "Error in Figure 2"; what changed is NOT VE... | pubmed |  | `JAMA Netw Open. 2021 Dec 1;4(12):e2144317. doi: 10.1001/jamanetworkopen.2021.44317.` |
| erratum title | Error in Figure 2. | erratum |  | `Error in Figure 2.` |
| operating threshold in the abstract | ABSENT | pubmed | | Not stated in the abstract. |

### Hop 6.5: PubMed abstract -> Europe PMC open-access full text (PMC8593763)

Identifier: `PMID 34779843 / PMC8593763`. Relationship: **same article**. State: **CONFIRMED**.

Needed because the abstract does not give cameras, centre mix or the prespecified hypotheses.

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| centre mix (full text) | 15 US centres: 6 primary care, 6 general ophthalmology, 3 retina specialty | epmc_fulltext |  | `Fifteen US study centers participated, including primary care (6), general ophthalmology (6), and retina specialty (3) centers.` |
| cameras (full text) | Canon CR-2 AF or Canon CR-2 Plus AF | epmc_fulltext |  | `(Canon CR-2 AF or Canon CR-2 Plus AF; Canon USA Inc)` |
| enrolment funnel (full text) | 942 consented; 915 met eligibility (1830 eyes); 893 completed (1786 eyes) | epmc_fulltext |  | `Of 942 consenting individuals, 915 participants (1830 eyes) met eligibility criteria and 893 participants (1786 eyes) (intent-to-screen) completed th...` |
| prespecified hypotheses (full text) | null: sensitivity at most 80%, specificity at most 77.5%; alternative: 90.0% and 82.5% | epmc_fulltext |  | `Alternative hypotheses of 90.0% for sensitivity and 82.5% for specificity were established.` |
| operating threshold (full text) | ABSENT | epmc_fulltext | | The full text reports a binary output per eye; no numeric threshold or cut-off for the algorithm score is stated (second pass searched threshold, cut-off, cutoff, operating point; the only 'threshold' hit is the p-value threshold). |

### Hop 7: version strings in three sources -> FDA v2.1.0 = GUDID 2.1.0 = PubMed 'version 2.1.0'

Identifier: `2.1.0`. Relationship: **SAME_MARKETED_VERSION**. State: **CONFIRMED at string level; CANDIDATE at build level**.

Three sources, all ultimately supplied by the sponsor and so not independent of each other, print the same release string. The FDA summary does not say which build produced the pivotal-trial numbers (it names v2.1.0 rev005 and rev006 for human-factors work), and the paper gives no build or revision. Equality of the release string is proven; identity of the exact build is NOT VERIFIED.

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| version_or_model_number | 2.1.0 | gudid |  | `"version_or_model_number":"2.1.0"` |
| software version of the cleared device | v2.1.0 | fda_summary | printed 3 of 21 (PDF 6) | `EyeArt (software version v2.1.0) was identified as having a major level of concern` |
| version in the abstract | version 2.1.0 | pubmed |  | `To evaluate the safety and accuracy of an artificial intelligence (AI) system (the EyeArt Automated DR Detection System, version 2.1.0) in detecting ...` |

### Hop 8: K200667 (v2.1.0) -> K223357 EyeArt v2.2.0 (decision 2023-06-16)

Identifier: `K223357`. Relationship: **SUPERSEDES (later clearance modifies v2.1.0 to v2.2.0; no withdrawal of K200667 was checked: NOT VERIFIED)**. State: **CONFIRMED (FDA text)**.

Not part of the original chain; recorded because it makes the date and version dimensions testable and because the later indication wording is narrower.

| fact | value | source | page | quote (shortened here; full in the JSON) |
|---|---|---|---|---|
| later EyeArt row on the same list | 06/16/2023,K223357,EyeArt v2.2.0,"Eyenuk, Inc.",Ophthalmic,PIB | ai_list |  | `06/16/2023,K223357,EyeArt v2.2.0,"Eyenuk, Inc.",Ophthalmic,PIB` |
| relationship to v2.1.0 | 510(k) to modify EyeArt (software version 2.1.0) and update it to 2.2.0 | k223357_summary | printed 3 of 10 (PDF 6) | `The purpose of this 510(k) notification is to modify EyeArt (software version 2.1.0) and update it to` |
| K223357 (v2.2.0) indications | adults with diabetes who have not been previously diagnosed with diabetic retinopathy; Canon CR-2 AF, Canon CR-2 Plus A... | k223357_summary | printed 1 of 1 (PDF 3) | `who have not been previously diagnosed with diabetic retinopathy. EyeArt is indicated for use with Canon CR-2 AF, Canon CR-2 Plus AF, and Topcon NW40...` |
| K223357 dates | received 2022-11-02, decision 2023-06-16 | k223357_openfda |  | `"decision_date":"2023-06-16"` |

## 3. Table cells (FDA Table 2 and Table 3)

Read from the page images (pdftotext interleaves the columns), then recomputed from each cell's own count. All 48 count tokens on the two pages recompute to a printed percentage within rounding (FDA prints the exact half 37/80 = 46.25 as 46.2).

| table | cohort | output | metric | k/n | printed | 95% CI | PDF page |
|---|---|---|---|---|---|---|---|
| Table 2 (sequential enrolment) | primary care, 90 eyes | mtmDR | sensitivity | 11/11 | 100.0% | [74.1% - 100%] | 10 (printed 7 of 21) |
| Table 2 (sequential enrolment) | primary care, 90 eyes | mtmDR | specificity | 69/75 | 92.0% | [85.1% - 97.5%] | 10 (printed 7 of 21) |
| Table 2 (sequential enrolment) | ophthalmology, 380 eyes | mtmDR | sensitivity | 37/39 | 94.9% | [86.4% - 100.0%] | 10 (printed 7 of 21) |
| Table 2 (sequential enrolment) | ophthalmology, 380 eyes | mtmDR | specificity | 281/324 | 86.7% | [82.1% - 90.7%] | 10 (printed 7 of 21) |
| Table 2 (sequential enrolment) | primary care, 90 eyes | vtDR | sensitivity | 4/4 | 100.0% | [51.0% - 100%] | 10 (printed 7 of 21) |
| Table 2 (sequential enrolment) | primary care, 90 eyes | vtDR | specificity | 77/79 | 97.5% | [93.4% - 100.0%] | 10 (printed 7 of 21) |
| Table 2 (sequential enrolment) | ophthalmology, 380 eyes | vtDR | sensitivity | 8/9 | 88.9% | NA | 10 (printed 7 of 21) |
| Table 2 (sequential enrolment) | ophthalmology, 380 eyes | vtDR | specificity | 331/353 | 93.8% | [90.4% - 96.6%] | 10 (printed 7 of 21) |
| Table 3 (enrichment permitted) | primary care, 670 eyes | mtmDR | sensitivity | 92/99 | 92.9% | [87.1% - 97.5%] | 11 (printed 8 of 21) |
| Table 3 (enrichment permitted) | primary care, 670 eyes | mtmDR | specificity | 457/534 | 85.6% | [82.2% - 89.1%] | 11 (printed 8 of 21) |
| Table 3 (enrichment permitted) | ophthalmology, 170 eyes | mtmDR | sensitivity | 28/29 | 96.6% | [87.5% - 100.0%] | 11 (printed 8 of 21) |
| Table 3 (enrichment permitted) | ophthalmology, 170 eyes | mtmDR | specificity | 115/135 | 85.2% | [78.1% - 91.5%] | 11 (printed 8 of 21) |
| Table 3 (enrichment permitted) | primary care, 670 eyes | vtDR | sensitivity | 22/24 | 91.7% | [80.0% - 100.0%] | 11 (printed 8 of 21) |
| Table 3 (enrichment permitted) | primary care, 670 eyes | vtDR | specificity | 553/600 | 92.2% | [89.6% - 94.6%] | 11 (printed 8 of 21) |
| Table 3 (enrichment permitted) | ophthalmology, 170 eyes | vtDR | sensitivity | 4/4 | 100.0% | [51.0% - 100%] | 11 (printed 8 of 21) |
| Table 3 (enrichment permitted) | ophthalmology, 170 eyes | vtDR | specificity | 141/157 | 89.8% | [83.9% - 95.4%] | 11 (printed 8 of 21) |

## 4. Discrepancies between sources

| id | field | one side | other side | status |
|---|---|---|---|---|
| D1 | date the submission was received | openFDA date_received 2020-03-13 | FDA letter 'Received: June 30, 2020' and 'Dated: June 30, 2020' | UNEXPLAINED. The letter is dated August 3, 2020 (decision). Whether June 30 is a resubmission or additional-information date is NOT VERIFIED. |
| D2 | number of study sites | FDA: 11 US study sites (655-subject analysis population) | JAMA: 15 US centres (942 consented: 6 primary care, 6 general ophthalmology, 3 retina); registry: 1 location listed | Different populations counted (655 analysed versus 942 consented), and the registry list is incomplete. A claim that says 'N sites' must say which count. |
| D3 | participants | FDA: 942 consented, 915 eligible, 655 analysed (22 and older) | JAMA: 942 consented, 915 eligible, 893 completed (1786 eyes); registry: 942 | Different analysis populations; no conflict in the funnel's first two steps. |
| D4 | minimum age | FDA analysis population: 22 years and older (subjects 21 or younger excluded) | JAMA and registry: 18 years or older (range 18-88); FDA indication: 'adults' | Real scope difference: the indicated population is 'adults', the FDA-analysed population is 22 and older, the published population starts at 18. Age 18 to 21 is evidenced by the paper but not by FDA's analysis. |
| D5 | study end date | registry completion date 2018-05-31 | JAMA 'to May 30, 2018' | One-day difference; immaterial, recorded. |
| D6 | performance figures | FDA: per-cohort eye-level results (for example primary care, enrichment permitted: mtmDR sensitivity 92.9% [87.1-97.5], specificity 85.6%) | JAMA: pooled 893 patients (mtmDR sensitivity 95.5% [92.4-98.5], specificity 85.0% [82.6-87.4]) | Different analysis populations and weighting, not a conflict. A claim must name which result it quotes. |
| D7 | software version of the pivotal-trial build | FDA: silent (v2.1.0 is the cleared device; rev005 and rev006 appear for human-factors work) | JAMA abstract: version 2.1.0; registry: frozen build, no number | Release string agrees, build identity not stated anywhere. NOT VERIFIED beyond the string. |
| D8 | indication wording across versions | K200667 (v2.1.0): not previously diagnosed with MORE THAN MILD diabetic retinopathy; primary care and eye care named | K223357 (v2.2.0): not previously diagnosed with diabetic retinopathy; Topcon NW400 added; no setting sentence | The later indication is narrower on prior disease and silent on setting. Evidence for one version cannot be carried to the other without restating the indication. |
| D9 | correction to the paper | PubMed lists an erratum (PMID 34935926, JAMA Netw Open 2021 Dec 1;4(12):e2144317) | Erratum title: 'Error in Figure 2.' | What changed in Figure 2 is NOT VERIFIED (the PubMed record has no text). The abstract numbers quoted here were read from the current PubMed record, which postdates the erratum link (record revised 2026-05-18). |
| D10 | registry freshness | statusVerifiedDate 2018-07; no results posted | paper published 2021-11 | The registry was last verified before the results existed and has no publication link. |

## 5. What the sources do not give (absent stays absent)

| field | status |
|---|---|
| operating threshold, cut-off or operating point of the algorithm | ABSENT in FDA summary, registry, PubMed abstract and open-access full text (only a p-value threshold appears) |
| software build (revision) used in the pivotal trial | ABSENT; release string only |
| indications text in openFDA | ABSENT (openFDA has no indications or version field) |
| registry link from NCT03112005 to the publication | ABSENT |
| content of the erratum to Figure 2 | NOT VERIFIED |
| whether K200667 has been withdrawn or is still in use | NOT VERIFIED (GUDID says 'In Commercial Distribution' on the record read; no withdrawal data checked) |

## 6. Second pass

74 re-extractions from the raw records by a different method (parsed JSON and regular expressions, plus recomputation of every table count); 74 agree, 0 data disagreements. During development the second-pass script reported four disagreements; all four were bugs in the checking code (a regex dropped by shell escaping, an expected-token count, and a rounding convention: FDA prints 37/80 as 46.2%, an exact half rounded down), not differences between the readings. They were fixed and the script re-run to 74 of 74. Two further regexes were found to be vacuous and were repaired; each absence check was then tested against a positive control.

This is one agent reading twice. It does not provide independence from the builder's misreadings of meaning (for example choosing which of two sentences states the age floor). The abstract-versus-full-text and FDA-versus-registry differences in section 4 were found by the reading itself, not by the script.

## 7. The question for the demo

> Can our primary-care clinics use EyeArt version 2.1.0 to screen adults aged 22 or older who have diabetes and no previous diagnosis of more than mild diabetic retinopathy, and does the evidence behind the vendor's statement that sensitivity for more-than-mild diabetic retinopathy is at least 85 percent apply to that use?

Structured claimed use:

```json
{
  "claimedUse": {
    "product": "device:fda:K200667",
    "version": "2.1.0",
    "population": {
      "age": {
        "min": 22
      },
      "conditions": [
        "diabetes mellitus"
      ],
      "exclusions": [
        "previously diagnosed with more than mild diabetic retinopathy"
      ]
    },
    "setting": [
      "primary_care"
    ],
    "purpose": "dr_screening_detection",
    "date": null
  },
  "claimedPerformance": {
    "metric": "mtmDR_sensitivity",
    "atLeast": 0.85
  }
}
```

Results the claim is tested against (all from the anchored records above):

| source | result | CI lower bound at least 85% |
|---|---|---|
| FDA Table 2 (sequential), primary care, 90 eyes | 100.0% [74.1-100] | no (tiny cohort; point estimate above 85, lower confidence bound below) |
| FDA Table 2 (sequential), ophthalmology, 380 eyes | 94.9% [86.4-100.0] | yes |
| FDA Table 3 (enrichment permitted), primary care, 670 eyes | 92.9% [87.1-97.5] | yes |
| FDA Table 3 (enrichment permitted), ophthalmology, 170 eyes | 96.6% [87.5-100.0] | yes |
| JAMA Netw Open 2021, pooled, 893 patients | 95.5% [92.4-98.5] | yes |

Whether the claim is judged on point estimates or on the lower confidence bound is a rule choice with no source threshold; the tiny cohort makes it matter. The date is left out of the base claim: a deployment date after 2020 triggers the staleness rule (no source threshold, REQUIRES_DOMAIN_REVIEW) and belongs in the counterfactual lab.

Counterfactual lab, each recomputed without a model call:

| change | expected relation |
|---|---|
| version 2.2.0 | evidence for 2.1.0 no longer covers the claimed version; K223357 (2.2.0) is the evidence, with a narrower indication wording |
| age floor 18 | PARTIAL: FDA analysis floor is 22; the paper covers 18 and older |
| age floor 12 | PARTIAL, narrower scope 22 and older (claim EA-02) |
| setting emergency department | DISJOINT with primary care and eye care |
| include previously diagnosed mild DR | K200667 permits it ('more than mild'); K223357 does not (claim EA-05) |
| date 2026-11-01 | REQUIRES_DOMAIN_REVIEW: no staleness window in any source; a successor clearance exists (claim EA-03) |

## 8. What this does not establish

- It does not show that EyeArt performs as claimed in any hospital. It shows which records support which stated scope.
- Source independence is not assessed: the sponsor ran the pivotal trial and wrote the FDA summary; several authors of the paper are Eyenuk employees (PubMed conflict-of-interest statement).
- The registry listing of one location and the erratum to Figure 2 mean the chain's weakest links are data quality, not identity.
- No clinician reviewed the age, setting or purpose readings (docs/05 G6 open).
