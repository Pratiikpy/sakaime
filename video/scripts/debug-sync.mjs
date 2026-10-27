// Prints, for one footage scene, which clip time is on screen at a few scene positions, and where each cue lands.
//   node scripts/debug-sync.mjs investigation
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const id = process.argv[2];
const { FOOTAGE } = await import(pathToFileURL(join(root, "src", "footageConfigs.ts")).href);
const lib = await import(pathToFileURL(join(root, "src", "lib", "footage.ts")).href);
const tl = JSON.parse(readFileSync(join(root, "src", "generated", "timeline.json"), "utf8"));
const cues = JSON.parse(readFileSync(join(root, "src", "generated", "cues.json"), "utf8"));
const cfg = FOOTAGE[id];
const scene = tl.scenes.find((s) => s.id === id);
const meta = cues[cfg.clip];
const pins = cfg.sync.map((p) => ({ frame: scene.beats[Math.min(p.beat, scene.beats.length - 1)].startFrame + (p.offset ?? 0), clipT: meta.cues.find((c) => c.name === p.cue).t }));
const start = meta.cues.find((c) => c.name === "start").t;
const anchors = [lib.openingAnchor(start, pins, tl.fps), ...pins];
const segs = lib.segmentsFrom(anchors, scene.frames, tl.fps);
console.log("scene frames", scene.frames, "clip duration", meta.duration);
for (const s of segs) console.log(`  frames ${s.from}-${s.to} clip from ${s.clipStart.toFixed(2)} rate ${s.rate.toFixed(2)}`);
for (const c of meta.cues) console.log(`  cue ${c.name.padEnd(14)} clip ${c.t.toFixed(2)} -> frame ${lib.frameOfClipTime(segs, c.t, tl.fps)}`);
