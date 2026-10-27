// Every number the video shows or speaks is declared here with the file and path it is read from.
//   kind "kn"        the file holds {k, n}
//   kind "value"     a plain value at the path
//   kind "meanWorst" the file holds {mean, worst, runs}
//   kind "tsArray"   the number of entries of `export const NAME = [...]` in a TypeScript file
// `file` is relative to the repository root. `base` is the object the path starts at; `flat` keeps the last segments as one key.
const R = "evals/results";

export const FIGURES = [
  // ScopeShift A: consistency with the rule table
  { key: "sa.exact", file: `${R}/scopeshift-a.json`, base: "summaries", path: "exactLabel", kind: "kn" },
  { key: "sa.positive", file: `${R}/scopeshift-a.json`, base: "summaries", path: "positiveControlCorrectSupported", kind: "kn" },
  { key: "sa.falseSupported", file: `${R}/scopeshift-a.json`, base: "summaries", path: "falseSupported", kind: "kn" },
  { key: "sa.cases", file: `${R}/scopeshift-a.json`, base: "summaries", path: "cases.n", kind: "value" },
  // ScopeShift B development: builder-labelled
  { key: "dev.V.exact", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.V.exact", kind: "kn", flat: true },
  { key: "dev.V.falseSupported", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.V.falseSupported", kind: "kn", flat: true },
  { key: "dev.V.falseAlarm", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.V.falseAlarm", kind: "kn", flat: true },
  { key: "dev.V.correctSupported", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.V.correctSupported", kind: "kn", flat: true },
  { key: "dev.B1.falseSupported", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.B1.falseSupported", kind: "kn", flat: true },
  { key: "dev.B2.falseSupported", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.B2.falseSupported", kind: "kn", flat: true },
  { key: "dev.B3.exact", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.B3.exact.meanWorst", kind: "meanWorst", flat: true },
  { key: "dev.B3.falseSupported", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.B3.falseSupported.meanWorst", kind: "meanWorst", flat: true },
  { key: "dev.B4.exact", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.B4.exact.meanWorst", kind: "meanWorst", flat: true },
  { key: "dev.B4.falseSupported", file: `${R}/scopeshift-b-dev.json`, base: "summaries", path: "dev.B4.falseSupported.meanWorst", kind: "meanWorst", flat: true },
  // ScopeShift B held-out: a second look, see evals/ERRATA.md E-005
  { key: "ho.V.exact", file: `${R}/scopeshift-b-held-out.json`, base: "summaries", path: "heldout.V.exact", kind: "kn", flat: true },
  { key: "ho.V.falseSupported", file: `${R}/scopeshift-b-held-out.json`, base: "summaries", path: "heldout.V.falseSupported", kind: "kn", flat: true },
  { key: "ho.V.falseAlarm", file: `${R}/scopeshift-b-held-out.json`, base: "summaries", path: "heldout.V.falseAlarm", kind: "kn", flat: true },
  { key: "ho.B3.exact", file: `${R}/scopeshift-b-held-out.json`, base: "summaries", path: "heldout.B3.exact.meanWorst", kind: "meanWorst", flat: true },
  { key: "ho.B3.falseSupported", file: `${R}/scopeshift-b-held-out.json`, base: "summaries", path: "heldout.B3.falseSupported.meanWorst", kind: "meanWorst", flat: true },
  { key: "ho.B4.falseSupported", file: `${R}/scopeshift-b-held-out.json`, base: "summaries", path: "heldout.B4.falseSupported.meanWorst", kind: "meanWorst", flat: true },
  // Identity
  { key: "id.falseMerge", file: `${R}/identityshift.json`, base: "summaries", path: "resolver.falseMergeRate", kind: "kn" },
  { key: "id.fuzzyFalseMerge", file: `${R}/identityshift.json`, base: "summaries", path: "fuzzyNameBaseline.falseMergeRate", kind: "kn" },
  { key: "id.families", file: `${R}/identityshift.json`, base: "summaries", path: "cases.families", kind: "value" },
  // DiscoveryShift
  { key: "disc.mapped.run1", file: `${R}/discoveryshift.json`, base: "summaries", path: "full.run1.mappedCorrectlyWhenItMustMap", kind: "kn", flat: true },
  { key: "disc.mapped.run2", file: `${R}/discoveryshift.json`, base: "summaries", path: "full.run2.mappedCorrectlyWhenItMustMap", kind: "kn", flat: true },
  { key: "disc.falseAccept", file: `${R}/discoveryshift.json`, base: "summaries", path: "full.run1.falseAcceptRate", kind: "kn", flat: true },
  { key: "disc.cases", file: `${R}/discoveryshift.json`, base: "summaries", path: "full.run1.cases", kind: "value", flat: true },
  // TimeShift
  { key: "time.stale", file: `${R}/timeshift.json`, base: "summaries", path: "staleSetEqualsDependentSet", kind: "kn" },
  { key: "time.staleFindings", file: `${R}/timeshift.json`, base: "summaries", path: "overFlagging.staleFindings", kind: "value" },
  { key: "time.affected", file: `${R}/timeshift.json`, base: "summaries", path: "overFlagging.reallyAffected", kind: "value" },
  // FailureShift
  { key: "fail.all", file: `${R}/failureshift.json`, base: "summaries", path: "correctState", kind: "kn" },
  { key: "fail.scoutOwn", file: `${R}/failureshift.json`, base: "summaries", path: "scoutGuard.injections", kind: "kn" },
  // Nightshift receipts on the recorded run
  { key: "route.receipted", file: "output_examples/model-route.json", base: "", path: "recordings.receiptReverified", kind: "value" },
  { key: "route.total", file: "output_examples/model-route.json", base: "", path: "recordings.total", kind: "value" },
  { key: "route.ultra", file: "output_examples/model-route.json", base: "", path: "modelsThatAnswered.nvidia/nemotron-3-ultra-550b-a55b", kind: "value", flat: true },
  { key: "route.lightning", file: "output_examples/model-route.json", base: "", path: "modelsThatAnswered.nvidia/nemotron-3.5-lightning-30b-a3b", kind: "value", flat: true },
  // Product snapshots: the running service in sample mode, taken by scripts/snapshot.mjs
  { key: "usl.tables", file: "video/data/snapshots/usl.json", base: "", path: "tables.length", kind: "value" },
  { key: "usl.studies", file: "video/data/snapshots/usl.json", base: "", path: "dqRules.1.rowsChecked", kind: "value" },
  { key: "usl.failures", file: "video/data/snapshots/usl.json", base: "", path: "dqRules.1.failures", kind: "value" },
  { key: "usl.rules", file: "video/data/snapshots/usl.json", base: "", path: "dqRules.length", kind: "value" },
  { key: "mask.admin", file: "video/data/snapshots/zetaris-masking.json", base: "", path: "admin", kind: "value" },
  { key: "mask.unassigned", file: "video/data/snapshots/zetaris-masking.json", base: "", path: "unassigned", kind: "value" },
  { key: "src.count", file: "video/data/snapshots/sources.json", base: "", path: "length", kind: "value" },
  { key: "case.dimensions", file: "video/data/snapshots/case-eyeart.json", base: "", path: "findings.1.mechanicalCoverage.length", kind: "value" },
  { key: "stages.count", file: "output_examples/api/propose-allowed-source.json", base: "body", path: "stages.length", kind: "value" },
  { key: "drills.count", file: "src/api/contract.ts", kind: "tsArray", name: "DRILLS" },
  { key: "labels.count", file: "src/schemas/common.ts", kind: "tsArray", name: "LABELS", optional: true },
];

// Numbers that live only in prose result files. Each text must appear verbatim in its file or the build fails.
export const LITERALS = [
  { key: "scout.heldout", text: "9 of 24", file: "README.md", kind: "kn", k: 9, n: 24 },
  // docs/zetaris-usl-reflection.md, "What it saved, measured": the same question three ways, medians of nine timed rounds.
  { key: "usl.ms.reads", text: "| 294 ms |", file: "docs/zetaris-usl-reflection.md", kind: "value", value: 294 },
  { key: "usl.ms.hand", text: "| 861 ms |", file: "docs/zetaris-usl-reflection.md", kind: "value", value: 861 },
  { key: "usl.ms.layer", text: "| 1,189 ms |", file: "docs/zetaris-usl-reflection.md", kind: "value", value: 1189 },
  { key: "usl.lines.reads", text: "48 lines of TypeScript", file: "docs/zetaris-usl-reflection.md", kind: "value", value: 48 },
  { key: "usl.lines.hand", text: "about 40 lines of formatted SQL", file: "docs/zetaris-usl-reflection.md", kind: "value", value: 40 },
  { key: "usl.lines.layer", text: "| 4 lines |", file: "docs/zetaris-usl-reflection.md", kind: "value", value: 4 },
];
