// Length gate. The organizers cap the demo video at four minutes; this fails above 3:58 so a rounding error cannot cross the line.
//   node scripts/check-length.mjs                    checks the planned timeline
//   node scripts/check-length.mjs --video out/x.mp4  checks the rendered file with ffprobe
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const LIMIT = 238; // 3:58
const FLOOR = 60;
const fmt = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

const vi = process.argv.indexOf("--video");
let seconds;
let what;
if (vi > 0) {
  const file = join(root, process.argv[vi + 1]);
  seconds = Number(execFileSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file], { encoding: "utf8" }).trim());
  what = `rendered file ${process.argv[vi + 1]}`;
} else {
  const tl = JSON.parse(readFileSync(join(root, "src", "generated", "timeline.json"), "utf8"));
  seconds = tl.totalSeconds;
  what = `planned timeline (${tl.scenes.length} scenes)`;
}
if (seconds > LIMIT) {
  console.error(`check-length: ${what} is ${fmt(seconds)} (${seconds.toFixed(1)} s), over the 3:58 gate`);
  process.exit(1);
}
if (seconds < FLOOR) {
  console.error(`check-length: ${what} is ${fmt(seconds)}, under the one-minute minimum`);
  process.exit(1);
}
console.log(`check-length: ok, ${what} is ${fmt(seconds)} (${seconds.toFixed(1)} s)`);
