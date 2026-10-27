# Provenance of the vendored OpenLineage specification

`OpenLineage.json` is the JSON Schema of the OpenLineage core specification, version 2-0-2 (its `$id` is `https://openlineage.io/spec/2-0-2/OpenLineage.json`), copied without modification. `tests/dossier/lineage.test.ts` validates every run event the dossier emits against it, so that the lineage claim is checked against the published schema and not against a copy written for this project.

- Upstream: https://github.com/OpenLineage/OpenLineage, path `spec/OpenLineage.json`
- Licence: Apache-2.0 (`LICENSE` is the upstream root licence file, unchanged)
- Last upstream change to the file: commit `a81dabd91ef52d08803394842f56bf9985094e32`, 2023-07-26. The file was identical at upstream `main` (`ff6c73647044544c8614eaae9ab61918727a26c1`, 2026-10-27), checked with the GitHub contents API on 2026-10-27.
- Vendored on: 2026-10-27

Hashes are over the LF-normalised content, which is what git stores and what the upstream blob SHA-1 refers to. `tests/dossier/lineage.test.ts` recomputes them.

| File | Upstream path | Blob SHA-1 | SHA-256 |
|---|---|---|---|
| `OpenLineage.json` | `spec/OpenLineage.json` | 58167f71407add7734810cda9943b39b83c89aa2 | 69f68bee00b9beac88a87059c0102410e7bb05f3f43c46d02a0409831eceb0d2 |
| `LICENSE` | `LICENSE` | 261eeb9e9f8b2b4b0d119366dda99c6fd7d35c64 | c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4 |

Only the core schema is vendored. The facet schemas under `spec/facets/` are not: the dossier's own facets are custom `sakaime_` facets, defined by the Zod schemas in `src/dossier/lineage.ts` and checked against those.
