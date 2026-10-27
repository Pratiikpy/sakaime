# Sakaime silos

Three kinds of source, built so that a federated query has real fragmentation to work across: a relational database, a
set of file snapshots of public registries, and file exports from vendor packets. `infra/zetaris` loads them into a
local Zetaris stack; `infra/zetaris/scripts/oracle.mjs` reads the same files with DuckDB as an independent check.

| Directory | Silo | Zetaris source | Real or constructed |
|---|---|---|---|
| `hospital/` | Hospital review database (vendors, requirements, submissions, cases, case_assignments, decisions, precedents, reviewers, evidence_links) | JDBC datasource `hospital` (Postgres) | **Constructed.** Every row carries `provenance = CONSTRUCTED`; a constraint rejects any other value. No patient data, no real hospital policy. |
| `registry/` | openFDA 510(k), UDI and classification records; ClinicalTrials.gov studies; PubMed articles | file-store tables in `sk_registry` | **Real records**, recorded 2026-10-27 and flattened to one line per record by `build/normalise-registry.mjs`. Every row keeps the hash of the file it came from. |
| `vendor_packets/` | Vendor packet exports (packets and claims) | file-store tables in `sk_vendor` | **Constructed.** Illustrative text written for testing. It was not issued by the named companies and says nothing about their real claims. The columns `confidential_unit_price_usd` and `confidential_reference_site` exist so that column policies have something to protect. |
| `documents/fda_summaries/` | Three FDA summary PDFs (K200667, DEN180001, K253265) | PDF file-store table `sk_docs.fda_summaries` | **Real** public FDA documents; hashes match `research/feasibility/fixtures/MANIFEST.md`. |
| `rest/` | Recorded openFDA and ClinicalTrials.gov JSON responses with nested arrays | REST tables in `sk_rest`, served by the `rest-silo` container | **Real** recorded responses. |

## The EyeArt case

The one authentic chain used by the headline join: FDA 510(k) K200667 (EyeArt, Eyenuk, cleared 2020-08-03) cites
ClinicalTrials.gov NCT03112005 in section D.1 of its summary; PubMed 34779843 reports that study, names EyeArt software
version 2.1.0 and adults aged 18 and over at 15 primary-care and eye-care sites; the openFDA UDI record lists version
2.1.0. The constructed packet `PKT-EA-01` then claims things the chain does not support: use below age 18, an emergency
department setting, software version 3.0, any camera, and diagnosis rather than detection. Two hospital cases are
defined for the same submission, one inside the authorized setting (`CASE-2026-014`, primary care) and one outside it
(`CASE-2026-021`, emergency department).

## Rebuilding the registry files

```
node data/silos/build/normalise-registry.mjs [fixtures-dir]
```

The default fixtures directory is `research/feasibility/fixtures` (local only). The script rewrites `registry/*.csv` and
`registry/MANIFEST.json`, which lists the hash of every source file and every output.

## Known data quirks

- `Viz.Al, Inc.` and the mangled `MammoScreen` device name are as openFDA returned them.
- 143 of the 157 ClinicalTrials.gov rows come from search summaries and have no eligibility block, so `minimum_age_years`
  is empty. Unknown is kept as empty, never as zero; the data-quality rule `has_eligibility` rejects those rows.
