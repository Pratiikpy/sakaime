# Sakaime: architecture specification

Status: design contract, v0.2, 2026-10-27 (revised after the outside review; every ruling is in `10-review-disposition.md`). Nothing here is implemented. Every external fact carries a tag: **[VERIFIED]** (read or run by us, source named), **[SECONDARY]**, **[HYPOTHESIS]**, **[NOT VERIFIED]**. Read with `01-prd.md`; sponsor depth is in `03-zetaris-plan.md` and `04-meterless-plan.md`; tests are in `05-requirements-matrix.md` and `06-evaluation-protocol.md`.

## 1. The one sentence

Sakaime discovers evidence scattered across regulators, registries, literature and a hospital's own records, resolves which records describe the same product, study and version, and then checks, dimension by dimension, whether that evidence covers the exact use a buyer has in mind, returning only as broad a conclusion as the evidence permits.

## 2. Design principles (each is testable)

1. **Discovery is the centrepiece.** Track 1 asks for a clever ability to discover and work across fragmented sources. A source added at run time, with a schema never seen in development, must be onboarded without code changes (section 5).
2. **Division of labour.** Connectors fetch. Zetaris federates. Deterministic code computes, verifies and decides labels. Nemotron proposes (mappings, extractions, identity adjudications, objections, prose). Humans own clinical judgement and the procurement decision. A model proposal never becomes a fact until a deterministic check or a reviewer accepts it.
3. **Three-valued everywhere.** Every comparison returns CONTAINED, NOT_CONTAINED or UNKNOWN. Unknown is never treated as false and never as safe. Source outage, empty result and "not indexed" are three different states.
4. **Authority depends on the question, and comes before recency.** There is no single hierarchy of sources. Each assertion type has its own authoritative source (section 4, authority matrix). A later document is not a stronger one; time decides only among sources that are equally authoritative for that assertion type.
5. **Replayable.** Every finding can be recomputed offline from recorded inputs and gives the same label. One changed byte in a source snapshot makes verification fail.
6. **Every component earns its place.** Each sponsor integration and each agent role has a pre-registered ablation (`06`). A component that does not change an outcome is removed, not defended.
7. **No safety verdicts.** The system never outputs "safe", "cleared" or "compliant". Labels describe evidence coverage only.

## 3. Layer map

```
 Reviewer question + intended use (ClaimedUse)
        |
 [L0] Scout Intent guard        intent, risk, routing; untrusted-text quarantine
        |
 [L1] Source Discovery Fabric   catalog, probe, schema-map, health, onboarding
        |
 [L2] Zetaris federation        one SQL over JDBC + REST + files; row/column policy; audit
        |
 [L3] Identity resolution       exact ids first, explainable probabilistic band, reviewer-confirmed links
        |
 [L4] Extraction                anchored parse, chunked long-document reading, verified quotes
        |
 [L5] Evidence memory           World Model (event-sourced bi-temporal facts), H-MEM (confirmed links, precedents, trust)
        |
 [L6] Applicability Compiler    typed scopes, containment lattice, minimal counterexample, requirements, counterfactuals
        |
 [L7] Investigation loop        Nemotron roles: plan, discover, resolve, extract, critique, report (bounded)
        |
 [L8] Dossier + review          findings, lineage, signed receipts, reviewer decision, offline verifier
```

Layers 1 to 6 are libraries with typed interfaces and no model dependency except where stated. Layer 7 orchestrates them. The UI reads Layer 8 only.

Mapping to the nine systems named in the outside review: Review Workspace = UI plus L0; Discovery Fabric = L1; Zetaris Federation = L2; Identity and Evidence Graph = L3 plus L5; Document Intelligence = L4; Evidence Investigation Engine = L7; Applicability Compiler = L6; Evidence Dossier = L8; Human Decision and Monitoring = the Decide experience (`01` s7) over L8 and L5.

## 4. Data model

All types are versioned JSON schemas under `schemas/`, validated at every boundary (Zod in TypeScript).

Entities (each has its own id and never stands in for another): `Manufacturer`, `ProductFamily`, `MarketedDevice`, `SoftwareRelease`, `AuthorizationSubmission` (510(k), De Novo, PMA), `Study`, `RegistryEntry` (with history), `Publication`.

**Typed links**, each with its own state. A link is a statement of exactly one relationship:

| LinkType | Meaning | Example evidence that can support it |
|---|---|---|
| `SAME_SUBMISSION` | two records describe one authorization | shared K, DEN or P number |
| `SAME_PRODUCT` | two records describe one product line | manufacturer + product code + name match, confirmed |
| `SAME_MARKETED_VERSION` | two records describe one software release | version string in both, or GUDID version tied to the submission |
| `STUDY_EVALUATES` | a study evaluated this product (and which release) | NCT or K/DEN number in both, or the study text names the product and version |
| `PUBLICATION_REPORTS` | a publication reports this study | NCT in the paper, registry reference list |
| `SUPERSEDES` | a record replaces another | explicit supersession in the record |

`LinkState`: `CONFIRMED` (exact identifier for that link type, or reviewer), `CANDIDATE` (score and waterfall), `AMBIGUOUS`, `REJECTED`. A shared submission number proves `SAME_SUBMISSION` and nothing more: it does not prove that every marketed release is clinically identical (feasibility: one De Novo with eleven GUDID versions).

**Authority matrix (by assertion type).**

| Assertion type | Authoritative source | Never authoritative for it |
|---|---|---|
| What use was authorized (indications, population, setting limits) | the regulator record (decision summary, letter, classification) | a study, a brochure |
| What performance a study reported | the original study report and its data | a vendor summary, a press release |
| Which software release is currently marketed | version-specific product documentation, corroborated by GUDID or labelling | a study abstract |
| What this hospital requires | the hospital's approved policy (the synthetic review database) | any external source |
| What the vendor asserts | the vendor packet, only as a claim to be checked | itself |
| That a study exists or does not exist | the registry and bibliographic sources searched, with date and query | the FDA list (it is "not comprehensive") |

A study cannot redefine an authorization's scope; a regulator record cannot overwrite a study's measured result. Public absence is "none found in source X on date D", never "none exists".

**Typed contracts** (conceptual; Zod schemas under `src/schemas/`, versioned):

- `Source`: `id, kind, access (zetaris|connector|file), descriptor, license, schemaHash, health (OK|EMPTY|UNAVAILABLE|FORBIDDEN|DRIFTED|STALE|BLOCKED), lastSuccessAt, dataClass`.
- `EvidenceRecord`: raw payload plus `sourceId, retrievedAt, sourcePublishedAt?, validFrom?, validTo?, requestHash, contentHash, schemaVersion, license`. Immutable; a newer fetch is a new record.
- `EvidenceAnchor`: `recordId, page?, jsonPath?, region?, text, textHash`.
- `EvidenceAssertion`: `subjectId, predicate, value, unit?, appliesToVersion?, anchor, extractionMethod, quoteVerified, supportVerified, verificationState`. Quote-exists and semantic support are separate fields (section 8).
- `ClaimedUse` and `EvidenceScope` share dimensions: `product+version, population, setting, purpose, timing, outcome/metric, comparator`; each holds a typed value or UNSPECIFIED. Each claim also declares `sourceDependencies` (required, corroborating, optional).
- `Fact` (bi-temporal): `subject, predicate, object, validFrom, validTo, recordedAt, supersededAt, sourceId, assertionType, anchor, hash`. History is never deleted.
- `Finding`: `claimId, label, mechanicalCoverage (per dimension), expertReviewFlags[], mismatches[] (minimal counterexample), requiredEvidence[], dependsOnFacts[], sourceDependencies, ruleVersion, traceId, reviewerState`.

**Two histories, never merged.** Evidence history records what each source said at each recorded point. Decision history records what Sakaime concluded, from which record versions, and what reviewers decided. A newer source never rewrites an earlier finding: the finding is re-evaluated, the old one is kept, and the new one references it with the reason.

Labels: `SUPPORTED_FOR_SCOPE`, `SUPPORTED_ONLY_FOR_NARROWER_SCOPE`, `CONTRADICTED_BY_SPECIFIED_EVIDENCE`, `INSUFFICIENT_EVIDENCE`, `REQUIRES_DOMAIN_REVIEW`. No other label exists in the type.

## 5. L1 Source Discovery Fabric (the Track 1 centrepiece)

Goal: given a question, find which sources can answer which part, learn their shape, and make them queryable, including a source nobody wrote an adapter for.

Pipeline for any new source (eight stages; a source that fails a stage stops there with the reason shown):

1. **Authorization.** Allowlist-first: sources come from approved families (registered cards). A pasted URL must resolve inside an allowed host list or be refused. The fetcher is SSRF-safe: https only, method GET, resolved addresses checked against private, loopback, link-local and cloud-metadata ranges, DNS pinned for the request, every redirect re-validated, response size and time capped. No credentials are forwarded.
2. **Capability discovery.** Catalog first: ask Zetaris what exists (`SHOW LIGHTNING DATABASES`, `SHOW TABLES IN <db>`, table metadata, tags) [VERIFIED for the first two statements]. For an external API read the source card (identifier fields, pagination, filters, limits, cadence, licence).
3. **Bounded probe.** A request limited to a few rows; hash the response shape (schema fingerprint); compare with any stored fingerprint. A changed shape raises a drift event instead of silently mis-mapping.
4. **Mapping proposal.** Nemotron proposes a field-to-canonical mapping from the sample and the card.
5. **Semantic and cross-source validation (deterministic).** Types are the easy part. Also check units and scale (a "sensitivity" in 0 to 1 vs 0 to 100), value ranges and distributions against the canonical field's expectations, identifier patterns (K, DEN and P numbers, NCT ids, PMIDs, DOIs), null and missing-value codes, date semantics, duplicate keys, and sample joins against records we already hold (does `device_id` join to known submissions at the expected rate). A field renamed from `device_name` to `product_name` is an easy mutation; percent to fraction or "study population" to "target population" is a hard one, and both are in the unknown-schema suite.
6. **Human review.** Uncertain or security-sensitive mappings are held until a reviewer accepts them. An accepted mapping is stored in H-MEM with its schema hash so the same shape is not asked again.
7. **Registration.** A passing source is registered with Zetaris (REST table, JDBC source or filestore table). If Zetaris cannot parameterise a REST request for that API [NOT VERIFIED, gate Z-REST in `03`], the fabric lands a normalised, provenance-preserving snapshot into the evidence lake (an S3-style filestore table) and Zetaris joins the snapshot; the record keeps the live request hash either way. Registration carries an idempotency key.
8. **Monitoring.** Track schema drift, changed records, access failures and stale snapshots; each raises a World Model event that marks dependent findings stale.

Source cards are declarative YAML (base URL, auth none or key, rate limit, identifier fields, pagination, update cadence, licence, data class). Each source exposes four verbs borrowed from the Airbyte protocol: `describe`, `check`, `discover`, `read`, plus a state checkpoint. `check` outcomes: OK, EMPTY (answered, no rows), UNAVAILABLE (timeout, 5xx, 429), DRIFTED (shape changed), FORBIDDEN, STALE (snapshot older than its declared cadence), BLOCKED (scripted access refused). `check` is a real probe (a `SELECT 1` through Zetaris, a bounded request to a public API), never a container healthcheck: a stopped Spark context keeps the healthcheck green while every query fails with HTTP 400. Messages such as "stopped SparkContext", "Could not create ResultSet: null" and thrift transport errors map to UNAVAILABLE (retry with backoff, then degrade). Only EMPTY may be read as "no records found", and even then the finding says "none found in source X on date D", never "none exist".

Add-a-source demo move: the reviewer chooses or pastes a source inside the allowlist and a one-line description; the fabric runs stages 1 to 7 and re-runs the same cross-source question.

Baseline for T1: a hardcoded ETL with fixed field names, which fails on the altered schema.

Source behaviours the `check` verb must tell apart (measured 2026-10-27, `research/feasibility/FEASIBILITY-REPORT.md`):

| Source | Empty result looks like | Outage or block looks like | Limit |
|---|---|---|---|
| openFDA | HTTP 404 with body `NOT_FOUND "No matches found!"` (read the body; status alone cannot tell it from a wrong path) | timeout, 5xx; malformed query is 500 or 400 | 240 requests/min and 1,000/day per IP without a key |
| ClinicalTrials.gov v2 | HTTP 200 with `{"studies": []}` | timeout, 5xx; bad parameter is 400 | published limit NOT VERIFIED |
| PubMed E-utilities | HTTP 200, `count 0` | timeout, 429 | 3 requests/s without a key |
| Europe PMC | HTTP 200, `hitCount 0` | timeout | NOT VERIFIED |
| FDA AI list (www.fda.gov) | n/a | scripted fetch redirected to an abuse-detection page (state **BLOCKED_FOR_SCRIPTS**: a pinned, hashed CSV snapshot is used and its date is shown) | browser fetch works |
| FDA summary PDFs (accessdata) | n/a | a missing PDF returns HTTP 404 with an HTML page, so check for `%PDF` as well as status | none seen |

The FDA list is BLOCKED for scripted access: a pinned, hashed CSV snapshot (fetched once in a browser) is used, shown with its date and handled like a stale snapshot, never like absence.

## 6. L2 Zetaris federation

Zetaris executes the joins. Our code never joins records in application memory except in the declared fallback path. Details, ablations and open verification gates are in `03-zetaris-plan.md`. Interface: `FederationPort { sql(statement, params, policyIdentity) -> {rows, total, queryId, servedFrom, respHash} }` with three modes: live, cassette (recorded real responses, for judges and CI) and fallback (local in-process engine, labelled degraded). Results whose `total` exceeds returned rows are refused as truncated, never used as partial answers. Zetaris is the federated query layer; DuckDB is used as an independent test oracle on frozen snapshots and, if ever used as a fallback, is labelled degraded and never presented as live federation. [VERIFIED pattern from the desk project, 2026-10-22; reimplemented here, not copied.]

## 7. L3 Identity resolution

Identity is a graph of the typed entities and links in section 4, not a single merged record.

Order of evidence for each link type:

1. **Exact identifier appropriate to the link**: a shared K, DEN or P number supports `SAME_SUBMISSION`; a shared NCT id supports `PUBLICATION_REPORTS`; a UDI-DI or GUDID version tied to the submission supports `SAME_MARKETED_VERSION`. A shared identifier never supports a different link type.
2. **Explainable probabilistic band** (Fellegi-Sunter in the style of Splink, MIT): blocking on normalised manufacturer and product code; comparison levels on name, manufacturer, version string and date proximity; m and u parameters trained on labelled pairs; a per-field match-weight waterfall shown to the reviewer. Highly correlated comparison fields distort probabilities, so the scores are calibrated on held-out pairs and reported as ranked evidence, not as calibrated probabilities of truth.
3. **Nemotron adjudication** only inside the uncertain band, only to propose, and it must cite fields.
4. **Reviewer confirmation** for any uncertain, high-impact link, stored in H-MEM with scope (organization, case) and version.

A candidate link is never promoted by a model alone. Two similar products with different versions stay separate; deliberately similar pairs, including the real collisions found in the feasibility probe (a bare "ContaCT" matches 446,198 PubMed records; a second product named MammoScreen exists), form the T3 corpus. Search uses vendor plus product plus condition in quotes, never the bare product name.

## 8. L4 Extraction

- Structured sources (openFDA JSON, ClinicalTrials.gov v2 JSON, PubMed XML) are parsed by typed code.
- Documents (FDA summary PDFs, open-access papers) go through a layout-aware parser (Docling-style, MIT) that keeps page and region. Text comes with an anchor.
- A second extractor is Zetaris itself: `FORMAT PDF` filestore tables return the extracted text (the preview length must be set; the default silently truncates at 1,000 characters). The two texts are compared; a disagreement lowers confidence and is shown.
- **Long documents** are read by the Meterless Markovian engine: fixed-size chunks with bounded carryover state, so context cost stays flat and a limitation on page 40 is carried to the verdict.
- Nemotron proposes typed extractions (population criteria, setting, software version, threshold, n, CI). Each assertion then passes **two separate checks**:
  1. *Quote-exists* (code): the quoted passage exists verbatim in the page text and the numbers parse. Failures are dropped and counted; unquoted extractions are discarded.
  2. *Semantic support*: does the passage actually state what the assertion claims (right subject, version, population, metric, threshold, and not a development-set or a different-module result)? Checked by deterministic pattern rules where possible, then by a second model call in a separate context that sees only the passage and the assertion, then by reviewer sampling. Its error rate is a reported metric (SupportShift sub-suite).
  A quote can exist without proving the relationship; provenance is not truth.
- Real parser hazards seen in two FDA summaries: performance goals redacted as "(b) (4)", OCR ligature damage, the version dropped in the (a)(2) device name, no data-collection dates and no software build. An absent field stays absent; it is never defaulted.

## 9. L5 Evidence memory

- **World Model** (Meterless, event-sourced): entities (device, authorization, study, claim, source), relationships and facts, appended as events. Supports time-travel ("what did we know on date D"), change events and dependency queries.
- **H-MEM** (Meterless): reviewer-confirmed identity links, accepted schema mappings, institutional precedents ("this hospital requires prospective validation for triage tools"), a trust ledger by source tier, and conflict resolution when two entries disagree. Nothing is stored unless a reviewer or a deterministic check confirmed it, so memory never launders a model guess into a fact.
- **Change impact**: every Finding lists the fact ids it used. When an event changes or retires a fact, only dependent findings are marked stale and recomputed; old reasoning is kept for audit.
- **Scoping**: every H-MEM record carries an organization and case scope. A hospital's precedent is never shared with another organization's case and never presented as universal clinical guidance.
- **Idempotency**: source registration, reviewer decisions and exports take idempotency keys, because a resumed investigation can re-run a node.

## 10. L6 Applicability Compiler (the distinctive invention)

Basis: published appraisal concepts, read first-hand on 2026-10-27 (`research/standards/APPLICABILITY-RULE-REGISTRY.md`, 38 candidate rules, each concept cited to a section or item number). PROBAST+AI defines the review question with PICOTS (population, index model, comparator, outcome, timing, setting and intended use) and rates "applicability" as three concern items per phase (participants and setting, predictors, outcome), each low, high or unclear, relative to the assessor's intended use. It has no applicability signalling questions. STARD-AI (40 items) and TRIPOD+AI define the reporting items that carry scope facts (eligibility, setting and dates, software version in STARD-AI item 13, thresholds, subgroup results, limitations). IMDRF SaMD N41 and the FDA PCCP guidance bound what a claim and a version change can mean (intended use vs indications for use; a version change does not by itself settle applicability).

**Honesty note carried from the registry: no standard prescribes deterministic applicability checks.** The concepts are cited; the executable logic and thresholds are our design inferences, open to clinician challenge. Anything contestable returns REQUIRES_DOMAIN_REVIEW. Two consequences already fixed: a claimed version with no evidence at all returns INSUFFICIENT_EVIDENCE, not "narrower scope" (a narrower scope must itself be contained in the evidence); and staleness windows and subgroup sample-size thresholds have no source threshold, so they also return REQUIRES_DOMAIN_REVIEW. The registry is committed under `docs/rules/` after our review.

Mechanism:

The compiler has **two outputs, kept separate**:

- *Mechanical evidence coverage* (computed): can code verify that the stated version, age interval, date, metric and named intended use match the supplied records? Each dimension is CONTAINED, NOT_CONTAINED or UNKNOWN, with the anchors that decided it.
- *Expert applicability assessment* (flagged, not computed): does the evidence establish meaningful generalisability, acceptable study quality or clinical suitability? These are `expertReviewFlags`; a rule that needs clinical interpretation returns REQUIRES_DOMAIN_REVIEW.

Mechanism:

1. **Containment per dimension.** Each dimension has a typed partial order: version (exact, same release line, unknown), population (age interval containment, condition set containment, exclusion conflicts), setting (ED < hospital < any care setting), purpose (a small taxonomy, e.g. triage-prioritisation < detection-aid < diagnosis), time (evidence period vs deployment date vs change-control boundary), metric operating point.
2. **Three-valued result** per dimension. Unspecified on either side is UNKNOWN, not CONTAINED.
3. **Label table** (deterministic). The five labels are *not* an ordered scale of better and worse.
   - All dimensions CONTAINED and every required source present and adequate: SUPPORTED_FOR_SCOPE.
   - Some dimensions NOT_CONTAINED, but a defined narrower scope is itself CONTAINED in the evidence: SUPPORTED_ONLY_FOR_NARROWER_SCOPE, with that scope stated.
   - A relevant, adequate source reports a result contradicting the claim in the same scope: CONTRADICTED_BY_SPECIFIED_EVIDENCE. Contradicting material that is weak, off-scope or low in credibility triggers REQUIRES_DOMAIN_REVIEW instead and must be dispositioned before any SUPPORTED label.
   - UNKNOWN on a required dimension, or a claimed version with no evidence at all: INSUFFICIENT_EVIDENCE.
   - Any rule flagged as needing clinical judgement: REQUIRES_DOMAIN_REVIEW.
4. **Dependency-aware degradation.** Each claim declares required, corroborating and optional sources. Losing a required source yields INSUFFICIENT_EVIDENCE with the reason shown in `degraded` ("unresolved" is a description of that state, never a sixth label); losing a corroborating one is displayed and lowers the explanation only.
5. **Minimal counterexample.** The smallest set of dimensions that are NOT_CONTAINED or UNKNOWN, the two values side by side, with anchors.
6. **Evidence requirements.** For each UNKNOWN or NOT_CONTAINED dimension, the exact kind of document or confirmation that would settle it, written specifically enough to send to a vendor.
7. **Counterfactual lab.** `compile(claimedUse, evidenceSet, ruleVersion)` is a pure, versioned function. Changing population, version, setting or date recomputes without a model call; explanation text is regenerated only from the new verified findings.
8. **Invariants checked by property tests** (fast-check), stated on containment, not on label order: (a) widening a claimed scope can only shrink the set of CONTAINED dimensions; (b) SUPPORTED_FOR_SCOPE for a wider scope implies SUPPORTED_FOR_SCOPE for each narrower scope inside it; (c) contrary evidence must carry a recorded disposition before SUPPORTED_FOR_SCOPE; (d) removing a source declared required never yields SUPPORTED_FOR_SCOPE; (e) identical inputs and rule version give the identical result; (f) no path emits a label outside the five.

## 11. L7 Investigation loop

A bounded state machine, not a free-running agent. Roles are responsibilities, several of them mostly deterministic:

| Role | Does | Model needed |
|---|---|---|
| Planner | Decomposes the question into sub-questions, picks sources, sets budgets | Nemotron, fallback to rule plan |
| Discoverer | Section 5 | Nemotron for mapping proposals only |
| Retriever | Runs Zetaris statements and connector reads | none |
| Resolver | Section 7, adjudicates the uncertain band | Nemotron, bounded |
| Extractor | Section 8 | Nemotron, verified by code |
| Critic | Tries to break each draft finding: unsupported leaps, wrong version, scope widening, uncited numbers | Nemotron adversarial, plus code checks |
| Compiler | Section 10 | none |
| Reporter | Writes prose only from verified findings; every sentence carries finding ids; code rejects sentences without one | Nemotron |

Controls: turn cap, per-call timeout, capped retries, budget per case, cancellation, idempotency keys on every external effect, and a published policy for each degradation (source down, Zetaris down, model down). Branching: on UNKNOWN the Planner may replan to a further source; on Critic objection the finding is revised or downgraded; on repeated failure the finding is left as INSUFFICIENT_EVIDENCE (or REQUIRES_DOMAIN_REVIEW) with the reason. Collaboration behaviours shown in traces: planner delegation, specialist tool use, evaluator critique, revision after critique, uncertainty branching, fallback, shared structured state, evidence in the answer.

## 12. L0 Scout Intent guard and security

- Intent and risk screening on every reviewer request and on every document-derived instruction: "certify this safe", "ignore previous instructions", requests to send data out, or write actions are refused or require confirmation. Execution contracts are signed (Ed25519) before any export.
- All fetched text is data. It is never placed in the instruction channel; extraction prompts treat it as quoted material. A prompt-injection corpus (vendor PDFs containing instructions) is part of the tests.
- Read-only by default for public sources and the hospital database; the Zetaris identity used by the agent has SELECT only. Vendor-confidential columns are masked by Zetaris policy for any identity not assigned to the case.
- No PHI in any fixture. The hospital database is synthetic.
- **Data classes and egress.** `public` records may be sent to the model. `vendor-confidential` content is processed by a local lane or sent only with recorded consent. `PHI` never enters the system. The active mode and every egress decision are visible and logged. Storage being local is not the same as processing being local, and the product says so.
- **Receipts.** A Nightshift receipt is verified for signature, key id against the installed application, routed model against the role map, and request and response hashes against what we sent and stored. A valid receipt shows where a response came from, not that it is true.

## 13. L8 Dossier and review

A dossier is a signed bundle: claim, ClaimedUse, findings, minimal counterexamples, requirements, source snapshots with hashes, Zetaris query ids and result hashes, model receipts (Nightshift), rule registry version, reviewer decisions. An offline verifier recomputes every hash and re-runs the compiler on the recorded inputs; any mismatch fails with a named reason. A signature proves integrity, not clinical truth. Both histories (evidence and decision) are included.

Lineage is emitted as OpenLineage-style events (run, job, input and output datasets with facets) so a finding can be traced back to the records, queries and extraction steps that produced it.

## 14. Runtime, modes, bounds

- Stack: TypeScript on Node 22+, Zod schemas, SQLite for local state, a small HTTP API, and a web UI. The Zetaris stack runs in Docker (WSL on Windows) [VERIFIED install, 2026-10-16, desk notes]; Postgres and file silos run beside it.
- **Sample-mode design (open policy question, `11-channel-intel.md` s4):** the compiler, identity scorer, verifiers and guard always execute for real on recorded inputs. Recorded model outputs are labelled recorded. A question that has no recording runs live when keys are present, or abstains visibly; it never invents an answer. The default mode is live when configured.
- `SAMPLE_MODE=true`: all external reads come from committed cassettes of real responses, Zetaris answers from a recorded cassette with query hashes, and the model route uses recorded calls. A judge needs no key and no Docker for this path.
- Live mode needs Docker for Zetaris, Nightshift (or an NVIDIA key) for the model. Every external call has a timeout and a cap; a full case run targets minutes, not hours.
- Traces: one JSONL file per run with the reason for each decision.

## 15. What is borrowed, and what we do differently

| Source | Mechanism | Licence | Our change |
|---|---|---|---|
| Trino SPI | Source declares what it could not push down; engine applies the residual | Apache-2.0 | Each source card lists supported predicates; residuals are applied in code and recorded |
| Airbyte protocol | spec/check/discover/read/state contract | MIT | Adds DRIFTED and EMPTY vs UNAVAILABLE as first-class results |
| Splink | Explainable probabilistic linkage | MIT | Reviewer-confirmed links override scores; uncertain band never auto-merges |
| Graphiti | Bi-temporal facts, edge invalidation | Apache-2.0 | Authority outranks recency; contradicted facts are kept, not expired silently |
| Docling | Layout-aware parse with provenance | MIT | Quote-exists verifier on every extracted value |
| OpenLineage | Run/job/dataset facets | Apache-2.0 | Facets carry anchors and rule versions |
| Meterless engines | H-MEM, World Model, Markovian, Scout Intent | Apache-2.0 | Used with specific tests and ablations (`04`) |

Studied but not adopted: Cognee (general memory layer), Onyx (licence split not cleared), LangGraph (only if our own bounded state machine proves too costly). Mira Network is a reference for the idea of claim decomposition only; its public client is described as proprietary and nothing from it is used.

## 16. Failure modes this design must survive

Source outage during a run; empty vs unavailable; changed schema; identical-looking device names; same device, different version; newer vendor brochure vs older controlled study; retracted or corrected paper; registry record updated after a finding; Zetaris down; model down or returning invalid JSON; prompt injection inside a PDF; truncated federated result; clock skew in dated records; duplicate studies reporting one trial; a mapped field whose unit silently changed; a pasted URL that resolves to an internal address or redirects to one; a quote that exists but does not support the assertion; a corroborating source lost while the required ones remain; a resumed investigation repeating a registration or a decision; a valid receipt attached to a wrong model. Each has a named test in `05-requirements-matrix.md`.
