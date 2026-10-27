// Wording lint for everything the video says or shows: the product's banned words, and the labels it must never output.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { SCENES } = await import(pathToFileURL(join(root, "src", "content.ts")).href);
const { FOOTAGE } = await import(pathToFileURL(join(root, "src", "footageConfigs.ts")).href);

const BANNED = /\b(best|proof|proves?|proven|guaranteed?|accurate|accuracy|production[- ]ready|state[- ]of[- ]the[- ]art|validated?|validation|cleared|compliant|approved|safe)\b/i;
const texts = [];
for (const s of SCENES) s.beats.forEach((b, i) => texts.push([`narration ${s.id}[${i}]`, b]));
for (const [id, c] of Object.entries(FOOTAGE)) {
  texts.push([`caption ${id}`, c.caption]);
  for (const co of c.callouts ?? []) texts.push([`callout ${id}/${co.cue}`, co.text]);
}
for (const f of readdirSync(join(root, "src", "scenes")).filter((x) => x.endsWith(".tsx"))) {
  const src = readFileSync(join(root, "src", "scenes", f), "utf8").replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, " ");
  for (const m of src.matchAll(/(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) texts.push([f, m[2]]);
  for (const m of src.matchAll(/>([^<>{}\n]+)</g)) texts.push([f, m[1]]);
}
const bad = texts.filter(([, t]) => BANNED.test(t)).map(([w, t]) => `${w}: "${t}" (${BANNED.exec(t)[0]})`);
if (bad.length) {
  console.error("check-words: banned wording\n  " + bad.join("\n  "));
  process.exit(1);
}
console.log(`check-words: ok (${texts.length} strings)`);
