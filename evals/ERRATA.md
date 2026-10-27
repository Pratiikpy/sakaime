# Evaluation errata

Dated entries, appended. Nothing here is edited after the fact; a correction is a new entry that points at the old one. Protocol: `docs/06-evaluation-protocol.md` section 2.

## E-001 (2026-10-27): the Gate 0 answer key was edited after the builder saw a dry run of the compiler

**What happened.** `evals/gate0/ANSWER-KEY.md` (section "Changes made after seeing a system output") discloses that, after the key and evidence items were written, a throwaway dry run fed the key's claims and hand-written evidence items to the in-progress `src/compiler`, and that the key was then changed in two ways:

1. **Evidence typing.** Analysis-population facts (age floor 22, pacing exclusion, 40 to 80 study ages) had been placed inside `authorization` items. After the dry run the items were split into an `authorization` item (what the indication says) and a `study` item (what the pivotal or validation study covered) for EyeArt (K200667 and K223357), GI Genius, Anumana and IDx-DR. In `evals/gate0/evidence-sets.json` that is the pairs `ev.ea.fda`/`ev.ea.fdastudy`, `ev.ea.k2`/`ev.ea.k2study`, `ev.gi.fda`/`ev.gi.study`, `ev.an.fda`/`ev.an.study`, `ev.id.fda`/`ev.id.study`. No expected label was changed by the split.
2. **CP-01.** The acceptable set was widened to include `CONTRADICTED_BY_SPECIFIED_EVIDENCE` after the dry run returned that label. The exact label stayed `SUPPORTED_ONLY_FOR_NARROWER_SCOPE`.

**Why it is contamination.** Under docs/06 section 2 a held-out label that the builders changed after looking at system output is no longer held out. Both changes moved the key toward behaviour the compiler had just shown.

**What git history can and cannot show.** The request was to list the change by diffing the key against history. That is not possible: `evals/gate0` appears in exactly one reachable commit (`535cad7`, 2026-10-27 11:10:26 +0530), which already holds the post-edit state. A dangling earlier commit (`dbf23d0`, 11:10:08, found with `git fsck --lost-found`) differs from it only by removed raw-terms and competitor-response files, not in `claims.jsonl`, `evidence-sets.json`, `ANSWER-KEY.md` or `tools/key-data.mjs`. So the edits happened in the working tree before the first commit and no earlier version of the key is recoverable. The description above is therefore the builder's own disclosure in `ANSWER-KEY.md`, cross-checked against the committed evidence items; the first encoding of the evidence is **NOT VERIFIED** beyond that disclosure.

**Treatment.** All 26 Gate 0 claims are **development**, never held-out, in every table of `RESULTS.md`. They keep their role in the Gate 0 80 percent rule because that rule's protocol (`evals/gate0/PROTOCOL.md`) was written with the claims as they are, and the rule is applied to the key as committed. Two sensitivity readings are reported beside it: the CP-01 score with the original acceptable set (without `CONTRADICTED_BY_SPECIFIED_EVIDENCE`), and the arms that use the hand-written evidence items (M1) kept apart from the arm that uses evidence extracted from the documents (M2), because only M1 depends on the item split.

**Replacement.** A new held-out set of 20 claims over five devices that no development claim uses, labelled before any system ran, sealed by hash: `evals/SEALED.md`.

## E-002 (2026-10-27): the extraction layer is not blind to the held-out documents

The five FDA summaries behind the held-out set are the five documents the extraction lead fetched to measure the FDA summary parser and then repaired it on (`tests/extraction/RESULTS.md`, "Documents the parser was not developed on", which states that the section is not a blind test). The held-out key does not depend on that work and was written from the documents alone, but the pipeline under test has seen these documents. Held-out results describe the pipeline on documents it was partly developed against. Recorded in `SEALED.md`; repeated in `RESULTS.md`.

## E-003 (2026-10-27): development of the evaluation adapter

The adapter that carries claims and extracted evidence into the compiler (`evals/lib/vocabulary.ts`, `evals/lib/pipeline.ts`) was iterated against the 26 development claims only. Its revisions are logged in `evals/results/adapter-log.json` with the development score at each revision. It was frozen, and its hash recorded in every result row, before the first run on the held-out claims. Any later change to the adapter is a new entry here and a new run.

## E-004 (2026-10-27): what the model arms did and did not do

- **B4 ran once, not three times.** The shared free-tier NVIDIA key allowed about two calls a minute for most of the session (HTTP 429 otherwise); a tool-using run is about five calls a claim. B3 ran three times on both partitions; B4 ran once on both. A second B4 run on the development set was started and abandoned part way; its recorded replies remain in `results/model-runs/b4.jsonl` as run 2 and 3 lines and are not used by any table. The development rows of B4 runs 2 and 3 in the first, discarded output were all HTTP 429 and are not reported.
- **A stray duplicate process** ran the held-out arm concurrently for several hours (a background chain restarted by an earlier kill). It wrote the same recorded replies to the same cache under the same keys (on load the earliest line for a key is used; the two replies to one prompt differed in a few cases even at temperature 0, which is the run-to-run variation the three B3 runs are there to show), so the held-out B4 run 2 lines in the cache come from it. It also changed the results once: one B3 call that had failed with HTTP 429 in the first held-out output was answered by this process, and a few prompts have two recorded replies. All tables were regenerated from the cache with the earliest-line rule and match a second replay exactly.
- **The prompts were not tuned.** The B3 and B4 system prompt was written once, checked on a single development claim for valid JSON, and hashed (`promptHash` in the results). Nothing in it was changed after the first full development run or after the held-out run.
- **Retries.** A call that returned HTTP 429, a 5xx or a timeout was retried with backoff; a reply, once received, was never re-asked. The harness client (not the product's 32 KB-capped client) was used for both arms because the records exceed 32 KB; the records are public FDA documents.
