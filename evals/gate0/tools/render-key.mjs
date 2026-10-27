// Renders ANSWER-KEY.md from claims.jsonl and claims-pass2.json. Run after build-claims.mjs.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate0Root } from "./lib.mjs";

const claims = readFileSync(join(gate0Root, "claims.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const p2 = JSON.parse(readFileSync(join(gate0Root, "claims-pass2.json"), "utf8"));
const short = (s, n) => (s.length > n ? s.slice(0, n - 1) + "..." : s);
const count = (f) => claims.filter(f).length;
const dist = {};
for (const c of claims) dist[c.key.expectedLabel] = (dist[c.key.expectedLabel] ?? 0) + 1;

const L = [];
L.push("# Same-input test: answer key (Gate 0, G2)", "");
L.push("All 26 claims are **CONSTRUCTED**: written for this test in the style of a vendor claim. None is a statement by any vendor and none says anything about any vendor. Every device, identifier, version, population, setting, endpoint and number they rely on is a real record from `research/feasibility/fixtures` or `evals/gate0/raw`, anchored below with a verbatim quote, a printed page where the source is a PDF, and the record's sha256. Machine-readable twin: `claims.jsonl` (claim and evidence shapes validate against `src/schemas/scope.ts`; `evidence-sets.json` holds the evidence items).", "");
L.push("Label: **single builder, two passes, not independent.** The claims, the scopes and the pass-1 key were written by one agent; pass 2 is a mechanical oracle (`tools/build-claims.mjs`) over the same structured scopes, which checks the key's internal consistency, not its truth. No clinician or second human has read the key (docs/05 G6 open).", "");
L.push("## Coverage of the requested mismatch kinds", "", "| kind | claims |", "|---|---|");
const cover = [
  ["narrower indication", "EA-05 (v2.2.0 indication excludes prior DR), LU-03 (target findings)"],
  ["different software version", "TR-02, VZ-02, PG-01, HF-01, LU-02"],
  ["different age range", "EA-02, GI-01, CP-01"],
  ["different setting", "ID-02"],
  ["superseded submission", "EA-03 (K223357 follows K200667)"],
  ["shared device name across K-numbers", "BC-02 (35 AI-list rows are named BriefCase)"],
  ["missing study", "MS-01 (registry protocol, no results), HF-01"],
  ["version mismatch, Transpara 1.7.2 vs 1.7.0", "TR-02"],
  ["intended-use mismatch, Lunit triage vs TB screening", "LU-02"],
  ["De Novo with many GUDID versions, Viz LVO", "VZ-02 (11 GUDID versions under DEN170073)"],
  ["intended-use mismatch, other", "EA-04, MS-02"],
  ["exclusion criterion", "AN-02"],
  ["clean positive controls", "EA-01, TR-01, LU-01, VZ-01, BC-01, PG-02, GI-02, AN-01, ID-01 (9 claims, 35%)"],
];
for (const [k, v] of cover) L.push(`| ${k} | ${v} |`);
L.push("", "## Label distribution", "", "| label | claims |", "|---|---|");
for (const [k, v] of Object.entries(dist)) L.push(`| ${k} | ${v} |`);
L.push("", `Contestable keys: ${count((c) => c.key.keyConfidence === "contestable")} of ${claims.length}. For a contestable key, \`acceptableLabels\` lists the other labels that withhold support; scoring reports the exact label and the acceptable-or-exact label separately (PROTOCOL.md). SUPPORTED_FOR_SCOPE or SUPPORTED_ONLY_FOR_NARROWER_SCOPE on any claim whose key is lower is a false-supported error, never acceptable.`, "");
L.push("## Semantics the key assumes (the lead's compiler must match or the key is not applicable)", "", "1. A dimension is in play only if the claim specifies it. A claim silent on a dimension makes no assertion on it. If the compiler instead treats a claim-unspecified dimension as UNKNOWN, no positive control can ever be SUPPORTED_FOR_SCOPE.", "2. Evidence silent on a dimension the claim specifies is UNKNOWN, which yields INSUFFICIENT_EVIDENCE (docs/02 s10).", "3. Evidence exclusions the claim does not also exclude widen the claimed population (PARTIAL). That is why positive controls list the evidence's exclusions.", "4. A different release string is DISJOINT unless a source states equivalence; GUDID labels establish marketed releases, not studied ones.", "5. Evidence about another version is not used for the other dimensions of a claim that names a version.", "6. A claim that specifies a date against older evidence needs a reviewer (no source threshold): REQUIRES_DOMAIN_REVIEW.", "7. Setting, purpose and condition strings are the key's own vocabulary; the lead maps them. Country is not a scored dimension (GI-02 is an Italian study).", "");
L.push("## Pass 2 (oracle) result", "", `Oracle agrees with the pass-1 key on ${p2.results.filter((r) => r.agree).length} of ${p2.results.length} claims. Disagreements:`, "");
for (const d of p2.disagreements) L.push(`- **${d.id}**: key ${d.passOne}, oracle ${d.oracle}. The oracle cannot emit CONTRADICTED_BY_SPECIFIED_EVIDENCE (it has no rule for a text that negates a use); the key's acceptable labels include the oracle's label. Resolution: kept as a contestable key.`);
L.push("", "### Key defects found and fixed while doing pass 2", "", "These were errors in the first draft of the key, found when the oracle or a re-read disagreed. They are listed because they show the key is fallible and because the same defects could recur in other keys.", "", "- **ID-02** was first written with a claim limited to eye-care clinics. A narrower scope must lie inside the claimed scope, so no narrower scope existed and the key was wrong. The claim now covers primary care and eye care.", "- **PG-01** first listed FDA's own reader study as evidence next to the published Alpha-build paper; with it the claim is simply supported. The evidence set is now the cited paper only, and the note says that a system answering from FDA's study answers a different question.", "- **Invented values** in three evidence items (a clearance date for Transpara, a 'pathology lab' setting for Paige, a 2014 date for the NXT trial) were not in any anchored quote. They were removed; nothing in the key rests on a value without an anchor.", "- `EA-02` was written with age 12 from the start on purpose: the FDA indication says 'adults', which leaves 18 to 21 ambiguous, so the key avoids that edge. The 18-to-21 ambiguity is recorded as discrepancy D4 in EYEART-CHAIN.md and is not scored.", "");
L.push("### Changes made after seeing a system output (disclosed because they could bias the key toward that system)", "", "On 2026-10-27, after the key and the evidence items were written, a throwaway dry run fed the key's claims and evidence items to the in-progress `src/compiler` (unmapped vocabulary, `requiredDimensions` set to the dimensions each claim specifies). It is not the Sakaime arm and is not scored. It changed the key in two ways, and it was kept to these two:", "", "1. **Evidence typing.** The first encoding put analysis-population facts (age floor 22, pacing exclusion, 40-80 study ages) inside `authorization` items although the FDA indications say only 'adults' or name no age. That was a modelling error of mine, found because the compiler read the age as an explicit authorization limit. The items are now split into an `authorization` item (what the indication says) and a `study` item (what the pivotal or validation study covered) for EA (K200667, K223357), GI-Genius, Anumana and IDx-DR. No label was changed. On the corrected encoding the compiler dry run returned INSUFFICIENT_EVIDENCE for 10 claims whose key differs (EA-01, EA-02, EA-03, EA-05, GI-01, GI-02, AN-01, AN-02, ID-01, ID-02), including the positive controls EA-01, GI-02, AN-01 and ID-01; I kept the faithful encoding rather than reshape it to please the compiler, and that divergence is a finding for the lead, not a key edit (see PROTOCOL.md section 7).", "2. **CP-01** acceptable set widened to include CONTRADICTED_BY_SPECIFIED_EVIDENCE, because an explicit 'adult patients' limit can reasonably be read as contradicting a claim for children. Both labels withhold support; the exact label stays SUPPORTED_ONLY_FOR_NARROWER_SCOPE.", "");
L.push("## The key, claim by claim", "");
for (const c of claims) {
  const u = c.claimedUse;
  L.push(`### ${c.id}: ${c.device} (${c.kind})`, "", `**CONSTRUCTED claim.** ${c.text}`, "", `Claimed use: product \`${u.product}\`, version ${u.version ?? "unspecified"}, population ${JSON.stringify(u.population) ?? "unspecified"}, setting ${JSON.stringify(u.setting)}, purpose \`${u.purpose}\`, date ${u.date ?? "unspecified"}.`, "", `**Expected: ${c.key.expectedLabel}**` + (c.key.acceptableLabels.length ? ` (also acceptable, withholding support: ${c.key.acceptableLabels.join(", ")})` : "") + `. Key confidence: ${c.key.keyConfidence}. Mismatch dimension(s): ${c.key.mismatchDimensions.length ? c.key.mismatchDimensions.join(", ") : "none (positive control)"}.` + (c.key.supportedNarrowerScope ? ` Supported narrower scope: ${c.key.supportedNarrowerScope}.` : ""), "", c.key.note, "", "Evidence for the key:", "");
  for (const q of c.keyQuotes) L.push(`- \`${q.id}\` (${q.source.replace("research/feasibility/fixtures/", "fixtures/")}${q.printedPage ? `, printed page ${q.printedPage}` : ""}, sha256 ${q.sha256.slice(0, 12)}): "${short(q.quote.replace(/\[\.\.\.\]/g, "[...]"), 260)}"`);
  L.push("");
}
writeFileSync(join(gate0Root, "ANSWER-KEY.md"), L.join("\n"));
console.log("wrote ANSWER-KEY.md", L.length, "lines");
