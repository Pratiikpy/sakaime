// Builds audio/mix.mp3: the narration beats placed on the timeline, a quiet synthesised music bed that ducks under the voice,
// and a few soft interface sounds. Everything here is generated with ffmpeg from nothing but arithmetic, so there is no
// third-party music or sample to license. Levels: voice about -16 LUFS, bed about -34 dB below it, sounds lower still.
//
//   node scripts/make-audio.mjs         writes audio/mix.mp3 and src/generated/audio.json
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const tl = JSON.parse(readFileSync(join(root, "src", "generated", "timeline.json"), "utf8"));
const cues = JSON.parse(readFileSync(join(root, "src", "generated", "cues.json"), "utf8"));
const { FOOTAGE } = await import(pathToFileURL(join(root, "src", "footageConfigs.ts")).href);
const lib = await import(pathToFileURL(join(root, "src", "lib", "footage.ts")).href);

const FPS = tl.fps;
const total = tl.totalSeconds + 1.5;
const work = join(root, "audio", "work");
mkdirSync(work, { recursive: true });

const run = (args) => execFileSync("ffmpeg", ["-v", "error", "-y", ...args], { stdio: ["ignore", "inherit", "inherit"] });

// ---- interface sounds: short, soft, synthesised
const sfx = {
  whoosh: ["-f", "lavfi", "-i", "anoisesrc=d=0.42:c=pink:a=0.6:r=48000", "-af", "highpass=f=500,lowpass=f=4200,afade=t=in:d=0.12,afade=t=out:st=0.14:d=0.28,volume=0.9"],
  tick: ["-f", "lavfi", "-i", "sine=f=1568:d=0.09:r=48000", "-af", "afade=t=in:d=0.004,afade=t=out:st=0.012:d=0.078,volume=0.8"],
  chime: ["-f", "lavfi", "-i", "sine=f=880:d=0.5:r=48000", "-af", "afade=t=in:d=0.01,afade=t=out:st=0.02:d=0.48,volume=0.7"],
  low: ["-f", "lavfi", "-i", "sine=f=146:d=0.5:r=48000", "-af", "afade=t=in:d=0.01,afade=t=out:st=0.04:d=0.46,volume=0.9"],
};
for (const [name, args] of Object.entries(sfx)) run([...args, "-ac", "1", join(work, `${name}.wav`)]);

// ---- events: when each sound is heard (seconds on the timeline)
const events = [];
for (const scene of tl.scenes) {
  const t0 = scene.start / FPS;
  events.push({ at: Math.max(0.05, t0 - 0.02), sound: "whoosh", gain: 0.5 });
  const cfg = FOOTAGE[scene.id];
  const meta = cues[cfg?.clip];
  if (cfg && meta) {
    const beatFrame = (i) => scene.beats[Math.min(i, scene.beats.length - 1)].startFrame;
    const pins = [];
    for (const s of cfg.sync) {
      const cue = meta.cues.find((c) => c.name === s.cue);
      if (cue) pins.push({ frame: beatFrame(s.beat) + (s.offset ?? 0), clipT: cue.t });
    }
    const anchors = [lib.openingAnchor((meta.cues.find((c) => c.name === "start") ?? { t: 0.2 }).t, pins, FPS), ...pins];
    const segs = lib.segmentsFrom(anchors, scene.frames, FPS);
    for (const co of cfg.callouts ?? []) {
      const cue = meta.cues.find((c) => c.name === co.cue);
      if (!cue || !cue.box) continue;
      const f = lib.frameOfClipTime(segs, cue.t, FPS) + Math.round((co.from ?? -0.15) * FPS);
      events.push({ at: t0 + f / FPS, sound: co.tone === "bad" ? "low" : "tick", gain: co.tone === "bad" ? 0.55 : 0.4 });
    }
  }
}

// ---- the filter graph
const inputs = [];
const parts = [];
let n = 0;
const addInput = (file) => {
  inputs.push("-i", file);
  return n++;
};

// voice
const voiceIdx = [];
for (const scene of tl.scenes) {
  for (const b of scene.beats) {
    const i = addInput(join(root, "audio", "beats", b.file));
    const ms = Math.round((scene.start / FPS + b.start) * 1000);
    parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${ms}:all=1[v${i}]`);
    voiceIdx.push(`[v${i}]`);
  }
}
parts.push(`${voiceIdx.join("")}amix=inputs=${voiceIdx.length}:normalize=0:duration=longest,apad=whole_dur=${total},atrim=0:${total},loudnorm=I=-16:TP=-1.5:LRA=7[voice]`);

// sounds
const sfxIdx = [];
const sfxInput = {};
for (const name of Object.keys(sfx)) sfxInput[name] = join(work, `${name}.wav`);
for (const e of events) {
  const i = addInput(sfxInput[e.sound]);
  const ms = Math.round(e.at * 1000);
  parts.push(`[${i}:a]aresample=48000,aformat=channel_layouts=mono,volume=${e.gain},adelay=${ms}:all=1[s${i}]`);
  sfxIdx.push(`[s${i}]`);
}
parts.push(`${sfxIdx.join("")}amix=inputs=${sfxIdx.length}:normalize=0:duration=longest,apad=whole_dur=${total},atrim=0:${total},volume=0.16[fx]`);

// music bed: a slow A minor pad, chords crossfading every 16 seconds, with a slow breathing swell
const CH = [
  [110.0, 164.81, 220.0, 261.63],
  [87.31, 130.81, 174.61, 261.63],
  [130.81, 196.0, 261.63, 329.63],
  [98.0, 146.83, 196.0, 293.66],
];
const SEG = 16;
const terms = [];
for (let k = 0; k * SEG < total + SEG; k++) {
  const centre = k * SEG + SEG / 2;
  const w = `max(0,1-abs(t-${centre})/${SEG})`;
  const chord = CH[k % CH.length].map((f, j) => `sin(2*PI*${(f * (1 + 0.0007 * (j - 1.5))).toFixed(3)}*t+${j})`).join("+");
  terms.push(`${w}*(${chord})`);
}
const expr = `0.045*(${terms.join("+")})*(0.75+0.25*sin(2*PI*t/11))`;
writeFileSync(join(work, "bed.expr"), expr);
const bedFile = join(work, "bed.wav");
run(["-f", "lavfi", "-i", `aevalsrc=exprs=${expr.replace(/,/g, "\\,")}:s=48000:d=${total}`, "-af", "lowpass=f=900,highpass=f=70,afade=t=in:d=3,afade=t=out:st=" + (total - 4) + ":d=4", "-ac", "1", bedFile]);
const bedIdx = addInput(bedFile);
parts.push(`[${bedIdx}:a]volume=1.0[bed0]`);
// duck the bed whenever the voice speaks
parts.push(`[voice]asplit=2[voiceA][voiceB]`);
parts.push(`[bed0][voiceA]sidechaincompress=threshold=0.02:ratio=8:attack=40:release=500:makeup=1[bed]`);
parts.push(`[voiceB][bed][fx]amix=inputs=3:normalize=0,alimiter=limit=0.89:level=false,aformat=sample_fmts=s16:channel_layouts=stereo[out]`);

const script = join(work, "graph.txt");
writeFileSync(script, parts.join(";\n"));
mkdirSync(join(root, "audio"), { recursive: true });
run([...inputs, "-filter_complex_script", script, "-map", "[out]", "-ar", "48000", "-c:a", "libmp3lame", "-b:a", "192k", join(root, "audio", "mix.mp3")]);

writeFileSync(join(root, "src", "generated", "audio.json"), JSON.stringify({ mix: "audio/mix.mp3" }));
console.log(`audio/mix.mp3 written: ${events.length} interface sounds, ${voiceIdx.length} narration beats`);
