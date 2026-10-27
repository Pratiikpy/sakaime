# Reflection on the Zetaris Unified Semantic Layer

Written 2026-10-27 from use of the installed Zetaris 2.4.3.1 hackathon build (Docker, local mode). Every figure below was read from a run on that stack; the commands are at the end. The three silos are the constructed hospital database (Postgres), the registry snapshot files (real FDA and ClinicalTrials.gov records) and the constructed vendor packet export (CSV). No patient data is involved.

## What the layer unified

One USL, `lightning.metastore.sakaime.review_semantics`, ten tables, 89 columns, each with a written description:

| Table | Reads | What it answers |
|---|---|---|
| `device_authorization`, `device_version_record` | FDA 510(k) and UDI snapshots | what FDA decided, and which software versions it lists |
| `registered_study` | ClinicalTrials.gov snapshot | study size (`study_enrolled`) and the youngest enrolled age (`study_enrolled_age_min_years`) |
| `vendor_claim` | vendor packet export | what the vendor claims (`claimed_age_min_years`, setting, purpose, version) |
| `review_case`, `hospital_requirement`, `confirmed_evidence_link` | hospital Postgres | the hospital's own intended use, policy and reviewer-confirmed links |
| `case_evidence_matrix` | all three silos | one row per case and claim, with the version and age comparisons already made |
| `collection_manifest` | manifest file plus live row counts | what each landed collection should hold against what it holds now |
| `term_definition` | the compiler's own vocabulary | 75 rows: care settings, intended purposes and metrics, with where each sits and what evidence on it covers |

The names are the reviewer's words (`authorized_on`, `study_enrolled`, `listed_version`) and not the silos' (`decision_date`, `enrollment_count`, `version_or_model_number`). The commercial columns of the vendor export are not in the layer.

`term_definition` is generated from the compiler's taxonomies and metric table (`src/federation/usl-terms.ts`), not typed a second time, so a second consumer reads the words the compiler used: "emergency department" sits inside "hospital (any unit)" inside "any care setting"; "recall" and "true positive rate" are read as sensitivity, which is a proportion from 0 to 1. The word "adult" is published with no number on purpose: the compiler compares the age bounds a source states and never turns the word into an age. That is a design choice, and the table says so in the row.

## What it saved, measured

The same question three ways: for every hospital case and every vendor claim on its packet, does FDA list the claimed version, and how do the claimed and intended lowest ages compare with the youngest enrolled age of the confirmed study. 28 rows. Nine timed rounds after one untimed warm-up, arms interleaved, read as the read-only agent identity, on a laptop that other processes were also using (`usl.ts measure 9`).

| Arm | Statements sent | Median | Range | Consumer code |
|---|---|---|---|---|
| Seven reads, one per silo table, joined in code | 7 | 294 ms | 232 to 404 | 48 lines of TypeScript, plus seven statements |
| One hand-written federated statement | 1 | 861 ms | 660 to 1,137 | about 40 lines of formatted SQL (the Evidence Matrix join) |
| One read of the layer | 1 | 1,189 ms | 1,060 to 1,472 | 4 lines |

All three arms returned the same 28 rows, equal cell by cell (also asserted by `tests/federation/usl.live.test.ts`).

What this shows: the layer turns a consumer's seven statements and 48 lines of join logic into one statement and four lines, and the join, the casts and the comparison rules are written once, in the layer, instead of in every consumer. What it does not show, and the numbers say plainly: **the layer did not save run time.** It is the slowest arm. The seven plain reads run in parallel and each is a cheap scan; the layer table runs the full federated join on every read, a little slower than the same join written by hand. Engineering time was not measured; no hours-saved figure is claimed. The one-off cost is also real: building the layer from nothing took 127 statements and 11.7 seconds, and a repeat run, which changes nothing, sent 8.

A further cost is the risk of the same logic living in several places. The by-hand code, the Evidence Matrix statement and the layer's activation query agree today because a test compares them; if one is edited the other two drift until that test runs.

## How it helps a hospital reviewer

- A reviewer or a BI tool asks "which claims reach younger patients than the study enrolled" with a four-line query and gets the answer with the comparison already made, from a table whose columns say what they hold.
- The definitions travel with the data. `GET /api/usl?caseId=...` returns the case's setting and purpose with the broader terms above them and the metric it asks about, read through the layer.
- The layer reads through the identity that asks. The reviewer who is not assigned to the EyeArt cases reads 5 of 7 cases and 8 of 28 matrix rows through the same tables; the agent identity and the assigned reviewer read 7 and 28. The layer added no policy of its own.
- It is queried as the read-only agent identity, which can run `SELECT`, `RUN DQ` and `LOAD USL` and is refused `ACTIVATE USL TABLE`, `REGISTER DQ` and `COMPILE USL`.

## Data-quality rules: what each caught

Seven rules, registered with `REGISTER DQ` and run with `RUN DQ <rule> TABLE <table>`, each answered with a query id.

| Rule | Table | On the recorded stack | Meaning |
|---|---|---|---|
| `collection_complete` | `collection_manifest` | 0 of 7 fail | a landed collection is whole: expected size known, all of it present, connector did not stop early |
| `study_has_eligibility` | `registered_study` | **143 of 157 fail** | the study record carries an eligibility block |
| `version_is_listed` | `device_version_record` | 0 of 20 | the record states a version |
| `claimed_age_plausible` | `vendor_claim` | 0 of 18 | the claimed lowest age is between 0 and 120 |
| `claim_cites_authorization` | `vendor_claim` | 0 of 18 | the claim cites an FDA number |
| `case_vocabulary_defined` | `review_case` | 0 of 7 | the case's setting and purpose are words the term table defines |
| `metric_proportion_bounds` | `term_definition` | 0 of 75 | a metric defined as a proportion is bounded by 0 and 1 |

- `study_has_eligibility` fails for 143 records, and that is a true result: they are search summaries that carry no eligibility block, so their youngest age is unknown. Unknown is never read as covered.
- **The completeness gate, with a deliberate truncation** (`usl.ts drill`): the landed file of the `pubmed_articles` collection was cut from 110 records to 39. `RUN DQ collection_complete` then reported 1 of 7 failing (query `c147701c-a5ff-49d8-b4d7-59cc300901ab`), the code check read the same manifest rows as `TRUNCATED: 39 of 110 records arrived`, the two agreed, and the collection was listed as blocked, so it feeds nothing downstream. The file was restored and the rule passed again (`928aba0e-0639-4a39-be2c-23d787c22548`). The collection chosen is one the Evidence Matrix does not read, so the drill could not disturb another client.
- The engine and the code form of the rule are made to agree, and a disagreement is thrown (DRIFTED), not guessed. Writing the test for that found a real mismatch in my own code: the existing `checkCollectionCompleteness` accepts a collection whose source reported no total if the connector reached the end, and the rule refuses it, because a manifest row with no expected size is invalid on the engine. I verified on the engine that a NULL expected total, a NULL `truncated` flag and a short count are each invalid, and made the code form match.
- The rules caught three mistakes of mine while I built them. `metric_proportion_bounds` first failed 57 of 75 rows because I wrote `unit IS NOT NULL AND ...` and the settings have no unit. The RUN DQ output headers are `total_record`, `valid_record` and `invalid_record` (singular); the parser in `dq.ts` had been written from the documentation's plural and would have thrown DRIFTED on every call. And the completeness mismatch above.
- A failed rule and an unreachable engine are kept apart. A failed rule is a result with counts and the snapshot is still served; an engine that cannot be asked is `503 UNAVAILABLE`. With the Zetaris port pointed at a closed port the completeness rule raised UNAVAILABLE and no verdict. A stopped API container was exercised earlier by the kill drill (`GATES.md`) and gives the same class.

## What did not work

From the gates, each still true:

1. `Hide` on a file-store table leaks the hidden value under the neighbouring column name. The layer excludes the confidential vendor columns instead of relying on a policy.
2. `REFRESH DATASOURCE` deletes every policy on the source. The layer reads through the caller's policies, so a wiped policy would widen what the layer shows; a canary query as a restricted identity is the only check, and it is the same check that found the row filter intact (5 of 7 above).
3. A non-admin identity can read a USL only after a REST call that has no SQL form. `ensureUsl` makes that call on every run, because the engine gives no way to read the assignment back and a rebuilt USL has a new id and loses it.
4. Unknown option names are accepted silently (`preview_len`).
5. Policies attach to users in practice, not to roles.
6. The audit log keeps request ids, not SQL text. The query ids returned by `RUN DQ` are therefore our own record; whether they can be found in `/audit/logs` for the layer was not tested.
7. There is no natural-language-to-SQL in this build (Z-NL is BLOCKED). The layer's descriptions are written for it, but nothing consumed them in this work, so that benefit is NOT VERIFIED.

New, found while building the layer:

8. A column named `source` makes `COMPILE USL` fail with "Invalid DDL statement. Please provide a valid CREATE TABLE statement". The message does not name the column; I found it by compiling the columns one at a time. It is `origin` now.
9. A DDL table that references another by foreign key must come after it in the same request, and a one-table dry run of a table with a foreign key fails for the same reason (`ReferenceTable...`), which reads like a fault in the table.
10. The refusal for a non-administrator is `User is not permitted to run this command`. `src/federation/classify.ts` has no pattern for that wording, so the port reports it as INVALID, not FORBIDDEN. The refusal is still a refusal and is not retried; the class is wrong. This is outside the files I own and is reported to the lead.
11. Descriptions are free text to the end of the statement; a colon or an apostrophe in one is not safe, so `assertDescription` limits them to letters, digits, space and `_ . , -`.
12. `RUN DQ` is slow beside a plain read: 0.8 to 3.9 seconds per rule on data of a few hundred rows, and the row-count statement over all ten tables took 5 seconds. A full read of the layer for the web app is 13 statements and about 12 seconds live, which is why the service keeps a live snapshot for 30 seconds and the recorded one is replayed.

## How the platform could improve

- Return a column name in `COMPILE USL` and `ACTIVATE USL TABLE` errors, and say which keywords are reserved.
- Give the role assignment of a USL an SQL form and a read-back, so that setup is one transaction and can be verified.
- Make `RUN DQ` return the failing keys with the count, or accept several rules in one statement; today one rule is one round trip and the invalid rows need a second statement.
- Keep an optional activation snapshot, so that a USL table that is expensive to compute is not recomputed on every read, with its age shown.
- Put the SQL text and the rows returned in the audit log, as the vendor page promises.
- Classify "not permitted to run this command" as a permission error in the response body, not only by message text.

## Not covered

Linux and macOS hosts, concurrent users, Zetaris Cloud, the vendor 8 GB profile, the audit log for layer queries, natural-language access, and any reading of the layer by a model (no prompt in this work includes a layer row). The measurement is one machine and one question; the ratios are not a benchmark.

## Commands

```
npx tsx infra/zetaris/scripts/usl.ts ensure      build or repair the layer (also run at the end of seed.sh)
npx tsx infra/zetaris/scripts/usl.ts record      record the reads into data/federation-cassettes/usl-*.json
npx tsx infra/zetaris/scripts/usl.ts measure 9   the three arms
npx tsx infra/zetaris/scripts/usl.ts drill       truncate, catch, restore
LIVE=1 npx vitest run tests/federation/usl.live.test.ts
```

Code: `src/federation/usl.ts` (specification, `ensureUsl`, `queryUsl`, rules, completeness gate), `usl-terms.ts`, `usl-cassette.ts`, `usl-measure.ts`, `src/service/usl.ts` and the route `GET /api/usl`.
