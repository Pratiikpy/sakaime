# Sakaime: product requirements document

Status: v0.2, 2026-10-27 (revised after the outside review; the product has since been built, and what exists and what was measured is in `05-requirements-matrix.md`, `08-build-plan.md` and `../evals/RESULTS.md`). Hypotheses are marked. This PRD is the contract for what the product does and for what we will and will not claim. Architecture: `02-architecture.md`. Sponsor depth: `03-zetaris-plan.md`, `04-meterless-plan.md`. Tests and evidence: `05-requirements-matrix.md`, `06-evaluation-protocol.md`. Decisions and open gates: `DECISIONS.md`.

## 1. Summary

**Sakaime** answers a question that existing evidence tools usually leave to the reader: *a claim can be true and still be wrong for you.*

A hospital AI-evaluation reviewer holds a vendor claim ("94% sensitivity; use it across the emergency department") and a stack of evidence scattered over regulators, trial registries, journals, the vendor's own packet and the hospital's own requirements. Sakaime discovers and joins that evidence, works out which records describe the same product, study and version, and checks whether the evidence covers the exact use under consideration: which product version, which patients, which setting, which purpose, on which date. It returns only as broad a conclusion as the evidence permits, shows the smallest mismatch, says what document would settle each unknown, and lets the reviewer change the intended use and watch the conclusion change.

**Promise:** do not just verify that the evidence is real; verify what it actually justifies.

**What the product claims to do, stated narrowly (adopted from the 2026-10-27 review):** Sakaime discovers what an organization can actually establish about a claim, shows exactly where independent sources agree or fail to connect, and identifies the evidence needed before a decision can be made. It does not decide whether a clinical AI product is appropriate for deployment.

**Three kinds of evidence, kept apart.** Track 1 capability (discovery and cross-source work), scientific reliability (are the conclusions right), and demand (does a buyer want this). Passing one says nothing about the others; the requirements matrix tags every result by which it supports.

**Track:** Open Agent Hackathon 2026, Track 1, Solving Fragmented Intelligence. This is a second, completely separate submission from desk. (Track 3, submitted 2026-10-26).

## 2. Problem and evidence

Status of each statement is the one we can support today.

- A buyer-side workflow exists. The Health AI Partnership publishes an AI vendor disclosure framework covering intended use, performance, compliance, data stewardship and lifecycle. [Per outside note; primary page read pending in `research/competition/COMPETITION-REPORT.md`.]
- Hospitals ask vendors for standardized assessments before procurement conversations advance (a Becker's Hospital Review report on Mass General Brigham, July 2026). [Per outside note; NOT VERIFIED by us.]
- Authorization and demonstrated patient benefit are different things. A PLOS Digital Health analysis published 2026-08-19 reviewed 1,357 AI/ML-enabled devices cleared or approved through 2025-12-05 and linked 34 (2.5%) to registered prospective trials, 12 (0.9%) to posted results, 12 (0.9%) to peer-reviewed publications and 3 (0.2%) to patient-centred outcomes. [Read through several news reports, 2026-10-27; the primary paper is not yet read. Consequence for us: the registry leg is often empty, so "no registered prospective trial found in source X on date D" is itself a core finding, and the demo device must be chosen from the small set that has linkable studies. If the paper's supplementary data lists device-to-study links it is a possible external ground truth for identity linking, `06`; NOT VERIFIED.]
- Applicability is a recognised appraisal concept: PROBAST+AI (population, index model, comparator, outcome, timing, setting, intended use), STARD-AI and TRIPOD+AI reporting items. We operationalise established concepts; we do not claim to invent them. [Rule extraction in `reports/applicability-rule-registry.md`.]
- The pain is assumed, not yet measured with buyers. No hospital reviewer has been interviewed. **Demand and willingness to pay are NOT VERIFIED.**

Why sources are fragmented in practice: regulator records state intended use and an authorization scope; registries describe studies and update them over time; papers report populations, settings and software versions in prose and tables; vendors summarise selectively and revise; hospitals keep their own requirements in their own systems. Identifiers rarely line up, and the same product appears under several names and versions.

## 3. Users

**Primary: the hospital AI-evaluation reviewer** (clinical informatics analyst, procurement analyst or quality lead on an AI intake committee). Context: a vendor packet arrives; the committee needs a defensible, source-linked account of what the evidence does and does not establish before technical and clinical review. They are not statisticians; they do know their own requirements.

**Secondary: the clinical champion** who must sign that the tool fits a service line and wants the shortest path to the exact page that limits the claim.

**Not a user:** patients, clinicians at the point of care, vendors. The product never produces patient-level output.

### Jobs to be done

1. "Tell me whether the evidence behind this claim covers the use we have in mind, and show me the exact source."
2. "Tell me what is missing, in the form of a request I can send."
3. "If we narrow or widen the use, show me what changes."
4. "When something we relied on is updated, tell me which of our conclusions it touches."
5. "Give me a record I can hand to the committee and re-check later."

## 4. Scope

### 4.1 P0 (the submission cannot ship without these)

| Id | Capability | Notes |
|---|---|---|
| F1 | **Source Console**: lists sources with kind, authority tier, health (OK, EMPTY, UNAVAILABLE, DRIFTED, FORBIDDEN), schema hash and last success; shows what Zetaris exposes; supports **Add a source** from a description and a URL; shows the schema-mapping proposal and the validator result | Track 1 centrepiece; `02` section 5 |
| F2 | **Evidence Matrix**: one Zetaris statement joining regulator, registry, vendor packet and hospital requirement tables for a device and intended use, with per-source provenance | `03` |
| F3 | **Identity resolution** with exact-id first, explainable probabilistic band (weight waterfall), reviewer confirmation; states CONFIRMED, CANDIDATE, AMBIGUOUS, REJECTED | no auto-merge in the uncertain band |
| F4 | **Claim X-Ray**: click a claim to see where it appears, which sources support it, what they do not establish, conflicting versions, and the exact quoted passage with page or field | every quote verified to exist in the record |
| F5 | **Applicability Compiler** and **Applicability Lab**: typed ClaimedUse vs EvidenceScope, three-valued containment, five labels, minimal counterexample, evidence requirements, counterfactual recomputation without a model call | `02` section 10 |
| F6 | **Missing-Evidence List**: prioritised, each item naming the document or confirmation that would settle it, with a draft request the reviewer can copy | never sent automatically |
| F7 | **Evidence Timeline**: bi-temporal view; "what did we know on date D"; change events; stale findings flagged and recomputed | World Model |
| F8 | **Degradation behaviour**: source off, Zetaris off, model off, truncated result each produce an explicit degraded or unresolved state, never a "supported" label | drills T6 |
| F9 | **Dossier**: signed bundle plus offline verifier; one changed byte fails | `02` section 13 |
| F10 | **Guard**: refuses safety certification and procurement approval requests, quarantines instructions found in documents, requires a signed contract for export | Scout Intent |
| F11 | **Review Desk**: cases, status, unresolved high-impact questions, newly changed evidence, reviewer decisions (accept, narrow, request evidence, escalate) | human decision state |
| F12 | **Judge path**: `SAMPLE_MODE` with recorded real responses, no key, same result; a documented live path | `02` section 14 |

### 4.2 P1 (build after P0 is verified)

- Precedent memory with dream-and-approve (H-MEM); precedent-aware findings ("our policy requires prospective validation for triage tools").
- Decision publishing back to Zetaris as a queryable table; second-client query demo.
- Zetaris audit cross-check, time travel and semantic layer, each subject to its gate (`03`).
- ScopeShift runner inside the app: run the benchmark and ablations from a screen and show the results table.
- Change notification: when a registry record or authorization changes, list affected cases.

### 4.3 P2 (explicitly not claimed until built and tested)

- **Domain packs.** The engine takes a pack (claim schema, dimension orders, rule registry, source cards). A second pack (for example a construction-addendum pack, where claimed scope is a bid and evidence is an addendum) would show the engine is not tied to medicine. It is a thesis, not a feature, until a pack runs end to end with its own tests.
- Multi-jurisdiction regulators; EUDAMED and other registries.
- Hospital-side connectors beyond the synthetic database.

### 4.4 Non-goals

- No clinical safety certification, no compliance verdict, no procurement approval. Labels describe evidence coverage only.
- No patient data, no PHI, no clinical decision support.
- No autonomous contact with vendors, no email sending, no writes to any external system.
- No model-consensus truth: agreement among models is never evidence.
- No generic AI-governance directory.

## 5. Functional requirements (testable)

| Id | Requirement | Test |
|---|---|---|
| FR-1 | Given a ClaimedUse and a case, the system returns a Finding per claim with exactly one of five labels | property: label set closed |
| FR-2 | Every number shown in a finding has an anchor whose quote exists verbatim in the stored record | quote-exists check on all findings |
| FR-3 | Widening a ClaimedUse can only shrink the set of CONTAINED dimensions; and SUPPORTED_FOR_SCOPE for a wider scope implies it for every narrower scope inside it (the five labels are not an ordered scale) | property test (C-06) |
| FR-4 | Removing a source that the claim declares **required** never produces SUPPORTED_FOR_SCOPE; losing a corroborating source is shown and lowers the explanation, not the label | property + drill (C-08) |
| FR-5 | Contrary evidence must be explicitly dispositioned before SUPPORTED_FOR_SCOPE; relevant adequate contrary evidence yields CONTRADICTED_BY_SPECIFIED_EVIDENCE, weak or off-scope contrary evidence yields REQUIRES_DOMAIN_REVIEW | property test (C-07) |
| FR-6 | Two records with different version labels are never merged without an exact identifier or reviewer confirmation | T3 corpus |
| FR-7 | A newer, lower-authority document never supersedes a higher-authority one | T4 corpus |
| FR-8 | A change event to a fact marks exactly the dependent findings stale and nothing else | T5 test |
| FR-9 | EMPTY, UNAVAILABLE and DRIFTED are distinct and displayed distinctly; only EMPTY can support "none found in source X on date D" | T6 drills |
| FR-10 | A truncated federated result is refused, never used as a partial answer | unit |
| FR-11 | Masked columns never appear in a prompt log or trace | policy test |
| FR-12 | The dossier verifier fails on any changed source hash, number or rule version, naming the failing item | tamper test |
| FR-13 | Every model-derived field carries a compute receipt or is labelled unreceipted | receipt coverage check |
| FR-14 | A document containing instructions cannot alter plans, labels or exports | injection corpus |
| FR-15 | A new source with an unseen schema is either mapped and checked, or declined with a reason, without a code change | T1 |
| FR-16 | Output prose contains no sentence that is not tied to a finding id | reporter check |
| FR-17 | `SAMPLE_MODE` reproduces the recorded run byte-for-byte for labels and queries | replay test |
| FR-18 | Authority is decided per assertion type (authorized use, reported performance, marketed version, local requirement, vendor assertion), never by one global ranking; a study cannot widen an authorization and a regulator record cannot overwrite a measured result | authority-matrix tests (C-01) |
| FR-19 | A shared identifier establishes only the link type it supports (SAME_SUBMISSION is not SAME_MARKETED_VERSION) | identity tests (C-02) |
| FR-20 | A source URL outside the allowlist, or resolving to a private, loopback, link-local or metadata address, or redirecting to one, is refused with the reason shown | SSRF suite (C-03) |
| FR-21 | A schema mapping that is type-valid but wrong in meaning (percent vs fraction, population vs target population) is rejected or sent to review | semantic mutation suite (C-04) |
| FR-22 | Every critical assertion passes two separate checks, quote-exists and semantic support, reported separately | extraction tests (C-05) |
| FR-23 | Data classes control egress: vendor-confidential content reaches a model only through a local lane or with recorded consent; PHI is never present | egress tests (C-14) |
| FR-24 | Receipts are verified for signature, key, routed model, tier, custody and the binding of the receipt to the call it came with; a valid receipt does not raise confidence in content. Implementation note: a Nightshift receipt carries no hash of the request or the reply (only lengths, a preview, token counts and the completion id), so the binding is checked on those and the reply text is hashed on our side | receipt tests (C-13) |
| FR-25 | External effects (source registration, reviewer decision, export) carry idempotency keys; a resumed investigation never repeats one | resume tests (C-17) |
| FR-26 | An earlier finding is never rewritten by new evidence; a new finding references the old and records the reason | history tests |

## 6. Non-functional requirements

- **Bounded:** timeouts on every external call; capped retries and turns enforced in code; a full case run in minutes; cancellation works.
- **Reproducible:** clean clone, one documented command, no key for sample mode; pinned versions; seeds recorded.
- **Light repo:** no large raw datasets; samples are small, real, hashed and listed in a manifest.
- **Accessible:** WCAG 2.2 AA contrast and keyboard operation for the main flow; findings are readable without colour alone.
- **Privacy and egress:** read-only; storage is local. Local storage is not local-only processing, so every datum has a class: *public* (may go to the model), *vendor-confidential* (local lane or recorded consent only), *PHI* (never in the system). The active mode and each egress decision are shown and logged. Whether a local model lane runs usefully on this hardware is NOT VERIFIED.
- **Security:** no secrets in the repo; secret scan in CI; untrusted text never enters the instruction channel; least-privilege Zetaris identity.
- **Honesty:** known limits shown in the product and the README; every constructed input labelled "constructed"; no unmeasured number in any public text.
- **Readiness beyond tests (C-15):** clean install on two operating systems, resource and latency budgets, automated accessibility checks plus keyboard review, a privacy review, update behaviour, and moderated user sessions. The product is not described as ready for production use until these exist.

## 7. Experience

Sakaime is an investigative workstation, not a chat window.

Three experiences, not eight separate screens:

**Discover** (analysts and technical reviewers): the **Source Console** (sources, health, schema, freshness, the Add-a-source flow, federated query details) and the **Evidence Matrix** (the federated result with source badges and the SQL one click away).

**Investigate** (the evidence workstation): **Claim X-Ray** (claim, supporting and non-supporting sources, the five dimensions What, Who, Where, When, Why with CONTAINED / NOT_CONTAINED / UNKNOWN per source, the exact page and quote), the **Applicability Lab** (version, population, setting, purpose and date; labels recompute at once, with no model call) and the **Evidence Timeline** (what changed and when; time-travel selector).

**Decide** (the committee's output): the **Review Desk** (cases, unresolved high-impact questions, evidence that changed since last review), the **Missing-Evidence List**, reviewer actions (accept, narrow, request evidence, escalate), decision history, export and the signed **Dossier**.

Five acceptance details from the review: every key finding is clickable to the original page, highlighted passage, source date and the rule that used it; uncertainty is stated in words ("study version not established"), not as a bare percentage; each unknown shows what would settle it, specific enough to send to a vendor; the Applicability Lab recomputes without a model call; every finding says whether it concerns regulatory authorization, reporting completeness, empirical performance, institutional policy or an unresolved clinical judgment. Unresolved items form a bounded list with the next evidence request, not an endless investigation.

Visual direction: the Blank brand kit already chosen for our products (ink on white, a single green accent, a rust red for failure, Outfit and JetBrains Mono, a redaction-bar motif, a terse voice). Findings use words and icons, not colour alone.

## 8. Data policy for the demonstration

- **Real:** FDA AI-enabled device list and linked records, openFDA device endpoints, ClinicalTrials.gov, PubMed and Europe PMC records, Crossref metadata, FDA summary documents. All recorded as small hashed cassettes with retrieval dates; licences and terms checked and listed.
- **Constructed and labelled:** the vendor packet, the hospital requirements and the review database. No contradiction is presented as a finding about a real vendor. The constructed vendor claim is compared with real regulator and study records, and the screen says so.
- **Case choice (from the feasibility probe, 2026-10-27, 12 real devices):** the FDA summary PDF is the primary, citable record (identifier, indication, population, setting, sites, sometimes version); external studies are candidate links labelled EXACT, STRONG, WEAK or NONE with the reason. Candidate demo devices, each showing a different real mismatch: **EyeArt (K200667)**, the one device whose chain FDA summary to NCT03112005 to a PubMed abstract naming "version 2.1.0" is machine-checkable end to end (the clean case); **Transpara (K221347, 1.7.2)** versus the MASAI trial abstract that says "version 1.7.0" and a later 2.x clearance (true number, different version); **Lunit INSIGHT CXR Triage (K211733)**, cleared for pleural effusion and pneumothorax triage while independent studies use the same brand for tuberculosis screening at versions 3.1.0.0 and 3.9.0.1 (different intended use and version); **Viz LVO (DEN170073)**, where FDA says "initial version 1.0" but GUDID lists eleven versions 1.1 to 1.11 under one De Novo and a registered trial cites the De Novo number. The final case is chosen after full-text reading and a second reader; none is a finding about a vendor until then.
- **Feasibility facts that shape the product** (`reports/feasibility-report.md`): all 1,593 K/DEN numbers on the FDA AI list (1,614 rows, current as of 2026-09-04) resolve in openFDA; intended-use text is only in the summary PDFs (extractable 59 of 59 sampled); a version label per submission exists for only 53% via GUDID; an exact identifier crosses between FDA summary and registry in only 3 of 12 devices and 1 of 59 sampled summaries; the study text states the FDA-reviewed version for 1 of 12; 11 of 12 devices have a version or identity conflict between FDA summary, GUDID and study text; 6 of 12 have a name collision (the bare name "ContaCT" matches 446,198 PubMed records). FDA blocks scripted download of the list, so the CSV is a pinned snapshot fetched once in a browser.

## 9. Success measures

Proposed targets, not results:

- **Safety first:** false-supported rate on the held-out set at zero observed errors, reported with the denominator and an upper confidence bound (a zero in a sample is not zero in the world).
- Critical mismatch recall at least 0.90 on the controlled set against the strongest baseline's measured value; report the gap, not just the number. Measured on authentic claims (`../evals/RESULTS.md`): 13 of 20 (65.0 percent) on the 26 development claims and 12 of 15 (80.0 percent) on the 20 held-out claims, so the target was not met.
- Do not optimise for refusal: also report the **false-alarm rate** (well-supported claims flagged) and the **correct-SUPPORTED rate**, so a system that refuses everything cannot look safe.
- Correct abstention on source-off drills 100% of runs in the suite.
- Identity matching: precision and recall on labelled pairs, plus correct abstention on ambiguous pairs.
- Change impact: exactly the dependent findings recomputed.
- Reviewer study (if independent reviewers are obtained): time to find the key mismatch and correctness with versus without the tool.

## 10. Positioning and competition

We do not claim that no one checks applicability. We claim a measurable, narrower difference to be tested: automatic discovery and federation of fragmented sources, identity resolution with ambiguity preserved, deterministic scope checking with minimal counterexamples and counterfactuals, and change-triggered re-evaluation.

First-hand teardown, read 2026-10-27 (`reports/competition-report.md`, public pages only; enterprise products behind demos may do more):

- **Strongest threat: Constat (constat.dev, Health AI).** A free MCP endpoint returned, for a real device (DEN170073), page-quoted study design, sample size, sites, demographics, generalizability and change-control fields, with predicate chains, weekly refresh and a watchlist diff. It has no claim input, no ClinicalTrials.gov or PubMed join and no applicability verdict in what we saw. Its buyers are regulatory and market-access teams, not hospital procurement. Adding a join and a claim check would be incremental for them.
- **Closest in intent: HealthIT.com Evidence Explorer.** A claims ledger with a JSON API; the rows have no version, population, setting or intended-use fields, its gate checks that a quoted excerpt exists at the source, and the data is a frozen snapshot (2026-08-27).
- Others (HAIP forms, CHAI cards, Credo AI, ModelOp, Censinet, AI TrustMark, Scite, Consensus, Elicit, FDA list and viewers) are forms, vendor-authored cards, governance of the buyer's own models, or literature tools. None was seen joining FDA, registry and literature for one device and testing a claim against scope.
- **Existing three-source join:** a PLOS Digital Health analysis linked FDA-cleared devices to registered trials (34 of 1,357 linked, 3 with patient-outcome evaluation; via search snippets, to be re-read at source). Its method (PubMed search by device name, NCT ids scraped from 510(k) summary pages, NCT-to-publication links, manual review) shows the join is possible but exists as a one-off research pipeline, not a product we found.
- **Distribution threat:** if CHAI's registry or an EHR vendor makes the vendor-authored model card the default procurement artifact, demand for an independent check could fall.
- Mira Network: no licence is declared on its public repositories, so only ideas can be taken.

Gate G2 was left open until the same-input test in the report (real claims with known mismatches, run through Constat's free tier, HealthIT.com and Sakaime; a rival at 80% or more removes the gap) was run. It has been run on 26 development claims and 20 sealed held-out claims: the gap against the two incumbents stands on that rule, and the full pipeline is less often exactly right than a generic Nemotron call on the same documents (`DECISIONS.md`, G2; `../evals/RESULTS.md`).

## 11. Risks and kill criteria

| Risk | Consequence | Mitigation or kill rule |
|---|---|---|
| Public device-to-study links are too sparse or too ambiguous | No authentic case | Feasibility gate G1. If fewer than a defined share of sampled devices have an exact or strong link, pivot the engine to a domain with objective labels (construction addenda, tariff revisions) per `DECISIONS.md` |
| No clinical domain reviewers | Authentic set unadjudicated | Label results "builder-adjudicated, not independent"; recruit reviewers; never claim clinical validity |
| Incumbents already check applicability | No gap | Gate G2: a task where a reasonably configured alternative cannot give equal results, shown on identical inputs; otherwise pivot |
| Zetaris REST tables cannot parameterise APIs | Weaker live federation | Snapshot-through-filestore route (`03`) |
| Looks like Track 2 | Mis-scored | Source Console and add-a-source lead the demo; the compiler follows |
| Overclaiming in a health domain | Reputation, rules | Closed label set, banned phrases, limits in product |
| Exception scope (a second entry) unclear | Eligibility | Preserve the written letter; confirm scope in writing before first commit |
| Cursor requirement: moderators say optional (22 and 24 Oct, rules reminder); the Official Rules text we hold says required | Eligibility | Resolved in practice (D-012); confirm on the live rules page; log any Cursor use truthfully |
| Rigor mistaken for demand | Impact score, wasted build | Gate P is tracked separately; no engineering result is cited as demand |
| Sparse identifiers produce endless unresolved work | Unusable product | Bounded unresolved list with next request; turn and budget caps |

## 12. Open questions for the owner

1. The text of the organizers' written permission (deadline, additional entry, code and commit-window terms).
2. Whether any clinician, hospital informatics or procurement contact can be reached for reviewer validation and a buyer interview.
3. Whether a healthcare flagship is acceptable if gate G1 or G2 fails, or whether to pivot immediately to the construction-addendum pack as the flagship.
4. Confirmation of the live rules page on Cursor (moderators say optional; D-012). Optional: the channel message about `metadata.json` if one exists beyond the community draft (D-023).
