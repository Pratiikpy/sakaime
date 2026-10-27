// How each recorded clip is cut: which clip moment lands on which narration beat, where the camera goes, what is called out.
// Text is a template (see lib/fmt.ts); cue names are the marks written by footage/scripts/<clip>.mjs.
// scripts/check-cues.mjs fails the build when a cue named here is missing from a clip.

export interface FootageConfig {
  clip: string;
  caption: string;
  startCue?: string;
  sync: { cue: string; beat: number; offset?: number }[];
  camera?: { cue: string; scale: number; lead?: number; focus?: "box" | "center"; shiftX?: number; shiftY?: number }[];
  callouts?: { cue: string; text: string; tone?: "good" | "bad" | "ink"; hold?: number; from?: number; side?: "above" | "below" }[];
}

export const FOOTAGE: Record<string, FootageConfig> = {
  addsource: {
    clip: "addsource",
    caption: "Add a source: {stages.count:w} stages, one decision",
    sync: [
      { cue: "form", beat: 0 },
      { cue: "running", beat: 1 },
      { cue: "semantic", beat: 2 },
      { cue: "mapping", beat: 2, offset: 80 },
      { cue: "outcome", beat: 3 },
    ],
    camera: [
      { cue: "form", scale: 1.3, lead: 0.9 },
      { cue: "running", scale: 1.0, focus: "center", lead: 0.2 },
      { cue: "semantic", scale: 1.35 },
      { cue: "mapping", scale: 1.2 },
      { cue: "outcome", scale: 1.3 },
    ],
    callouts: [
      { cue: "filled", text: "An address on the allowlist", tone: "good", hold: 2.2 },
      { cue: "stages", text: "{stages.count:w} stages, each with its reason", hold: 2.6, side: "below" },
      { cue: "semantic", text: "Semantic check: held for a person", tone: "ink", hold: 2.8 },
      { cue: "mapping", text: "Each mapping checked against the values", hold: 2.8 },
      { cue: "outcome", text: "Held for review, not registered", tone: "ink", hold: 2.6 },
    ],
  },
  console: {
    clip: "console",
    caption: "Source console",
    sync: [
      { cue: "filled", beat: 0 },
      { cue: "refused", beat: 0, offset: 35 },
      { cue: "table", beat: 1, offset: 20 },
    ],
    camera: [
      { cue: "filled", scale: 1.3, lead: 0.8 },
      { cue: "refused", scale: 1.3 },
      { cue: "table", scale: 1.0, focus: "center" },
      { cue: "health", scale: 1.3 },
    ],
    callouts: [
      { cue: "refused", text: "Refused at stage one", tone: "bad", hold: 2.6 },
      { cue: "table", text: "Every source the product reads", hold: 1.8 },
      { cue: "health", text: "Health, schema fingerprint, freshness", hold: 2.4 },
    ],
  },
  matrix: {
    clip: "matrix",
    caption: "One federated statement: the Evidence Matrix",
    sync: [
      { cue: "meta", beat: 0 },
      { cue: "table", beat: 0, offset: 75 },
      { cue: "badges", beat: 1 },
      { cue: "columns", beat: 1, offset: 45 },
      { cue: "sql", beat: 2, offset: 30 },
      { cue: "banner", beat: 2, offset: 75 },
    ],
    camera: [
      { cue: "meta", scale: 1.25, lead: 0.8 },
      { cue: "table", scale: 1.0, focus: "center" },
      { cue: "badges", scale: 1.45 },
      { cue: "columns", scale: 1.3 },
      { cue: "sql", scale: 1.15 },
      { cue: "banner", scale: 1.3 },
    ],
    callouts: [
      { cue: "meta", text: "One statement, one query id", hold: 2.4 },
      { cue: "badges", text: "Each column tied to its source", hold: 2.6, side: "below" },
      { cue: "sql", text: "The statement Zetaris ran", hold: 2.2 },
      { cue: "banner", text: "Recorded replay, stated on every screen", tone: "ink", hold: 2.6, side: "below" },
    ],
  },
  usl: {
    clip: "usl",
    caption: "Zetaris Unified Semantic Layer",
    sync: [
      { cue: "panel", beat: 0 },
      { cue: "completeness", beat: 0, offset: 45 },
      { cue: "tables", beat: 0, offset: 80 },
      { cue: "rule", beat: 1, offset: 60 },
    ],
    camera: [
      { cue: "panel", scale: 1.15, lead: 0.8 },
      { cue: "tables", scale: 1.1 },
      { cue: "rules", scale: 1.0, focus: "center" },
      { cue: "rule", scale: 1.3 },
    ],
    callouts: [
      { cue: "panel", text: "Read as the read-only agent identity", hold: 2.4 },
      { cue: "tables", text: "{usl.tables:w} tables, each described", hold: 2.4 },
      { cue: "rule", text: "{usl.failures} of {usl.studies} failed: unknown, never covered", tone: "bad", hold: 3.2 },
    ],
  },
  identity: {
    clip: "identity",
    caption: "Identity: typed links, uncertainty kept",
    sync: [
      { cue: "links", beat: 0 },
      { cue: "link", beat: 1 },
      { cue: "weights", beat: 1, offset: 75 },
    ],
    camera: [
      { cue: "links", scale: 1.15, lead: 0.8 },
      { cue: "link", scale: 1.3 },
      { cue: "weights", scale: 1.15 },
    ],
    callouts: [
      { cue: "links", text: "Typed links, each with a state", hold: 2.4 },
      { cue: "flag", text: "version-differs: 1.7.0 versus 1.7.2", tone: "bad", hold: 2.4, from: -0.1 },
      { cue: "weights", text: "Weights per field: the score", hold: 2.6, side: "below" },
    ],
  },
  xray: {
    clip: "xray",
    caption: "Claim X-ray: claimed against established",
    sync: [
      { cue: "dimensions", beat: 0 },
      { cue: "passages", beat: 0, offset: 60 },
      { cue: "contradicted", beat: 1 },
      { cue: "counterexample", beat: 1, offset: 70 },
    ],
    camera: [
      { cue: "dimensions", scale: 1.25, lead: 0.9 },
      { cue: "passages", scale: 1.2 },
      { cue: "contradicted", scale: 1.25 },
      { cue: "counterexample", scale: 1.3 },
    ],
    callouts: [
      { cue: "dimensions", text: "{case.dimensions:w} dimensions, one relation each", hold: 2.4 },
      { cue: "passages", text: "Exact passage, page and source", hold: 2.6 },
      { cue: "contradicted", text: "Contradicted: the population is disjoint", tone: "bad", hold: 2.4 },
      { cue: "counterexample", text: "The smallest mismatch", tone: "ink", hold: 2.6 },
    ],
  },
  lab: {
    clip: "lab",
    caption: "Applicability lab: change the use, recompute",
    sync: [
      { cue: "baseline", beat: 0 },
      { cue: "typed", beat: 0, offset: 55 },
      { cue: "result", beat: 0, offset: 105 },
      { cue: "nomodel", beat: 1 },
    ],
    camera: [
      { cue: "form", scale: 1.15, lead: 0.8 },
      { cue: "typed", scale: 1.4 },
      { cue: "result", scale: 1.25 },
      { cue: "nomodel", scale: 1.3 },
    ],
    callouts: [
      { cue: "baseline", text: "Before: needs domain review", hold: 2.0 },
      { cue: "typed", text: "Version 3.0 instead of 2.1.0", tone: "bad", hold: 2.0 },
      { cue: "result", text: "After: not enough evidence", tone: "bad", hold: 2.6 },
      { cue: "nomodel", text: "No model called", tone: "ink", hold: 2.4 },
    ],
  },
  timeline: {
    clip: "timeline",
    caption: "Timeline: the case as of any date",
    sync: [
      { cue: "controls", beat: 0 },
      { cue: "asof", beat: 0, offset: 70 },
      { cue: "events", beat: 0, offset: 130 },
    ],
    camera: [
      { cue: "controls", scale: 1.25, lead: 0.8 },
      { cue: "asof", scale: 1.25 },
      { cue: "events", scale: 1.15 },
    ],
    callouts: [
      { cue: "controls", text: "Read the case as of a date", hold: 2.0 },
      { cue: "asof", text: "What was known in 2018", hold: 2.2 },
      { cue: "events", text: "Every fact, with its source", hold: 2.2 },
    ],
  },
  desk: {
    clip: "desk",
    caption: "Review desk, missing evidence, decisions",
    sync: [
      { cue: "settle", beat: 0 },
      { cue: "missing", beat: 0, offset: 45 },
      { cue: "decision", beat: 1 },
      { cue: "recorded", beat: 1, offset: 100 },
    ],
    camera: [
      { cue: "stats", scale: 1.2, lead: 0.6 },
      { cue: "settle", scale: 1.2 },
      { cue: "missing", scale: 1.2 },
      { cue: "decision", scale: 1.25 },
      { cue: "recorded", scale: 1.25 },
    ],
    callouts: [
      { cue: "stats", text: "Open questions, out-of-date findings", hold: 1.8 },
      { cue: "settle", text: "What would settle it", hold: 2.2 },
      { cue: "missing", text: "A drafted request to the vendor", hold: 2.6 },
      { cue: "decision", text: "The reviewer decides", tone: "ink", hold: 2.2 },
      { cue: "recorded", text: "Logged; the evidence is unchanged", hold: 2.4 },
    ],
  },
  investigation: {
    clip: "investigation",
    caption: "Investigation: roles, trace, receipts",
    sync: [
      { cue: "roles", beat: 0 },
      { cue: "trace", beat: 0, offset: 70 },
      { cue: "planner", beat: 1 },
      { cue: "critic", beat: 1, offset: 100 },
    ],
    camera: [
      { cue: "roles", scale: 1.15, lead: 0.7 },
      { cue: "trace", scale: 1.1 },
      { cue: "planner", scale: 1.25 },
      { cue: "critic", scale: 1.25 },
    ],
    callouts: [
      { cue: "roles", text: "Bounded roles", hold: 2.2 },
      { cue: "trace", text: "Every step is traced", hold: 2.4 },
      { cue: "planner", text: "Model, recorded reply, signed receipt", hold: 2.8 },
      { cue: "critic", text: "The critic answers too", tone: "ink", hold: 2.8 },
    ],
  },
  guard: {
    clip: "guard",
    caption: "Scout guard",
    sync: [
      { cue: "text", beat: 0 },
      { cue: "result", beat: 0, offset: 80 },
    ],
    camera: [
      { cue: "text", scale: 1.25, lead: 0.7 },
      { cue: "result", scale: 1.25 },
    ],
    callouts: [
      { cue: "text", text: "An instruction inside a vendor document", tone: "bad", hold: 2.4 },
      { cue: "result", text: "Set aside, not obeyed", hold: 2.8 },
    ],
  },
  drills: {
    clip: "drills",
    caption: "{drills.count:w} failure drills",
    sync: [
      { cue: "cards", beat: 0 },
      { cue: "stale", beat: 0, offset: 90 },
      { cue: "summary", beat: 0, offset: 205 },
      { cue: "detail", beat: 1, offset: 30 },
    ],
    camera: [
      { cue: "cards", scale: 1.1, lead: 0.8 },
      { cue: "stale", scale: 1.2 },
      { cue: "summary", scale: 1.2 },
      { cue: "detail", scale: 1.25 },
    ],
    callouts: [
      { cue: "cards", text: "{drills.count:w} ways to break it", hold: 2.4 },
      { cue: "stale", text: "Only dependent findings go stale", hold: 2.6 },
      { cue: "summary", text: "Less sure, never more", hold: 2.6 },
      { cue: "detail", text: "Nothing became supported", hold: 2.6 },
    ],
  },
  dossier: {
    clip: "dossier",
    caption: "Signed dossier and the tamper test",
    sync: [
      { cue: "exported", beat: 0 },
      { cue: "verified", beat: 0, offset: 70 },
      { cue: "tampered", beat: 1, offset: 30 },
      { cue: "signature", beat: 2 },
    ],
    camera: [
      { cue: "exported", scale: 1.2, lead: 0.7 },
      { cue: "verified", scale: 1.2 },
      { cue: "tampered", scale: 1.3 },
      { cue: "signature", scale: 1.3 },
    ],
    callouts: [
      { cue: "exported", text: "One file: sources, quotes, rules, decisions", hold: 2.4 },
      { cue: "verified", text: "Verifier: hashes and signature intact", hold: 2.2 },
      { cue: "tampered", text: "One character changed: the item is named", tone: "bad", hold: 2.8 },
      { cue: "signature", text: "Integrity, not identity: a demo key", tone: "ink", hold: 2.6 },
    ],
  },
};
