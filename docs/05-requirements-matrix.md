# Requirement-to-implementation-to-test-to-evidence matrix

Status 2026-10-27 (v0.2, revised after the outside review in `10-review-disposition.md`): every row is NOT STARTED unless it says otherwise. Every result recorded here is tagged by what it supports: **[T1]** Track 1 capability, **[REL]** scientific reliability, **[DEM]** demand. Passing one never counts as passing another. A row turns PASS only with the named evidence, produced by a run, with a source-of-truth read. States are PASS, FAIL, PENDING, BLOCKED (BLOCKED means three serious attempts, written down). Source precedence: the live HackOS page, Official Rules and written organizer decisions; then the supplied guides; then verified sponsor contracts; then our design. Organizer wording is in the sibling project's notes (not in this repository) (read-only). The companion standard `reference/validwhen-track1-winning-standard.md` supplied the first draft of the event rows.

## A. Organizer rules and submission components

| Id | Requirement | Implementation | Test | Evidence | Status |
|---|---|---|---|---|---|
| O-01 | Track 1 only, one primary track; consistent in HackOS, video, deck | metadata in README, deck, form text | submit-check script | form text + deck slide 1 | NOT STARTED |
| O-02 | Real problem, named user, real output | PRD sections 2, 3; Review Desk | reviewer study or labelled absence | study record or NOT VERIFIED note | NOT STARTED |
| O-03 | A working agent system, not a pipeline: at least three collaboration behaviours visible | investigation loop (`02` s11) | trace-behaviour test: planner delegation, tool use, critique, revision, uncertainty branch, fallback, shared state, evidence | JSONL trace + trace review | NOT STARTED |
| O-04 | Zetaris required with a real, output-changing role | `src/sponsors/zetaris` | ZA-1..ZA-8 | query ids, cassettes, ablation table | NOT STARTED |
| O-05 | Meterless required with a real, output-changing role | `src/engines/*` | conformance + MA-1..MA-5 | runner output, ablation table | NOT STARTED |
| O-06 | NVIDIA Nemotron where it contributes; route disclosed | model port, Nightshift route | receipt coverage; role-removal ablation | receipts in dossier | NOT STARTED |
| O-07 | Cursor: optional per moderator statements of 2026-10-22 and 2026-10-24 and the rules reminder (CONFIRM on the live rules page; the Official Rules text we hold says required). Use it if useful and log it truthfully; claim nothing beyond the log | `cursor-usage-log` | n/a | log entry or an empty log with the explanation | PROVISIONALLY RESOLVED: moderators say optional; the live rules page is not yet confirmed |
| O-08 | Bounded and predictable: timeouts, capped retries and turns in code | ports, loop budgets | fault-injection suite | test output | NOT STARTED |
| O-09 | Offline and keyless judge path | `SAMPLE_MODE` cassettes | clean-clone run, no key, byte-equal labels | recorded transcript | NOT STARTED |
| O-10 | Open, lawful, light data; no PHI | fixtures manifest | repo size check, secret scan, licence list | manifest + scan output | NOT STARTED |
| O-11 | Trace of the why of each decision | JSONL per run | schema test | `output_examples/traces/` | NOT STARTED |
| O-12 | Sample inputs and outputs committed | `input_examples/`, `output_examples/` | clean-clone | files | NOT STARTED |
| O-13 | No secrets; `.env.example` placeholders | gitignore, scanner | secret scan incl. history | scan output | NOT STARTED |
| O-14 | Pre-existing and third-party code declared in the **Description and the README** (what existed before 22 Oct, what was built during the event): vendored Meterless references, public datasets, studied open-source mechanisms, the design experience from the sibling project | `docs/provenance.md`, NOTICE | licence audit, first-commit audit | audit output | NOT STARTED |
| O-15 | Demo video 1 to 4 minutes covering the full flow and the sponsor effects | video project | length gate, chapter check | file + link | NOT STARTED |
| O-16 | Slide deck with problem, solution, architecture, stack, sponsor roles, visuals, future work | deck | outline checklist | PDF | NOT STARTED |
| O-17 | README runnable by a stranger; repository is **public on github.com** (the form accepts only GitHub URLs) | README | clean-clone literal run | transcript | NOT STARTED |
| O-18 | Sponsor technology explanation naming code paths and traces | `docs/submission/` | claim-to-code check | document | NOT STARTED |
| O-19 | HackOS entry accurate; the written exception preserved, with its exact scope for a second entry, the commit window, team rules, code provenance and judging eligibility checked one by one (an exception on time is not an exception on other rules) | form | manual | screenshot, letter on file | OPEN (letter text needed, gate G0) |
| O-21 | Repository-root `metadata.json` following the community draft schema (D-023), validated with ajv, every listed path exists; organizer format unconfirmed | `metadata.json` | `tests/metadata.test.ts` plus ajv validation | the file and the validation output | NOT STARTED (format OPEN) |
| O-22 | **Nightshift is the primary AI provider** and does real work; in any judge-run or hosted mode Nightshift is reachable where the app runs, or the mode says it is using another provider | model port, README, sponsor explanation | receipt coverage, provider trace | receipt log | NOT STARTED |
| O-23 | **Zetaris judging core**: onboard and query sources, a Unified Semantic Layer queried through the product, a data-quality rule, and a written reflection (how it saved time, how it helps, how to improve it) | `src/sponsors/zetaris`, `docs/zetaris-usl-reflection.md` | USL query test, DQ rule test, reflection present | query ids, DQ output, document | NOT STARTED |
| O-24 | One-command offline judge: `npm run judge` re-verifies the dossier hash, re-runs the compiler on recorded inputs, replays the source-off drills and prints PASS or FAIL per claim, no keys | `scripts/judge` | run on a clean clone in under 2 minutes | transcript | NOT STARTED |
| O-20 | Safety wording: no overclaim, no diagnosis, no certification | closed label set; wording lint | lint + guard tests | lint output | NOT STARTED |

## B. Judging criteria

| Id | Criterion (points) | What must be shown | Evidence |
|---|---|---|---|
| J-1 | Impact (30) | named reviewer, real decision, reviewer study or an honest absence, buyer or domain input | study record; competition report |
| J-2 | Technical (20) | discovery, federation, identity, temporal, compiler, recovery; tests; reproducibility | test suite, ablations, clean-room runs |
| J-3 | Innovation (15) | minimal counterexample, counterfactual lab, change-triggered re-evaluation, add-a-source | comparison against baselines on identical inputs |
| J-4 | Demo (15) | one authentic case; source failure that changes the answer correctly | video; `07-demo-and-submission.md` |
| J-5 | Product and UX (10) | workstation, not chat; accessibility | screenshots reviewed; keyboard and contrast checks |
| J-6 | Sponsor Tech (10) | ablations that change outputs; code paths | ablation tables |

## C. Track 1 tests (made measurable)

| Id | Test | Pass condition | Baseline for comparison |
|---|---|---|---|
| T1 | **Unknown-schema discovery**: a source with an altered field name or layout unseen in development, plus a semantic mutation (unit, scale or meaning) | mapped and validated, or declined with a reason; no code change; the semantic mutation is caught | hardcoded ETL fails |
| T2 | **Cross-source-only answer**: a finding that needs regulator + registry + document + local vendor/hospital data | the same finding is unreachable from any single source; Zetaris query id and source ids recorded | each source alone |
| T3 | **Identity ambiguity**: two similar devices or trials, one true match | true match found, false match not merged, ambiguous pair left AMBIGUOUS | fuzzy-name merge |
| T4 | **Temporal and authority conflict**: newer vendor claim vs older controlled study | authority respected for the assertion type; newer text does not win | take-latest |
| T5 | **Changed-source re-evaluation**: change a source or the reviewer-confirmed use | only dependent findings recomputed; old reasoning kept | full recompute without dependency tracking |
| T6 | **Source-off and degraded query**: disconnect FDA or the registry; separately stop Zetaris; inject a partial result and an unsupported predicate | outcome becomes INSUFFICIENT_EVIDENCE with a degraded reason (described as unresolved in the UI) when the source is required for the claim, never "supported"; a lost corroborating source is shown without changing the label; clean continuation per policy | silent fallback |
| T7 | **Ablations**: remove Nemotron critic, each Meterless engine, identity resolver, federation, compiler | effects reported; components that change nothing removed | full system |
| T8 | **Decision usefulness**: two independent reviewers, source-by-source vs Sakaime | time and correctness recorded; disagreements kept | manual research |

## D. Invariants (each has a property or integration test)

| Id | Invariant | Test |
|---|---|---|
| I-1 | Unknown is not false and not safe; outage, empty and unindexed are distinct | drills T6 + unit |
| I-2 | Claim-supported is not use-supported | compiler tests |
| I-3 | Regulatory status is not clinical effectiveness | wording lint + label table tests |
| I-4 | A model hypothesis is not a verified link | identity tests |
| I-5 | Signed evidence is not true evidence | verifier docs + tamper test |
| I-6 | A strong synthetic test is not demand | wording lint on claims; README limits |
| I-7 | Authority before recency | T4 |
| I-8 | Every extracted number has a verified anchor | quote-exists test |
| I-9 | The label set is closed | type + property test |
| I-10 | Replay gives the same labels | O-09 replay test |

## E. Corrections adopted from the outside review (acceptance tests)

Each correction is closed only when its test passes. IDs are referenced from `10-review-disposition.md`.

| Id | Correction | Acceptance test | Supports |
|---|---|---|---|
| C-01 | Authority by assertion type | a study cannot widen an authorization's scope; a regulator record cannot override a study's measured result; a later vendor claim never wins; the matrix rows are exercised on real records | [REL] |
| C-02 | Typed identity links | a shared submission number yields SAME_SUBMISSION only; Viz LVO's eleven GUDID versions under one De Novo are not merged into one release; Transpara 1.7.0 vs 1.7.2 stay separate | [REL] |
| C-03 | Safe source onboarding | SSRF suite: private, loopback, link-local and metadata addresses, DNS rebinding, redirect to internal, non-https, oversized responses, non-allowlisted hosts are all refused with a reason | [T1] |
| C-04 | Semantic schema validation | semantic mutation set: percent vs fraction, population vs target population, swapped identifier types, null codes, duplicate keys; each rejected or sent to review; renames mapped | [T1] |
| C-05 | Quote-exists and semantic support, separately | planted cases where the quote exists but supports a different subject, version or threshold; both checks reported; semantic-support error rate measured | [REL] |
| C-06 | Containment invariants (no label ranking) | property tests (a) and (b) of `02` s10 hold on generated scopes | [REL] |
| C-07 | Contrary evidence by relevance and credibility | relevant adequate contradiction gives CONTRADICTED; weak or off-scope gives REQUIRES_DOMAIN_REVIEW; a SUPPORTED label without a recorded disposition is impossible | [REL] |
| C-08 | Dependency-aware degradation | lose a required source: INSUFFICIENT_EVIDENCE with the reason in `degraded` (there is no sixth label); lose a corroborating one: displayed, label unchanged | [T1] [REL] |
| C-09 | Consistency tests separate from domain-validity tests | the report names which suite each number comes from; no consistency result is described as clinical correctness | [REL] |
| C-10 | Cluster-aware statistics | effective sample size reported; intervals by cluster bootstrap by device; no split puts one device or study family in both partitions | [REL] |
| C-11 | Cases chosen after a hand-proven chain | each case has a manifest with identifiers, quotes, a second reader and disagreements before it enters a suite | [REL] |
| C-12 | Fair ablations | three-arm Zetaris comparison; Meterless ablations measure real effects; a null result is published and the claim is dropped | [T1] |
| C-13 | Receipt verification | invalid, replayed, wrong-key and wrong-model receipts are rejected; coverage of model-derived fields reported | [REL] |
| C-14 | Data classes and egress | vendor-confidential content cannot reach a remote model without recorded consent or a local lane; masked values never appear in prompt logs | [REL] |
| C-15 | Readiness beyond tests | clean install on Windows and Ubuntu; resource and latency budgets; axe plus keyboard review; privacy review; update behaviour; moderated user sessions if any | [DEM] [T1] |
| C-16 | PMF tracked separately | gate P has its own evidence file; no engineering metric appears in a demand claim | [DEM] |
| C-17 | Idempotent external effects | kill and resume at each step: no duplicate source registration, decision or export | [T1] |

## F. Track 1 completion standard (from the review, kept above the detailed rows)

| Requirement | Completion evidence |
|---|---|
| Meaningful problem | independent industry evidence, a named buyer and a real decision [DEM] |
| Track 1 discovery | an unknown source schema discovered and meaningfully incorporated (T1, C-03, C-04) |
| Multiple fragmented sources | a real query across heterogeneous, independently maintained systems (T2) |
| Cross-source reasoning | at least one necessary answer cannot be obtained from a single source (T2) |
| Conflicting information | contradictory identities, authority and revisions handled correctly (T3, T4, C-01, C-02) |
| Working agent system | planning, tool use, branching, critique and bounded revision visible in traces (O-03) |
| Zetaris | real federation, setup, traces and a fair comparison (O-04, C-12) |
| Meterless | actual engines, conformance, memory, measurable contributions (O-05, C-12) |
| NVIDIA Nemotron | model responsibilities and valid call records (O-06, C-13) |
| Reproducibility | fresh clone, bounded execution, keyless sample path (O-08, O-09) |
| Security | secret scans, guarded source onboarding, least privilege (O-13, C-03, C-14) |
| Impact | independent evidence that the problem matters and a user-value evaluation [DEM] |
| Innovation | a same-input comparison showing the new contribution (gate G2) |
| Technical depth | integration tests, source failures, property tests, documented limits |
| Product experience | accessible, understandable investigation and review workflow (C-15) |
| Demo | the real product on authentic data with verifiable outputs (O-15) |
| GitHub | code, README, sample inputs and outputs, licence information (O-12, O-14, O-17) |
| Pitch deck | problem, product, architecture, sponsor roles, measured results, limits (O-16) |
| Eligibility | organizer exception, separate entry, team, actual tool use, code provenance and submission details verified (O-07, O-14, O-19) |
