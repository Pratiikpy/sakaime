# Coverage: every organizer ask against the deck, the video and the repository

Built 2026-10-27 from `research/hackathon/organizer/` (01 welcome guide, 02 FAQ, 03 journey map, 04 approach guide, 06 setup guide, 07 how the week runs, 08 full guide), `research/hackathon/intel/01`, `03`, `04`, and `docs/05-requirements-matrix.md` sections A (O-01 to O-24) and B (J-1 to J-6). Slide numbers are those of `sakaime-deck.pdf` (36 slides); `node docs/submission/build-deck.mjs` prints the list. The video column uses the scenes planned in `docs/07-demo-and-submission.md` section 1 (the decision; add a source; one query, one matrix; an identity left uncertain; change the use; a failure; the tamper test; the limits). `video/README.md` did not exist when this was written, so reconcile that column with the cut. Status words: **covered**, **partly**, **not covered** (with the reason).

Left out of the deck on purpose: the organizers' written exception for a second entry (gate G0, O-19) and any deadline; both belong to the owner, not to the judges.

## Slide index

1 Title. 2 Problem. 3 User and decision (Impact). 4 Why the evidence is fragmented. 5 What exists today. 6 What we built. 7 to 9 How it works end to end, EyeArt (question, discover, join; identity, extract, compile; label, drill, dossier). 10 Architecture (Technical). 11 Technical stack. 12 The Track 1 challenge. 13 What is new (Innovation). 14 Source discovery. 15 Identity resolution. 16 Agent workflow. 17 Applicability compiler. 18 What the product refuses to say. 19 Claim X-ray and lab. 20 Product and UX. 21 Failure behaviour. 22 Signed dossier. 23 Sponsor requirements (Sponsor Tech). 24 Zetaris, federation and gates. 25 Zetaris, USL. 26 Meterless. 27 Nemotron through Nightshift. 28 Safety and security. 29 How it was evaluated. 30 Results, every row. 31 Ablations. 32 Run it yourself (Demo). 33 Submission components. 34 Limits and not verified. 35 Provenance. 36 Roadmap, team, links.

## 1. The challenge and what a strong system looks like

| # | Ask (source) | Deck | Video | Repository proof | Status |
|---|---|---|---|---|---|
| 1 | "Demonstrate a clever ability to discover and work across fragmented data sources." (01 s4, 02 s4, 08 s4: Track 1) | 12, 14, 7 | Add a source; One query, one matrix | `src/discovery/`, `src/federation/`, `data/discovery-shift/RESULTS.md` | covered |
| 2 | "Use three or four small sources rather than one large one. The value is in discovering and working across them, not in volume." (04 s6) | 4, 12 | One query, one matrix | `data/silos/` (Postgres, registry snapshots, vendor CSV and PDFs, REST) | covered |
| 3 | "queries three disconnected systems, reconciling conflicting records, and producing a single sourced summary with the systems each fact came from" (04 s3, s19) | 7 to 9, 12, 19 | One query, one matrix; Claim X-ray | `src/service/linking.ts`, `ui/src/screens/ClaimXray.tsx`, `output_examples/dossiers/` | covered |
| 4 | "Agents that delegate tasks dynamically ... critique or validate ... shared memory ... branching, retries, escalation, and recovery ... logs or traces" (01 s3) | 16, 21 | An identity left uncertain; A failure | `src/agents/`, `output_examples/traces/*.jsonl` | partly: delegation, shared state, replan, critique pass and traces are shown; the critic confirmed no objection and changed no label in the recorded runs, and no source or model fallback appears in a recorded trace (slide 16 says both) |
| 5 | "at least three of these" nine collaboration behaviours (04 s9) | 16 | A failure | `src/agents/investigation.ts`, `critic.ts`, `plan.ts`; `tests/agents/agents.test.ts` | covered: seven of nine are visible in the traces; revision after critique and a fallback path are marked not seen |
| 6 | "Quality of interaction matters more than number of agents." (04 s8) | 16 | none | traces | covered |
| 7 | Weak pattern: "Agent A -> Agent B -> Agent C", "agents are only wrappers around prompts" (01 s3, 04 s9) | 16, 17 | none | `src/compiler/` is deterministic code; models only propose | covered |
| 8 | "A working agent system, not a demo or a chatbot" (04 s10 header) | 6, 7 to 9, 32 | whole video | `npm run judge`, `npm run serve` | covered |
| 9 | A real problem, a named user, a decision (FAQ s8; 04 s3 format) | 2, 3 | The decision | `docs/01-prd.md` s3 | partly: the user is a role; no reviewer or buyer was interviewed (slides 3 and 34 say so) |
| 10 | "Unsafe overclaiming" is a failure; avoid overclaiming accuracy, safety or production readiness (04 s4, s20) | 18, 28, 34 | The limits | closed label set `src/schemas/finding.ts`; wording lint `src/agents/policy.ts`; `check-numbers.mjs` lints the deck | covered |
| 11 | Judges reward: clear problem and user; agents do real work; critique and recovery; reliable execution; sponsor use; a usable output; a clear demo (FAQ s8) | 2, 3, 7 to 9, 16, 21, 23 to 27, 20, 32 | all | see section 3 | covered |
| 12 | Judges discount: UI polish without depth, single agents presented as many, hardcoded demo paths, weak implementation, unsupported claims of value (FAQ s8) | 20, 30, 31, 34 | The limits | `evals/RESULTS.md`; sample mode runs the real compiler on recordings; every number on a slide is checked against a source file | covered |
| 13 | "Weak: agents that are only prompt wrappers; nothing shows how the system reached its output" (01 s3) | 7 to 9, 16, 22 | Claim X-ray; tamper test | traces, signed dossier with lineage | covered |

## 2. Sponsor requirements

| # | Ask (source) | Deck | Video | Repository proof | Status |
|---|---|---|---|---|---|
| 14 | "Zetaris: every submission must integrate Zetaris"; "the center of every build" (01 s8, 06 Data rule) | 23, 24, 25, 7 | Add a source; One query, one matrix; A failure | `src/federation/`, `src/discovery/`, `infra/zetaris/GATES.md` | covered |
| 15 | Zetaris judging core: onboard and query sources, a Unified Semantic Layer, a data-quality rule, a reflection (`docs/11-channel-intel.md`, O-23) | 25 | One query, one matrix | `src/federation/usl.ts`, `src/federation/dq.ts`, `docs/zetaris-usl-reflection.md` | covered; the layer saved no run time (slide 25) |
| 16 | Zetaris natural-language route (06 data recipes; matrix B5) | 24, 34 | none | `infra/zetaris/GATES.md` Z-NL | not covered: BLOCKED in the local build, three routes tried; slide 24 shows it as Blocked |
| 17 | "Meterless: every submission must integrate Meterless"; "at least one Meterless Engine in a working feature" (01 s8; `docs/11-channel-intel.md`) | 23, 26 | Change the use; A failure | `src/engines/`, `third_party/meterless/`, `tests/engines/` | covered; MA-5 not measured and Scout weak on new wording (slides 26, 31) |
| 18 | "Nightshift as primary AI provider" (`docs/11-channel-intel.md`, O-22) | 23, 27 | none (not shown on screen) | `src/models/nightshift.ts`, `src/models/stack.ts`, `output_examples/model-route.json` | covered for the recorded run (61 of 61 receipted); live fallback and forged receipt exercised against doubles only; organizer acceptance of a loopback Nightshift NOT VERIFIED |
| 19 | "your product must run on NVIDIA Nemotron" (06 Power rule); "NVIDIA wherever it contributes" (01 s8) | 23, 27 | none | `src/models/roles.ts` | covered; role-removal ablation not run (slide 31) |
| 20 | "Cursor (with Space XAI): Required" (01 s8, 04 s10) against moderator statements that it is optional (D-012) | 23, 35, 36 | none | README "Cursor is optional ... was not used" | not covered: Cursor was not used; slides 23, 33, 34, 35 and 36 say so; the live rules page was not read |
| 21 | "Video and deck both name Zetaris, Meterless and Cursor and show where each one sits" (07 checklist) | 23 | planned | slide 23 | partly: Cursor sits nowhere (not used) |
| 22 | Bright Data: "Required for the Bright Data bounty" only | 23, 34 | none | none | not applicable: the primary track is Track 1 |
| 23 | "Colab links if you used Colab-hosted agents" (07) | 33 | none | none | not applicable: no Colab |
| 24 | "what was unique about your use of the sponsor technologies" (01 s9, 07) | 24, 25, 26, 27 | Add a source; A failure | `infra/zetaris/GATES.md` defects 1 to 10; `tests/engines/ABLATIONS.md` | covered |
| 25 | Sponsor technology explanation as a separate document naming code paths (01 s9, O-18) | 23 to 27 carry the content | none | no separate document yet | not covered: the explanation text for the form is not written; slides 23 to 27 hold the same content |

## 3. The six judging criteria (01 s12; 07; intel 01)

| # | Criterion and the judges' words | Deck (slide answering it directly) | Video | Repository proof | Status |
|---|---|---|---|---|---|
| 26 | **Impact (30)**: "how effectively the solution addresses a meaningful real-world problem for its intended users"; consistency with the challenge statements | 3 (user, decision; the judges' words printed), 12 (challenge), 2, 4, 5 | The decision | `docs/01-prd.md`, `docs/reports/` | partly: the problem and decision are real; demand is unmeasured (gate P, G6, G7 open), stated on slides 3 and 34 |
| 27 | **Technical (20)**: "technical implementation, reliability and architecture" | 10, 11, 16, 21, 29, 30, 31 | A failure | 3,140 tests, 157 drills, `evals/RESULTS.md` | covered; exact-label accuracy below the generic arms is shown on slides 5 and 30 |
| 28 | **Innovation (15)**: "how original or creative the approach" | 13, 17 | Change the use | `src/compiler/`, `ui/src/screens/Lab.tsx` | covered; the claim is limited to what the same-input tests show |
| 29 | **Demo (15)**: "how clearly the demo shows the solution, its functionality, and the value it provides" | 32 (and 7 to 9, 19) | all | `npm run judge`, sample mode | partly: the video is a separate artefact, not embedded in the deck |
| 30 | **Product and UX (10)**: "intuitive, accessible, and easy to use" | 20, 19 | all | `ui/src/screens/`, `tests/ui/` (axe, keyboard, responsive) | partly: automated accessibility, keyboard and layout checks pass; no moderated user session (slide 20) |
| 31 | **Sponsor Tech (10)**: "how effectively the solution uses the sponsors' technology to address the problem and enhance the overall product" | 23 to 27 | Add a source; A failure | see rows 14 to 25 | covered, with the null, by-construction and not-done items marked |
| 32 | Ties: Impact, then timestamp (FAQ s8) | none | none | none | not a deliverable |

## 4. What must be submitted (01 s9, 02 s7, 04 s14, 07)

| # | Ask (source) | Deck | Video | Repository proof | Status |
|---|---|---|---|---|---|
| 33 | Demo video 1 to 4 minutes: "main workflow, how the agent solves the challenge, key features, how Zetaris and Meterless are integrated" | 32, 33 | the video itself | `video/` | partly: in production by another agent; `metadata.json` still has `demo_video: null` |
| 34 | Slide deck: "problem and target users" | 2, 3 | | | covered |
| 35 | Deck: "solution overview" | 6, 7 to 9 | | | covered |
| 36 | Deck: "agent workflow or architecture diagram" | 10, 16, 7 to 9 | | `docs/02-architecture.md` | covered |
| 37 | Deck: "technical stack" | 11 | | `package.json` | covered |
| 38 | Deck: "how Zetaris and Meterless were used" | 23 to 26 | | | covered |
| 39 | Deck: "what was unique about your use of the sponsor technologies" | 24 to 27 | | | covered |
| 40 | Deck: "screenshots or other product visuals" | 12, 19, 20, 22 (and diagrams on 7 to 10, 14 to 17) | | `docs/submission/images/` (regenerate with `node docs/submission/capture.mjs`) | covered; screenshots are of the sample-mode product and the banner stays in the picture |
| 41 | Deck: "potential future enhancements and use cases" | 36 | | | covered; domain packs marked a thesis |
| 42 | GitHub repository: "all source code ... a README covering setup, usage and dependencies" | 32, 33 | | `README.md`, `package.json` | partly: README complete; at the time of writing the local branch is 38 commits ahead of `origin/main` and github.com could not be reached from this machine, so the push is not verified |
| 43 | README "someone outside your team could run it" (07) | 32 | | `README.md` "Try it (no keys, no Docker)" | partly: `npm run judge` passes in the working tree (67 PASS, 0 FAIL; 5.5 s in `docs/05-requirements-matrix.md`, 4.3 s when re-run for this deck); a literal clean-clone run on Windows and Ubuntu is not done (O-09, O-24) |
| 44 | Sample inputs and outputs (04 s10, s14) | 32, 33 | | `input_examples/`, `output_examples/` | covered |
| 45 | "Logs or traces showing how the agents worked" (04 s14) | 16, 33 | | `output_examples/traces/` | covered |
| 46 | `SAMPLE_MODE=true` fallback; "does your agent still work if a public API is down?" (04 s5, s7, s18) | 32, 21 | | `.env.example`, `data/cassettes/`, `src/federation/cassette.ts` | covered |
| 47 | "No API keys committed"; `.env` in `.gitignore`; `.env.example` placeholders (01 s8) | 33 | | `.gitignore`, `.env.example`; secret scan O-13 is a point-in-time read | covered (no committed scanner) |
| 48 | "Declare any pre-existing components" (01 s9, 02 s5) | 35 | | `docs/provenance.md`, `metadata.json` | partly: declared in README, provenance and `metadata.json`; the HackOS form text does not exist yet |
| 49 | "Test a clean setup from scratch" (01 s11, 02 s7) | 32, 33, 34 | | `npm run judge` | not covered: clean-clone transcript missing (O-09); slides 32 to 34 say so |
| 50 | Open, lawful, light data; no real personal data; documented sources (02 s5, 04 s7, s12) | 4, 28, 35 | | `docs/provenance.md`, `data/silos/README.md`; about 6.5 MB tracked | partly: terms of the FDA summaries, ClinicalTrials.gov and PubMed abstracts are marked NOT VERIFIED in provenance; no `data/README.md` in the layout the guide suggests |
| 51 | Bounded runs: timeouts, capped retries and turns (04 s11) | 21 | A failure | `src/service/budget.ts`, `evals/results/failureshift.json` | covered; latency and cost not measured (stated) |
| 52 | State limitations honestly (04 s4) | 34 | The limits | `README.md` "Limits", `evals/RESULTS.md` | covered |
| 53 | Primary track Track 1 only, consistent in form, video and deck (O-01) | 1, 12 | all | `metadata.json` `track` | partly: form text and video not checked against each other |
| 54 | `metadata.json` (O-21; community draft, organizer format unconfirmed) | 33 | | `metadata.json`, `tests/metadata.test.ts` | partly: `cursor.status` reads `planned` while the text says not used (the lead's file, not touched here) |
| 55 | Project description for the HackOS form (150 to 2000 characters per `docs/07`) | 33 | | none | not covered: not part of the deck; slide 33 says "outside the deck" |

## 5. Items the organizers ask that the deck states as not done

- Cursor as development environment: not used (slides 23, 33, 34, 35, 36).
- Zetaris natural-language-to-SQL: blocked in the local build (slides 24, 34).
- A clean-clone run on Windows and Ubuntu: not done (slides 32, 33, 34).
- A reviewer study, a buyer interview, independent labelling: not done (slides 3, 20, 29, 34, 36).
- MA-5 (Nightshift receipts as an ablation), a critic ablation, a federation-off accuracy ablation: not measured (slide 31).
- Constat and HealthIT.com on the held-out claims: not run (slides 5, 34).
- A separate sponsor technology explanation and a form description: not in the deck (slide 33).
- Bright Data bounty and Colab links: not applicable (slides 23, 33).

## 6. Open points for the lead

1. Push: 38 local commits are not on `origin/main` (github.com was unreachable from this machine at build time).
2. `video/README.md` scene list: reconcile the video column above.
3. `metadata.json`: `slide_deck` is null and `cursor.status` is `planned`; both are outside `docs/submission/`.
4. The HackOS description and the sponsor explanation text are not written.
5. A `SemanticLayer` screen (`ui/src/screens/SemanticLayer.tsx`) appeared while the deck was built; `capture.mjs` does not capture it yet. Add a slide image once the UI is stable (slide 25 is the natural place).
