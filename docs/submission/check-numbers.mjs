// Fails if a number on a slide is not found in the files that slide declares as its sources, if a registry id is unknown,
// if a banned word appears, or if a slide cites a slide number that does not exist.
//   node docs/submission/check-numbers.mjs
//
// What it checks: ratios ("9 of 26", "9/26"), percentages, decimals, integers of 10 or more, and K, DEN, NCT and PMID ids.
// A number is accepted when it appears in one of the slide's declared source files (Markdown or JSON; for JSON, also as k/n
// pairs and as percentages derived from `rate`, `mean` and `worst` fields) or when the slide computed it from a file and
// declared how (`derive`). Integers below 10 are listed, not checked. Number words ("seven") are not checked.
import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { ROOT, text } from "./lib/data.mjs";
import { buildAll } from "./lib/deck.mjs";

const BANNED = [
  [/best/i, "best"], [/proof|proven|proves?/i, "proof"], [/guarantee[sd]?/i, "guaranteed"], [/accurate(?:ly)?/i, "accurate"],
  [/production[- ]ready/i, "production-ready"], [/state[- ]of[- ]the[- ]art/i, "state-of-the-art"], [/validated/i, "validated"],
  [/(?:is|are|was|were|deemed|considered|found|declared)\s+(?:safe|cleared|compliant|approved|certified)/i, "a verdict of safety"],
];

function walkJson(o, add) {
  if (o && typeof o === "object") {
    if (typeof o.k === "number" && typeof o.n === "number") {
      add.ratio(`${o.k}/${o.n}`);
      if (typeof o.rate === "number") for (const d of [0, 1]) add.pct((o.rate * 100).toFixed(d));
    }
    if (typeof o.mean === "number") for (const d of [0, 1]) add.pct((o.mean * 100).toFixed(d));
    if (typeof o.worst === "number") for (const d of [0, 1]) add.pct((o.worst * 100).toFixed(d));
    if (typeof o.rate === "number") for (const d of [0, 1]) add.pct((o.rate * 100).toFixed(d));
    for (const v of Object.values(o)) walkJson(v, add);
  }
}

const corpusCache = new Map();
function corpusOf(rel) {
  if (corpusCache.has(rel)) return corpusCache.get(rel);
  const c = { raw: "", ratios: new Set(), nums: new Set(), pcts: new Set(), ids: new Set() };
  const p = resolve(ROOT, rel);
  if (existsSync(p) && statSync(p).isDirectory()) {
    c.raw = readdirSync(p).join(" ");
  } else if (existsSync(p)) {
    c.raw = text(rel);
    if (rel.endsWith(".json")) {
      try {
        walkJson(JSON.parse(c.raw), { ratio: (x) => c.ratios.add(x), pct: (x) => c.pcts.add(x) });
      } catch {
        /* a .jsonl or malformed file is read as plain text */
      }
    }
  } else throw new Error(`declared source does not exist: ${rel}`);
  const t = c.raw.replace(/(\d),(\d{3})/g, "$1$2");
  for (const m of t.matchAll(/(\d+)\s*(?:of(?: the)?|\/)\s*(\d+)/g)) c.ratios.add(`${m[1]}/${m[2]}`);
  for (const m of t.matchAll(/\d+(?:\.\d+)?/g)) c.nums.add(m[0]);
  for (const m of t.matchAll(/(\d+(?:\.\d+)?)\s*(?:%|percent)/g)) c.pcts.add(m[1]);
  for (const m of t.matchAll(/\b(?:K|DEN|NCT|P)\d{6,8}\b|\bPMID\s*\d+|\bpubmed:\d+/g)) c.ids.add(m[0].replace(/\s+/g, "").replace("pubmed:", "PMID"));
  corpusCache.set(rel, c);
  return c;
}

const deck = buildAll();
let failures = 0;
const lines = [];
const unchecked = [];
for (const s of deck.slides) {
  const corp = s.sources.map(corpusOf);
  const has = (k, v) => corp.some((c) => c[k].has(v));
  const derived = new Set(s.derived.map((d) => d.value));
  let t = s.text.replace(/\(\d of \d\)/g, " ");
  const problems = [];
  // ids
  for (const m of t.matchAll(/\b(?:K|DEN|NCT)\d{6,8}\b|\bPMID\s*\d+/g)) {
    const id = m[0].replace(/\s+/g, "");
    if (!has("ids", id) && !has("nums", id.replace(/^[A-Z]+/, "")) && !corp.some((c) => c.raw.includes(id))) problems.push(`id ${m[0]} not in the sources`);
  }
  // dates and ids are not numbers to check
  t = t.replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.Z]+)?\b/g, " ").replace(/\b(?:K|DEN|NCT|P)\d{5,8}\b|PMID\s*\d+/g, " ").replace(/\b[A-Z]{1,4}-[A-Z]{1,4}-\d+\b|\bCASE-\d{4}-\d+\b/g, " ").replace(/\b[a-z]*[a-f]*\d[a-f\d]{7,}\b/g, " ").replace(/\bL[0-8]\b|\bZ-[A-Z]+\b|\bE-00\d\b|\bD-0\d\d\b|\bR\d+\b|\bB[0-6]\b/g, " ").replace(/\b\d+\.\d+\.\d+(?:\.\d+)?\b/g, " ").replace(/(\d),(\d{3})/g, "$1$2");
  const seen = new Set();
  const check = (kind, val, ok) => {
    const key = `${kind}:${val}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (derived.has(val)) return;
    if (!ok) problems.push(`${kind} ${val} not in the declared sources`);
  };
  // ratios
  t = t.replace(/(\d+)\s*(?:of|\/)\s*(\d+)/g, (m, a, b) => {
    check("ratio", `${a}/${b}`, has("ratios", `${a}/${b}`) || derived.has(a) || derived.has(b));
    return " ";
  });
  // percentages
  t = t.replace(/(\d+(?:\.\d+)?)\s*(?:%|percent)/g, (m, a) => {
    check("percent", a, has("pcts", a) || has("nums", a));
    return " ";
  });
  // decimals
  t = t.replace(/\b\d+\.\d+\b/g, (m) => {
    check("decimal", m, has("nums", m));
    return " ";
  });
  // integers
  for (const m of t.matchAll(/\b\d+\b/g)) {
    const v = m[0];
    if (v.length === 4 && /^20\d\d$/.test(v)) continue;
    if (Number(v) < 10) { unchecked.push(`slide ${s.n}: ${v}`); continue; }
    check("integer", v, has("nums", v));
  }
  // banned words
  for (const [re, name] of BANNED) {
    const clean = (x) => x.replace(/provenance/gi, "");
    const ctxOf = (x) => (clean(x).match(new RegExp(`.{0,25}${re.source}.{0,15}`, "i")) ?? [""])[0];
    if (re.test(clean(s.text))) problems.push(`banned wording "${name}" on the slide: ...${ctxOf(s.text)}...`);
    if (re.test(clean(s.notes))) problems.push(`banned wording "${name}" in the notes: ...${ctxOf(s.notes)}...`);
  }
  // slide references
  for (const m of s.text.matchAll(/\bslides? (\d+)(?: (?:to|and) (\d+))?/g)) {
    for (const x of [m[1], m[2]].filter(Boolean)) if (+x < 1 || +x > deck.total) problems.push(`refers to slide ${x}, which does not exist`);
  }
  if (problems.length) failures += problems.length;
  lines.push(`${problems.length ? "FAIL" : "ok  "}  ${String(s.n).padStart(2)}  ${s.title.slice(0, 60)}${problems.length ? "\n" + problems.map((p) => `        ${p}`).join("\n") : ""}`);
}
console.log(lines.join("\n"));
console.log("\nNumbers computed from a file rather than copied (declared with derive):");
for (const s of deck.slides) for (const d of s.derived) console.log(`  slide ${String(s.n).padStart(2)}  ${String(d.value).padStart(6)}  ${d.note}`);
const perSlide = {};
for (const u of unchecked) { const [a, b] = u.split(": "); (perSlide[a] ??= []).push(b); }
console.log(`\nIntegers below 10 are not checked (${unchecked.length}):`);
for (const [k, v] of Object.entries(perSlide)) console.log(`  ${k}: ${v.join(" ")}`);
console.log(failures ? `\n${failures} problem(s)` : "\nevery checked number, id and word passes");
process.exit(failures ? 1 : 0);
