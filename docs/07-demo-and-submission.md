# Demo, deck, README and submission plan

Status: plan, revised 2026-10-27 after the web app, the sample run and the evaluation results existed. **No video, deck, sponsor explanation or HackOS form has been produced**; this file is the script text and the checklist for them. The README is written (`../README.md`). The first authentic case is EyeArt (the one chain the feasibility probe found machine-checkable end to end); the vendor claims are constructed and labelled so on screen. Every claim in the video, deck and README must cite a row in a results file or be removed. Visual direction: the Blank brand kit (ink on white, one green accent, rust red for failure, Outfit and JetBrains Mono, redaction-bar motif, terse voice).

## 0. What the product shows today

Screen names are the ones in the navigation (`ui/src/components/Layout.tsx`): **Review desk**, **Sources**, **Guard**, **About and limits**, and for one case **Overview**, **Evidence matrix**, **Claim X-ray**, **Applicability lab**, **Timeline**, **Investigation**, **Resilience** and **Dossier**. A banner on every screen states the run mode (sample, with recorded replies, or live).

The EyeArt case (`eyeart-k200667`, "EyeArt 2.1.0: diabetic retinopathy detection in primary care") holds the hospital's intended use and ten constructed vendor claims. The labels below are the recorded run (`data/sample/run/labels.json`; reproduced by `npm run judge` and, in a live run on 2026-10-27, by `output_examples/live-smoke-eyeart.json`):

| Claim | What the vendor sentence says | Label |
|---|---|---|
| intended use (`CASE-2026-014.intended`) | primary-care clinics screening adults with diabetes and no earlier diagnosis of more than mild retinopathy, sensitivity of at least 85 percent | REQUIRES_DOMAIN_REVIEW |
| CLM-EA-01 | the pivotal study's own population (22 and older, with the study's exclusions), primary care and eye care, Canon CR-2 cameras | SUPPORTED_FOR_SCOPE |
| CLM-EA-02 | covers patients with diabetes of all ages, including children | REQUIRES_DOMAIN_REVIEW |
| CLM-EA-03 | prioritisation for patients in the emergency department or admitted to hospital | INSUFFICIENT_EVIDENCE |
| CLM-EA-04 | the 2026 release, version 3.0, is covered by the same clearance and study | INSUFFICIENT_EVIDENCE |
| CLM-EA-05 | works with any colour fundus camera | REQUIRES_DOMAIN_REVIEW |
| CLM-EA-06 | diagnoses retinopathy and replaces the dilated eye examination | SUPPORTED_ONLY_FOR_NARROWER_SCOPE |
| CLM-EA-07 | detects more than mild retinopathy in adults 22 and older, primary and eye care | SUPPORTED_ONLY_FOR_NARROWER_SCOPE |
| CLM-EA-08 | also detects it in patients already diagnosed with more than mild retinopathy | CONTRADICTED_BY_SPECIFIED_EVIDENCE |
| CLM-EA-09 | sensitivity of at least 96 percent in primary care and eye care | REQUIRES_DOMAIN_REVIEW |
| CLM-EA-10 | the pivotal population extended to ages 18 to 21 | SUPPORTED_ONLY_FOR_NARROWER_SCOPE |

One claim is supported, three are supported only for a narrower use, one is contradicted, two are insufficient and three (plus the intended use) need a domain review. The Lunit (`lunit-k211733`) and Transpara (`transpara-k221347`) cases are INSUFFICIENT_EVIDENCE throughout: their recorded runs show what the product does when the studies leave dimensions open, and they carry the AMBIGUOUS identity links (Lunit: 8 study links, 7 publication links and 2 release links AMBIGUOUS; Transpara: a 1.7.0 versus 1.7.2 study left AMBIGUOUS with its weight waterfall). The EyeArt case has five CONFIRMED links and one CANDIDATE (NCT04302012, 4.325 bits, "version-stated-on-one-side-only: 2.1.0") and no AMBIGUOUS link, so the ambiguity scene uses the Transpara case.

## 1. The four-minute demo (target 3:50, hard cap 4:00)

The judge must see a source nobody wired up get discovered and joined through Zetaris, an identity left uncertain on purpose, a conclusion that changes when the use changes, and a failure that makes the system less sure instead of falsely sure. A recorded response is labelled recorded; a cassette is never shown as a live federation call. Chapter timings are targets to be checked against frames.

| Time | Scene and screen | Exact demonstration | Sponsor effect shown | Recorded or live |
|---|---|---|---|---|
| 0:00 to 0:25 | **The decision.** Review desk, then the EyeArt Overview | The hospital's intended-use sentence and the ten constructed vendor claims; the "constructed" notice is on screen; one line on why the evidence sits in regulator, registry, literature, vendor and hospital systems | none | Sample mode |
| 0:25 to 1:10 | **Add a source.** Sources, "Add a source" | Run the allowed example (FDA device identifier records for K221347): the eight stages (Authorization, Capability discovery, Bounded probe, Mapping proposal, Semantic check, Human review, Registration, Monitoring) with the mapping and its checks. Then the cloud-metadata example, refused at Authorization with the reason, and the unlisted-host example. Say what the semantic check did only if the stage text says it | Zetaris catalog and registration; Nemotron mapping proposal | The stage outcomes must come from a run made for the video; sample mode replays the recorded model reply, and the banner says so |
| 1:10 to 1:55 | **One query, one matrix.** Evidence matrix, then Claim X-ray on CLM-EA-01 and CLM-EA-08 | The statement that joined Postgres, registry snapshots and vendor files (query id, row counts, "recorded" or "live"); the seven dimensions claimed against established, with the passage, page, source and retrieval date; CLM-EA-01 is the one supported claim, CLM-EA-08 is contradicted because its population is disjoint from the evidence's | Zetaris federation; Markovian reading of the long summary | Sample mode, or live if Docker and the Zetaris stack are up |
| 1:55 to 2:25 | **An identity left uncertain.** Transpara case, Claim X-ray, a link with its waterfall | A study that reports version 1.7.0 against the cleared 1.7.2 stays AMBIGUOUS with the flags "version-differs" and "family-name"; no merge, and the claim stays INSUFFICIENT_EVIDENCE | H-MEM keeps confirmed links; World Model timeline | Sample mode |
| 2:25 to 2:55 | **Change the use.** EyeArt, Applicability lab | Version 2.1.0 to 3.0 on CLM-EA-01: SUPPORTED_FOR_SCOPE becomes INSUFFICIENT_EVIDENCE (`output_examples/api/recompute-release-3-0.json`: the version dimension goes from CONTAINED to DISJOINT, no model called); then the age range 18 to 21 | deterministic compiler | Live in the browser against the recorded evidence |
| 2:55 to 3:25 | **A failure.** Resilience | Run "Source off" on the study source and "Zetaris off": every finding becomes INSUFFICIENT_EVIDENCE with the reason (not supported, not "no evidence exists"); the invariant line reads that it held. Then the registry change drill: only dependent findings go stale | Zetaris kill drill; World Model dependency tracking | Drills run through the real code on the recorded evidence; the Zetaris stop is live only if the stack is running, otherwise it is injected at the port and the screen says so |
| 3:25 to 3:45 | **The tamper test.** Dossier, "Try to cheat" | Export the signed dossier, change one character, and the verifier names the failing item ("content changed since signing (hash mismatch)"); say that the signature shows integrity and not who signed, because the key is a demo key | Scout contract signing; Nightshift receipts only if they exist | Scripted with Playwright so every frame is the real run |
| 3:45 to 3:55 | **The limits, then the close.** About and limits | Read three limits aloud: the vendor claims are constructed; one builder labelled everything and no clinician has read it; the full pipeline is conservative and flagged all nine well-supported development claims. Links to GitHub | none | none |

### What must be said, on screen or aloud

- Every vendor claim and the hospital requirement are constructed; the regulator, registry and publication records are real and carry retrieval dates.
- The default run replays recorded replies from the real services; the compiler, identity scorer, verifiers and guard run for real on them. The banner shows which mode is active.
- On the 26 development claims the full pipeline labelled none of the 17 unsupported claims as supported; it was exactly right on 9 of 26 and flagged all 9 well-supported claims. The generic Nemotron arms were more often exactly right and labelled 20 to 39 percent (means over runs) of the unsupported claims as supported. Both statements, with the class "builder-labelled", belong in any slide that shows the result (`../evals/RESULTS.md`).
- Nobody who runs a hospital AI review was interviewed; demand is not measured.
- The Scout guard's recall on injection wording written after its rules were frozen is 9 of 24 with rules alone; the optional classifier is off in the product (D-030).
- The video says "61 of 61 replies carry a verified Nightshift receipt": that holds for the committed recorded run (`output_examples/model-route.json`). The rendered video and its scene timeline are in `video/` (`video/README.md`, `video/COVERAGE.md`).

### Recording rules

Script the tamper test and the drills with Playwright so every frame comes from the real run; use a polished capture tool only for narrative framing. No scene may show a result that was not produced in the recorded run. Check each chapter timestamp against frames before publishing and keep a length guard under 4:00. The repository, the public evidence hub and the deck carry the technical depth the video does not. Do not edit or produce any video from this file; it is the plan.

### What to prepare before recording

1. Decide sample or live mode for the video. Live needs Docker and the Zetaris stack (`../infra/zetaris/README.md`) and a model route; the banner must match.
2. Run the three add-a-source examples once in the chosen mode and read every stage's summary; write the narration from what they say. Do not claim a caught unit or meaning change that the stage text does not show; if none appears, show the DiscoveryShift result with its class instead.
3. Open the Transpara Claim X-ray and confirm the 1.7.0 versus 1.7.2 link and its waterfall are on screen at the chosen zoom.
4. Rehearse the Applicability lab edits (version 3.0; age 18 to 21) and confirm the label and the reason text.
5. Decide whether Zetaris is stopped for real in the video (the `zetaris_off` drill otherwise injects the fault at the port) and say which.
6. Settle the Nightshift route (O-22): either re-record through Nightshift so receipts exist, or do not mention receipts.
7. Prepare the results slide from `../evals/RESULTS.md` with the unfavourable rows, not only the favourable ones.
8. Run `npm run judge` and the browser tests on the commit that is filmed, and note the commit.

## 2. Deck outline (24 to 28 slides, PDF; Blank brand kit)

1 Title and promise. 2 The problem with a true claim. 3 The user and the decision. 4 Why evidence is fragmented. 5 What exists today (honest competitor slide: Constat returns evidence fields and no verdict on a claim; HealthIT.com the same). 6 Product tour: Sources. 7 Evidence matrix. 8 Claim X-ray. 9 Applicability lab. 10 Timeline and change impact. 11 Architecture diagram (layers L0 to L8). 12 Track 1 mapping: discover, work across, reconcile. 13 Zetaris: roles, statement, policies, kill drill, the gates that failed (Z-NL blocked; the USL and data-quality rule run in the gate scripts, not in the product). 14 Meterless: four engines, roles, ablations on constructed data. 15 NVIDIA Nemotron: roles, model mix, receipts as they stand. 16 Applicability Compiler: dimensions, labels, invariants, the 17 implemented and 21 unimplemented registry rules. 17 Identity resolution and uncertainty. 18 Safety: what the product refuses to say. 19 The five suites: design and baselines. 20 Results table (measured rows only, with the class of each, including ScopeShift (B) exact-label accuracy and false-alarm rate). 21 Ablations, including the null identity-layer result. 22 Reproducibility: clean clone, sample mode, `npm run judge`. 23 Limits and what is not verified. 24 Roadmap and domain packs (marked as thesis). 25 Team and tools (Claude Code; Cursor not used). 26 Links. A required architecture diagram and stack slide are present (11, 13 to 15).

## 3. README

Written: `../README.md` covers the promise, the five labels, the no-key quick start (`npm run judge`), what to look at first, the layers, the sponsor table with code paths and evidence, measured results with their class, limits, live mode, the repository map and provenance. Still to check before submission: the Zetaris row says "eight of nine gates pass" (see `DECISIONS.md` G4: eight of the plan's nine, with Z-JUDGE through `npm run judge`); the Zetaris row and `metadata.json` describe a USL queried as a read-only identity, which the gate scripts do and the product does not (matrix row O-23); the sponsor table names a receipt log as Nemotron evidence while the committed run has no receipts; `metadata.json` lists Cursor as `planned` while the text says not used. The README additions the channels asked for are the agent-to-model table, the receipt log link, the pre-existing declaration, `npm run judge` and `.env.example`; the last three are present, the agent-to-model mapping is in the sponsor table and `src/models/roles.ts` and is not a separate table, and the receipt log link is absent because no receipts exist for the committed run.

## 4. Sponsor technology explanation

Not written. Outline: Zetaris: the statement, silos, the USL and its data-quality rule, the reflection (`docs/zetaris-usl-reflection.md`, also not written), policies, catalog, kill drill, the gates that failed and what was dropped, with query ids from `GATES.md`. Meterless: each engine's role, the extensions beyond the reference, conformance and extended test results, ablation rows (MA-5 not measured), the unconfirmed "primary provider" status. NVIDIA: models per role, the route actually used, receipts, what a fallback does. Cursor: not used. Each paragraph names code paths and a trace line.

## 5. HackOS form

Not filled. Description 150 to 2000 characters, video link (YouTube, Vimeo or Drive; under 4 minutes), GitHub link, optional deck link or file. Track selected in the team workspace. The description opens with a link to the public Notion brief if one is built, states the problem, the Track 1 mechanism, the measured results with their limits and class, and names the constructed parts. The exact text is drafted last, from results files, and the submission is created only by the owner.

## 6. Pre-submission checklist

State on 2026-10-27, from `05-requirements-matrix.md`:

| Item | State |
|---|---|
| Repository public on github.com with the current code | PENDING: public, but `origin/main` holds only the first commit; 31 local commits are not pushed |
| `npm run judge` passes on a clean clone without keys | PENDING: passes in the working tree (67 PASS, 0 FAIL, 5.5 s); clean clone not run |
| Description and README declare what is pre-existing | PENDING: README and `provenance.md` written; Description not |
| `metadata.json` exists and every path resolves | PASS against the community draft; organizer format unconfirmed |
| Clean-clone run on Windows and Ubuntu without a key; live run with Zetaris and Nightshift | PENDING |
| Secret scan including history | PASS as a one-off read; no scanner in the repository |
| Repo size check, wording lint | size PASS (about 6.5 MB tracked); lint of the deck, video and form text PENDING |
| Every video chapter checked against frames; every deck number traced to a results row | PENDING: no video or deck |
| Links opened logged out | PENDING |
| Written organizer exception filed with the submission notes | PENDING (the owner; G0) |
| Team and track confirmed in the workspace; submission created by the owner | PENDING |
