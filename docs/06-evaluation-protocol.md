# Evaluation protocol: five suites (pre-registration draft v0.2)

Status: draft, 2026-10-27, revised after the outside review (`10-review-disposition.md`). This file is committed before any held-out case is run; after that, changes are appended as a dated erratum, never edited in place. All targets are proposals. **Status after the runs of 2026-10-27:** the five suites were run; results are in `../evals/RESULTS.md` and the changes made after the first held-out runs are in `../evals/ERRATA.md` (E-001 to E-007), not edited into this text. The cases were written and keyed by one builder, so no result here is domain-validity. **The suite called ScopeShift was one blended benchmark in v0.1; it is now one of five.**

## 1. Question

Can the system (a) handle new sources and meanings, (b) keep devices, versions, submissions and studies apart, (c) tell a supported claim from an apparently identical one that differs in one material respect, (d) reconstruct history and invalidate exactly the dependent findings, and (e) behave correctly when things fail? And does each component (federation, identity resolution, memory, long-document reading, guard, compiler) change the outcome in a measurable, fairly measured way?

## 2. What the numbers can and cannot show (read first)

- **Engineering-consistency tests** compare an implementation with a rule table or a specification (the controlled counterfactuals, property tests, drills). They show the code does what we wrote. They do **not** show the rules are clinically right; a rule table and a test derived from it agree by construction. Every result from this class is labelled "consistency" in all reports.
- **Domain-validity tests** need people qualified in the domain who label cases without seeing our system's answer. **No independent reviewer is secured today.** Until one is, authentic cases are labelled "builder-adjudicated with a second reader, not independent", and no sentence anywhere claims clinical or independent validation. A blind model-assisted second annotator may be added as a consistency check only.
- **Demand** (does a buyer want this) is not measured here at all; it has its own gate (P). No score in this file is evidence of demand.

### Leakage and independence rules

- Split by **device or product family**, never by case. All versions, submissions and mutations of one family stay in one partition.
- The same study under different identifiers (NCT, PMID, DOI) counts as one study and stays in one partition.
- Held-out labels are written and sealed before pipeline code is tuned on test-like data; the sealed file's hash is committed. Any look at held-out outputs by the builders is logged as contamination and the case moves to development.
- Reviewers label without seeing the system's proposed verdict; disagreement is recorded, not averaged away.
- Prompt and rule changes after the first held-out run, and early failed runs, are published in an erratum.
- Mutations of one device are not independent evidence of generalisation: statistics are clustered by device (section 6).
- Baselines receive comparable documents and the same query opportunities; access differences and product restrictions are recorded, never hidden.
- Score the **evidence actually used** (anchor and semantic support), not the fluency of the answer.

## 3. The five suites

| Suite | Question | Data | Class |
|---|---|---|---|
| **DiscoveryShift** | Can the system handle genuinely new source layouts and meanings? | held-out source layouts; controlled changes: renamed fields (easy), unit or scale changes (percent vs fraction), meaning swaps (study population vs target population), identifier-format changes, duplicated records, silent truncation | consistency (labels by construction) plus authentic public APIs |
| **IdentityShift** | Does it keep devices, releases, submissions and studies apart and link the right ones? | reviewer-labelled record pairs and hard negatives from the real collisions in the feasibility probe (bare product names, shared brand across products, one submission with many releases) | domain-validity if reviewers exist; otherwise builder with a second reader |
| **ScopeShift** | Does it recognise when evidence fails to support the proposed use? | (A) controlled single-dimension counterfactuals built from authentic scopes; (B) authentic claims adjudicated by reviewers | A consistency, B domain-validity |
| **TimeShift** | Does it reconstruct historical evidence and invalidate exactly the dependent findings after a change? | versioned records and timestamped updates (registry history, snapshot pairs, a withdrawn or corrected record) | consistency plus authentic history |
| **FailureShift** | Does it react correctly to outages, truncation, permissions, injection and model failure? | reproducible fault injection: source off, Zetaris stopped, partial or truncated result, unsupported predicate, invalid model JSON, model timeout, SSRF attempts, injected instructions in documents | consistency |

Set A of v0.1 (controlled counterfactuals) lives inside ScopeShift (A) and DiscoveryShift; Set B (authentic cases) lives inside ScopeShift (B) and IdentityShift. Controlled and authentic results are never pooled.

### ScopeShift (A): construction

For each authentic evidence scope `E`, build a ClaimedUse identical to `E` (a positive control) and then mutate exactly one dimension: version bump or unconfirmed version; population widened (age, condition, an exclusion removed); setting widened; purpose shifted; date outside the evidence period or past a change-control boundary; metric at a different threshold or operating point; a required source unavailable; identity ambiguous. The expected label follows from the construction; where the meaning of "wider" is clinically contestable, the expected label is REQUIRES_DOMAIN_REVIEW and those cases are scored on abstention, not on a verdict.

### Case admission

A case enters any suite only after its full relationship chain is established by hand (identifiers, quotes, versions, populations, settings) with a second reader and recorded disagreements (C-11). A real device is not automatically a good case. The first authentic case is EyeArt (K200667 to NCT03112005 to a PubMed abstract naming version 2.1.0); further candidates (Transpara, Lunit, Viz LVO) are admitted only after the same check.

## 4. Arms (identical inputs)

| Arm | Description |
|---|---|
| B0 | Manual source-by-source research (reviewer study only; time and correctness) |
| B1 | Keyword and structured-rule baseline over the same records, no model |
| B2 | Source-by-source SQL or search |
| B3 | A single Nemotron call with all retrieved documents in context |
| B4 | A generic tool-using Nemotron agent: same tools, same model, no compiler and no identity layer |
| B5 | Zetaris natural-language-to-SQL / MCP path with none of our layers, if reachable |
| B6 | Accessible incumbents on the same cases under their permitted terms: Constat's free MCP tier (device evidence fields; no claim input), the HealthIT.com JSON ledger (no scope fields); others where trial access is legitimate; otherwise recorded as not run |
| V | Sakaime full |
| V-minus-X | Sakaime with component X removed (federation, identity resolver, compiler, critic, each Meterless engine), measured as in `03` s6 and `04` s4 |

Model-dependent arms run three times; the worst run is reported beside the mean. Sponsor comparisons follow the fairness rules in `03` and `04`: measure the real effect, never engineer a loss.

## 5. Metrics

Primary (all reported together, never one alone):

1. **False-supported rate**: cases labelled SUPPORTED_FOR_SCOPE (or with a broader narrower-scope than warranted) although the expected label is lower. Reported with denominator and Wilson interval; for zero observed errors, the upper bound.
2. **Critical mismatch recall**: planted material mismatches named correctly (dimension and both values) with a valid anchor.
3. **False-alarm rate**: well-supported claims flagged or sent to review, and **correct-SUPPORTED rate**. A system that refuses everything must not look safe.

Secondary: correct abstention (unknown vs negative); scope-label accuracy; identity precision, recall and correct abstention on ambiguous pairs; quote validity and **semantic-support validity** reported separately; temporal accuracy (back-in-time query); change-impact exactness (stale set equals dependent set); source-off correctness (correct degraded state per the dependency rules); injection success rate and false-block rate on look-alike legitimate requests; mapping correctness on semantic mutations; reviewer time (B0 vs V); cost and latency; token cost labelled estimated or measured.

## 6. Statistics and sample size

Paired binary outcomes: exact McNemar test per arm pair; effect as the difference of proportions with a Wilson-based interval; **cluster bootstrap by device** for repeated cases; Holm correction across the primary comparisons. Report **effective sample size** (clusters, not cases). Every run is reported, including negative and tied outcomes. A zero-error sample does not show zero error in the world.

Proposed targets: at least 120 controlled cases across at least 20 devices for ScopeShift (A), at least 30 authentic cases for ScopeShift (B) if reviewers can be obtained. These are engineering goals with uncertain power; the quality and independence of authentic cases matter more than the count. If fewer can be built, report the actual number and the resulting interval widths. Reached: 222 controlled cases over 18 summaries in 17 device families (the 20-device target was not reached) and 26 development plus 20 held-out authentic claims over 12 and 5 devices (the 30-case target for one set was not reached). The feasibility report (12 devices, 8 with an exact or strong study link, 1 with a matching version) suggests authentic cases will be few; that is stated, not hidden.

## 7. Source-off and degradation suite (FailureShift; T6)

For each case rerun with: FDA source off; registry off; both off; Zetaris stopped; a truncated result; a partial result; an unsupported predicate; invalid model JSON; a model timeout; a corroborating-only source off. Expected: required-source loss yields unresolved or insufficient with the reason; corroborating-source loss changes only the displayed explanation; nothing becomes "supported" and nothing becomes "none exist". Metric: share of drills with the correct state.

## 8. Reviewer study (T8), if reviewers are obtained

Two independent reviewers per case, within-subject: source-by-source first or tool-assisted first, order randomised. Measures: whether the key mismatch is identified, time to the finding, whether missing evidence is correctly listed, the escalation decision. Small samples are described as exploratory; no clinical claim is made.

## 9. Reporting and public wording

A results file per run (JSON) and a report with the table of arms, failures with examples, the ablation table, the contamination log, the erratum log and the list of what was not run. The README links the pre-registration commit and the sealed-label hash. In every public text (README, deck, video, form), a number appears only if it comes from a results row; until then the slot reads "to be measured". The wording lint is extended to reject unmeasured figures. The ideal public claim has this shape, filled only after measurement: independent or builder-labelled cases evaluated (N, with the class); material discrepancies correctly identified; incorrect support conclusions with interval; correct abstentions; the strongest baseline and its result; reviewer time saved only if measured; identity and source failures published; cost and latency.
