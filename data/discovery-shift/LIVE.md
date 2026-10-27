# Live run: onboarding against the real Zetaris stack, real public sources and the real model

Run on 2026-10-27 with `npx tsx tests/discovery/live/run.ts` (first run: `sk_onboarded` dropped first, so every registration is a creation) and again with `--keep` (second run: the tables exist). Raw output: `live/results-first-run.json`, `live/results-second-run.json`, with the decision trace of each in `live/trace-*.jsonl`. Credentials are read by name from `.env` and `infra/zetaris/sakaime.env` and are not printed or written. The stack is the one described in `infra/zetaris/README.md` (Zetaris 2.4.3.1 hackathon build, engine probe `SELECT 1` answered in 80 ms and 61 ms). Statements run as the read-only agent identity, except the registration DDL, which runs as the administrator under the admin policy.

What is real: the fetch (the SSRF-safe fetcher, DNS checked, socket pinned to the vetted address), the two public APIs (openFDA 510(k) and ClinicalTrials.gov v2), the model (Nemotron through the NVIDIA route; `nemotron-3.5-lightning-30b-a3b` or `nemotron-3-ultra-550b-a55b` as routed), the object store, the Zetaris DDL and every query. What is constructed, and labelled so in the source descriptions: the two partner exports (`partner-clearances.csv`, the clearance records we hold with every column renamed; `partner-performance.csv`, reported sensitivities from PubMed abstracts on a 0 to 100 scale). A constructed layout cannot be hosted by a real registry, so these two are served by a local fixture under a card for a test host. The run script also stands in for a reviewer once (below).

## Outcomes

| Source | First run | Second run | Notes |
|---|---|---|---|
| openFDA 510(k), six clearances we hold (`api.fda.gov`, 29 fields) | held for review | held for review | 1 finding, below |
| ClinicalTrials.gov v2, EyeArt studies (nested JSON, 6 fields) | registered `sk_onboarded.s_study_97e63be11cef`, 6 rows, created | same table, `kept: true` | joined with 6 vendor claims in one federated query |
| Partner clearances, every column renamed (constructed) | registered `sk_onboarded.s_authorization_2eb54b9c42c8`, 12 rows, created | `kept: true` | joined with 6 hospital submissions |
| Partner performance, percent scale (constructed) | held (stages 5 and 6 held, 7 and 8 pending) | held | "the values are on a 0 to 100 scale (largest 97.7); the canonical field is a fraction" |
| Partner performance after acceptance by the run script | registered `sk_onboarded.s_performance_d696a7b41562`, 6 rows, `0.955` for the first sensitivity | `kept: true` | joined with 7 vendor claims |
| `https://169.254.169.254/latest/meta-data/` | declined at stage 1: IP-literal host | same | Scout also declined to issue a contract |
| `https://example.org/data.csv` | declined: host not on the allowlist | same | Scout would issue a contract; the pipeline refuses on its own |
| `http://api.fda.gov/device/510k.json?limit=1` | declined: only https | same | Scout also declined |

Re-running changes nothing: the second run found each table it had created, compared its row count and its column list with the snapshot, and left it (`kept: true`, `databaseCreated: false`). The snapshot hashes of the registered tables are equal between the two runs (`01d77e846b88...`, `5e56ea5bebc8...`, `075e1618e17e...`).

## The cross-source query

One statement, run as the read-only identity, over two sources onboarded in this run and two original silos (a Postgres datasource and file-store tables):

```
hospital.submissions (JDBC)  ->  sk_onboarded.s_authorization_2eb54b9c42c8 (onboarded)
                             ->  sk_vendor.vendor_claims (files)
                             ->  sk_onboarded.s_study_97e63be11cef (onboarded)
```

6 rows, `servedFrom: live`, query ids `6724c1d6-4f52-4058-a302-d2bd4d1d9763` (first run) and `332270f4-c867-4266-b30f-57ebe4a2d21f` (second). The first row: `SUB-1001, EyeArt, Eyenuk, Inc., 2020-08-03, CLM-EA-01, NCT03112005, enrollment 942, COMPLETED`. The statement is in `live/results-*.json` under `joins`.

## What the real FDA source raised

The model proposed the nested column `openfda.device_name` for `device_name`. The check that compares rows joining on the key with the held record held it: "0 of 6 rows that join on submission_number agree with the held fda_510k.device_name (for K253265 the source says "Radiological Computer-Assisted Triage And Notification Software" and the held record says "BriefCase-Triage")". The other four compared columns (applicant, product code, decision date, device class) agreed on 6 of 6. That nested field is the FDA classification name, not the trade name. The run script does not answer this hold. A person would pick another column or accept that the source names it differently; the pipeline did not register a column that looked right by name and joined perfectly on the key.

## What the live runs found, and what was changed because of it

These are in the errata of `RESULTS.md`; each has a test.

- The model filed an array of establishment registration numbers as a trial identifier. The whole source was declined, although the column was irrelevant. Fix: a model proposal that the values contradict and that nothing in the source supports is discarded and the rest is judged. The synonym `registration number`, which belonged to no trial field, was removed.
- The first ClinicalTrials.gov registration was held because the real engine renders a date column it inferred as a timestamp (`2024-07-27 00:00:00`), and the test double does not. Fix: the held value is compared as a date.
- Re-assigning a role to a database answers HTTP 400 "Database SK_ONBOARDED has already been assigned to AGENT_READONLY role." The repeat was treated as a failure. Fix: that wording is the idempotent case.
- A table that exists was verified by row count only; a second registration of the same request under a different mapping would have been read through the old column list. Fix: the column list must match as well.
- openFDA records carry `device_name` twice (top level and under `openfda`). Fix: a reviewer can keep one of two columns proposed for one field; without a choice the duplicate stays held.

## Not verified

The Nightshift route (the model ran through the NVIDIA route); an API-key identity (the stack uses password login for every identity); a source larger than the 5,000-row, 2 MiB bound; concurrent registrations from two processes (two simultaneous calls in one process are serialised and tested); the Zetaris Cloud product.

## To clean up

`DROP LIGHTNING DATABASE sk_onboarded` as the administrator removes the tables this run created. The next run drops it by itself unless started with `--keep`.
