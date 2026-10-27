# Sakaime and Zetaris: using the platform to its full depth

Status: plan, 2026-10-27. Zetaris is required in every submission and must have a real, output-changing role. This plan lists every Zetaris capability we can verify, the role each plays in Sakaime, the test that proves it matters, and the gates that must pass before we claim anything. Facts are tagged. Sources: `the sibling project's Zetaris setup notes (not in this repository)` (runs on this machine, 2026-10-16 to 2026-10-22), `zetaris-docs-readout.md` (public documentation, 2026-10-13 to 2026-10-17). Those are the sibling project's notes; the facts are about Zetaris, not about that project.

## 1. What is verified about Zetaris (on this machine)

| Fact | Tag |
|---|---|
| Local stack (Docker Compose, WSL) installs; `verify.sh` 9 of 9 PASS; UI 3000, REST 8888, JDBC 10000 | VERIFIED 2026-10-16 |
| `POST /api/v1.0/sql-editor/sqls/run` with bearer key, `X-Org-ID`, request UUID, body `{queryId, sql, source, limit}` returns rows | VERIFIED 2026-10-16 |
| Discovery statements: `SHOW LIGHTNING DATABASES`, `SHOW TABLES IN <db>` work; `SHOW TABLES` without a target is refused | VERIFIED 2026-10-16/17 |
| Own JDBC source (Postgres) registered and queried as `<name>.<table>` | VERIFIED 2026-10-22 |
| Own REST source: `CREATE LIGHTNING DATABASE`, then `CREATE LIGHTNING REST TABLE t FROM db REQUEST (endpoint, method, http_encoding, response_type, insecure_ssl) HEADER () BODY ()`; the request is re-issued on every query that touches the table | VERIFIED 2026-10-22 (static JSON) |
| Own file source: S3-style bucket (S3Mock) plus `CREATE LIGHTNING FILESTORE TABLE ... FORMAT CSV OPTIONS (path "s3a://...", header, inferSchema, ...)` | VERIFIED 2026-10-22 |
| One SQL statement joining JDBC + REST + files returned correct results (792 rows with `limit` 5000); aggregating each silo in a subquery before joining avoided fan-out | VERIFIED 2026-10-22 |
| Stopping the API container made a dependent command fall back cleanly in 3 s | VERIFIED 2026-10-22 |
| Zetaris containers reach silos only by container name on their Docker network, not host files | VERIFIED 2026-10-22 |
| Row and column policies: Grant, Deny, Hide, Masked (regex), Encrypted; row filter expressions; table-level grants | documented, NOT RUN by us |
| Catalog: table/column metadata, statistics, metadata change history, tags | documented, NOT RUN |
| Unified Semantic Layer; Iceberg time travel; audit log retrieval; query plan/pushdown output; `REGISTER PDF DATASOURCE`; MCP and natural-language-to-SQL | documented or advertised, NOT RUN or NOT FOUND |

## 2. Roles in Sakaime, ordered by how much they change the result

| # | Zetaris capability | Sakaime role | What a judge sees | Fair comparison (test id) |
|---|---|---|---|---|
| Z1 | Federated SQL across **three silo types** | The Evidence Matrix: one statement joins hospital review records (JDBC Postgres), regulator and registry records (REST or snapshot filestore), and vendor packet exports (CSV files) on stable identifiers | The Query tab with the statement, source badges per column, row counts, query id | Without Zetaris the matrix loses the hospital requirement columns and the vendor claim columns, or is assembled by slower application code with no governance; the finding "claim exceeds the hospital's own requirement" disappears (ZA-1) |
| Z2 | Catalog and `SHOW` statements | The Discoverer enumerates sources and schemas from Zetaris, not from a hardcoded list; a new database appears in the Source Console on its own | A source added in Zetaris shows up without a code change | Discovery falls back to the static source cards and the unknown-source test T1 fails (ZA-2) |
| Z3 | Row and column policies | Vendor-confidential packet fields are masked for reviewers not assigned to the case; the agent identity has SELECT only and never sees masked columns | Two reviewer identities see different columns for the same query; the model prompt log contains no masked value | With policies off a masked value appears in the prompt log and the safety test fails (ZA-3) |
| Z4 | Catalog tags and metadata change history | Source authority tier, system-of-record flag and licence stored as tags where the data lives; a schema change in the catalog raises a World Model drift event that marks dependent findings stale | A tag edit changes how a source is weighted; a metadata change triggers re-evaluation | Authority falls back to the local card; drift is not detected from the platform (ZA-4) |
| Z5 | Governed read-only access and per-query audit | Every query carries the reviewer or service identity; the Zetaris audit record is cross-checked against our trace (an unlogged query or a replayed cassette posing as live raises an alarm) | A "trace matches audit log" line in the dossier | Audit cross-check impossible; marked NOT VERIFIED in the dossier (ZA-5), if the audit data can be read at all |
| Z6 | Decisions published back as a Zetaris data product | Reviewer decisions and findings are written to the Postgres silo and exposed as a table that other consumers (a second agent, a BI tool) can query: "which products are on hold" | A query from a separate client returns the held products | Cross-consumer consistency lost (ZA-6) |
| Z7 | Iceberg time travel on snapshots | "What did the evidence say on the date of the last review" as a query over an earlier snapshot | The Evidence Timeline reads an earlier snapshot through Zetaris | Falls back to our own snapshot store (ZA-7), if time travel is available in the local build |
| Z8 | Unified Semantic Layer | Shared definitions ("sensitivity", "emergency department", "adult") that the compiler reads | A definition edited in the layer changes a label | Falls back to our glossary (ZA-8), if the layer is reachable |
| Z9 | Natural-language-to-SQL / MCP | The naive baseline in the ablation: the same question answered by Zetaris's own agent path without our discovery, identity and compiler layers | Side by side: baseline answer vs Sakaime answer | n/a, it is the comparison arm |
| Z10 | Pushdown / plan output | Show which predicates ran at the source (an `EXPLAIN`-style view) and apply residuals in code | Query plan beside the SQL | Informational |

Tiers (adopted from the 2026-10-27 review, `10-review-disposition.md`):

| Tier | Capabilities | Proof required |
|---|---|---|
| **Essential** | Z1 federated query across PostgreSQL, public-record snapshots and vendor files; Z2 discovery and unknown-schema handling; **Z8 the Unified Semantic Layer with at least one data-quality rule (completeness gate: a truncated collection feeds nothing downstream) and a written reflection, which Zetaris staff named as the core of Zetaris judging (D-024)**; correct failure semantics (empty, unavailable, forbidden, stale, truncated kept distinct) | query id, source ids, correct rows, an independent SQL comparison on the DuckDB oracle; add a source, validate the mapping, register and query without an application code change |
| **Strong differentiator** | Z3 permission-aware access (sensitive fields unavailable to unauthorised reviewers and to their model calls); Z4 source metadata and drift (a changed schema or record marks exactly the dependent findings stale) | two-identity demo; prompt-log inspection; a drift event with the stale set |
| **Conditional** | Z5 audit cross-check, Z6 decision publishing, Z7 time travel, Z10 pushdown output | the capability works on the installed version with a reproducible recording; otherwise dropped from the claims |
| **Comparison arm** | Z9 Zetaris's own natural-language-to-SQL and MCP path | recorded as a baseline, not a feature |

The strongest demonstration of this plan: a new evidence source is added, discovered, joined with existing records through Zetaris and changes an investigation; then the source goes offline and the system distinguishes unavailable evidence from a genuine negative finding.

## 3. Design of the silos

- **Postgres `hospital`** (JDBC, synthetic): `requirements` (what this hospital asks of AI products: intended setting, minimum validation type, subgroup reporting, update-control evidence), `vendors`, `submissions` (vendor claims with the packet id), `cases`, `reviewers`, `decisions`, `precedents`. No PHI.
- **Evidence silos for public records**:
  - REST tables over openFDA, ClinicalTrials.gov v2, PubMed E-utilities and Crossref, each defined with a bounded endpoint (the query string fixed per table, since the request is re-issued per query and per-query parameters are NOT VERIFIED). The Discoverer creates such a table per bounded scope at run time, for example one product code or one condition.
  - Where a REST response shape does not fit a table cleanly (nested `results` arrays) [NOT VERIFIED, gate Z-REST], the connector lands a normalised snapshot as CSV/Parquet in the S3-style bucket and a filestore table exposes it. The Record keeps the live request hash and the snapshot hash.
- **Files silo** (S3-style, CSV/Parquet): vendor packet exports, extracted-facts tables from our own parser (each row with its anchor), and evidence snapshots for time travel.

Both the REST route and the snapshot route make Zetaris perform the join. The difference is only where the public bytes sit.

### Operating facts learned from the channels (2026-10-27; `reference/hackos-channel-digest-2026-10-27.md`)

- **Snapshot-first for public JSON.** REST tables are re-fetched on every query (40 to 50 s for a 1.5 MB JSON), `CACHE TABLE` does not survive a restart, and very wide nested JSON can exhaust the driver heap (2 GB default; one team used 4 GB). So public API responses are normalised into the filestore and joined there; REST tables are for small bounded endpoints only.
- **PDFs through Zetaris.** `FORMAT PDF` filestore tables expose extracted text (`preview`, default 1,000 characters, silently truncated) and bytes (`pdfToText`). We test this on the FDA summaries as a second extractor beside our own parser, set the preview length explicitly and detect truncation (gate Z-PDF).
- **One statement per request**, no trailing semicolon, values returned as strings (typed casting layer on our port), 60 s limit, `localhost` inside SQL is the container (use `host.docker.internal`).
- **USL recipe**: the whole `COMPILE USL` DDL in one request, one `ACTIVATE USL TABLE` per table with explicit casts, then `RUN DQ TABLE`.
- **Agent identity**: a non-admin user with a General role limited to view and its own API key can only run SELECT; admin work (sources, USL creation) is done separately. Known risk: non-admin users with grants saw "does not have access to USL" on USL tables (gate Z-POL covers USL tables).
- **Health**: a stopped Spark context leaves the container healthcheck green while every query returns HTTP 400; HTTP 400 "Could not create ResultSet: null" and thrift transport errors appear intermittently on clusters. Our `check` runs a real `SELECT 1`, classifies these as UNAVAILABLE and retries with backoff, and an out-of-memory restart is a named drill.

## 4. The headline statement

One statement (shape, not final SQL) produces the Evidence Matrix for a device and an intended use:

```
authorization (REST/snapshot: FDA)   JOIN  study registry (REST/snapshot: ClinicalTrials.gov)
  ON confirmed identity link table (Postgres: reviewer-confirmed links)
JOIN vendor claims (files: packet export)  ON vendor claim -> device version
JOIN hospital requirements (Postgres)      ON setting + purpose
```

Aggregation happens per silo before the join, because joining raw rows repeated amounts in the sibling project's tests (fan-out). The result carries per-source row provenance, so the Matrix keeps source columns instead of collapsing them. A key-based join is used only for candidate retrieval; resolution happens in L3.

## 5. Verification gates (nothing here is claimed until the gate passes)

| Gate | Question | Pass condition |
|---|---|---|
| Z-REST | Can a REST table read an openFDA / ClinicalTrials.gov JSON response (nested `results` / `studies` arrays) and expose usable columns? | A query over the live table returns the same count and a matching sample as a direct call; otherwise use snapshot route and record why |
| Z-POL | Do column masks and row filters work for a second identity, and does a masked value reach the model prompt? | Two identities see different columns for one statement; prompt log contains no masked value |
| Z-CAT | Can catalog tags and metadata change history be read through REST or SQL? | Tag set and read back; a changed column appears in history |
| Z-AUD | Can the audit record be read, and does it list our queries? | Each traced query id found in audit; or recorded as NOT VERIFIED |
| Z-TT | Does Iceberg time travel work in this build? | A query at an earlier snapshot returns the earlier rows; otherwise drop Z7 |
| Z-USL | Can we compile and activate a USL (whole DDL in one request, per-table activate with casts), query it through the product as the read-only identity, and run a DQ rule? | USL queried as a non-admin view-only user; `RUN DQ TABLE` result recorded; this gate is Essential (D-024), so a failure blocks the Zetaris claim until fixed |
| Z-PDF | Does `FORMAT PDF` return usable text for the FDA summaries with the preview length set, and do we detect truncation? | text of 3 real summaries compared with our parser's text; truncation flagged |
| Z-NL | What does Zetaris's natural-language-to-SQL return for the Evidence Matrix question? | Recorded as the baseline arm |
| Z-JUDGE | What does a judge without Docker see? | Cassette path reproduces results; live proof path documented |

If a gate fails, the feature is dropped from the product and from the claims, and the failure goes in the sponsor explanation as a limit.

## 6. Fair comparisons (pre-registered; `06-evaluation-protocol.md`)

Switching a sponsor component off must not be rigged to make it look essential. For Zetaris, three arms are compared on identical data:

1. **A simpler join engine** over the same records (DuckDB in process, used also as the independent oracle).
2. **Limited single-source access** (what an agent sees if it queries each source alone).
3. **The real Zetaris integration.**

Compared on: correctness of the joined answer (expected equal if the data is the same), discovery of a new source without code change, governance (masked columns reaching the model), provenance (query ids and audit), failure semantics, latency and operability. A capability counts as earning its place where it improves federation, governance, extensibility or operational reliability; where it does not change the answer, we say so and do not invent an accuracy gain. Hiding a source from the baseline proves little and is not done.

Named comparisons: ZA-1 federation vs in-process join vs single source; ZA-2 discovery with and without Zetaris metadata; ZA-3 policies on and off (prompt-log inspection); ZA-4 catalog tags and drift; ZA-5 audit cross-check; ZA-6 decision publishing; ZA-7 time travel; ZA-8 semantic layer. Each reports findings changed, runtime, whether the degraded state was announced, and the cases where nothing changed.

## 7. Evidence we will produce for judges

A recorded Zetaris session (video and cassette) with query ids, the statement above and per-silo row counts; the two-identity masking demo; the Source Console showing a database added in Zetaris; the kill drill (stop the Zetaris API container; the product answers within seconds with every affected finding marked degraded); and a sponsor explanation that names the code paths.

## 8. Risks

REST-table limits (Z-REST); Windows and WSL memory (the stack needs about 8 GB for Docker; the host has shown memory pressure); the default admin credential on the local install must stay local; Docker images need about 10 GB of disk and C: has little room (plan a data location off the system drive or free space first); judges without Docker rely on cassettes.

## 9. Deliverable: the USL reflection

Zetaris staff asked every team to reflect on its USL. `docs/zetaris-usl-reflection.md` will state, from measured use: what the USL unified, how much time it saved against joining the sources by hand (measured, not estimated), how it helps a hospital reviewer, which data-quality rules caught what, what did not work (including any of the issues in s3), and how the platform could improve. It is written after the Z-USL gate passes.
