# Study register: GitHub repositories to read, in order

Status 2026-10-27. Source of the list: the outside playbook kept verbatim in `reference/validwhen-track1-github-study-playbook.md` (61 repositories). Facts below were read from the GitHub API on 2026-10-27 (all 61 exist, none archived). **A repository is a navigational start, not a dependency**: a mechanism is taken only after reading its code and tests, checking the licence, and writing a short design note comparing it with a simpler option (`08-build-plan.md`, section 4). The licence column is what GitHub detected; NOASSERTION means the LICENSE file must be read by us.

Priority: P0 read before the named module is built; P1 read if relevant; P2 optional alternative; REFERENCE ideas only. Study status is NOT STARTED unless stated.

## 0. Sponsor source repositories

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [Meterless/Meterless](https://github.com/Meterless/Meterless) | 257 | Apache-2.0 | 2026-10-19 | Reference engines, their real API contracts, conformance harnesses, Nightshift documentation and licensing | An engine actually changes case behavior and its conformance and product-specific tests pass | Read through the sibling project's engineering brief (commit 0aa7417). Not re-cloned here yet. |
| P0 | [zetaris/getting-started](https://github.com/zetaris/getting-started) | 9 | Apache-2.0 | 2026-10-26 | Version-matched Lightning SQL examples, REST/file/JDBC source onboarding recipes, connection helpers and known setup issues | Genuine three-silo Zetaris query, discovery, safe fallback and source registration on the installed version | Read through the sibling project's notes. Not re-cloned here yet. |
| P1 | [zetaris/lightning-catalog](https://github.com/zetaris/lightning-catalog) | 41 | MIT | 2026-02-05 | Public catalog concepts and metadata modeling; not assumed identical to the installed proprietary platform | Catalog fields and APIs used by Sakaime are independently verified, or feature stays out of claims | NOT STARTED |

## A. Source discovery, connectors and federation

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [airbytehq/airbyte](https://github.com/airbytehq/airbyte) | 22,272 | NOASSERTION | 2026-10-27 | Connector spec/check/discover/read/state and resuming after interruption | T1: onboard and checkpoint an unseen source; report UNAVAILABLE vs EMPTY | Protocol repo `airbytehq/airbyte-protocol` cloned (`research/airbyte-protocol`, MIT). Main repo not cloned. Licence reported as NOASSERTION; read the LICENSE and the connector licences before adapting anything. |
| P1 | [meltano/sdk](https://github.com/meltano/sdk) | 120 | Apache-2.0 | 2026-10-26 | Singer tap and target contracts, discovery, pagination and incremental state | Run a source with pagination and restart without duplicate rows | NOT STARTED |
| P1 | [dlt-hub/dlt](https://github.com/dlt-hub/dlt) | 6,017 | Apache-2.0 | 2026-10-27 | Schema evolution and incremental, idempotent ingestion | Add/change a field and preserve source lineage on incremental load | NOT STARTED |
| P0 | [trinodb/trino](https://github.com/trinodb/trino) | 13,369 | Apache-2.0 | 2026-10-27 | Connector SPI, pushdown and residual filters, distributed query planning | T2: predicates unsupported by a source are still evaluated correctly | Read in part 2026-10-27: connector SPI (`ConnectorMetadata.applyFilter` and friends, `ConstraintApplicationResult.remainingFilter`). Sparse clone in `research/trino`. |
| P0 | [duckdb/duckdb](https://github.com/duckdb/duckdb) | 42,602 | MIT | 2026-10-26 | Independent SQL oracle and deterministic snapshot replay | Compare Zetaris result with DuckDB without reusing the same join implementation | NOT STARTED |
| P1 | [tobymao/sqlglot](https://github.com/tobymao/sqlglot) | 9,727 | MIT | 2026-10-26 | SQL AST, allowlisted read-only queries and dialect normalization | Reject unsafe SQL and log residual predicates; do not treat parsing as proof of validity | NOT STARTED |
| P1 | [apache/datafusion](https://github.com/apache/datafusion) | 9,536 | Apache-2.0 | 2026-10-26 | Query optimizer and physical vs logical plan design | Inspect plans and compare joins/fallback performance | NOT STARTED |
| P0 | [datahub-project/datahub](https://github.com/datahub-project/datahub) | 12,895 | Apache-2.0 | 2026-10-27 | Metadata schema, discovery search, provenance and metadata change events | Newly registered source appears with schema, authority and freshness | NOT STARTED |
| P1 | [open-metadata/OpenMetadata](https://github.com/open-metadata/OpenMetadata) | 15,589 | Apache-2.0 | 2026-10-27 | Catalog, tagging, ownership, source governance, quality and lineage UI | Show a schema drift event and affected findings | NOT STARTED |

## B. Evidence extraction and retrieval

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [docling-project/docling](https://github.com/docling-project/docling) | 69,643 | MIT | 2026-10-27 | Layout-aware PDF and table extraction with page and region anchors | Ground study version, metric, threshold and population to actual pages | Cloned 2026-10-27 (`research/docling`). Not run. |
| P0 | [docling-project/docling-graph](https://github.com/docling-project/docling-graph) | 937 | MIT | 2026-10-26 | Structured evidence graph and deterministic provenance binder | Every extracted assertion has exact or explicitly unresolved anchor | NOT STARTED |
| P1 | [Unstructured-IO/unstructured](https://github.com/Unstructured-IO/unstructured) | 15,629 | Apache-2.0 | 2026-10-27 | File-specific partitioners and heterogeneous ingestion | Compare email, PDF and scanned report parsing | NOT STARTED |
| P2 | [datalab-to/marker](https://github.com/datalab-to/marker) | 40,651 | Apache-2.0 | 2026-10-22 | Alternative PDF/table extraction baseline; check licensing | Evaluate same held-out PDFs; select only if it beats Docling | NOT STARTED |
| P1 | [deepset-ai/haystack](https://github.com/deepset-ai/haystack) | 26,851 | Apache-2.0 | 2026-10-26 | Modular hybrid retrieval, document filters, pipelines and evidence retrieval | Retrieve exact supporting and contradictory passages without source leakage | NOT STARTED |
| P1 | [onyx-dot-app/onyx](https://github.com/onyx-dot-app/onyx) | 33,012 | NOASSERTION | 2026-10-27 | Permission-aware enterprise connectors and retrieval UX | Study connector access control and permission propagation | Sparse clone of connector directories (`research/onyx`). Licence split not cleared. Licence NOASSERTION (MIT plus a separate enterprise licence); ideas only until read. |
| P2 | [microsoft/graphrag](https://github.com/microsoft/graphrag) | 36,456 | MIT | 2026-10-26 | Graph-RAG relationship extraction and local/global retrieval; maintenance-oriented reference | Compare graph retrieval to exact-identifier and structured search | NOT STARTED. Maintenance-oriented per its README. |
| P2 | [pgvector/pgvector](https://github.com/pgvector/pgvector) | 23,489 | NOASSERTION | 2026-10-26 | Vector candidates inside PostgreSQL, with ordinary joins | Semantic matching used only for candidates, not confirmation | NOT STARTED. Licence NOASSERTION (PostgreSQL licence file); read. |

## C. Identity resolution, versioning and temporal data

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [moj-analytical-services/splink](https://github.com/moj-analytical-services/splink) | 2,539 | MIT | 2026-10-26 | Probabilistic Fellegi-Sunter matching, blocking and score waterfalls | T3: distinguish near-identical devices and variants; abstain on ambiguous links | Cloned 2026-10-27 (`research/splink`); structure read, Fellegi-Sunter modules located. Not run. |
| P1 | [dedupeio/dedupe](https://github.com/dedupeio/dedupe) | 4,523 | MIT | 2025-07-29 | Human-active-learning record linkage and deduplication | Compare label efficiency and false-merge rates | NOT STARTED. Last push 2025-07-29. |
| P1 | [allenai/scispacy](https://github.com/allenai/scispacy) | 1,997 | Apache-2.0 | 2025-12-04 | Biomedical entity recognition and alias normalization | Show recall gain on real names without false merges | NOT STARTED |
| P0 | [getzep/graphiti](https://github.com/getzep/graphiti) | 32,252 | Apache-2.0 | 2026-10-26 | Time-valid facts, provenance episodes, evolving relationships | T4/T5: source authority + valid time, and exact dependent-finding invalidation | Read in part 2026-10-27: edge fields and `resolve_edge_contradictions` (recency-only rule). Clone in `research/graphiti`. |
| P1 | [networkx/networkx](https://github.com/networkx/networkx) | 17,363 | NOASSERTION | 2026-10-22 | Simple reference graph traversals and connected-component oracle | Compare identity and dependency closures on small exact-answer fixtures | NOT STARTED. Licence NOASSERTION (BSD-3-Clause file); read. |
| P1 | [OpenLineage/OpenLineage](https://github.com/OpenLineage/OpenLineage) | 2,726 | Apache-2.0 | 2026-10-25 | Run/job/dataset events and extensible lineage facets | Dossier can reconstruct each finding source and transformation | Cloned 2026-10-27 (`research/OpenLineage`). Not read in depth. |
| P2 | [MarquezProject/marquez](https://github.com/MarquezProject/marquez) | 2,300 | Apache-2.0 | 2026-10-26 | Lineage catalog/storage and graph exploration UI | Study end-user traceability; do not deploy unless needed | NOT STARTED |

## D. Agent orchestration, typed contracts and constraints

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs) | 3,377 | MIT | 2026-10-27 | TypeScript checkpoints, interruptions and resumable bounded state | Demonstrate critique/revision, restart recovery, human approval without duplicate side effects | NOT STARTED |
| P1 | [langchain-ai/langgraph](https://github.com/langchain-ai/langgraph) | 43,956 | MIT | 2026-10-27 | Python implementation/examples for durable state and human interrupts | Study semantics, not necessarily deploy alongside TS | NOT STARTED |
| P2 | [temporalio/sdk-typescript](https://github.com/temporalio/sdk-typescript) | 941 | MIT | 2026-10-27 | Durable workflows, idempotency, retries and compensation | Use if case processing evolves into multi-hour reliable workflows | NOT STARTED |
| P1 | [pydantic/pydantic-ai](https://github.com/pydantic/pydantic-ai) | 20,893 | MIT | 2026-10-27 | Typed tools and structured model outputs; Python alternative | Study validation/retries even if runtime stays TS | NOT STARTED |
| P0 | [colinhacks/zod](https://github.com/colinhacks/zod) | 44,202 | MIT | 2026-10-19 | Strict input/output boundary and closed state machine types | Invalid or ambiguous data never becomes a confirmed evidence object | NOT STARTED |
| P2 | [Z3Prover/z3](https://github.com/Z3Prover/z3) | 12,842 | NOASSERTION | 2026-10-27 | SMT constraints and counterexamples for complex applicability rules | Only adopt if simple typed rules cannot express tested constraints | NOT STARTED. Licence NOASSERTION (MIT file); read. |
| P2 | [microsoft/autogen](https://github.com/microsoft/autogen) | 61,577 | CC-BY-4.0 | 2026-10-16 | Role-group conversations and multi-agent evaluation reference | Compare multiagent complexity to small bounded flow | NOT STARTED. Licence reported as CC-BY-4.0 on the repo; code licence to be read. |

## E. Data contracts, quality and drift

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [sodadata/soda-core](https://github.com/sodadata/soda-core) | 2,454 | NOASSERTION | 2026-10-26 | Data quality contracts, schema and field-level checks | Units, nulls, duplicates, identity domains and drift must fail visibly | NOT STARTED. Licence NOASSERTION; read before adopting. |
| P1 | [fivetran/great_expectations](https://github.com/fivetran/great_expectations) | 11,904 | Apache-2.0 | 2026-10-22 | Expectation suites and validation reports | Compare field-level validation coverage with simpler contracts | NOT STARTED. The playbook's slug resolves and is active; confirm it is the maintained Great Expectations project. |
| P1 | [unionai-oss/pandera](https://github.com/unionai-oss/pandera) | 4,499 | MIT | 2026-10-26 | Statistical and semantic dataframe constraints | Schema-mapped fields fail when values change meaning/units | NOT STARTED |
| P1 | [evidentlyai/evidently](https://github.com/evidentlyai/evidently) | 8,012 | Apache-2.0 | 2026-09-29 | Dataset drift/quality metrics and AI evaluation reporting | Drift alerts separate schema changes from data distribution changes | NOT STARTED |

## F. Claims, benchmark and scientific proof

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [allenai/scifact](https://github.com/allenai/scifact) | 279 | NOASSERTION | 2023-10-15 | Scientific claim/evidence labels, rationale retrieval and abstention baseline | ScopeShift independent baseline: citation correctness is not clinical applicability | NOT STARTED. Last push 2023-10-15; licence not machine-detected. A baseline dataset, not a clinical-applicability ground truth. |
| P1 | [dwadden/multivers](https://github.com/dwadden/multivers) | 54 | MIT | 2023-08-16 | Scientific claim verification over long papers | Benchmark evidence support and explicit contradictory rationale | NOT STARTED. Last push 2023-08-16; research code. |
| P0 | [promptfoo/promptfoo](https://github.com/promptfoo/promptfoo) | 26,478 | MIT | 2026-10-26 | Model/tool-agent comparisons, custom graders, red-team tests | Run identical cases on full and baseline arms with pinned input manifest | NOT STARTED |
| P0 | [dubzzz/fast-check](https://github.com/dubzzz/fast-check) | 5,219 | MIT | 2026-10-26 | Property-based testing and minimal counterexample shrinking | Compiler invariants, source-off, no accidental evidence widening | NOT STARTED |
| P0 | [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | 17,289 | MIT | 2026-10-26 | Deterministic TS tests, integration tests and reports | Clean cloned repo can reproduce claims | NOT STARTED |
| P1 | [NVIDIA/garak](https://github.com/NVIDIA/garak) | 9,717 | Apache-2.0 | 2026-10-23 | Model security probing for injections, leakage and task hijacking | Hidden instructions in PDFs cannot alter the evidence verdict | NOT STARTED |
| P1 | [bennettoxford/trialstracker](https://github.com/bennettoxford/trialstracker) | 28 | MIT | 2025-01-10 | Long-running clinical trial reporting surveillance workflow | Study public-trial source collection, attribution and the actual buyer gap | NOT STARTED. Last push 2025-01-10. |
| P2 | [OHDSI/CommonDataModel](https://github.com/OHDSI/CommonDataModel) | 1,097 | none | 2026-10-09 | Mature clinical-data normalization standards (not patient-data pipeline for MVP) | Study vocabulary/identity lessons; do not ingest PHI | NOT STARTED. No licence detected; standards study only, no code. |

## G. Security, provenance and reliability

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [OWASP/CheatSheetSeries](https://github.com/OWASP/CheatSheetSeries) | 33,751 | CC-BY-SA-4.0 | 2026-10-26 | SSRF, authentication, authorization, input validation, secrets | Source onboarder refuses private IP, redirects, DNS rebinding and unapproved schemes | NOT STARTED |
| P0 | [microsoft/playwright](https://github.com/microsoft/playwright) | 98,599 | Apache-2.0 | 2026-10-27 | Real-browser end-to-end tests, screenshots and reproducible demo | Recreate judge demo entirely from actual application state | NOT STARTED |
| P0 | [sigstore/sigstore-js](https://github.com/sigstore/sigstore-js) | 187 | Apache-2.0 | 2026-10-26 | Artifact signing and verification | Tamper one byte and verification fails; signer identity claims limited to what is proven | NOT STARTED |
| P1 | [in-toto/in-toto](https://github.com/in-toto/in-toto) | 1,051 | NOASSERTION | 2026-08-27 | Supply-chain attestation and layout verification | Track inputs and performed steps in exported dossier | NOT STARTED. Licence NOASSERTION; read. |
| P1 | [open-telemetry/opentelemetry-js](https://github.com/open-telemetry/opentelemetry-js) | 3,504 | Apache-2.0 | 2026-10-26 | Structured trace IDs across services and requests | Link agent decisions to federation calls and parser operations | NOT STARTED |
| P1 | [gitleaks/gitleaks](https://github.com/gitleaks/gitleaks) | 30,369 | MIT | 2026-10-23 | Secret detection across repository and history | Secret scan on all commits and build artifacts | NOT STARTED |
| P1 | [aquasecurity/trivy](https://github.com/aquasecurity/trivy) | 38,747 | Apache-2.0 | 2026-10-26 | Vulnerability scanning for dependencies and containers | Track critical vulnerabilities in build and Docker assets | NOT STARTED |
| P1 | [dequelabs/axe-core](https://github.com/dequelabs/axe-core) | 7,712 | MPL-2.0 | 2026-10-26 | Accessibility checks for review UI | No serious automated a11y violations, plus human keyboard review | NOT STARTED |

## H. Reviewer product UX, visualization and applications

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| P0 | [shadcn-ui/ui](https://github.com/shadcn-ui/ui) | 126,636 | MIT | 2026-10-26 | Accessible customizable application components | Evidence Desk and source cards work consistently on mobile and desktop | NOT STARTED |
| P1 | [radix-ui/primitives](https://github.com/radix-ui/primitives) | 19,435 | MIT | 2026-10-14 | Accessible dialogs, tooltips, menus and focus management | Every uncertain-source modal keyboard operable | NOT STARTED |
| P1 | [TanStack/query](https://github.com/TanStack/query) | 50,487 | MIT | 2026-10-27 | Server-state caching, invalidation, cancellation and retry | Source updates invalidate stale UI without displaying old conclusions | NOT STARTED |
| P1 | [TanStack/table](https://github.com/TanStack/table) | 28,526 | MIT | 2026-10-21 | Evidence Matrix columns and filtering | Large source matrix remains usable with provenance and statuses | NOT STARTED |
| P1 | [xyflow/xyflow](https://github.com/xyflow/xyflow) | 38,791 | MIT | 2026-10-26 | Interactive source/claim/dependency graph visualization | One-click drilldown from finding to original record | NOT STARTED |
| P2 | [wojtekmaj/react-pdf](https://github.com/wojtekmaj/react-pdf) | 11,192 | MIT | 2026-10-26 | PDF document display integration | Click source anchor and open actual page and highlight | NOT STARTED |

## I. Deliberately non-runtime prior art

| Pri | Repository | Stars | Licence | Last push | Study focus | Proof before the module is called done | Study status and cautions |
|---|---|---:|---|---|---|---|---|
| REFERENCE | [Aroha-Labs/mira-network](https://github.com/Aroha-Labs/mira-network) | 2 | none | 2026-06-10 | Claim decomposition, developer-facing product narrative; licensing restrictions | Study product ideas only; do not copy proprietary client code | No licence declared (ideas only). |

## Already cloned for study (local, `research/`, gitignored)

splink, graphiti, docling, cognee (not on the playbook; a general memory layer, not adopted), trino (sparse), airbyte-protocol, onyx (sparse), OpenLineage, plus `research/samples` (a real DOT addendum) and `research/feasibility/fixtures` (about 4 MB of recorded public API responses).

## Counts

P0 21, P1 30, P2 9, REFERENCE 1; total 61. Studied in part: 8. Read in depth: 2 (Trino SPI, Graphiti contradiction rule).
