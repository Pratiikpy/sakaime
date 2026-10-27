# Sakaime: documentation index

Sakaime (境目, "the boundary line") checks whether the evidence behind a claim covers the exact use a buyer has in mind. Working name in the outside documents under `reference/`: VALIDWHEN.

State on 2026-10-27: the product is built and measured. The design documents `01` to `04` and `06` describe the intent and are corrected only where the build made a statement false; the documents that report what exists are `05`, `07`, `08`, `DECISIONS.md` and, outside this folder, [`../evals/RESULTS.md`](../evals/RESULTS.md). Start with `../README.md` for the product, then `CHARTER.md`, then read in this order.

## Documents

| File | What it is |
|---|---|
| `CHARTER.md` | The adopted research and engineering charter: sources of truth, required corrections, method per component, ready-only-when conditions |
| `01-prd.md` | Product requirements: promise, users, scope (P0, P1, P2), functional requirements FR-1 to FR-26, non-functional requirements, the three experiences, risks, open questions |
| `02-architecture.md` | Architecture: layers, entities and typed links, authority matrix, discovery pipeline with SSRF and semantic validation, identity, extraction, memory, the two-output compiler, loop, security and egress, dossier. Written as a design contract; implementation notes mark where the build differs |
| `03-zetaris-plan.md` | Zetaris tiers (essential, strong, conditional), silo design, headline statement, verification gates, fair three-arm comparisons. The gate results are in `../infra/zetaris/GATES.md` |
| `04-meterless-plan.md` | Meterless engine roles, reference gaps to close, tests, fair ablations, memory scoping, Scout false-block measure, receipt verification. Results: `../tests/engines/ABLATIONS.md`, `../tests/engines/markovian/MA3-RESULTS.md`, `../tests/engines/scout/RESULTS.md` |
| `05-requirements-matrix.md` | **Results as of 2026-10-27.** Organizer rules O-01 to O-24, judging criteria, Track 1 tests T1 to T8, invariants, corrections C-01 to C-17 and the completion standard, each with a status (PASS, FAIL, PENDING, BLOCKED) and the evidence file behind it |
| `06-evaluation-protocol.md` | The five suites (DiscoveryShift, IdentityShift, ScopeShift, TimeShift, FailureShift), leakage rules, arms, metrics, statistics. Pre-registration text; the runs and their errata are in `../evals/` |
| `07-demo-and-submission.md` | The four-minute demo script against the screens and labels the product shows now, what to prepare before recording, deck outline, README and submission status. Nothing recorded yet |
| `08-build-plan.md` | Gate-by-gate status (Gates 0 to 6 and P), repository layout as built, constraints, what the lead must settle next |
| `09-study-register.md` | The 61 repositories from the outside playbook, verified against the GitHub API, with priority, licence, last push and cautions. Its per-row study status was not maintained; the mechanisms actually adopted and their licences are in `provenance.md` |
| `10-review-disposition.md` | Point-by-point ruling on the outside review: sixteen corrections and every other point, with the document changed and the test that closes it |
| `11-channel-intel.md` | What the HackOS channel messages changed: Cursor optional, Zetaris judging core (USL, data-quality rule, reflection), Nightshift as primary provider, model availability, receipts and memory isolation, `metadata.json` community draft, judge-script pattern |
| `DECISIONS.md` | Decisions D-001 to D-039 (D-029 onward made during the build), where we differ from outside documents, open gates G0 to G7 and gate P with real statuses |
| `provenance.md` | What existed before the build, what was vendored, which open-source ideas were rebuilt and under which licence, third-party data terms, constructed data, AI assistance |
| `candidates/2026-10-27-track1-candidate-evaluation.md` | How the first candidate (BidDelta) and alternatives were checked |
| `reports/` | The three research reports published with the repository, as written on 2026-10-27 and not edited since: `feasibility-report.md` (12 real devices), `competition-report.md` (first-hand teardown, Constat and HealthIT.com) and `applicability-rule-registry.md` (38 candidate rules with their standards citations) |
| `schemas/community-metadata.schema.json` | The community draft schema that `../metadata.json` follows (D-023); `../tests/metadata.test.ts` checks it |
| `reference/` | Local only (not published): outside documents kept as received: the architecture source map, the Track 1 winning standard, the GitHub study playbook, the 2026-10-27 architecture review and playbook message, and the curated HackOS channel digest. Inputs, not verified fact |

## Where the results live

| What | Where |
|---|---|
| Evaluation report (generated, do not edit) | `../evals/RESULTS.md`, from the files in `../evals/results/` |
| Contamination and erratum log | `../evals/ERRATA.md` (E-001 to E-007), `../evals/SEALED.md` |
| Gate 0: claims, key, EyeArt chain, competitor arms | `../evals/gate0/` |
| Sealed held-out claims and key | `../evals/heldout/` |
| Zetaris gates and kill drill | `../infra/zetaris/GATES.md` |
| DiscoveryShift | `../data/discovery-shift/RESULTS.md` |
| Identity corpus | `../data/identity-corpus/RESULTS.md` |
| Extraction | `../tests/extraction/RESULTS.md` |
| Meterless engine ablations and conformance | `../tests/engines/` (see `04`) |
| Recorded run, sample inputs and outputs | `../data/sample/run/labels.json`, `../input_examples/`, `../output_examples/` |
| Offline check | `npm run judge` (67 lines PASS on 2026-10-27) |

## Working rules

- When outside advice arrives, save it as received in `reference/`, answer it point by point in `10-review-disposition.md` (or a successor), and update the plan. Nothing is skipped.
- A status is PASS, FAIL, PENDING or BLOCKED, and PASS needs a named evidence file (`05`).
- Every number in a public text comes from a results file; the class of the result (consistency, builder-labelled, domain-validity) travels with it.
- Docs under `reports/` and `reference/` are records of what was read or received and are not rewritten to match later results.
