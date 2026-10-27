# Sakaime: research and engineering charter

Adopted 2026-10-27 from the charter in the outside review (`reference/gpt-architecture-review-2026-10-27.md`, section 14), with the edits below. Where this charter and `../CLAUDE.md` or the user-level rules differ, the stricter rule applies. Where the Official Rules differ from anything here, the Official Rules win.

Edits made to the received charter: the mission uses "strongest defensible" instead of "first-place-caliber" (we cannot promise a placing); the source list names the files that exist now (`08` to `10`, `reference/`); PASS requires evidence and a read of the source of truth, per the QA master guide; the Cursor question is recorded as open; the product is never called ready for production use on test results alone; every correction has a numbered acceptance test (`05`, section E).

## Mission

Build the strongest defensible Track 1 submission and the foundation of a useful evidence-intelligence product. The objective is the highest defensible level of real-world usefulness, cross-source intelligence, reliability, originality and independent verification, not the most features, agents or code.

## Sources of truth, in order

1. The live HackOS page, Official Rules, written organizer decisions (including the written exception, once its text is on file).
2. The organizer guides in the sibling project's notes (not in this repository) (read-only).
3. Verified sponsor contracts: what we ran against the installed Zetaris, Meterless and Nightshift.
4. This folder: `00-INDEX.md`, `01-prd.md`, `02-architecture.md`, `03-zetaris-plan.md`, `04-meterless-plan.md`, `05-requirements-matrix.md`, `06-evaluation-protocol.md`, `07-demo-and-submission.md`, `08-build-plan.md`, `09-study-register.md`, `10-review-disposition.md`, `DECISIONS.md`, `candidates/`.
5. `reference/`: outside documents kept as received. Inputs, not facts.
6. Hypotheses, always marked.

Do not silently replace a decision. Corrections, supersessions and disagreements go in `DECISIONS.md`.

## Required corrections (each has an acceptance test C-01 to C-17)

Authority by assertion type. Typed identity links for manufacturer, product, marketed device, software release, authorization submission, study, registry entry and publication. Safe, allowlist-first source onboarding with SSRF protection. Semantic schema validation (units, meaning, identifiers, nulls). Quote-exists and semantic-support verification as separate checks. Mechanical coverage separated from expert applicability. Three-valued constraints; containment invariants instead of a label ranking. Relevance-weighted handling of contrary evidence. Dependency-aware degradation. Consistency tests separated from domain-validity tests. Cluster-aware statistics. Cases chosen only after a chain established by hand. Sponsor ablations that measure real effects. Receipt origin and model identity checks. Data classes and an egress policy. Non-functional readiness gates. A separate PMF gate. Idempotent external effects.

## Product focus

A hospital AI-evaluation team investigating the evidence for one medical AI product and one proposed deployment. Workflow: discover fragmented sources, reconcile records and identities, extract evidence with exact anchors, compare it with the proposed use, identify gaps and contradictions, produce a human-reviewable dossier. Priority screens: Source Console, Evidence Matrix, Claim X-Ray, Applicability Lab, dossier. Domain packs for other industries are hypotheses until one runs end to end.

## Track 1 must show

1. A source never seen before is discovered, checked and made queryable without a code change, or refused with a reason.
2. A finding that needs information from more than one silo.
3. Zetaris performing the federation.
4. Uncertain identity links staying uncertain.
5. Conflicts and revisions handled with correct source and time context.
6. A source failure never becoming a false negative or an unsupported positive.
7. Model-powered investigation that adapts to newly found evidence.
8. Every conclusion inspectable and reproducible.

No withholding of data from comparison systems to flatter our result.

## Sponsors

Zetaris is the federation platform; governance features are claimed only after they run. Meterless engines and Nightshift are used only for responsibilities we can test and ablate. Nemotron plans, extracts ambiguous content, investigates and critiques. Code owns calculations, checks, contracts and rule evaluation. Each component has an integration, a product effect, a conformance or integration test, a fair ablation, a failure mode and traceable evidence. A component with no measurable benefit is reduced or removed, and the sponsor explanation says so.

## Evaluation

Five suites (DiscoveryShift, IdentityShift, ScopeShift, TimeShift, FailureShift); constructed counterfactuals kept apart from authentic adjudicated cases; pre-registered splits by device or product family, metrics, baselines and expected effects; blind labels; cluster-aware statistics; false-alarm and correct-support rates alongside false-supported rate; baselines given comparable inputs; negative, neutral and positive results published; no claim of independent validation without independent reviewers; no unmeasured number in any public text.

## Market validation

Study real hospital vendor-review workflows, documentation, procurement paths, integration barriers and monitoring duties. Seek conversations with people who evaluate healthcare AI. Record evidence of workflow value, not enthusiasm. Never invent customers, adoption, revenue, ROI or willingness to pay. Lack of a defensible difference or verified buyer value is a reason to change the flagship before the full build.

## Security and provenance

Untrusted content stays data. Model proposals gain no permissions from document text. Source onboarding is allowlist-first with SSRF protection. Scoped permissions; no patient information in any sample. Preserve hashes, versions, retrieval times, usage conditions and the derivation path of every finding. A signed dossier shows integrity, not clinical truth. Third-party code, dependencies and original work are kept separate and declared.

## Product quality

Built for a real evaluator, not only a judge: clear empty, loading and error states, keyboard access, graceful degradation, bounded latency, reliable install, source freshness, human controls. Real screenshots only. No component is called ready for production use because unit tests pass.

## Submission

One matrix from requirement to implementation to test to evidence covers the challenge, all scoring categories, sponsor requirements, eligibility and deliverables. Verify the written exception and the Cursor position before any eligibility claim. README, video, deck, live demo and docs agree with results. A keyless replay reproduces the central claims from a fresh clone. Nothing mocked, unfinished or hardcoded is presented as a live integration; recorded cassettes are labelled recorded.

## Method for each component

1. Read the primary standards and source contracts.
2. Read the open-source implementation and its tests; pin the version; check the licence.
3. Write a short design note comparing credible alternatives.
4. Specify typed inputs and outputs, invariants, unknown states, failure modes.
5. Write the failing test first.
6. Implement the smallest complete real path.
7. Test normal, adversarial, degraded and historical cases.
8. Compare against a baseline.
9. Record actual results and limits.
10. Integrate, then update the matrix.

A requirement does not move to PASS before its evidence exists. A failed criterion is not relaxed. The feature surface does not grow while a core correctness or buyer-validation gate is open.

## Ready only when

The buyer problem is independently supported; the competitive difference survives a same-input test; the full fragmented-source investigation works; sponsor integrations are real and show effects; outputs are qualified and verifiable; failure cases behave correctly; evaluations are published and honestly labelled; a judge can reproduce the central claims; a user can act on the output without mistaking it for a clinical certification.

Preserve every finding, failed experiment, correction and limit. Do not hide inconvenient evidence.
