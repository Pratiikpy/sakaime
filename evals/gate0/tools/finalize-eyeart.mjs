// Merges the first pass (eyeart-case-manifest.pass1.json) and the second pass (eyeart-second-pass.json) with the
// hand-written chain, discrepancy list and demo question, then writes eyeart-case-manifest.json and EYEART-CHAIN.md.
// Run after build-eyeart-manifest.mjs and second-pass-eyeart.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate0Root } from "./lib.mjs";

const p1 = JSON.parse(readFileSync(join(gate0Root, "eyeart-case-manifest.pass1.json"), "utf8"));
const p2 = JSON.parse(readFileSync(join(gate0Root, "eyeart-second-pass.json"), "utf8"));
if (p1.problems.length) throw new Error("first pass has problems: " + p1.problems.join("; "));
if (p2.disagreements.length) throw new Error("second pass disagrees: " + JSON.stringify(p2.disagreements.map((d) => d.id)));
const byId = Object.fromEntries(p1.facts.map((f) => [f.id, f]));
const short = (s, n = 170) => (s.length > n ? s.slice(0, n - 1) + "..." : s);

const hops = [
  { hop: 1, from: "FDA AI-enabled device list row", to: "openFDA 510(k) record", identifier: "K200667", relationship: "SAME_SUBMISSION", state: "CONFIRMED", why: "The list row's Submission Number equals openFDA k_number; device name EyeArt and applicant Eyenuk, Inc. agree (spelling 'Eyenuk, Inc' versus 'Eyenuk, Inc.').", facts: ["H1.row", "H2.k", "H2.name", "H2.applicant", "H2.decision", "H2.received", "H2.code", "H2.type", "H2.summary_flag"], absent: ["H2.no_indication"] },
  { hop: 2, from: "openFDA 510(k) record", to: "GUDID record (version label)", identifier: "K200667 in premarket_submissions", relationship: "SAME_MARKETED_VERSION", state: "CONFIRMED (label only)", why: "The single GUDID record for submission K200667 carries version_or_model_number 2.1.0, brand EyeArt, company Eyenuk, Inc. GUDID states a marketed version label; it does not state which build a study used.", facts: ["H3.submission", "H3.version", "H3.brand", "H3.company", "H3.dates", "H3.count"] },
  { hop: 3, from: "openFDA 510(k) record", to: "FDA 510(k) summary PDF", identifier: "K200667 (printed 'Re: K200667')", relationship: "SAME_SUBMISSION", state: "CONFIRMED", why: "PDF at accessdata cdrh_docs/pdf20/K200667.pdf; the letter names K200667, EyeArt, Eyenuk, and is dated August 3, 2020 (openFDA decision_date 2020-08-03). Source PDF sha256 matches the fixture manifest and was re-fetched.", facts: ["H4.ifu", "H4.version", "H4.hf_rev", "H4.predicate", "H4.letter_dates"], absent: ["H4.trial_ver", "H4.threshold"] },
  { hop: 4, from: "FDA 510(k) summary PDF", to: "ClinicalTrials.gov NCT03112005", identifier: "NCT03112005", relationship: "STUDY_EVALUATES", state: "CONFIRMED", why: "FDA's own text cites the registry id as the pivotal trial.", facts: ["H4.nct", "H4.n", "H4.sites", "H4.cohorts", "H4.age", "H4.ref", "H4.endpoint", "H4.ci_method"] },
  { hop: 5, from: "ClinicalTrials.gov record", to: "same record, fields read", identifier: "NCT03112005", relationship: "SAME_PRODUCT (sponsor Eyenuk, Inc.; intervention is a fundus-photography procedure, the device name EyeArt appears only in the title)", state: "CONFIRMED by identifier; product named only in titles", why: "The record's interventions are 'Color fundus photography' and 'Mydriatic Agent'; a search by intervention name would not find it.", facts: ["H5.id", "H5.enrol", "H5.start", "H5.end", "H5.status", "H5.minage", "H5.setting", "H5.location", "H5.outcome", "H5.frozen"], absent: ["H5.version", "H5.refs"] },
  { hop: 6, from: "ClinicalTrials.gov NCT03112005", to: "PubMed PMID 34779843 (JAMA Netw Open 2021)", identifier: "NCT03112005 in the abstract", relationship: "PUBLICATION_REPORTS", state: "CONFIRMED (identifier in text, one direction only)", why: "PubMed finds the paper by the NCT string as free text; the secondary-source-id field search returns 0, and the registry record lists no publication. The link exists only because the paper cites the registry id.", facts: ["H6.link_all", "H6.link_si", "H6.design", "H6.pop", "H6.age", "H6.perf", "H6.imageability", "H6.version", "H6.erratum", "H6.erratum_title"], absent: ["H6.threshold"] },
  { hop: 6.5, from: "PubMed abstract", to: "Europe PMC open-access full text (PMC8593763)", identifier: "PMID 34779843 / PMC8593763", relationship: "same article", state: "CONFIRMED", why: "Needed because the abstract does not give cameras, centre mix or the prespecified hypotheses.", facts: ["H6b.centres", "H6b.cameras", "H6b.funnel", "H6b.hypotheses"], absent: ["H6b.threshold"] },
  { hop: 7, from: "version strings in three sources", to: "FDA v2.1.0 = GUDID 2.1.0 = PubMed 'version 2.1.0'", identifier: "2.1.0", relationship: "SAME_MARKETED_VERSION", state: "CONFIRMED at string level; CANDIDATE at build level", why: "Three sources, all ultimately supplied by the sponsor and so not independent of each other, print the same release string. The FDA summary does not say which build produced the pivotal-trial numbers (it names v2.1.0 rev005 and rev006 for human-factors work), and the paper gives no build or revision. Equality of the release string is proven; identity of the exact build is NOT VERIFIED.", facts: ["H3.version", "H4.version", "H6.version"] },
  { hop: 8, from: "K200667 (v2.1.0)", to: "K223357 EyeArt v2.2.0 (decision 2023-06-16)", identifier: "K223357", relationship: "SUPERSEDES (later clearance modifies v2.1.0 to v2.2.0; no withdrawal of K200667 was checked: NOT VERIFIED)", state: "CONFIRMED (FDA text)", why: "Not part of the original chain; recorded because it makes the date and version dimensions testable and because the later indication wording is narrower.", facts: ["H1.later_row", "L1.update", "L1.ifu", "L1.dates"] },
];

const discrepancies = [
  { id: "D1", field: "date the submission was received", a: "openFDA date_received 2020-03-13", b: "FDA letter 'Received: June 30, 2020' and 'Dated: June 30, 2020'", facts: ["H2.received", "H4.letter_dates"], status: "UNEXPLAINED. The letter is dated August 3, 2020 (decision). Whether June 30 is a resubmission or additional-information date is NOT VERIFIED." },
  { id: "D2", field: "number of study sites", a: "FDA: 11 US study sites (655-subject analysis population)", b: "JAMA: 15 US centres (942 consented: 6 primary care, 6 general ophthalmology, 3 retina); registry: 1 location listed", facts: ["H4.sites", "H6.design", "H6b.centres", "H5.location"], status: "Different populations counted (655 analysed versus 942 consented), and the registry list is incomplete. A claim that says 'N sites' must say which count." },
  { id: "D3", field: "participants", a: "FDA: 942 consented, 915 eligible, 655 analysed (22 and older)", b: "JAMA: 942 consented, 915 eligible, 893 completed (1786 eyes); registry: 942", facts: ["H4.n", "H6.pop", "H6b.funnel", "H5.enrol"], status: "Different analysis populations; no conflict in the funnel's first two steps." },
  { id: "D4", field: "minimum age", a: "FDA analysis population: 22 years and older (subjects 21 or younger excluded)", b: "JAMA and registry: 18 years or older (range 18-88); FDA indication: 'adults'", facts: ["H4.age", "H6.age", "H5.minage", "H4.ifu"], status: "Real scope difference: the indicated population is 'adults', the FDA-analysed population is 22 and older, the published population starts at 18. Age 18 to 21 is evidenced by the paper but not by FDA's analysis." },
  { id: "D5", field: "study end date", a: "registry completion date 2018-05-31", b: "JAMA 'to May 30, 2018'", facts: ["H5.end", "H6.design"], status: "One-day difference; immaterial, recorded." },
  { id: "D6", field: "performance figures", a: "FDA: per-cohort eye-level results (for example primary care, enrichment permitted: mtmDR sensitivity 92.9% [87.1-97.5], specificity 85.6%)", b: "JAMA: pooled 893 patients (mtmDR sensitivity 95.5% [92.4-98.5], specificity 85.0% [82.6-87.4])", facts: ["H6.perf"], status: "Different analysis populations and weighting, not a conflict. A claim must name which result it quotes." },
  { id: "D7", field: "software version of the pivotal-trial build", a: "FDA: silent (v2.1.0 is the cleared device; rev005 and rev006 appear for human-factors work)", b: "JAMA abstract: version 2.1.0; registry: frozen build, no number", facts: ["H4.trial_ver", "H6.version", "H5.frozen"], status: "Release string agrees, build identity not stated anywhere. NOT VERIFIED beyond the string." },
  { id: "D8", field: "indication wording across versions", a: "K200667 (v2.1.0): not previously diagnosed with MORE THAN MILD diabetic retinopathy; primary care and eye care named", b: "K223357 (v2.2.0): not previously diagnosed with diabetic retinopathy; Topcon NW400 added; no setting sentence", facts: ["H4.ifu", "L1.ifu"], status: "The later indication is narrower on prior disease and silent on setting. Evidence for one version cannot be carried to the other without restating the indication." },
  { id: "D9", field: "correction to the paper", a: "PubMed lists an erratum (PMID 34935926, JAMA Netw Open 2021 Dec 1;4(12):e2144317)", b: "Erratum title: 'Error in Figure 2.'", facts: ["H6.erratum", "H6.erratum_title"], status: "What changed in Figure 2 is NOT VERIFIED (the PubMed record has no text). The abstract numbers quoted here were read from the current PubMed record, which postdates the erratum link (record revised 2026-05-18)." },
  { id: "D10", field: "registry freshness", a: "statusVerifiedDate 2018-07; no results posted", b: "paper published 2021-11", facts: ["H5.status"], status: "The registry was last verified before the results existed and has no publication link." },
];

const notGiven = [
  { field: "operating threshold, cut-off or operating point of the algorithm", status: "ABSENT in FDA summary, registry, PubMed abstract and open-access full text (only a p-value threshold appears)", facts: ["H4.threshold", "H6.threshold", "H6b.threshold"] },
  { field: "software build (revision) used in the pivotal trial", status: "ABSENT; release string only", facts: ["H4.trial_ver", "H5.version"] },
  { field: "indications text in openFDA", status: "ABSENT (openFDA has no indications or version field)", facts: ["H2.no_indication"] },
  { field: "registry link from NCT03112005 to the publication", status: "ABSENT", facts: ["H5.refs"] },
  { field: "content of the erratum to Figure 2", status: "NOT VERIFIED", facts: ["H6.erratum_title"] },
  { field: "whether K200667 has been withdrawn or is still in use", status: "NOT VERIFIED (GUDID says 'In Commercial Distribution' on the record read; no withdrawal data checked)", facts: [] },
];

const demo = {
  claimedUseQuestion: "Can our primary-care clinics use EyeArt version 2.1.0 to screen adults aged 22 or older who have diabetes and no previous diagnosis of more than mild diabetic retinopathy, and does the evidence behind the vendor's statement that sensitivity for more-than-mild diabetic retinopathy is at least 85 percent apply to that use?",
  claimedUse: { product: "device:fda:K200667", version: "2.1.0", population: { age: { min: 22 }, conditions: ["diabetes mellitus"], exclusions: ["previously diagnosed with more than mild diabetic retinopathy"] }, setting: ["primary_care"], purpose: "dr_screening_detection", date: null },
  claimedPerformance: { metric: "mtmDR_sensitivity", atLeast: 0.85 },
  resultsToTestAgainst: [
    { source: "FDA Table 2 (sequential), primary care, 90 eyes", value: "100.0% [74.1-100]", k: 11, n: 11, ciLowerAtLeast85: false, note: "tiny cohort; point estimate above 85, lower confidence bound below" },
    { source: "FDA Table 2 (sequential), ophthalmology, 380 eyes", value: "94.9% [86.4-100.0]", k: 37, n: 39, ciLowerAtLeast85: true },
    { source: "FDA Table 3 (enrichment permitted), primary care, 670 eyes", value: "92.9% [87.1-97.5]", k: 92, n: 99, ciLowerAtLeast85: true },
    { source: "FDA Table 3 (enrichment permitted), ophthalmology, 170 eyes", value: "96.6% [87.5-100.0]", k: 28, n: 29, ciLowerAtLeast85: true },
    { source: "JAMA Netw Open 2021, pooled, 893 patients", value: "95.5% [92.4-98.5]", k: null, n: null, ciLowerAtLeast85: true },
  ],
  note: "Whether the claim is judged on point estimates or on the lower confidence bound is a rule choice with no source threshold; the tiny cohort makes it matter. The date is left out of the base claim: a deployment date after 2020 triggers the staleness rule (no source threshold, REQUIRES_DOMAIN_REVIEW) and belongs in the counterfactual lab.",
  counterfactuals: [
    { change: "version 2.2.0", expected: "evidence for 2.1.0 no longer covers the claimed version; K223357 (2.2.0) is the evidence, with a narrower indication wording" },
    { change: "age floor 18", expected: "PARTIAL: FDA analysis floor is 22; the paper covers 18 and older" },
    { change: "age floor 12", expected: "PARTIAL, narrower scope 22 and older (claim EA-02)" },
    { change: "setting emergency department", expected: "DISJOINT with primary care and eye care" },
    { change: "include previously diagnosed mild DR", expected: "K200667 permits it ('more than mild'); K223357 does not (claim EA-05)" },
    { change: "date 2026-11-01", expected: "REQUIRES_DOMAIN_REVIEW: no staleness window in any source; a successor clearance exists (claim EA-03)" },
  ],
};

const manifest = {
  case: "EyeArt K200667",
  requirement: "C-11 (docs/05-requirements-matrix.md): a case enters a suite only after its chain is proven by hand with a second reader and recorded disagreements",
  label: "single builder, two passes, not independent",
  retrieved: p1.retrieved,
  verdict: "CHAIN PROVEN at identifier level for all hops; version equality proven at release-string level only; build-level identity NOT VERIFIED. Discrepancies D1 to D10 are recorded, none breaks the chain.",
  sources: p1.sources,
  hops,
  facts: p1.facts,
  tableCells: p1.tableCells,
  discrepancies,
  notGiven,
  demo,
  secondPass: { file: "eyeart-second-pass.json", method: p2.method, checks: p2.checks, agreements: p2.agreements, dataDisagreements: p2.disagreements.length, note: "During development the second-pass script reported four disagreements; all four were bugs in the checking code (a regex dropped by shell escaping, an expected-token count, and a rounding convention: FDA prints 37/80 as 46.2%, an exact half rounded down), not differences between the readings. They were fixed and the script re-run to 74 of 74. Two further regexes were found to be vacuous and were repaired; each absence check was then tested against a positive control." },
  problems: [],
};
writeFileSync(join(gate0Root, "eyeart-case-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");

// ---- markdown
const L = [];
L.push("# EyeArt chain, hand-proven (Gate 0, C-11)", "");
L.push("Retrieval date for every record: 2026-10-27. Label: **single builder, two passes, not independent**. Machine-readable twin: `eyeart-case-manifest.json`. Every quote below is checked by `tools/build-eyeart-manifest.mjs` against the raw record (whitespace-collapsed, ASCII-folded); page numbers and hashes are computed, not typed.", "");
L.push("## Verdict", "", manifest.verdict, "");
L.push("Admissible as the first authentic case for ScopeShift (B) and for the demo, with the discrepancies in section 4 shown rather than hidden. It is a clean case in the narrow sense that the identifiers chain; it is not free of ambiguity, and the ambiguity is the point of the product.", "");
L.push("## 1. Sources", "", "| id | record | sha256 | URL |", "|---|---|---|---|");
for (const [id, s] of Object.entries(p1.sources)) L.push(`| ${id} | \`${s.path}\` | \`${s.sha256.slice(0, 16)}...\` | ${s.url.length > 90 ? s.url.slice(0, 90) + "..." : s.url} |`);
L.push("", "Fixture hashes equal the rows in `research/feasibility/fixtures/MANIFEST.md` (checked). The FDA summary text is `pdftotext -layout` output; PDF page = printed summary page + 3.", "");
L.push("## 2. The chain, hop by hop", "");
for (const h of hops) {
  L.push(`### Hop ${h.hop}: ${h.from} -> ${h.to}`, "", `Identifier: \`${h.identifier}\`. Relationship: **${h.relationship}**. State: **${h.state}**.`, "", h.why, "");
  L.push("| fact | value | source | page | quote (shortened here; full in the JSON) |", "|---|---|---|---|---|");
  for (const fid of h.facts) {
    const f = byId[fid];
    const pg = f.anchor?.printedPages?.[0] ? `printed ${f.anchor.printedPages[0]} (PDF ${f.anchor.pdfPages[0]})` : "";
    L.push(`| ${f.field} | ${short(String(f.value), 120).replace(/\|/g, "/")} | ${f.source} | ${pg} | ${f.quote ? "`" + short(f.quote.replace(/\|/g, "/"), 150) + "`" : ""} |`);
  }
  for (const fid of h.absent ?? []) L.push(`| ${byId[fid].field} | ABSENT | ${byId[fid].source} | | ${byId[fid].note} |`);
  L.push("");
}
L.push("## 3. Table cells (FDA Table 2 and Table 3)", "", "Read from the page images (pdftotext interleaves the columns), then recomputed from each cell's own count. All 48 count tokens on the two pages recompute to a printed percentage within rounding (FDA prints the exact half 37/80 = 46.25 as 46.2).", "", "| table | cohort | output | metric | k/n | printed | 95% CI | PDF page |", "|---|---|---|---|---|---|---|---|");
for (const c of p1.tableCells) L.push(`| ${c.table} | ${c.cohort} | ${c.output} | ${c.metric} | ${c.k}/${c.n} | ${c.reportedPct} | ${c.ci} | ${c.pdfPage} (printed ${c.printedPage}) |`);
L.push("", "## 4. Discrepancies between sources", "", "| id | field | one side | other side | status |", "|---|---|---|---|---|");
for (const d of discrepancies) L.push(`| ${d.id} | ${d.field} | ${d.a} | ${d.b} | ${d.status.replace(/\|/g, "/")} |`);
L.push("", "## 5. What the sources do not give (absent stays absent)", "", "| field | status |", "|---|---|");
for (const n of notGiven) L.push(`| ${n.field} | ${n.status} |`);
L.push("", "## 6. Second pass", "", `${p2.checks} re-extractions from the raw records by a different method (parsed JSON and regular expressions, plus recomputation of every table count); ${p2.agreements} agree, ${p2.disagreements.length} data disagreements. ${manifest.secondPass.note}`, "", "This is one agent reading twice. It does not provide independence from the builder's misreadings of meaning (for example choosing which of two sentences states the age floor). The abstract-versus-full-text and FDA-versus-registry differences in section 4 were found by the reading itself, not by the script.", "");
L.push("## 7. The question for the demo", "", `> ${demo.claimedUseQuestion}`, "", "Structured claimed use:", "", "```json", JSON.stringify({ claimedUse: demo.claimedUse, claimedPerformance: demo.claimedPerformance }, null, 2), "```", "", "Results the claim is tested against (all from the anchored records above):", "", "| source | result | CI lower bound at least 85% |", "|---|---|---|");
for (const r of demo.resultsToTestAgainst) L.push(`| ${r.source} | ${r.value} | ${r.ciLowerAtLeast85 ? "yes" : "no"}${r.note ? " (" + r.note + ")" : ""} |`);
L.push("", demo.note, "", "Counterfactual lab, each recomputed without a model call:", "", "| change | expected relation |", "|---|---|");
for (const c of demo.counterfactuals) L.push(`| ${c.change} | ${c.expected} |`);
L.push("", "## 8. What this does not establish", "", "- It does not show that EyeArt performs as claimed in any hospital. It shows which records support which stated scope.", "- Source independence is not assessed: the sponsor ran the pivotal trial and wrote the FDA summary; several authors of the paper are Eyenuk employees (PubMed conflict-of-interest statement).", "- The registry listing of one location and the erratum to Figure 2 mean the chain's weakest links are data quality, not identity.", "- No clinician reviewed the age, setting or purpose readings (docs/05 G6 open).", "");
writeFileSync(join(gate0Root, "EYEART-CHAIN.md"), L.join("\n"));
console.log("wrote eyeart-case-manifest.json and EYEART-CHAIN.md", "lines:", L.length);
