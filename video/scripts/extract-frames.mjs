// Review aids for a rendered file: one frame at every second of every scene, laid out as a contact sheet per scene
// (frames/sheets/<n>-<scene>.jpg, 3 columns, one frame per second, left to right and top to bottom), plus single frames in frames/seconds/ for closer reading.
//   node scripts/extract-frames.mjs [video] [outDir]
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const video = join(root, process.argv[2] ?? "out/sakaime-demo.mp4");
const out = process.argv[3] ?? join(root, "out", "frames");
const tl = JSON.parse(readFileSync(join(root, "src", "generated", "timeline.json"), "utf8"));
mkdirSync(join(out, "sheets"), { recursive: true });
mkdirSync(join(out, "seconds"), { recursive: true });

const ff = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: "inherit" });
tl.scenes.forEach((s, i) => {
  const start = s.start / tl.fps;
  const dur = s.frames / tl.fps;
  const n = Math.ceil(dur);
  const rows = Math.ceil(n / 3);
  const name = `${String(i + 1).padStart(2, "0")}-${s.id}`;
  ff(["-ss", start.toFixed(2), "-t", dur.toFixed(2), "-i", video, "-vf", `fps=1,scale=640:-1,tile=3x${rows}`, "-frames:v", "1", join(out, "sheets", `${name}.jpg`)]);
  ff(["-ss", start.toFixed(2), "-t", dur.toFixed(2), "-i", video, "-vf", "fps=1,scale=1280:-1", join(out, "seconds", `${name}-%02d.jpg`)]);
});
console.log("frames written to", out);
