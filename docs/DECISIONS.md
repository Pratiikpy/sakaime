# Decisions

Format: id, date, decision, alternatives considered, reason, what would reverse it. Costly-to-reverse choices only. Unresolved items are in section "Open gates" and are closed with an answer, a source and a date, never deleted.

## Decided

**D-001 (2026-10-27) Product: Sakaime, an applicability-aware evidence intelligence system.** Alternatives: BidDelta (construction addenda), NYC building reconciliation, vulnerability-scanner reconciliation, recall exposure, cost-basis reconciliation (`candidates/2026-10-27-track1-candidate-evaluation.md`). Reason: the owner chose it after reading an outside proposal; its idea (does the evidence cover this exact use) generalises beyond medicine; the appraisal basis is published (PROBAST+AI, STARD-AI, TRIPOD+AI). Reverse if gate G1 or G2 fails.

**D-002 (2026-10-27) Track 1, second submission, separate repository.** Reason: desk (Track 3) is submitted; the written organizer permission allows another project in another track. Terms of that letter are NOT VERIFIED here. Reverse: only the organizers.

**D-003 (2026-10-27) Flagship domain: clinical AI procurement evidence. Status: CONDITIONAL, leaning GO after the feasibility probe (G1), not yet GO (G2 same-input test and reviewers outstanding).** Reason: public sources exist (FDA list, openFDA, ClinicalTrials.gov, PubMed, Crossref) and need no key. Risks: sparse or ambiguous device-to-study links, no clinical reviewers, incumbents. Pivot target if gates fail: the same engine on construction addenda (objective old/new quantities in real DOT addenda) or tariff revisions. The engine is built domain-pack ready from the start (claim schema, dimension orders, rule registry, source cards) so a pivot changes data, not architecture.

**D-004 (2026-10-27) Centre of gravity: autonomous source discovery and federation, with the Applicability Compiler as the distinguishing invention.** Reason: the Track 1 text asks for discovery and work across fragmented sources; a compiler alone reads as Track 2 or 3. Reverse: no.

**D-005 (2026-10-27) Stack: TypeScript on Node 22+, Zod schemas, SQLite local state, Vitest, fast-check for property tests, a small HTTP API and a web UI.** Alternatives: Python (richer scientific ecosystem, Splink and Docling are Python). Reason: Meterless engines and harnesses are TypeScript; one language for engines, ports and UI; we reimplement the needed mechanisms (identity scoring, anchored parsing) in TypeScript, calling a Python Docling sidecar only if extraction quality requires it, which would be recorded as a separate decision. Reverse if the sidecar becomes the main extractor.

**D-006 (2026-10-27) No desk code, data, copy or screenshots are reused.** Ideas and patterns are free. Reason: originality, the pre-existing-code declaration rule, and honest provenance. Anything reused on purpose goes in `docs/provenance.md` first.

**D-007 (2026-10-27) Deterministic code owns labels, arithmetic, containment and verification; Nemotron proposes; humans decide.** Reason: reliability and judge trust. Reverse: no.

**D-008 (2026-10-27) Meterless: vendor the sponsor's Apache-2.0 reference engines and conformance harnesses unmodified, then extend them in `src/engines/` to close the gaps listed in `04`.** Alternatives: reuse desk's own engine implementations (rejected by D-006). Reason: sponsor-authored harness gives a neutral conformance result; our extensions are visible diffs.

**D-009 (2026-10-27) Closed label set; no safety, compliance or approval outputs.** Reason: organizer red flag on overclaiming in healthcare; correctness. Reverse: no.

**D-010 (2026-10-27) `SAMPLE_MODE` uses recorded real responses (hashed cassettes), not synthetic stand-ins, for public sources.** Constructed parts are labelled. Reason: judges need keyless reproducibility without fake data. 

**D-011 (2026-10-27) Domain packs are a thesis, not a claim.** Only a pack that runs end to end with its own tests may be mentioned as working.

**D-012 (2026-10-27, provisionally resolved: moderators say optional, live rules page not yet confirmed) Cursor is optional.** Moderators stated on 22 and 24 Oct that Cursor is optional, that no Cursor credits exist and that there is no separate Cursor prize; a rules reminder repeats "Cursor is optional" (`reference/hackos-channel-digest-2026-10-27.md`, s2). The Official Rules text we hold and the Help Cursor channel text still say required, so the live rules page is still to be confirmed. We may use Cursor and log it truthfully, but we are not obliged to. The Track 3 submission's statement that Cursor was not used stands on the same evidence.

**D-013 (2026-10-27) Reference documents received from outside are kept verbatim under `docs/reference/` and treated as inputs, not as verified fact.** Where our reading differs, this folder's documents win and say why. Working rule: whenever outside advice arrives, save it as received first, then answer it point by point and plan the work (`10-review-disposition.md`).

**D-014 (2026-10-27) The outside review of 2026-10-27 is adopted with refinements.** All sixteen corrections accepted; four refined (6 label ranking, 7 contrary evidence, 8 degradation, 12 fair ablations). Full ruling table: `10-review-disposition.md`. Reverse: no; each correction has an acceptance test (C-01 to C-17).

**D-015 (2026-10-27) Authority is decided per assertion type; identity is a graph of typed links.** Replaces the single authority hierarchy and the single CONFIRMED/CANDIDATE state of v0.1. `02` s4, s7.

**D-016 (2026-10-27) Source onboarding is allowlist-first and SSRF-safe; mappings are validated for meaning, not only type.** `02` s5.

**D-017 (2026-10-27) The compiler separates mechanical coverage from expert applicability; the five labels are not an ordered scale; invariants are stated on containment.** `02` s10.

**D-018 (2026-10-27) Evaluation is five suites (DiscoveryShift, IdentityShift, ScopeShift, TimeShift, FailureShift), consistency and domain-validity kept apart, statistics clustered by device, no unmeasured number in any public text.** `06`.

**D-019 (2026-10-27) Data classes (public, vendor-confidential, PHI) and an egress policy govern what reaches a model; local storage is not local processing.** `02` s12.

**D-020 (2026-10-27) The outside GitHub playbook (61 repositories) is a study catalogue, verified against the GitHub API, not an install list.** `09-study-register.md`.

**D-021 (2026-10-27) Build order follows Gates 0 to 6 with a parallel demand gate P.** `08-build-plan.md`. Gate 1 spikes may start before Gate 0 passes because they are reversible and are the highest-value Track 1 work; the full build waits for Gate 0.

**D-022 (2026-10-27) Visual identity: the same Blank brand kit as the Track 3 submission, chosen by the owner.** Ink on white, one green accent, rust red for failure, Outfit and JetBrains Mono, the redaction-bar motif, a terse voice. Applies to the UI, deck, video and Notion hub. Findings still use words and icons, not colour alone. Fonts are copied from the sibling repository's licensed font files for rendering only; no desk code or screenshots are reused (D-006).

**D-023 (2026-10-27, revised) `metadata.json` at the repository root follows the community draft schema until the organizers publish a format.** The sponsor folders ask for sponsor use "in your README and metadata.json" but define no format. A community draft (Apache-2.0, JSON Schema 2020-12) requires `schema_version`, `project`, `track`, `team`, `repository`, `sponsors` (with role, status, where, evidence), `pre_existing` and `run`. We use it as the base, validate with ajv, and add a test that every path listed exists. If an official format appears, it replaces this.

**D-024 (2026-10-27) Zetaris judging core is adopted as Essential: a Unified Semantic Layer, a data-quality rule and a written reflection.** Staff said the core of Zetaris judging is: identify, onboard and query sources; create a USL and query it; add a basic data-quality rule; reflect on how it saved time, how it helps and how to improve it. `03` s2; deliverable `docs/zetaris-usl-reflection.md`.

**D-025 (2026-10-27) Model map and Nightshift hygiene.** Lightning 30B for high-volume roles, Ultra 550B for critic and adjudication, Super VL only for small prompts with a fallback; prompts kept under 32 KB; availability re-probed each run; a unique memory scope per call and a check that the receipt's `hmem` count is 0 (otherwise the call is excluded from evaluations). `04` s3.5.

**D-026 (2026-10-27) Judge path: `npm run judge` plus a sample mode whose agent logic really runs.** One command re-verifies the dossier hash, re-runs the compiler on recorded inputs, replays the source-off drills and prints PASS or FAIL per claim without keys. Recorded model outputs are labelled recorded; unseen questions go live when configured or abstain visibly. This keeps both readings of the AI Usage Policy 4.1 defensible (OPEN question 3 below).

**D-027 (2026-10-27) The NVIDIA API key from the Track 3 project is reused here, by the owner's instruction.** It lives only in this folder's gitignored `.env` (copied by script, never printed); `.env.example` carries placeholders. Both free-tier Nemotron models in the model map (Lightning 30B, Ultra 550B) answered HTTP 200 on 2026-10-27. The key is shared between two projects, so rate limits are shared and any key rotation must update both `.env` files. Reverse: delete `.env` here.

**D-028 (2026-10-27) The product is named Sakaime (境目, "the boundary line").** The name is the point where evidence stops applying; tagline: "Know where the evidence stops." Chosen by the owner from a shortlist (Sakaime, Mikiwame, Wakimae, Tsugime, Kakusho). Checked only for npm and GitHub name collisions (none found for the exact name on 2026-10-27); this is not trademark or domain clearance. The working name VALIDWHEN appears only in the outside documents under `reference/`. Repository: `Pratiikpy/sakaime`, licence Apache-2.0.

## Where our reading differs from the outside documents

- The outside note frames the flagship as settled; we mark it CONDITIONAL until G1 and G2 pass.
- It names Z3, PydanticAI, Evidently and Sigstore as candidates; we adopt none until a need is shown (principle: a mechanism, not a dependency).
- It lists "Reddit search for practitioner workflow" in r/medicine and similar; Reddit access works only through a read-only front end here and healthcare communities are small for this topic. A buyer or reviewer interview is the stronger evidence and is still missing.
- It recommends running the evaluation with independent domain reviewers; none is secured. Until one is, results are labelled builder-adjudicated.

## Open gates

| Gate | Question | Evidence needed | Status |
|---|---|---|---|
| G0 | What exactly do the organizers' written terms cover for a second entry (deadline, additional entry, code and commit terms)? A participant's question about a second project in another track has no visible answer in the channels | the letter text | OPEN (the owner) |
| G1 | Can real devices be linked to real studies from public keyless data, with version and population stated? | `research/feasibility/FEASIBILITY-REPORT.md` (12 devices, 2026-10-27): identity and FDA-reviewed evidence retrievable keyless and reliably; external study links only as ranked candidates (exact 3, strong 5, weak 3, none 1 of 12; version agrees for 1 of 12) | ANSWERED: CONDITIONAL. The product's value is exposing this ambiguity, so the design keeps links as classed candidates and never states a link as fact below STRONG |
| G2 | Is there a defensible gap against incumbents? | `research/competition/COMPETITION-REPORT.md` (read 2026-10-27: no product seen that joins FDA, registry and literature and tests a claim against scope; Constat is the strongest threat), then a same-input test of about 25 claims | REPORT DONE; test not started |
| G3 | Do the standards give citable, deterministic rules? | `research/standards/APPLICABILITY-RULE-REGISTRY.md` (read 2026-10-27): concepts citable, executable logic and thresholds are our inference; PROBAST+AI has three applicability items, not signalling questions; two real FDA summaries (DEN170073, K250694) show missing dates, thresholds, subgroups and version strings | ANSWERED: concepts yes, determinism by design; contested rules go to REQUIRES_DOMAIN_REVIEW |
| G4 | Which Zetaris gates pass (Z-REST, Z-POL, Z-CAT, Z-AUD, Z-TT, Z-USL, Z-NL, Z-JUDGE)? | `03` section 5 | NOT STARTED |
| G5 | Do the Meterless harnesses run against our modules? | conformance output | NOT STARTED |
| G6 | Can any clinical or informatics reviewer be recruited? | named reviewer or documented attempts | OPEN (the owner) |
| G7 | Is a buyer interview possible? | transcript or documented attempts | OPEN (the owner) |

Gate P (demand): purchasing authority, workflow fit, adoption cost and willingness to use or pay, evidenced by conversations with people who evaluate healthcare AI products. Status: NOT STARTED; needs the owner's contacts. Nothing in this repository is evidence of demand.

Mapping to the build gates in `08-build-plan.md`: G0 and G2 belong to Gate 0; G4 to Gate 1; G1 and G3 informed Gate 2 and Gate 3 and are answered; G5 to Gate 4; G6 to Gate 5 and Gate P; G7 to Gate P.

Conviction gate (from the global rules) is not passed. A full build starts when Gate 0 passes (the same-input test, a hand-proven authentic chain, the written exception on file); G1 and G3 are answered; G2's test and G6/G7 remain open.

## Open questions from the channels (2026-10-27)

1. Is a recorded-replay sample mode acceptable under the AI Usage Policy 4.1? 2. How do judges run submissions, and must clusters stay up after the deadline? 3. A second project by the same team in another track: allowed under the written exception? 4. Official `metadata.json` format. 5. Zetaris audit-log visibility. 6. Live pitching. Source: `reference/hackos-channel-digest-2026-10-27.md`, s5; rulings in `11-channel-intel.md`.
