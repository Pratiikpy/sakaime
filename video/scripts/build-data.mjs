// Reads every figure from its source file and writes src/generated/figures.json. The composition imports only that file,
// so no number in a scene is typed by hand. Fails the build when a source or a path is missing.
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FIGURES, LITERALS } from "../data/figures.manifest.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..");

function readJson(rel) {
  return JSON.parse(readFileSync(join(repo, rel), "utf8"));
}

/** Resolves a dotted path; with `flat`, the remainder after the first existing prefix is tried as a single key. */
function dig(obj, path, flat) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return undefined;
    if (flat) {
      // Keys such as "dev.B3.exact.meanWorst" are single keys of the summaries object.
      const joined = parts.slice(i).join(".");
      if (typeof cur === "object" && joined in cur) return cur[joined];
    }
    cur = cur[parts[i]];
  }
  return cur;
}

const figures = {};
const problems = [];

for (const f of FIGURES) {
  const abs = join(repo, f.file);
  if (!existsSync(abs)) {
    if (f.optional) continue;
    problems.push(`${f.key}: missing file ${f.file}`);
    continue;
  }
  let value;
  if (f.kind === "tsArray") {
    const text = readFileSync(abs, "utf8");
    const m = new RegExp(`export const ${f.name} = \\[([\\s\\S]*?)\\] as const`).exec(text);
    if (!m) {
      if (f.optional) continue;
      problems.push(`${f.key}: ${f.name} not found in ${f.file}`);
      continue;
    }
    value = [...m[1].matchAll(/"[^"]+"/g)].length;
    figures[f.key] = { kind: "value", value, source: f.file, path: `${f.name}.length` };
    continue;
  }
  const json = readJson(f.file);
  const root0 = f.base ? json[f.base] : json;
  const hit = dig(root0, f.path, f.flat);
  if (hit === undefined) {
    problems.push(`${f.key}: ${f.path} not found in ${f.file}`);
    continue;
  }
  if (f.kind === "kn") {
    if (typeof hit.k !== "number" || typeof hit.n !== "number") problems.push(`${f.key}: expected {k,n}`);
    figures[f.key] = { kind: "kn", k: hit.k, n: hit.n, source: f.file, path: [f.base, f.path].filter(Boolean).join(".") };
  } else if (f.kind === "meanWorst") {
    figures[f.key] = { kind: "meanWorst", mean: hit.mean, worst: hit.worst, runs: hit.runs, source: f.file, path: [f.base, f.path].filter(Boolean).join(".") };
  } else {
    figures[f.key] = { kind: "value", value: hit, source: f.file, path: [f.base, f.path].filter(Boolean).join(".") };
  }
}

for (const l of LITERALS) {
  const text = readFileSync(join(repo, l.file), "utf8");
  if (!text.includes(l.text)) {
    problems.push(`${l.key}: "${l.text}" not found in ${l.file}`);
    continue;
  }
  figures[l.key] = l.kind === "value" ? { kind: "value", value: l.value, source: l.file, path: `verbatim: ${l.text}` } : { kind: "kn", k: l.k, n: l.n, source: l.file, path: `verbatim: ${l.text}` };
}

// Facts that are not numbers but must come from a file: the recorded run's labels, in claim order.
const labelsPath = "data/sample/run/labels.json";
if (existsSync(join(repo, labelsPath))) {
  figures["labels.file"] = { kind: "value", value: readJson(labelsPath), source: labelsPath, path: "" };
}

if (problems.length) {
  console.error("build-data failed:\n  " + problems.join("\n  "));
  process.exit(1);
}
mkdirSync(join(root, "src", "generated"), { recursive: true });
writeFileSync(join(root, "src", "generated", "figures.json"), JSON.stringify(figures, null, 1));
console.log(`figures: ${Object.keys(figures).length} written`);

// Footage cues: where each named moment of every recorded clip is, and the on-screen box of the element it is about.
const clipsDir = join(root, "footage", "clips");
const cues = {};
if (existsSync(clipsDir)) {
  for (const f of readdirSync(clipsDir)) {
    if (f.endsWith(".cues.json") && !f.startsWith("_")) {
      const meta = JSON.parse(readFileSync(join(clipsDir, f), "utf8"));
      cues[meta.clip] = meta;
    }
  }
}
writeFileSync(join(root, "src", "generated", "cues.json"), JSON.stringify(cues));
console.log(`footage clips with cues: ${Object.keys(cues).length}`);

// The judge script's real output, split into lines for the terminal scene.
const judgePath = join(root, "data", "snapshots", "judge.txt");
if (existsSync(judgePath)) {
  const lines = readFileSync(judgePath, "utf8").split("\n").map((l) => l.replace("\r", "")).filter((l, i, a) => !(l === "" && (i === 0 || i === a.length - 1)));
  writeFileSync(join(root, "src", "generated", "judge.json"), JSON.stringify({ lines }));
  console.log(`judge output: ${lines.length} lines`);
}
