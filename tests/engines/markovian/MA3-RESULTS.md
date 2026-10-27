# MA-3: a scope restriction deep in a long document

Generated from `tests/engines/markovian/results/ma3-live.json (2026-10-27T06:33:47.157Z, arms markovian, markovian_no_carryover, single_truncated, single_full)`; `tests/engines/markovian/results/ma3-live-ids.json (2026-10-27T07:10:01.297Z, arms markovian_ids)`. Live model: `nvidia/nemotron-3.5-lightning-30b-a3b` through NVIDIA's hosted API.

Corpus: 4 constructed documents (labelled constructed, no patient data), 40 pages and about 107,232 bytes each, seeds 7001, 14920, 22839, 30758. Each holds one scope restriction planted deep in the text (between 60% and 90% of the way through) in an ordinary paragraph, four early facts (software version, operating point, setting, sample size) and decoy sentences that reuse the restriction's key without restricting anything.

## What the arms are

- **markovian**: the chunked reader with the verified-ledger carryover (flat prompt size, every prompt under 32 KB). The carryover lists each recorded fact with its value.
- **markovian_ids**: the same, with the carryover listing each recorded fact by id, field and page but not by value, so the model has nothing to restate.
- **markovian_no_carryover**: the same chunking with the carryover withheld, to separate what chunking gives from what the carryover gives.
- **single_truncated**: one prompt cut at 28,016 bytes, the product's prompt limit less its fixed framing.
- **single_full**: one prompt holding the whole document (about 107 KB). It exceeds the 32 KB rule the product keeps to, and exists only as the comparator; it goes through a harness client without that rule.

All arms use the same instructions, output schema and verification (a quote must exist on the cited page). A call that failed is counted as a failure and shown separately, never as a miss. Prompt tokens are provider-reported when every call reported them.

## Results

| Arm | Restriction found (all documents) | Planted facts found | Decoy confusions | Mean total prompt tokens | Mean peak tokens in one call | Calls | Token source |
|---|---|---|---|---|---|---|---|
| markovian | 1/4 = 25.0% (95% CI 4.6 to 69.9) | 7/16 = 43.8% (95% CI 23.1 to 66.8) | 6 | 30840 | 5737 | 6.0 | measured |
| markovian_ids | 3/4 = 75.0% (95% CI 30.1 to 95.4) | 15/16 = 93.8% (95% CI 71.7 to 98.9) | 7 | 30618 | 5703 | 6.0 | measured |
| markovian_no_carryover | 3/4 = 75.0% (95% CI 30.1 to 95.4) | 13/16 = 81.3% (95% CI 57.0 to 93.4) | 13 | 28308 | 5195 | 6.0 | measured |
| single_truncated | 0/4 = 0.0% (95% CI 0.0 to 49.0) | 4/16 = 25.0% (95% CI 10.2 to 49.5) | 0 | 6914 | 6914 | 1.0 | measured |
| single_full | 2/4 = 50.0% (95% CI 15.0 to 85.0) | 15/16 = 93.8% (95% CI 71.7 to 98.9) | 1 | 23449 | 23449 | 1.0 | measured |

## Per document

| Document | Arm | Status | Restriction found | Planted facts | Facts kept | Facts dropped | Calls | Peak prompt tokens | Seconds | Note |
|---|---|---|---|---|---|---|---|---|---|---|
| synthetic-7001 | markovian | OK | false | 4/4 | 56 | 46 | 6 | 6345 | 387 | partial: 0 of 6 chunks failed |
| synthetic-7001 | markovian_no_carryover | OK | false | 1/4 | 101 | 7 | 6 | 5271 | 258 | partial: 0 of 6 chunks failed |
| synthetic-7001 | single_truncated | OK | false | 2/4 | 15 | 0 | 1 | 6912 | 15 |  |
| synthetic-7001 | single_full | OK | true | 4/4 | 15 | 1 | 1 | 23187 | 28 |  |
| synthetic-14920 | markovian | OK | true | 1/4 | 17 | 29 | 6 | 5623 | 101 |  |
| synthetic-14920 | markovian_no_carryover | OK | true | 4/4 | 102 | 1 | 6 | 5273 | 432 | partial: 0 of 6 chunks failed |
| synthetic-14920 | single_truncated | OK | false | 0/4 | 4 | 0 | 1 | 7007 | 14 |  |
| synthetic-14920 | single_full | OK | false | 3/4 | 13 | 3 | 1 | 23008 | 20 |  |
| synthetic-22839 | markovian | OK | false | 1/4 | 21 | 51 | 6 | 5573 | 167 |  |
| synthetic-22839 | markovian_no_carryover | OK | true | 4/4 | 93 | 3 | 6 | 5239 | 396 | partial: 0 of 6 chunks failed |
| synthetic-22839 | single_truncated | OK | false | 0/4 | 4 | 0 | 1 | 6790 | 26 |  |
| synthetic-22839 | single_full | OK | false | 4/4 | 14 | 0 | 1 | 23433 | 32 |  |
| synthetic-30758 | markovian | OK | false | 1/4 | 25 | 68 | 6 | 5405 | 202 | partial: 0 of 6 chunks failed |
| synthetic-30758 | markovian_no_carryover | OK | true | 4/4 | 122 | 0 | 6 | 4996 | 534 | partial: 0 of 6 chunks failed |
| synthetic-30758 | single_truncated | OK | false | 2/4 | 14 | 0 | 1 | 6947 | 22 |  |
| synthetic-30758 | single_full | OK | true | 4/4 | 13 | 2 | 1 | 24167 | 16 |  |
| synthetic-7001 | markovian_ids | OK | false | 4/4 | 76 | 8 | 6 | 5983 | 403 | partial: 0 of 6 chunks failed, 3 replies cut off |
| synthetic-14920 | markovian_ids | OK | true | 4/4 | 68 | 9 | 6 | 5819 | 222 | partial: 0 of 6 chunks failed, 1 replies cut off |
| synthetic-22839 | markovian_ids | OK | true | 4/4 | 83 | 13 | 6 | 5604 | 433 | partial: 0 of 6 chunks failed, 3 replies cut off |
| synthetic-30758 | markovian_ids | OK | true | 3/4 | 80 | 28 | 6 | 5404 | 445 | partial: 0 of 6 chunks failed, 2 replies cut off |

## How to read this

- With four documents the intervals are very wide. A difference of one document between two arms is not evidence of anything.
- The corpus is synthetic and its restriction sentences are written to be findable. Real reports bury restrictions in tables, footnotes and scanned figures that this corpus does not contain.
- One model was used (a 30B-parameter Nemotron without extended reasoning). A stronger model, or the same model with a second pass aimed only at restrictions, may behave differently. Neither was run.
- The reader's verification drops a quote that is reworded. When the carryover shows the model earlier facts it tends to restate them in its own words, and those are dropped (see "Facts dropped"); that is the verification doing its job, and it costs recall and uses up the model's answer budget.
- A note saying 'partial' means some replies were cut off at the answer limit and only the complete facts before the cut were kept.

