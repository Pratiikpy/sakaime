# Sakaime

**Know where the evidence stops.**

Sakaime (境目, "the boundary line") is an applicability-aware evidence intelligence system. A claim can be true and still be wrong for you. Given a vendor claim about a clinical AI product and the exact use a hospital has in mind (product version, population, setting, purpose, date), Sakaime discovers evidence scattered across regulators, trial registries, literature, the vendor's own packet and the hospital's own requirements, works out which records describe the same product, study and version, and reports only as much as the evidence supports: what is supported, what is supported only for a narrower scope, what is contradicted, what is insufficient, and what needs a human expert. It shows the smallest mismatch, says what document would settle each unknown, and lets the reviewer change the intended use and watch the conclusion change.

It never certifies safety, compliance or procurement. Its labels describe evidence coverage only.

Built for the Open Agent Hackathon 2026, Track 1 (Solving Fragmented Intelligence), on Zetaris (federation), Meterless (engines and Nightshift) and NVIDIA Nemotron.

## Status

Design stage. No application code is published yet, and nothing in this repository is a measured result. The design documents are in [`docs/`](docs/00-INDEX.md); start with the product requirements ([`docs/01-prd.md`](docs/01-prd.md)) and the architecture ([`docs/02-architecture.md`](docs/02-architecture.md)). Hypotheses, unverified claims and open gates are marked as such throughout, and the build follows the gates in [`docs/08-build-plan.md`](docs/08-build-plan.md).

## What is deliberately not claimed

- No clinical or independent validation: no independent reviewer has yet taken part.
- No evidence of demand: no buyer has been interviewed.
- No superiority over existing products: a same-input comparison is planned and not yet run.
- All vendor claims used in demonstrations are constructed and labelled as such; public records are real.

## Licence

Apache-2.0. See [`LICENSE`](LICENSE).
