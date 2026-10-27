// Renders still frames for review without rendering the whole video.
//   node scripts/stills.mjs <outDir> hook:0.5 problem:0.9 pipeline:0.3 ...     scene id and position inside the scene (0..1)
//   node scripts/stills.mjs <outDir> --every 2        one frame every two seconds of the whole video
import { bundle } from "@remotion/bundler";
import { renderStill, selectComposition } from "@remotion/renderer";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [outDir, ...args] = process.argv.slice(2);
if (!outDir) throw new Error("usage: stills.mjs <outDir> scene:pos ... | --every <seconds>");
mkdirSync(outDir, { recursive: true });
const timeline = JSON.parse(readFileSync(join(root, "src", "generated", "timeline.json"), "utf8"));

const frames = [];
if (args[0] === "--every") {
  const step = Number(args[1] ?? 2) * timeline.fps;
  for (let f = 0; f < timeline.totalFrames; f += step) frames.push({ name: `t${String(Math.floor(f / timeline.fps)).padStart(3, "0")}`, frame: Math.floor(f) });
} else {
  for (const a of args) {
    const [id, pos = "0.5"] = a.split(":");
    const scene = timeline.scenes.find((s) => s.id === id);
    if (!scene) throw new Error(`no scene ${id}`);
    frames.push({ name: `${id}-${pos}`, frame: scene.start + Math.min(scene.frames - 1, Math.round(scene.frames * Number(pos))) });
  }
}

const serveUrl = await bundle({ entryPoint: join(root, "src", "index.ts"), publicDir: join(root, "public") });
const composition = await selectComposition({ serveUrl, id: "Sakaime", port: 3987 });
for (const f of frames) {
  await renderStill({ composition, serveUrl, port: 3987, frame: f.frame, output: join(outDir, `${f.name}.png`), imageFormat: "png" });
  console.log("still", f.name, f.frame);
}
