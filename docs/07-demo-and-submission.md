# Demo, deck, README and submission plan

Status: plan, 2026-10-27. The first authentic case is EyeArt (the one chain the feasibility probe found machine-checkable end to end); a clearly labelled constructed vendor claim supplies the overreach. Every claim in the video, deck and README must cite a row in a results file or be removed. Visual direction: the Blank brand kit (ink on white, one green accent, rust red for failure, Outfit and JetBrains Mono, redaction-bar motif, terse voice).

## 1. The four-minute demo (target 3:50, hard cap 4:00)

Rewritten after the 2026-10-27 review: fewer scenes, each with clearer proof, and nothing crowded into a montage. The judge must see a source nobody wired up get discovered and joined through Zetaris, an identity left uncertain on purpose, a conclusion that changes when the use changes, and a failure that makes the system less sure instead of falsely sure. A recorded response is labelled recorded; a cassette is never shown as a live federation call.

| Time | Scene | Exact demonstration | Sponsor effect shown |
|---|---|---|---|
| 0:00 to 0:30 | **The real decision** | A vendor-style claim (constructed, labelled) and the hospital's intended use; why the evidence is scattered across regulator, registry, literature, vendor packet and hospital policy | none |
| 0:30 to 1:15 | **Track 1 centrepiece** | Add a source inside the allowlist; the fabric probes it, shows the mapping, runs the semantic checks (including a unit it caught), registers it, and the Evidence Matrix appears from one real Zetaris statement with query id and row counts | Zetaris catalog, registration and federation; Nemotron mapping proposal; H-MEM stores the mapping |
| 1:15 to 2:05 | **The discovery** | One authentic chain (the EyeArt case): link types shown separately, one link left AMBIGUOUS with its weight waterfall; the claim opens beside the exact page and quote; the smallest mismatch is named | World Model timeline; Markovian carried a restriction from deep in a long document |
| 2:05 to 2:45 | **The intelligence** | The reviewer changes the intended population and version in the Applicability Lab; labels recompute with no model call; the Missing-Evidence List updates | deterministic compiler |
| 2:45 to 3:15 | **Resilience** | Stop a material source and then the Zetaris API: the finding becomes unresolved with the reason (not "supported", not "no evidence exists"); then a registry record changes and only dependent findings go stale | Zetaris kill drill; World Model dependency tracking |
| 3:15 to 3:45 | **Proof** | Export the signed dossier, change one byte and watch verification fail with a named field; the measured benchmark table with its limits; sponsor ablation rows | Nightshift receipts; Scout Intent guard |
| 3:45 to 3:55 | **Close** | One sentence of value, the limits in one line, GitHub and Notion links | none |

Recording rules: script the proof segments (kill drills, tamper test) with Playwright so every frame comes from the real run; use a polished capture tool only for narrative framing. No scene may show a result that was not produced in the recorded run. Check each chapter timestamp against frames before publishing and keep a length guard under 4:00. The repository, the public evidence hub and the deck carry the technical depth the video does not.

## 2. Deck outline (24 to 28 slides, PDF; Blank brand kit)

1 Title and promise. 2 The problem with a true claim. 3 The user and the decision. 4 Why evidence is fragmented. 5 What exists today (honest competitor slide). 6 Product tour: Source Console. 7 Evidence Matrix. 8 Claim X-Ray. 9 Applicability Lab. 10 Evidence Timeline and change impact. 11 Architecture diagram (layers L0 to L8). 12 Track 1 mapping: discover, work across, reconcile. 13 Zetaris: roles, statement, policies, kill drill. 14 Meterless: four engines, roles, ablations. 15 NVIDIA Nemotron: roles, model mix, receipts. 16 Applicability Compiler: dimensions, labels, invariants. 17 Identity resolution and uncertainty. 18 Safety: what the product refuses to say. 19 ScopeShift: design and baselines. 20 Results table (only measured rows). 21 Ablations. 22 Reproducibility: clean clone, sample mode. 23 Limits and what is not verified. 24 Roadmap and domain packs (marked as thesis). 25 Team and tools (Claude Code, Cursor use as logged). 26 Links. A required architecture diagram and stack slide are present (11, 13 to 15).

## 3. README outline

Title and one-sentence promise; what it is and is not; quick start (sample mode, no key); live mode (Docker for Zetaris, Nightshift or NVIDIA key via `.env`); what to look at first (the Source Console and the kill drill); repository map; sample inputs and outputs; tests and how to run them; how the benchmark and ablations run; sponsor roles with file paths; data provenance and licences; known limits; security notes; the exact commands the video uses.

README additions from the channels: a table of which agent runs on which Nemotron model (for the Nemotron award), a link to the receipt log, the pre-existing declaration (what existed before 22 Oct and what was built during), the `npm run judge` command, and a `.env.example` with placeholders plus a seed script so a judge can point the agent at their own data.

## 4. Sponsor technology explanation outline

Zetaris: the statement, silos, the USL and its data-quality rule, the reflection (`docs/zetaris-usl-reflection.md`), policies, catalog, kill drill, gates that failed and what was dropped, with query ids. Meterless: each engine's role, extensions to the reference, conformance and extended test results, ablation rows, Nightshift receipts and the unconfirmed "primary provider" status. NVIDIA: models per role, route, receipts, what a fallback does. Cursor: usage as logged, or not used. Each paragraph names code paths and a trace line.

## 5. HackOS form

Description 150 to 2000 characters, video link (YouTube, Vimeo or Drive; under 4 minutes), GitHub link, optional deck link or file. Track selected in the team workspace. The description opens with a link to the public Notion brief if one is built, states the problem, the Track 1 mechanism, the measured results with their limits, and names the constructed parts. The exact text is drafted last, from results files.

## 6. Pre-submission checklist

The repository is public on github.com (the form accepts only GitHub URLs); `npm run judge` passes on a clean clone without keys; the Description and the README declare what is pre-existing. `metadata.json` at the repository root (product, track, links, sponsor roles with code paths and evidence, user and decision, constructed-data labels) exists and every path in it resolves; its organizer format is unconfirmed (D-023).

Clean-clone run on Windows and Ubuntu without a key (sample mode); live run with Zetaris and Nightshift; secret scan including history; repo size check; wording lint; every video chapter checked against frames; every deck number traced to a results row; links opened logged out; written organizer exception filed with the submission notes; team and track confirmed in the workspace; the submission created only by the owner.
