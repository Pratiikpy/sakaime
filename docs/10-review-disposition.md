# Disposition of the outside review of 2026-10-27

Inputs: `reference/gpt-architecture-review-2026-10-27.md` (the review, 15 sections), `reference/gpt-github-playbook-message-2026-10-27.md` and `reference/validwhen-track1-github-study-playbook.md` (61 repositories). Rule: every point is answered here with a ruling, a reason and the place it changed; nothing is skipped and nothing is adopted without a test. Rulings: ACCEPT, REFINE (accepted with a change we explain), HOLD (valid, waiting on evidence), NOTE (informational). Acceptance tests are C-01 to C-16 in `05-requirements-matrix.md`, section E.

## 1. The sixteen corrections

| # | Review's point | Ruling | Reason and change | Where | Test |
|---|---|---|---|---|---|
| 1 | One global authority hierarchy is wrong; authority depends on the question | ACCEPT | Our `02` used fixed tiers. Replaced by an **authority matrix by assertion type**: authorized use and scope (regulator record), reported performance (the original study and its data), current marketed version (version-specific product documentation, corroborated), local requirement (the hospital's approved policy), vendor assertion (never authoritative on its own). A study cannot widen an authorization; a regulator record cannot overwrite a study's measured result. Public absence is not study absence (the FDA list is "not comprehensive") | `02` s4, s9 | C-01 |
| 2 | A shared identifier is not one relationship | ACCEPT | Identity model rebuilt as entity types (manufacturer, product family, marketed device, software release, authorization submission, study, registry entry, publication) joined by **typed links** (`SAME_SUBMISSION`, `SAME_PRODUCT`, `SAME_MARKETED_VERSION`, `STUDY_EVALUATES`, `PUBLICATION_REPORTS`, `SUPERSEDES`), each with its own state. A shared submission number proves only `SAME_SUBMISSION`. Feasibility data backs this: Viz LVO has eleven GUDID versions under one De Novo | `02` s7 | C-02 |
| 3 | Add-a-source must be sandboxed and permission-checked | ACCEPT | Source onboarding is **allowlist-first** (approved source families) with an SSRF-safe fetcher: https only, resolved-address checks that block private, loopback, link-local and metadata ranges, DNS pinning, redirect re-validation, method GET, size and time caps. The demo's pasted URL must resolve inside the allowlist or be refused with the reason shown | `02` s5 | C-03 |
| 4 | Type-valid is not meaning-valid | ACCEPT | Mapping validator adds semantic checks: units and scale (percent vs fraction), value ranges and distributions, identifier patterns, null and missing-value codes, date semantics, duplicate keys, sample joins against known records. The unknown-schema suite includes semantic mutations, not only renames | `02` s5 | C-04 |
| 5 | A verbatim quote does not prove the claimed relationship | ACCEPT | Two checks, reported separately: **quote-exists** (code) and **semantic support** (does the quoted passage state what the field claims: right subject, version, population, metric, threshold). Semantic support is checked by deterministic pattern rules where possible, a second model call in a separate context that sees only the quote and the assertion, and reviewer sampling; its error rate is a benchmark metric | `02` s8 | C-05 |
| 6 | A broader intended use is not simply a worse label; verdicts are not a ranking | REFINE | Agreed that the five labels are not an ordered scale. Our earlier property "widening never improves a label" was wrong as stated. Replaced by invariants on **dimension containment**: widening a claimed scope can only shrink the set of CONTAINED dimensions; and `SUPPORTED_FOR_SCOPE` for a wider scope implies it for every narrower scope inside it | `02` s10, `01` FR-3 | C-06 |
| 7 | New contradictory evidence does not automatically invalidate support | REFINE | Contrary evidence is classified by relevance (same version and population or not), design quality and source type. A relevant, adequate contradiction blocks `SUPPORTED_FOR_SCOPE` and yields `CONTRADICTED_BY_SPECIFIED_EVIDENCE`; a weak or off-scope one yields `REQUIRES_DOMAIN_REVIEW`. Invariant: a contrary item must be explicitly dispositioned before the label can be `SUPPORTED_FOR_SCOPE` | `02` s10, `01` FR-5 | C-07 |
| 8 | A missing source is not always fatal | REFINE | Each claim declares its **source dependencies** (required, corroborating, optional). Degradation is evaluated against them: loss of a required source gives INSUFFICIENT or UNRESOLVED; loss of a corroborating one lowers confidence in the explanation and is shown, not hidden. The earlier rule "removing a required source never produces SUPPORTED" stays, with the word "required" now defined per claim | `02` s9, `01` FR-4 | C-08 |
| 9 | Rule-derived tests cannot validate rule meaning | ACCEPT | Already admitted in `06`; now the **first** thing it says. Two suites are named differently: engineering-consistency (rule table vs implementation) and domain-validity (only by reviewers). No consistency result is reported as clinical correctness | `06` s2 | C-09 |
| 10 | 120 cases on 20 devices are not 120 observations | ACCEPT | Cluster by device; report the effective sample size; cluster-bootstrap intervals; splits by device and by study family | `06` s5, s6 | C-10 |
| 11 | A real device is not automatically a good mismatch | ACCEPT | Cases enter the benchmark only after the full relationship chain is proven by hand with a second reader. Demo starts from one clean documented chain; a labelled constructed vendor claim supplies the overreach | `01` s8, `07` | C-11 |
| 12 | Ablations must measure real effects, not engineered loss | REFINE | Our Zetaris ablation ("matrix loses columns") risked being engineered. Replaced by **three fair arms**: same data through an in-process engine, single-source access, and real Zetaris; compare accuracy only where it truly differs and otherwise discovery, governance, provenance, latency and operability. Same rule for Meterless: measure the real effect; a null result is reported and the claim is dropped | `03` s6, `04` s4, `06` s3 | C-12 |
| 13 | Receipts: verify origin and model identity | ACCEPT | Receipt verification checks the signature, the key id against the installed Nightshift, the routed model against the role map, and that request and response hashes match what we sent and stored. A valid receipt never upgrades the truth of a model's content | `04` s3.5 | C-13 |
| 14 | Local-first storage is not local-only processing | ACCEPT | **Data classes and an egress policy**: public records may go to the model; vendor-confidential content goes only to a local lane or with explicit consent; PHI is never in the system. The mode and each egress decision are shown to the reviewer and logged. Local lane availability is NOT VERIFIED (8 GB VRAM question) | `01` s6, `02` s12 | C-14 |
| 15 | Passing tests is not product readiness | ACCEPT | Adds non-functional gates: clean install on two OS, resource and latency budgets, accessibility (axe plus keyboard), privacy review, update behaviour, and moderated user sessions. The word "production-ready" stays banned until all exist | `01` s6, `07` s6 | C-15 |
| 16 | Rigor is not PMF | ACCEPT | A separate gate **P** (purchasing authority, workflow fit, adoption cost, willingness to use) tracked apart from engineering gates; no engineering result may be cited as demand | `DECISIONS` G6, G7, GP | C-16 |

## 2. Other points in the review

| Section | Point | Ruling | Change |
|---|---|---|---|
| 1 | Three claims are being proven at once (Track 1, scientific reliability, PMF) | ACCEPT | Evidence is now tagged by which of the three it supports; the matrix has a column for it |
| 1 | New promise: "discovers what an organization can actually establish about a claim..." | ACCEPT | Adopted in `01` s1 |
| 1 | Sparse identifiers could create endless unresolved investigations | ACCEPT | Review Desk shows a bounded **unresolved list with the next evidence request**, not endless loops; investigations have turn and budget caps; unresolved is a first-class output |
| 3 | Nine systems; Review Workspace, Discovery Fabric, Zetaris Federation, Identity and Evidence Graph, Document Intelligence, Investigation Engine, Compiler, Dossier, Decision and Monitoring | ACCEPT | Mapped onto our L0 to L8 in `02` s3 (names aligned: Document Intelligence = L4, Decision and Monitoring = L8 plus the Review Desk) |
| 3 | Typed contracts (SourceHealth with STALE and BLOCKED; LinkType; LinkState; EvidenceRecord; EvidenceAnchor; EvidenceAssertion; Finding) | ACCEPT | Adopted as the starting schemas; `SourceHealth` gains STALE and BLOCKED; `EvidenceAssertion` gains `unit` and `appliesToVersion`; `Finding` gains `sourceDependencies` |
| 3 | Evidence history and decision history kept separately; never rewrite a finding | ACCEPT | `02` s9: two logs, old findings preserved, a change produces a new finding that references the old |
| 4A | Eligibility: public FAQ still says Cursor is required; our log says optional since 22 Oct | RESOLVED by moderator statements | `11-channel-intel.md`, D-012 |
| 4A | The written extension must cover the second project | ACCEPT | Gate G0 stays open; text needed from the owner |
| 4B | JAMA Network Open study of 903 devices; Joint Commission 2026 certification | NOTE | Both come from the outside review and are secondary for us until read; the competitor report found the Joint Commission pages blocked and used a secondary article |
| 4C | DuckDB as oracle or labelled fallback, never a hidden replacement for Zetaris | ACCEPT | `03` s6 and `02` s6: DuckDB is the independent test oracle; any fallback is labelled degraded |
| 4D | PROBAST+AI is an appraisal tool; STARD-AI and TRIPOD+AI are reporting guidelines | ACCEPT | Already how the standards registry treats them; stated in `02` s10 |
| 4E | LangGraph's resume can re-run a node; side effects need idempotency | ACCEPT | Every external effect (source registration, reviewer decision, export) takes an idempotency key; test in C-17 (added) |
| 4G | Constat's terms restrict reuse of its compiled dataset | NOTE | We never copy its data; the same-input test uses only what its free tier returns under its terms; read the terms before the test |
| 5 | Zetaris tiers: Essential / Strong differentiator / Conditional | ACCEPT | `03` s2 reorganised into the three tiers |
| 6 | Memory must be scoped per organization; test Scout on paraphrases and legitimate look-alike requests; report false-block rate | ACCEPT | `04` s3.2, s3.4 |
| 7 | Five suites: DiscoveryShift, IdentityShift, ScopeShift, TimeShift, FailureShift | ACCEPT | `06` rebuilt around the five suites; our earlier Sets A and B become the two data sources inside them |
| 7 | Measure false alarms and correct acceptance of well-supported claims, not only refusals | ACCEPT | Added "false-alarm rate" and "correct SUPPORTED rate" to the primary metrics |
| 7 | Leakage rules: split by product family; no same study under two identifiers across splits; label blind to the system's verdict; disclose post-hoc changes | ACCEPT | `06` s2 |
| 7 | Results table has placeholders until measured; never aspirational numbers in public | ACCEPT | `06` s9; wording lint extended to forbid unmeasured numbers in the README, deck and video |
| 8 | One clean authentic case first | ACCEPT | EyeArt is the first case (its chain is machine-checkable end to end per the feasibility probe) |
| 9 | Three experiences: Discover, Investigate, Decide | ACCEPT | `01` s7 |
| 9 | Five UX details (clickable findings, understandable uncertainty, what would settle it, instant Lab, finding-type labelling) | ACCEPT | Added as acceptance criteria in `01` s7 |
| 10 | Simpler four-minute story | ACCEPT | `07` s1 rewritten |
| 11 | Go-to-market: interview the evaluator, validate one real decision, fit committee documentation, test monitoring demand | ACCEPT | Recorded in `08-build-plan.md` s6 as the PMF track; we cannot run interviews ourselves, so it needs the owner's contacts |
| 12 | Gates 0 to 6 and stop conditions | ACCEPT | `08-build-plan.md` adopts them as the build order; our G0 to G7 are mapped to them |
| 13 | Track 1 completion standard above the detailed matrix | ACCEPT | Added as `05` section F |
| 14 | The charter | ACCEPT, with edits | `CHARTER.md`; edits listed in its header |
| 15 | Priorities in order | ACCEPT | Order reproduced in `08` s2 |

## 3. Open items this review surfaces

1. **Cursor.** Resolved by the channel digest (`11-channel-intel.md`): moderators say Cursor is optional (22 and 24 Oct, rules reminder). Confirm on the live rules page.
2. **The written extension**: exact text still needed (G0).
3. **Constat terms**: read before the same-input test.
4. **Two review citations** (JAMA, Joint Commission) are unread by us.

## 4. Where we deliberately differ from the review or the playbook

- We keep the custom bounded state machine and Zod, and study LangGraph.js for patterns; we do not adopt Temporal, AutoGen or an agent framework without a tested need.
- The playbook lists 61 repositories; several have licence fields we cannot rely on (NOASSERTION) or old last-push dates (SciFact and MultiVerS 2023). `09-study-register.md` carries the checks; nothing is installed because it is listed.
- One playbook slug (`fivetran/great_expectations`) resolves and is active but should be confirmed as the maintained Great Expectations project before use.
