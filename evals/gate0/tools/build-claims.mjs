// Builds claims.jsonl, evidence-sets.json and claims-pass2.json.
// Pass 1 = the key authored in key-data.mjs. Pass 2 = a mechanical oracle that re-derives the label from the
// claim's structured use and the evidence items' scopes using the label table of docs/02-architecture.md s10,
// without reading the pass-1 label. The oracle is one agent's reading of those rules: single builder, two
// passes, not independent. Every quote is anchored against the raw record; every source hash is checked.
// Run: node tools/build-claims.mjs
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { gate0Root, sha256File, locate, pageLabel, manifestHashes, squash, loadPages } from "./lib.mjs";
import { SRC, ANCHORS, EVIDENCE, CLAIMS } from "./key-data.mjs";

const problems = [];
const hashes = manifestHashes();
const FX = "research/feasibility/fixtures/";

// ---- anchors
const sourceInfo = {};
for (const [id, path] of Object.entries(SRC)) {
  const sha256 = sha256File(path);
  const key = path.startsWith(FX) ? path.slice(FX.length) : null;
  sourceInfo[id] = { path, sha256, ...(key ? { fixturesManifestMatches: hashes.get(key) === sha256 } : {}) };
  if (key && hashes.get(key) !== sha256) problems.push(`hash mismatch vs MANIFEST.md: ${path}`);
}
const anchor = {};
for (const [id, [src, quote]] of Object.entries(ANCHORS)) {
  const path = SRC[src];
  const pages = locate(path, quote);
  if (pages.length === 0) problems.push(`anchor ${id}: quote not found in ${path}`);
  anchor[id] = { id, source: path, sha256: sourceInfo[src].sha256, quote, ...(path.endsWith(".txt") ? { pdfPage: pages[0], printedPage: pageLabel(path, pages[0]) } : {}), occurrences: pages.length };
}

// ---- evidence sets
for (const item of Object.values(EVIDENCE)) {
  for (const a of item.anchors) if (!anchor[a]) problems.push(`evidence ${item.id}: unknown anchor ${a}`);
}
writeFileSync(join(gate0Root, "evidence-sets.json"), JSON.stringify({ note: "Evidence items in the shape of src/schemas/scope.ts EvidenceItemSchema plus an anchors list; scopes are hand-derived from the anchored quotes (single builder). Setting, purpose and condition strings are this key's own vocabulary.", items: Object.values(EVIDENCE).map((e) => ({ ...e, anchors: e.anchors.map((a) => anchor[a]) })) }, null, 2) + "\n");

// ---- the oracle (pass 2)
const RANK = { SUPPORTED_FOR_SCOPE: 4, SUPPORTED_ONLY_FOR_NARROWER_SCOPE: 3, REQUIRES_DOMAIN_REVIEW: 2, INSUFFICIENT_EVIDENCE: 1, CONTRADICTED_BY_SPECIFIED_EVIDENCE: 0 };
const interval = (a) => ({ lo: a.min ?? -Infinity, hi: a.max ?? Infinity });
function ageRel(c, e) {
  if (!c) return null;
  if (!e) return "UNKNOWN";
  const x = interval(c), y = interval(e);
  if (x.lo >= y.lo && x.hi <= y.hi) return "CONTAINED";
  return x.lo <= y.hi && y.lo <= x.hi ? "PARTIAL" : "DISJOINT";
}
function setRel(c, e) {
  if (!c) return null;
  if (!e) return "UNKNOWN";
  if (c.every((v) => e.includes(v))) return "CONTAINED";
  return c.some((v) => e.includes(v)) ? "PARTIAL" : "DISJOINT";
}
function oracle(claim) {
  const u = claim.use;
  const items = claim.evidence.map((id) => EVIDENCE[id]).filter((e) => !e.scope.product || !u.product || e.scope.product === u.product);
  const itemResults = items.map((e) => {
    const s = e.scope;
    const rel = {};
    rel.version = !u.versions ? null : !s.versions ? "UNKNOWN" : u.versions.every((v) => s.versions.includes(v)) ? "CONTAINED" : "DISJOINT";
    rel.age = ageRel(u.population?.age, s.population?.age);
    rel.conditions = setRel(u.population?.conditions, s.population?.conditions);
    // Groups the evidence excluded that the claim does not also exclude widen the claimed population.
    const missingExcl = (s.population?.exclusions ?? []).filter((x) => !(u.population?.exclusions ?? []).includes(x));
    rel.exclusions = missingExcl.length ? "PARTIAL" : null;
    rel.settings = setRel(u.settings, s.settings);
    rel.purpose = !u.purpose ? null : !s.purpose ? "UNKNOWN" : u.purpose === s.purpose ? "CONTAINED" : "DISJOINT";
    const rels = Object.values(rel).filter(Boolean);
    let label;
    if (e.adequate === false) label = "INSUFFICIENT_EVIDENCE";
    else if (rels.some((r) => r === "DISJOINT" || r === "UNKNOWN")) label = "INSUFFICIENT_EVIDENCE";
    else if (rels.some((r) => r === "PARTIAL")) label = "SUPPORTED_ONLY_FOR_NARROWER_SCOPE";
    else label = "SUPPORTED_FOR_SCOPE";
    // No source states a staleness window, so a dated claim against older evidence needs a reviewer.
    if (u.timing?.from && RANK[label] >= 3) label = "REQUIRES_DOMAIN_REVIEW";
    return { evidence: e.id, relations: rel, label };
  });
  const best = itemResults.reduce((a, b) => (RANK[b.label] > RANK[a.label] ? b : a), itemResults[0] ?? { label: "INSUFFICIENT_EVIDENCE", evidence: null });
  return { label: itemResults.length ? best.label : "INSUFFICIENT_EVIDENCE", itemResults };
}

// ---- numbers in the claim text must appear in the quoted anchors (or be claim-side facts)
const claimSideNumbers = new Set(["1", "2", "3"]);
function numberWarnings(c) {
  const hay = squash(c.quotes.map((q) => ANCHORS[q][1]).concat(c.evidence.flatMap((e) => EVIDENCE[e].anchors.map((a) => ANCHORS[a][1]))).join(" ").replace(/·/g, ".").replaceAll("[...]", "")).replace(/,/g, "").replace(/(\d) (\d{3})\b/g, "$1$2");
  const text = c.text.replace(/,/g, "");
  const tokens = [...text.matchAll(/\d+(?:\.\d+)?%?/g)].map((m) => m[0]);
  return tokens.filter((t) => !claimSideNumbers.has(t) && !hay.includes(t));
}

// ---- assemble
const claimSide = {};
const lines = [];
const pass2 = [];
const disagreements = [];
for (const c of CLAIMS) {
  for (const q of c.quotes) if (!anchor[q]) problems.push(`${c.id}: unknown anchor ${q}`);
  for (const e of c.evidence) if (!EVIDENCE[e]) problems.push(`${c.id}: unknown evidence ${e}`);
  const o = oracle(c);
  const agree = o.label === c.expected;
  const within = agree || c.acceptable.includes(o.label);
  pass2.push({ id: c.id, oracleLabel: o.label, passOneLabel: c.expected, agree, oracleLabelIsAcceptableToKey: within, itemResults: o.itemResults });
  if (!agree) disagreements.push({ id: c.id, passOne: c.expected, oracle: o.label, acceptableToKey: within, resolution: null });
  const warn = numberWarnings(c);
  const pctWarn = warn.filter((t) => t.endsWith("%"));
  if (pctWarn.length) problems.push(`${c.id}: percentages in text not found in its quotes: ${pctWarn.join(", ")}`);
  claimSide[c.id] = warn.filter((t) => !t.endsWith("%"));
  const u = c.use;
  lines.push(
    JSON.stringify({
      id: c.id,
      constructed: true,
      constructedNotice: "CONSTRUCTED CLAIM. Written for this test in the style of a vendor claim; it is not a statement by any vendor and says nothing about any vendor.",
      device: c.device,
      kind: c.kind,
      text: c.text,
      claimedUse: { product: u.product, version: u.versions?.[0] ?? null, population: u.population ?? null, setting: u.settings ?? null, purpose: u.purpose ?? null, date: u.timing?.from ?? null },
      claim: { id: c.id, text: c.text, use: u },
      evidenceSetIds: c.evidence,
      key: { expectedLabel: c.expected, acceptableLabels: c.acceptable, keyConfidence: c.confidence, mismatchDimensions: c.dims, ...(c.narrower ? { supportedNarrowerScope: c.narrower } : {}), note: c.note },
      keyQuotes: c.quotes.map((q) => anchor[q]),
      claimSideNumbers: claimSide[c.id],
      pass2: { oracleLabel: o.label, agreesWithPassOne: agree, oracleLabelIsAcceptableToKey: within },
    }),
  );
}
writeFileSync(join(gate0Root, "claims.jsonl"), lines.join("\n") + "\n");
writeFileSync(join(gate0Root, "claims-pass2.json"), JSON.stringify({ label: "single builder, two passes, not independent", method: "mechanical oracle over claim.use and evidence scopes (build-claims.mjs); it cannot emit CONTRADICTED_BY_SPECIFIED_EVIDENCE, so a key that expects it will always disagree and that is recorded", results: pass2, disagreements }, null, 2) + "\n");

const dist = {};
for (const c of CLAIMS) dist[c.expected] = (dist[c.expected] ?? 0) + 1;
console.log(`claims ${CLAIMS.length}, anchors ${Object.keys(anchor).length}, problems ${problems.length}`);
console.log("label distribution:", JSON.stringify(dist));
console.log("pass-2 disagreements:", JSON.stringify(disagreements.map((d) => `${d.id}: key ${d.passOne} / oracle ${d.oracle} (${d.acceptableToKey ? "oracle label acceptable to key" : "NOT acceptable"})`)));
for (const p of problems) console.log("PROBLEM:", p);
void loadPages;
