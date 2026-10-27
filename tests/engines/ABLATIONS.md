# Engine ablations: World Model (MA-1) and H-MEM (MA-2)

These are the pre-registered ablations from `docs/04-meterless-plan.md` section 4, measured on constructed sessions. Every number below is pinned by a test, so this file cannot drift from the code: if the code changes the number, the test fails.

Reproduce:

```
npx vitest run tests/engines/world-model/ablation.test.ts tests/engines/hmem/ablation.test.ts
```

The measuring functions are `src/engines/world-model/ablation.ts` and `src/engines/hmem/ablation.ts`. The sessions are `tests/engines/world-model/ablation-session.ts` and `tests/engines/hmem/ablation-session.ts`. **All session data is constructed**: fictional devices, fictional submission numbers, wording written by hand before any result was seen. Nothing here is a measurement on real reviews, and no figure below should be quoted as one.

---

## MA-1: remove the World Model

Question: after a source changes, how many findings that used it are left unflagged?

Session: 12 devices, 36 findings (version, population and a combined scope finding per device, each citing the fact ids it used), then 11 source changes: two registry version updates, one withdrawn population fact, one older observation arriving late, one second source restating a value, one setting change, and five changes that no finding used.

A finding counts as really stale if the value it consumed now differs, or a fact it cited was withdrawn. That is decided by an independent evaluator over plain arrays (`independentTruth`), which shares the stated rule with the engine and none of its code.

| Arm | Findings | Really stale | Flagged | Stale and not flagged | Flagged without need | To recompute |
|---|---|---|---|---|---|---|
| World Model absent | 36 | 7 | 0 | **7** | 0 | 0 |
| World Model present | 36 | 7 | 9 | **0** | 2 | 9 |
| Recompute everything (no dependency tracking, nothing missed) | 36 | 7 | 36 | 0 | 29 | 36 |

What this does and does not show:

- **The "absent" row is by construction.** An engine that is not there flags nothing, so the 7 unflagged findings follow from the arm's definition and are not an experimental result. It is the reference point only.
- **The "present" row has two parts.** Missing no stale finding is, for this session, also close to by construction: any change in the value a finding consumed is a change of the winning fact, and a change of the winning fact is what the engine flags. The property test in `tests/engines/world-model/dependencies.test.ts` checks it more broadly (150 random sequences of assertions, retractions and declarations, against an independent oracle: the stale set equals the set of findings that depend on what changed). The informative number is the cost side.
- **The informative comparison is against recomputing everything**, the alternative that needs no dependency tracking: 9 findings recomputed instead of 36, with the 7 that needed it all among them.
- **The 2 unnecessary flags have one cause**, listed by the test: a second source restated device 5's software version with the same value on a later date, so the winning fact changed while the value did not. The engine cannot know the value is equal in the sense that matters to a finding, so it flags. This is deliberate and conservative.
- Not measured: wall-clock cost, behaviour on real registry churn, and whether recomputing only the flagged findings gives the same final answers as recomputing all of them (that depends on the finding pipeline, which does not exist yet; the T5 requirement in `docs/05-requirements-matrix.md` is still open).

Verdict for the sponsor explanation: the World Model's contribution is **exact change impact at about a quarter of the recomputation** on this session. It is not a claim about accuracy of findings.

---

## MA-2: remove H-MEM

Question: across a ten-case session, how often is a reviewer asked about an ambiguity they have already resolved?

Session: ten cases at two fictional hospitals, 34 questions about seven underlying ambiguities (three product-to-submission links, two policy questions, one field mapping, one unit question). 22 of the 34 repeat an ambiguity the same hospital resolved earlier: 4 repeat the earlier wording exactly and 18 reword it, either keeping the identifiers or dropping them.

A question is answered from memory when the top retrieved reviewer-confirmed record scores at or above the engine's default retrieval threshold (0.35). Retrieval is the engine's own synchronous lexical path; nothing was tuned on this session.

| Arm | Reviewer asked | Repeats asked | Answered from memory | Right record | Wrong record | Other hospital's record |
|---|---|---|---|---|---|---|
| No memory | 34 | **22** | 0 | 0 | 0 | 0 |
| H-MEM, scoped to the hospital | 19 | **10** | 15 | 11 | **4** | 0 |
| H-MEM, scoped, with an identifier guard | 23 | **11** | 11 | 11 | **0** | 0 |
| H-MEM, not scoped (control, not a product configuration) | 14 | 9 | 20 | 8 | **12** | **9** |

What this shows:

- **There is an effect.** Memory removes about half of the repeated questions (22 down to 10 or 11). The "no memory" row is by construction; the other rows are measurements of real retrieval.
- **It is also a hazard.** Scoped memory answered 4 questions with the answer to a different question. All four are identity-link questions about different products ("is the Orbis StrokeAlert the same product as submission K900002" against the stored "is the Aurelia ChestRead the same product as K900001"): they share almost every word, so a retrieval score cannot tell them apart. A wrong reuse of an identity link is worse than asking again.
- **An identifier guard removes the hazard at a cost of one avoided question** (11 avoided instead of 12). The guard (`identifiersAgree` in `src/engines/hmem/enrich.ts`) lets a retrieved record answer only if both texts name the same registry identifiers. The product should reuse reviewer-confirmed links only through this guard, or an equivalent exact-key check, and never on a similarity score alone.
- **Organization scoping works.** With it, no hospital received the other's records (0 leaks). Without it, 9 questions were answered from the other hospital's records and 12 reuses were wrong, which is the case for the scoping rule.
- **Every miss is a reworded question.** All 4 word-for-word repeats were answered from memory. The repeats that memory did not answer are rewordings: some drop the identifiers (which the guard then refuses to match) and some share too few words to reach the threshold. A better retriever could recover some of them and could also conflate more.
- The first time a hospital meets an ambiguity, it is asked, even if the other hospital resolved the same one earlier.

Limits, stated plainly:

- One constructed session of 34 questions, wording written by one person. The percentages have no confidence interval and should not be quoted as a rate.
- The semantic path (an injected embedder) was **not measured**: only a test double exists, and no real embedding model was run. NOT VERIFIED whether a real embedding model would recover more rewordings, and near-identical question templates about different products would be conflated by any similarity measure, so the guard would still be needed.
- The 0.35 threshold was the engine's default and was not varied.
- Policy and mapping questions have no identifiers to guard on. In this session none of them was reused wrongly, but there are only three such ambiguities, so that is an absence of observed failures, not evidence that none occurs.
- "Precedent hit rate" from the plan is the "right record" column above, over the repeats available.

Verdict for the sponsor explanation: H-MEM **retains reviewer answers and avoids about half of repeated questions on a constructed session, safely only with the organization scope and the identifier guard**. The claim should say that, with the numbers, and no more.

---

MA-3 (Markovian), MA-4 (Scout Intent) and MA-5 (Nightshift receipts) are measured with their own engines and are not in this file yet.
