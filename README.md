# Sakaime

**Know where the evidence stops.**

Sakaime (境目, "the boundary line") checks whether the evidence behind a claim covers the exact use a buyer has in mind. A claim can be true and still be wrong for you: a sensitivity figure measured on version 2.1.0, in adults over 22, in primary care, says nothing certain about version 3.0 in an emergency department.

The first use case is a hospital team reviewing a medical-AI vendor's claim. The evidence sits in separate places that do not share identifiers: the regulator's decision summary, the trial registry, the journal article, the vendor's packet and the hospital's own requirements. Sakaime discovers and joins those sources, works out which records describe the same product, study and version, and returns only as broad a conclusion as the evidence permits. It shows the smallest mismatch, the exact passage behind it, and the document that would settle each unknown.

Built for Track 1 of the Open Agent Hackathon 2026, *Solving Fragmented Intelligence*. Licence: Apache-2.0.

**Start here:** [full judge brief on Notion](https://congruous-neighbor-289.notion.site/Sakaime-Brief-for-Users-Judges-Research-PMF-406dfbac05cc81a581a6fa814d08e9e7) (problem, product, every result and every limit) · [demo video, 3:55](https://drive.google.com/file/d/1jXCCANnrG8X17-oGdmd8syNWivGx3llX/view) · [pitch deck (PDF)](docs/submission/sakaime-deck.pdf)

## What it will never say

Every finding carries exactly one of five labels. They describe what the evidence covers; they are not a safety rating.

| Label | Meaning |
|---|---|
| `SUPPORTED_FOR_SCOPE` | The evidence covers every dimension of the stated use. |
| `SUPPORTED_ONLY_FOR_NARROWER_SCOPE` | It covers a narrower use, which the finding states. |
| `CONTRADICTED_BY_SPECIFIED_EVIDENCE` | Relevant, adequate evidence points the other way. |
| `INSUFFICIENT_EVIDENCE` | A required piece is missing, unreadable or unavailable. |
| `REQUIRES_DOMAIN_REVIEW` | The rule needs clinical judgement the code refuses to make. |

There is no "safe", "cleared" or "compliant" output. Unknown is never treated as false and never as safe. A source that was down is never reported as a source that had nothing to say. Sakaime does not decide whether a product should be deployed.

## Try it (no keys, no Docker)

Requirements: Node 22.19 or newer.

```
git clone https://github.com/Pratiikpy/sakaime.git
cd sakaime
npm ci
npm run judge
```

`npm run judge` replays the recorded run offline. It re-verifies the signed dossier hashes, re-runs the compiler on the recorded evidence, replays the source-failure drills and prints PASS or FAIL for each claim. It needs no key and finishes in a few seconds. `npm test` also runs offline; the browser tests (`npm run ui:test`) need `npx playwright install chromium` or an installed Google Chrome.

To use the product:

```
cp .env.example .env        # SAMPLE_MODE=true is the default there
npm run ui:build
npm run serve               # http://127.0.0.1:8787
```

In sample mode every external read is replayed from recordings made against the real services on 2026-10-27: public sources, the Zetaris engine and the Nemotron models. The compiler, identity scorer, verifiers and guard run for real on those recorded inputs. A question with no recording abstains visibly; it never invents an answer. The banner at the top of every screen states which mode is active.

### What to look at first

1. **Review desk**: open the EyeArt case. The packet holds ten constructed vendor claims. One is supported, three are supported only for a narrower use, one is contradicted, and the rest need more evidence or a domain review.
2. **Claim X-ray**: each dimension (product, version, population, setting, purpose, date, metric) shown claimed against established, with the exact passage, its page, its source and its retrieval date.
3. **Applicability lab**: change the version, age range, setting or date and watch the label recompute. No model is called.
4. **Resilience**: run a drill that stops a source, stops the federation engine, truncates a result or injects an instruction into a vendor document. A lost required source never turns a claim into a supported one.
5. **Sources**: add a source from a description and a URL and watch the eight onboarding stages; an address inside a network or at cloud metadata is refused at stage one. In sample mode the allowed example is read from a recording and stops before registration (the object store is configured only in live mode), and the checks against held records are replayed only for recorded statements. The unit and meaning-change catches are measured in DiscoveryShift, above.
6. **Dossier**: export the signed bundle, change one character and watch the verifier name the failing item.

## How it works

```
reviewer question and intended use
  L0  Scout guard            intent, injection quarantine, signed export contracts
  L1  Source discovery       allowlist, SSRF-safe fetch, probe, schema fingerprint, semantic validation, review, registration
  L2  Zetaris federation     one SQL over Postgres, registry snapshots and vendor files; policies; Unified Semantic Layer
  L3  Identity resolution    typed links (same submission, same version, study evaluates ...); uncertain links stay uncertain
  L4  Extraction             anchored PDF and API parsing; quote-exists check separate from semantic support
  L5  Evidence memory        bi-temporal World Model, H-MEM for confirmed links and precedents
  L6  Applicability compiler per-dimension containment, label table, minimal counterexample, counterfactuals
  L7  Investigation loop     bounded roles: planner, retriever, resolver, extractor, critic, reporter
  L8  Dossier                signed bundle, offline verifier, lineage events, reviewer decisions
```

Code owns calculations, labels and checks. Nemotron proposes (mappings, extractions in ambiguous passages, objections, prose). A model proposal never becomes a fact until a deterministic check or a reviewer accepts it. The design is in [`docs/`](docs/00-INDEX.md); the decisions are in [`docs/DECISIONS.md`](docs/DECISIONS.md).

### Sponsor technology and where it does real work

| Sponsor | What it does here | Code | Evidence |
|---|---|---|---|
| **Zetaris** | Federates three silo types in one statement; discovers sources from its catalog; a Unified Semantic Layer queried as a read-only identity; a completeness data-quality rule; masking for reviewers not assigned to a case | `src/federation/`, `src/discovery/`, `infra/zetaris/` | `infra/zetaris/GATES.md`, on a real 2.4.3.1 stack: Z-HEAD, Z-REST, Z-POL (two defects found), Z-CAT, Z-AUD (with limits), Z-TT, Z-USL, Z-PDF and the kill drill pass; Z-NL (natural-language-to-SQL) is blocked in this build |
| **Meterless** | H-MEM keeps confirmed links, accepted mappings and precedents; the World Model reconstructs history and marks exactly the dependent findings stale; Markovian reads long documents; Scout Intent guards every request and signs export contracts | `src/engines/`, `third_party/meterless/` | Sponsor conformance runners pass: H-MEM 13/13, World Model 8/8, Markovian 8/8; ablations in `tests/engines/ABLATIONS.md` |
| **NVIDIA Nemotron**, through **Nightshift** | Planner, discoverer, resolver, extractor second opinion, critic and reporter roles; Lightning 30B for volume, Ultra 550B for the critic. Nightshift is the primary route: every reply of the committed sample run was answered through the installed Nightshift 1.2.3 and carries its signed compute receipt, re-verified at start-up against the pinned key id (61 of 61); NVIDIA's API answers only if Nightshift is unreachable or a receipt fails, and the reply is then labelled `nvidia` and unreceipted | `src/models/` | Role map in `src/models/roles.ts`; recorded replies and receipts in `data/model-cassettes/`; route summary in `output_examples/model-route.json` |

Cursor is optional for this hackathon and was not used.

In sample mode the model roles can only answer from recordings; a role with no recording falls back to rules and templates and the investigation trace says so for each step ("no recording for role ..."). Check the trace of the case you open to see which roles had a recorded reply.

## Measured results

Every number below comes from a results file under [`evals/results/`](evals/results/); the full report, with intervals and the list of what was not run, is [`evals/RESULTS.md`](evals/RESULTS.md). **Read the class of each result.** *Consistency* tests compare the code with the rule table its authors wrote; they show the code does what the table says and nothing about whether the table is clinically right. *Builder-labelled* results are scored against answers one person wrote from the source documents. No clinician and no independent reviewer has read any of it.

| Suite | Result | Class |
|---|---|---|
| ScopeShift A, 222 controlled single-change counterfactuals over 18 FDA summaries | 218 exact (98.2%); 24 of 24 positive controls; 0 of 198 unsupported cases labelled supported | consistency |
| ScopeShift B, 26 development claims, full pipeline | exact 9 of 26; 0 of 17 unsupported claims labelled supported; 9 of 9 well-supported claims **not** labelled supported | builder-labelled |
| ScopeShift B, 20 sealed held-out claims, full pipeline | exact 9 of 20; 0 of 15 unsupported labelled supported; 4 of 5 well-supported flagged. A second look, not a blind test (see errata) | builder-labelled |
| Same claims, one Nemotron call with all records in the prompt | held-out exact 63% (mean of 3); 22% of unsupported claims labelled supported | builder-labelled |
| Same claims, tool-using Nemotron agent without the compiler | held-out exact 60%; 3 of 15 unsupported labelled supported | builder-labelled |
| Competitors on the same inputs | Neither Constat nor HealthIT.com emits a verdict on a claim. A reviewer could re-derive the key from Constat's output for 7 of 26 claims and from HealthIT's for 0 of 26 | builder-labelled |
| IdentityShift, 14 device families held out in turn | 0 of 60 false merges (a fuzzy-name baseline: 23 of 60); precision 48 of 48; recall 0.77 | development set, one reader |
| DiscoveryShift, 102 mutated source layouts (100 scored, 2 known limits) from four base tables | First run on the sealed suite: 39 of 48 mappable layouts mapped, 44 of 44 must-not-register layouts caught. Second run, after fixes made against the same cases: 48 of 48 and 44 of 44. A hardcoded loader: 22 of 48 and 12 of 44 | builder-labelled |
| TimeShift | 27 of 27 cases: the stale set equals the dependent set | consistency |
| FailureShift | 157 of 157 drills end in the correct state, including stopping the real Zetaris API container | consistency |

**What this says plainly.** Sakaime does not label an unsupported claim as supported in any set. Keyword and source-by-source baselines do so for 53% to 77% of them, and generic Nemotron arms for 20% to 39%. In exchange, Sakaime is conservative: on the development set it supports none of the nine well-supported claims, because the source documents or linked registry records leave a dimension unplaced, and its exact-label accuracy is below the generic Nemotron arms. We report that as a cost, not hide it. The remaining gaps are listed under limits.

## Limits

- **No clinical validation.** The applicability rules cite published concepts (PROBAST+AI, STARD-AI, TRIPOD+AI, IMDRF N41, FDA PCCP guidance), but no standard prescribes deterministic checks. The executable logic and thresholds are our design inferences and are marked so in [`src/compiler/rules.ts`](src/compiler/rules.ts); 21 of the 38 candidate registry rules are not implemented and each is listed with the reason.
- **No buyer evidence.** Nobody who runs a hospital AI review has been interviewed. Demand is not measured and nothing here is evidence of it.
- **One reader.** The answer keys, identity labels and extraction gold files were written by one builder. The Gate 0 key was edited after the builder saw a dry run of the compiler; the erratum (E-001) discloses it, and a second claim set was sealed afterwards.
- **Few authentic mismatches.** In the public data only 1 of 12 probed devices had a study that states the version the FDA reviewed. Links from devices to studies are shown as ranked candidates, never as fact below an exact identifier.
- **Extraction gaps.** Results that exist only in stacked tables are not read, so a numeric performance claim is not supported by any case today. Study population and setting are not inherited from the indications.
- **Constructed claims.** Every vendor claim and hospital requirement is constructed and labelled so on screen. No claim is a statement by a real vendor. There is no patient data.
- **Recorded replay.** Sample mode replays recorded model and engine replies. The default mode is live when configured; live mode was exercised once end to end.
- **Guard.** The Scout rule layer is strong on the prompts it was tuned on and weak on unseen wording (held-out injection recall 9 of 24 with rules alone); a model classifier exists and is measured in `tests/engines/scout/RESULTS.md`, but the product's guard (`src/agents/guard.ts`) runs the rules only and does not enable it.
- **Receipts.** Nightshift receipts identify where a reply came from, not that it is true, and they carry no hash of the reply text.

## Live mode

Needs Docker for the Zetaris stack and a model route. Set `NIGHTSHIFT_API_KEY` to the installed Nightshift's application token for the primary route (the receipt key id is read from its receipt log, or pin it with `NIGHTSHIFT_RECEIPT_KEY_ID`); `NVIDIA_API_KEY` adds the labelled fallback, and `SAKAIME_MODEL_FALLBACK=off` removes it. Follow [`infra/zetaris/README.md`](infra/zetaris/README.md) to start the stack, put the key names from `.env.example` into `.env`, then run `npm run serve` without `SAMPLE_MODE`. `npm run record:sample` re-records the cassettes from a live run.

## Repository

```
src/schemas, src/ports      shared contracts
src/compiler                applicability compiler and rule registry
src/sources, src/discovery  source layer and onboarding
src/federation              Zetaris port, cassette, DuckDB oracle
src/identity, src/extraction
src/engines                 H-MEM, World Model, Markovian, Scout Intent
src/models                  NVIDIA and Nightshift clients, receipts, egress policy
src/service, src/agents, src/api   case pipeline, investigation loop, HTTP API
src/dossier                 signed bundle and offline verifier
ui/                         web app
evals/, data/, tests/       evaluation suites, recordings and corpora, tests
docs/, infra/zetaris/       design, decisions, research reports, Zetaris runbook
```

Run the tests with `npm test`, which runs offline, and the type checks with `npm run typecheck`. The browser tests (`npm run ui:test`) need Chromium from `npx playwright install chromium` or an installed Google Chrome. What existed before the build, what was studied and under which licence: [`docs/provenance.md`](docs/provenance.md). Requirement-by-requirement status: [`docs/05-requirements-matrix.md`](docs/05-requirements-matrix.md).
