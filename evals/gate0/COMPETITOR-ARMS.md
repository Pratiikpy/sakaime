# Competitor arms (Gate 0, G2): terms, runs, scores

Run date: 2026-10-27. Claims, key and method: `claims.jsonl`, `ANSWER-KEY.md`, `PROTOCOL.md`. Scoring code: `tools/score-arms.mjs`. Per-claim detail: `arms/scored.json`.

## 1. Result in one paragraph

Neither incumbent accepts a claim, so neither emits a verdict: native verdicts 0 of 26 for both. Judged generously, as "could a careful reviewer re-derive the key's answer from only this arm's output for the claim's device", Constat's free MCP reaches 7 of 26 (26.9%, 95% Wilson 13.7-46.1%) and the HealthIT.com ledger reaches 0 of 26 (upper 95% bound 12.9%). Both are far below the 80 percent line that would remove the gap. This is a statement about their public interfaces on this claim set, built by the same builder as the key; it is not a statement about Sakaime, which has not been run, and not about the strongest baseline (a generic model given the same documents), which has not been run either.

## 2. Terms and permitted use (read 2026-10-27)

### 2.1 Constat (Health AI LLC)

Pages read, with the first 16 hex characters of the sha256 of the saved HTML in `raw/terms/`: terms `https://constat.dev/terms` (01884fcae8138dd1, page states 'Last updated 2026-07-11'), privacy `https://constat.dev/privacy` (124a293fb4e68faf, 'Last updated 2026-07-30'), pricing `https://constat.dev/pricing` (fd449aa8850ad803), MCP page `https://constat.dev/connect` (367b2eca30ed3f03), `https://constat.dev/robots.txt`.

Verbatim clauses:

- Terms s.2 Permitted use: "You may browse the site, look up individual devices, run searches, and query the MCP endpoint within its published rate limits — free of charge, for your own or your organization's internal evaluation and decision-support. Citing individual figures or device records with attribution (a link to the relevant constat.dev page) is welcome."
- Terms s.3 (requires a written commercial licence): "Bulk reproduction of the parsed corpus or any substantial portion of it — by scraping pages, enumerating the sitemap, or systematic API/MCP extraction. Redistributing, reselling, or republishing the parsed fields, statistics, or extraction output, in any format. Using the corpus or site content to train or fine-tune machine-learning models. Incorporating the data into a competing product or service."
- Terms s.4: "Anonymous API and MCP access is rate-limited per client; higher metered limits are available with an API key (see /connect ). Circumventing rate limits, rotating IPs to evade them, or otherwise defeating access controls is a violation of these terms."
- Pricing: "Anonymous MCP reads are rate-limited; no credit card is required." and "The public Constat console and anonymous Constat MCP read tools are free within the published rate limit."
- Privacy: "Constat does not require patient records or protected health information; do not include personal or sensitive health information in tool arguments, feedback, or forms."
- `robots.txt` (`User-Agent: *`): `Disallow: /alerts`, `/lab`, `/api/`. The MCP endpoint is `https://constat.dev/api/mcp`.

Numeric limits: the report of earlier today quotes 10 work units per minute and 50 per day. **NOT VERIFIED**: none of the pages above states a number. What was observed: the endpoint refused the seventh request inside about a minute with `minute_work_units_exceeded`, `retryable: true`, `retry_after_seconds: 60`.

**Decision.** Permitted: anonymous, serial `device_evidence_lookup` calls within the rate limit, for internal evaluation (s.2). Not permitted: bulk or systematic extraction, republishing the parsed output in any format (s.3), rate-limit evasion (s.4), and any claim that our data derives from theirs. Consequences applied:

1. One lookup per distinct device (13 K/DEN numbers: the 12 devices plus the later EyeArt clearance K223357), no repeats; responses are cached.
2. Spacing was widened to 25 seconds after the refusal. **Deviation, stated plainly:** the first retry (K253265) went out 28 seconds after the refusal, not after the stated `retry_after_seconds: 60`, because the second run was started by hand before the wait logic existed; the server accepted it. Same client address throughout, no rotation, no key, no evasion, so this is not circumvention under s.4, but it is not strict compliance with the retry hint. The script now enforces the stated wait itself.
3. **Raw responses are not committed.** The repository is public and s.3 forbids republishing the extraction output; `arms/constat/raw/` is gitignored (`arms/constat/.gitignore`) and only the sha256 of each response is committed (`arms/constat/calls.jsonl`). The scored table below lists which key facts were found, not Constat's text.
4. `robots.txt` disallows `/api/`; the terms and the MCP page invite exactly this use of that endpoint, and robots.txt governs crawlers. This is a reading, recorded here so the lead can overrule it. No page was crawled.
5. 'Competing product' (s.3): we incorporate none of Constat's data; this is a comparison for internal evaluation. If Sakaime later reuses any Constat field it needs a licence. **The lead should decide whether to email hello@healthai.com before publishing any comparison** (the competition report already lists that email as test 2).

Constat arm status: **RUN within the terms** (13 successful lookups, 1 refusal, 1 tools/list call; 15 requests in total today from this session). Arm not run: paid Evidence Assessment (from $5k), keyed MCP, `evidence_search` (it would add calls without adding claim input).

### 2.2 HealthIT.com

Pages read: `https://www.healthit.com/robots.txt`, `/llms.txt`, `/.well-known/agents.json` (232c7723a985ef1d), `/privacy` (bfabe458eb279d5b), `/methodology`, `/coverage`, `/api-docs`. There is **no terms page**: `https://www.healthit.com/terms` returns 404.

Verbatim:

- `robots.txt` (`User-Agent: *`): `Allow: /`, `Disallow: /api/`.
- `llms.txt`: "**Start here if you are an agent:** [/.well-known/agents.json](/.well-known/agents.json) — capability manifest, epistemic caveats, refusal boundaries, and the write surface in one fetch."
- `agents.json` policy: "cors":"*", "auth":"none for read and feedback", "rate_limit":"none enforced in research preview; be reasonable", "phi":"non-PHI service; do not transmit patient identifiers".
- `agents.json` attribution: "required":true, "form":"HealthIT.com, snapshot {snapshot_id}, evidence cutoff {evidence_cutoff_at}".
- `/privacy`: "Source materials remain subject to their owners' rights."

**Decision.** Permitted: two read-only GETs of the documented agent API (`/api/v1/evidence`, `/api/v1/vendors`), which the manifest invites; `robots.txt` disallows `/api/` for generic crawlers while the site's own manifest publishes it for agents (a contradiction on their side, recorded). Obligations: cite as "HealthIT.com, snapshot snap_36bba25c577cbb44, evidence cutoff 2026-08-27T04:05Z" and carry each row's verification state. No terms restrict reuse; none grants it either, so only the two raw JSON files (115 KB and 52 KB) are kept, with hashes, and no HealthIT text beyond short row excerpts is reproduced in the docs. HealthIT arm status: **RUN**.

## 3. What each arm was given and returned

| | Constat free MCP | HealthIT.com JSON ledger | Sakaime |
|---|---|---|---|
| Input accepted | one K or DEN number (`device_evidence_lookup`); none of its 14 tools takes claim text (schemas in `arms/constat/tools_list.json`, sha256 `0f391433d567...`) | a GET filter by workflow, source class, verification state, year or product; no claim input | claim plus evidence set (to be run later by the lead) |
| Query opportunities | one lookup per device, 13 devices | one fetch of the whole ledger (142 rows, snapshot snap_36bba25c577cbb44), joined by product slug | to be set equal: one query per claim |
| Verdict emitted | none (structured extraction with verbatim quotes) | none (claim ledger rows with verification state) | one of five labels |
| Devices covered | all 13 returned status `ok` | 4 of 12 devices have a product row: Lunit INSIGHT (2 rows), Viz.ai One Platform (3), HeartFlow Analysis FFRct (4), Aidoc aiOS (3); EyeArt, Transpara, Paige, GI Genius, Caption, Anumana, MammoScreen, IDx-DR have no row. Even where a row exists it is about a platform, not the device: the Lunit rows concern INSIGHT DBT and MMG (not CXR Triage K211733), the Aidoc rows are platform-level and one is the ICH module | all |

Access difference that favours the incumbents: the ceiling score lets a human do the comparison they cannot do. Access difference that favours us: the claims and the key were authored by the Sakaime builder, which can bias toward the dimensions Sakaime checks (version, population, setting, purpose).

## 4. Scores

Native verdicts: Constat 0 of 26, HealthIT 0 of 26. False-supported: 0 for both, because neither says anything (a system that never answers has no false-supported rate; it also has zero recall). Ceiling ("derivable") is defined in the header of `tools/score-arms.mjs`: every fact the key needs for the claim must appear in that arm's output for the claim's device.

| arm | all claims | mismatch claims (17) | positive controls (9) |
|---|---|---|---|
| Constat, derivable | 7/26 (26.9%, Wilson 13.7-46.1%) | 6/17 | 1/9 |
| HealthIT, derivable | 0/26 (upper 95% bound 12.9%) | 0/17 | 0/9 |

Per claim (facts found / facts the key needs; DERIVABLE means all found):

| claim | key label | Constat lookup | Constat facts | Constat | HealthIT rows | HealthIT facts | HealthIT |
|---|---|---|---|---|---|---|---|
| EA-01 | SUPPORTED_FOR_SCOPE | K200667 | 3/5 | no | 0 | 0/5 | no |
| EA-02 | SUPPORTED_ONLY_FOR_NARROWER_SCOPE | K200667 | 1/1 | DERIVABLE | 0 | 0/1 | no |
| EA-03 | REQUIRES_DOMAIN_REVIEW | K200667 | 0/1 | no | 0 | 0/1 | no |
| EA-04 | INSUFFICIENT_EVIDENCE | K200667 | 0/1 | no | 0 | 0/1 | no |
| EA-05 | SUPPORTED_ONLY_FOR_NARROWER_SCOPE | K223357 | 0/1 | no | 0 | 0/1 | no |
| TR-01 | SUPPORTED_FOR_SCOPE | K221347 | 1/3 | no | 0 | 0/3 | no |
| TR-02 | INSUFFICIENT_EVIDENCE | K221347 | 1/2 | no | 0 | 0/2 | no |
| LU-01 | SUPPORTED_FOR_SCOPE | K211733 | 3/4 | no | 2 | 0/4 | no |
| LU-02 | INSUFFICIENT_EVIDENCE | K211733 | 3/3 | DERIVABLE | 2 | 0/3 | no |
| LU-03 | SUPPORTED_ONLY_FOR_NARROWER_SCOPE | K211733 | 2/2 | DERIVABLE | 2 | 0/2 | no |
| VZ-01 | SUPPORTED_FOR_SCOPE | DEN170073 | 1/3 | no | 3 | 0/3 | no |
| VZ-02 | INSUFFICIENT_EVIDENCE | DEN170073 | 0/2 | no | 3 | 0/2 | no |
| BC-01 | SUPPORTED_FOR_SCOPE | K253265 | 4/4 | DERIVABLE | 3 | 0/4 | no |
| BC-02 | INSUFFICIENT_EVIDENCE | K253265 | 1/1 | DERIVABLE | 3 | 0/1 | no |
| MS-01 | INSUFFICIENT_EVIDENCE | K240301 | 0/1 | no | 0 | 0/1 | no |
| MS-02 | CONTRADICTED_BY_SPECIFIED_EVIDENCE | K240301 | 1/1 | DERIVABLE | 0 | 0/1 | no |
| PG-01 | INSUFFICIENT_EVIDENCE | DEN200080 | 0/1 | no | 0 | 0/1 | no |
| PG-02 | SUPPORTED_FOR_SCOPE | DEN200080 | 1/3 | no | 0 | 0/3 | no |
| GI-01 | SUPPORTED_ONLY_FOR_NARROWER_SCOPE | DEN200055 | 0/1 | no | 0 | 0/1 | no |
| GI-02 | SUPPORTED_FOR_SCOPE | DEN200055 | 1/3 | no | 0 | 0/3 | no |
| HF-01 | INSUFFICIENT_EVIDENCE | K213857 | 0/1 | no | 4 | 0/1 | no |
| AN-01 | SUPPORTED_FOR_SCOPE | K232699 | 2/3 | no | 0 | 0/3 | no |
| AN-02 | SUPPORTED_ONLY_FOR_NARROWER_SCOPE | K232699 | 0/1 | no | 0 | 0/1 | no |
| ID-01 | SUPPORTED_FOR_SCOPE | DEN180001 | 3/5 | no | 0 | 0/5 | no |
| ID-02 | SUPPORTED_ONLY_FOR_NARROWER_SCOPE | DEN180001 | 1/1 | DERIVABLE | 0 | 0/1 | no |
| CP-01 | SUPPORTED_ONLY_FOR_NARROWER_SCOPE | DEN190040 | 0/1 | no | 0 | 0/1 | no |

Which facts were missing is in `arms/scored.json` (`missing` per claim). Pattern: Constat returns the FDA summary's study design, sample size, sites, performance and a few verbatim quotes, and so often shows the cleared finding or the age floor; it returns no indication field, no software version for the studied build, no setting or exclusion statement, no external study, no registry status and no successor clearance. HealthIT's rows are vendor pages, press releases and summaries about whole platforms; the only regulatory row for our devices is HeartFlow K213857 (decision 2022-10-14, equal to openFDA), which names no version, population or setting.

### 4.1 Checks on the scoring itself (a negative finding needs more evidence than a positive one)

- The fact patterns were written from the key's quotes, after a keyword look at the Constat responses to learn their shape. That is a leak risk in the direction of tuning; I did not alter any pattern after scoring.
- Spot checks of cells scored 'not found', run with looser patterns on the raw responses: DEN170073 has none of `acute`, `stroke`, `hospital`; K221347 has none of `screening`, `concurrent`, `reading aid`; K232699 has none of `pacing`, `paced`, `adults`, `at risk`; K223357 has none of `previously`, `not been`; K213857 names only the predicate 'HeartFlow FFRCT v3' (K203329) and never 'v3.plus'; K200667 has the quote 'subjects 21 years old or younger' (counted as the age floor, so EA-02 is DERIVABLE) but no 'more than mild' and no version.
- Generous readings taken: MS-02 counted DERIVABLE because Constat's own extracted quote calls MammoScreen 'a concurrent reading medical software device'; EA-02 DERIVABLE from the 21-years-or-younger exclusion quote; ID-02 DERIVABLE from 'enrolled at 10 primary care sites'.
- A positive control is DERIVABLE for Constat only for BC-01 (the one device whose summary text lands entirely in Constat's quoted fields).

## 5. Assessment

**Proven.** On the incumbents' present public interfaces and this claim set: neither answers the question the product asks, and a reviewer holding only their output could re-derive the key's answer for roughly one claim in four (Constat) or none (HealthIT). The 80 percent kill criterion is not met by either.

**Not proven, not run.** (1) The Sakaime arm. (2) The strongest baseline: a generic model given the same retrieved documents (B3/B4 in docs/06), which is the arm most likely to approach 80 percent on the dimensions that sit in plain text (age, setting, purpose, named version). (3) Innolitics' explorer and chat (no legitimate trial access was established). (4) Constat's paid assessment and keyed MCP. (5) Any rival that adds a claim-input tool after today; Constat's tool list has 14 tools and none takes claim text, but that is true only as of 2026-10-27.

**Limits of this test.** 26 claims over 12 devices (effective sample about 12 clusters); claims and key by one builder, with 11 of 26 keys contestable; the ceiling score depends on hand-written fact patterns; no clinician review. A pass here removes one reason to stop. It does not show the product is good.
