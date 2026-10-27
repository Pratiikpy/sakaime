# Sakaime competitor teardown

Date read: 2026-10-27. Method: WebFetch (a small model summarises each page, so quoted wording is only as exact as that extraction returned it), curl and the GitHub API, plus WebSearch snippets. Two first-hand probes: a live call to Constat's free MCP endpoint, and the full JSON of the HealthIT.com evidence API.

Cell legend:
- YES = observed.
- PARTIAL = some of it, with a limit stated in the notes.
- NO = affirmatively absent in something I read, such as a schema, a tool list or a page that scopes it out.
- NOT VERIFIED = not described on the pages I could read. Silence is not treated as absence.

Capabilities:
- C1 = auto discovery and joining of FDA/openFDA, ClinicalTrials.gov and PubMed.
- C2 = device-to-study identity resolution with ambiguity handling.
- C3 = vendor claim checked against population, version, setting and intended-use scope.
- C4 = evidence tracked over time, with conclusions invalidated when sources change.
- C5 = exportable audit trail.

## 1. Matrix

| Competitor | C1 join | C2 identity | C3 claim vs scope | C4 over time | C5 audit export |
|---|---|---|---|---|---|
| HealthIT.com Evidence Explorer | NO (curated rows, not auto-joined) [A] | NO (product slug only) [A] | NO (schema has no scope fields) [A] | PARTIAL (pinned snapshot, freshness labels; "later reviews do not update") [B] | PARTIAL (JSON API, snapshot sha256, claim ids) [A] |
| Constat (Health AI), not on your list | PARTIAL (FDA 510(k), AI list, openFDA recalls, MAUDE, CMS; no CT.gov or PubMed seen) [C] | PARTIAL (K/DEN number, product code, predicate edges; no study identity) [C] | NO (extracts fields, never compares a claim) [C] | PARTIAL (weekly refresh, watchlist_diff; tracks FDA signals, not claim validity) [C][D] | PARTIAL (source quotes and page numbers; licensed exports are paid) [C][D] |
| AI TrustMark | NOT VERIFIED [E] | NOT VERIFIED [E] | PARTIAL ("named scope" checked against evidence; version, population and use not stated) [E] | NOT VERIFIED [E] | PARTIAL (public verification records and certificates) [E] |
| CHAI (registry, Applied Model Card, guidance) | NO (vendor-authored cards) [F] | NO [F] | NO (card documents intended use; nothing checks it) [F] | NOT VERIFIED [F] | PARTIAL (open schema repo; card is a document) [F] |
| Credo AI | NOT VERIFIED (FDA, PubMed not mentioned) [G] | NOT VERIFIED [G] | NOT VERIFIED [G] | PARTIAL (monitoring of customer's own AI) [G] | YES (audit trails, evidence recording) [G] |
| ModelOp | NOT VERIFIED [H] | NOT VERIFIED [H] | NOT VERIFIED [H] | NOT VERIFIED [H] | PARTIAL ("audit-ready evidence", no detail) [H] |
| HAIP vendor disclosure framework | NO (static form) [I] | NO [I] | NO (vendor self-reports; domain 1 "Intended Use") [I] | NO (domain 5 assigns vendor duties; no tracker) [I] | PARTIAL (Excel form) [I] |
| Mira Network | NOT VERIFIED [J] | NOT VERIFIED [J] | NO (generic factual claims by LLM consensus) [J] | NOT VERIFIED [J] | PARTIAL (signed certificate, secondary sources) [J] |
| Scite | PARTIAL (literature plus clinical trials; no FDA) [K] | NO (page: no medical or device features) [K] | PARTIAL (supported/contradicted by later papers; about truth, not scope) [K] | NOT VERIFIED (Collections "monitor papers") [K] | NOT VERIFIED [K] |
| Consensus | PARTIAL (400M papers; no FDA or CT.gov) [L] | NO [L] | NO (Consensus Meter on yes/no questions) [L] | NOT VERIFIED [L] | PARTIAL (RIS, BibTeX, CSV citation export) [L] |
| Elicit | PARTIAL (138M papers; CT.gov not mentioned) [M] | NO [M] | NO (data extraction from papers) [M] | NOT VERIFIED (alerts not mentioned) [M] | NOT VERIFIED [M] |
| FDA AI-enabled device list | NO (FDA only) [N] | PARTIAL (submission number, product code; "not a comprehensive resource") [N] | NO [N] | PARTIAL ("updated periodically", no date stamp) [N] | PARTIAL (CSV, Excel, XML of the list) [N] |
| FDA AI Search (Dana-Farber) | NO (FDA only) [O] | NO [O] | NO [O] | PARTIAL (update script; paper used July 2025 data) [O] | NOT VERIFIED [O] |
| Innolitics 510(k) Explorer | NO (FDA only) [P] | PARTIAL (K/PMA numbers, predicate fields) [P] | NO (extracts intended use, does not test claims) [P] | PARTIAL (saved alerts, guidance digests) [P] | YES (Excel, PDF, agent token) [P] |
| Paragon AI-device viewer | PARTIAL (FDA list, openFDA class, recalls) [Q] | PARTIAL (102 authorisations linked to recalls by FDA identifiers) [Q] | NO [Q] | PARTIAL (dated snapshots) [Q] | YES (CSV) [Q] |
| ACR AI Central | NOT VERIFIED (product pages did not render) [R] | NOT VERIFIED [R] | NOT VERIFIED [R] | NOT VERIFIED [R] | NOT VERIFIED [R] |
| Epic seismometer (open source) | NO (local data only) [S] | NO [S] | NO [S] | PARTIAL (post-deployment monitoring) [S] | NOT VERIFIED [S] |
| Censinet RiskOps AI | NOT VERIFIED [T] | NOT VERIFIED [T] | NOT VERIFIED (page: no external clinical evidence check described) [T] | PARTIAL (AI telemetry flags products that add AI) [T] | PARTIAL ("defensible documentation") [T] |

Not matrixed, covered in section 5: Epic/Microsoft/Google governance features (NOT VERIFIED, nothing found), Vizient (no AI evidence service found), "Bluebook" (could not identify what it refers to), ECRI (analyst-delivered, member content), Mayo Platform_Validate, Joint Commission certification, OVERT, iatroX, AimwellBio.

Sources:
- [A] https://healthit.com/evidence ; https://www.healthit.com/api/v1/evidence (full JSON read; claim keys are claim, claim_category, claim_id, claim_version, confirmed, product_name, product_slug, retrieved_at, reviewer, source_date, source_type, source_url, verification_status, workflow)
- [B] https://healthit.com/coverage ; https://healthit.com/methodology
- [C] https://constat.dev ; https://constat.dev/api/mcp (live call, DEN170073)
- [D] https://constat.dev/pricing
- [E] https://ai-trustmark.org
- [F] https://www.chai.org ; https://registry.chai.org ; https://registry.chai.org/applied-model-card
- [G] https://www.credo.ai ; https://www.credo.ai/industry/healthcare
- [H] https://www.modelop.com
- [I] https://healthaipartnership.org/haip-ai-vendor-disclosure-framework
- [J] https://docs.mira.network ; GitHub API for Aroha-Labs
- [K] https://scite.ai
- [L] https://consensus.app
- [M] https://elicit.com/pricing
- [N] https://www.fda.gov/medical-devices/artificial-intelligence-enabled-medical-devices/list-artificial-intelligence-enabled-medical-devices
- [O] https://arxiv.org/abs/2602.00006 ; https://github.com/lotterlab/fda_ai_search
- [P] https://fda.innolitics.com/
- [Q] https://paragoninstitute.org/ai-tools/ai-medical-devices/
- [R] https://aicentral.org/ ; snippets from radiologybusiness.com and acr.org
- [S] https://github.com/epic-open-source/seismometer
- [T] https://censinet.com/capabilities/artificial-intelligence-governance

## 2. Per-competitor summaries

Each entry gives the claim in the vendor's words, the price, and what the reviewer still does by hand.

**HealthIT.com Evidence Explorer (healthit.com)**
- Quote: "Every claim we hold, and how far we can stand behind it." The ledger holds 142 claims across 39 products, and "28% are confirmed against the source text by the evidence gate."
- The gate hashes a stored excerpt and matches it to live source text. Coverage page: it "does not validate every assertion, the study methods, or the source's independence." Snapshot cutoff is 2026-08-27, and "Later editorial source reviews do not update these results."
- Price: free research preview. "This research preview does not accept purchases or packet requests"; Evidence Packets "not yet available."
- Reviewer still does: everything about applicability. Only 4 of 142 rows are regulatory filings and 19 are peer-reviewed studies. Rows carry no version, population, setting or intended-use field. Most rows are vendor pages and press releases.
- Closest in intent to Sakaime (claim ledger, evidence classes, JSON API, agent manifest). Different in kind: it verifies that a quote exists at a source, not that the evidence applies.

**Constat by Health AI (constat.dev)**
- Quote: "Search FDA AI medical-device evidence, from 510(k) predicates through payment." Tracks: Precedent (1,506 devices parsed, 2,577 predicate edges), Postmarket (1,519 devices, 9,907 drift signals), Reimbursement, Radar. 13 tools on the site, 14 in the live tool list.
- First-hand probe: `device_evidence_lookup` on DEN170073 (Viz.ai ContaCT) returned structured fields, each with a source quote, page number and confidence. Fields included study design, n sites, demographics_reported, generalizability (external testing, scanner diversity, subgroups), PCCP, sensitivity/specificity with CI, and the extraction model (gemini-2.5-flash) with its timestamp. No indication or intended-use field, and no ClinicalTrials.gov or PubMed ids in that response.
- Price: public console and anonymous MCP $0 (10 work units/min, 50/day); Evidence Assessment from $5k, one-time, "2-week target"; Monitored Evidence Brief from $500/month; data and MCP licence on request. Pipeline refreshed weekly.
- Reviewer still does: the join to trials and papers, the vendor's own claim, the claim-versus-scope comparison, and the verdict. Constat says "Verify against primary sources."
- It is the only product I found that already automates premarket population and generalizability extraction with page-level quotes. Its stated buyers are regulatory, quality, clinical-evidence and market-access teams, not hospital procurement.

**AI TrustMark (ai-trustmark.org)**
- Quote: "an independent verification layer for AI services"; it "checks supplier, product, operating-control and customer evidence." Bronze, Silver and Gold depth tiers, a 0-100 Assurance Score, and public records stating "what was examined, the depth of checking, the date, the evidence grade and any unresolved gaps." Operated by AI Build Group Ltd.
- Price: pricing page exists, figures not shown on the page I read. Listing is free; "payment cannot buy review stars, directory position, a higher Assurance Score or a predetermined certificate outcome."
- Reviewer still does: confirm the record's scope matches their product version, population and use. The page does not say it checks any of these. I did not find a health record to inspect. Similar names (Nemko AI Trust Mark, TermScout TrustMark) are unrelated.

**CHAI (chai.org)**
- Offers: Public Registry ("documented health AI solutions with the transparency needed for responsible adoption"), Applied Model Card (draft v0.1; intended use, performance, risks, five principles, HTI-1 DSI support), risk categorisation tool v3, governance playbook, T&E frameworks for ambient AI, wellness, agentic AI and clinical trials. Joint Commission and CHAI issued joint guidance in Sept 2025.
- The registry says solutions are "verified" but not who verifies or how. The model-card page names no attester and does not address populations. Entry counts did not render ("Loading..."). A Mar 2025 CHAI post says the registry is powered by Avanade SAIGE.
- Price: not stated; registry viewing is public.
- Reviewer still does: all verification. Cards are vendor-authored documents. No FDA or study links appeared.

**Credo AI (credo.ai)**
- Quote: AI governance platform with AI Registry (models, agents, apps, vendors), "Assess Vendor Risk", "Audit Trails & Reporting", "Continuous monitoring, drift detection and real-time alerts." The healthcare page lists "Vendor AI oversight" and a free "AI Vendor Risk Profiles" tool. Joined CHAI's partner program Apr 28, 2026 (press release via search).
- Price: none public ("Book a conversation").
- Reviewer still does: gather and judge the clinical evidence. No FDA, ClinicalTrials.gov or PubMed capability described on the pages I read.

**ModelOp (modelop.com)**
- Quote: "the system of record that unifies every AI asset," covering "ML, GenAI, Agentic, and vendor AI"; "Audit-ready evidence mapped to every regulation and policy."
- No healthcare offering, clinical evidence check or pricing on the page read; "Request a Demo."
- Reviewer still does: all evidence applicability work. Everything beyond the home page is NOT VERIFIED.

**HAIP vendor disclosure framework (healthaipartnership.org)**
- Quote: "designed to help healthcare delivery organizations (HDOs) evaluate AI systems comprehensively and responsibly." Five domains: System Capabilities and Intended Use; System Performance and Compliance; Data Stewardship; Integration Requirements; Lifecycle Management. Excel form and full framework document; companion NEJM AI paper.
- No version or date on the page; footer "All rights reserved"; no reuse licence.
- Price: free download.
- Reviewer still does: send the form, read the answers, then check each answer against FDA records and studies. Nothing verifies the vendor's replies. Individual field names were not on the page; NOT VERIFIED beyond the five domains.

**Mira Network (mira.network)**
- Described in secondary coverage (Binance Research, Messari via search results) as decomposing AI output into claims that staked LLM verifier nodes label True/False/Uncertain, with a signed certificate. Reported accuracy "70% to 96%" is the project's or commentators' claim, not verified.
- Licence of public repos: the GitHub org Aroha-Labs hosts `mira-network` (description: an LLM router and client with CLI and console) and `mira-sdk-python`. GitHub's API reports no licence for either, which means no open-source grant; ideas only. Two forks in that org are GPL (ComfyUI) and GPL-2.0 (a WordPress plugin). I did not find the verification protocol source. The unrelated GitHub org "mira-network" (MIT, last push 2022) is not this project.
- Docs I read describe an LLM gateway (credits, API keys, chat/completions), not a verification API.
- Reviewer still does: everything domain-specific. A generic claim verifier has no FDA record, version or scope model.

**Scite / Consensus / Elicit**
- Scite: "Smart Citations show how later research has supported, challenged, or discussed a paper, claim..."; "Every claim Scite's AI makes links back to the specific sentence in the specific paper." Page says nothing about medical devices. Price not on the page.
- Consensus: "an AI academic search engine for peer-reviewed literature"; Consensus Meter, Deep Search, Study Snapshots; "Search 400M+ scientific papers"; citation export RIS/BibTeX/CSV. Free to access; plan prices not on the page.
- Elicit: Basic free; Pro $49/user/month; Plus $229/user/month; Enterprise custom; custom extraction from uploaded papers, a systematic-review workflow, API on Pro. ClinicalTrials.gov and alerts not mentioned.
- Reviewer still does: find which paper belongs to which device version, and judge whether the study population matches theirs. These tools answer "what does the literature say", not "does this study apply to this product".

**FDA AI-enabled device list (fda.gov)**
- Six columns: Date of Final Decision, Submission Number, Device, Company, Panel, Primary Product Code. Newest entry in the version I read: 06/29/2026. Downloads: CSV, Excel, XML.
- Quote: "not a comprehensive resource of AI-enabled medical devices"; devices identified "mainly by AI-related terms in their authorization summaries and/or their classification." Summaries "are not complete." Sorting only; no filter.
- Reviewer still does: open each linked summary and find the studies. Version and software-release identity are not in the list.

**Other FDA-data viewers**
- FDA AI Search (fda-ai-search.com, Dana-Farber): LLM-extracted summaries embedded for semantic search; paper used the July 10, 2025 FDA list. Repo `lotterlab/fda_ai_search` shows no declared licence, last push 2025-12-01 (ideas only).
- Innolitics FDA 510(k) Explorer: "The intended use is extracted for you"; an "AI Performance" view (acceptance criteria, observed values, dataset descriptions) the page itself calls "AI-generated but has been very reliable in practice," which is the vendor's own claim. Alerts, Excel/PDF download, an agent token. Price not stated. Made by a 510(k) consultancy.
- Paragon Health Institute viewer: 1,614 authorisations, 271 recall records linked to 102 authorisations; CSV downloads. States it "cites no clinical studies."

**Epic seismometer, Censinet, ACR AI Central**
- Epic seismometer: BSD-3-Clause, pushed 2026-10-21, 272 stars. "a suite of tools that allows you to evaluate AI model performance"; needs the hospital's own patient, intervention and outcome data. Complements a Sakaime verdict (local performance); does not touch published evidence.
- Censinet: "launch structured AI evaluations across ethical, clinical, operational, and regulatory domains," aligned to NIST AI RMF; AI Telemetry classifies vendor products as AI-enabled or not and surfaces changes. Press claims (up to 66% faster assessments) are vendor claims. Price not public. This is the hospital vendor-risk system a Sakaime verdict would feed into.
- ACR AI Central: per search snippets, entries list manufacturer, FDA product codes, predicate device and performance evaluation; ACR editors "continuously review publicly-available FDA data, vendor information and physician feedback." Imaging only; embedded-in-equipment software not cataloged. Product pages did not render for me.

## 3. Procurement-workflow evidence

- Mass General Brigham. Becker's primary article ("As AI vendor ROI claims grow bolder, health systems require more proof") returned 403 and a CAPTCHA, so I did not read it. The DistilINFO republication dated July 21, 2026 states Rebecca Mishuris, MD "requires every AI company to complete a standard questionnaire before procurement advances" and quotes her: "Even being able to fill out that form is a non-negotiable." The form covers how a model works, how it was validated and whether bias was examined (DistilINFO's paraphrase). I found no published copy of the form. Becker's separate piece on the MGB Healthcare AI Challenge describes crowdsourced evaluation.
- Same article: Valleywise Health CIO Stephanie Hines requires vendors to show "training methodology, model maturation, and outcomes data from comparable organizations"; "I want to see the evidence." Evergreen Health's Kevin Bidtah: "Go-live isn't the end, isn't the finish line."
- Scottsdale Institute (webinar Dec 16, 2025): intake forms from 16 health systems averaged 24 questions; common sections were model performance metrics, data privacy and security, and regulatory status; "Half of forms ask about FDA approval." The full analysis was not read, only the event page.
- Duke ABCDS oversight template (search snippet, .docx not opened): asks for FDA clearance evidence, selection criteria and external validation results, plus a local validation plan.
- Joint Commission Responsible Use of AI certification (dhinsights.org, June 18, 2026): reviews governance, data management, risk and bias reduction, testing, transparency and training. Quote: the certification "doesn't validate individual products or tools." The Joint Commission and Healthcare IT News pages returned 403.
- Mayo Clinic Platform_Validate (search snippets): independent report on accuracy, efficacy and bias using Mayo data; developers can publish the scores. Per-product testing, not a claim-scope check; price not found.
- ECRI (home.ecri.org/pages/ai-resources): AI evidence assessments are member-only; GRADE method per press; no prices shown.
- PHTI: March 2025 report says it "would not be a typical PHTI head-to-head evidence report"; not a continuing evidence service.
- Epic: AI Trust and Assurance Suite (seismometer) released May 21, 2024 per Becker's snippet; per Digital Health News it does not validate generative AI.
- Microsoft, Google, Epic marketplace governance of third-party evidence: two searches found nothing documented. NOT VERIFIED.
- Vizient and "Bluebook": one search each found no AI evidence or assessment service. I could not identify what "Bluebook" refers to. NOT VERIFIED.

Voice of the customer (documented, not forum threads; Reddit skipped as instructed):
- Hines (Valleywise): outcomes data "from comparable organizations", i.e. the population-match problem stated by a buyer.
- Mishuris (MGB): a standard intake is the gate; the form itself is not published.
- Health-system CIO quote about vendor risk (Healthcare IT News, via search snippet): "treat AI systems as critical infrastructure requiring the same rigor as other systems and platforms."
- No quote found of a practitioner saying a cited study did not apply to their patients. That search returned only vendor and guidance blogs. NOT VERIFIED as a lived complaint.
- Independent analysis in PLOS Digital Health (via search snippets): of 1,357 FDA-cleared AI/ML devices, 34 linked to registered trials and 3 evaluated on patient outcomes. Its pipeline: PubMed searches by device name, NCT ids scraped from 510(k) summary pages, NCT-to-publication links in PubMed, manual review. So the three-source join exists as a one-off research method and not as a product I could find.

## 4. Is there a defensible gap?

**Most credible gap.** Nothing I could read joins FDA records, ClinicalTrials.gov and PubMed for one named device AND tests a specific vendor claim against version, population, setting, intended use and date AND says when it is ambiguous or when a source change voids the verdict.
- HealthIT.com: I read the full ledger JSON, and it has no scope fields. Its gate checks excerpt hashes only.
- Constat: strongest on premarket extraction, but it has no claim input, no trial or paper join, and no applicability verdict.
- Everything else is a form (HAIP), a self-authored card (CHAI), a generic verifier (Mira), a literature tool (Scite, Consensus, Elicit) or governance for the buyer's own models (Credo, ModelOp, Censinet, seismometer).

**Strongest incumbent threat: Constat (Health AI).**
- It already ships page-quoted extraction of sample size, sites, demographics, generalizability and PCCP, predicate chains, weekly refresh, a watchlist diff tool, an MCP endpoint with a free tier and $5k scoped assessments.
- Adding NCT/PubMed linking and a "claim in, scope check out" tool is incremental. Their buyer today is regulatory and market-access, which is the one real difference.
- Second threat, on distribution: CHAI's registry (Avanade/Microsoft engine) and Epic could make a vendor-authored model card the default procurement artifact. That would lower demand for an independent check.

**Caveats on the gap, so it is not overclaimed.**
- Enterprise products (Credo, ModelOp, Censinet) and ECRI/Mayo services sit behind demos and memberships. I read only public pages, so a hidden claim-vs-scope feature is possible.
- Constat's tool list could add claim checking in any release. My probe is a single call on one device on 2026-10-27.
- Some competitor pages rendered poorly (CHAI registry counts, AI Central products).

**Tests that would settle it** (none run yet):
1. Build a gold set of about 25 real vendor claims with known mismatches: indication narrower than the claim, pediatric or different-scanner use, superseded K-number, a study of a different software version, and a device name shared across K-numbers. Run every claim through Constat's free MCP, HealthIT.com, Innolitics chat and Sakaime. Score each on correct verdict, correct refusal on ambiguity, and source-cited evidence. If any rival matches Sakaime on 80 percent or more, the gap is not defensible.
2. Email Constat and ask directly whether CT.gov/PubMed joining and claim-scope checking are on the roadmap.
3. Show 5 hospital reviewers one real packet; time the manual check against the tool's output and ask whether they would put the output in an approval file.
4. Fetch the Becker's article and the MGB form through a browser, and ask the MGB contact whether the questionnaire asks for evidence applicability.

## 5. Not verified or not covered

- Becker's primary article (403, CAPTCHA); Joint Commission and Healthcare IT News pages (403). I used the DistilINFO republication and a DH Insights article.
- Not read at all: AI TrustMark verification records, CHAI registry entries, ACR AI Central product pages, Constat paid tiers, Credo and ModelOp beyond the pages above, Scite and Consensus feature pages beyond home pages, Mira's verification protocol source, the Duke template contents, the HAIP full framework document.
- Epic, Microsoft and Google health-AI governance features: two searches, no documented features. Vizient and Bluebook: one search each, nothing relevant.
- First-hand tests were limited to one Constat call and one HealthIT.com JSON pull. I did not drive any product UI.
- Search-tool summaries (the PLOS pipeline description, Mayo, ECRI GRADE claims, Censinet's 66 percent figure) are second-hand and should be re-read at source before being cited publicly.
