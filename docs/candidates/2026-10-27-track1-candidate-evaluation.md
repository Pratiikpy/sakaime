# Track 1 candidate evaluation, 2026-10-27

Status: working record. Nothing here is a build decision yet. Every number was read on 2026-10-27 unless a date is given. "NOT VERIFIED" means we did not read the source ourselves.

## 1. What the first candidate (BidDelta) was checked against

An outside research note proposed BidDelta: a pre-submission check that a construction bid reflects every material amendment. We checked its claims.

| Claim in the note | What we found |
|---|---|
| A March 2026 r/estimators post: about $250,000 mechanical underground job, 600 metres of pipe missed from Addendum 1, nearly $100,000 | **Verified.** "Always read your Addendums!!", r/estimators, 2026-03-12, 79 upvotes, 67 comments. The poster says the addendum was 116 pages and the change was "buried near the end", and that a mechanical contractor, not their own process, caught it. Self-reported. |
| Late amendments and missed scope are a recurring estimator pain | **Supported.** r/estimators "Royally f*cked. So many missed scope. Project already won." (2026-09-01, 125 upvotes, 93 comments: a missed-sheets case, advice is to build a delta log of every miss with sheet and revision). "Why are there so many errors in estimating?" (2025-12-17, 145 comments). r/Construction "Job massively underbid" (2026-10-13, 518 upvotes, 434 comments, not read in full). |
| GAO rejects bids that fail to acknowledge material amendments | **Supported, but old.** Search results show decisions such as B-194679 and B-208688 holding that failure to acknowledge a material amendment makes a bid nonresponsive, with a materiality test (price, quantity, quality, delivery, relative standing). The decisions found are mostly 1970s to 1990s; current law (FAR 14.405) was not re-read. |
| Public source data exists for reproducible tests | **Verified for addenda.** North Carolina, North Dakota, Ohio and Florida DOTs publish addenda. The NCDOT addendum we downloaded (Martin County I-6028B, 2020) lists "Item / Description / Old Quantity / New Quantity" per pay item and says the bid "must include these pay item revisions". FDOT states that failing to load all amendment files "will cause the bid to be rejected". FDOT and TxDOT publish bid tabulations; whether every one is downloadable without an account is NOT VERIFIED. |
| Competitors overlap | **Worse than the note said.** BidShield (bidshield.co, roofing estimators): a 135-check, 17 to 18 phase preflight with "Addenda Tracking... confirmed incorporated before submission" and "AI-powered scope verification". Consight (consight.ai, general contractors): reads "plans, specs, and addenda", AI bid leveling, "Data Source Traceability" (click any result to see the source line), bid revision requests, an assistant that "holds context from first bid invitation to final buyout". The claimed differentiator (source-linked, addenda-aware preflight) is already advertised by both. |

New evidence the note did not have:

- r/estimators is openly hostile to AI products. "Stop asking us about our problems to support market research for your AI tools" (2025-08-29, 157 upvotes). "Do not trust AI with takeoffs or anyone who says it can" (2026-07-25, 132 upvotes, the poster's AI takeoff returned less than half the real area). "Until your 'spiffy new AI program for estimating' can properly read one of these, please stop spamming this sub" (2026-06-22, 94 upvotes). Consequence: the note's plan of five practitioner interviews recruited through that community is unlikely to work, and a product that guesses (takeoff, scope generation) will be rejected on sight. A checker that never produces a quantity and only flags disagreements is the one shape these threads do not argue against. That is an inference, not a finding.
- Reddit was read through a public Redlib instance (read-only front end), with an identifying user agent and four seconds between requests. Search there is loose keyword matching: long queries return unrelated popular threads, so only subreddit-restricted queries were used and counts are not a census.

Verdict on BidDelta: demand for the underlying problem is verified. Its originality against BidShield and Consight is NOT established. It is a candidate, not the choice.

## 2. Repository study (cloned shallow into `research/`, local only)

Licences were read from each repo's LICENSE file. Only mechanisms are taken; none of the eight platforms is deployed.

| Repo | Licence | Mechanism verified in code | What we would do differently |
|---|---|---|---|
| Trino (core/trino-spi) | Apache-2.0 | `ConnectorMetadata.applyFilter / applyProjection / applyAggregation / applyJoin / applyLimit / applyTopN`. A connector returns a `ConstraintApplicationResult` carrying `remainingFilter` and `remainingExpression`: what it could not push down, which the engine must still apply. | Each of our sources declares what it can answer and returns the residual; the system never assumes a source handled a predicate. Zetaris does the real federation, so we model the negotiation, not a second engine. |
| Splink | MIT | Probabilistic record linkage (Fellegi-Sunter): blocking rules, comparison levels with m and u probabilities, EM training, match weights that can be shown as a per-field waterfall. | Use the explainable-weight idea for matching items across amendment, estimate and quote. Add an explicit "needs a human" band, never auto-merge in the uncertain band. |
| Graphiti | Apache-2.0 | Bi-temporal facts: `valid_at`, `invalid_at`, `expired_at`, `reference_time`, plus source `episodes`. `resolve_edge_contradictions` expires an older edge when a newer one becomes valid. | The rule is recency only: a later arrival wins. In bidding, a later document is not necessarily more authoritative (a supplier email does not outrank an addendum). We rank by source authority first, time second, and keep the superseded fact. |
| Docling | MIT | Structured document parsing that keeps layout and tables, with page-level provenance. | Every extracted number keeps page and region so a reviewer can open the page. Extraction is checked by deterministic cross-checks, because layouts differ across DOTs. |
| Airbyte protocol | MIT | Connector contract with spec, check, discover, read and state messages, catalog of streams. | Same four verbs per source (describe, check, discover, read) so a source being down is a first-class state, different from "no records". |
| OpenLineage | Apache-2.0 | Run, job and dataset events with extensible facets. | Each finding records its inputs, versions and the step that produced it. |
| Cognee | Apache-2.0 | Builds a memory graph across many sources. | Not adopted: a general memory layer is infrastructure. Meterless H-MEM is the required memory. |
| Onyx | MIT with a separate enterprise licence (SPDX NOASSERTION) | Connector framework with per-document permission sync and federated connectors that query at search time. | Ideas only until the licence split is read; not copied. |

Not studied: LangGraph (state, checkpoints, human interrupts) and OpenMetadata were not cloned; the lessons attributed to them come from the outside note and are NOT VERIFIED by us.

## 3. Candidate scorecard (judgement, not measurement)

Scale 1 to 5. Demand = evidence a real person has the problem. Data = real public data a judge can run with no key. Fit = needs Zetaris across structured sources and Meterless memory over time. Gap = distance from existing products.

| Candidate | Demand | Data | Fit | Gap | Main risk |
|---|---|---|---|---|---|
| BidDelta (addenda vs estimate vs quotes) | 4, verified incidents | 3, addenda real, estimate and quotes constructed | 4 | 2, BidShield and Consight overlap | originality; community distrust of AI |
| NYC building and rent-stabilization reconciliation (HPD, DOF tax, DHCR lists, eviction records) | 3, JustFix and Brick Underground show the need; Reddit demand not yet counted by us | 5, open data, no key | 5, identity matching plus time plus authority | 2, JustFix "Who Owns What" does ownership and violations | one city; legal-advice overclaim |
| Vulnerability reconciliation across scanners and advisory databases | 3, a peer-reviewed study (Boles et al., SCAM 2024) found Trivy and Grype disagree on counts and IDs across 927 images | 5 | 3, mostly APIs and files | 2, DefectDojo-style aggregators exist | crowded; judges see many security entries |
| Product recall exposure for resellers | 2, thin evidence found | 5 | 3 | 3 | weak demand |
| Crypto and brokerage cost-basis reconciliation | 4, r/CryptoTax 1099-DA threads | 2, private data | 3 | 1, Koinly and CoinTracker | strong incumbents; private data |
| Vendor-payment verification (wired $475,000 to the wrong vendor, r/Accounting, 508 upvotes) | 3 | 2 | 3 | 3 | data is private |
| Federal bid readiness (SAM.gov, amendments, registration status) | 3 | 3 | 3 | 2 | crowded AI-for-contracting field; API key |

## 4. Where this leaves the choice

- No candidate is shown to be the strongest. The honest state: BidDelta has the strongest verified pain, the weakest originality claim, and the most hostile user community; NYC reconciliation has the cleanest data and fit, and an incumbent that is a nonprofit.
- The sharpest version of BidDelta found so far: do not produce quantities, only detect disagreement. A real, public benchmark is possible: real DOT addenda give exact item, old quantity and new quantity; real bid tabulations give real item lists and unit prices; a stale estimate or quote built from pre-addendum quantities has known ground truth by construction. The synthetic part must be labelled as such.

Kill criteria before building (any one stops BidDelta):

1. Extraction of old and new quantities from addenda in at least three DOT layouts is below 95% exact on a hand-checked set.
2. A trial of BidShield or Consight on the same cases catches what we catch.
3. We cannot state in one sentence what a practitioner gains that those products do not give.

Checked after the scorecard: the NYC HPD violations endpoint on NYC Open Data answers without a key (one request returned violation records with borough, block, lot and status), so that candidate's data is reachable. A Reddit search for tenant-tool demand in r/NYCapartments, r/Tenant and r/nyc returned popular unrelated threads, so demand for that candidate is NOT established by us; one r/NYCapartments post, "Built this after my friend got quietly screwed on a 1BR lease" (2026-04-18, 908 upvotes, 129 comments), shows someone building a lease-check tool and was not read.

Open work: read the HPD, DOF and DHCR datasets for real contradictions; read the 908-upvote tool thread; run kill criterion 1 on real addenda from at least three DOTs; try BidShield's free trial on one real addendum.
