# Sakaime: documentation index

Sakaime (境目, "the boundary line") checks whether the evidence behind a claim covers the exact use a buyer has in mind. Working name in earlier documents: VALIDWHEN.

Start with `../CLAUDE.md` (status and rules), then `CHARTER.md`, then read in this order.

| File | What it is |
|---|---|
| `CHARTER.md` | The adopted research and engineering charter: sources of truth, required corrections, method per component, ready-only-when conditions |
| `01-prd.md` | Product requirements: promise, users, scope (P0, P1, P2), functional requirements FR-1 to FR-26, non-functional requirements, the three experiences, risks, open questions |
| `02-architecture.md` | Architecture v0.2: layers, entities and typed links, authority matrix, discovery pipeline with SSRF and semantic validation, identity, extraction, memory, the two-output compiler, loop, security and egress, dossier |
| `03-zetaris-plan.md` | Zetaris tiers (essential, strong, conditional), silo design, headline statement, verification gates, fair three-arm comparisons |
| `04-meterless-plan.md` | Meterless engine roles, reference gaps to close, tests, fair ablations, memory scoping, Scout false-block measure, receipt verification |
| `05-requirements-matrix.md` | Organizer rules O-01 to O-20, judging criteria, Track 1 tests T1 to T8, invariants, corrections C-01 to C-17, Track 1 completion standard |
| `06-evaluation-protocol.md` | The five suites (DiscoveryShift, IdentityShift, ScopeShift, TimeShift, FailureShift), leakage rules, arms, metrics, statistics |
| `07-demo-and-submission.md` | Four-minute demo (revised), deck outline, README outline, sponsor explanation, checklist |
| `08-build-plan.md` | Gates 0 to 6 and the parallel demand gate, repository layout, method, resources, risks, readiness to build |
| `09-study-register.md` | The 61 repositories from the outside playbook, verified against the GitHub API, with priority, licence, last push, study status and cautions |
| `10-review-disposition.md` | Point-by-point ruling on the outside review: sixteen corrections and every other point, with the document changed and the test that closes it |
| `11-channel-intel.md` | What the HackOS channel messages changed: Cursor optional, Zetaris judging core (USL, data-quality rule, reflection), Nightshift as primary provider, model availability, receipts and memory isolation, metadata.json community draft, judge-script pattern, the deadline |
| `DECISIONS.md` | Decisions D-001 to D-021, where we differ from outside documents, open gates G0 to G7 and gate P |
| `candidates/2026-10-27-track1-candidate-evaluation.md` | How the first candidate (BidDelta) and alternatives were checked |
| `reference/` | Local only (not published): outside documents kept as received: the architecture source map, the Track 1 winning standard, the GitHub study playbook, the 2026-10-27 architecture review and playbook message, and the curated HackOS channel digest. Inputs, not verified fact |
| `../research/` | Local only: cloned repositories and the three research reports (`feasibility/`, `competition/`, `standards/`), the real addendum sample, `repo_facts.tsv` |

Working rule: when outside advice arrives, save it as received in `reference/`, answer it point by point in `10-review-disposition.md` (or a successor), and update the plan. Nothing is skipped.
