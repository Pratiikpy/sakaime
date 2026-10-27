# Sealed held-out key

Written 2026-10-27, before any system was run on the held-out claims.

| File | sha256 |
|---|---|
| `evals/heldout/claims.jsonl` (case inputs, no labels) | `a7e06def6efa7e620db43801edde85b5476ea94ad5ced276ce19fbfb2a28c284` |
| `evals/heldout/key.json` (labels, anchored quotes, pass 1 and pass 2) | `fcd1327e1d065546cea15898250c3af0a57ddba04321b09d35694d2a10abaf2a` |

Sealed at 2026-10-27T08:09:16Z (`evals/heldout/seal.json`). `evals/lib/seal.ts` recomputes both hashes at the start of every held-out run and refuses to run when either differs; every held-out result row carries the key hash it was scored against. `tests/evals/seal.test.ts` shows that changing one byte of the key fails the check. A sealed key is never edited after system output has been seen; a needed change is a dated entry in `ERRATA.md`, and results before and after are both reported.

## What the set is

20 CONSTRUCTED claims (each carries the notice) over five FDA 510(k) summaries that no Gate 0 claim uses: K253801 (Anumana cardiac amyloidosis), K252360 (Anumana pulmonary hypertension), K253825 (Saige-Dx), K250680 (Bayesian Health sepsis), K253163 (EFAI appendicitis). Four claims per device: one positive control and three mismatches. Labels: 5 SUPPORTED_FOR_SCOPE, 2 SUPPORTED_ONLY_FOR_NARROWER_SCOPE, 8 CONTRADICTED_BY_SPECIFIED_EVIDENCE, 4 INSUFFICIENT_EVIDENCE, 1 REQUIRES_DOMAIN_REVIEW. 11 of 20 keys are contestable and carry acceptable labels that withhold support. The documents are the public FDA PDFs (URLs and sha256 in `key.json`); the pdfjs page text used for quoting is committed under `evals/heldout/text/`, the PDFs themselves are not (`evals/heldout/raw/`, ignored).

## How it was labelled

- Pass 1: the builder read each document and wrote the label, the mismatching dimension with both values, and verbatim anchored quotes. `build.ts` checks that every quote exists in its document, that every decimal or percentage in a claim text appears in a quote (the claimed threshold of HO-SE-03 is the one exception, it is the claim), and that no acceptable label is a SUPPORTED label.
- Pass 2: the builder wrote a per-dimension relation table (CONTAINED, PARTIAL, DISJOINT, UNKNOWN) and fed it to a mechanical oracle (`oracle.ts`) that implements the label table of docs/02 section 10 and shares no code with the compiler. Result: the oracle agrees with the hand label on 20 of 20 claims, no disagreement to record. Read that for what it is: the same person wrote both passes and the relations were written knowing the hand labels, so agreement checks the key's internal consistency, not its truth. Where a claim is labelled CONTRADICTED because a sentence says in words that the use is not intended (HO-CA-03, HO-PH-03, HO-SD-03, HO-EF-03), the oracle takes that as an input (`textNegatesUse`); the compiler's rule table has no such rule, and a difference between the key and the compiler there is a measured gap, not a key defect.
- Class: **builder-labelled, single builder, not independent.** No clinician or second human has read the key. No claim of clinical or independent validation follows from any number computed against it.

## What was and was not done before sealing

Done: the five documents were read in full for scope, the claims written from them, the quotes verified, the oracle run. Nothing from Sakaime's compiler, extraction output or any model arm on these documents was looked at when the labels were written.

Not done, and stated:

- **Exposure of the extraction layer.** The five documents are the same ones the extraction lead used to develop and then fix the FDA summary parser (`tests/extraction/RESULTS.md`, held-out section, which itself says "not a blind test"). The key is independent of that work; the extractor is not blind to these documents. Results on this set therefore describe the pipeline on documents it was partly built on, and say less about unseen documents than the word held-out suggests. The extractor tuning and the evaluation harness are separate, but this exposure is on the record.
- **Few devices.** 5 devices means 5 clusters. Intervals are wide and the effective sample size is 5, not 20.
- **The seal is a file hash, not a commit.** The agent that wrote this file may not run git commands that change state, so the commit that timestamps the seal is made by the lead. Until it is made, the seal's age rests on `seal.json` (`sealedAt`) and on the key hash that every result row carries. Commit `evals/heldout/` and this file before committing any held-out result.
- **No blind second annotator.** A model-assisted second annotator (permitted by docs/06 as a consistency check) was not run.
