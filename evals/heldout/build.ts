/**
 * Builds the held-out case files from data.ts and checks them against the source documents.
 *
 *   npx tsx evals/heldout/build.ts
 *
 * Writes evals/heldout/claims.jsonl (the inputs every arm receives, no labels) and evals/heldout/key.json (labels, anchored quotes,
 * pass 1 and pass 2 results). It does not run any system. Sealing is a separate step (seal.ts) done once the key is final.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, quoteInText, readText, sha256, squash, writeJson, writeText } from "../lib/core.ts";
import type { EvalCase } from "../lib/types.ts";
import { CLAIMS, NOTICE, QUOTES, SOURCES } from "./data.ts";
import { oracleLabel } from "./oracle.ts";

const docs = new Map(SOURCES.map((s) => [s.id, readText(join(ROOT, s.file))]));
const problems: string[] = [];

const sourceHashes = SOURCES.map((s) => {
  const text = docs.get(s.id) as string;
  const raw = join(ROOT, "evals", "heldout", "raw", `${s.id}.pdf`);
  const pdfOk = existsSync(raw) ? sha256(readFileSync(raw)) === s.pdfSha256 : null;
  if (pdfOk === false) problems.push(`${s.id}: PDF on disk does not match the recorded sha256`);
  return { id: s.id, textSha256: sha256(text), pdfSha256: s.pdfSha256, pdfChecked: pdfOk, url: s.url, decisionDate: s.decisionDate };
});

const anchored = Object.fromEntries(
  Object.entries(QUOTES).map(([id, q]) => {
    const text = docs.get(q.doc) as string;
    const pages = text.split("\f");
    const hits = pages.map((p, i) => (quoteInText(q.quote, p) ? i + 1 : 0)).filter(Boolean);
    const whole = quoteInText(q.quote, text);
    if (!whole) problems.push(`quote ${id} not found in ${q.doc}`);
    return [id, { ...q, page: hits[0] ?? null, onPages: hits, found: whole }];
  }),
);

const numberTokens = (t: string): string[] => t.match(/\d+\.\d+%?|\d+%/g) ?? [];

const keys: Record<string, unknown> = {};
const cases: Omit<EvalCase, "key">[] = [];
const disagreements: { id: string; hand: string; oracle: string; acceptable: boolean }[] = [];

for (const c of CLAIMS) {
  const src = SOURCES.find((s) => s.id === c.source);
  if (!src) throw new Error(`${c.id}: unknown source ${c.source}`);
  for (const q of c.quotes) if (!(q in QUOTES)) problems.push(`${c.id}: unknown quote ${q}`);
  const joined = c.quotes.map((q) => squash(QUOTES[q]?.quote ?? "")).join(" ");
  const claimSide = c.performance ? `${Math.round(c.performance.atLeast * 100)}%` : "";
  for (const n of numberTokens(c.text)) if (n !== claimSide && !joined.includes(n.replace("%", ""))) problems.push(`${c.id}: number ${n} in the claim text is not in any quote`);
  const oracle = oracleLabel(c.pass2);
  const agrees = oracle === c.key.expectedLabel;
  if (!agrees) disagreements.push({ id: c.id, hand: c.key.expectedLabel, oracle, acceptable: c.key.acceptableLabels.includes(oracle) });
  if (c.key.acceptableLabels.some((l) => l === "SUPPORTED_FOR_SCOPE" || l === "SUPPORTED_ONLY_FOR_NARROWER_SCOPE")) problems.push(`${c.id}: acceptable labels contain a SUPPORTED label`);
  if ((c.kind === "positive control") !== (c.key.expectedLabel === "SUPPORTED_FOR_SCOPE")) problems.push(`${c.id}: kind and expected label disagree`);
  if (c.key.expectedLabel !== "SUPPORTED_FOR_SCOPE" && c.key.mismatches.length === 0) problems.push(`${c.id}: a withheld label needs at least one named mismatch`);
  keys[c.id] = {
    key: c.key,
    quotes: c.quotes.map((q) => ({ id: q, ...anchored[q] })),
    pass1: { label: c.key.expectedLabel },
    pass2: { relations: c.pass2.relations, explicitLimit: !!c.pass2.explicitLimit, textNegatesUse: !!c.pass2.textNegatesUse, reviewFlag: !!c.pass2.reviewFlag, contraryAdequate: !!c.pass2.contraryAdequate, oracleLabel: oracle, agreesWithPass1: agrees },
  };
  cases.push({
    id: c.id,
    cluster: c.source,
    product: src.device,
    kind: c.kind,
    partition: "held-out",
    text: c.text,
    claim: { id: c.id, text: c.text, use: c.use, ...(c.performance ? { performance: c.performance } : {}) } as EvalCase["claim"],
    ...(c.policy ? { policy: c.policy } : {}),
  });
}

const count = (f: (c: (typeof CLAIMS)[number]) => string): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const c of CLAIMS) out[f(c)] = (out[f(c)] ?? 0) + 1;
  return out;
};

const key = {
  about:
    "Sealed answer key for the held-out ScopeShift (B) set. CONSTRUCTED claims over five FDA 510(k) summaries that no development claim uses. Single builder, two passes (hand label, then a relation table fed to a mechanical oracle), not independent; no clinician has read it. The key was written before Sakaime or any other arm was run on these claims.",
  notice: NOTICE,
  sources: sourceHashes,
  labelDistribution: count((c) => c.key.expectedLabel),
  contestable: CLAIMS.filter((c) => c.key.keyConfidence === "contestable").length,
  clusters: [...new Set(CLAIMS.map((c) => c.source))],
  pass2Disagreements: disagreements,
  keys,
};

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}

writeText(join(ROOT, "evals", "heldout", "claims.jsonl"), cases.map((c) => JSON.stringify({ ...c, constructed: true, notice: NOTICE })).join("\n") + "\n");
writeJson(join(ROOT, "evals", "heldout", "key.json"), key);
console.log(`claims: ${CLAIMS.length}, clusters: ${key.clusters.length}, contestable: ${key.contestable}`);
console.log("labels:", key.labelDistribution);
console.log("pass-2 disagreements:", disagreements.length ? disagreements : "none");
