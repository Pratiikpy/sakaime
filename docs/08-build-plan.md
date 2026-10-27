# Build plan: gates, order, method, resources, status

Status 2026-10-27, end of the first build day. The design and the outside review (`10-review-disposition.md`) were turned into an order of work with stopping conditions; the code, the evaluation suites and the web app now exist. Gates are quality gates, not dates. A gate passes only with its evidence in the requirements matrix (`05`), and the measured results are in `../evals/RESULTS.md`.

## 0. Where each gate stands

| Gate | State | Passed | Not passed, and why |
|---|---|---|---|
| 0 Competitive and source feasibility | PARTIAL | The EyeArt chain is established at identifier level. The 26-claim same-input test ran: Constat gives no verdict (a reviewer could re-derive the key for 7 of 26), HealthIT.com 0 of 26. The Gate 0 rule says the gap stands | Sakaime's own arm does not reach 0.80 and is less often exactly right than the generic Nemotron arms. The written organizer exception (G0) is not on file in the repository. The key was edited after a dry run (ERRATA E-001), so all 26 claims are development. No independent second reader |
| 1 Source discovery and Zetaris federation | BUILT; eight of nine plan gates pass | Discovery fabric, safe fetch, source cards, connectors, semantic validation, Zetaris port with live, cassette and DuckDB fallback modes, three silos; DiscoveryShift; Z-REST, Z-POL, Z-CAT, Z-AUD, Z-TT, Z-USL, Z-PDF pass on a real stack | Z-NL is BLOCKED (no natural-language route in the build). The Unified Semantic Layer and the data-quality rule are exercised by the gate scripts, not by the product. The USL reflection document is not written |
| 2 Identity and document evidence | BUILT | Typed-link resolver with weight waterfall; FDA summary parser with two checks; IdentityShift 0 of 60 false merges | Recall 0.774; the labels have one reader; the corpus was used to design and score the resolver; the extraction gold is in-sample for 12 documents and not blind for 5 |
| 3 Applicability Compiler | BUILT | Dimension containment, label table, minimal counterexample, counterfactuals; 17 registry rules and 17 Sakaime rules; 21 registry rules unimplemented and listed; property tests; ScopeShift (A) 218 of 222 | The executable logic is our inference, not a standard; full-pipeline exact label on authentic claims is low (below) |
| 4 Agent orchestration and Meterless | BUILT; ablations PARTIAL | Bounded state machine with roles; four engines; sponsor conformance runners pass; MA-1 to MA-4 measured | MA-5 and the critic ablation are not measured; Scout recall on unseen wording is weak; the committed run is not receipted by Nightshift |
| 5 Independent evaluation | RUN; not independent | The five suites, baselines B1 to B4 and B6, statistics, erratum log | No independent reviewer; B0 and B5 not run; Promptfoo and garak not run; competitors not run on the held-out claims |
| 6 Product and submission | PARTIAL | 13 web screens, browser tests (axe, keyboard, layout), `npm run judge`, README, `metadata.json`, sample inputs and outputs | No video, deck, sponsor explanation or HackOS form; code not pushed; no clean-clone run on two systems |
| P Purchasing and adoption | NOT STARTED | n/a | Needs the owner's contacts. Nothing in the repository is evidence of demand |

## 1. Priorities, in order

1. Establish the competitive gap against Constat and the nearest alternatives (same-input test).
2. Establish one authentic device-to-study-to-version evidence chain, by hand, with a second reader.
3. Build genuine autonomous source discovery and Zetaris federation.
4. Make identity resolution and source meaning correct.
5. Make the Applicability Compiler conservative, deterministic and independently reviewable.
6. Add only the agents and memory engines that improve a measured outcome.
7. Check the workflow with real evaluators (Gate P).
8. Then invest in product polish and the submission experience.

## 2. Gates in detail

Mapping to the decision gates in `DECISIONS.md`: G0 letter, G1 linking (answered), G2 gap, G3 rules (answered), G4 Zetaris, G5 Meterless, G6 reviewer, G7 buyer interview. The review's Gates 0 to 6 below are the build order; Gate P is the demand track that runs beside them.

### Gate 0: competitive and source feasibility

Tasks and what happened:

- Read Constat's terms and free-tier limits; read HealthIT.com's reuse terms. **Done** (`evals/gate0/COMPETITOR-ARMS.md`, section 2). Constat was queried serially within its published terms; one retry went out 28 seconds after a rate-limit refusal that asked for 60, a deviation recorded in the file. Raw competitor output is not committed; hashes are.
- Write the same-input test: real claims with a known mismatch of one kind each, an answer key from the FDA summary and the linked study text, comparable records for every arm. **Done with 26 claims** (17 with a planted mismatch, 9 positive controls, 12 device families) in `evals/gate0/`. The key has one builder with two passes, not an independent second reader. After the builder saw a dry run of the compiler the key was edited (ERRATA E-001); all 26 claims are development, and a second set of 20 claims over five devices was sealed by hash afterwards (`evals/SEALED.md`).
- Establish the EyeArt chain by hand (K200667, the FDA summary, NCT03112005, the PubMed abstract naming version 2.1.0). **Done at identifier level**, with ten discrepancies D1 to D10 recorded; version equality is established at release-string level only and build-level identity is NOT VERIFIED (`evals/gate0/EYEART-CHAIN.md`).
- Capture the organizers' Cursor announcement or mark the question open; obtain the written exception text. **Cursor:** moderators say optional, the live rules page is not read. **Exception text: still open (G0).**

Stop or pivot conditions, checked: a rival matching us at 80 percent or more on the same inputs: no rival did (Constat 26.9 percent derivable, no verdict; HealthIT.com 0 percent). The chain cannot be established by hand: it was established at identifier level. The exception does not cover the second entry: NOT VERIFIED, the text is not on file.

**Reading.** The rule as written says the gap stands, and that is a statement about the two incumbents only. Against a generic model given the same documents the picture is different: the full pipeline's exact-label accuracy on the 26 development claims is 9 of 26 (34.6 percent) against a mean of 44.9 percent for one Nemotron call and 46.2 percent for a tool-using Nemotron agent, with 0 false-supported answers against 6 to 7 of 17 and 5 of 17. The pipeline answers INSUFFICIENT_EVIDENCE for 17 of 26 claims and confirms none of the nine well-supported controls. Its advantage is that it does not over-claim. The build went past Gate 0 on the owner's instruction (D-021), and the conviction gate in the global rules was not passed on this evidence (`DECISIONS.md`, open gates).

### Gate 1: source discovery and Zetaris federation

Tasks and status: SSRF-safe fetcher and source cards (**done**, FailureShift SSRF 21 of 21); connector contract with EMPTY, UNAVAILABLE, DRIFTED, FORBIDDEN, STALE, BLOCKED (**done**, source states 92 of 92); bounded probe, schema fingerprint, semantic validator, mapping proposal with Nemotron (**done**, DiscoveryShift); Zetaris port and three silos (**done**); DuckDB as independent oracle (**done**, 20 rows equal cell by cell); Source Console and Evidence Matrix screens (**done**).

Zetaris gates (`../infra/zetaris/GATES.md`, real 2.4.3.1 stack, run 2026-10-27): Z-HEAD (the headline join), Z-REST, Z-POL, Z-CAT, Z-AUD, Z-TT, Z-USL, Z-PDF and the kill drill pass; Z-NL is BLOCKED after three routes; Z-JUDGE is not in `GATES.md` and is covered only by `npm run judge` over the recordings. Eight of the plan's nine gates therefore pass, counting Z-JUDGE through the judge command. Two defects were found and are handled in code: `Hide` leaks on file-store tables (the stack uses `Deny` and `Masked`), and a datasource refresh deletes policies (they are re-applied and canary-checked).

Open in this gate: the Unified Semantic Layer and the completeness rule run in the gate scripts and in `src/federation/dq.ts`, but no product screen or investigation step queries the USL; `docs/zetaris-usl-reflection.md` is not written; REST-table registration is not built (D-029).

Tests: T1 PASS (consistency), T2 PENDING, T6 PASS (consistency), C-03, C-04, C-08 PASS, C-12 PENDING, O-23 FAIL.

### Gate 2: identity and document evidence

Built: entity and link model; Fellegi-Sunter-style scorer with waterfall; 150-pair corpus with hard negatives from the feasibility data; FDA summary parser with anchors; quote-exists and semantic-support checks; Markovian long-document reading; GUDID version map.

Measured: IdentityShift leave-one-family-out, 14 families: 0 of 60 false merges, precision 48 of 48, recall 48 of 62, correct abstention 20 of 22 (development set, one reader). Extraction on 12 development documents: version strings 5 of 5, performance statements precision 0.971 and recall 0.968, headline results 0.955 and 0.955; five later documents are not a blind test (`tests/extraction/RESULTS.md`). Not done: results that exist only in stacked tables are not read (EyeArt's pivotal sensitivity is one), and the population and setting of a study are not inherited from the indications (D-032).

### Gate 3: Applicability Compiler

Built: dimension lattices; three-valued containment; label table; minimal counterexample; evidence requirements; counterfactual lab; the regulator-bound rule (D-031); mechanical coverage separated from expert-review flags. The rule registry research is `reports/applicability-rule-registry.md`; the executable rules and their basis are in `src/compiler/rules.ts` (17 registry rules and 17 Sakaime rules; 21 of the 38 registry rules are not implemented and each is listed with the reason). A separate `docs/rules/` folder was not created.

Measured: ScopeShift (A), 222 controlled counterfactuals over 18 summaries: 218 exact (98.2 percent), 24 of 24 positive controls, 0 of 198 false-supported; four misses in one mutation where the rule table has no row. Property tests with fast-check on the containment invariants pass. ScopeShift (B) on authentic claims is the weak result: see the reading under Gate 0 and `evals/RESULTS.md`, "Why V answers INSUFFICIENT_EVIDENCE so often".

### Gate 4: agent orchestration and Meterless

Built: bounded state machine with budgets and idempotency keys on registration, decisions and export; roles planner, discoverer, retriever, resolver, extractor, critic, reporter; Nightshift client and receipt verifier; four engines in `src/engines/`; Scout Intent with its own grader.

Measured: sponsor conformance runners pass (H-MEM 13, World Model 8, Markovian 8); the Scout stock harness exits 0 over its 32 examples. MA-1 to MA-4 are on constructed inputs (`tests/engines/ABLATIONS.md`, `tests/engines/markovian/MA3-RESULTS.md`, `tests/engines/scout/RESULTS.md`). Not measured: MA-5 (receipts), the critic, Nightshift as the route of the committed run (0 of 14 replies receipted). Weak: Scout held-out recall 9 of 24 with rules alone, 16 of 24 with the optional classifier (D-030).

### Gate 5: independent evaluation

Run: the five suites from `06` with baselines B1 to B4 and B6 (Gate 0 reuse, development only), paired tests, cluster intervals, an erratum log of seven entries (E-001 to E-007) and a sealed held-out set. Not run: B0 and the reviewer study, B5 (blocked), the competitors on the held-out claims, Promptfoo and garak, a blind second annotator, more than three model runs. The suite is **not independent**: one builder wrote every key.

### Gate 6: product and submission

Done: 13 screen components under `ui/src/screens/` (landing, review desk, case overview, evidence matrix, claim X-ray, applicability lab, timeline, investigation, resilience, dossier, sources, guard, about); `npm run judge`; README; `metadata.json` with its test; sample inputs and outputs; browser tests pass (axe, keyboard, layout, copy lint).

Not done: demo video, slide deck, sponsor technology explanation (`docs/submission/` does not exist), HackOS form, public push of the 31 local commits, clean-clone runs on two operating systems, resource and latency budgets, privacy review, moderated user sessions, per-component design notes (`docs/design-notes/` does not exist).

### Gate P: purchasing and adoption (parallel; not an engineering gate)

Tasks: interview people who ran an AI product review (the last review, the systems they consulted, what delayed or changed the decision); check one real decision with public or consented records; show the tool and measure manual effort and misses; check export fits committee documentation; test willingness to use or pay only after a real task. Needs the owner's contacts. **Status: not started.** Nothing is said about demand until this has data.

## 3. Repository layout (as built)

```
src/schemas/      Zod schemas: evidence, scope, finding, common
src/ports/        the contracts between modules
src/sources/      source cards, connectors, safe fetch
src/discovery/    probe, fingerprint, mapping proposal, semantic validator, registration, monitor
src/federation/   Zetaris port (live, cassette, fallback), DuckDB oracle, USL and data-quality statements
src/identity/     entity model, link types, scorer, adjudication
src/extraction/   parsing, anchors, quote check, semantic support check
src/engines/      hmem, world-model, markovian, scout (our implementations against the sponsor runners)
src/compiler/     dimensions, containment, labels, counterexamples, requirements, counterfactuals, rules
src/agents/       roles, guard, trace, report, critic, plan
src/models/       NVIDIA and Nightshift clients, receipts, egress policy
src/service/      case pipeline, investigation, drills, workbench
src/api/          HTTP API and contract
src/dossier/      build, sign, verify, lineage events
ui/               web app
evals/            five suites, baselines, graders, results, sealed held-out set
data/             cassettes, silos, corpora, discovery-shift suite
third_party/      vendored Meterless references (H-MEM, World Model) with NOTICE
input_examples/, output_examples/   sample requests, replies, dossiers and traces
infra/zetaris/    the stack runbook, seed, gate scripts and GATES.md
scripts/          judge, serve, record-sample, typecheck
docs/             this folder
```

The code is committed locally (32 commits at the time of writing); the public repository holds only the first commit until the owner pushes. Nothing under `research/` or `docs/reference/` is committed.

## 4. Method for every component

Follow `CHARTER.md`. The intent in the first draft was a one-page design note per component in `docs/design-notes/` and an update of the study register (`09`) per component; neither was kept up. The decisions that matter are in `DECISIONS.md`, the adopted mechanisms and their licences are in `provenance.md`, and the study register's per-row status was not maintained.

## 5. Resources and constraints

- **Disk:** C: had about 6 GB free at the start; the Zetaris images need about 10 GB. Free space under the standing rule (upload to Drive first, log, then delete) before pulling images; keep `research/` clones sparse; cassettes stay small and hashed (tracked files total about 6.5 MB).
- **Memory:** the Docker VM was capped at 3.9 GB by the user's `.wslconfig` and the driver heap set to 1,536 MB; the vendor profile asks for 8 GB for Docker (`infra/zetaris/GATES.md`).
- **Zetaris:** 2.4.3.1 hackathon build, cold start 52 s from empty volumes. Credentials live in `.env` only.
- **Nightshift:** installed 2026-10-24 on loopback; the response-cache defect needs a per-call scope header.
- **FDA list:** scripted fetch is blocked; a pinned CSV snapshot (browser fetch) is the input, with its date shown.
- **Rate budgets:** openFDA 240 per minute and 1,000 per day per IP without a key; PubMed 3 per second; the shared NVIDIA free-tier key allowed about two calls a minute for part of the day, which limited B4 to one run (ERRATA E-004).
- **Cursor:** optional per moderators; not used.

## 6. Risks and stop conditions

Competitive overlap (measured, see Gate 0); sparse and ambiguous links (answered: handled as classed candidates); no clinical reviewer; no buyer evidence; Zetaris REST limits (handled by snapshots); reference-engine gaps; disk and memory; eligibility terms; model quality on extraction. The pivot target remains construction addenda or tariff revisions on the same engine (`DECISIONS.md`, D-003).

## 7. What the lead must settle next

1. The written exception text (G0), and whether the second entry stands as built.
2. Whether the low exact-label accuracy on authentic claims is acceptable for the headline, or whether the extraction layer is extended first (stacked-table results; study population and setting).
3. The USL: query it from the product, or state in the README that it is exercised by the gate scripts; write the reflection.
4. Nightshift as the primary route for the recorded run (O-22, O-06 receipts).
5. A clinician or informatics reviewer (G6), a buyer interview (G7), and the demand track (P).
6. Video, deck, sponsor explanation, HackOS form, push to GitHub, clean-clone runs.
