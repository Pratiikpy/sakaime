/**
 * Runs the identity evaluation on the labelled corpus and writes the results.
 *
 *   npx tsx src/identity/run-eval.ts
 *
 * Writes data/identity-corpus/RESULTS.md and src/identity/model.default.json (the model trained on the whole
 * corpus). Reads the pinned FDA AI list to build the reference population for family names.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { hashOf } from "../util/canonical.ts";
import { generatePairs } from "./blocking.ts";
import { defaultCorpusDir, loadCorpus, type Corpus } from "./corpus.ts";
import {
  clusterBootstrap,
  crossFamilySweep,
  recordsOf,
  runInSample,
  runLeaveOneFamilyOut,
  statistics,
  summarise,
  type FitOptions,
  type Interval,
  type Metrics,
  type PairOutcome,
  type Rate,
  wilson,
} from "./evaluate.ts";
import { buildReference } from "./reference.ts";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");

export function loadReference(csvPath = join(repoRoot, "research", "feasibility", "fixtures", "fda", "ai-enabled-devices.csv")) {
  const rows = parse(readFileSync(csvPath, "utf8"), { columns: true, skip_empty_lines: true }) as Record<string, string>[];
  return buildReference(rows.map((r) => r["Device"] ?? ""));
}

const f3 = (x: number | null) => (x === null ? "n/a" : x.toFixed(3));
const rate = (r: Rate) => (r.rate === null ? "n/a (n=0)" : `${f3(r.rate)} (${r.k}/${r.n}; Wilson ${f3(r.lo)} to ${f3(r.hi)})`);
const interval = (i: Interval) => (i.lo === null ? `n/a (${i.clusters} families)` : `${f3(i.point)} (cluster bootstrap ${f3(i.lo)} to ${f3(i.hi)}, ${i.clusters} families)`);

function headlineRows(outcomes: readonly PairOutcome[]): string[] {
  const m = summarise(outcomes);
  return [
    `| Precision (links that are true) | ${rate(m.precision)} | ${interval(clusterBootstrap(outcomes, statistics.precision))} |`,
    `| Recall (true links found as CANDIDATE or CONFIRMED) | ${rate(m.recall)} | ${interval(clusterBootstrap(outcomes, statistics.recall))} |`,
    `| Surfaced recall (true links found or shown as AMBIGUOUS) | ${rate(m.surfacedRecall)} | ${interval(clusterBootstrap(outcomes, statistics.surfacedRecall))} |`,
    `| Correct abstention (AMBIGUOUS pairs left AMBIGUOUS) | ${rate(m.correctAbstention)} | ${interval(clusterBootstrap(outcomes, statistics.correctAbstention))} |`,
    `| False-merge rate (non-matches called a link) | ${rate(m.falseMergeRate)} | |`,
    `| Overconfident on ambiguous (called a link) | ${rate(m.overconfidentOnAmbiguous)} | |`,
    `| Over-rejected on ambiguous (called REJECTED) | ${rate(m.overRejectedOnAmbiguous)} | |`,
    `| Confirmed where truth is not MATCH | ${m.falseConfirms} | must be 0 |`,
    `| Pairs expected to reach CONFIRMED that did | ${rate(m.confirmRecall)} | |`,
    `| Expected mismatch flags present | ${rate(m.flagRecall)} | |`,
  ];
}

function stratumRow(label: string, outcomes: readonly PairOutcome[]): string {
  const m: Metrics = summarise(outcomes);
  return `| ${label} | ${m.pairs} | ${m.byTruth.MATCH}/${m.byTruth.NON_MATCH}/${m.byTruth.AMBIGUOUS} | ${f3(m.precision.rate)} | ${f3(m.recall.rate)} | ${f3(m.surfacedRecall.rate)} | ${f3(m.correctAbstention.rate)} | ${m.falseConfirms} |`;
}

function verdictCounts(outcomes: readonly PairOutcome[], truth: PairOutcome["pair"]["truth"]): string {
  const sel = outcomes.filter((o) => o.pair.truth === truth);
  const count = (v: PairOutcome["verdict"]) => sel.filter((o) => o.verdict === v).length;
  const confirmed = sel.filter((o) => o.state === "CONFIRMED").length;
  return `link ${count("LINK")} (of which confirmed ${confirmed}), abstain ${count("ABSTAIN")}, rejected ${count("NO")}, not proposed ${count("SILENT")}`;
}

function misses(outcomes: readonly PairOutcome[]): string[] {
  const lines: string[] = [];
  for (const o of outcomes) {
    const t = o.pair.truth;
    let kind: string | null = null;
    if (t === "MATCH" && o.verdict !== "LINK") kind = `true link not proposed as a link (${o.verdict.toLowerCase()})`;
    else if (t === "NON_MATCH" && o.verdict === "LINK") kind = "FALSE MERGE";
    else if (t === "AMBIGUOUS" && o.verdict !== "ABSTAIN") kind = `ambiguous pair not left AMBIGUOUS (${o.verdict.toLowerCase()})`;
    if (kind) {
      const w = o.weight === null ? "" : `, ${o.weight} bits`;
      lines.push(`| ${o.pair.id} | ${o.pair.linkType} | ${t} | ${o.state ?? "none"}${w} | ${kind} | ${o.pair.contestable ? "contestable" : o.pair.labelBasis} |`);
    }
  }
  return lines;
}

/** Removes what the builder annotated by hand on studies and papers: use tags, module and the manufacturer. */
function withoutAnnotations(corpus: Corpus): Corpus {
  const records = new Map(corpus.records);
  for (const [id, entry] of corpus.records) {
    const r = entry.record;
    if (r.kind === "Study" || r.kind === "Publication") {
      const { manufacturer: _m, module: _mod, ...rest } = r;
      records.set(id, { family: entry.family, record: { ...rest, purposeTags: [] } });
    }
  }
  return { records, pairs: corpus.pairs };
}

function ablationSection(corpus: Corpus, reference: ReturnType<typeof loadReference>): string[] {
  const full = summarise(runLeaveOneFamilyOut(corpus, reference).outcomes.filter((o) => o.pair.family !== "easy"));
  const bare = summarise(runLeaveOneFamilyOut(withoutAnnotations(corpus), reference).outcomes.filter((o) => o.pair.family !== "easy"));
  return [
    `Studies and papers rely on use tags, module and manufacturer that the builder read from their text; a document extractor would have to supply them. Leave-one-family-out with those fields removed from every study and paper (names, text, identifiers, dates and enrolment stay):`,
    ``,
    `| | With annotations | Without annotations |`,
    `|---|---|---|`,
    `| Precision | ${rate(full.precision)} | ${rate(bare.precision)} |`,
    `| Recall | ${rate(full.recall)} | ${rate(bare.recall)} |`,
    `| Surfaced recall | ${rate(full.surfacedRecall)} | ${rate(bare.surfacedRecall)} |`,
    `| Correct abstention | ${rate(full.correctAbstention)} | ${rate(bare.correctAbstention)} |`,
    `| Confirmed where truth is not MATCH | ${full.falseConfirms} | ${bare.falseConfirms} |`,
  ];
}

function sweepSection(corpus: Corpus, model: ReturnType<typeof runInSample>["model"]): string[] {
  const sweep = crossFamilySweep(corpus, model);
  const states = Object.entries(sweep.byState).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, n]) => `${k} ${n}`).join(", ");
  return [
    `Every pair of records from different device families, under every link type their kinds allow, with the whole-corpus model (which has seen some of these pairs as labelled non-links). Records of different families are different products, studies and papers, so none of these should be a link.`,
    ``,
    `- ${sweep.combinations} combinations: ${states}.`,
    `- Called a link (CONFIRMED or CANDIDATE): ${sweep.links.length}.${sweep.links.length > 0 ? ` ${sweep.links.join("; ")}.` : ""}`,
    `- This is a check on records the labelled pairs do not cover, not a measured precision: it contains only negatives.`,
  ];
}

function blockingSection(corpus: Corpus): string[] {
  const blocked = generatePairs(recordsOf(corpus));
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
  const set = new Set(blocked.pairs.map((p) => key(p.a.id, p.b.id)));
  const matches = corpus.pairs.filter((p) => p.truth === "MATCH");
  const found = matches.filter((p) => set.has(key(p.a, p.b))).length;
  const missed = matches.filter((p) => !set.has(key(p.a, p.b))).map((p) => p.id);
  const all = corpus.pairs;
  const foundAll = all.filter((p) => set.has(key(p.a, p.b))).length;
  return [
    `Blocking keys: manufacturer or alias group, product code, brand token of a name (and brand tokens found in study and paper text), stated use, study size, and every owned or cited identifier.`,
    ``,
    `- Records ${corpus.records.size}; possible pairs ${blocked.totalPossible}; pairs kept ${blocked.pairs.length}; comparisons avoided ${(blocked.reduction * 100).toFixed(1)}%.`,
    `- True links reachable after blocking: ${rate(wilson(found, matches.length))}.`,
    `- All labelled pairs reachable after blocking: ${foundAll}/${all.length}.`,
    ...(missed.length > 0 ? [`- Labelled links that blocking would have lost: ${missed.join(", ")}.`] : []),
  ];
}

export interface RunOutput {
  markdown: string;
  modelJson: string;
}

export function runEvaluation(corpus: Corpus, reference: ReturnType<typeof loadReference>, date: string): RunOutput {
  const cv = runLeaveOneFamilyOut(corpus, reference);
  const inSample = runInSample(corpus, reference);
  const hard = (o: readonly PairOutcome[]) => o.filter((x) => x.pair.family !== "easy");
  const easy = cv.outcomes.filter((x) => x.pair.family === "easy");
  const cvHard = hard(cv.outcomes);
  const families = new Set(cvHard.map((o) => o.pair.family));

  const byKind = new Map<string, number>();
  for (const { record } of corpus.records.values()) byKind.set(record.kind, (byKind.get(record.kind) ?? 0) + 1);
  const byLink = new Map<string, number>();
  for (const p of corpus.pairs) byLink.set(p.linkType, (byLink.get(p.linkType) ?? 0) + 1);
  const corpusHash = hashOf({ records: [...corpus.records.values()], pairs: corpus.pairs });

  const sensitivity: FitOptions[] = [{ upperFloorBits: 0 }, { upperFloorBits: 2 }, { upperFloorBits: 4 }];
  const sensRows = sensitivity.map((fit) => {
    const run = runLeaveOneFamilyOut(corpus, reference, fit);
    const m = summarise(hard(run.outcomes));
    return `| ${fit.upperFloorBits} | ${f3(m.precision.rate)} (${m.precision.k}/${m.precision.n}) | ${f3(m.recall.rate)} (${m.recall.k}/${m.recall.n}) | ${f3(m.surfacedRecall.rate)} | ${f3(m.correctAbstention.rate)} | ${m.falseConfirms} |`;
  });

  const linkTypes = ["SAME_SUBMISSION", "SAME_PRODUCT", "SAME_MARKETED_VERSION", "STUDY_EVALUATES", "PUBLICATION_REPORTS"] as const;
  const cvConfirmedWrong = cvHard.filter((o) => o.state === "CONFIRMED" && o.pair.truth !== "MATCH");

  const md: string[] = [
    `# Identity resolution: measured results`,
    ``,
    `Run date ${date}. Produced by \`npx tsx src/identity/run-eval.ts\`; every figure below is computed by that run from the files in this folder.`,
    `Corpus hash ${corpusHash.slice(0, 16)}; model hash ${cv.model.training.contentHash.slice(0, 16)}; scorer \`${cv.model.method}\`.`,
    ``,
    `## What was run`,
    ``,
    `The resolver in \`src/identity\` was run on every labelled pair in \`pairs.json\`. Records are in \`records.json\`; each carries a \`fixtureRef\` to the pinned public data in \`research/feasibility/fixtures\`, and \`tests/identity/corpus.test.ts\` re-checks that the quoted fields still match those files.`,
    ``,
    `- ${corpus.records.size} records (${[...byKind].map(([k, n]) => `${n} ${k}`).join(", ")}) from ${families.size} device families plus ${easy.length} unrelated-pair controls.`,
    `- ${corpus.pairs.length} labelled pairs (${[...byLink].map(([k, n]) => `${n} ${k}`).join(", ")}). Truth: ${verdictTruth(corpus)}.`,
    `- Every label is builder-labelled by one reader (the builder), not independently reviewed. ${corpus.pairs.filter((p) => p.contestable).length} pairs are marked contestable. ${corpus.pairs.filter((p) => p.labelBasis === "identifier").length} labels rest on an identifier or structured field in the records; ${corpus.pairs.filter((p) => p.labelBasis === "reading").length} rest on the builder reading text.`,
    `- purposeTags, module, and the manufacturer of studies and papers were annotated by the builder from the quoted text (the manufacturer by a fixed vendor-name scan). They stand in for what a document extractor would supply.`,
    ``,
    `System output counted as a link: CONFIRMED or CANDIDATE. AMBIGUOUS is abstention. REJECTED is a refusal. A pair not proposed at all is reported as "not proposed". A model proposal is not used in this run.`,
    ``,
    `## Headline: leave-one-family-out (the figure to read)`,
    ``,
    `For each device family, the scorer was trained on every labelled pair that touches no record of that family, then that family's pairs were resolved. ${cvHard.length} pairs, ${families.size} families.`,
    ``,
    `| Measure | Pairs as independent | Families as the unit |`,
    `|---|---|---|`,
    ...headlineRows(cvHard),
    ``,
    `Outcomes by truth: MATCH: ${verdictCounts(cvHard, "MATCH")}. NON_MATCH: ${verdictCounts(cvHard, "NON_MATCH")}. AMBIGUOUS: ${verdictCounts(cvHard, "AMBIGUOUS")}.`,
    ``,
    `Unrelated-pair controls (${easy.length}): ${verdictCounts(easy, "NON_MATCH")}.`,
    ``,
    `## For comparison: trained and scored on the same pairs`,
    ``,
    `Optimistic, since the model has seen every pair it is scored on. The gap to the table above is the cost of unseen devices.`,
    ``,
    `| Measure | Pairs as independent | Families as the unit |`,
    `|---|---|---|`,
    ...headlineRows(hard(inSample.outcomes)),
    ``,
    `## By link type and by label quality (leave-one-family-out, hard pairs)`,
    ``,
    `| Stratum | Pairs | Match/Non/Amb | Precision | Recall | Surfaced recall | Correct abstention | False confirms |`,
    `|---|---|---|---|---|---|---|---|`,
    ...linkTypes.map((lt) => stratumRow(lt, cvHard.filter((o) => o.pair.linkType === lt))),
    stratumRow("labelled by identifier", cvHard.filter((o) => o.pair.labelBasis === "identifier")),
    stratumRow("labelled by reading", cvHard.filter((o) => o.pair.labelBasis === "reading")),
    stratumRow("firm labels", cvHard.filter((o) => !o.pair.contestable)),
    stratumRow("contestable labels", cvHard.filter((o) => o.pair.contestable)),
    ``,
    `## Where the system and the labels disagree (leave-one-family-out, hard pairs)`,
    ``,
    `| Pair | Link type | Truth | System | Disagreement | Label basis |`,
    `|---|---|---|---|---|---|`,
    ...misses(cvHard),
    ``,
    `A true link shown as AMBIGUOUS is not lost: it reaches the reviewer with its waterfall and flags. A true link not proposed at all is a miss of recall.`,
    ``,
    `## Safety invariants`,
    ``,
    `- CONFIRMED results whose truth is not MATCH: ${cvConfirmedWrong.length} in leave-one-family-out, ${hard(inSample.outcomes).filter((o) => o.state === "CONFIRMED" && o.pair.truth !== "MATCH").length} in the whole-corpus fit.`,
    `- CONFIRMED results reached without an exact identifier: ${cvHard.filter((o) => o.state === "CONFIRMED" && o.candidateClass !== "EXACT-IDENTIFIER").length}. Only an exact identifier or a reviewer decision produces CONFIRMED; the scorer cannot (tests/identity/properties.test.ts).`,
    ``,
    `## Without the builder's annotations`,
    ``,
    ...ablationSection(corpus, reference),
    ``,
    `## Unlabelled cross-family sweep`,
    ``,
    ...sweepSection(corpus, inSample.model),
    ``,
    `## Blocking`,
    ``,
    ...blockingSection(corpus),
    ``,
    `## Sensitivity to the strong-candidate floor`,
    ``,
    `The strong band starts at the larger of the highest-scoring training non-link and a fixed floor in bits of evidence (a likelihood ratio of 2^floor to 1). The floor is a design choice. It was 4 in the first run and was lowered to 2 after that run showed correct SAME_PRODUCT links all scoring between 3 and 4 bits. The corroboration gate, not the floor, is the main safeguard against false candidates. Leave-one-family-out results at three floors:`,
    ``,
    `| Floor (bits) | Precision | Recall | Surfaced recall | Correct abstention | False confirms |`,
    `|---|---|---|---|---|---|`,
    ...sensRows,
    ``,
    `## Changes made after seeing results (disclosed)`,
    ``,
    `This corpus was used both to design and to evaluate the resolver, so the figures above are development-set figures. Changes made after a first run exposed errors:`,
    ``,
    `1. SAME_MARKETED_VERSION is rejected whenever two fully specified release labels disagree, whether or not the records share a submission (the first version required a shared submission).`,
    `2. The strong-candidate floor was lowered from 4 to 2 bits (see above).`,
    `3. A strong candidate now needs two independent kinds of positive evidence (name, manufacturer, design numbers, equal version, product code); agreement of intended use is context, not independent evidence. A name shared by several list rows needs agreeing use before it counts as a name.`,
    `4. Manufacturer agreement is not counted as independent when the product name contains the company name (Paige Prostate, Lunit INSIGHT).`,
    `5. Pairs with a matching brand but disagreeing details are surfaced as AMBIGUOUS with their flags instead of being dropped, because the mismatch is what a reviewer needs to see.`,
    `6. One label was corrected: pubmed:32371116 against DEN200055 was labelled AMBIGUOUS; its abstract names GI Genius and Medtronic, so it is MATCH.`,
    `7. Abstract text in the records was lengthened to the full abstract.`,
    `8. Blocking on stated use and study size was added after the first run lost four true links that share no brand or manufacturer.`,
    `9. A product name followed by a descriptor ("Lunit INSIGHT CXR Triage") now matches the name without it, a name contained in another record is checked against the multi-row name list like an exact name, and the word "briefcase" is treated as generic only when found in free text, not in another record's name.`,
    `10. Documented product-name drift (IDx-DR and LumineticsCore, Caption Guidance and EchoGPS, ContaCT and Viz LVO) was added as a flag, after the first run showed those renames were invisible to the reviewer.`,
    ``,
    `## Caveats`,
    ``,
    `- Small sample: ${corpus.pairs.length} pairs from ${families.size} device families. Intervals are wide; read the cluster bootstrap, not the Wilson interval, since pairs of one family are not independent.`,
    `- One reader. The labels have not been checked by a second person, let alone an independent expert, and this is not an independent validation.`,
    `- The pairs were chosen from the real collisions in the feasibility report, so the non-matches are harder than a random sample. Precision here is not the precision on a random stream of candidate pairs.`,
    `- Recall depends on annotations a document extractor must supply (purpose, module, manufacturer of studies and papers). Without them it is lower (see the ablation above); precision did not change.`,
    `- A paper that names a device only by a brand carried by a different record (for example "Viz.ai software" against the De Novo named ContaCT) is not linked, because the system does not yet propagate names across linked product records.`,
    `- A publication is not linked to a product through its study: PUBLICATION_REPORTS and STUDY_EVALUATES are resolved separately and not composed.`,
    `- Match weights are ranking evidence in bits under an independence assumption that does not hold; they are not probabilities.`,
    `- Not run: a model adjudication (needs the model route), reviewer confirmation at scale, and any pair outside the 12 devices and their collisions.`,
    ``,
  ];
  return { markdown: md.join("\n"), modelJson: JSON.stringify(inSample.model, null, 1) + "\n" };
}

function verdictTruth(corpus: Corpus): string {
  const c = (t: string) => corpus.pairs.filter((p) => p.truth === t).length;
  return `${c("MATCH")} MATCH, ${c("NON_MATCH")} NON_MATCH, ${c("AMBIGUOUS")} AMBIGUOUS`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const corpus = loadCorpus();
  const reference = loadReference();
  const out = runEvaluation(corpus, reference, new Date().toISOString().slice(0, 10));
  writeFileSync(join(defaultCorpusDir(), "RESULTS.md"), out.markdown, "utf8");
  writeFileSync(join(here, "model.default.json"), out.modelJson, "utf8");
  process.stdout.write(out.markdown);
}
