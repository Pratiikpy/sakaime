// Fails when a footage config names a clip or a cue that the recorded clips do not hold, or when a clip had browser errors.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { FOOTAGE } = await import(pathToFileURL(join(root, "src", "footageConfigs.ts")).href);
const { SCENES } = await import(pathToFileURL(join(root, "src", "content.ts")).href);
const cues = JSON.parse(readFileSync(join(root, "src", "generated", "cues.json"), "utf8"));
const tl = JSON.parse(readFileSync(join(root, "src", "generated", "timeline.json"), "utf8"));
const { MIN_RATE, MAX_RATE, openingAnchor } = await import(pathToFileURL(join(root, "src", "lib", "footage.ts")).href);
const rates = [];

const problems = [];
for (const scene of SCENES.filter((s) => s.kind === "footage")) {
  const cfg = FOOTAGE[scene.id];
  if (!cfg) {
    problems.push(`scene ${scene.id}: no footage config`);
    continue;
  }
  const meta = cues[cfg.clip];
  if (!meta || !existsSync(join(root, "footage", "clips", `${cfg.clip}.mp4`))) {
    problems.push(`scene ${scene.id}: clip ${cfg.clip} is not recorded`);
    continue;
  }
  const has = (n) => meta.cues.some((c) => c.name === n);
  const used = [...cfg.sync.map((s) => s.cue), ...(cfg.camera ?? []).map((c) => c.cue), ...(cfg.callouts ?? []).map((c) => c.cue)];
  for (const u of new Set(used)) if (!has(u)) problems.push(`scene ${scene.id}: cue "${u}" missing from clip ${cfg.clip} (has ${meta.cues.map((c) => c.name).join(", ")})`);
  for (const c of cfg.callouts ?? []) {
    const cue = meta.cues.find((x) => x.name === c.cue);
    if (cue && !cue.box) problems.push(`scene ${scene.id}: cue "${c.cue}" has no box, so its callout cannot be placed`);
  }
  if (meta.errors.length) problems.push(`clip ${cfg.clip}: ${meta.errors.length} browser error(s): ${meta.errors[0]}`);
  // Playback rate between consecutive pins: outside the limits the clip would not reach the next pin on time.
  const sceneTl = tl.scenes.find((x) => x.id === scene.id);
  const beatFrame = (i) => sceneTl.beats[Math.min(i, sceneTl.beats.length - 1)].startFrame;
  const startT = (meta.cues.find((c) => c.name === "start") ?? { t: 0.2 }).t;
  const pins = [];
  for (const p of cfg.sync) {
    const cue = meta.cues.find((c) => c.name === p.cue);
    if (cue) pins.push({ frame: beatFrame(p.beat) + (p.offset ?? 0), clipT: cue.t, name: p.cue });
  }
  const anchors = [{ ...openingAnchor(startT, pins, tl.fps), name: "start" }, ...pins];
  anchors.sort((a, b) => a.frame - b.frame);
  for (let i = 1; i < anchors.length; i++) {
    const a = anchors[i - 1];
    const b = anchors[i];
    if (b.frame <= a.frame || b.clipT <= a.clipT) {
      problems.push(`scene ${scene.id}: pins "${a.name}" then "${b.name}" run backwards (frames ${a.frame} to ${b.frame}, clip ${a.clipT} to ${b.clipT})`);
      continue;
    }
    const rate = (b.clipT - a.clipT) / ((b.frame - a.frame) / tl.fps);
    rates.push(`${scene.id}: ${a.name} -> ${b.name} x${rate.toFixed(2)}`);
    if (rate > MAX_RATE || rate < MIN_RATE) problems.push(`scene ${scene.id}: from "${a.name}" to "${b.name}" needs playback rate ${rate.toFixed(2)} (limits ${MIN_RATE} to ${MAX_RATE}); move the pin or shorten the clip`);
  }
  const lastSync = Math.max(...cfg.sync.map((s) => meta.cues.find((c) => c.name === s.cue)?.t ?? 0));
  if (lastSync > meta.duration) problems.push(`clip ${cfg.clip}: cue after the end of the clip`);
}
if (problems.length) {
  console.error("check-cues:\n  " + problems.join("\n  "));
  process.exit(1);
}
if (process.argv.includes("--rates")) console.log(rates.join("\n"));
console.log(`check-cues: ok (${SCENES.filter((s) => s.kind === "footage").length} footage scenes)`);
