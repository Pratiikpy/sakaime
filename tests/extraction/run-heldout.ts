/**
 * Scores the parser on PDFs it was not developed on, read through pdfjs.
 * SAKAIME_HELDOUT_DIR=<dir holding K253801.pdf ...> npx tsx tests/extraction/run-heldout.ts [--verbose]
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFdaSummary, type FdaSummaryExtraction } from "../../src/extraction/fda-summary.ts";
import { formatReport, measureFda, resultKey, type Adjudication, type Gold } from "../../src/extraction/measure.ts";
import { readPdf } from "../../src/extraction/pdf.ts";
import { isUsable } from "../../src/extraction/verify.ts";

const dir = process.env.SAKAIME_HELDOUT_DIR;
if (!dir || !existsSync(dir)) {
  console.log("SKIPPED: set SAKAIME_HELDOUT_DIR to the directory holding the held-out PDFs (URLs are in fda-heldout-gold.json).");
  process.exit(0);
}
const goldPath = join(import.meta.dirname, "gold", "fda-heldout-gold.json");
const gold = JSON.parse(readFileSync(goldPath, "utf8")) as Gold;
const adjPath = join(import.meta.dirname, "gold", "fda-heldout-adjudication.json");
const adjudication: Adjudication = existsSync(adjPath) ? (JSON.parse(readFileSync(adjPath, "utf8")) as { verdicts: Adjudication }).verdicts : {};

const runs: Record<string, FdaSummaryExtraction> = {};
for (const id of Object.keys(gold.docs)) {
  const bytes = new Uint8Array(readFileSync(join(dir, `${id}.pdf`)));
  const sha = createHash("sha256").update(bytes).digest("hex");
  const { doc } = await readPdf(id, bytes);
  console.log(`${id} sha256 ${sha.slice(0, 16)} pages ${doc.pages.length} ${doc.warnings.length ? `warnings: ${doc.warnings.join("; ")}` : ""}`);
  runs[id] = await parseFdaSummary(doc);
}
const report = measureFda(gold, runs, adjudication);
console.log(formatReport(report));

if (process.argv.includes("--verbose")) {
  for (const [id, run] of Object.entries(runs)) {
    const g = gold.docs[id];
    if (!g) continue;
    const goldKeys = new Set(g.results.map((r) => resultKey(r.metric, r.value, r.kind)));
    for (const k of run.extraction.kept) {
      const p = k.assertion.predicate;
      const state = isUsable(k) ? "USABLE" : k.assertion.supportVerified;
      const q = (k.detail.qualifiers ?? []).join(",");
      if (/^(result|performance_goal)\./.test(p)) {
        const kind = p.startsWith("performance_goal.") ? "goal" : "observed";
        const key = resultKey(p.split(".")[1] as string, Number(k.assertion.value), kind);
        console.log(`${id} ${goldKeys.has(key) ? "gold " : "EXTRA"} ${state} ${key} [${q}] ${k.anchor.text.replace(/\s+/g, " ").slice(0, 100)}`);
      } else if (/^(device\.version|population\.age_|indication\.setting_term|document\.cites_nct)/.test(p)) {
        console.log(`${id} ${p} ${JSON.stringify(k.assertion.value)} ${state} [${q}]`);
      }
    }
  }
}
