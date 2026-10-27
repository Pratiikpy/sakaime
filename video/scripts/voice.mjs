// Generates the narration: one wav per beat (Piper, local, free), measures each, and writes src/generated/timeline.json
// so every visual cue lands on the sentence it belongs to. Re-run after any change to the narration text.
//
//   node scripts/voice.mjs            synthesise what changed, then rebuild the timeline
//   node scripts/voice.mjs --timeline rebuild the timeline only (uses existing wavs, or an estimate where none exist)
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { SCENES, LOCAL_COUNTS } = await import(pathToFileURL(join(root, "src", "content.ts")).href);
const { expand } = await import(pathToFileURL(join(root, "src", "lib", "fmt.ts")).href);
const figures = JSON.parse(readFileSync(join(root, "src", "generated", "figures.json"), "utf8"));

const FPS = 30;
const LEAD = 0.35; // seconds before the first word: the title wipes in first
const GAP = 0.2; // between beats
const TAIL = 0.3; // after the last word
const PY = process.env.PIPER_PYTHON ?? "C:/Users/prate/.venvs/video-tts/Scripts/python.exe";
const MODEL = process.env.PIPER_MODEL ?? "C:/Users/prate/.cache/piper-voices/en_GB-cori-high.onnx";
const LENGTH_SCALE = Number(process.env.PIPER_LENGTH_SCALE ?? 0.72);

// Respellings for the voice only. The text on screen and in the repository keeps the real spelling.
const SPEECH = [
  [/Sakaime/g, "Sah-kigh-meh"],
  [/Zetaris/g, "Zeh-tah-riss"],
  [/Meterless/g, "Meter-less"],
  [/Nemotron/g, "Nemmo-tron"],
  [/Nightshift/g, "Night-shift"],
  [/H-MEM/g, "Aitch-mem"],
  [/NVIDIA/g, "En-vidia"],
  [/npm run judge/g, "N P M run judge"],
  [/\bK200667\b/g, "K two hundred thousand six hundred sixty-seven"],
  [/\b1\.7\.0\b/g, "one point seven point zero"],
  [/\b1\.7\.2\b/g, "one point seven point two"],
  [/\b2\.1\.0\b/g, "two point one point zero"],
  [/\b3\.0\b/g, "three point zero"],
  [/\b2018\b/g, "twenty eighteen"],
  [/ {2,}/g, " "],
];
const speak = (t) => SPEECH.reduce((s, [re, to]) => s.replace(re, to), t);

const outDir = join(root, "audio", "beats");
mkdirSync(outDir, { recursive: true });
const cachePath = join(outDir, "manifest.json");
const cache = existsSync(cachePath) ? JSON.parse(readFileSync(cachePath, "utf8")) : {};

const items = [];
const plan = [];
for (const scene of SCENES) {
  scene.beats.forEach((tpl, i) => {
    const text = expand(tpl, figures, LOCAL_COUNTS);
    const spoken = speak(text);
    const file = `${scene.id}-${i}.wav`;
    const hash = createHash("sha256").update(`${MODEL}|${LENGTH_SCALE}|${spoken}`).digest("hex").slice(0, 16);
    plan.push({ scene: scene.id, i, text, spoken, file, hash });
    if (cache[file] !== hash || !existsSync(join(outDir, file))) items.push({ out: join(outDir, file), text: spoken, hash, file });
  });
}

const timelineOnly = process.argv.includes("--timeline");
if (!timelineOnly && items.length) {
  if (!existsSync(MODEL)) throw new Error(`voice model not found: ${MODEL}`);
  console.log(`synthesising ${items.length} of ${plan.length} beats`);
  const run = spawnSync(PY, [join(here, "tts_piper.py")], { input: JSON.stringify({ model: MODEL, length_scale: LENGTH_SCALE, items: items.map(({ out, text }) => ({ out, text })) }), encoding: "utf8", maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`piper failed: ${run.stderr}`);
  for (const it of items) cache[it.file] = it.hash;
  writeFileSync(cachePath, JSON.stringify(cache, null, 1));
}

function duration(file) {
  const p = join(outDir, file);
  if (!existsSync(p)) return null;
  return Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", p], { encoding: "utf8" }).trim());
}

let cursor = 0;
const scenes = [];
let estimated = 0;
for (const scene of SCENES) {
  const beats = [];
  let t = LEAD;
  for (const p of plan.filter((x) => x.scene === scene.id)) {
    let d = duration(p.file);
    if (d === null) {
      d = p.text.split(/\s+/).length / 2.7;
      estimated++;
    }
    beats.push({ file: p.file, text: p.text, start: round(t), dur: round(d) });
    t += d + GAP;
  }
  const spoken = t - GAP + TAIL;
  const seconds = Math.max(scene.minSeconds, spoken);
  const frames = Math.ceil(seconds * FPS);
  scenes.push({ id: scene.id, start: cursor, frames, beats: beats.map((b) => ({ ...b, startFrame: Math.round(b.start * FPS), frames: Math.ceil(b.dur * FPS) })) });
  cursor += frames;
}
function round(x) {
  return Math.round(x * 1000) / 1000;
}

writeFileSync(join(root, "src", "generated", "timeline.json"), JSON.stringify({ fps: FPS, totalFrames: cursor, totalSeconds: round(cursor / FPS), estimatedBeats: estimated, scenes }, null, 1));
console.log(`timeline: ${round(cursor / FPS)} s over ${scenes.length} scenes (${estimated} beats estimated, not yet synthesised)`);
