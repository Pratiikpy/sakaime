// The narration, one beat per sentence group, and the scene list. Every number is a placeholder that scripts/build-data.mjs
// resolves from a results file; scripts/check-numbers.mjs fails the build if a digit or a number word is typed here by hand,
// except for the raw tokens listed in RAW_TOKENS, each of which must appear in the file named beside it.

export interface SceneDef {
  id: string;
  /** Chapter label on screen, kept to a few words. */
  tag: string;
  kind: "graphic" | "footage" | "terminal";
  /** Recorded clip (video/footage/clips/<clip>.webm) for footage scenes. */
  clip?: string;
  /** Narration, one string per beat. A beat is one TTS call and one visual cue. */
  beats: string[];
  /** The scene never runs shorter than this many seconds, so a short sentence still leaves time to read the screen. */
  minSeconds: number;
}

export const SILOS = ["Regulator", "Trial registry", "Literature", "Vendor packet", "Hospital requirements"] as const;

/** Counts of lists that live in this file, usable as {local.name}. */
export const LOCAL_COUNTS: Record<string, number> = { "local.silos": SILOS.length };

/** Tokens that appear in the narration or on screen as typed text, each checked against the file that contains it. */
export const RAW_TOKENS: { text: string; file: string; needle?: string }[] = [
  { text: "1.7.0", file: "video/data/snapshots/case-transpara.json" },
  { text: "1.7.2", file: "video/data/snapshots/case-transpara.json" },
  { text: "2.1.0", file: "output_examples/api/recompute-release-3-0.json" },
  { text: "3.0", file: "output_examples/api/recompute-release-3-0.json" },
  { text: "2018", file: "output_examples/api/timeline-eyeart-as-of-2018.json" },
  { text: "K200667", file: "video/data/snapshots/case-eyeart.json" },
  { text: "K221347", file: "output_examples/api/propose-allowed-source.json" },
  { text: "CLM-EA-01", file: "video/data/snapshots/case-eyeart.json" },
  { text: "CLM-EA-08", file: "video/data/snapshots/case-eyeart.json" },
  { text: "CLM-EA-03", file: "video/data/snapshots/case-eyeart.json" },
  ...[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => ({ text: `L${i}`, file: "docs/02-architecture.md" })),
  { text: "22 and older", file: "video/data/snapshots/case-eyeart.json", needle: "22 and older" },
  { text: "18", file: "video/data/snapshots/case-eyeart.json", needle: '"min":18' },
  { text: "D-012", file: "docs/DECISIONS.md" },
  { text: "30B", file: "output_examples/model-route.json" },
  { text: "550B", file: "output_examples/model-route.json" },
  { text: "1.2.3", file: "README.md" },
  { text: "2.4.3.1", file: "infra/zetaris/GATES.md" },
];

export const SCENES: SceneDef[] = [
  {
    id: "hook", tag: "The problem", kind: "graphic", minSeconds: 8,
    beats: [
      "A vendor says its medical AI works.",
      "True, and still wrong for you: another version, another age group, another ward.",
      "Where does the evidence stop?",
    ],
  },
  {
    id: "problem", tag: "Fragmented evidence", kind: "graphic", minSeconds: 8,
    beats: [
      "{local.silos:w} systems. No shared identifier.",
      "Sakaime discovers them, joins them through Zetaris, and compares them with your use.",
    ],
  },
  {
    id: "pipeline", tag: "How it works", kind: "graphic", minSeconds: 15,
    beats: [
      "A guard screens the request. Zetaris federates the sources.",
      "Identity links records, keeping doubt. Extraction pins quotes to pages.",
      "The compiler compares {case.dimensions:w} dimensions, claimed against established.",
      "Models propose. Code checks. A signed dossier records it.",
    ],
  },
  {
    id: "addsource", tag: "Add a source", kind: "footage", clip: "addsource", minSeconds: 14,
    beats: [
      "Add a source nobody wired up.",
      "It is allowlisted, discovered, and probed within bounds.",
      "A model proposes a mapping; code checks units, scales, identifiers and joins.",
      "The checks hold some findings for a person. Only reviewed mappings reach Zetaris. {stages.count:w} stages.",
    ],
  },
  {
    id: "console", tag: "Source console", kind: "footage", clip: "console", minSeconds: 7,
    beats: [
      "A cloud-metadata address is refused at stage one.",
      "The console shows each source's health and fingerprint.",
    ],
  },
  {
    id: "matrix", tag: "Zetaris federation", kind: "footage", clip: "matrix", minSeconds: 11,
    beats: [
      "One Zetaris statement joins Postgres, registry snapshots and vendor files.",
      "Every column keeps its source badge.",
      "This run replays a recording of the real engine; the banner says so.",
    ],
  },
  {
    id: "usl", tag: "Semantic layer", kind: "footage", clip: "usl", minSeconds: 10,
    beats: [
      "A Unified Semantic Layer of {usl.tables:w} tables, in the reviewer's words.",
      "A quality rule found {usl.failures} of {usl.studies} study records with no eligibility block: unknown, never covered.",
    ],
  },
  {
    id: "uslplus", tag: "Semantic layer", kind: "graphic", minSeconds: 10,
    beats: [
      "An unassigned reviewer sees {mask.unassigned:w} of {mask.admin:w} cases; the engine does the masking.",
      "The honest cost: one read of the layer took {usl.ms.layer} milliseconds against {usl.ms.hand} by hand. It saved lines, not time.",
    ],
  },
  {
    id: "identity", tag: "Identity", kind: "footage", clip: "identity", minSeconds: 9,
    beats: [
      "Links are typed, scored, and shown with weights.",
      "Version 1.7.0 against the regulator's 1.7.2 stays ambiguous. No merge.",
    ],
  },
  {
    id: "xray", tag: "Claim X-ray", kind: "footage", clip: "xray", minSeconds: 11,
    beats: [
      "{case.dimensions:w} dimensions, claimed against established, each with quote, page and date.",
      "One claim is supported. One is contradicted: its population does not overlap.",
      "The rest say what is missing.",
    ],
  },
  {
    id: "lab", tag: "Applicability lab", kind: "footage", clip: "lab", minSeconds: 8.7,
    beats: [
      "Change the use and the answer recomputes: version 3.0 instead of 2.1.0, and the label drops to not enough evidence.",
      "No model is called.",
    ],
  },
  {
    id: "timeline", tag: "Timeline", kind: "footage", clip: "timeline", minSeconds: 6,
    beats: [
      "The World Model keeps history: read the case as it stood on any date, each finding tied to the facts it used.",
    ],
  },
  {
    id: "desk", tag: "Review desk", kind: "footage", clip: "desk", minSeconds: 8.5,
    beats: [
      "For each gap, the missing-evidence list drafts the vendor request.",
      "The reviewer decides; the decision is logged and never edits the evidence.",
    ],
  },
  {
    id: "investigation", tag: "Investigation", kind: "footage", clip: "investigation", minSeconds: 10,
    beats: [
      "A bounded loop: planner, checker, resolver, critic, reporter.",
      "Nemotron proposes, code verifies. {route.receipted} of {route.total} replies carry a verified Nightshift receipt.",
    ],
  },
  {
    id: "guard", tag: "Scout guard", kind: "footage", clip: "guard", minSeconds: 5,
    beats: [
      "Scout quarantines an instruction hidden inside a vendor document.",
    ],
  },
  {
    id: "drills", tag: "Failure drills", kind: "footage", clip: "drills", minSeconds: 8,
    beats: [
      "{drills.count:w} drills break it on purpose: a source offline, Zetaris stopped, a result cut short, a registry record changed. Only dependent findings go stale.",
      "A lost source never becomes supported.",
    ],
  },
  {
    id: "dossier", tag: "Signed dossier", kind: "footage", clip: "dossier", minSeconds: 10.5,
    beats: [
      "The signed dossier holds sources, quotes, rules and decisions.",
      "Change one character; the verifier names the failing item.",
      "The signature shows integrity, not who signed.",
    ],
  },
  {
    id: "judge", tag: "One command", kind: "terminal", minSeconds: 7,
    beats: [
      "One command, no keys: npm run judge.",
      "It re-verifies the hashes and re-runs the compiler, claim by claim.",
    ],
  },
  {
    id: "sponsors", tag: "Sponsor technology", kind: "graphic", minSeconds: 20,
    beats: [
      "Zetaris: federation, semantic layer, quality rule, masking. Without it, findings fall to insufficient.",
      "Meterless: H-MEM keeps links, the World Model tracks staleness, Markovian reads long documents, Scout guards.",
      "Nemotron, through Nightshift, plays planner, checker and critic, with signed receipts.",
      "Cursor was not used; the organizers call it optional.",
      "Sample mode replays recordings; compiler, verifiers and guard still run.",
    ],
  },
  {
    id: "results", tag: "Measured results", kind: "graphic", minSeconds: 20,
    beats: [
      "Measured, and labelled by who wrote the answers.",
      "Of {dev.V.falseSupported:n} unsupported claims, Sakaime labelled none supported; one Nemotron call did so {dev.B3.falseSupported:pct} percent of the time.",
      "The cost: exactly right on {dev.V.exact}, and all {dev.V.falseAlarm:k} well-supported claims flagged.",
      "{id.falseMerge} false merges. {fail.all} failure drills correct.",
    ],
  },
  {
    id: "limits", tag: "Limits", kind: "graphic", minSeconds: 13,
    beats: [
      "Claims are constructed. One builder wrote the keys; no clinician read them.",
      "No buyer was interviewed. The guard caught {scout.heldout} unseen injections.",
      "Not done: a blind second reviewer, a hospital trial, a live federation call here.",
    ],
  },
  {
    id: "close", tag: "Sakaime", kind: "graphic", minSeconds: 5.5,
    beats: [
      "Sakaime. Know where the evidence stops. Clone it, run npm run judge.",
    ],
  },
];
