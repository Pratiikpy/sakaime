# Same-input test: protocol (Gate 0, G2)

Version 1, 2026-10-27. Written before any Sakaime run and before any generic-model run. Changing a rule below after a run is a deviation and must be recorded next to the result.

## 1. Question and decision rule

Question (`docs/DECISIONS.md` G2, `docs/08-build-plan.md` Gate 0): is there a defensible gap between Sakaime and what already exists, measured on the same inputs?

Decision rule, as written in the competition report and the build plan: *a rival that matches Sakaime on 80 percent or more of the claims removes the gap.* The sentence is ambiguous, so two readings are fixed here in advance and both are reported:

- **T-A (absolute).** A rival satisfies T-A if its exact-label accuracy on the 26 claims is at least 0.80 **and** its false-supported count is no higher than Sakaime's. For an arm that emits no verdict, T-A is not satisfiable.
- **T-B (substitutability).** A rival satisfies T-B if its verdict equals Sakaime's verdict on at least 80 percent of the claims.
- **Ceiling (reviewer-assisted).** For arms that emit no verdict: a claim is DERIVABLE if every fact the key needs appears in the arm's output for the claim's device (fact lists in `tools/score-arms.mjs`). The gap is removed on the ceiling reading if DERIVABLE reaches at least 80 percent.

The gap is **removed** if any arm satisfies T-A, or T-B with a lower false-supported count than Sakaime, or the ceiling. It **stands on this evidence** if none does. Standing is not evidence of quality: it means no rival tested here removed it.

## 2. Inputs

- `claims.jsonl`: 26 CONSTRUCTED claims (each line carries the notice). Claim shape is `ClaimSchema` from `src/schemas/scope.ts` (`claim`), plus the plain `claimedUse` fields (product, version, population, setting, purpose, date).
- `evidence-sets.json`: 23 evidence items in `EvidenceItemSchema` shape with anchored quotes. Each claim lists its `evidenceSetIds`.
- `ANSWER-KEY.md` and the `key` object of each line: expected label, acceptable labels, key confidence, mismatch dimensions, supported narrower scope, anchored quotes.
- Raw records: `research/feasibility/fixtures/**` and `evals/gate0/raw/**`, every one hashed and anchored (`tools/build-claims.mjs` fails if a quote is missing or a fixture hash differs from `MANIFEST.md`).
- 26 claims over 12 devices. Claims on one device are correlated, so the effective sample is about 12 clusters; intervals use a cluster bootstrap by device (docs/06 s6), not a plain binomial.

## 3. Arms and comparable access

| Arm | What it gets | Query opportunities | Notes |
|---|---|---|---|
| Constat free MCP | one `device_evidence_lookup` per K/DEN number | one per distinct device (13 numbers) | no tool takes claim text; terms in COMPETITOR-ARMS.md |
| HealthIT.com ledger | the whole claim ledger, joined by product slug | one fetch | no claim input; 4 of 12 devices have a product row |
| Sakaime, mode M1 (compiler only) | the key's `claim` and `evidenceSetIds` items | one `compile` per claim | tests the compiler, not discovery; **leaks the hand-derived evidence items**, so M1 can never be the G2 result |
| Sakaime, mode M2 (full pipeline) | the claim text and the product identity only; discovery, extraction, linking and compilation run from the sources | one query per claim | the G2 result; same raw records as the key, from cassettes or live sources |
| Generic model, B3/B4 of docs/06 | the same retrieved documents as M2, one Nemotron call (B3) or a tool-using agent without compiler or identity layer (B4) | same as M2 | **not run in Gate 0; the arm most likely to approach 80 percent** |

Rules against rigging:

1. Every arm sees the same 26 claims and the same 12 devices; no arm sees the key or the other arms' output.
2. No arm gets a second query to correct a first one. A failed call is recorded as UNAVAILABLE, not retried into a pass.
3. Access differences are recorded in the table above and in each result file. The ceiling reading favours the incumbents (a human does the comparison they cannot); the claim authorship favours Sakaime (same builder as the key).
4. Competitor calls stay inside their stated terms (COMPETITOR-ARMS.md section 2). An arm that cannot be run within its terms is marked BLOCKED with the clause.
5. Model-dependent arms run three times; the worst run is reported beside the mean (docs/06 s4).
6. The key is frozen before the Sakaime and generic-model arms run. Any later key change is a deviation, listed with the reason, and the results before and after are both reported.
7. The mapping from this key's vocabulary (setting, purpose and condition strings) to the compiler's taxonomies is fixed and committed before the M1 or M2 run and not tuned afterwards (section 7).

## 4. Scoring per claim

For each arm and each claim record: the label emitted (or NONE), the evidence it cited, and whether the citation is **sound**: at least one cited record is one of the claim's `keyQuotes` sources and the cited text supports the mismatch dimension. Then:

- **Exact**: emitted label equals `key.expectedLabel`.
- **Acceptable**: exact, or in `key.acceptableLabels` (labels that withhold support when the key is contestable).
- **False-supported**: the arm emits SUPPORTED_FOR_SCOPE or SUPPORTED_ONLY_FOR_NARROWER_SCOPE where the key's expected label is lower. For a narrower-scope key, SUPPORTED_FOR_SCOPE is false-supported; for a contestable key, the acceptable labels never include a SUPPORTED label.
- **Correct abstention**: on a claim whose `key.keyConfidence` is contestable or whose key is INSUFFICIENT_EVIDENCE or REQUIRES_DOMAIN_REVIEW, the arm emits INSUFFICIENT_EVIDENCE or REQUIRES_DOMAIN_REVIEW. Unknown is never reported as false and never as safe.
- **Critical mismatch recall** (17 mismatch claims): the arm's emitted mismatch names the key's dimension and both values, with a valid anchor.
- **False-alarm rate** (9 positive controls): an exact label other than SUPPORTED_FOR_SCOPE on a positive control. Reported beside the correct-SUPPORTED rate so that refusing everything cannot look safe.
- **Source-cited evidence**: share of emitted verdicts with a sound citation. A verdict with no citation scores zero on this measure even when the label is right.
- **Semantic soundness** (not just quote existence) is checked by hand on every claim where the arm's label is exact, because a quote can exist and not support the verdict.

Reporting: counts with denominators, Wilson intervals, cluster bootstrap by device for paired differences, exact McNemar between Sakaime and each rival, Holm correction across the primary comparisons; zero errors are reported with the upper bound (a zero in a sample is not zero in the world). Contested keys are reported separately from clear keys.

## 5. Pass and stop criteria

- **Gap stands**: no rival reaches T-A, T-B with fewer false-supported, or the ceiling at 80 percent.
- **Gap removed (stop or pivot per docs/08)**: any rival does. Report the arm, the reading and the numbers; do not change the reading to rescue the result.
- **Not decided**: if the Sakaime arm or the generic-model arm has not run, G2 stays open. Gate 0 incumbents result so far: COMPETITOR-ARMS.md.
- A Sakaime false-supported count above zero on the clear-key claims is a defect to fix before any claim of safety, whatever the rival does.

## 6. What is not covered

Innolitics, ACR AI Central, AI TrustMark and other products were not run (no legitimate trial access established). Constat's paid assessment and keyed MCP were not run. Device classes outside the 12 (PMA devices, wearable ECG, pathology beyond prostate) are absent. No clinician or second human has read the key. Claim wording is by the builder of the key.

## 7. Interface for the Sakaime arm (no harness file is written)

`src/compiler` exists on disk as of this writing and is in flux, so no `run-sakaime-arm.ts` is committed: a harness needs a vocabulary mapping and three option choices that change the result, and those are the lead's decisions. The call is `compile(claim: unknown, evidence: unknown, options?: CompileOptions): Finding` from `src/compiler/index.ts`.

A runnable harness is about 40 lines: read `claims.jsonl` and `evidence-sets.json`; for each claim map the vocabulary; call `compile(c.claim, c.evidenceSetIds.map(id => items[id]), options)` with `evidence` items passed as `{...item, anchorIds: anchors.map(a => a.id)}` (the `anchors` field is the key's own and the schema rejects it); compare `finding.label` with `c.key`; write one JSONL row per claim (claim id, label, mismatches, anchor ids, trace id) for the scorer in section 4. `tools/validate-schemas.ts` shows the exact schema-valid shape.

Decisions the lead must fix and commit first:

1. **Vocabulary map.** The key uses `dr_screening_detection`, `concurrent_reading_aid`, `triage_notification`, `ai_supported_reading_triage`, `tb_screening`, `ai_assisted_second_reading`, `autonomous_reading`, `assistive_detection_after_initial_review`, `computer_assisted_lesion_detection`, `coronary_risk_and_functional_assessment`, `lvef_40_screening`, `echo_image_acquisition_guidance`, `dr_progression_monitoring`, settings `primary_care`, `eye_care`, `hospital`, `screening_program`, `endoscopy_unit`; conditions are free strings. `DEFAULT_PURPOSE_TAXONOMY` has `screening`, `detection_aid`, `triage_notification`, `monitoring`, `acquisition_guidance`, `diagnosis`, `prognosis`. The mapping changes outcomes: for example `autonomous_reading` mapped to `diagnosis` (wider than `detection_aid`) gives PARTIAL, while the key treats it as DISJOINT.
2. **requiredDimensions.** The compiler default is every dimension but metric. The key treats a claim-unspecified dimension as not asserted (ANSWER-KEY.md, semantic 1). Under the default, claims silent on setting or date become UNKNOWN and no positive control can be SUPPORTED. Pass `requiredDimensions` per claim or change the rule; then record which.
3. **policy.stalenessWindowDays.** With none set, the compiler never raises the staleness rule; the key expects REQUIRES_DOMAIN_REVIEW for EA-03 because no source states a window. Choose a window and say so, or accept that EA-03 is a known miss.

**Informational dry run, not scored.** A throwaway run of the compiler as it stood on 2026-10-27 (raw vocabulary, `requiredDimensions` set to each claim's specified dimensions) gave on the final key: exact 12, acceptable 4, other 10. The 10 are all INSUFFICIENT_EVIDENCE where the key is higher or different: EA-01, EA-02, EA-03, EA-05, GI-01, GI-02, AN-01, AN-02, ID-01, ID-02. The common cause is that the FDA indications say 'adults' without a number while the claims state an age, so the authorization item's age is UNKNOWN and the study item's age does not rescue it. That makes four positive controls (EA-01, GI-02, AN-01, ID-01) false alarms. It may be a compiler defect (an 'adults' convention is missing) or a key defect (the key assumes a study item can supply what the indication leaves unsaid); it needs a second reader. On the first encoding of the evidence (age numbers placed in the authorization items) the same compiler returned CONTRADICTED_BY_SPECIFIED_EVIDENCE for EA-02, GI-01, AN-02 and CP-01 where the key says narrower scope, which is the reading 'explicit authorization limit', also worth an explicit decision. EA-03 returned SUPPORTED_FOR_SCOPE on the first encoding: with no policy the successor clearance and the six-year gap are invisible, which the key counts as false-supported.

## 8. Reproduce

From the repository root, in this order (Node 24): `node evals/gate0/tools/build-eyeart-manifest.mjs`, `node evals/gate0/tools/second-pass-eyeart.mjs`, `node evals/gate0/tools/finalize-eyeart.mjs`, `node evals/gate0/tools/build-claims.mjs`, `npx tsx evals/gate0/tools/validate-schemas.ts`, `node evals/gate0/tools/render-key.mjs`, `node evals/gate0/tools/score-arms.mjs`, `node evals/gate0/tools/render-arms.mjs`. The Constat arm needs its raw responses, which are not committed (terms s.3); re-running `tools/run-constat.mjs <K numbers>` re-fetches them within the rate limit, and `calls.jsonl` holds the hash each response had on 2026-10-27, which a re-fetch may legitimately differ from (their extraction is refreshed weekly).
