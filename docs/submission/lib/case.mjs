// The EyeArt case as recorded in the committed run: dossier, labels and trace. Everything the walk-through slides show comes from here.
import { json, text } from "./data.mjs";

export const DOSSIER = "output_examples/dossiers/eyeart-k200667.dossier.json";
export const LABELS_FILE = "data/sample/run/labels.json";
export const TRACE = "output_examples/traces/eyeart-k200667.trace.jsonl";
export const body = () => json(DOSSIER).body;

export const labelsRun = () => json(LABELS_FILE).cases.find((c) => c.caseId === "eyeart-k200667");
export const labelOf = (claimId) => {
  const c = labelsRun().claims.find((x) => x.claimId === claimId);
  if (!c) throw new Error(`no recorded label for ${claimId}`);
  return c;
};
export const finding = (claimId) => {
  const f = body().findings.find((x) => x.claimId === claimId);
  if (!f) throw new Error(`no finding for ${claimId}`);
  return f;
};
export const coverage = (claimId, dim) => {
  const row = finding(claimId).mechanicalCoverage.find((d) => d.dimension === dim);
  if (!row) throw new Error(`no ${dim} row for ${claimId}`);
  return row;
};
export const traceEvents = (file = TRACE) => text(file).trim().split("\n").map((l) => JSON.parse(l));
export const claimText = (claimId) => {
  const c = body().claims.find((x) => x.id === claimId);
  return c?.text ?? c?.sentence ?? null;
};
export const caseInput = () => json("input_examples/cases/eyeart-k200667.json");

/** Strip the evidence-type prefix the compiler adds ("study: 2.1.0" stays readable). */
export const short = (s, n = 90) => (s.length > n ? `${s.slice(0, n - 1)}...` : s);
