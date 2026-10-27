import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { documentFromText } from "../../src/extraction/document.ts";
import { parseFdaSummary, type FdaSummaryExtraction } from "../../src/extraction/fda-summary.ts";
import { measureFda, resultKey, type Adjudication, type Gold, type MeasureReport } from "../../src/extraction/measure.ts";
import { isUsable } from "../../src/extraction/verify.ts";

export const FIXTURE_DIR = join(import.meta.dirname, "..", "..", "data", "fixtures", "feasibility", "fda");
export const GOLD_PATH = join(import.meta.dirname, "gold", "fda-gold.json");
export const ADJUDICATION_PATH = join(import.meta.dirname, "gold", "fda-adjudication.json");

export function loadGold(): Gold {
  return JSON.parse(readFileSync(GOLD_PATH, "utf8")) as Gold;
}

export function loadAdjudication(): Adjudication {
  return existsSync(ADJUDICATION_PATH) ? (JSON.parse(readFileSync(ADJUDICATION_PATH, "utf8")) as { verdicts: Adjudication }).verdicts : {};
}

/** Run the parser over the pdftotext fixtures of the 12 devices. */
export async function runAllText(): Promise<Record<string, FdaSummaryExtraction>> {
  const out: Record<string, FdaSummaryExtraction> = {};
  for (const f of readdirSync(FIXTURE_DIR).filter((x) => x.endsWith("_summary_text.txt")).sort()) {
    const id = f.split("_")[0] as string;
    out[id] = await parseFdaSummary(documentFromText(id, readFileSync(join(FIXTURE_DIR, f), "utf8")));
  }
  return out;
}

export function unadjudicatedExtras(gold: Gold, runs: Record<string, FdaSummaryExtraction>, adj: Adjudication) {
  const rows: { doc: string; key: string; passage: string; qualifiers: string[]; ci?: [number, number] }[] = [];
  for (const [id, run] of Object.entries(runs)) {
    const g = gold.docs[id];
    if (!g) continue;
    const goldKeys = new Set(g.results.map((r) => resultKey(r.metric, r.value, r.kind)));
    const seen = new Set<string>();
    for (const k of run.extraction.kept) {
      if (!isUsable(k) || !/^(result|performance_goal)\./.test(k.assertion.predicate)) continue;
      const kind = k.assertion.predicate.startsWith("performance_goal.") ? "goal" : "observed";
      const key = resultKey(k.assertion.predicate.split(".")[1] as string, Number(k.assertion.value), kind);
      if (goldKeys.has(key) || adj[id]?.[key] || seen.has(key)) continue;
      seen.add(key);
      rows.push({ doc: id, key, passage: k.anchor.text.replace(/\s+/g, " "), qualifiers: k.detail.qualifiers ?? [], ...(k.detail.ci ? { ci: k.detail.ci } : {}) });
    }
  }
  return rows;
}

export type { MeasureReport };
export { measureFda };

/** The held-out PDFs, read through pdfjs. Returns undefined when the directory is not given. */
export async function runHeldOut(dir: string | undefined) {
  if (!dir || !existsSync(dir)) return undefined;
  const { readPdf } = await import("../../src/extraction/pdf.ts");
  const gold = JSON.parse(readFileSync(join(import.meta.dirname, "gold", "fda-heldout-gold.json"), "utf8")) as Gold;
  const adjPath = join(import.meta.dirname, "gold", "fda-heldout-adjudication.json");
  const adjudication: Adjudication = existsSync(adjPath) ? (JSON.parse(readFileSync(adjPath, "utf8")) as { verdicts: Adjudication }).verdicts : {};
  const runs: Record<string, FdaSummaryExtraction> = {};
  for (const id of Object.keys(gold.docs)) {
    const { doc } = await readPdf(id, new Uint8Array(readFileSync(join(dir, `${id}.pdf`))));
    runs[id] = await parseFdaSummary(doc);
  }
  return { gold, runs, report: measureFda(gold, runs, adjudication) };
}

/** The 12 development summaries read through pdfjs instead of pdftotext (PDFs fetched separately, not committed). */
export async function runDevelopmentPdfs(dir: string | undefined) {
  if (!dir || !existsSync(dir)) return undefined;
  const { readPdf } = await import("../../src/extraction/pdf.ts");
  const gold = loadGold();
  const runs: Record<string, FdaSummaryExtraction> = {};
  for (const id of Object.keys(gold.docs)) {
    const { doc } = await readPdf(id, new Uint8Array(readFileSync(join(dir, `${id}.pdf`))));
    runs[id] = await parseFdaSummary(doc);
  }
  return { runs, report: measureFda(gold, runs, loadAdjudication()) };
}
