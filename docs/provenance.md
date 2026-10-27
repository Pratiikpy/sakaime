# Provenance

What in this repository existed before the build, what was studied, what was adapted, and under which licence. The Open Agent Hackathon asks for pre-existing components to be declared; this file is the full record, and the README and `metadata.json` summarise it.

All Sakaime source code was written for this project, starting 2026-10-27. Nothing was copied from the previous submission (desk., Track 3). Where an idea or a small contract detail was taken from it, that is listed below.

## Vendored third-party code (unmodified)

| What | Where | Licence | Source |
|---|---|---|---|
| Meterless reference engines (H-MEM, World Model) and their conformance runners | `third_party/meterless/` | Apache-2.0 | The sponsor's public repository, commit `0aa7417`. File hashes are in `third_party/meterless/PROVENANCE.md`; `tests/engines/vendor-integrity.test.ts` fails if a file differs. |

Sakaime's own engines in `src/engines/` are separate implementations that pass the same conformance runners and close the reference gaps listed in `docs/04-meterless-plan.md`. The Markovian and Scout Intent engines are built from the sponsor's specification; the sponsor's Markovian conformance runner is invoked from a local clone of the sponsor repository and is not vendored.

## Ideas studied and rebuilt (no code copied)

| Source | Licence | What was taken | Where it lives here |
|---|---|---|---|
| Splink (Ministry of Justice) | MIT | Fellegi-Sunter comparison levels, match-weight waterfall, blocking | `src/identity/` |
| Docling (IBM) | MIT | Layout-aware parsing that keeps provenance to page and passage | `src/extraction/` |
| OpenLineage | Apache-2.0 | Run, job and dataset events with facets; the published schema validates our events in a test | `src/dossier/lineage.ts`, `tests/dossier/` |
| Airbyte protocol | MIT | The `describe`, `check`, `discover`, `read` connector contract | `src/ports/`, `src/sources/` |
| Trino connector SPI | Apache-2.0 | A source declares which predicates it applies; the engine applies the residual | `data/sources/*.yaml`, `src/sources/` |
| Graphiti | Apache-2.0 | Bi-temporal facts and edge invalidation, with authority ranked above recency | `src/engines/world-model/` |
| PROBAST+AI, STARD-AI, TRIPOD+AI, IMDRF SaMD N41, FDA PCCP guidance | Published standards | Concepts of applicability and the items that carry scope facts. No standard prescribes the executable rules; those are our design inferences and say so in `src/compiler/rules.ts`. | `src/compiler/` (registry read from `research/standards/APPLICABILITY-RULE-REGISTRY.md`, local only) |

## Contract details taken from the previous submission (read-only reference)

The desk. repository was read to learn verified behaviour of two sponsor tools. Everything below was rebuilt in new code and tested here.

- Zetaris REST request shape (`/api/v1.0/sql-editor/sqls/run`, headers, body), trailing-semicolon handling and truncation refusal: `src/federation/`.
- Nightshift request headers (`meterless-scope`, `meterless-ttfb-ms`), the Ed25519 receipt envelope layout and key-id derivation: `src/models/`.
- The visual identity (D-022): the Outfit and JetBrains Mono font files, copied unchanged with their SIL Open Font Licence texts into `ui/public/fonts/`. No desk. code, copy or screenshots are used.

## Third-party data

| Data | Licence or terms | Used in |
|---|---|---|
| openFDA 510(k), UDI and PMA endpoints | CC0 (`open.fda.gov/license`) | `data/cassettes/`, `data/silos/registry/` |
| FDA AI-enabled device list and 510(k) / De Novo summary PDFs | US government work; reuse terms NOT VERIFIED beyond that | `data/sources/`, `evals/heldout/raw/` |
| ClinicalTrials.gov API v2 | Public data; published terms NOT VERIFIED | `data/cassettes/` |
| PubMed and Europe PMC records | Metadata free; abstracts and full text carry per-publisher terms (NOT VERIFIED in detail). Only short quoted passages are stored. | `data/cassettes/` |
| deepset prompt-injection dataset | See `data/scout-corpus/external/NOTICE.md` | Scout evaluation only |
| Community `metadata.json` draft schema | Apache-2.0 | `research/community-metadata.schema.json` (local) |

Competitor material: Constat's anonymous endpoint was queried within its published terms for the same-input test; its raw responses and terms pages, and HealthIT.com's data dumps, are kept locally and are not republished. Only hashes and scored results are committed (`evals/gate0/`).

## Constructed data

Every vendor claim, hospital requirement and review database row is constructed for the test and labelled so in the data and on screen. No patient data exists anywhere in the repository. The hospital database is synthetic (`data/silos/hospital/`). No claim in the repository is a statement by a real vendor.

## AI assistance

The code, tests and documents were written with Claude Code (Anthropic) under the owner's direction, with subagents working on separate modules and the lead reviewing and committing their work. Model calls in the running product go to NVIDIA Nemotron models through the NVIDIA API and, where installed, Nightshift. Cursor was not used.
