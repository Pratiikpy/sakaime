# Sakaime feasibility: can a real device be linked to its real studies from public, keyless data?

Probe date 2026-10-27. All requests used User-Agent `validwhen-research/1.0 (read-only)`, no keys, no logins. Every URL, date, status, byte count and sha256 is in `fixtures/_requests.jsonl` and `fixtures/MANIFEST.md` (about 4.0 MB of fixtures, none over 300 KB).

## VERDICT: CONDITIONAL

Device identity and the FDA-reviewed evidence are retrievable keyless and reliably. Linking a device to external studies is NOT reliable: only 3 of 12 devices had an exact-identifier link, only 1 of 12 had a link whose study text states the same software version FDA reviewed. It works as "ranked candidate links, each labelled EXACT / STRONG / WEAK / NONE with the reason", never as "these are the device's studies".

| Question | Answer | Evidence |
|---|---|---|
| Resolve every FDA AI-list row to an openFDA record | YES, 1,593 of 1,593 K/DEN numbers | batch sweep, section 2 |
| Get intended-use text from an API | NO. Only in the summary PDF (text-extractable 12 of 12) | section 3 |
| Get software version per submission keyless | PARTLY. GUDID via openFDA `/device/udi` maps 851 of 1,593 (53%) | section 2 |
| Exact K/DEN/NCT identifier shared between device record and study | RARE (3 of 12; FDA summary cites an NCT in 1 of 59 sampled) | sections 4, 5 |
| Study text states the FDA-reviewed version | 1 of 12 (EyeArt v2.1.0) | section 4 |
| Name collisions and version ambiguity | Collision for 6 of 12; version/identity conflict for 11 of 12 | section 6 |

## 1. FDA "List of AI-Enabled Medical Devices"

- Page: `https://www.fda.gov/medical-devices/software-medical-device-samd/artificial-intelligence-enabled-medical-devices` redirects to `.../artificial-intelligence-enabled-medical-devices/list-artificial-intelligence-enabled-medical-devices`.
- **Scripted fetch is blocked.** curl and urllib (with our identifying UA, with a Mozilla UA, and with the default curl UA) get a 302/301 to `/apology_objects/abuse-detection-apology.html` (Akamai) for the page, and 404 for `/media/178541/download?attachment`. A real browser session (Playwright) loads the page and `fetch()` of the CSV works (HTTP 200, `text/csv; charset=UTF-8`, 141,468 bytes). A pipeline therefore needs a one-off browser fetch or a manual download, then commits the CSV. NOT VERIFIED: whether a polite refresh by script ever works.
- Formats offered: CSV (`/media/178541/download?attachment`, fetched), Excel (`/media/178540/...`, link seen, not fetched), XML (`/media/178565/...`, link seen, not fetched). The HTML table pages 50 rows at a time ("Showing 1 to 50 of 1,614 entries").
- Last update: "Content current as of 09/04/2026"; CSV `Last-Modified` Fri, 04 Sep 2026 11:54:09 GMT. Newest decision 06/29/2026.
- Columns (6): `Date of Final Decision, Submission Number, Device, Company, Panel (Lead), Primary Product Code`. No version column, no intended use, no study link.
- Rows: **1,614**, all with a submission number. 1,553 K, 40 DEN, 21 P (PMA, some with supplement suffix such as `P130020/S005`). Panels: Radiology 1,230, Cardiovascular 154, Neurology 73, Anesthesiology 30, GI-Urology 27, Hematology 22, Pathology 10, Ophthalmic 10. Oldest entries date from 1995.
- FDA states the list is "not a comprehensive resource", built by keyword match on AI terms in summaries/classification, and that devices without a published decision summary are added later.
- Data quality seen in the CSV: 79 rows pack several devices in one cell separated by `;` or commas (for example "Voluson Expert 18; Voluson Expert 20; Voluson Expert 22"); company names vary by spelling (Viz.ai appears as `Viz.ai`, `Viz. ai`, `Viz.Al`; iSchemaView has 6 spellings; Siemens 13; Eko has 6 spellings spanning two different companies, Eko Health and Eko.ai/Us2.ai).

## 2. openFDA coverage (keyless)

- `GET api.fda.gov/device/510k.json?search=k_number:K253265` returns, for K and DEN numbers alike (De Novo records appear here with `clearance_type: "Direct"` and blank `statement_or_summary`): `k_number, device_name, applicant, contact, address fields, country_code, decision_date, date_received, decision_code, decision_description, clearance_type, statement_or_summary ("Summary" | "Statement" | blank), product_code, advisory_committee(_description), review_advisory_committee, third_party_flag, expedited_review_flag, openfda{device_name (generic class name), device_class, regulation_number, medical_specialty_description, registration/fei numbers}`. **No indications text, no software version, no study field.** `meta.last_updated` was 2026-10-19.
- Sweep over the whole list in batches of 25 (`k_number:(K1 OR K2 ...)`, 64 requests): **1,593 of 1,593 K/DEN numbers resolved**, zero errors. PMA: `api.fda.gov/device/pma.json?search=pma_number:P130020` works and returns per-supplement `ao_statement` and `supplement_reason`; I tested one of the 21 P numbers only.
- `api.fda.gov/device/classification.json?search=product_code:QAS` returns the regulation definition (generic intended use for the product code), not the device's own indication.
- **Version map via GUDID**: `api.fda.gov/device/udi.json?search=premarket_submissions.submission_number:"K200667"` returns `brand_name, version_or_model_number, company_name, premarket_submissions[]`. Sweep (64 requests): **851 of 1,593 (53.4%)** submissions have at least one GUDID record; **306 of those 851 carry more than one distinct version label**. It is the only keyless place a submission number meets a version string.
- openFDA has no De Novo-specific endpoint; there is no study or trial endpoint.

## 3. Intended use and study description: summary PDFs

- Pattern: 510(k) `https://www.accessdata.fda.gov/cdrh_docs/pdf{YY}/K{YYNNNN}.pdf`; De Novo `https://www.accessdata.fda.gov/cdrh_docs/reviews/DEN{...}.pdf`. (My first guess `pdfs{YY}` was wrong; I found the true path by reading the `pmn.cfm?ID=` detail page, which links to it. The detail page itself carries no indications text.)
- 12 of 12 chosen devices: PDF downloaded, `pdftotext -layout` extracted text (12 to 76 KB each, 8 to 26 pages). Formal "Indications for Use" form present in 10; the other two (K211733, K213857) describe intended use only in prose.
- Sample of 50 random list entries (40 K, 10 DEN): 49 PDFs resolved by URL pattern with HEAD; 1 miss (DEN250007, 404). Separate sample of 59 downloaded PDFs (K 2019+ and DEN): text extractable 59 of 59. Crude regex counts on those 59 (lower bounds): indication language 53, clinical/standalone/reader-study language 51, a version-like string 15, a site-count phrase 11, an NCT number **1 (K241676 cites NCT04094818)**.
- Extraction artefacts: ToUnicode warnings, and registered-mark symbols degrade in the PDF text (`Transpara@`, `MammoScreen�`). The summary is written by the sponsor and is not standardised.

## 4. The 12 devices

Fields available for all 12 from openFDA 510(k): the list in section 2. Intended-use source for all 12: summary PDF only. "FDA summary study" = what the PDF itself says about the pivotal study.

| # | Device (FDA name) | No. | GUDID version label(s) | Best study link found | Class |
|---|---|---|---|---|---|
| 1 | IDx-DR (ophth.) | DEN180001 | none for DEN; siblings K203629 "V2", K213037 "v2.3" | CT.gov NCT02963441 "LumineticsCore (formerly IDX-DR)", 900 pts, "US pivotal study version 01 and 02"; PMID 31304320 (pivotal, 900, primary care). No K/DEN/NCT in either direction. FDA summary: 900 pts, 10 primary-care sites, v2.0.0 US, Topcon NW400 | STRONG-TEXT |
| 2 | EyeArt (ophth.) | K200667 | 2.1.0 | FDA summary cites NCT03112005 (942 consented, 11 US sites, primary + eye care). PMID 34779843 abstract contains NCT03112005 and "version 2.1.0" | EXACT-IDENTIFIER |
| 3 | Caption Guidance (cardio US) | DEN190040 | "Guidance", "AI" (owner now GE) | FDA nurse pivotal: 8 RNs x 30 pts, 5 cardiologists, Terason. PMID 33599681 (8 nurses x 30, 5 echocardiographers, 2 academic hospitals) and NCT03897140 (240 pts, "Bay Labs EchoGPS"). Product name absent from the abstract; "EchoGPS" absent from the FDA PDF | STRONG-TEXT (design match only) |
| 4 | ContaCT / Viz LVO (neuro) | DEN170073 | 11 records, 1.1 to 1.11 | CT.gov NCT04608617 intervention text "Viz LVO (De Novo Number DEN170073)", 600 pts, US hub/spoke systems, NIHSS >= 6. 47 PubMed papers match `Viz.ai[tiab]`; of the first 12 returned, none carries DEN170073 or an NCT, and they span several Viz modules (LVO, ICH, ICH volume). No version in the registry record | EXACT-IDENTIFIER (registry side only) |
| 5 | BriefCase-Triage, abdominal CT | K253265 | none; sibling BriefCase 1.1.0.0 (K180647), 2.0.0 (no submission) | None in CT.gov. PubMed Aidoc papers are ICH/PE/C-spine modules, not this one. FDA summary: 394 cases, 6 US sites, sensitivity 94.2% | NONE (WEAK for brand) |
| 6 | Transpara 1.7.2 (mammo) | K221347 | 1.7.2 (K210404 = 1.7.y, K241831 = 2.Y.Z) | MASAI NCT04838756 (100,000 women, Sweden, 40-74); PMID 37541274 abstract names Transpara, says "version 1.7.0" and carries the NCT. Version differs from K221347 | STRONG-TEXT (version mismatch) |
| 7 | MammoScreen (3) (mammo) | K240301 | none for K240301; siblings "MAL2US", "MAML" | NCT05800132, sponsor Therapixel, 5,000 women, France, 7 sites, recruiting, no version, no results. PubMed: 2 name hits, one is a different product | STRONG-TEXT (protocol only) |
| 8 | Lunit INSIGHT CXR Triage (CXR) | K211733 | 1.0 | Studies use "INSIGHT CXR" for TB screening in Vietnam (NCT06401434; PMID 40233023 versions 3.1.0.0 vs 3.9.0.1). Cleared use is pleural effusion and pneumothorax triage; FDA data were NIH plus India sites | WEAK-NAME-ONLY |
| 9 | Paige Prostate (path.) | DEN200080 | "1.X" | PMID 33904171, 33782551 name the product, no version, no ID; PMID 32393768 studies "Paige Prostate Alpha" (research build). FDA locks v2.1.501. CT.gov: 0 hits in 3 queries | WEAK-NAME-ONLY |
| 10 | GI Genius (GI) | DEN200055 | none for DEN; siblings GGS200, GGM200, CB1708-EU | FDA summary cites NCT04079478 "AID Study" (700 pts, 3 Italian centres) (NCT01694966 is a methylene-blue colonoscopy trial whose videos were reused for training, not a device study). No PMID attached to either; no PubMed hit for the NCT. PMID 32371116 (685 pts, 3 Italian centres, Sep-Nov 2019) looks like the paper but NOT VERIFIED. COLO-DETECT NCT04723758 / PMID 39153491 (UK NHS) tests GI Genius (Medtronic) in routine NHS care; module/version not stated in the abstract | EXACT-IDENTIFIER (FDA to registry) |
| 11 | HeartFlow Analysis (cardio CT) | K213857 | "FFRct version 3" | FFRct is a technique name (1,090 PubMed papers). PMID 24486266 (NCT01757678, 2014) names HeartFlow, no version. FDA summary has no clinical-study text | WEAK-NAME-ONLY |
| 12 | Anumana Low EF AI-ECG (cardio) | K232699 | "ECG-AI LEF 12-Lead Algorithm", "1010" | FDA: retrospective, 16,000 records, 4 US health systems. NCT04963218 (sponsor Mayo, 16,000, 4 sites) and PMID 41547169 (16,000 extracted, 13,960 evaluable, 4 US sites, no vendor name). Anumana-sponsored NCT05867407 is a later prospective trial | STRONG-TEXT (numbers only) |

Counts:
- **EXACT-IDENTIFIER 3** (EyeArt, Viz/ContaCT, GI Genius). **STRONG-TEXT 5** (IDx-DR, Caption, Transpara, MammoScreen, Anumana). **WEAK-NAME-ONLY 3** (Lunit, Paige, HeartFlow). **NONE 1** (BriefCase K253265).
- At least one EXACT or STRONG link to a study stating population and setting: **8 of 12**. Every one of the 8 still needed a human or model reading the text to accept it; only EyeArt's chain (FDA summary to NCT to PubMed abstract) is machine-checkable end to end.
- Study text states a version: 3 of 12 (EyeArt 2.1.0, Transpara 1.7.0, IDx-DR "version 01/02"). **Version matches the FDA-reviewed submission: 1 of 12 (EyeArt).**
- EXACT identifier AND matching version AND population AND setting: **1 of 12**.
- FDA summary itself describes a pivotal or validation study for 11 of 12 (HeartFlow K213857 has none by regex); I did not audit each for population and setting. The summary is the strongest and most reliably retrievable evidence; external studies are secondary.
- Searching CT.gov by device name in the intervention field would have missed EyeArt (interventions listed are "Color fundus photography" and "Mydriatic Agent"), MASAI/Transpara (intervention "AI screening modality"; the name is only in the description), and GI Genius AID (intervention "AI").

## 5. Identifier traffic: how often does a K/DEN/NCT string cross the boundary?

- FDA summary to NCT: 2 of 12 chosen (EyeArt, GI Genius); 1 of 59 in the random sample.
- Registry to FDA number: CT.gov `query.term=DEN170073` returns exactly 1 study (NCT04608617). `K200667`, `K232699`, `DEN200055` return 0.
- Paper to FDA number, Europe PMC full-text search for the exact number: `"DEN170073"` 8 hits, `"DEN180001"` 10, `"DEN190040"` 6, `"DEN200080"` 4, `"K232699"` 1, `"K200667"` 1, `"DEN200055"` 1, `"K221347"` 0, `"K211733"` 0, `"K213857"` 0, `"K253265"` 0. The titles of the top hits are reviews and device catalogues (for example "Machine Learning-Enabled Medical Devices Authorized by the FDA in 2024"), not performance studies; I did not open them. `"K240301"` returns 4 hits that are unrelated gene/enzyme accession noise.
- PubMed search by NCT number found a paper for 5 of the 11 NCTs I tested (NCT02963441, NCT05867407, NCT04838756 with 3 papers, NCT05838456 via `[si]`; NCT03112005 only as free text, `[si]` gave 0). None for NCT04079478, NCT04608617, NCT04963218, NCT05800132, NCT03705650, NCT04142879. Registered does not mean linked.
- CT.gov `referencesModule` PMIDs: NCT02963441 lists one (31304320), NCT04723758 lists two; NCT04079478, NCT03112005, NCT04608617 list none.

## 6. Ambiguity and collisions (quotes and counts)

Name collisions (a string match to something unrelated), 6 of 12 devices:
- **ContaCT**: PubMed `ContaCT[tiab]` returns 446,198 hits; results are "Contact dermatitis" and "contact angle". CT.gov `ContaCT AND stroke` returns 843 irrelevant studies.
- **BriefCase**: PubMed hits include "The Briefcase She Carried" (palliative care) and "briefcase spectral-domain OCT". `Aidoc` in CT.gov returns one study about another vendor's product (BoneView).
- **Caption**: PubMed `Caption[tiab]` 683 hits; a "Caption Health OR Bay Labs" CT.gov query returned a pregnancy video-messaging trial and a VR depression study first.
- **MammoScreen**: a different product with the same name exists: NCT04996316 "MammoScreen Breast Cancer Risk Assessment and Decision Aid" (OHSU) and PMID 32159424. Europe PMC fuzzy match also returns "MammoWave" microwave imaging papers.
- **HeartFlow / FFRct**: FFRct is a technique used by several vendors (1,090 PubMed papers).
- **IDx-DR**: searching the sponsor "Digital Diagnostics" in CT.gov returns Hologic's "Genius Digital Diagnostics System" and a Parkinson's trial.
- Across the whole AI list: 645 of 1,614 rows (40%) share a normalised device name (version tokens stripped) with another submission; 306 rows have a one-word name; 26 normalised names are shared across company strings (crude heuristic, includes spelling variants). Example: `Aurora` is K251153 (GE Medical Systems Israel) and K231355 (EnsoData). `BodyGuardian Remote Monitoring System` is K243349 (Boston Scientific Cardiac) and K192732 (Preventice Technologies), same name, two company strings.

Owner/alias drift: IDx, LLC became Digital Diagnostics and the product became LumineticsCore (FDA name IDx-DR, registry name "LumineticsCore (formerly IDX-DR)"). Bay Labs became Caption Health became GE, and the pre-clearance trial name is "EchoGPS". GI Genius: applicant Cosmo, GUDID labeller Covidien LP or Linkverse SRL, trials say "Medtronic". Anumana's algorithm descends from a Mayo research model (EAGLE trial NCT04000087), so "which algorithm was tested" is itself unclear.

Version ambiguity, 11 of 12 devices have a conflict between at least two of FDA summary, GUDID and study text (EyeArt is the one that agrees):
- Viz LVO: FDA De Novo says "This is the initial version 1.0"; GUDID lists 11 versions 1.1 to 1.11, all under the single DEN170073. A study on "Viz" cannot be placed on that scale.
- Transpara: K221347 is 1.7.2; MASAI abstract says 1.7.0 (GUDID: K210404); K241831 is 2.1.0.
- Lunit INSIGHT CXR: FDA/GUDID 1.0; independent studies run 3.1.0.0 and 3.9.0.1 and compare them, finding different performance.
- IDx-DR: FDA "2.0.0 US"; GUDID V2 and v2.3; registry "version 01 and 02", elsewhere "version 03".
- BriefCase: 35 list rows are named BriefCase, BriefCase-Triage or BriefCase-Quantification, with different indications (abdominal CT in K253265, rib fractures in K202992; papers cover ICH, PE and C-spine). A 2025 NPJ Digit Med study of "Aidoc BriefCase ICH Triage" (82.2% sensitivity, 101,944 CTs, 17-site health system) does not describe K253265 (94.2% sensitivity on abdominal CT in the FDA summary).
- Paige: research "Alpha" versus locked v2.1.501 versus GUDID "1.X".
- MammoScreen: (2), (3), (4), (5) and "BD" are separate submissions under one brand.

## 7. Source behaviour, rate limits, terms (one line each)

- **FDA pages (www.fda.gov)**: Akamai bot block for scripts (302 to apology page); a browser works. Reuse terms: NOT VERIFIED (US government work).
- **FDA accessdata PDFs**: scripted GET works; unknown path returns 404 with a 17,737-byte HTML "Page Not Found", so check `%PDF` not just status. Reuse terms: NOT VERIFIED.
- **openFDA**: no key: 240 requests/minute and 1,000/day per IP (read from `open.fda.gov/apis/authentication/`); I saw no rate-limit headers. No match returns **HTTP 404** `NOT_FOUND "No matches found!"` (indistinguishable by status from a wrong path, so read the body); malformed Lucene returns **500** with a parse message; bad `limit` returns 400; one client-side timeout (WinError 10060) seen on NCBI, none on openFDA. Terms: CC0 per `open.fda.gov/license`, with a disclaimer not to rely on it for medical decisions. I used 176 openFDA requests today; the full-list resolution sweep is about 130 of them, so a daily refresh fits under the 1,000/day cap but a development day with retries could exceed it.
- **ClinicalTrials.gov API v2**: no key; zero-result search returns **200 with `{"studies": []}`** (empty is not an error); malformed id or `pageSize=abc` returns 400 with a plain message; no rate-limit headers; `GET /api/v2/version` gives `dataTimestamp 2026-10-26T09:00:04`. Quoting terms matters (unquoted `Viz.ai OR ContaCT` returned 21,462 junk hits). Published rate limit and terms: NOT VERIFIED (docs page is JavaScript-rendered and returned no text to me). Public data.
- **PubMed E-utilities**: `X-Ratelimit-Limit: 3` header confirmed keyless; I kept to roughly 2 requests per second and never provoked a 429, so 429 behaviour is NOT VERIFIED. Zero hits returns 200 with `count 0` and `"No items found."`; efetch of a bad PMID returns 200 with an empty `PubmedArticleSet`. `[tiab]` is case-insensitive and word-split, so product names that are common words flood results. Abstracts are NLM-held records; reuse terms are per-publisher, not CC0 (NOT VERIFIED in detail).
- **Europe PMC REST**: no key, no rate headers seen; empty query returns 200 `hitCount 0`. Full-text search covers open-access articles, which is why `"Caption Guidance"` gives 38 hits where PubMed gives 2 and `"MammoScreen"` gives 51 versus 2, but with fuzzy matching noise. Licence of full text varies per article (OA subset), metadata free. Rate limits: NOT VERIFIED.
- **Crossref**: `/works/{doi}` returned title, journal, date but, for the one JAMA Cardiology DOI tried, no abstract, no funder and no relation links. Headers: `x-rate-limit-limit: 5`, interval 1s, `x-concurrency-limit: 1` (public pool). Metadata reuse licence: NOT VERIFIED (the docs page I fetched only states the site content is CC BY 4.0). Useful for DOI resolution and dates, not for device links.

## 8. What was NOT covered or NOT verified

- Only 12 devices; 11 of them are AI/ML software cleared in 2018 to 2025. No PMA device was linked (only the openFDA PMA endpoint was probed on P130020). Classification of links is my reading of abstracts and registry text, single reviewer, no second reader.
- I did not open full-text papers, so version, population and setting were judged from abstracts, registry records and FDA summaries only. A full-text pass would raise version coverage; the Europe PMC hits show the text exists for open-access papers.
- XLSX and XML versions of the AI list were not fetched. Whether the CSV and HTML table are identical beyond row count was not checked.
- NOT VERIFIED: the AID-study to PMID 32371116 match; GUDID completeness beyond the counts above; NCBI 429 behaviour; CT.gov and Europe PMC published limits; reuse terms for abstracts and full text.
- The 59-PDF statistics use crude regexes and are lower bounds; the 1-in-59 NCT figure has a wide interval (a handful of NCT mentions more or fewer would move it a lot).
- Playwright wrote two temporary files into the project root while saving the CSV; I moved the CSV into the fixtures folder and deleted the rest (`git status` clean).

## 9. What the evidence says to build

1. Treat the FDA summary PDF as the primary, citable evidence record (identifier, indication, population, setting, sites, version if stated). It is the only source that is keyed by the submission number and covers 11 of 12 devices.
2. Resolve device identity as list row, then openFDA 510(k), then GUDID, and show the version label gap openly (GUDID missing for 47% of submissions).
3. Present external studies as candidate links with the class and the reason (NCT in FDA text, DEN in registry, same numbers, name only), plus explicit mismatch flags: version differs, intended use differs (Lunit TB versus triage), module differs (BriefCase ICH versus abdominal), build differs (Paige Alpha). Never state a link as fact below STRONG.
4. Search with quoted vendor plus product plus condition, never the bare product name (ContaCT, BriefCase, Caption, FFRct all fail bare).
5. Ship the AI list CSV and the fixtures as pinned data; the FDA page cannot be scraped by script.
