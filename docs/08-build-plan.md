# Build plan: gates, order, method, resources, readiness

Status 2026-10-27. This plan turns the design and the outside review (`10-review-disposition.md`) into an order of work with stopping conditions. No code exists yet. Gates are quality gates, not dates. A gate passes only with its evidence in the requirements matrix (`05`).

## 1. Priorities, in order

1. Establish the competitive gap against Constat and the nearest alternatives (same-input test).
2. Prove one authentic device-to-study-to-version evidence chain, by hand, with a second reader.
3. Build genuine autonomous source discovery and Zetaris federation.
4. Make identity resolution and source meaning correct.
5. Make the Applicability Compiler conservative, deterministic and independently reviewable.
6. Add only the agents and memory engines that improve a measured outcome.
7. Validate the workflow with real evaluators (Gate P).
8. Then invest in product polish and the submission experience.

## 2. Gates

Mapping to the decision gates in `DECISIONS.md`: G0 letter, G1 linking (answered), G2 gap, G3 rules (answered), G4 Zetaris, G5 Meterless, G6 reviewer, G7 buyer interview. The review's Gates 0 to 6 below are the build order; Gate P is the demand track that runs beside them.

### Gate 0: competitive and source feasibility

Tasks:
- Read Constat's terms and free-tier limits; read HealthIT.com's reuse terms.
- Write the **same-input test**: about 25 real claims with a known mismatch of one kind each (narrower indication, different version, different age range or setting, superseded submission, shared device name, missing study). Define the answer key from the FDA summary and the linked study text, with a second reader. Give every arm comparable records and record access differences.
- Hand-prove the **EyeArt chain** (K200667 to the FDA summary to NCT03112005 to the PubMed abstract naming version 2.1.0): exact identifiers, version relationships, quoted endpoints, population, setting. Write the case manifest. Choose the exact intended-use question.
- Capture the organizers' Cursor announcement or mark the question open; obtain the written exception text.

Output: competitor evidence, authentic case manifest, an architecture decision (GO, narrow, or pivot).
Studies before: HAIP framework text, PROBAST+AI and STARD-AI items already in the rule registry.
Stop or pivot if: a rival matches us on the same inputs at 80% or more; the chain cannot be proven by hand; the exception does not cover the second entry.

### Gate 1: source discovery and Zetaris federation

Tasks: SSRF-safe fetcher and source cards; connector contract (describe, check, discover, read, state) with EMPTY, UNAVAILABLE, DRIFTED, FORBIDDEN, STALE, BLOCKED; bounded probe and schema fingerprint; semantic validator; mapping proposal with Nemotron; Zetaris port (live, cassette, fallback) and the three silos from `03`; Zetaris gates Z-REST, Z-POL, Z-CAT, Z-AUD, Z-TT, Z-USL, Z-NL, Z-JUDGE run and recorded; DuckDB as independent oracle; Source Console and Evidence Matrix screens.

Also in Gate 1 (Zetaris judging core, D-024): compile and activate a USL over the three silos, query it as the read-only General-role user, add the completeness data-quality rule, test the PDF filestore route (Z-PDF), and start the USL reflection notes.
Tests: T1, T2, T6 (source-off), C-03, C-04, C-08, C-12, O-23; one federated result checked against the oracle.
Studies before: Airbyte protocol, Trino SPI (done in part), DataHub (metadata change events), Soda Core, SQLGlot, OWASP SSRF sheet, `zetaris/getting-started`.
Output: working Source Console and Evidence Matrix on real data in sample mode and live mode.

### Gate 2: identity and document evidence

Tasks: entity and link model; Fellegi-Sunter style scorer with waterfall; pair corpus with hard negatives from the feasibility data; FDA summary parser with anchors; quote-exists and semantic-support checks; Markovian long-document reading; GUDID version map.
Tests: T3, C-02, C-05; precision, recall and correct abstention on labelled pairs.
Studies before: Splink, Dedupe, scispaCy (only if recall needs it), Docling and Docling Graph (provenance binder), Unstructured and Marker only as parser baselines.
Output: one inspectable evidence chain, end to end.

### Gate 3: Applicability Compiler

Tasks: dimension lattices; three-valued containment; label table; minimal counterexample; evidence requirements; counterfactual lab; rule registry committed under `docs/rules/` after review; mechanical coverage separated from expert-review flags.
Tests: T4, T5, C-01, C-06, C-07, C-09; property tests with fast-check on the containment invariants.
Studies before: the rule registry (`research/standards`), PCCP guidance sections, Z3 only if typed rules prove insufficient.
Output: validated Claim X-Ray and Applicability Lab on the chosen case.

### Gate 4: agent orchestration and Meterless

Tasks: bounded state machine with idempotency keys on external effects; roles; Nightshift port and receipt verification; vendored Meterless engines extended per `04`; Scout Intent with its own grader; scoped memory.
Tests: T7, C-13, C-17; conformance (H-MEM 13, World Model 8, Markovian 8, Scout harness with zero skips) and our extended suites; MA-1 to MA-5 ablations.
Studies before: LangGraph.js patterns, Zod, the Meterless repository at the pinned commit.
Output: a complete trace with meaningful, pre-registered ablations.

### Gate 5: independent evaluation

Tasks: the five suites from `06`; baselines B0 to B5; reviewer study if reviewers exist; fault injection; Promptfoo and garak runs; report with failures.
Tests: all suites; C-10, C-11.
Output: reproducible benchmark, real failures, limitations, comparison report.

### Gate 6: product and submission

Tasks: accessibility (axe and keyboard), install reliability on two OS, resource budgets, privacy review, moderated user sessions if any, README, deck, video, public evidence hub (Notion), clean-room runs, sponsor explanation, HackOS form.
Tests: C-15, O-01 to O-24, including `npm run judge` (O-24) and the public GitHub repository (O-17).
Output: end-to-end product, not only a prototype.

### Gate P: purchasing and adoption (parallel; not an engineering gate)

Tasks: interview people who ran an AI product review (the last review, the systems they consulted, what delayed or changed the decision); validate one real decision with public or consented records; show the tool and measure manual effort and misses; check export fits committee documentation; test willingness to use or pay only after a real task.
Needs: the owner's contacts. Output: transcripts and an honest finding, or a documented attempt. Nothing is said about demand until this has data.

## 3. Repository layout (created at Gate 1)

```
src/schemas/      Zod schemas: Source, Record, Anchor, Assertion, Link, Finding, Dossier
src/sources/      source cards, connectors, safe-fetch
src/discovery/    probe, fingerprint, mapping proposal, semantic validator, registration
src/federation/   Zetaris port (live, cassette, fallback), DuckDB oracle
src/identity/     entity model, link types, scorer, adjudication
src/extraction/   parsing, anchors, quote check, semantic support check
src/engines/      hmem, world-model, markovian, scout (extended from the vendored references)
src/compiler/     dimensions, containment, labels, counterexamples, requirements, counterfactuals
src/agents/       state machine, roles, model port, budgets
src/dossier/      build, sign, verify, lineage events
src/api/          HTTP API
ui/               web app (Discover, Investigate, Decide)
evals/            five suites, baselines, graders
data/             cassettes, fixtures, pinned FDA list snapshot, manifests
third_party/      vendored Meterless harnesses with NOTICE
scripts/          secret scan, size check, wording lint, clean-room runner
docs/             this folder
```

The repository is initialised only when Gate 1 starts and the first commit is allowed by the organizers' terms for the second entry (G0). Nothing under `research/` or `reference/` containing third-party code is committed.

## 4. Method for every component

Follow `CHARTER.md`. In addition: each component gets a one-page design note in `docs/design-notes/` (alternatives considered, licence, chosen contract, invariants, failure modes, the failing test first), and the study register row (`09`) is updated with the commit studied.

## 5. Resources and constraints

- **Disk:** C: had about 6 GB free on 2026-10-27. Zetaris images need about 10 GB. Plan: free space under the standing rule (upload to Drive first, log, then delete) before pulling images; keep `research/` clones sparse; keep cassettes small and hashed.
- **Memory:** the host showed memory pressure; the Zetaris stack wants about 8 GB for Docker. Stop unused MCP servers and background tools before live Zetaris runs.
- **Driver heap:** the default is 2 GB; raise to 4 GB if wide JSON is loaded; the Spark context can die silently (see `03` s3).
- **Zetaris:** installed once in WSL on 2026-10-16; confirm it still starts. Credentials live in `.env` only.
- **Nightshift:** installed 2026-10-24 on loopback; the response-cache defect needs a per-call scope header.
- **FDA list:** scripted fetch is blocked; a pinned CSV snapshot (browser fetch) is the input, with its date shown.
- **Rate budgets:** openFDA 240/min and 1,000/day per IP without a key; PubMed 3/s; plan cassettes so development does not exhaust them.
- **Cursor:** open question. Cheapest safe course is to do part of the work in Cursor and log it.

## 6. Risks and stop conditions

Competitive overlap; sparse and ambiguous links (answered: handled as classed candidates); no clinical reviewer; no buyer evidence; Zetaris REST limits; reference-engine gaps; disk and memory; eligibility terms; model quality on extraction. Stop or pivot per section 2 and per `DECISIONS.md` (pivot target: construction addenda or tariff revisions on the same engine).

## 7. Readiness to build

Ready now (no build gate blocks them): read the Constat terms; write the same-input test and answer key; hand-prove the EyeArt chain; capture the Cursor and exception texts; confirm Zetaris and Nightshift start; scaffold Gate 1 modules as spikes in a scratch folder.

Not ready for the full build: gate 0 has not passed (no same-input result, no hand-proven chain, no exception text, no reviewer, no buyer contact). Per the conviction gate in the global rules, the full build starts when Gate 0 passes. Gate 1 spikes may start earlier because they are reversible research and are the highest-value Track 1 work.
