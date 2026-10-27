/**
 * Records, with the development score at each setting, the adapter choices that were compared while it was being built (ERRATA.md E-003).
 * Only choices that are still expressible as a VConfig are re-run here, so the numbers are reproducible; bug fixes are listed in words.
 * Development claims only. The held-out claims were not run before the adapter was frozen.
 *
 *   npx tsx evals/suites/adapter-log.ts
 */
import { loadDevCases } from "../lib/cases.ts";
import { retrieve } from "../lib/documents.ts";
import { ADAPTER_HASH, runV, toArmOutput, V_FULL, type VConfig } from "../lib/pipeline.ts";
import { scoreCase } from "../lib/grade.ts";
import { stamp } from "../lib/core.ts";
import { writeResult } from "../lib/results.ts";

const dev = loadDevCases();
const settings: { revision: string; change: string; config: VConfig }[] = [
  { revision: "r0", change: "the compiler's own default dependencies (authorization, plus a study when the claim states a number)", config: { ...V_FULL, dependencies: "default" } },
  { revision: "r1", change: "every claim declares authorization and study as required (the setting that was frozen)", config: { ...V_FULL, dependencies: "declared" } },
];

const rows = [];
for (const s of settings) {
  for (const evidence of ["extracted", "hand"] as const) {
    let exact = 0;
    let acceptable = 0;
    let falseSupported = 0;
    for (const c of dev.cases) {
      const run = await runV(c, await retrieve(c.product, "development"), { ...s.config, evidence }, dev.handSetIds.get(c.id) ?? []);
      const sc = scoreCase(c, toArmOutput(run));
      exact += +sc.exact;
      acceptable += +sc.acceptable;
      falseSupported += +sc.falseSupported;
    }
    rows.push({ revision: s.revision, change: s.change, evidence, exact: `${exact}/${dev.cases.length}`, acceptable: `${acceptable}/${dev.cases.length}`, falseSupported });
  }
}
writeResult("adapter-log.json", {
  meta: { ...stamp("adapter-log", 0), class: ["builder-labelled"], description: "Adapter choices compared on the 26 development claims, with the score at each. Frozen adapter hash recorded below.", frozenAdapterHash: ADAPTER_HASH },
  summaries: { frozenAdapterHash: ADAPTER_HASH },
  revisions: rows,
  fixesInWords: [
    "ClinicalTrials.gov fixtures that hold a whole search response: the candidate keeps only the study named by its record id (before the fix, one fixture attached thirteen unrelated studies to a device when the identity layer was off, and the compiler rejected the duplicate item ids).",
    "A trial identifier cited inside an FDA summary (GI Genius) has no registry fixture; it is carried as a record with no extracted items instead of failing.",
    "The repository .env key is read before the shell's NVIDIA_API_KEY: a stale shell value returned HTTP 403 on the model arms.",
  ],
});
console.log(rows);
