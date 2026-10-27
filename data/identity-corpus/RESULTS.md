# Identity resolution: measured results

Run date 2026-10-27. Produced by `npx tsx src/identity/run-eval.ts`; every figure below is computed by that run from the files in this folder.
Corpus hash 33d64d68ccecc163; model hash c08930f61484686e; scorer `supervised-counting-with-shrinkage`.

## What was run

The resolver in `src/identity` was run on every labelled pair in `pairs.json`. Records are in `records.json`; each carries a `fixtureRef` to the pinned public data in `data/fixtures/feasibility`, and `tests/identity/corpus.test.ts` re-checks that the quoted fields still match those files.

- 120 records (50 AuthorizationSubmission, 16 SoftwareRelease, 24 Study, 30 Publication) from 14 device families plus 6 unrelated-pair controls.
- 150 labelled pairs (17 SAME_SUBMISSION, 18 SAME_MARKETED_VERSION, 42 SAME_PRODUCT, 59 STUDY_EVALUATES, 14 PUBLICATION_REPORTS). Truth: 62 MATCH, 66 NON_MATCH, 22 AMBIGUOUS.
- Every label is builder-labelled by one reader (the builder), not independently reviewed. 9 pairs are marked contestable. 42 labels rest on an identifier or structured field in the records; 108 rest on the builder reading text.
- purposeTags, module, and the manufacturer of studies and papers were annotated by the builder from the quoted text (the manufacturer by a fixed vendor-name scan). They stand in for what a document extractor would supply.

System output counted as a link: CONFIRMED or CANDIDATE. AMBIGUOUS is abstention. REJECTED is a refusal. A pair not proposed at all is reported as "not proposed". A model proposal is not used in this run.

## Headline: leave-one-family-out (the figure to read)

For each device family, the scorer was trained on every labelled pair that touches no record of that family, then that family's pairs were resolved. 144 pairs, 14 families.

| Measure | Pairs as independent | Families as the unit |
|---|---|---|
| Precision (links that are true) | 1.000 (48/48; Wilson 0.926 to 1.000) | 1.000 (cluster bootstrap 1.000 to 1.000, 14 families) |
| Recall (true links found as CANDIDATE or CONFIRMED) | 0.774 (48/62; Wilson 0.656 to 0.860) | 0.774 (cluster bootstrap 0.667 to 0.877, 14 families) |
| Surfaced recall (true links found or shown as AMBIGUOUS) | 0.968 (60/62; Wilson 0.890 to 0.991) | 0.968 (cluster bootstrap 0.905 to 1.000, 14 families) |
| Correct abstention (AMBIGUOUS pairs left AMBIGUOUS) | 0.909 (20/22; Wilson 0.722 to 0.975) | 0.909 (cluster bootstrap 0.737 to 1.000, 14 families) |
| False-merge rate (non-matches called a link) | 0.000 (0/60; Wilson 0.000 to 0.060) | |
| Overconfident on ambiguous (called a link) | 0.000 (0/22; Wilson 0.000 to 0.149) | |
| Over-rejected on ambiguous (called REJECTED) | 0.000 (0/22; Wilson 0.000 to 0.149) | |
| Confirmed where truth is not MATCH | 0 | must be 0 |
| Pairs expected to reach CONFIRMED that did | 1.000 (21/21; Wilson 0.845 to 1.000) | |
| Expected mismatch flags present | 1.000 (33/33; Wilson 0.896 to 1.000) | |

Outcomes by truth: MATCH: link 48 (of which confirmed 21), abstain 12, rejected 0, not proposed 2. NON_MATCH: link 0 (of which confirmed 0), abstain 10, rejected 19, not proposed 31. AMBIGUOUS: link 0 (of which confirmed 0), abstain 20, rejected 0, not proposed 2.

Unrelated-pair controls (6): link 0 (of which confirmed 0), abstain 0, rejected 0, not proposed 6.

## For comparison: trained and scored on the same pairs

Optimistic, since the model has seen every pair it is scored on. The gap to the table above is the cost of unseen devices.

| Measure | Pairs as independent | Families as the unit |
|---|---|---|
| Precision (links that are true) | 1.000 (49/49; Wilson 0.927 to 1.000) | 1.000 (cluster bootstrap 1.000 to 1.000, 14 families) |
| Recall (true links found as CANDIDATE or CONFIRMED) | 0.790 (49/62; Wilson 0.674 to 0.873) | 0.790 (cluster bootstrap 0.687 to 0.889, 14 families) |
| Surfaced recall (true links found or shown as AMBIGUOUS) | 1.000 (62/62; Wilson 0.942 to 1.000) | 1.000 (cluster bootstrap 1.000 to 1.000, 14 families) |
| Correct abstention (AMBIGUOUS pairs left AMBIGUOUS) | 0.909 (20/22; Wilson 0.722 to 0.975) | 0.909 (cluster bootstrap 0.714 to 1.000, 14 families) |
| False-merge rate (non-matches called a link) | 0.000 (0/60; Wilson 0.000 to 0.060) | |
| Overconfident on ambiguous (called a link) | 0.000 (0/22; Wilson 0.000 to 0.149) | |
| Over-rejected on ambiguous (called REJECTED) | 0.000 (0/22; Wilson 0.000 to 0.149) | |
| Confirmed where truth is not MATCH | 0 | must be 0 |
| Pairs expected to reach CONFIRMED that did | 1.000 (21/21; Wilson 0.845 to 1.000) | |
| Expected mismatch flags present | 1.000 (33/33; Wilson 0.896 to 1.000) | |

## By link type and by label quality (leave-one-family-out, hard pairs)

| Stratum | Pairs | Match/Non/Amb | Precision | Recall | Surfaced recall | Correct abstention | False confirms |
|---|---|---|---|---|---|---|---|
| SAME_SUBMISSION | 17 | 9/8/0 | 1.000 | 1.000 | 1.000 | n/a | 0 |
| SAME_PRODUCT | 39 | 20/15/4 | 1.000 | 0.900 | 1.000 | 1.000 | 0 |
| SAME_MARKETED_VERSION | 18 | 4/11/3 | 1.000 | 1.000 | 1.000 | 1.000 | 0 |
| STUDY_EVALUATES | 57 | 23/22/12 | 1.000 | 0.478 | 0.913 | 0.917 | 0 |
| PUBLICATION_REPORTS | 13 | 6/4/3 | 1.000 | 1.000 | 1.000 | 0.667 | 0 |
| labelled by identifier | 42 | 22/20/0 | 1.000 | 0.955 | 1.000 | n/a | 0 |
| labelled by reading | 102 | 40/40/22 | 1.000 | 0.675 | 0.950 | 0.909 | 0 |
| firm labels | 135 | 53/60/22 | 1.000 | 0.868 | 1.000 | 0.909 | 0 |
| contestable labels | 9 | 9/0/0 | 1.000 | 0.222 | 0.778 | n/a | 0 |

## Where the system and the labels disagree (leave-one-family-out, hard pairs)

| Pair | Link type | Truth | System | Disagreement | Label basis |
|---|---|---|---|---|---|
| anumana-131 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 9.152 bits | true link not proposed as a link (abstain) | contestable |
| anumana-132 | STUDY_EVALUATES | MATCH | AMBIGUOUS, -0.96 bits | true link not proposed as a link (abstain) | reading |
| caption-027 | SAME_PRODUCT | MATCH | AMBIGUOUS, 3.32 bits | true link not proposed as a link (abstain) | identifier |
| caption-032 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 8.597 bits | true link not proposed as a link (abstain) | contestable |
| eyeart-012 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 8.493 bits | true link not proposed as a link (abstain) | reading |
| gigenius-114 | PUBLICATION_REPORTS | AMBIGUOUS | none, 0.739 bits | ambiguous pair not left AMBIGUOUS (silent) | reading |
| heartflow-119 | SAME_PRODUCT | MATCH | AMBIGUOUS, 3.257 bits | true link not proposed as a link (abstain) | reading |
| heartflow-123 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 2.724 bits | true link not proposed as a link (abstain) | contestable |
| heartflow-125 | STUDY_EVALUATES | AMBIGUOUS | none, 0.868 bits | ambiguous pair not left AMBIGUOUS (silent) | reading |
| idxdr-019 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 9.22 bits | true link not proposed as a link (abstain) | reading |
| lunit-101 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 7.225 bits | true link not proposed as a link (abstain) | reading |
| transpara-078 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 0.863 bits | true link not proposed as a link (abstain) | reading |
| viz-049 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 2.206 bits | true link not proposed as a link (abstain) | contestable |
| viz-050 | STUDY_EVALUATES | MATCH | AMBIGUOUS, 2.185 bits | true link not proposed as a link (abstain) | contestable |
| viz-051 | STUDY_EVALUATES | MATCH | none, -1.447 bits | true link not proposed as a link (silent) | contestable |
| viz-052 | STUDY_EVALUATES | MATCH | none, -0.368 bits | true link not proposed as a link (silent) | contestable |

A true link shown as AMBIGUOUS is not lost: it reaches the reviewer with its waterfall and flags. A true link not proposed at all is a miss of recall.

## Safety invariants

- CONFIRMED results whose truth is not MATCH: 0 in leave-one-family-out, 0 in the whole-corpus fit.
- CONFIRMED results reached without an exact identifier: 0. Only an exact identifier or a reviewer decision produces CONFIRMED; the scorer cannot (tests/identity/properties.test.ts).

## Without the builder's annotations

Studies and papers rely on use tags, module and manufacturer that the builder read from their text; a document extractor would have to supply them. Leave-one-family-out with those fields removed from every study and paper (names, text, identifiers, dates and enrolment stay):

| | With annotations | Without annotations |
|---|---|---|
| Precision | 1.000 (48/48; Wilson 0.926 to 1.000) | 1.000 (41/41; Wilson 0.914 to 1.000) |
| Recall | 0.774 (48/62; Wilson 0.656 to 0.860) | 0.661 (41/62; Wilson 0.537 to 0.767) |
| Surfaced recall | 0.968 (60/62; Wilson 0.890 to 0.991) | 0.935 (58/62; Wilson 0.846 to 0.975) |
| Correct abstention | 0.909 (20/22; Wilson 0.722 to 0.975) | 0.864 (19/22; Wilson 0.667 to 0.953) |
| Confirmed where truth is not MATCH | 0 | 0 |

## Unlabelled cross-family sweep

Every pair of records from different device families, under every link type their kinds allow, with the whole-corpus model (which has seen some of these pairs as labelled non-links). Records of different families are different products, studies and papers, so none of these should be a link.

- 11766 combinations: AMBIGUOUS 230, REJECTED 2186, not proposed 9350.
- Called a link (CONFIRMED or CANDIDATE): 0.
- This is a check on records the labelled pairs do not cover, not a measured precision: it contains only negatives.

## Blocking

Blocking keys: manufacturer or alias group, product code, brand token of a name (and brand tokens found in study and paper text), stated use, study size, and every owned or cited identifier.

- Records 120; possible pairs 7140; pairs kept 1403; comparisons avoided 80.4%.
- True links reachable after blocking: 1.000 (62/62; Wilson 0.942 to 1.000).
- All labelled pairs reachable after blocking: 142/150.

## Sensitivity to the strong-candidate floor

The strong band starts at the larger of the highest-scoring training non-link and a fixed floor in bits of evidence (a likelihood ratio of 2^floor to 1). The floor is a design choice. It was 4 in the first run and was lowered to 2 after that run showed correct SAME_PRODUCT links all scoring between 3 and 4 bits. The corroboration gate, not the floor, is the main safeguard against false candidates. Leave-one-family-out results at three floors:

| Floor (bits) | Precision | Recall | Surfaced recall | Correct abstention | False confirms |
|---|---|---|---|---|---|
| 0 | 1.000 (48/48) | 0.774 (48/62) | 0.968 | 0.955 | 0 |
| 2 | 1.000 (48/48) | 0.774 (48/62) | 0.968 | 0.909 | 0 |
| 4 | 1.000 (45/45) | 0.726 (45/62) | 0.935 | 0.864 | 0 |

## Changes made after seeing results (disclosed)

This corpus was used both to design and to evaluate the resolver, so the figures above are development-set figures. Changes made after a first run exposed errors:

1. SAME_MARKETED_VERSION is rejected whenever two fully specified release labels disagree, whether or not the records share a submission (the first version required a shared submission).
2. The strong-candidate floor was lowered from 4 to 2 bits (see above).
3. A strong candidate now needs two independent kinds of positive evidence (name, manufacturer, design numbers, equal version, product code); agreement of intended use is context, not independent evidence. A name shared by several list rows needs agreeing use before it counts as a name.
4. Manufacturer agreement is not counted as independent when the product name contains the company name (Paige Prostate, Lunit INSIGHT).
5. Pairs with a matching brand but disagreeing details are surfaced as AMBIGUOUS with their flags instead of being dropped, because the mismatch is what a reviewer needs to see.
6. One label was corrected: pubmed:32371116 against DEN200055 was labelled AMBIGUOUS; its abstract names GI Genius and Medtronic, so it is MATCH.
7. Abstract text in the records was lengthened to the full abstract.
8. Blocking on stated use and study size was added after the first run lost four true links that share no brand or manufacturer.
9. A product name followed by a descriptor ("Lunit INSIGHT CXR Triage") now matches the name without it, a name contained in another record is checked against the multi-row name list like an exact name, and the word "briefcase" is treated as generic only when found in free text, not in another record's name.
10. Documented product-name drift (IDx-DR and LumineticsCore, Caption Guidance and EchoGPS, ContaCT and Viz LVO) was added as a flag, after the first run showed those renames were invisible to the reviewer.

## Caveats

- Small sample: 150 pairs from 14 device families. Intervals are wide; read the cluster bootstrap, not the Wilson interval, since pairs of one family are not independent.
- One reader. The labels have not been checked by a second person, let alone an independent expert, and this is not an independent validation.
- The pairs were chosen from the real collisions in the feasibility report, so the non-matches are harder than a random sample. Precision here is not the precision on a random stream of candidate pairs.
- Recall depends on annotations a document extractor must supply (purpose, module, manufacturer of studies and papers). Without them it is lower (see the ablation above); precision did not change.
- A paper that names a device only by a brand carried by a different record (for example "Viz.ai software" against the De Novo named ContaCT) is not linked, because the system does not yet propagate names across linked product records.
- A publication is not linked to a product through its study: PUBLICATION_REPORTS and STUDY_EVALUATES are resolved separately and not composed.
- Match weights are ranking evidence in bits under an independence assumption that does not hold; they are not probabilities.
- Not run: a model adjudication (needs the model route), reviewer confirmation at scale, and any pair outside the 12 devices and their collisions.
