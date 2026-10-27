# Channel intelligence: what we learned and what changes

Input: `reference/hackos-channel-digest-2026-10-27.md` (curated from five pastes of HackOS channels, read 2026-10-27). Rule: save what arrives, rule on each point, update the plan. Rulings: ADOPT, REFINE, NOTE, OPEN. Test ids refer to `05-requirements-matrix.md`.

## 1. Resolved

| Finding | Ruling | Change |
|---|---|---|
| Moderators on 22 and 24 Oct and the rules reminder: **Cursor is optional**; no Cursor credits; no separate Cursor prize | ADOPT. D-012 resolved. Still CONFIRM on the live rules page because the Help Cursor channel text and the Official Rules text we hold say required | `DECISIONS` D-012, `05` O-07. The sibling (Track 3) submission's statement that Cursor was not used stands on the same evidence |
| Every submission needs Zetaris as data layer, at least one Meterless Engine in a working feature, **Nightshift as primary AI provider**, NVIDIA where it contributes | ADOPT; already the design. New explicit requirement for a hosted or judge-run mode: Nightshift must be reachable where the app runs | `05` O-22, `04` s1 |
| Pre-existing components are allowed if declared in the Description and the README (what existed before 22 Oct, what was built during) | ADOPT. Sakaime code is all new (started 27 Oct); declare as pre-existing: the vendored Meterless reference engines (Apache-2.0), public datasets, open-source mechanisms studied, and the design experience from the sibling project (no code reused) | `05` O-14, `07` s5 |
| The repository must be public on github.com | ADOPT | `05` O-17, `08` s3 |

## 2. Zetaris: the judging core and the operating facts

| Finding | Ruling | Change |
|---|---|---|
| Zetaris judging core (staff): identify and onboard sources, query them, **create a Unified Semantic Layer, query it, add a basic data-quality rule**, and **reflect** (how it saved time, how it helps, how to improve it) | ADOPT. USL plus DQ rule move from "conditional" to **Essential**; a written USL reflection becomes a deliverable | `03` s2 tiers, `05` O-23, `07` s4, `08` Gate 1 |
| Native PDF reading: `FORMAT PDF`, `preview` text, `pdfToText(bytes)` | ADOPT as a candidate extraction route and Track 1 fit (Zetaris reads the FDA summary PDFs itself); test on our PDFs; the default preview length of 1,000 characters truncates silently, so the length option must be set and truncation detected | `03` s3, `02` s8, gate Z-PDF |
| Read-only agent identity: non-admin user with a General role limited to view, own API key | ADOPT as the agent identity for Z3. Risk: a participant saw "does not have access to USL" for non-admin users with grants; gate Z-POL must test USL tables | `03` s2 Z3, s5 |
| Completeness as a DQ rule: a cut-short collection feeds nothing downstream (peer pattern) | ADOPT: our truncated-result refusal is expressed as a Zetaris DQ rule as well as in code | `03` s2 |
| REST tables are re-fetched on every query (40 to 50 s for a 1.5 MB JSON); `CACHE TABLE` fixes speed but dies on restart; very wide nested JSON can exhaust the 2 GB driver heap | REFINE gate Z-REST: **prefer the snapshot route** (normalised files in the filestore) for large or nested public JSON; use REST tables only for small bounded endpoints; set the driver heap to 4 GB if needed; re-issue `CACHE TABLE` at start | `03` s3, s5 |
| After an out-of-memory the Spark context can stop while the container healthcheck stays green and every query returns HTTP 400 "stopped SparkContext"; AWS clusters showed intermittent HTTP 400 "Could not create ResultSet: null" and thrift transport errors | ADOPT in the connector contract: `check` runs a real `SELECT 1` probe, never a container healthcheck; these messages are classified UNAVAILABLE (retry with backoff, then degrade), never FORBIDDEN or EMPTY; an out-of-memory restart is a named drill | `02` s5, `06` s7 |
| REST API: one statement per request, no trailing semicolon, all values returned as strings, 60 s limit; localhost inside SQL is the container (`host.docker.internal` reaches the host) | ADOPT: a typed casting layer on the Zetaris port; long statements split; timeouts under 60 s | `03` s3 |
| Option spelling for PDF preview length differs between two staff posts; filestore path forms `dffs://` vs absolute container path | NOTE: verify on the installed build in the first spike | `03` s5 |
| USL recipe: whole `COMPILE USL` DDL in one request, one `ACTIVATE USL TABLE` per table with explicit casts, then `RUN DQ TABLE` | ADOPT | `03` s3 |
| Open: whether Zetaris keeps an audit log judges can see | OPEN (Z-AUD stays a gate) | `03` s5 |
| Hosting: no shared instance; local Docker, home server, Codespace (4 cores, 16 GB) or AWS managed cluster; staff say the local edition's minimum requirements will not change | NOTE. Our Zetaris is the local WSL install; disk and memory limits stay in `08` s5 | no change |

## 3. Nightshift and NVIDIA

| Finding | Ruling | Change |
|---|---|---|
| Nightshift adds its own remembered answers to later prompts (receipt `hmem` field of 1 or 2); a unique memory scope per call gives 0; our own 2026-10-24 finding was a response-cache defect avoided with a unique `meterless-scope` header | ADOPT: every evaluation call carries a unique memory scope; the receipt's `hmem` count must be 0 or the call is excluded and logged; a benchmark run without this check is invalid (independence of cases) | `04` s3.5, `06` s2 |
| Receipt checks used by peers: Ed25519 signature, requested tier named, custody on request id and app id, routed model equals requested model | ADOPT into C-13; also check `routed_model` (a 0.6.2 build routed explicit ids to auto) and record the Nightshift version | `04` s3.5, `05` C-13 |
| Models that work on the free NVIDIA API: Nemotron 3.5 Lightning 30B and Nemotron 3 Ultra 550B; Super 120B returns 404; **Super VL 120B fails in waves and reportedly fails above roughly 32 to 64 KB prompts** | ADOPT in the model map: Lightning 30B for high-volume roles, Ultra 550B for critic and adjudication; Super VL only for small prompts with a fallback; keep every call's prompt under 32 KB (chunking via Markovian helps); 429 handling with backoff; the model availability list is re-probed at the start of every run and recorded | `04` s3.5, `02` s11 |
| Best use of NVIDIA Nemotron: no application; README table of agent to model, a real run in the video, receipt log linked from the README | ADOPT | `07` s3, `05` O-06 |
| Nightshift on a cloud VM counts; Linux supports only DGX Spark | NOTE (we use Windows) | none |

## 4. Submission and judging mechanics

| Finding | Ruling | Change |
|---|---|---|
| Judges may lack credentials; ship `.env.example`, a sample mode that runs from a fresh clone without keys, a README with setup and a seed script | ADOPT; matches `SAMPLE_MODE` | `05` O-09, `07` s3 |
| **Open:** whether a recorded-replay sample mode complies with the AI Usage Policy 4.1 ("the default mode must run real agent logic") | OPEN. Design so both readings are defensible: the compiler, identity scorer, verifiers and guard always execute for real on recorded inputs; a new question not in the recording either runs live when keys are present or abstains visibly (never invents); the default mode is live when configured; replayed model outputs are labelled recorded | `02` s14, `07` s3; added to the open-questions list |
| **Open:** how judges run projects, whether clusters must stay up after the deadline, whether pitching is live | OPEN; design for all: hands-on sample mode, a recorded live proof, a public evidence hub | `07` |
| Peers publish a one-command offline judge script (`npm run judge`, `python judge.py`) that re-checks their main claims in 20 to 90 s | ADOPT: `npm run judge` re-verifies the dossier hash, re-runs the compiler on recorded inputs, replays the source-off drills and prints PASS or FAIL per claim, with no keys | `05` O-24, `08` Gate 6 |
| `metadata.json`: no official format; a community draft schema exists (Apache-2.0, JSON Schema 2020-12, requires schema_version, project, track, team, repository, sponsors with status/where/evidence, pre_existing, run) | REFINE D-023: use the community schema as the base for our file and validate with ajv; if the organizers publish a format, theirs wins | `DECISIONS` D-023, `05` O-21 |
| The second entry depends on the written exception whose text we do not hold | OPEN (G0): obtain the letter text and its exact terms. The deadline date is ignored by standing rule | `DECISIONS` G0 |

## 5. Peer field and what it implies

At least four Track 1 teams show: a new-source onboarding flow (profile in place, model proposes a mapping, a person approves, it becomes a Zetaris view), signed-receipt verification on every call, pre-registered evaluations with published negative results, honest limits and an offline judge script. Therefore Add-a-source is expected, not unique. Our differentiators must be shown with measurements: semantic validation of mappings (units and meaning, caught on a planted mutation), SSRF-safe allowlisted onboarding, typed identity links with preserved ambiguity (real collisions from FDA data), the applicability compiler with counterexamples and counterfactuals, dependency-aware change handling, and the same-input comparison with Constat. "Unverifiable" outcomes that name what to check next (a peer lesson from a domain practitioner) are already our Missing-Evidence List.

## 6. New open questions (added to `DECISIONS`)

1. Recorded-replay sample mode acceptable under the AI Usage Policy 4.1? 2. How judges run submissions and whether clusters must remain up. 3. A second project by the same team: allowed under the written exception? (G0.) 4. Official `metadata.json` format. 5. Zetaris audit log visibility. 6. Live pitching.
