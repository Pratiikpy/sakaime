import { loadAdjudication, loadGold, runAllText, unadjudicatedExtras } from "./measurement.ts";
const gold = loadGold();
const runs = await runAllText();
for (const r of unadjudicatedExtras(gold, runs, loadAdjudication())) {
  console.log(`${r.doc} ${r.key} ${r.ci ? JSON.stringify(r.ci) : ""} [${r.qualifiers.join(",")}]\n    ${r.passage.slice(0, 260)}`);
}
