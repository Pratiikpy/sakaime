/**
 * Runs the DiscoveryShift suite and writes data/discovery-shift/results.json and RESULTS.md.
 *
 *   npx tsx tests/discovery/shift/run.ts --mode record          first run: calls the model, records every reply
 *   npx tsx tests/discovery/shift/run.ts --mode replay          offline: replays the recorded replies
 *   npx tsx tests/discovery/shift/run.ts --mode live            calls the model again without recording (repeat runs)
 *   add  --arms full,lexical,nojoin   which arms to run (default all three)
 *   add  --only A-C-01,A-R-01         a subset (nothing is written then)
 *   add  --label run2                 names a repeat run in results.json
 *
 * The model key is read from the repository .env and is never printed.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASSETTE_DIR, SHIFT_DIR, runSuite, type Arm, type CaseResult, type Mode, type Sealed } from "./suite.ts";
import { rate, wilson, pctText, type Category } from "./score.ts";

const args = process.argv.slice(2);
const flag = (name: string, fallback: string): string => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1]! : fallback;
};
const mode = flag("mode", "replay") as Mode;
const arms = flag("arms", "full,lexical,nojoin").split(",") as Arm[];
const only = args.includes("--only") ? flag("only", "").split(",") : undefined;
const label = flag("label", "run1");

interface ArmRun {
  arm: Arm;
  mode: Mode;
  label: string;
  at: string;
  results: CaseResult[];
}

const ORDER = ["run1", "run2", "replay-items-1-8", "live2", "live3"];
const ARMS = ["full", "lexical", "nojoin"];
const ordered = (runs: ArmRun[]): ArmRun[] => [...runs].sort((a, b) => ORDER.indexOf(a.label) - ORDER.indexOf(b.label) || ARMS.indexOf(a.arm) - ARMS.indexOf(b.arm));

function loadPrior(): ArmRun[] {
  const p = join(SHIFT_DIR, "results.json");
  return existsSync(p) ? (JSON.parse(readFileSync(p, "utf8")) as { runs: ArmRun[] }).runs : [];
}

const count = (rs: CaseResult[], c: Category): number => rs.filter((r) => r.category === c).length;

function headline(rs: CaseResult[], sealed: Sealed, which: "pipeline" | "baseline") {
  const exp = sealed.expected;
  const scored = rs.filter((r) => !exp[r.id]!.knownLimit);
  const cat = (r: CaseResult): Category => (which === "pipeline" ? r.category : r.baseline.category);
  const lbl = (r: CaseResult) => (which === "pipeline" ? r.label : r.baseline.label);
  const mustMap = scored.filter((r) => exp[r.id]!.expect.length === 1 && exp[r.id]!.expect[0] === "mapped");
  const mayNotMap = scored.filter((r) => !exp[r.id]!.expect.includes("mapped"));
  const optional = scored.filter((r) => exp[r.id]!.expect.includes("mapped") && exp[r.id]!.expect.length > 1);
  const falseAccepts = scored.filter((r) => cat(r) === "false_accept");
  return {
    n: scored.length,
    mustMap: { n: mustMap.length, correct: mustMap.filter((r) => cat(r) === "correct").length, wrong: mustMap.filter((r) => cat(r) === "wrong_mapping").length, falseHold: mustMap.filter((r) => cat(r) === "false_hold").length, falseDecline: mustMap.filter((r) => cat(r) === "false_decline").length },
    mayNotMap: { n: mayNotMap.length, caught: mayNotMap.filter((r) => lbl(r) !== "mapped").length, falseAccept: mayNotMap.filter((r) => cat(r) === "false_accept").length },
    optional: { n: optional.length, ok: optional.filter((r) => cat(r) === "correct").length, falseAccept: optional.filter((r) => cat(r) === "false_accept").length },
    falseAccepts: falseAccepts.map((r) => r.id),
    semanticFalseAccepts: falseAccepts.filter((r) => !["control"].includes(r.class)).length,
  };
}

function classTable(rs: CaseResult[]): string {
  const classes = [...new Set(rs.map((r) => r.class))];
  const rows = classes.map((c) => {
    const xs = rs.filter((r) => r.class === c);
    const g = (k: Category) => count(xs, k);
    return `| ${c} | ${xs.length} | ${g("correct")} | ${g("false_accept")} | ${g("wrong_mapping")} | ${g("false_hold") + g("false_decline")} | ${g("over_refusal") + g("imprecise")} |`;
  });
  return ["| Class | Cases | Correct | False accept | Wrong mapping | False hold or decline | Refused, wrong kind |", "|---|---|---|---|---|---|---|", ...rows].join("\n");
}

function clusterTable(rs: CaseResult[]): string {
  const clusters = [...new Set(rs.map((r) => r.cluster))].sort();
  return ["| Base source | Cases | Correct | False accept | Other misses |", "|---|---|---|---|---|", ...clusters.map((k) => {
    const xs = rs.filter((r) => r.cluster === k);
    return `| ${k} | ${xs.length} | ${count(xs, "correct")} | ${count(xs, "false_accept")} | ${xs.length - count(xs, "correct") - count(xs, "false_accept")} |`;
  })].join("\n");
}

function armBlock(run: ArmRun, sealed: Sealed, withBaseline = false): string {
  const h = headline(run.results, sealed, "pipeline");
  const b = headline(run.results, sealed, "baseline");
  const line = (name: string, x: ReturnType<typeof headline>) =>
    `| ${name} | ${rate(x.mustMap.correct, x.mustMap.n)} | ${x.mustMap.falseHold} / ${x.mustMap.falseDecline} / ${x.mustMap.wrong} | ${rate(x.mayNotMap.caught, x.mayNotMap.n)} | ${x.falseAccepts.length} (${x.falseAccepts.join(", ") || "none"}) |`;
  return ["| Arm | Mapped correctly (cases that must map) | False hold / false decline / wrong mapping | Caught (cases that must not register) | False accepts, all cases |", "|---|---|---|---|---|", line(`${run.arm} (${run.label})`, h), line("hardcoded ETL baseline", b)].join("\n");
}

function failures(run: ArmRun, sealed: Sealed): string {
  const bad = run.results.filter((r) => r.category !== "correct" && !sealed.expected[r.id]!.knownLimit);
  if (bad.length === 0) return "None.";
  return bad
    .map((r) => {
      const e = sealed.expected[r.id]!;
      const spec = sealed.cases.find((c) => c.id === r.id)!;
      return `- **${r.id}** (${r.class}: ${spec.mutation}). Expected ${e.expect.join(" or ")}, got ${r.label}; ${r.category.replace("_", " ")}${r.detail ? ` (${r.detail})` : ""}. ${r.reason ? `System reason: ${r.reason.slice(0, 260)}` : ""}${r.open.length ? ` Open fields: ${r.open.map((o) => `${o.sourceField} as ${o.canonicalField} ${o.check}`).join("; ")}.` : ""}`;
    })
    .join("\n");
}

async function main(): Promise<void> {
  if (args.includes("--report-only")) {
    const saved = JSON.parse(readFileSync(join(SHIFT_DIR, "results.json"), "utf8")) as { runs: ArmRun[] };
    const { loadSealed } = await import("./suite.ts");
    writeFileSync(join(SHIFT_DIR, "RESULTS.md"), report(ordered(saved.runs), loadSealed()));
    return;
  }
  const prior = only ? [] : loadPrior().filter((r) => !(r.label === label && arms.includes(r.arm)));
  const fresh: ArmRun[] = [];
  let sealed: Sealed | undefined;
  for (const arm of arms) {
    process.stderr.write(`\n== arm ${arm}, mode ${mode}${only ? ` (${only.length} cases)` : ""}\n`);
    const { results, sealed: s } = await runSuite({ mode, arm, ...(only ? { only } : {}), log: (l) => process.stderr.write(`${l}\n`) });
    sealed = s;
    fresh.push({ arm, mode, label, at: new Date().toISOString(), results });
  }
  if (only || !sealed) return;
  const runs = ordered([...prior, ...fresh]);
  writeFileSync(join(SHIFT_DIR, "results.json"), `${JSON.stringify({ sealed: sealed.hashes, runs }, null, 1)}\n`);
  writeFileSync(join(SHIFT_DIR, "RESULTS.md"), report(runs, sealed));
  process.stderr.write("\nwrote data/discovery-shift/results.json and RESULTS.md\n");
}

const RUN_NOTES: Record<string, string> = {
  run1: "the first run on the sealed suite, before any change",
  run2: "the same recorded model replies, after the changes in the errata",
  "replay-items-1-8": "the same replay at the code of errata items 1 to 8",
  live2: "the model called again, on the code of errata items 1 to 8",
  live3: "the model called a third time, on the final code",
};

function report(runs: ArmRun[], sealed: Sealed): string {
  const primary = runs.find((r) => r.arm === "full" && r.label === "run1") ?? runs[0]!;
  const nCases = sealed.cases.length;
  const nLimit = Object.values(sealed.expected).filter((e) => e.knownLimit).length;
  const wilsonNote = (k: number, n: number) => {
    const w = wilson(k, n);
    return `${pctText(w.low)} to ${pctText(w.high)}`;
  };
  const h = headline(primary.results, sealed, "pipeline");
  const notes = existsSync(join(SHIFT_DIR, "NOTES.md")) ? readFileSync(join(SHIFT_DIR, "NOTES.md"), "utf8") : "";
  const parts: string[] = [];
  parts.push(`# DiscoveryShift results

Generated by \`tests/discovery/shift/run.ts\` from \`results.json\`. The ground truth is sealed in \`SEALED.md\` (expected.json \`${sealed.hashes.expected.slice(0, 16)}...\`, cases.json \`${sealed.hashes.cases.slice(0, 16)}...\`); the runner refused to score if either differed.

**What these numbers are.** Consistency results: the pipeline against a policy written from the construction of each mutation (\`SEALED.md\`). They show that the pipeline does what the policy says on layouts it was not tuned on. They do not show that the policy is clinically right, and the labeller is the pipeline's builder. ${nCases} cases over four base sources (12 FDA clearances, 14 ClinicalTrials.gov studies, 11 reported-performance records, 30 bibliography records), so the number of independent clusters is four; the intervals below treat cases as independent and are therefore narrower than the evidence supports. ${nLimit} cases are known limits (undetectable from the response by construction) and are reported separately.

Runs: ${runs.map((r) => `${r.arm}/${r.label} (${r.mode}, ${r.at.slice(0, 10)})`).join(", ")}.
`);
  parts.push(`## Headline: the held-out run (arm "full", ${primary.label}, ${RUN_NOTES[primary.label] ?? primary.label})

${armBlock(primary, sealed, true)}

Counts are over the ${primary.results.length - nLimit} scored cases. Cases that must map: ${h.mustMap.n}. Cases that must not register: ${h.mayNotMap.n}. Optional-column cases (a bare \`n\`, an opaque \`metric_a\`; leaving the column unmapped is correct): ${h.optional.n}, of which correct ${h.optional.ok}, false accept ${h.optional.falseAccept}. False accepts of a semantic mutation: ${h.semanticFalseAccepts}${h.semanticFalseAccepts === 0 ? ` (upper bound ${wilsonNote(0, h.mayNotMap.n + h.optional.n)} over ${h.mayNotMap.n + h.optional.n} cases that could have produced one; zero observed errors do not show zero error in the world)` : " (a critical defect)"}.
`);
  for (const r of runs) {
    if (r === primary) continue;
    parts.push(`## Arm "${r.arm}" (${r.label}: ${RUN_NOTES[r.label] ?? r.label}; ${r.mode})\n\n${armBlock(r, sealed)}\n`);
  }
  parts.push(`## By mutation class (arm "full", ${primary.label})\n\n${classTable(primary.results)}\n\n## By base source\n\n${clusterTable(primary.results)}\n`);
  parts.push(`## Every miss (arm "full", ${primary.label})\n\n${failures(primary, sealed)}\n`);
  const after = runs.find((x) => x.arm === "full" && x.label === "run2");
  if (after && after !== primary) parts.push(`## Every miss after the errata (arm "full", run2)

These cases were scored after fixes made because of the run above, so they are no longer held-out for the behaviours that changed.

${failures(after, sealed)}
`);
  const limits = primary.results.filter((r) => sealed.expected[r.id]!.knownLimit);
  if (limits.length) {
    parts.push(`## Known limits (not in the headline)\n\n${limits.map((r) => `- **${r.id}**: outcome ${r.label}. ${sealed.expected[r.id]!.knownLimit}.`).join("\n")}\n`);
  }
  const full = runs.filter((r) => r.arm === "full");
  if (full.length > 1) {
    parts.push(`## Repeat runs of arm "full"\n\n| Run | Mode | False accepts | Mapped correctly | Caught |\n|---|---|---|---|---|\n${full.map((r) => {
      const x = headline(r.results, sealed, "pipeline");
      return `| ${r.label} | ${r.mode} | ${x.falseAccepts.length} | ${x.mustMap.correct}/${x.mustMap.n} | ${x.mayNotMap.caught}/${x.mayNotMap.n} |`;
    }).join("\n")}\n\nThe worst run is the one to quote.\n`);
  }
  const ab = runs.filter((r) => r.arm !== "full" && r.label === primary.label);
  for (const r of ab) {
    const diff = r.results.filter((x, i) => x.label !== primary.results[i]?.label || x.category !== primary.results[i]?.category);
    parts.push(`## Cases whose result changes when arm "${r.arm}" replaces "full"\n\n${diff.length === 0 ? "None." : diff.map((x) => { const p = primary.results.find((y) => y.id === x.id)!; return `- **${x.id}**: ${p.label} (${p.category}) became ${x.label} (${x.category})`; }).join("\n")}\n`);
  }
  if (notes) parts.push(notes);
  return `${parts.join("\n")}\n`;
}

await main();
