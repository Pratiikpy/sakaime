// Writes video/README.md and video/COVERAGE.md from the timeline, the narration and the figure sources, so the timestamps and
// the source of every number cannot drift from what is rendered. Run by `npm run build:all`; safe to run alone.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const { SCENES, RAW_TOKENS } = await import(pathToFileURL(join(root, "src", "content.ts")).href);
const { FOOTAGE } = await import(pathToFileURL(join(root, "src", "footageConfigs.ts")).href);
const { expand } = await import(pathToFileURL(join(root, "src", "lib", "fmt.ts")).href);
const tl = JSON.parse(readFileSync(join(root, "src", "generated", "timeline.json"), "utf8"));
const figures = JSON.parse(readFileSync(join(root, "src", "generated", "figures.json"), "utf8"));
const cues = JSON.parse(readFileSync(join(root, "src", "generated", "cues.json"), "utf8"));
const { LOCAL_COUNTS } = await import(pathToFileURL(join(root, "src", "content.ts")).href);

const t = (frames) => {
  const s = frames / tl.fps;
  return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
};
const at = (id) => {
  const s = tl.scenes.find((x) => x.id === id);
  return s ? `${t(s.start)} to ${t(s.start + s.frames)}` : "n/a";
};

const SCENE_FILE = { hook: "Hook.tsx", problem: "Problem.tsx", pipeline: "Pipeline.tsx", uslplus: "Usl.tsx", judge: "Terminal.tsx", sponsors: "Sponsors.tsx", results: "Results.tsx", limits: "Limits.tsx", close: "Close.tsx" };
const DIRECT = {
  hook: "video/data/snapshots/case-eyeart.json (the constructed claim CLM-EA-01 and the mismatches in CLM-EA-04, CLM-EA-10, CLM-EA-03)",
  problem: "src/connectors identifier fields (k_number, nct_id, pmid, claim_id, case_id); silo kinds from docs/02-architecture.md",
  pipeline: "video/data/snapshots/case-eyeart.json (finding for CLM-EA-01: seven dimensions, relations, anchor page, link state, matrix row count)",
  uslplus: "video/data/snapshots/zetaris-masking.json, docs/zetaris-usl-reflection.md (timings and line counts, verbatim table rows)",
  judge: "video/data/snapshots/judge.txt (the real output of npm run judge)",
  sponsors: "output_examples/model-route.json, video/data/snapshots/usl.json, evals/results/timeshift.json",
  results: "evals/results/*.json (see the figure list below)",
  limits: "README.md limits, evals/ERRATA.md",
  close: "package.json (repository), README.md",
};

// figure keys used by a scene: placeholders in its narration and callouts, and quoted keys in its component
const keysIn = (text) => [...text.matchAll(/\{([a-zA-Z0-9_.-]+)(?::[a-z]+)?\}/g)].map((m) => m[1]).filter((k) => k in figures);
const used = (scene) => {
  const set = new Set();
  for (const b of scene.beats) keysIn(b).forEach((k) => set.add(k));
  const cfg = FOOTAGE[scene.id];
  if (cfg) {
    keysIn(cfg.caption).forEach((k) => set.add(k));
    (cfg.callouts ?? []).forEach((c) => keysIn(c.text).forEach((k) => set.add(k)));
  }
  const f = SCENE_FILE[scene.id];
  if (f) {
    const src = readFileSync(join(root, "src", "scenes", f), "utf8");
    for (const k of Object.keys(figures)) if (src.includes(`"${k}"`) || src.includes(`{${k}}`) || src.includes(`{${k}:`)) set.add(k);
  }
  return [...set];
};

const rows = SCENES.map((s) => {
  const keys = used(s);
  const srcs = [...new Set(keys.map((k) => figures[k].source))];
  const kind = s.kind === "footage" ? `recorded (${s.clip})` : s.kind === "terminal" ? "motion graphic over real output" : "motion graphic";
  const own = s.kind === "footage" ? `the product's own screen as served in sample mode, recorded by video/footage/scripts/${s.clip}.mjs` : undefined;
  const sources = [own, DIRECT[s.id], ...srcs].filter(Boolean).join("; ");
  return { s, kind, sources, keys };
});

// ------------------------------------------------------------------ README
const timelineTable = rows
  .map((r, i) => `| ${String(i + 1).padStart(2, "0")} | ${at(r.s.id)} | ${r.s.id} | ${r.kind} | ${r.sources} |`)
  .join("\n");

const figureTable = Object.entries(figures)
  .filter(([k]) => k !== "labels.file")
  .map(([k, f]) => {
    const v = f.kind === "kn" ? `${f.k} of ${f.n}` : f.kind === "meanWorst" ? `mean ${(f.mean * 100).toFixed(1)}%, worst ${(f.worst * 100).toFixed(1)}%, ${f.runs} run(s)` : String(f.value);
    return `| \`${k}\` | ${v} | \`${f.source}\` | \`${f.path}\` |`;
  })
  .join("\n");

const readme = `# Sakaime demo video

A ${t(tl.totalFrames)} (${tl.totalSeconds.toFixed(1)} s) demo video for the Open Agent Hackathon 2026, Track 1. It is a Remotion composition at 1920x1080, 30 fps, H.264, over **real footage of the running product** (scripted Chrome, recorded against the real service in sample mode) and motion graphics whose figures are read from the repository's results files. Voiceover is local text to speech. The default render has no burned-in subtitles (the on-screen titles, callouts and figures carry the meaning); a second render with subtitles that carry exactly the voiceover's words is made for muted viewing.

Generated by \`scripts/make-docs.mjs\` from the rendered timeline. Do not edit by hand.

## Commands (run inside \`video/\`)

\`\`\`
npm install                  once; the video has its own node_modules and does not touch the root package.json
npm run build:all            everything below, in order, ending with both renders and the review frames
\`\`\`

\`build:all\` runs these steps; each can be run alone:

| Command | What it does |
|---|---|
| \`npm run ui\` | \`npm run ui:build\` at the repository root |
| \`npm run footage\` | freezes ui/dist into footage/ui-snapshot, then records every clip: each one against its own fresh \`SAMPLE_MODE=true\` service on its own port, 1920x1080, with a drawn cursor, at human pace; writes footage/clips/*.mp4 and *.cues.json |
| \`npm run snapshot\` | stores the JSON the service serves (health, cases, sources, semantic layer) and the real output of \`npm run judge\` under data/snapshots |
| \`npm run data\` | reads every figure from its source file into src/generated/figures.json; merges the footage cues |
| \`npm run voice\` | synthesises each narration beat (Piper, voice en_GB-cori-high, a public-domain recording), measures it, writes the timeline, then builds audio/mix.mp3 (voice, a synthesised music bed that ducks under the voice, soft interface sounds) |
| \`npm run check\` | wording lint, number check, cue check, length gate (fails above 3:58) |
| \`npm run render\` | \`out/sakaime-demo.mp4\` (subtitles on), then ffprobe length check |
| \`npm run render:clean\` | \`out/sakaime-demo-nocaptions.mp4\` (same, no subtitles) |
| \`npm run frames\` | one frame per second of every scene as contact sheets and single frames in out/frames |
| \`npm run studio\` | Remotion Studio on port 3986 |

Needs Node 24, Google Chrome (the recorder uses \`channel: "chrome"\`), ffmpeg and ffprobe on PATH, and for the voice a Python venv with \`piper-tts\` and the voice model (paths in scripts/voice.mjs, overridable with PIPER_PYTHON and PIPER_MODEL). The ElevenLabs route was not available (the key was rejected, HTTP 401), so no paid service is used.

## What is recorded and what is graphics

Recorded, from the real running product: add a source (all eight stages), the source console and a refused address, the Evidence Matrix, the Unified Semantic Layer panel, identity links, the Claim X-ray, the Applicability Lab, the Timeline, the Review Desk with a recorded decision, the Investigation trace, the Scout guard, the failure drills, and the signed dossier with the tamper test. The run-mode banner of the product is in view at the start of each clip, and the same four chips (restated from the service's own health response) stay in the top strip of every product scene.

Motion graphics: the hook, the fragmented-sources problem, the pipeline, the masking and cost comparison for the semantic layer, the terminal (real \`npm run judge\` output, played back), sponsors, measured results, limits, close. Every claim shown is labelled constructed; every replayed reply is labelled recorded.

## Timeline, with the source of every number

| # | Time | Scene | Kind | Where the numbers and facts come from |
|---|---|---|---|---|
${timelineTable}

## Every figure and its file

Each figure is declared in \`data/figures.manifest.mjs\` and read by \`scripts/build-data.mjs\`. \`scripts/check-numbers.mjs\` fails the build if a digit or a number word in the narration, a caption, a callout or a scene is typed by hand instead of coming from a placeholder, or is one of the few raw tokens (versions, claim ids) that must appear verbatim in the file named beside them in \`src/content.ts\`.

| Figure | Value | File | Path |
|---|---|---|---|
${figureTable}

## How a clip is tied to the narration

footage/lib.mjs records named marks (\`mark("semantic", locator)\`) with the time and the on-screen box of an element. src/footageConfigs.ts pins marks to narration beats (\`sync\`), moves the camera to a mark (\`camera\`) and places labelled outlines (\`callouts\`). The clip is played faster or slower between pins, so the footage is real and unedited while its pace follows the voice. When the interface changes, re-run \`npm run footage\`; \`npm run check:cues\` fails if a mark the cut depends on is missing.

## Checks run on every render

\`check:words\` (banned wording and the labels the product never emits), \`check:numbers\`, \`check:cues\`, \`check:length\` (3:58 gate, also run against the rendered file with ffprobe). See also \`COVERAGE.md\`.
`;
writeFileSync(join(root, "README.md"), readme);

// ------------------------------------------------------------------ COVERAGE
const A = (id) => `${at(id)} (${id})`;
const covRows = [
  ["Demo video of 1 to 4 minutes", "[F7] [W9]", `whole video, ${t(tl.totalFrames)}; length gate 3:58`, "video/scripts/check-length.mjs"],
  ["Shows the main workflow end to end", "[F7] [A14]", `${A("addsource")}, ${A("matrix")}, ${A("xray")}, ${A("desk")}, ${A("dossier")}`, "ui/src/screens/*, tests/ui/flows.spec.ts"],
  ["Shows how the agent solves the selected challenge (discover and work across fragmented sources)", "[F7] [W5 Track 1]", `${A("problem")}, ${A("pipeline")}, ${A("addsource")}, ${A("matrix")}, ${A("identity")}`, "docs/01-prd.md, docs/02-architecture.md, src/discovery, src/identity"],
  ["Key features", "[F7]", `${A("console")}, ${A("usl")}, ${A("xray")}, ${A("lab")}, ${A("timeline")}, ${A("desk")}, ${A("investigation")}, ${A("guard")}, ${A("drills")}, ${A("dossier")}, ${A("judge")}`, "README.md, docs/05-requirements-matrix.md"],
  ["How Zetaris is integrated", "[F7] [W9]", `${A("matrix")}, ${A("usl")}, ${A("uslplus")}, ${A("sponsors")}, ${A("addsource")} (registration)`, "src/federation, src/discovery, infra/zetaris/GATES.md, docs/zetaris-usl-reflection.md"],
  ["How Meterless is integrated", "[F7] [W9]", `${A("sponsors")}, ${A("timeline")} (World Model), ${A("identity")} (H-MEM links), ${A("guard")} (Scout)`, "src/engines, third_party/meterless, tests/engines/ABLATIONS.md"],
  ["Where NVIDIA technology contributes", "[F7]", `${A("investigation")}, ${A("sponsors")}, ${A("addsource")} (mapping proposal)`, "src/models, output_examples/model-route.json"],
  ["How Cursor was used during development", "[F7] [setup checklist]", `${A("sponsors")}: stated as not used, optional per the organizers`, "docs/DECISIONS.md D-012"],
  ["What was unique about the use of the sponsor technologies", "[F7]", `${A("sponsors")}, ${A("uslplus")}, ${A("results")}`, "tests/engines/ABLATIONS.md, data/discovery-shift/RESULTS.md, docs/zetaris-usl-reflection.md"],
  ["Evidence of how the output was reached: logs, traces, cited sources", "[W3] [A14]", `${A("xray")} (quote, page, retrieval date), ${A("investigation")} (trace and receipts), ${A("dossier")}`, "output_examples/traces, output_examples/dossiers, src/dossier"],
  ["Critique and recovery, not a fixed pipeline", "[F8] [A9]", `${A("investigation")} (critic role), ${A("drills")}, ${A("identity")} (uncertainty kept), ${A("timeline")}`, "src/agents/critic.ts, src/agents/investigation.ts, evals/results/failureshift.json"],
  ["Safety: no overclaiming, no unsupported claim of value", "[A4] [A20]", `${A("xray")}, ${A("drills")}, ${A("results")}, ${A("limits")}`, "src/compiler/compile.ts, evals/RESULTS.md, evals/ERRATA.md"],
  ["A repository that runs from a clean setup, with sample inputs and outputs", "[A14]", `${A("judge")}, ${A("close")}`, "README.md, input_examples, output_examples, scripts/judge.ts"],
  ["Limitations stated honestly", "[A4]", `${A("results")} (unfavourable rows), ${A("limits")}`, "README.md limits, evals/ERRATA.md"],
  ["AI Usage Policy 4.1: the default mode must run real agent logic", "[channel digest]", `${A("sponsors")} (what is replayed and what runs for real), ${A("matrix")} (banner), every product scene (run-mode strip)`, "docs/DECISIONS.md D-026, docs/11-channel-intel.md"],
  ["Real, not hardcoded, demo paths (judges discount hardcoded paths)", "[F8]", "every product scene is a real recording of the running service; each clip has its own fresh service; the Lab and the drills run the real code", "video/footage/lib.mjs, video/footage/record-all.mjs"],
  ["More than one agent, interacting (judges discount single agents presented as many)", "[F8] [W3]", `${A("investigation")}: planner, checker, resolver, critic, reporter, each with its recorded reply and receipt`, "src/agents, src/models/roles.ts"],
  ["UI polish is not a substitute for depth", "[F8]", `${A("results")} and ${A("limits")} carry the measured and unmeasured`, "evals/RESULTS.md"],
];

const lead = [
  ["The fragmented-sources problem", A("problem")],
  ["Add a source with the eight stages and the semantic checks", A("addsource")],
  ["The Source Console and a refused address", A("console")],
  ["Zetaris: one federated statement", A("matrix")],
  ["Evidence Matrix with per-column source badges", A("matrix")],
  ["Unified Semantic Layer panel and the data-quality rule result", A("usl")],
  ["Masking for an unassigned reviewer", A("uslplus")],
  ["The by-hand against Unified Semantic Layer comparison, honest that it saved no run time", A("uslplus")],
  ["Identity: typed links, an uncertain link kept uncertain", A("identity")],
  ["Claim X-ray with exact page anchors", A("xray")],
  ["Applicability Lab recomputing with no model call", A("lab")],
  ["Timeline and change impact (only dependent findings go stale)", `${A("timeline")}, ${A("drills")}`],
  ["Review Desk and decisions", A("desk")],
  ["Missing-evidence list with the vendor request", A("desk")],
  ["The seven failure drills", A("drills")],
  ["The investigation trace, Nemotron roles, Nightshift receipts", A("investigation")],
  ["The Scout guard quarantining an instruction in a vendor document", A("guard")],
  ["The signed dossier and the tamper test", A("dossier")],
  ["The one-command judge script", A("judge")],
  ["The sponsor roles", A("sponsors")],
  ["Measured results including the unfavourable rows", A("results")],
  ["The honest limits", A("limits")],
];

const notShown = [
  "Pre-existing components are declared in the HackOS form and in docs/provenance.md, not in the video.",
  "Zetaris natural-language-to-SQL (gate Z-NL) is blocked in the installed build; the video does not mention it. See infra/zetaris/GATES.md.",
  "The slide deck, the sponsor technology explanation and the README are separate submission parts; the video does not replace them.",
  "Live mode (Docker with the Zetaris stack and a live Nightshift route) is not shown. Every product scene is sample mode, stated on screen. Live mode ran once end to end (README, Limits).",
  "Cost and latency of the model arms, a blind second reviewer, a hospital trial and any clinical sign-off were not done and are named as not done in the limits scene.",
  "The Meterless engine ablations (World Model, H-MEM, Markovian, Scout) are in tests/engines; the video names the roles and one cost (over-flagging) but does not chart them.",
  "Audio: the voiceover is synthetic (Piper, local). The ElevenLabs key was rejected with HTTP 401, so a human-sounding voice was not produced.",
];

const coverage = `# Coverage: every ask, the scene that answers it, and the file that proves it

Generated by \`scripts/make-docs.mjs\` from the rendered timeline. Source tags: F = organizer FAQ, W = welcome guide, A = approach guide (all in research/hackathon/organizer), plus the channel digest in docs/reference. Where an ask is not covered the row says so under "Not shown in the video".

## What the organizers ask of the video and of the demo

| Ask | Source | Scene and time | Proof in the repository |
|---|---|---|---|
${covRows.map((r) => `| ${r.join(" | ")} |`).join("\n")}

## What the owner asked the video to show

| Item | Scene and time |
|---|---|
${lead.map((r) => `| ${r.join(" | ")} |`).join("\n")}

## Not shown in the video

${notShown.map((n) => `- ${n}`).join("\n")}

The limits scene says on screen: not done, a blind second reviewer, a hospital trial, a live federation call in this video.
`;
writeFileSync(join(root, "COVERAGE.md"), coverage);
console.log("README.md and COVERAGE.md written");
