// Fails the build when a number in the composition is not traceable to a source file.
//
// Rules, applied to the narration (src/content.ts), the footage captions and callouts (src/footageConfigs.ts) and every string or
// text node in the scene components:
//   1. A digit or a number word (two to twenty, thirty to hundred) may only come from a {placeholder}, which build-data.mjs
//      resolves from a results file.
//   2. Or it is one of the RAW_TOKENS in src/content.ts, each of which must appear in the file named beside it.
// Numbers computed in code from figures (bar lengths, counts, percentages) are not strings and are not checked here: they are
// derived from the same figures.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repo = join(root, "..");
const { SCENES, RAW_TOKENS } = await import(pathToFileURL(join(root, "src", "content.ts")).href);
const { FOOTAGE } = await import(pathToFileURL(join(root, "src", "footageConfigs.ts")).href);
const figures = JSON.parse(readFileSync(join(root, "src", "generated", "figures.json"), "utf8"));

const problems = [];
const NUMBER_WORDS = /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand)\b/i;

// Raw tokens must exist in their files.
for (const t of RAW_TOKENS) {
  const p = join(repo, t.file);
  if (!existsSync(p) || !readFileSync(p, "utf8").toLowerCase().includes((t.needle ?? t.text).toLowerCase())) problems.push(`RAW_TOKEN "${t.text}" not found in ${t.file}`);
}

function covered(text) {
  // Remove the tokens that are allowed to appear, longest first, then see whether any digit or number word is left.
  let rest = text;
  for (const t of [...RAW_TOKENS].sort((a, b) => b.text.length - a.text.length)) rest = rest.split(t.text).join(" ");
  return rest;
}

function checkTemplate(where, template) {
  for (const key of [...template.matchAll(/\{([a-zA-Z0-9_.-]+)(?::[a-z]+)?\}/g)].map((m) => m[1])) {
    if (!(key in figures) && !key.startsWith("local.")) problems.push(`${where}: placeholder {${key}} has no figure`);
  }
  const stripped = covered(template.replace(/\{[^}]*\}/g, " "));
  if (/\d/.test(stripped)) problems.push(`${where}: typed digit in "${template}"`);
  const w = NUMBER_WORDS.exec(stripped);
  if (w) problems.push(`${where}: typed number word "${w[0]}" in "${template}"`);
}

for (const scene of SCENES) scene.beats.forEach((b, i) => checkTemplate(`narration ${scene.id}[${i}]`, b));
for (const [id, cfg] of Object.entries(FOOTAGE)) {
  checkTemplate(`caption ${id}`, cfg.caption);
  for (const c of cfg.callouts ?? []) checkTemplate(`callout ${id}/${c.cue}`, c.text);
}

// Scene components: string literals and JSX text.
const CSSISH = /(^#|px|rgba?\(|calc\(|cubic-bezier|%|translate|scale\(|inset|solid|dashed|dotted|\.ttf|^fonts\/|^audio\/|^footage\/|^\d+(\.\d+)?$|^[0-9a-f]{3,8}$|sin\(|rem|vh|vw|em$|ms$)/;
const dir = join(root, "src", "scenes");
for (const f of readdirSync(dir).filter((x) => x.endsWith(".tsx"))) {
  const src = readFileSync(join(dir, f), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/[^\n]*/g, " ");
  const found = [];
  for (const m of src.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) found.push(m[2]);
  for (const m of src.matchAll(/>([^<>{}\n]+)</g)) found.push(m[1]);
  for (const text of found) {
    const t = text.trim();
    if (!t) continue;
    if (/^(import|from)\b/.test(t) || t.startsWith("../") || t.startsWith("./")) continue;
    if (CSSISH.test(t) && !/[A-Za-z]{4,}\s[A-Za-z]{3,}/.test(t)) continue;
    if (/\$\{/.test(t) || /^\{.*\}$/.test(t)) {
      checkTemplate(`${f}`, t.replace(/\$\{[^}]*\}/g, " "));
      continue;
    }
    if (!/\d/.test(covered(t)) && !NUMBER_WORDS.test(covered(t))) continue;
    // an expression-like string (selectors, attribute names, regexes) is not on-screen text
    if (/^[\w.:#\[\]="'-]+$/.test(t) && !/\d{1}/.test(t.replace(/[A-Za-z]\d/g, ""))) continue;
    checkTemplate(`${f}`, t);
  }
}

if (problems.length) {
  console.error(`check-numbers: ${problems.length} problem(s)\n  ` + [...new Set(problems)].join("\n  "));
  process.exit(1);
}
console.log(`check-numbers: ok (${SCENES.reduce((n, s) => n + s.beats.length, 0)} narration beats, ${Object.keys(FOOTAGE).length} footage configs, ${RAW_TOKENS.length} raw tokens verified)`);
