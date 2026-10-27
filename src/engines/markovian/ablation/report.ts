/**
 * Turns the JSON that the MA-3 run wrote into tests/engines/markovian/MA3-RESULTS.md.
 *
 *   npx tsx src/engines/markovian/ablation/report.ts [--in a.json,b.json] [--out tests/engines/markovian/MA3-RESULTS.md]
 *
 * Several result files may be given; later ones add arms run separately on the same documents. Every number is
 * recomputed from the per-document results in the JSON, not copied from a summary.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { ARMS, summarise, type DocResult, type MA3Report } from "./ma3.ts";
import { fmtRate } from "./stats.ts";

const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : d;
};

const root = resolve(import.meta.dirname, "..", "..", "..", "..");
const inputs = arg("in", "tests/engines/markovian/results/ma3-live.json")
  .split(",")
  .map((f) => resolve(root, f.trim()));
const output = resolve(root, arg("out", "tests/engines/markovian/MA3-RESULTS.md"));
type Loaded = MA3Report & { http?: { requests: number; statuses: Record<string, number> } };
const loaded = inputs.map((f) => JSON.parse(readFileSync(f, "utf8")) as Loaded);
const first = loaded[0] as Loaded;
const report: Loaded = { ...first, results: loaded.flatMap((r) => r.results) };
const runs = loaded.map((r, i) => `${relative(root, inputs[i] as string).replace(/\\/g, "/")} (${r.generatedAt}, arms ${[...new Set(r.results.map((x) => x.arm))].join(", ")})`);

const table = (head: string[], rows: string[][]): string => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
const summaries = ARMS.map((a) => summarise(a, report.results as DocResult[])).filter((s) => s.documents > 0);

const md: string[] = [];
md.push("# MA-3: a scope restriction deep in a long document", "");
md.push(
  `Generated from ${runs.map((r) => `\`${r}\``).join("; ")}. ${report.model.live ? `Live model: \`${report.model.label}\` through NVIDIA's hosted API.` : "TEST DOUBLE: this validates the harness and measures no model."}`,
  "",
  `Corpus: ${report.corpus.documents} constructed documents (labelled constructed, no patient data), ${report.corpus.pages} pages and about ${report.corpus.meanBytes.toLocaleString("en-US")} bytes each, seeds ${report.corpus.seeds.join(", ")}. Each holds one scope restriction planted deep in the text (between 60% and 90% of the way through) in an ordinary paragraph, four early facts (software version, operating point, setting, sample size) and decoy sentences that reuse the restriction's key without restricting anything.`,
  "",
);
md.push("## What the arms are", "");
md.push(
  [
    "- **markovian**: the chunked reader with the verified-ledger carryover (flat prompt size, every prompt under 32 KB). The carryover lists each recorded fact with its value.",
    "- **markovian_ids**: the same, with the carryover listing each recorded fact by id, field and page but not by value, so the model has nothing to restate.",
    "- **markovian_no_carryover**: the same chunking with the carryover withheld, to separate what chunking gives from what the carryover gives.",
    `- **single_truncated**: one prompt cut at ${report.config.truncateBytes.toLocaleString("en-US")} bytes, the product's prompt limit less its fixed framing.`,
    `- **single_full**: one prompt holding the whole document (about ${Math.round(report.corpus.meanBytes / 1000)} KB). It exceeds the 32 KB rule the product keeps to, and exists only as the comparator; it goes through a harness client without that rule.`,
    "",
    "All arms use the same instructions, output schema and verification (a quote must exist on the cited page). A call that failed is counted as a failure and shown separately, never as a miss. Prompt tokens are provider-reported when every call reported them.",
  ].join("\n"),
  "",
);
md.push("## Results", "");
md.push(
  table(
    ["Arm", "Restriction found (all documents)", "Planted facts found", "Decoy confusions", "Mean total prompt tokens", "Mean peak tokens in one call", "Calls", "Token source"],
    summaries.map((s) => [s.arm, fmtRate(s.restrictionRecallAll), fmtRate(s.plantedFactRecall), String(s.decoyHits), String(Math.round(s.meanPromptTokensTotal)), String(Math.round(s.meanPromptTokensPeak)), s.meanCalls.toFixed(1), s.tokenLabel]),
  ),
  "",
);
md.push("## Per document", "");
md.push(
  table(
    ["Document", "Arm", "Status", "Restriction found", "Planted facts", "Facts kept", "Facts dropped", "Calls", "Peak prompt tokens", "Seconds", "Note"],
    (report.results as DocResult[]).map((r) => [r.docId, r.arm, r.status, r.status === "OK" ? String(r.restrictionFound) : "n/a", `${r.plantedFound}/${r.plantedTotal}`, String(r.factsVerified), String(r.dropped), String(r.calls), String(r.promptTokensPeak), String(Math.round(r.wallMs / 1000)), (r.reason ?? "").replace(/\|/g, "/")]),
  ),
  "",
);
md.push("## How to read this", "");
md.push(
  [
    "- With four documents the intervals are very wide. A difference of one document between two arms is not evidence of anything.",
    "- The corpus is synthetic and its restriction sentences are written to be findable. Real reports bury restrictions in tables, footnotes and scanned figures that this corpus does not contain.",
    "- One model was used (a 30B-parameter Nemotron without extended reasoning). A stronger model, or the same model with a second pass aimed only at restrictions, may behave differently. Neither was run.",
    "- The reader's verification drops a quote that is reworded. When the carryover shows the model earlier facts it tends to restate them in its own words, and those are dropped (see \"Facts dropped\"); that is the verification doing its job, and it costs recall and uses up the model's answer budget.",
    "- A note saying 'partial' means some replies were cut off at the answer limit and only the complete facts before the cut were kept.",
  ].join("\n"),
  "",
);

mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${md.join("\n")}\n`);
console.log(`wrote ${output}`);
