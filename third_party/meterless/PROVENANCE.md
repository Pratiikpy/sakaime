# Provenance of the vendored Meterless engine references

These files are the sponsor's public reference material for four of the Meterless engines, copied without modification so that conformance results can be checked against a neutral baseline: **H-MEM** (`hmem/`) and **World Model** (`world-model/`) in full, and from **Markovian** (`markovian/`) and **Scout Intent** (`scout-intent/`) only the files that Sakaime's conformance tests execute (the Markovian conformance runner and the Scout Intent stock evaluation harness with its corpus). Sakaime's own implementations live in `src/engines/hmem`, `src/engines/world-model`, `src/engines/markovian` and `src/engines/scout`; nothing in those directories is copied from here (decision D-008, `docs/DECISIONS.md`).

- Upstream: https://github.com/Meterless/Meterless
- Pinned commit: `0aa7417ba5c826396d91e891328be78c45e6fbf6` (committed 2026-07-22T23:14:36Z)
- Licence: Apache-2.0, `Copyright 2026 Meterless` (`LICENSE`, and the per-engine copies)
- Vendored on: 2026-10-27

## How the pin was checked

1. The upstream tree at `0aa7417` was listed with the GitHub API on 2026-10-27, and the git blob SHA-1 of every vendored file (after line-ending normalisation to LF, which is what git stores) was compared with the blob SHA-1 of the same path upstream. All files in the table below show `match`; the root `LICENSE` is the one file taken from the repository root and is also unchanged.
2. Upstream moved on after the pinned commit (HEAD was `1742dec`, 2026-10-19). Between `0aa7417` and `1742dec` only Markdown files differ in `engines/hmem` and `engines/world-model`; every non-Markdown file (runners, vectors, reference sources, tests, configuration) has the identical blob SHA at both commits. The `AGENTS.md` specification and the `docs/` pages vendored here are the `0aa7417` versions and differ from `1742dec`; which version of the prose governs is not established here (NOT VERIFIED), and the executable behaviour (the runners and vectors) is identical in both.
3. `AGENTS.md` is stored as `AGENTS.md.sponsor-copy` so that agent tooling does not read the sponsor's instructions as this project's instructions. The bytes are unchanged.

## What is vendored and what is not

Vendored for H-MEM and World Model: the specification (`AGENTS.md.sponsor-copy`), the conformance runner and vectors, the reference sources, the reference's own smoke tests, its package and compiler configuration, the idempotency script for World Model, and the `docs/` pages of each engine.

Vendored for Markovian: the engine licence, the conformance README and the conformance runner (`markovian/conformance/runner.ts`). The runner imports only Node built-ins when `MARKOVIAN_IMPL` names an implementation, so none of the Markovian reference sources are needed to run it against Sakaime's engine (without `MARKOVIAN_IMPL` it would look for `../reference/src/index.ts`, which is not vendored).

Vendored for Scout Intent: the engine licence and the stock evaluation harness under `scout-intent/evals/` (runner, thresholds, intent fixtures and the six regression-set files, 32 examples). The harness writes its report next to itself, so `tests/engines/scout/stock.test.ts` copies it into `node_modules/.cache` before running it. It imports the `yaml` package, which is a dependency of this repository.

Not vendored: images, marketing content, workshops, examples, the control-plane HTML, lock files, the Markovian and Scout Intent specifications, documentation pages and reference sources, and the generated `evals/reports/` files of Scout Intent.

## Markovian and Scout Intent files, added later

The 15 `markovian/` and `scout-intent/` rows below were added after the first vendoring. Their upstream blob SHA-1 values were checked on 2026-10-27 against the GitHub git tree API for `0aa7417ba5c826396d91e891328be78c45e6fbf6` (`GET /repos/Meterless/Meterless/git/trees/0aa7417ba5c826396d91e891328be78c45e6fbf6?recursive=1`), not against a local clone: the local study clone has no git history, and it renames the `AGENTS.md` specifications to `*.sponsor-copy`. All 15 match. The files were copied from that clone with LF line endings. Against upstream HEAD `1742dec56a66` (checked the same way) 13 of the 15 are byte-identical, including the Markovian runner and the Scout Intent runner, thresholds and corpus; only the two README files (`markovian/conformance/README.md`, `scout-intent/evals/README.md`) differ, as prose.

## Per-file record

SHA-256 is taken over the LF-normalised content so that it is reproducible from any checkout regardless of line-ending settings. `tests/engines/vendor-integrity.test.ts` recomputes every row and fails if a vendored file has changed.

| Vendored path | Upstream path | Blob SHA-1 (12) | SHA-256 | Upstream blob |
|---|---|---|---|---|
| `LICENSE` | `LICENSE` | d1a6bb88af6e | 63e29fc8231b53757a77fbc371071c91d768621efa1e68b1d9ff8d1bb7c4a0ef | root LICENSE of the upstream repository |
| `hmem/AGENTS.md.sponsor-copy` | `engines/hmem/AGENTS.md` | 6ea1d92a1bdc | a9f1d4356dca42259eed5212ab091f1195b6f98040afe58e36968c93b21a2a9a | match |
| `hmem/LICENSE` | `engines/hmem/LICENSE` | d1a6bb88af6e | 63e29fc8231b53757a77fbc371071c91d768621efa1e68b1d9ff8d1bb7c4a0ef | match |
| `hmem/conformance/README.md` | `engines/hmem/conformance/README.md` | fb5bb7c440ee | cf44fd4d3c9a8af0c46157bb015dead8d4ccb2d000c2358e7da1e4cecfbc4c39 | match |
| `hmem/conformance/runner.ts` | `engines/hmem/conformance/runner.ts` | dab4c66cac7d | d6724860761c4846a0bce3080d25115bcb0ba1d9d0d2e933438f5683a7a9b7c5 | match |
| `hmem/conformance/vectors/vectors.json` | `engines/hmem/conformance/vectors/vectors.json` | 776b6b6e808e | 10afb5a07233466576ba6feb0d88408488909ba2721ee9157fdb932132917029 | match |
| `hmem/docs/README.md` | `engines/hmem/docs/README.md` | badc21ba0d5c | 4accec909974857108f9012a58f22bbe7c5825f524ba76e0e32849cb5e73a2d5 | match |
| `hmem/docs/architecture.md` | `engines/hmem/docs/architecture.md` | c0f9ea532c38 | d18825d66085ad36c45a0a0472e01aa961efc5059ba26079944b1d3696b8de49 | match |
| `hmem/docs/conflict-resolution.md` | `engines/hmem/docs/conflict-resolution.md` | 9050d12bd17f | b3f2717d7788b2c8941ff78a0ac885b38a4750fa303ee3ab12ed9d0ad777972a | match |
| `hmem/docs/dreaming.md` | `engines/hmem/docs/dreaming.md` | d82f80dbea11 | 91cc4a8f019eba97857c6d0f59ddcb74cc546f972e45e7b0ec1767a25a024443 | match |
| `hmem/docs/how-to-use.md` | `engines/hmem/docs/how-to-use.md` | 687cfe9b1ac9 | dc5a8320e0445b71fc439026ec4a26214607f84afdd20e3d1ffb5a2118a5ba36 | match |
| `hmem/docs/memory-record.md` | `engines/hmem/docs/memory-record.md` | 4944b8e09d3b | f2eb034c16ffcb175218388084ba17f992159ae60e9fc4d455284efbc9d6f9a1 | match |
| `hmem/docs/mining-pipeline.md` | `engines/hmem/docs/mining-pipeline.md` | 1b7c96767940 | b23a57e8f49b5438bc12fe55f3b986cbc5420bb7c8239fd760fecd0aaa17ce79 | match |
| `hmem/docs/practical-how-to.md` | `engines/hmem/docs/practical-how-to.md` | 28425b2b20e0 | c1ee37fcf0653815bbdaaf0b2925398dfbef48468e9cce32ab5ac0b68c5706ba | match |
| `hmem/docs/preview-first-sleep-cycle.md` | `engines/hmem/docs/preview-first-sleep-cycle.md` | d7f2fcfb0cfc | c12eea9126928e3cfcdfb2ea814382a184b15db05a5863c0226261d0fe0d81e3 | match |
| `hmem/docs/privacy-and-local-first.md` | `engines/hmem/docs/privacy-and-local-first.md` | b893d218fc71 | a3cc35f4483db4165fcde45d2d10f31ee5b2293a0e8994b2720315c18c0abfa6 | match |
| `hmem/docs/reinjection.md` | `engines/hmem/docs/reinjection.md` | 05668157c635 | 0c5c31d5692b5258be21741eb48fd79cb159a7355321cb6e8a5914dac769f84d | match |
| `hmem/docs/retrieval-ranking.md` | `engines/hmem/docs/retrieval-ranking.md` | a6fd039a7e43 | 6f8e883869c75cfb83e227b45abedf2fe142ba4297cddf20b5bea62567b383d3 | match |
| `hmem/docs/sleep-cycle.md` | `engines/hmem/docs/sleep-cycle.md` | bbdf793f82a5 | 4286a88dec5664b8cd7701e885733f0e20dd78b2d8f3fa9a0c2841c01296c09e | match |
| `hmem/docs/tiered-storage.md` | `engines/hmem/docs/tiered-storage.md` | 0bd4f95fa6b1 | fd31c1a1dfe1c8ecb50b0e2da058d48ed8ab9dec03749121c076ed45dde88f7f | match |
| `hmem/docs/trust-ledger.md` | `engines/hmem/docs/trust-ledger.md` | 19d9a0a75ce4 | dc1db8967e71f0414585855def77a1f6c988d0fdff8c8e5399b2e5a38c8f65c0 | match |
| `hmem/reference/README.md` | `engines/hmem/reference/README.md` | 60b8c6c14d3a | ab3a50c274aace1e9d05e60b01598f531b3da80f966275c437aa871b7b71c775 | match |
| `hmem/reference/package.json` | `engines/hmem/reference/package.json` | b9f971137fa4 | 982b032b671667f6c3c2f857ab0791a8f78f9574957410dcd1d0a65119cde18d | match |
| `hmem/reference/src/conflictDetection.ts` | `engines/hmem/reference/src/conflictDetection.ts` | 2d444ecb901f | 432e8b86ed0b5883d435e5ab4a12160d1f40d194cbdb4c119d3b710cbb0301a3 | match |
| `hmem/reference/src/dreaming.ts` | `engines/hmem/reference/src/dreaming.ts` | e2c1dd041746 | d12594d667ec068690c6b81e020cd62ade91671316a1ab9b529259304aceb009 | match |
| `hmem/reference/src/embeddings.ts` | `engines/hmem/reference/src/embeddings.ts` | e9e6ae7f2adb | 89433327ee1075a8049bc8518cdf5cabf51ad67802e192266841cdee727b6d10 | match |
| `hmem/reference/src/index.ts` | `engines/hmem/reference/src/index.ts` | 7f20562365b4 | 9c481889afcdd70086d3bb3470842fa2330215e4d7760d826d103accdf8c1cdf | match |
| `hmem/reference/src/memoryMining.ts` | `engines/hmem/reference/src/memoryMining.ts` | a3d27743c667 | 6072693d654ea1c34a9adbf6ce80101eeb1eeb56273d264f6ceb4859ffde6562 | match |
| `hmem/reference/src/memoryRetrieval.ts` | `engines/hmem/reference/src/memoryRetrieval.ts` | 5c1b924806c2 | 4fe120b1b64fe7225b9b28fda59514c114de9e885d22c5bf0aa035788b6d629d | match |
| `hmem/reference/src/memoryStore.ts` | `engines/hmem/reference/src/memoryStore.ts` | 92c49358c174 | a1eac8de8c0fde0e503e1212f3cb98295a661c2a8bad93ad82e51985885e6fd0 | match |
| `hmem/reference/src/sleepCycle.ts` | `engines/hmem/reference/src/sleepCycle.ts` | 6d651535d5eb | 3ce0d4f3233d0ad7c133a2cbaf39b6122467022e0aa378a160a0d463e2264cef | match |
| `hmem/reference/src/trustLedger.ts` | `engines/hmem/reference/src/trustLedger.ts` | 716880f548bf | 263253dd3342c488ce773d7e728d77aec983c1833873602b59ce1a6c7999e20e | match |
| `hmem/reference/src/types.ts` | `engines/hmem/reference/src/types.ts` | de7838f2dceb | becb504870a67646a20a421ffe04d8732db63418393423d2186c074b182f54c7 | match |
| `hmem/reference/test/smoke.test.ts` | `engines/hmem/reference/test/smoke.test.ts` | 45bd9af7f602 | 84e09fb08eb769b19488d68f0303c2a9ab275f37e80e986438f0099cd7c98824 | match |
| `hmem/reference/tsconfig.json` | `engines/hmem/reference/tsconfig.json` | 204dd19fc04d | a0e236840f54f788dec6c2a56a84b7cd737bac932848fd8808dc20f94e49d4d4 | match |
| `world-model/AGENTS.md.sponsor-copy` | `engines/world-model/AGENTS.md` | b4c04f36817f | 6732ee2067e983be4a5f468e827dd24c4b669646b8dd006e3c75825e33f2da3b | match |
| `world-model/LICENSE` | `engines/world-model/LICENSE` | d1a6bb88af6e | 63e29fc8231b53757a77fbc371071c91d768621efa1e68b1d9ff8d1bb7c4a0ef | match |
| `world-model/conformance/README.md` | `engines/world-model/conformance/README.md` | 05e300a94556 | 23e3cdcf3eab2967e9a7a671feb938d73834303ae0e8c25db915d039b1e012d2 | match |
| `world-model/conformance/runner.ts` | `engines/world-model/conformance/runner.ts` | d4e26f7901b8 | 7cd3b80d62d45d16f3342c62a91c89abf819c9b46970187d2f36fb9e3050da82 | match |
| `world-model/docs/aggregate-shapes.md` | `engines/world-model/docs/aggregate-shapes.md` | 445b5207ab9a | 995bc9a71d78573eb7df643eb3bad397353ea5220c9a9ce001fb36ff2bd8857e | match |
| `world-model/docs/architecture.md` | `engines/world-model/docs/architecture.md` | 8f6508da56d6 | d3d81202fd3227d1f3c35fb392c8652f401eed23dcf6a74cfbd96b08fc49b89a | match |
| `world-model/docs/concurrency-and-queues.md` | `engines/world-model/docs/concurrency-and-queues.md` | 7025dd0bad97 | 00f0fecd852f8ee9dcfbc4cca5638bb69bb37feac77b950dc9e4b3179021342d | match |
| `world-model/docs/entity-context-relationship-model.md` | `engines/world-model/docs/entity-context-relationship-model.md` | 3b0518d6c6ac | eb37488c4f1612c9f4f5c475d2a2d87c9fdbb25eb7df96a20d2160dee67f0952 | match |
| `world-model/docs/ingest-pipeline.md` | `engines/world-model/docs/ingest-pipeline.md` | 712b9d73eb5e | fe2f36b8541477f6ad3faaab4c2b4aee356df583074fad50b2b930f1f6d9bc5e | match |
| `world-model/docs/operator-control-plane.md` | `engines/world-model/docs/operator-control-plane.md` | 07364c0f480e | d62b8ffd797634f3bbbb201f4489162ce0ba7209ff085fc64c6d0f02519a5851 | match |
| `world-model/docs/read-surface.md` | `engines/world-model/docs/read-surface.md` | ea321a4c5aba | 618be6133e6cadce8090dcf09a78136ad8948fff387d903429ae7657448569c2 | match |
| `world-model/docs/stable-ids.md` | `engines/world-model/docs/stable-ids.md` | 993a520a4dd7 | 4eb5b26d9d4b311332f88695ce62ea2396317e7fc280f8cae28ff74eb26cc95e | match |
| `world-model/docs/trade-offs.md` | `engines/world-model/docs/trade-offs.md` | 156e5d5b1356 | c817f4bd7e66604d8fffada070756412d8ea5c377a4367e80c499610c890b492 | match |
| `world-model/reference/README.md` | `engines/world-model/reference/README.md` | c7badc57b5af | da891f94d28b5900d4ec87a412782b61be2401931670334546cae1974f3004fb | match |
| `world-model/reference/package.json` | `engines/world-model/reference/package.json` | fa66ea683aea | 22b0a13e94e2d43759a3b1aa09e592e3266c6d43c5d2c506c4944ed9313f3276 | match |
| `world-model/reference/scripts/idempotency-check.ts` | `engines/world-model/reference/scripts/idempotency-check.ts` | f2305fda72b3 | 541d6970cf9b59b246c1d17b69814cd8efbd29d4ef03c5ba775befeef62750ac | match |
| `world-model/reference/src/index.ts` | `engines/world-model/reference/src/index.ts` | ce5d69410f5b | 6e543a0be45fca9ff323fdb1a8bcd73e64ebf2b443c4b7a623cd70da33ec205d | match |
| `world-model/reference/src/ingest.ts` | `engines/world-model/reference/src/ingest.ts` | 7e8c5283625d | b99ee2957c2c2b42288a86ce2acaae20c8052a97e2985569802140d95969dc03 | match |
| `world-model/reference/src/resolve.ts` | `engines/world-model/reference/src/resolve.ts` | 449cb73118c1 | 3fd81d2a53a39684adafb0b3e538b1fb3952be75b229b65cc755c70a0dd4fae4 | match |
| `world-model/reference/src/stableIds.ts` | `engines/world-model/reference/src/stableIds.ts` | ad7efafd69f8 | 6dd81234f337ebdb7c00314aaf63482a47f19382b40c624bc57df8ba6bb88513 | match |
| `world-model/reference/src/store.ts` | `engines/world-model/reference/src/store.ts` | eb9c772a2787 | 2cfa6897003c22f1e2ac88e5ecf8347f653a25af7ca5842aa7042a1cc731d032 | match |
| `world-model/reference/src/types.ts` | `engines/world-model/reference/src/types.ts` | dddd28615703 | 4e31a8cf4de6d4b46b09659ada879be46ca8a97f25ee05f583eaa0010ddd1528 | match |
| `world-model/reference/test/smoke.test.ts` | `engines/world-model/reference/test/smoke.test.ts` | 1c86e88cfd32 | 73398749d408647798849adafc76e9acd37efe50bcbd760b0c4d0d24d1bc092a | match |
| `world-model/reference/tsconfig.json` | `engines/world-model/reference/tsconfig.json` | e128372a3493 | dc5d553c157c5425f4cf70970d7910be3774bfc1a5e8c33e4edae5b17407ecb0 | match |
| `markovian/LICENSE` | `engines/markovian/LICENSE` | d1a6bb88af6e | 63e29fc8231b53757a77fbc371071c91d768621efa1e68b1d9ff8d1bb7c4a0ef | match |
| `markovian/conformance/README.md` | `engines/markovian/conformance/README.md` | c30c9ba27b42 | b7622eeed0922d812e196c66b14cd7c0acd57e3af6e46eb3696eccf223ee8be8 | match |
| `markovian/conformance/runner.ts` | `engines/markovian/conformance/runner.ts` | 0d0befbb30e7 | 03a17106ba0feba1ad0e4a18399577851e0810720ab79eb51c85b80e49865f31 | match |
| `scout-intent/LICENSE` | `engines/scout-intent/LICENSE` | d1a6bb88af6e | 63e29fc8231b53757a77fbc371071c91d768621efa1e68b1d9ff8d1bb7c4a0ef | match |
| `scout-intent/evals/README.md` | `engines/scout-intent/evals/README.md` | 827a6a86eaa7 | 6a9258bb1b11003f2c9f5f92dd50cebe165528c95174c230ca70debccb43e7cc | match |
| `scout-intent/evals/config/thresholds.yaml` | `engines/scout-intent/evals/config/thresholds.yaml` | c7fb307c2681 | f49b4db850298c9a2fa7fc258af7d968fb6ecdda97e6d12d7fb32c5c61ede02d | match |
| `scout-intent/evals/fixtures/intents.json` | `engines/scout-intent/evals/fixtures/intents.json` | d7c8cab620d3 | 942c4b443807b42e7cada57f68d5895624a49b446ec94ceafe8d02aa9860c5b8 | match |
| `scout-intent/evals/regression-set/v1/edge-cases/clarification.jsonl` | `engines/scout-intent/evals/regression-set/v1/edge-cases/clarification.jsonl` | 4ed9b2a2682b | 066600ca7301e075aada79bb5d4c28b36ae61ec02d09c70ba6b55458c9523ff9 | match |
| `scout-intent/evals/regression-set/v1/injection/adversarial.jsonl` | `engines/scout-intent/evals/regression-set/v1/injection/adversarial.jsonl` | ca3dc0af2af9 | 141f1db3a42ac3e42c78edd014863d5561cb0931e792954c16fb3a545eeb663e | match |
| `scout-intent/evals/regression-set/v1/intents/deal.jsonl` | `engines/scout-intent/evals/regression-set/v1/intents/deal.jsonl` | 95f655269e2b | 0be4860dadf5f6433ad5faaa0db33e147b56a28afd724f84095a6b6055a0b83c | match |
| `scout-intent/evals/regression-set/v1/intents/email.jsonl` | `engines/scout-intent/evals/regression-set/v1/intents/email.jsonl` | 81e05f103018 | 57d7c83e67460b7374161dfca9598357da344eb25ee51470614cbffb527016e7 | match |
| `scout-intent/evals/regression-set/v1/intents/research-and-plan.jsonl` | `engines/scout-intent/evals/regression-set/v1/intents/research-and-plan.jsonl` | 55d132bfa939 | db769f5166ec1624e784fd37a876e48e74b85691e59707d46bb17088f9bc7c26 | match |
| `scout-intent/evals/regression-set/v1/multi-intent/composed.jsonl` | `engines/scout-intent/evals/regression-set/v1/multi-intent/composed.jsonl` | 3e04f9f1bcb7 | d72474787b56de775b1a02a0259a326f37a1345e2897ac515a6fe8ce684ea3c5 | match |
| `scout-intent/evals/runner/add.ts` | `engines/scout-intent/evals/runner/add.ts` | 8b33628c3e58 | 431700f1738f204e60c0486e85c4b3b607dcd25fe3bb232404b69f94d338e4c7 | match |
| `scout-intent/evals/runner/index.ts` | `engines/scout-intent/evals/runner/index.ts` | 779dec70f3d6 | e2454b6e308e0458fb5b02862ef1cf78ceac69b04ab3b02554b250bf34097ba0 | match |

## Baseline results of the unmodified references (2026-10-27, Node v24.20.0, tsx)

| Check | Result |
|---|---|
| `HMEM_IMPL` unset, `hmem/conformance/runner.ts` against `hmem/reference/src/index.ts` | 13/13 checks passed, exit 0 |
| `WORLD_MODEL_IMPL` unset, `world-model/conformance/runner.ts` against `world-model/reference/src/index.ts` | 8/8 checks passed, exit 0 |
| `hmem/reference/test/smoke.test.ts` (vitest 3.2.7) | 10/10 tests passed |
| `world-model/reference/test/smoke.test.ts` (vitest 3.2.7) | 10/10 tests passed |

Reproduce from the repository root:

```
npx tsx third_party/meterless/hmem/conformance/runner.ts
npx tsx third_party/meterless/world-model/conformance/runner.ts
```

These are the reference implementations' own results. They are not results for Sakaime's engines; those are reported separately by `tests/engines/hmem/conformance.test.ts` and `tests/engines/world-model/conformance.test.ts`.
