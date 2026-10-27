# Zetaris gates: results

Run date: 2026-10-27. Gates are defined in `docs/03-zetaris-plan.md` section 5. Each gate is a script in `infra/zetaris/gates/`, run by `infra/zetaris/scripts/verify.sh`. The full run recorded here made 115 SQL statements (95 answered, 13 refused by permission, 7 returned an error on purpose or by design) and took about 35 seconds; the kill drill ran separately. The raw evidence (every statement with request id, query id, identity, outcome and timing) is written to `infra/zetaris/.runtime/results/` and is not committed; this file keeps trimmed excerpts.

## Environment

| Item | Value |
|---|---|
| Platform | Zetaris 2.4.3.1 hackathon build (`SHOW SERVER VERSION`: build hash `cb88df0b`; API build `a2848d8a`), Spark 3.5.3 in local mode |
| Host | Windows 11, Docker Desktop 29.1.3 (compose 2.40.3), Docker VM capped at 3.9 GB by the user's `.wslconfig`, Git Bash, Node 24 |
| Heaps | driver 1536m, API 768m (the vendor laptop profile is 2g and 1g and asks for 8 GB for Docker) |
| Silo images | `postgres:16-alpine`, `adobe/s3mock:latest` (sha256:ab01a694...), `python:3.12-alpine` |
| Cold start | empty volumes to a working `SELECT 1`: 52 s; seed from scratch: 24 s |

Not covered by any run: Linux and macOS hosts, the vendor 8 GB profile, concurrent users, Zetaris Cloud, the MCP and natural-language routes of the cloud product.

## Summary

| Gate | Verdict | Checks | What the evidence shows |
|---|---|---|---|
| Z-HEAD (not in the plan; the headline join) | PASS | 12 | One statement over Postgres, registry files and vendor files returns 20 rows in 0.8 s, identical cell by cell to DuckDB over the same CSV files; a changed cell and a missing row are both detected by the comparison |
| Z-REST | PASS | 8 | A REST table over nested openFDA and ClinicalTrials.gov JSON returns the same counts and ids as a direct call; 0.5 s per query on a 3 KB endpoint; the endpoint is requested again by every query |
| Z-POL | PASS, with two defects found | 33 | Four identities see different columns for one statement; no confidential value reached the agent identity in 23 responses; the non-admin "does not have access to USL" error is reproduced and fixed. Defects: `Hide` leaks on file-store tables, and a datasource refresh deletes policies |
| Z-CAT | PASS | 14 | Tags set and read back; schema drift is visible through `DESCRIBE` and through `SHOW DATASOURCE CHANGE HISTORY` (undocumented, administrator only, JDBC sources only) |
| Z-AUD | PASS, with limits | 8 | The administrator audit log lists 9 of 9 request ids we sent, with identity and success flag; it records no SQL text and no row counts |
| Z-TT | PASS | 7 | `VERSION AS OF` and `TIMESTAMP AS OF` return the earlier registry state from an Iceberg table; applies to Iceberg tables only |
| Z-USL | PASS | 23 | Six-table USL compiled in one request, activated with explicit casts, queried as the read-only identity; data-quality rules checked against DuckDB and against a planted violation |
| Z-PDF | PASS | 17 | `FORMAT PDF` returns usable text for three real FDA summaries once `preview_len` is set; the default 1,000-character cut is detected |
| Z-NL | BLOCKED | 1 | No natural-language-to-SQL service exists in the local build; three ways of finding one are written down below |
| Kill drill | PASS | 7 | API stopped: failure reported in 2 to 7 ms as UNAVAILABLE. Engine out of memory: the JVM exits, the restart policy brings it back in 36 to 111 s over three runs |

## Defects and findings that change the design

1. **`Hide` on a file-store (CSV) table leaks the hidden value.** With a `Hide` column policy, `SELECT *` drops the column name from the header but not the value, so every later value moves one column left: the hidden price appeared as `confidential_reference_site` and the last column (`provenance`) was lost. Named-column selects fail with `UNRESOLVED_COLUMN`, so only star expansion leaks. `Deny` (value becomes null) and `Masked` keep the columns aligned and are what the stack uses. The same `Hide` on the JDBC table `hospital.decisions` behaved correctly. Reproduced inside gate Z-POL, then the policy is restored.
2. **A datasource refresh deletes every policy on that source.** `REFRESH DATASOURCE TABLES FROM hospital` and `UPDATE DATASOURCE SCHEMA hospital` both set the access-control record of every table to null, even when nothing changed. The SELECT grant stays, so a restricted reviewer silently sees all rows (7 of 7 cases instead of 5 of 7). Policies on file-store tables were not affected in the run. Sakaime must re-apply policies after any refresh and check them before trusting a source: read the policy and run a canary query as a restricted identity. Reproduced on a throwaway datasource in Z-POL so the real policies stay in place.
3. **The PDF preview length option is `preview_len`.** The open-source reader names it `pdf_preview_len`; this build stores that option without error and ignores it, as it does eight other spellings, so the preview silently stays at 1,000 characters. The correct key was found by reading the string constants of the class in the running driver (`UnstructuredData`: `preview_len`, `preview_max_bytes`). With `preview_len "2000000"` the three summaries return 47,199, 35,080 and 29,732 characters.
4. **A non-admin user needs two steps for a USL.** `GRANT SELECT ON USL NAMESPACE ... TO ROLE` is not enough; the error stays `User ... does not have access to USL`. The USL instance must also be assigned to the role through REST (`POST /access-control/assign/role/usl` with the USL id). `ASSIGN USL ...` does not exist as SQL. Reproduced by revoking and re-assigning in Z-POL.
5. **Policies attach to users, not roles, in practice.** A policy attached to a role (with or without `roleSelected` on the user) had no effect in three attempts; a policy attached to the user through `userLevelPolicy` works for columns and for rows.
6. **Unknown option names are accepted silently** on filestore tables (finding 3), and table descriptions accept only letters, digits, `_ . - ,`.
7. **Metadata change history is readable through SQL, but only by an administrator, and only for JDBC sources.** `SHOW DATASOURCE CHANGE HISTORY <datasource>` returns operation, entity, time and description (for example `ADD | COLUMN | ... column : drift_probe:StringType was added`). It is not in the command reference or the OpenAPI document; it was found in the compiled web UI. An earlier version of the gate recorded "no SQL or REST route returns the history", which was wrong; the lesson is to search the product's own client before writing a negative finding. Drift in the file snapshots is detected by hashing, not by the catalog.
8. **The audit log is a witness to the call, not to the query.** `GET /audit/logs` (administrator only) lists `requestId` (the `X-Request-ID` header we send), user, api name, times and a success flag, and marks refused and failed calls as unsuccessful. It has no SQL text, no tables touched and no row count, although the vendor page promises them. Per its description, activity logs expire after 30 days and `DELETE /audit/logs/clear` removes the expired ones; whether it can remove newer entries was not tested.
9. **A USL inherits the source policies.** The row filter on `hospital.cases` also applied when the same rows were read through the USL table `case_context` (5 of 7 rows for the unassigned reviewer).
10. **Out-of-memory ends the JVM; the stopped-context case was not reproduced.** The other teams' report (healthy container, every query failing with "stopped SparkContext") did not occur: the driver exited and the restart policy restarted it. The container health check is only a TCP connect to port 10000, so it cannot detect an engine that is up but unusable; readiness must be a real `SELECT 1`.

## Z-HEAD: the headline join

Command: `node infra/zetaris/scripts/verify.mjs z-head`. Statement: `infra/zetaris/sql/headline.zetaris.sql` (54 lines; each silo aggregated in its own subquery before any join). Oracle: `headline.duckdb.sql` over the same CSV files, loaded by `scripts/oracle.mjs`.

```
headline.zetaris.sql as admin (one REST request) => rows 20, total 20, 845 ms (engine 823 ms), truncated false
Zetaris rows equal DuckDB rows, cell by cell: 20 rows identical
negative control: a changed cell is detected: CASE-2026-009 / CLM-ID-01 column claim_age_vs_study: expected "WITHIN_STUDY" got "WITHIN_STUDY_TAMPERED"
negative control: a missing row is detected: missing from actual: CASE-2026-009 / CLM-ID-01
agent identity (read-only) runs the same statement: 20 rows in 856 ms, equal to the admin result
unassigned reviewer: 8 rows, the two EyeArt cases absent (row filter applied inside the join)
```

Rows for the EyeArt case:

```
CLM-EA-01 v2.1.0 age>=18 | version LISTED     | age WITHIN_STUDY
CLM-EA-02 v2.1.0 age>=0  | version LISTED     | age CLAIM_BELOW_STUDY_MINIMUM
CLM-EA-04 v3.0   age>=18 | version NOT_LISTED | age WITHIN_STUDY
```

Limit: the oracle and the Zetaris statement implement the same logic written by the same author, so equality shows that the engine executes it correctly across the three silos, not that the logic is right.

## Z-REST

Command: `node infra/zetaris/scripts/verify.mjs z-rest`. Tables in `sk_rest`: two over the local REST silo (recorded responses) and two over the live endpoints.

```
static: 6 rows in 268 ms; direct call: 6 studies, totalCount 6; NCT ids equal; NCT03112005 enrollment 942 on both sides
static: GET count at the endpoint 13 -> 15 after two queries (the request is re-issued by each query)
live ClinicalTrials.gov: zetaris 6/6 in 588 ms, direct 6/6 in 407 ms; NCT ids equal
live openFDA 510(k) K200667: zetaris n=1 k=K200667 class=2 in 1139 ms, direct 1407 ms
live ClinicalTrials.gov, 5 repeated queries: min 469 ms, median 482 ms, max 492 ms
```

Nested arrays arrive as one row with an array column; `LATERAL VIEW explode(studies)` unnests them. Not tested: a large response (other teams report 40 to 50 s for 1.5 MB) and wide JSON against the driver heap; the snapshot route stays the default for large public JSON.

## Z-POL

Command: `node infra/zetaris/scripts/verify.mjs z-pol`. Identities (all created by `seed.mjs`): `admin`; `agent-reader` (general level, role `agent_readonly`, SELECT only); `reviewer-unassigned` (role `case_reviewer_unassigned`, same restrictions as the agent plus a row filter); `reviewer-assigned` (role `case_reviewer_assigned`, no policy).

One statement, `SELECT * FROM sk_vendor.vendor_claims ORDER BY claim_id`, row `CLM-EA-01`:

```
admin     15 columns  price 41500  site "Reference site 17"  provenance CONSTRUCTED
assigned  15 columns  price 41500  site "Reference site 17"  provenance CONSTRUCTED
reader    15 columns  price null   site "**"                  provenance CONSTRUCTED
reviewer  15 columns  price null   site "**"                  provenance CONSTRUCTED
```

Other results:

```
denied column in SELECT list / alias star / subquery: no confidential value in any response
WHERE predicate on the masked column (= 'Reference site 17'): 0 rows for the agent; on the denied price (= 41500): 0 rows (no inference through filters)
row filter: admin 7 cases, reviewer-unassigned 5; same 5 through the USL table case_context
agent identity refused (FORBIDDEN): INSERT, CREATE DATASOURCE, CREATE LIGHTNING DATABASE, GRANT, COMPILE USL, DROP TABLE; decisions still 3 rows
USL: query OK -> revoke instance assignment -> "User 'AGENT-READER@SAKAIME.EXAMPLE' does not have access to USL" -> assign -> OK
leak sweep: none of 12 confidential values (6 prices, 6 reference sites) in the 23 responses the agent identity received, nor in the 11 the unassigned reviewer received
```

Not verified: that a masked value cannot reach a model prompt. The Sakaime agent and its prompt log do not exist yet; what is verified is that the data layer never hands the value to the identity that would build the prompt. The `Encrypted` policy action, and the API-key route for the agent identity (see README), were not exercised.

## Z-CAT

Command: `node infra/zetaris/scripts/verify.mjs z-cat`. Drift is made on a throwaway datasource (`hospital_probe`) so the real policies are not touched (finding 2).

```
tags: set, read back, found by tag search; the agent can read them (authority_tier:regulator) and cannot write (HTTP 400)
drift: ALTER TABLE reviewers ADD COLUMN drift_probe -> catalog unchanged -> REFRESH -> DESCRIBE shows the new column (5 -> 6)
SHOW DATASOURCE CHANGE HISTORY hospital_probe -> INITIALIZE | DATASOURCE | hospital_probe is created
                                              -> INITIALIZE | DATASOURCE | 9 tables ingested
                                              -> ADD | COLUMN | schema : public, table : reviewers, column : drift_probe:StringType was added
                                              -> DELETE | COLUMN | ... column : drift_probe was deleted
agent identity running the same statement: FORBIDDEN (administrator only)
```

## Z-AUD

Command: `node infra/zetaris/scripts/verify.mjs z-aud`. Eight statements as the agent (five answered, one error, one refusal, one forbidden lake read) and one as the administrator, each with its own request id.

```
GET /audit/logs (admin): 9 of 9 request ids found; user matches; success flag false for the refusal and the error
  {"requestId":"669995bb-...","userEmail":"GeneralUserPrincipal(Email(AGENT-READER@SAKAIME.EXAMPLE)","apiName":"runSql","finishSuccessfully":false}
GET /audit/logs (agent): HTTP 400 {"msg":"Not Allowed"}
GET /sql-editor/sqls/history (agent): 8 of 8 query ids found, including the failed one ("status":"Error")
a request id that was never sent: not found
```

The query history is per user (the administrator's history shows none of the agent's ids), so only `/audit/logs` is an independent witness. The operator-side table `audit.sql_audit_log` keys on a hash of the SQL and does not carry our ids, so it was not used. Not tested: the clear endpoint, tamper evidence. Retention is 30 days per the endpoint description.

## Z-TT

Command: `node infra/zetaris/scripts/verify.mjs z-tt`. Iceberg table `sk_lake.evidence.registry_snapshot` in a data lake on local storage, two snapshots of the registry record NCT03112005.

```
VERSION AS OF <first snapshot>  -> RECRUITING
VERSION AS OF <second snapshot> -> COMPLETED          current state -> COMPLETED
TIMESTAMP AS OF <between the commits> -> RECRUITING
TIMESTAMP AS OF '2000-01-01' -> error "Cannot find a snapshot older ..." (an error, not an empty answer)
VERSION AS OF 123 -> error (unknown snapshot)
agent identity without an assignment: FORBIDDEN
```

`CREATE DATALAKE` on the S3Mock bucket was rejected with "Path does not exist or is not allowed" even with an object under the prefix, so the lake uses `storageType "LOCAL"` on the driver and API shared volume. Why the S3 form failed is NOT VERIFIED. The CSV file-store snapshots have no history; Sakaime must write snapshots into the lake to ask what the evidence said on an earlier date.

## Z-USL

Command: `node infra/zetaris/scripts/verify.mjs z-usl`. Definition: `infra/zetaris/sql/usl.mjs`. Model: `lightning.metastore.sakaime.sakaime_evidence` with `authorization_record`, `device_version`, `study_record`, `vendor_claim`, `case_context`, `evidence_matrix`.

```
COMPILE USL (6 tables, one request): accepted
SHOW NAMESPACES OR TABLES IN ...sakaime_evidence: all 6 activated
agent identity (non-admin) row counts through the USL: 12, 20, 157, 14, 7, 20 (equal to the source files)
evidence_matrix through the USL equals the DuckDB join, cell by cell: 20 rows in 1047 ms (the hand-written join: 829 ms)
RUN DQ has_eligibility TABLE ...study_record -> total 157, valid 14, invalid 143   (DuckDB: 14 of 157)
the 143 rejected records are exactly the 143 search summaries without an eligibility block; NCT03112005 passes
RUN DQ age_in_range, cites_a_submission (vendor_claim), has_version (device_version): 0 invalid
planted violation (age 200, no cited submission): caught by both rules (15 total, 1 invalid each); original restored, 14 of 14
foreign key device_version.submission_number -> authorization_record: 20 of 20 resolve
agent identity ACTIVATE USL TABLE / REGISTER DQ: FORBIDDEN
```

The completeness rule is the one the plan calls essential: a ClinicalTrials.gov record cut short before it reached the silo feeds nothing downstream. Activation failures are explained well: a missing `COALESCE` on a `NOT NULL` key returned the corrected SELECT in the error text. No time saving against hand-joining is claimed; engineering time was not measured.

## Z-PDF

Command: `node infra/zetaris/scripts/verify.mjs z-pdf`. Three FDA summary PDFs (K200667, DEN180001, K253265; hashes match the fixtures manifest). Extractors compared: Zetaris `FORMAT PDF`, poppler `pdftotext`, `pdfjs-dist`.

```
default table: length(preview) = 1000 for all three (file sizes 851,970 / 142,581 / 468,736 bytes) -> flagged as truncated
explicit table (preview_len "2000000"): 47,199 / 35,080 / 29,732 characters
recall of pdftotext words in the Zetaris text: 98.75% / 99.24% / 99.05%   (pdfjs words in the Zetaris text: 100% for all three)
an indication sentence quoted from pdftotext is found in the Zetaris text for all three;
  for K200667 and K253265 it lies beyond the first 1,000 characters, so a default table would have lost it silently
```

The table exposes text only: no page numbers, offsets or layout. It is a second extractor for agreement checks and cannot replace the locator layer. That the extractor is PDFBox text stripping is read from the open-source code and the class constants, not confirmed for the installed build.

## Z-NL: BLOCKED

The Zetaris natural-language path for the Evidence Matrix question could not be measured. Three independent routes were tried (`node infra/zetaris/scripts/verify.mjs z-nl`):

1. REST: the local OpenAPI document (284 paths) has only `pipeline/.../ask` and `pipeline/.../chats`, which belong to an LLM pipeline relation (provider, prompt, config, top_n, min_score), not to a question over federated tables. A call on a nonexistent pipeline returns HTTP 400; no pipeline exists and building one needs an LLM provider and the disabled Airflow component.
2. Web UI: the compiled front end contains an assistant that answers "AI assistant is not yet wired to a backend"; no file mentions text-to-SQL.
3. Bundle: the local compose file has no natural-language, MCP or AI-steward service; guessed paths `/mcp`, `/api/v1.0/mcp`, `/api/v1.0/nl2sql`, `/api/v1.0/query/natural-language` all return 404.

NOT VERIFIED: whether the Zetaris Cloud or Enterprise natural-language and MCP routes would answer it. Not attempted: building an LLM pipeline relation. The ablation needs the documented fallback, a model-written-SQL arm over REST (`docs/03-zetaris-plan.md` section 6, arm 2).

## Kill drill

Command: `node infra/zetaris/scripts/verify.mjs kill-drill --kill-drill`. Three runs, same stack.

```
Part A, API container stopped (docker stop took 3.9 to 4.7 s):
  SELECT 1 for the agent identity: UNAVAILABLE after 7, 2, 4, 2, 2 ms (fetch failed, ECONNREFUSED); a data query: UNAVAILABLE after 1 ms, zero rows
  the driver container stayed running/healthy: the engine and the REST layer fail separately
  docker start -> SELECT 1 answers again after 13.2 s to 14.3 s
Part B, engine out of memory (collect_list of 40 million 200-character strings, driver heap 1536m):
  the statement failed as UNAVAILABLE (HTTP 400 "Could not create ResultSet: null" or TTransportException) after 12.9 s, 24.3 s and 87.6 s in the three runs
  the driver JVM exited and the restart policy restarted it (OOMKilled flag false, exit code 0)
  SELECT 1 answered again 36 s, 53 s and 111 s after the statement was sent, without manual action; container health was "starting", then "healthy" at the moment queries worked
```

The failure is classified UNAVAILABLE (retry, then degrade), never FORBIDDEN or empty. Because a refused connection is immediate but a hung one was not observed, every Sakaime call still carries its own timeout. The policies survived the driver restarts (the reviewer still saw 5 of 7 cases).

## What was not run

- Z-JUDGE (what a judge without Docker sees): not in this task.
- Z10 pushdown output: `EXPLAIN ROUTING` answers "Query Director is not enabled on this server (set LIGHTNING_QUERY_DIRECTOR_ENABLED=true)"; not enabled.
- An API key for the agent identity: the vendor guide asks that keys are created by hand in the UI, so the stack uses password login for all identities. The README lists the one human step.
- Role-level policies, the `Encrypted` action, concurrent queries, S3-backed data lakes, audit retention and tamper evidence, Linux and macOS.
