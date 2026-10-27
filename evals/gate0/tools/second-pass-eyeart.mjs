// Second pass: re-derive every extracted EyeArt value from the raw records by a different method than the
// first pass (parsed JSON and regular expressions over the raw text, and recomputation of every table cell
// from its own counts), WITHOUT reading the first-pass quotes. Only after extraction does it compare with
// eyeart-case-manifest.pass1.json. One agent reading twice: single builder, two passes, not independent.
// Run: node tools/second-pass-eyeart.mjs  (writes ../eyeart-second-pass.json)
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate0Root, repoRoot, loadPages, squash } from "./lib.mjs";

const FX = "research/feasibility/fixtures";
const raw = (rel) => readFileSync(join(repoRoot, rel), "utf8");
const json = (rel) => JSON.parse(raw(rel));
const pagesOf = (rel) => loadPages(rel);
const all = (rel) => pagesOf(rel).join(" ");
const checks = [];
const check = (id, secondPass, firstPass) => {
  const a = JSON.stringify(secondPass);
  const b = JSON.stringify(firstPass);
  checks.push({ id, secondPass, firstPass, agree: a === b });
};

// ---- raw records
const csv = raw(`${FX}/fda/ai-enabled-devices.csv`).split(/\r?\n/);
const listRow = csv.find((l) => l.includes(",K200667,"));
const laterRow = csv.find((l) => l.includes(",K223357,"));
const o510 = json(`${FX}/openfda/510k_K200667.json`).results[0];
const gudid = json(`${FX}/openfda/udi_K200667.json`);
const fda = all(`${FX}/fda/K200667_summary_text.txt`);
const fdaPages = pagesOf(`${FX}/fda/K200667_summary_text.txt`);
const ct = json(`${FX}/ctgov/study_NCT03112005.json`);
const pmXml = raw(`${FX}/pubmed/ef_eyeart.xml`);
const pmRecord = pmXml.slice(pmXml.lastIndexOf("<PubmedArticle>", pmXml.indexOf('<PMID Version="1">34779843</PMID>')), pmXml.indexOf("</PubmedArticle>", pmXml.indexOf('<PMID Version="1">34779843</PMID>')));
const abstract = squash(
  [...pmRecord.matchAll(/<AbstractText[^>]*>([\s\S]*?)<\/AbstractText>/g)].map((m) => m[1].replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&")).join(" "),
);
const epmc = all("evals/gate0/raw/europepmc/PMC8593763_fulltext.xml");
const k2 = all("evals/gate0/raw/fda/K223357_summary_text.txt");
const o2 = json("evals/gate0/raw/openfda/510k_K223357.json").results[0];

// ---- hop 1 and 2: list row and openFDA
check("H1.row", listRow, '08/03/2020,K200667,EyeArt,"Eyenuk, Inc",Ophthalmic,PIB');
check("H1.later_row", laterRow, '06/16/2023,K223357,EyeArt v2.2.0,"Eyenuk, Inc.",Ophthalmic,PIB');
check("H2.k", o510.k_number, "K200667");
check("H2.name", o510.device_name, "EyeArt");
check("H2.applicant", o510.applicant, "Eyenuk, Inc.");
check("H2.decision", o510.decision_date, "2020-08-03");
check("H2.received", o510.date_received, "2020-03-13");
check("H2.code", o510.product_code, "PIB");
check("H2.type", `${o510.clearance_type} / ${o510.decision_description}`, "Traditional / Substantially Equivalent");
check("H2.summary_flag", o510.statement_or_summary, "Summary");
check("H2.no_indication", Object.keys(o510).filter((k) => /indic|version|study|intended/i.test(k)), []);

// ---- hop 3: GUDID
const g = gudid.results[0];
check("H3.version", g.version_or_model_number, "2.1.0");
check("H3.submission", g.premarket_submissions.map((s) => s.submission_number), ["K200667"]);
check("H3.brand", g.brand_name, "EyeArt");
check("H3.company", g.company_name, "Eyenuk, Inc.");
check("H3.dates", `${g.publish_date} / ${g.public_version_date}`, "2020-11-09 / 2022-06-10");
check("H3.count", gudid.meta.results.total, 1);

// ---- hop 4: FDA summary, by regex
const ifuStart = fda.indexOf("A. Intended Use / Indications for Use");
const ifuText = fda.slice(ifuStart, fda.indexOf("Page 1 of 21", ifuStart));
check("H4.ifu.adults", /in eyes of adults diagnosed with diabetes who have not been previously diagnosed with more than mild diabetic retinopathy/.test(ifuText), true);
check("H4.ifu.cameras", (ifuText.match(/Canon CR-2 (?:Plus )?AF/g) || []).length, 2);
check("H4.ifu.settings", /both primary care and eye care settings/.test(ifuText), true);
check("H4.version", (fda.match(/software version (v\d+\.\d+\.\d+)/) || [])[1], "v2.1.0");
check("H4.hf_rev", [...new Set([...fda.matchAll(/v2\.1\.0 (rev\d+)/g)].map((m) => m[1]))], ["rev005", "rev006"]);
const funnel = fda.match(/A total of (\d+) subjects were consented of which (\d+) subjects met study/);
check("H4.nct", (fda.match(/ClinicalTrials\.gov ID (NCT\d{8})/) || [])[1], "NCT03112005");
check("H4.funnel", [Number(funnel[1]), Number(funnel[2]), Number((fda.match(/analyses were presented on (\d+) participants/) || [])[1])], [942, 915, 655]);
check("H4.sites", Number((fda.match(/at (\d+) US study sites/) || [])[1]), 11);
check("H4.cohorts", [fda.match(/\((\d+) subjects, with (\d+) enrolled at primary care sites and (\d+) enrolled at ophthalmology sites\)/g)].flat().map((s) => s.match(/\d+/g).map(Number)), [[235, 45, 190], [420, 335, 85]]);
check("H4.age", [Number((fda.match(/persons aged (\d+) years and older/) || [])[1]), Number((fda.match(/subjects (\d+) years old or younger/) || [])[1])], [22, 21]);
check("H4.threshold_absent", /threshold|cut-?off|operating point/i.test(fda), false);
check("H4.trial_version_absent", /pivotal[^.]{0,200}v\d+\.\d+\.\d+/i.test(fda), false);
check("H4.letter_dates", [(fda.match(/Dated: ([A-Za-z]+ \d+, \d{4})/) || [])[1], (fda.match(/Received: ([A-Za-z]+ \d+, \d{4})/) || [])[1]], ["June 30, 2020", "June 30, 2020"]);
check("H4.predicate", [(fda.match(/Trade name of the device: ([\w-]+)/) || [])[1], (fda.match(/De Novo Number: (DEN\d+)/) || [])[1]], ["IDx-DR", "DEN180001"]);
check("H4.re_line", (fda.match(/Re: (K\d{6})/) || [])[1], "K200667");

// ---- every Table 2 and Table 3 cell recomputed from its own count, all 48 tokens
const tokensOk = [];
for (const p of [10, 11]) {
  const page = fdaPages[p - 1];
  const counts = [...page.matchAll(/\((\d+)\/(\d+)\)/g)].map((m) => [Number(m[1]), Number(m[2])]);
  const pcts = new Set([...page.matchAll(/(\d+\.\d)%/g)].map((m) => Number(m[1])));
  const bad = counts.filter(([k, n]) => ![...pcts].some((v) => Math.abs(v - (100 * k) / n) <= 0.0501)); // FDA rounds exact halves down (37/80 = 46.25 printed 46.2)
  tokensOk.push({ pdfPage: p, countTokens: counts.length, unmatched: bad });
}
check("H4.tables.recompute", tokensOk.map((t) => [t.pdfPage, t.countTokens, t.unmatched.length]), [[10, 24, 0], [11, 27, 0]]); // page 11 holds three extra counts from the imageability bullets

// ---- hop 5: ClinicalTrials.gov by parsed JSON
const ps = ct.protocolSection;
check("H5.id", ps.identificationModule.nctId, "NCT03112005");
check("H5.enrol", `${ps.designModule.enrollmentInfo.count} (${ps.designModule.enrollmentInfo.type.toLowerCase()})`, "942 (actual)");
check("H5.start", ps.statusModule.startDateStruct.date, "2017-04-17");
check("H5.end", ps.statusModule.completionDateStruct.date, "2018-05-31");
check("H5.status", `${ps.statusModule.overallStatus}, verified ${ps.statusModule.statusVerifiedDate}, ${ct.hasResults ? "results posted" : "no results posted"}`, "COMPLETED, verified 2018-07, no results posted");
check("H5.minage", ps.eligibilityModule.minimumAge, "18 Years");
check("H5.location", `${ps.contactsLocationsModule.locations.length} (${ps.contactsLocationsModule.locations[0].facility})`, "1 (Los Angeles Biomedical Research Institute)");
check("H5.version_absent", /\b\d+\.\d+\.\d+\b/.test(JSON.stringify(ps).replace(/\d{4}-\d{2}-\d{2}/g, "")), false);
check("H5.refs_absent", ps.referencesModule === undefined, true);

// ---- hop 6: PubMed by regex over the abstract
check("H6.link_all", json(`${FX}/pubmed/es_all_NCT03112005.json`).esearchresult.idlist, ["34779843"]);
check("H6.link_si", json(`${FX}/pubmed/es_NCT03112005.json`).esearchresult.count, "0");
check("H6.version", (abstract.match(/version (\d+\.\d+\.\d+)/) || [])[1], "2.1.0");
check("H6.design", [(abstract.match(/preregistered \((NCT\d+)\)/) || [])[1], (abstract.match(/conducted from ([A-Za-z]+ \d+, \d{4}), to ([A-Za-z]+ \d+, \d{4})/) || []).slice(1), Number((abstract.match(/A total of (\d+) individuals aged (\d+) years or older/) || [])[1]), Number((abstract.match(/aged (\d+) years or older/) || [])[1]), Number((abstract.match(/at (\d+) primary care and eye care facilities/) || [])[1])], ["NCT03112005", ["April 17, 2017", "May 30, 2018"], 942, 18, 15]);
check("H6.pop", [Number((abstract.match(/Of (\d+) consenting individuals, (\d+) patients \((\d+) eyes\)/) || [])[2]), Number((abstract.match(/Of (\d+) consenting individuals, (\d+) patients \((\d+) eyes\)/) || [])[3])], [893, 1786]);
check("H6.age", (abstract.match(/Mean \(SD\) participant age was ([\d.]+) \(([\d.]+)\) years \(median, (\d+); range, (\d+)-(\d+) years\)/) || []).slice(1).map(Number), [53.9, 15.2, 56, 18, 88]);
const perf = abstract.match(/mtmDR \(sensitivity: ([\d.]+)%; 95% CI, ([\d.]+)%-([\d.]+)% and specificity: ([\d.]+)%; 95% CI, ([\d.]+)%-([\d.]+)%\) and vtDR \(sensitivity: ([\d.]+)%; 95% CI, ([\d.]+)%-(\d+)% and specificity: ([\d.]+)%; 95% CI, ([\d.]+)%-([\d.]+)%\)/);
check("H6.perf", perf.slice(1).map(Number), [95.5, 92.4, 98.5, 85.0, 82.6, 87.4, 95.1, 90.1, 100, 89.0, 87.0, 91.1]);
check("H6.imageability", (abstract.match(/grade ([\d.]+)% \(95% CI, ([\d.]+)%-([\d.]+)%\) of the eyes/) || []).slice(1).map(Number), [87.4, 85.2, 89.6]);
check("H6.erratum", (pmRecord.match(/RefType="ErratumIn"><RefSource>([^<]+)</) || [])[1], "JAMA Netw Open. 2021 Dec 1;4(12):e2144317. doi: 10.1001/jamanetworkopen.2021.44317.");
check("H6.threshold_absent", /threshold|cut-?off|operating point/i.test(abstract), false);

// ---- hop 6b: Europe PMC full text
check("H6b.centres", (epmc.match(/primary care \((\d+)\), general ophthalmology \((\d+)\), and retina specialty \((\d+)\) centers/) || []).slice(1).map(Number), [6, 6, 3]);
check("H6b.cameras", (epmc.match(/\(Canon CR-2 AF or Canon CR-2 Plus AF; Canon USA Inc\)/) || [null])[0] !== null, true);
check("H6b.funnel", (epmc.match(/Of (\d+) consenting individuals, (\d+) participants \((\d+) eyes\) met eligibility criteria and (\d+) participants \((\d+) eyes\)/) || []).slice(1).map(Number), [942, 915, 1830, 893, 1786]);
check("H6b.hypotheses", (epmc.match(/Alternative hypotheses of ([\d.]+)% for sensitivity and ([\d.]+)% for specificity/) || []).slice(1).map(Number), [90, 82.5]);
check("H6b.threshold_absent", [...epmc.matchAll(/(.{60})(threshold|cut-?off|operating point)/gi)].map((m) => m[1]).filter((c) => !/Significance/.test(c)).length, 0);

// ---- later clearance
check("L1.ifu", /not been previously diagnosed with diabetic retinopathy\. EyeArt is indicated for use with Canon CR-2 AF, Canon CR-2 Plus AF, and Topcon NW400 cameras/.test(k2), true);
check("L1.update", /modify EyeArt \(software version 2\.1\.0\) and update it to software version 2\.2\.0/.test(k2), true);
check("L1.dates", `${o2.date_received} ${o2.decision_date}`, "2022-11-02 2023-06-16");

// ---- remaining first-pass facts, re-checked under their own ids
check("H4.n", [Number(funnel[1]), Number(funnel[2]), Number((fda.match(/analyses were presented on (\d+) participants/) || [])[1])], [942, 915, 655]);
check("H4.trial_ver", /pivotal[^.]{0,200}v\d+\.\d+\.\d+/i.test(fda), false);
check("H4.ref", /Fundus Photography Reading Center \(FPRC\) per the Early Treatment for Diabetic Retinopathy Study severity \(ETDRS\) scale on dilated 4-wide field stereo fundus imaging/.test(fda), true);
check("H4.endpoint", /primary outcomes were the sensitivity and specificity of EyeArt for detecting mtmDR and vtDR in subject eyes/.test(fda), true);
check("H4.ci_method", [/clustered bootstrap method/.test(fda), /Wilson method is used/.test(fda)], [true, true]);
check("H4.threshold", /threshold|cut-?off|operating point/i.test(fda), false);
check("H5.setting", ps.eligibilityModule.studyPopulation, "Study subjects will be enrolled at eye care practices and primary/diabetes care practices");
check("H5.outcome", /Number of subject eyes whose EyeArt results match the reading center grading for identifying referable diabetic eye disease \(moderate NPDR or higher on the ICDR scale or surrogate markers for CSME\)\./.test(ps.outcomesModule.primaryOutcomes[0].measure), true);
check("H5.frozen", /finalized and frozen before the first subject is enrolled and a copy will be placed in a version-controlled system/.test(ps.descriptionModule.detailedDescription), true);
check("H5.version", /\b\d+\.\d+\.\d+\b/.test(JSON.stringify(ps).replace(/\d{4}-\d{2}-\d{2}/g, "")), false);
check("H5.refs", ps.referencesModule === undefined, true);
check("H6.erratum_title", raw("evals/gate0/raw/pubmed/ef_34935926_erratum.xml").includes("<ArticleTitle>Error in Figure 2.</ArticleTitle>"), true);
check("H6.threshold", /threshold|cut-?off|operating point/i.test(abstract), false);
check("H6b.threshold", [...epmc.matchAll(/(.{60})(threshold|cut-?off|operating point)/gi)].map((m) => m[1]).filter((c) => !/Significance/.test(c)).length, 0);

// ---- compare with the first pass and write
const pass1 = JSON.parse(readFileSync(join(gate0Root, "eyeart-case-manifest.pass1.json"), "utf8"));
const disagreements = checks.filter((c) => !c.agree);
const uncovered = pass1.facts.filter((f) => !checks.some((c) => c.id === f.id || c.id.startsWith(f.id + "."))).map((f) => f.id);
writeFileSync(
  join(gate0Root, "eyeart-second-pass.json"),
  JSON.stringify({ label: "single builder, two passes, not independent", method: "regex and parsed-JSON re-extraction from raw records plus recomputation of every Table 2/3 cell", checks: checks.length, agreements: checks.length - disagreements.length, disagreements, firstPassFactsNotRechecked: uncovered }, null, 2) + "\n",
);
console.log(`checks ${checks.length}, agree ${checks.length - disagreements.length}, disagree ${disagreements.length}`);
for (const d of disagreements) console.log("DISAGREE", d.id, "second:", JSON.stringify(d.secondPass), "first:", JSON.stringify(d.firstPass));
console.log("first-pass facts without a second-pass check:", uncovered.join(", ") || "none");
