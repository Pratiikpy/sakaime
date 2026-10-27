# Zetaris stack for Sakaime

A local Zetaris Lightning platform with the three Sakaime silos, three non-admin identities, a Unified Semantic Layer and the verification gates of `docs/03-zetaris-plan.md` section 5. Everything runs in Docker under its own compose project (`sakaime-zetaris`) on its own ports, so it can sit beside any other Zetaris installation. Results of the gates are in `GATES.md`.

Verified on Windows 11 with Docker Desktop and Git Bash. Linux and macOS are NOT VERIFIED; the scripts are plain bash and Node but have not been run there.

## What you get

| Service | Where | What it is |
|---|---|---|
| Web UI | http://localhost:3300 | Zetaris UI, bound to loopback; sign in as `admin@sakaime.example` with `SAKAIME_ZETARIS_ADMIN_PASSWORD` from `.env` |
| REST API | http://127.0.0.1:8988/api/v1.0 | `POST /sql-editor/sqls/run` runs one Lightning SQL statement; OpenAPI at `/redoc/docs.yaml` (Basic auth) |
| Internal API | http://127.0.0.1:8989 | login route used by the platform itself; do not publish |
| JDBC | `jdbc:zetaris:lightning@localhost:10100` | driver jar in `bundle/jdbc/`; the port is published, a JDBC client was not run in this work (NOT VERIFIED) |
| Spark UI | http://127.0.0.1:4140 | no authentication, loopback only |
| Hospital database | `127.0.0.1:15433`, database `hospital` | the Postgres silo, also registered in Zetaris as datasource `hospital` |
| Object store | http://127.0.0.1:19190 | S3Mock holding the registry snapshots, vendor exports and PDFs (in memory; `seed` refills it) |
| REST silo | http://127.0.0.1:18080 | recorded openFDA and ClinicalTrials.gov JSON for the REST-table gate |

Inside the Docker network the services reach each other by service name (`hospital-db`, `object-store`, `rest-silo`). A source on your host or laptop is not reachable by Zetaris; that is why every silo is a container here.

Zetaris objects created by `seed`:

| Object | Kind | Contents |
|---|---|---|
| `hospital.*` | JDBC datasource | vendors, requirements, submissions, cases, case_assignments, decisions, precedents, reviewers, evidence_links (constructed) |
| `sk_registry.*` | file-store database | fda_510k, fda_udi, fda_classification, ctgov_studies, pubmed_articles (real records, flattened) |
| `sk_vendor.*` | file-store database | vendor_packets, vendor_claims (constructed) |
| `sk_docs.fda_summaries` | PDF file-store table | three FDA summaries; `fda_summaries_default` keeps the 1,000-character default for comparison |
| `sk_rest.*` | REST tables | recorded and live openFDA and ClinicalTrials.gov endpoints |
| `sk_lake.evidence.registry_snapshot` | Iceberg table | two snapshots, for time travel |
| `lightning.metastore.sakaime.sakaime_evidence.*` | USL | authorization_record, device_version, study_record, vendor_claim, case_context, evidence_matrix; four data-quality rules |

Identities (names only; passwords are generated into the repository `.env`):

| Identity | Level and role | Sees |
|---|---|---|
| administrator `admin@sakaime.example` | ADMIN | everything; used by setup and the gates, never by the agent |
| `agent-reader@sakaime.example` | general, `agent_readonly`, SELECT only | all silos with `confidential_unit_price_usd` denied (null) and `confidential_reference_site` masked |
| `reviewer-unassigned@sakaime.example` | general, `case_reviewer_unassigned` | the same column treatment, and a row filter that removes the two EyeArt cases from `hospital.cases` |
| `reviewer-assigned@sakaime.example` | general, `case_reviewer_assigned` | everything in the silos, no policy |

All three non-admin identities log in with a password and a JWT (`GET /auth/login` with Basic auth and `X-Org-ID: 1`); `scripts/zt.mjs` does this. The vendor guide asks that REST API keys are created by hand in the UI and never by an agent, so no script creates one. If you want the agent to use a key: sign in to the UI as `agent-reader@sakaime.example`, open Management, API Tokens, create a key, and store it yourself; nothing in this directory depends on it.

## Run it from a clean machine

You need Docker with the compose plugin (Docker Desktop is enough), Node 22 or later, bash (Git Bash or WSL on Windows), about 15 GB of free disk and a Zetaris Cloud account.

1. Register at https://cloud.enterprise.zetaris.com/register and open the "Run locally" page. Download `zetaris-platform.zip` and unzip it and rename its top folder `zetaris-platform` to `bundle`, so that `infra/zetaris/bundle/docker-compose.yml` exists. The directory is gitignored: the bundle carries a personalised `.env` and a 31 MB driver jar and is not ours to redistribute. Nothing in it is modified; this directory only adds an overlay (`docker-compose.sakaime.yml`).
2. Put the registry login from that page into the repository `.env`: `ZETARIS_REGISTRY`, `ZETARIS_REGISTRY_USER`, `ZETARIS_REGISTRY_PASSWORD` (`.env.example` lists every entry). Then generate the rest:

   ```
   node infra/zetaris/scripts/secrets.mjs
   ```

   It appends the missing `SAKAIME_*` passwords to `.env` and never prints them. Zetaris requires the administrator password to have at least 8 characters with a lower case letter, an upper case letter, a digit and one of `$ @ ! % * ? &`; the generator follows that rule and avoids `$`.
3. Start the platform and the silos (about 4 GB of images on the first run, then about 50 s):

   ```
   infra/zetaris/scripts/up.sh
   ```

4. Load the silos, identities, policies and the semantic layer (about 25 s, idempotent):

   ```
   infra/zetaris/scripts/seed.sh
   ```

5. Run the gates:

   ```
   infra/zetaris/scripts/verify.sh
   ```

   Expected: `PASS` for Z-HEAD, Z-REST, Z-POL, Z-CAT, Z-AUD, Z-TT, Z-USL and Z-PDF, and `BLOCKED` for Z-NL (there is no natural-language service in the local build; `GATES.md` records the three attempts). Run one gate with `verify.sh Z-POL`.
6. Optional, destructive: the kill drill stops the API container and runs the query engine out of memory, which restarts the driver:

   ```
   infra/zetaris/scripts/verify.sh kill-drill --kill-drill
   ```

Stop with `infra/zetaris/scripts/down.sh` (keeps data) or `down.sh --purge` (deletes the metastore, the field-encryption keypair and the hospital database). After a `down`/`up` cycle run `seed.sh` again: the object store is in memory.

On Windows, run the scripts from Git Bash or from inside WSL. The Ubuntu WSL distribution is not needed; Docker Desktop's engine hosts the stack. Starting an old WSL distribution can bring other projects' containers up inside the same 4 GB VM, which starves this stack.

## Sizing

The vendor laptop profile (2g driver heap, 1g API heap) asks for 8 GB for Docker. `sakaime.env` sets 1536m and 768m so that the stack fits in a Docker VM of 3.9 GB together with a few other small containers; in that VM the whole stack used about 1.8 GB of container memory plus 1.2 GB of swap, and the gates pass. On a larger host raise `ZSPARK_DRIVER_MEM` and `ZETARIS_API_MAX_HEAP` in `sakaime.env` and recreate the driver and API (`up.sh`). The overlay caps each service's memory (`mem_limit`) so a runaway statement kills its own container instead of a neighbour. Large or deeply nested JSON through REST tables can exhaust the driver heap; land such responses as files instead.

## Rules this stack taught us

These come from the gates; evidence is in `GATES.md`.

- Never use the `Hide` column action on file-store tables: `SELECT *` leaks the hidden value under a neighbouring column name. Use `Deny` or `Masked`.
- `REFRESH DATASOURCE TABLES FROM <source>` and `UPDATE DATASOURCE SCHEMA <source>` delete all policies on that source. After either, run `seed.sh` (it re-applies the policies) and check with a restricted identity.
- A non-admin user needs both `GRANT SELECT ON USL NAMESPACE ...` and a REST assignment of the USL instance to the role. `seed.mjs` does both.
- Policies attach to users (`userLevelPolicy`), not to roles, in this build.
- The preview length of a PDF table is `preview_len`. Unknown option names are accepted and ignored.
- Readiness is a real `SELECT 1` through the REST route (`scripts/wait-ready.mjs`), not the container health check, which only tests that port 10000 accepts a connection.
- One statement per request, no trailing semicolon, values come back as strings, descriptions allow only letters, digits and `_ . - ,`.

## Layout

```
docker-compose.sakaime.yml   overlay: memory caps, Spark profile, the three silo containers
sakaime.env                  non-secret configuration (image tags, ports, heaps)
.env.example                 the entries read from the repository .env
conf/spark-defaults.conf     small-data Spark profile
sql/                         headline statement (Zetaris and DuckDB dialects), USL definition
scripts/                     up, down, seed, verify (bash); secrets, seed, zt (REST client), oracle (DuckDB), wait-ready, verify (Node)
gates/                       one script per gate
GATES.md                     results with evidence
bundle/                      the unpacked vendor download (gitignored)
.runtime/                    generated secrets file and evidence JSON (gitignored)
```

The silo data lives in `data/silos/` with its own README.
