// First pass (builder): the EyeArt chain, hop by hop, every fact with a verbatim anchor.
// Hashes, page numbers and anchor checks are computed here, never typed. Run: node tools/build-eyeart-manifest.mjs
// Writes ../eyeart-case-manifest.json (the second pass, second-pass-eyeart.mjs, is run separately and merged in).
import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gate0Root, sha256File, locate, pageLabel, manifestHashes } from "./lib.mjs";

const FX = "research/feasibility/fixtures";
const RAW = "evals/gate0/raw";
const RETRIEVED = "2026-10-27";

const sources = {
  ai_list: { path: `${FX}/fda/ai-enabled-devices.csv`, url: "https://www.fda.gov/media/178541/download?attachment", note: "Fetched once inside a browser session; FDA page says content current as of 09/04/2026." },
  openfda_510k: { path: `${FX}/openfda/510k_K200667.json`, url: "https://api.fda.gov/device/510k.json?search=k_number:K200667" },
  gudid: { path: `${FX}/openfda/udi_K200667.json`, url: "https://api.fda.gov/device/udi.json?search=premarket_submissions.submission_number%3A%22K200667%22&limit=100" },
  fda_summary: { path: `${FX}/fda/K200667_summary_text.txt`, url: "https://www.accessdata.fda.gov/cdrh_docs/pdf20/K200667.pdf", note: "pdftotext -layout of the FDA PDF (source PDF sha256 6f6d788a59f3a66e75597af7563a7554de0d26d01b68cc7d01cfbda6be0b6219, re-fetched 2026-10-27 and matched). PDF page = summary page + 3." },
  ctgov: { path: `${FX}/ctgov/study_NCT03112005.json`, url: "https://clinicaltrials.gov/api/v2/studies/NCT03112005" },
  pubmed: { path: `${FX}/pubmed/ef_eyeart.xml`, url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34779843 (batch file holding 10 records; PMID 34779843 is the one used)" },
  pubmed_esearch_all: { path: `${FX}/pubmed/es_all_NCT03112005.json`, url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=NCT03112005" },
  pubmed_esearch_si: { path: `${FX}/pubmed/es_NCT03112005.json`, url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=%22NCT03112005%22%5Bsi%5D" },
  epmc_fulltext: { path: `${RAW}/europepmc/PMC8593763_fulltext.xml`, url: "https://www.ebi.ac.uk/europepmc/webservices/rest/PMC8593763/fullTextXML", note: "Open access, CC BY-NC-ND 4.0 (stated in the record)." },
  erratum: { path: `${RAW}/pubmed/ef_34935926_erratum.xml`, url: "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi?db=pubmed&id=34935926" },
  k223357_summary: { path: `${RAW}/fda/K223357_summary_text.txt`, url: "https://www.accessdata.fda.gov/cdrh_docs/pdf22/K223357.pdf", note: "pdftotext -layout; source PDF sha256 ae03ea60fb5a642f944dc08f51946d564979be0a325a207059079aec8b44d604 (PDF not kept, 544 KB)." },
  k223357_openfda: { path: `${RAW}/openfda/510k_K223357.json`, url: "https://api.fda.gov/device/510k.json?search=k_number:K223357" },
};

/** kind: stated (source says it), absent (searched, source does not say it), differs (sources disagree). */
const facts = [
  // ---- hop 1: FDA AI-enabled device list row
  { id: "H1.row", hop: 1, field: "list row", value: "08/03/2020,K200667,EyeArt,\"Eyenuk, Inc\",Ophthalmic,PIB", kind: "stated", source: "ai_list", quote: "08/03/2020,K200667,EyeArt,\"Eyenuk, Inc\",Ophthalmic,PIB" },
  { id: "H1.later_row", hop: 1, field: "later EyeArt row on the same list", value: "06/16/2023,K223357,EyeArt v2.2.0,\"Eyenuk, Inc.\",Ophthalmic,PIB", kind: "stated", source: "ai_list", quote: "06/16/2023,K223357,EyeArt v2.2.0,\"Eyenuk, Inc.\",Ophthalmic,PIB" },
  // ---- hop 2: openFDA 510(k)
  { id: "H2.k", hop: 2, field: "k_number", value: "K200667", kind: "stated", source: "openfda_510k", quote: "\"k_number\":\"K200667\"" },
  { id: "H2.name", hop: 2, field: "device_name", value: "EyeArt", kind: "stated", source: "openfda_510k", quote: "\"device_name\":\"EyeArt\"" },
  { id: "H2.applicant", hop: 2, field: "applicant", value: "Eyenuk, Inc.", kind: "stated", source: "openfda_510k", quote: "\"applicant\":\"Eyenuk, Inc.\"" },
  { id: "H2.decision", hop: 2, field: "decision_date", value: "2020-08-03", kind: "stated", source: "openfda_510k", quote: "\"decision_date\":\"2020-08-03\"" },
  { id: "H2.received", hop: 2, field: "date_received", value: "2020-03-13", kind: "stated", source: "openfda_510k", quote: "\"date_received\":\"2020-03-13\"" },
  { id: "H2.code", hop: 2, field: "product_code", value: "PIB", kind: "stated", source: "openfda_510k", quote: "\"product_code\":\"PIB\"" },
  { id: "H2.type", hop: 2, field: "clearance_type / decision", value: "Traditional / Substantially Equivalent", kind: "stated", source: "openfda_510k", quote: "\"decision_description\":\"Substantially Equivalent\"" },
  { id: "H2.summary_flag", hop: 2, field: "statement_or_summary", value: "Summary", kind: "stated", source: "openfda_510k", quote: "\"statement_or_summary\":\"Summary\"" },
  { id: "H2.no_indication", hop: 2, field: "indications text in openFDA", value: null, kind: "absent", source: "openfda_510k", note: "The openFDA 510(k) record has no indications, software version or study field (checked: field names in the record)." },
  // ---- hop 3: GUDID version
  { id: "H3.version", hop: 3, field: "version_or_model_number", value: "2.1.0", kind: "stated", source: "gudid", quote: "\"version_or_model_number\":\"2.1.0\"" },
  { id: "H3.submission", hop: 3, field: "premarket_submissions.submission_number", value: "K200667", kind: "stated", source: "gudid", quote: "\"submission_number\":\"K200667\"" },
  { id: "H3.brand", hop: 3, field: "brand_name", value: "EyeArt", kind: "stated", source: "gudid", quote: "\"brand_name\":\"EyeArt\"" },
  { id: "H3.company", hop: 3, field: "company_name", value: "Eyenuk, Inc.", kind: "stated", source: "gudid", quote: "\"company_name\":\"Eyenuk, Inc.\"" },
  { id: "H3.dates", hop: 3, field: "publish_date / public_version_date", value: "2020-11-09 / 2022-06-10", kind: "stated", source: "gudid", quote: "\"public_version_date\":\"2022-06-10\"" },
  { id: "H3.count", hop: 3, field: "GUDID records for K200667", value: 1, kind: "stated", source: "gudid", quote: "\"total\":1" },
  // ---- hop 4: FDA 510(k) summary
  { id: "H4.ifu", hop: 4, field: "indications for use", value: "Automatic detection of more than mild DR and vision-threatening DR in eyes of adults diagnosed with diabetes who have not been previously diagnosed with more than mild DR; use with Canon CR-2 AF and Canon CR-2 Plus AF cameras in primary care and eye care settings.", kind: "stated", source: "fda_summary", quote: "EyeArt is indicated for use by healthcare providers to automatically detect more than mild diabetic retinopathy and vision-threatening diabetic retinopathy [...] in eyes of adults diagnosed with diabetes who have not been previously diagnosed with more than mild diabetic retinopathy. EyeArt is indicated for use with Canon CR-2 AF and Canon CR-2 Plus AF cameras in both primary care and eye care settings." },
  { id: "H4.version", hop: 4, field: "software version of the cleared device", value: "v2.1.0", kind: "stated", source: "fda_summary", quote: "EyeArt (software version v2.1.0) was identified as having a major level of concern" },
  { id: "H4.hf_rev", hop: 4, field: "human-factors build", value: "v2.1.0 rev005 validated; rev006 assessed as not adding critical tasks", kind: "stated", source: "fda_summary", quote: "a validation study using EyeArt v2.1.0 rev005" },
  { id: "H4.trial_ver", hop: 4, field: "software version used in the pivotal trial", value: null, kind: "absent", source: "fda_summary", note: "The summary names v2.1.0 for the cleared device and for human-factors builds; it does not say which build produced the pivotal-trial results. The link to v2.1.0 for the trial comes from the PubMed record (hop 6), not from FDA." },
  { id: "H4.nct", hop: 4, field: "trial cited by FDA", value: "NCT03112005", kind: "stated", source: "fda_summary", quote: "EyeArt was validated in a prospective, multi-center pivotal clinical trial (ClinicalTrials.gov ID NCT03112005). A total of 942 subjects were consented of which 915 subjects met study" },
  { id: "H4.n", hop: 4, field: "enrolment funnel (FDA)", value: "942 consented; 915 met eligibility; 655 in the analysis population", kind: "stated", source: "fda_summary", quote: "analyses were presented on 655 participants after excluding subjects who did not meet certain additional prespecified criteria (e.g., subjects 21 years old or younger)" },
  { id: "H4.sites", hop: 4, field: "sites (FDA, analysis population)", value: "11 US study sites (primary care centers and general ophthalmology centers)", kind: "stated", source: "fda_summary", quote: "The 655 participants were enrolled in the study at 11 US study sites that included primary care centers and general ophthalmology centers." },
  { id: "H4.cohorts", hop: 4, field: "cohorts", value: "sequential 235 (45 primary care, 190 ophthalmology); enrichment-permitted 420 (335 primary care, 85 ophthalmology)", kind: "stated", source: "fda_summary", quote: "(235 subjects, with 45 enrolled at primary care sites and 190 enrolled at ophthalmology sites)" },
  { id: "H4.age", hop: 4, field: "target population age (FDA analysis)", value: "22 years and older", kind: "stated", source: "fda_summary", quote: "The target population of the EyeArt pivotal clinical trial analysis was asymptomatic persons aged 22 years and older who were diagnosed with diabetes and not diagnosed with more than mild diabetic retinopathy." },
  { id: "H4.ref", hop: 4, field: "reference standard", value: "Fundus Photography Reading Center grading, ETDRS scale, dilated 4-wide field stereo fundus imaging", kind: "stated", source: "fda_summary", quote: "reference standard determined by experienced and certified graders at the Fundus Photography Reading Center (FPRC)" },
  { id: "H4.endpoint", hop: 4, field: "primary outcomes", value: "sensitivity and specificity for mtmDR and vtDR, per eye", kind: "stated", source: "fda_summary", quote: "The primary outcomes were the sensitivity and specificity of EyeArt for detecting mtmDR and vtDR in subject eyes." },
  { id: "H4.ci_method", hop: 4, field: "confidence interval method", value: "clustered bootstrap; Wilson where the proportion is 100%", kind: "stated", source: "fda_summary", quote: "All the 95% confidence intervals (CIs) are computed using the clustered bootstrap method" },
  { id: "H4.threshold", hop: 4, field: "operating threshold or cut-off", value: null, kind: "absent", source: "fda_summary", note: "No threshold, cut-off or operating point is stated in the summary (second pass searched for threshold, cut-off, cutoff, operating point and found none)." },
  { id: "H4.letter_dates", hop: 4, field: "dates printed on the FDA letter", value: "Dated June 30, 2020; Received June 30, 2020; decision letter August 3, 2020", kind: "stated", source: "fda_summary", quote: "Dated: June 30, 2020 Received: June 30, 2020" },
  { id: "H4.predicate", hop: 4, field: "predicate", value: "IDx-DR, De Novo DEN180001", kind: "stated", source: "fda_summary", quote: "Trade name of the device: IDx-DR" },
  // ---- hop 5: ClinicalTrials.gov
  { id: "H5.id", hop: 5, field: "nctId", value: "NCT03112005", kind: "stated", source: "ctgov", quote: "\"nctId\":\"NCT03112005\"" },
  { id: "H5.enrol", hop: 5, field: "enrollment", value: "942 (actual)", kind: "stated", source: "ctgov", quote: "\"enrollmentInfo\":{\"count\":942,\"type\":\"ACTUAL\"}" },
  { id: "H5.start", hop: 5, field: "start date", value: "2017-04-17", kind: "stated", source: "ctgov", quote: "\"startDateStruct\":{\"date\":\"2017-04-17\",\"type\":\"ACTUAL\"}" },
  { id: "H5.end", hop: 5, field: "completion date", value: "2018-05-31", kind: "stated", source: "ctgov", quote: "\"completionDateStruct\":{\"date\":\"2018-05-31\",\"type\":\"ACTUAL\"}" },
  { id: "H5.status", hop: 5, field: "status / last verified", value: "COMPLETED, verified 2018-07, no results posted", kind: "stated", source: "ctgov", quote: "\"statusVerifiedDate\":\"2018-07\"" },
  { id: "H5.minage", hop: 5, field: "minimum age", value: "18 Years", kind: "stated", source: "ctgov", quote: "\"minimumAge\":\"18 Years\"" },
  { id: "H5.setting", hop: 5, field: "study population / setting", value: "Study subjects will be enrolled at eye care practices and primary/diabetes care practices", kind: "stated", source: "ctgov", quote: "\"studyPopulation\":\"Study subjects will be enrolled at eye care practices and primary/diabetes care practices\"" },
  { id: "H5.location", hop: 5, field: "listed locations", value: "1 (Los Angeles Biomedical Research Institute)", kind: "stated", source: "ctgov", quote: "\"facility\":\"Los Angeles Biomedical Research Institute\"" },
  { id: "H5.outcome", hop: 5, field: "primary outcome 1", value: "EyeArt results match reading center grading for referable diabetic eye disease (moderate NPDR or higher on ICDR, or surrogate markers for CSME); sensitivity and specificity; 1 visit", kind: "stated", source: "ctgov", quote: "Number of subject eyes whose EyeArt results match the reading center grading for identifying referable diabetic eye disease (moderate NPDR or higher on the ICDR scale or surrogate markers for CSME)." },
  { id: "H5.frozen", hop: 5, field: "software freeze statement", value: "device frozen before first enrolment, copy kept in a version-controlled system; no version number given", kind: "stated", source: "ctgov", quote: "The EyeArt device will be finalized and frozen before the first subject is enrolled and a copy will be placed in a version-controlled system." },
  { id: "H5.version", hop: 5, field: "software version in the registry record", value: null, kind: "absent", source: "ctgov", note: "No version string in the registry record." },
  { id: "H5.refs", hop: 5, field: "registry-side publication links (referencesModule)", value: null, kind: "absent", source: "ctgov", note: "The record has no referencesModule; the registry does not link the paper. The link exists only because the paper cites the NCT number." },
  // ---- hop 6: PubMed
  { id: "H6.link_all", hop: 6, field: "PubMed search NCT03112005 [All Fields]", value: "PMID 34779843", kind: "stated", source: "pubmed_esearch_all", quote: "\"idlist\":[\"34779843\"]" },
  { id: "H6.link_si", hop: 6, field: "PubMed secondary-source-id search NCT03112005[si]", value: "0 hits", kind: "stated", source: "pubmed_esearch_si", quote: "\"count\":\"0\"" },
  { id: "H6.version", hop: 6, field: "version in the abstract", value: "version 2.1.0", kind: "stated", source: "pubmed", quote: "To evaluate the safety and accuracy of an artificial intelligence (AI) system (the EyeArt Automated DR Detection System, version 2.1.0) in detecting both more-than-mild diabetic retinopathy (mtmDR) and vision-threatening diabetic retinopathy (vtDR)." },
  { id: "H6.design", hop: 6, field: "design, dates, sites, age", value: "prospective multicenter cross-sectional diagnostic study, 2017-04-17 to 2018-05-30, 942 consented aged 18 or older with diabetes, 15 primary care and eye care facilities", kind: "stated", source: "pubmed", quote: "A prospective multicenter cross-sectional diagnostic study was preregistered (NCT03112005) and conducted from April 17, 2017, to May 30, 2018. A total of 942 individuals aged 18 years or older who had diabetes gave consent to participate at 15 primary care and eye care facilities." },
  { id: "H6.pop", hop: 6, field: "analysed population and age", value: "893 patients (1786 eyes); mean age 53.9 (SD 15.2), median 56, range 18-88", kind: "stated", source: "pubmed", quote: "Of 942 consenting individuals, 893 patients (1786 eyes) met the inclusion criteria and completed the study protocol." },
  { id: "H6.age", hop: 6, field: "age distribution", value: "mean 53.9 (SD 15.2); median 56; range 18-88", kind: "stated", source: "pubmed", quote: "Mean (SD) participant age was 53.9 (15.2) years (median, 56; range, 18-88 years)" },
  { id: "H6.perf", hop: 6, field: "primary performance, without dilation", value: "mtmDR sensitivity 95.5% (95% CI 92.4-98.5), specificity 85.0% (82.6-87.4); vtDR sensitivity 95.1% (90.1-100), specificity 89.0% (87.0-91.1)", kind: "stated", source: "pubmed", quote: "Sensitivity and specificity of the AI system were high in detecting mtmDR (sensitivity: 95.5%; 95% CI, 92.4%-98.5% and specificity: 85.0%; 95% CI, 82.6%-87.4%) and vtDR (sensitivity: 95.1%; 95% CI, 90.1%-100% and specificity: 89.0%; 95% CI, 87.0%-91.1%) without dilation." },
  { id: "H6.imageability", hop: 6, field: "imageability without dilation", value: "87.4% (95% CI 85.2-89.6)", kind: "stated", source: "pubmed", quote: "the AI system able to grade 87.4% (95% CI, 85.2%-89.6%) of the eyes with reading center grades" },
  { id: "H6.erratum", hop: 6, field: "correction notice", value: "ErratumIn: JAMA Netw Open 2021 Dec 1;4(12):e2144317 (PMID 34935926), titled \"Error in Figure 2\"; what changed is NOT VERIFIED", kind: "stated", source: "pubmed", quote: "JAMA Netw Open. 2021 Dec 1;4(12):e2144317. doi: 10.1001/jamanetworkopen.2021.44317." },
  { id: "H6.erratum_title", hop: 6, field: "erratum title", value: "Error in Figure 2.", kind: "stated", source: "erratum", quote: "Error in Figure 2." },
  { id: "H6.threshold", hop: 6, field: "operating threshold in the abstract", value: null, kind: "absent", source: "pubmed", note: "Not stated in the abstract." },
  // ---- hop 6b: open-access full text (the abstract is insufficient for cameras, centre mix and hypotheses)
  { id: "H6b.centres", hop: 6, field: "centre mix (full text)", value: "15 US centres: 6 primary care, 6 general ophthalmology, 3 retina specialty", kind: "stated", source: "epmc_fulltext", quote: "Fifteen US study centers participated, including primary care (6), general ophthalmology (6), and retina specialty (3) centers." },
  { id: "H6b.cameras", hop: 6, field: "cameras (full text)", value: "Canon CR-2 AF or Canon CR-2 Plus AF", kind: "stated", source: "epmc_fulltext", quote: "(Canon CR-2 AF or Canon CR-2 Plus AF; Canon USA Inc)" },
  { id: "H6b.funnel", hop: 6, field: "enrolment funnel (full text)", value: "942 consented; 915 met eligibility (1830 eyes); 893 completed (1786 eyes)", kind: "stated", source: "epmc_fulltext", quote: "Of 942 consenting individuals, 915 participants (1830 eyes) met eligibility criteria and 893 participants (1786 eyes) (intent-to-screen) completed the study according to protocol" },
  { id: "H6b.hypotheses", hop: 6, field: "prespecified hypotheses (full text)", value: "null: sensitivity at most 80%, specificity at most 77.5%; alternative: 90.0% and 82.5%", kind: "stated", source: "epmc_fulltext", quote: "Alternative hypotheses of 90.0% for sensitivity and 82.5% for specificity were established." },
  { id: "H6b.threshold", hop: 6, field: "operating threshold (full text)", value: null, kind: "absent", source: "epmc_fulltext", note: "The full text reports a binary output per eye; no numeric threshold or cut-off for the algorithm score is stated (second pass searched threshold, cut-off, cutoff, operating point; the only 'threshold' hit is the p-value threshold)." },
  // ---- later clearance (superseding version) used for the date and version cases
  { id: "L1.ifu", hop: 7, field: "K223357 (v2.2.0) indications", value: "adults with diabetes who have not been previously diagnosed with diabetic retinopathy; Canon CR-2 AF, Canon CR-2 Plus AF and Topcon NW400; no primary-care/eye-care setting sentence", kind: "stated", source: "k223357_summary", quote: "who have not been previously diagnosed with diabetic retinopathy. EyeArt is indicated for use with Canon CR-2 AF, Canon CR-2 Plus AF, and Topcon NW400 cameras." },
  { id: "L1.update", hop: 7, field: "relationship to v2.1.0", value: "510(k) to modify EyeArt (software version 2.1.0) and update it to 2.2.0", kind: "stated", source: "k223357_summary", quote: "The purpose of this 510(k) notification is to modify EyeArt (software version 2.1.0) and update it to" },
  { id: "L1.dates", hop: 7, field: "K223357 dates", value: "received 2022-11-02, decision 2023-06-16", kind: "stated", source: "k223357_openfda", quote: "\"decision_date\":\"2023-06-16\"" },
];

/** Table cells read from the Table 2 and Table 3 page images and recomputed from their counts. */
const tableCells = [];
const addCells = (table, pdfPage, cohort, output, rows) => {
  for (const [metric, k, n, reported, ci] of rows) tableCells.push({ table, pdfPage, cohort, output, metric, k, n, reportedPct: reported, ci });
};
addCells("Table 2 (sequential enrolment)", 10, "primary care, 90 eyes", "mtmDR", [["sensitivity", 11, 11, "100.0%", "[74.1% - 100%]"], ["specificity", 69, 75, "92.0%", "[85.1% - 97.5%]"]]);
addCells("Table 2 (sequential enrolment)", 10, "ophthalmology, 380 eyes", "mtmDR", [["sensitivity", 37, 39, "94.9%", "[86.4% - 100.0%]"], ["specificity", 281, 324, "86.7%", "[82.1% - 90.7%]"]]);
addCells("Table 2 (sequential enrolment)", 10, "primary care, 90 eyes", "vtDR", [["sensitivity", 4, 4, "100.0%", "[51.0% - 100%]"], ["specificity", 77, 79, "97.5%", "[93.4% - 100.0%]"]]);
addCells("Table 2 (sequential enrolment)", 10, "ophthalmology, 380 eyes", "vtDR", [["sensitivity", 8, 9, "88.9%", "NA"], ["specificity", 331, 353, "93.8%", "[90.4% - 96.6%]"]]);
addCells("Table 3 (enrichment permitted)", 11, "primary care, 670 eyes", "mtmDR", [["sensitivity", 92, 99, "92.9%", "[87.1% - 97.5%]"], ["specificity", 457, 534, "85.6%", "[82.2% - 89.1%]"]]);
addCells("Table 3 (enrichment permitted)", 11, "ophthalmology, 170 eyes", "mtmDR", [["sensitivity", 28, 29, "96.6%", "[87.5% - 100.0%]"], ["specificity", 115, 135, "85.2%", "[78.1% - 91.5%]"]]);
addCells("Table 3 (enrichment permitted)", 11, "primary care, 670 eyes", "vtDR", [["sensitivity", 22, 24, "91.7%", "[80.0% - 100.0%]"], ["specificity", 553, 600, "92.2%", "[89.6% - 94.6%]"]]);
addCells("Table 3 (enrichment permitted)", 11, "ophthalmology, 170 eyes", "vtDR", [["sensitivity", 4, 4, "100.0%", "[51.0% - 100%]"], ["specificity", 141, 157, "89.8%", "[83.9% - 95.4%]"]]);

// ---- build and check
const hashes = manifestHashes();
const out = { generatedFor: "Gate 0, C-11", builtFrom: "evals/gate0/tools/build-eyeart-manifest.mjs", retrieved: RETRIEVED, label: "single builder, two passes, not independent", sources: {}, facts: [], tableCells: [], problems: [] };

for (const [id, s] of Object.entries(sources)) {
  if (!existsSync(join(gate0Root, "..", "..", s.path))) { out.problems.push(`missing source file ${s.path}`); continue; }
  const sha256 = sha256File(s.path);
  const fixtureKey = s.path.startsWith(FX + "/") ? s.path.slice(FX.length + 1) : null;
  const expected = fixtureKey ? hashes.get(fixtureKey) : undefined;
  out.sources[id] = { path: s.path, url: s.url, sha256, retrieved: RETRIEVED, ...(s.note ? { note: s.note } : {}), ...(fixtureKey ? { manifestSha256Matches: expected === sha256 } : {}) };
  if (fixtureKey && expected !== sha256) out.problems.push(`${s.path}: sha256 differs from fixtures MANIFEST.md (${expected})`);
}

for (const f of facts) {
  const rec = { ...f };
  if (f.quote) {
    const src = sources[f.source].path;
    const pages = locate(src, f.quote);
    if (pages.length === 0) out.problems.push(`${f.id}: quote not found in ${src}`);
    rec.anchor = { pdfPages: src.endsWith(".txt") ? pages : undefined, printedPages: src.endsWith(".txt") ? pages.map((p) => pageLabel(src, p)) : undefined, occurrences: pages.length };
  }
  out.facts.push(rec);
}

for (const c of tableCells) {
  const src = sources.fda_summary.path;
  const recomputed = Math.round((1000 * c.k) / c.n) / 10;
  const rep = Number(c.reportedPct.replace("%", ""));
  const countHit = locate(src, `(${c.k}/${c.n})`).includes(c.pdfPage);
  const pctHit = locate(src, c.reportedPct).includes(c.pdfPage);
  const ciHit = c.ci === "NA" ? locate(src, "NA").includes(c.pdfPage) : locate(src, c.ci).includes(c.pdfPage);
  if (recomputed !== rep) out.problems.push(`table cell ${c.cohort} ${c.output} ${c.metric}: ${c.k}/${c.n} recomputes to ${recomputed}, reported ${rep}`);
  if (!countHit || !pctHit || !ciHit) out.problems.push(`table cell ${c.cohort} ${c.output} ${c.metric}: token missing on pdf page ${c.pdfPage} (count ${countHit}, pct ${pctHit}, ci ${ciHit})`);
  out.tableCells.push({ ...c, recomputedPct: recomputed, printedPage: pageLabel(src, c.pdfPage), tokensFoundOnPage: countHit && pctHit && ciHit, readFrom: "page image (rendered at 80 dpi) because pdftotext interleaves the table columns" });
}

writeFileSync(join(gate0Root, "eyeart-case-manifest.pass1.json"), JSON.stringify(out, null, 2) + "\n");
console.log(`facts ${out.facts.length}, table cells ${out.tableCells.length}, problems ${out.problems.length}`);
for (const p of out.problems) console.log("PROBLEM:", p);
