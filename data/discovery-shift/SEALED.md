# DiscoveryShift: sealed before the first run

The ground truth for the unknown-schema suite was written before any case was given to the onboarding pipeline, to the model or to the baseline. The hashes below fix it. `tests/discovery/shift/run.ts` refuses to score if `expected.json` or `cases.json` no longer matches them. A change to either file after the first run is an erratum in `RESULTS.md`, never an edit in place.

| File | sha256 |
|---|---|
| `expected.json` (the expected outcome of every case) | `3d55ebf819ad9207296893bcf0de4ea8b29e646c77201545233064cb02b8b9f5` |
| `cases.json` (the manifest: id, class, mutation, description, expected join rate, hash of each case file) | `53d2a15f488042f6d1f25729ddfab45b991eb9049954f26cf6e496e441902335` |
| `build.mjs` (the generator; deterministic, seed 20261027) | `d2515402dbb1c595e570fba12fe5884769948f47e3c8344519eb09d6ca9c5afe` |

Sealed at 2026-10-27T08:35:42Z (UTC), before the first run. 102 cases from four base sources built from records we hold: 12 FDA clearances (openFDA), 14 ClinicalTrials.gov studies, 11 reported-performance records taken from PubMed abstracts (each value checked against the abstract text by the generator), and 30 PubMed bibliography records.

## Policy the expected outcomes follow

- `mapped`: every field mapped, nothing held, registered. The mapping must equal the one listed in `expected.json`.
- `held`: a person must decide: a 0 to 100 scale, a numeric missing-value code, an ambiguous day/month order, a meaning no cue settles, a conflicting duplicate key.
- `declined`: the evidence contradicts the mapping (impossible value, wrong identifier family, no identifier, no overlap where overlap is expected), or the source cannot be read as a whole (cut off, empty).
- Where the right answer is a judgement between held and declined, both are listed and either counts. Where a column is optional (a bare `n`, an opaque `metric_a`), a registration that leaves the column unmapped is correct and one that maps it is a false accept (`forbid`).
- A semantic mutation is caught when the outcome is not a registration that contains a forbidden mapping.
- Cases marked `knownLimit` are undetectable from the response by construction; they are run and reported, and kept out of the headline rates.

## What this suite can and cannot show

- The labels follow from the construction of each mutation and the policy above. They are engineering-consistency labels, not clinical ones: they show the pipeline does what the policy says on layouts it was not tuned on, not that the policy is the right one.
- Author, labeller and pipeline builder are the same person. The class of each mutation was known when the validators were written; the cases (the particular aliases, values and combinations) were generated afterwards and not seen by the pipeline.
- Mutations of one source are not independent. There are four base sources, so the effective number of independent clusters is four, whatever the case count; intervals are reported per case and the cluster count is stated beside them.
- A baseline (a hardcoded extraction with the base layout's fixed field names) is scored on the same cases.
