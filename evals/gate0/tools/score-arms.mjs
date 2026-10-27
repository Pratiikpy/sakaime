// Scores the competitor arms against the answer key.
// Native score: does the arm itself emit a verdict for a claim? Neither accepts a claim, so the native
// verdict count is zero by construction (verified from Constat's tools/list schemas and HealthIT's API).
// Ceiling score: could a careful reviewer re-derive the key's answer from ONLY that arm's output for the claim's
// device? A claim is "derivable" when every fact listed for it below appears in the arm's output. The fact
// lists are written from the answer key (what the key's quotes establish), not from the arm's output.
// Run: node tools/score-arms.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate0Root } from "./lib.mjs";

const claims = readFileSync(join(gate0Root, "claims.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));

const CONSTAT_K = { EA: "K200667", TR: "K221347", LU: "K211733", VZ: "DEN170073", BC: "K253265", MS: "K240301", PG: "DEN200080", GI: "DEN200055", HF: "K213857", AN: "K232699", ID: "DEN180001", CP: "DEN190040" };
const constatDevice = (id) => (id === "EA-05" ? "K223357" : CONSTAT_K[id.slice(0, 2)]);
const HEALTHIT_SLUG = { BC: "aidoc-aios", VZ: "viz-ai-one-platform", HF: "heartflow-analysis-ffrct", LU: "lunit-insight" };

const F = (need, rx) => ({ need, rx });
const AGE22 = /21 years old or younger|\b22 years|aged 22|age 22|22 and older/i;
const PRIMARY = F("primary care setting", /primary care/i);
const FACTS = {
  "EA-01": [F("indication: no previous diagnosis of more than mild DR", /more than mild|not (?:been )?previously diagnosed/i), F("software version 2.1.0", /2\.1\.0/), F("age floor 22", AGE22), PRIMARY, F("eye-care setting", /eye care|ophthalmolog/i)],
  "EA-02": [F("age floor 22", AGE22)],
  "EA-03": [F("successor clearance K223357 or v2.2.0", /K223357|v?2\.2\.0/i)],
  "EA-04": [F("cleared use: detection in patients not previously diagnosed with more than mild DR", /more than mild|not (?:been )?previously diagnosed/i)],
  "EA-05": [F("K223357 indication: no previous diagnosis of diabetic retinopathy", /not been previously diagnosed|no previous diagnosis|previously diagnosed with diabetic retinopathy/i)],
  "TR-01": [F("software version 1.7.2", /1\.7\.2/), F("concurrent reading aid", /concurrent reading aid/i), F("screening population", /screening/i)],
  "TR-02": [F("trial software version 1.7.0", /1\.7\.0/), F("trial identity (MASAI, randomised)", /MASAI|randomi[sz]ed/i)],
  "LU-01": [F("software version 1.0", /version\s*1\.0|\bv1\.0\b/i), F("adult chest X-ray", /adult/i), F("pleural effusion", /pleural effusion/i), F("pneumothorax", /pneumothorax/i)],
  "LU-02": [F("cleared finding pleural effusion", /pleural effusion/i), F("cleared finding pneumothorax", /pneumothorax/i), F("triage purpose", /triage/i)],
  "LU-03": [F("cleared finding pleural effusion", /pleural effusion/i), F("cleared finding pneumothorax", /pneumothorax/i)],
  "VZ-01": [F("initial version 1.0", /version 1\.0|v1\.0/i), F("age older than 22", /older than 22|22 years/i), F("acute setting", /acute/i)],
  "VZ-02": [F("study version 1.0", /version 1\.0|v1\.0|initial version/i), F("marketed release 1.11", /1\.11/)],
  "BC-01": [F("free gas module", /free gas|IFG/i), F("age 18 and older", /18 and older|aged 18/i), F("394 cases", /\b394\b/), F("sensitivity 94.2%", /94\.2/)],
  "BC-02": [F("cleared finding is intra-abdominal free gas", /free gas|IFG/i)],
  "MS-01": [F("registry status or results for NCT05800132", /NCT05800132|recruiting/i)],
  "MS-02": [F("concurrent reading aid / not solely", /concurrent reading|solely/i)],
  "PG-01": [F("published reader study used the Alpha build", /Alpha/i)],
  "PG-02": [F("version 2.1.501", /2\.1\.501/), F("Philips scanner or whole slide images", /Philips|whole slide/i), F("610 slides", /\b610\b/)],
  "GI-01": [F("study age range 40 to 80", /between 40 and 80|40.{0,12}80 years|40-80/i)],
  "GI-02": [F("study age range 40 to 80", /between 40 and 80|40.{0,12}80 years|40-80/i), F("screening or surveillance", /screening|surveillance/i), F("Italian study", /Italy|Italian/i)],
  "HF-01": [F("cleared release v3.plus", /v3\.plus|v3 plus/i)],
  "AN-01": [F("adults at risk for heart failure", /at risk for heart failure/i), F("16,000 records", /16,?000/), F("sensitivity 84.5%", /84\.5/)],
  "AN-02": [F("validation paired ECGs without pacing", /pacing|paced/i)],
  "ID-01": [F("version 2.0.0", /2\.0\.0/), F("age 22 and older", /22 and older|ages? 22/i), PRIMARY, F("Topcon NW400", /NW400/i), F("sensitivity 87.4%", /87\.4|0\.874/)],
  "ID-02": [F("primary-care-only labelling or study", /primary care/i)],
  "CP-01": [F("indication: adult patients only", /adult/i)],
};

const constatText = (k) => {
  const line = readFileSync(join(gate0Root, "arms", "constat", "raw", `${k}.sse`), "utf8").split("\n").find((l) => l.startsWith("data:"));
  const j = JSON.parse(line.slice(5));
  if (j.result?.structuredContent?.status !== "ok") throw new Error(`Constat ${k}: not ok`);
  return JSON.stringify(j.result.structuredContent.data);
};
const ledger = JSON.parse(readFileSync(join(gate0Root, "arms", "healthit", "evidence_all.json"), "utf8")).claims;

const rows = [];
for (const c of claims) {
  const facts = FACTS[c.id];
  if (!facts) throw new Error(`no facts for ${c.id}`);
  const k = constatDevice(c.id);
  const ct = constatText(k);
  const slug = HEALTHIT_SLUG[c.id.slice(0, 2)];
  const hrows = slug ? ledger.filter((r) => r.product_slug === slug) : [];
  const ht = hrows.map((r) => r.claim).join(" ");
  const score = (text) => {
    const found = facts.filter((f) => f.rx.test(text)).map((f) => f.need);
    const missing = facts.filter((f) => !f.rx.test(text)).map((f) => f.need);
    return { found, missing, derivable: missing.length === 0, coverage: `${found.length}/${facts.length}` };
  };
  rows.push({ id: c.id, device: c.device, expected: c.key.expectedLabel, positiveControl: c.kind === "positive control", constat: { lookup: k, nativeVerdict: null, ...score(ct) }, healthit: { productSlug: slug ?? null, rowsReturned: hrows.length, nativeVerdict: null, ...score(ht) } });
}
const tally = (arm, pred = () => true) => {
  const r = rows.filter(pred);
  return { claims: r.length, derivable: r.filter((x) => x[arm].derivable).length };
};
const summary = {
  claims: rows.length,
  nativeVerdictsEmitted: { constat: 0, healthit: 0 },
  derivableFromArmOutput: { constat: tally("constat"), healthit: tally("healthit") },
  derivableOnMismatchClaims: { constat: tally("constat", (x) => !x.positiveControl), healthit: tally("healthit", (x) => !x.positiveControl) },
  derivableOnPositiveControls: { constat: tally("constat", (x) => x.positiveControl), healthit: tally("healthit", (x) => x.positiveControl) },
};
writeFileSync(join(gate0Root, "arms", "scored.json"), JSON.stringify({ method: "see header of tools/score-arms.mjs", summary, rows }, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 1));
console.log(rows.map((r) => `${r.id.padEnd(6)} ${r.expected.slice(0, 12).padEnd(13)} constat ${r.constat.coverage.padEnd(4)} ${r.constat.derivable ? "DERIVABLE" : "-        "} healthit rows=${String(r.healthit.rowsReturned).padEnd(2)} ${r.healthit.coverage.padEnd(4)} ${r.healthit.derivable ? "DERIVABLE" : "-"}`).join("\n"));
