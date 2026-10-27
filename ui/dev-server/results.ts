/**
 * Reads the published result files and turns the figures into the rows the About screen shows. Nothing is typed in:
 * a figure is parsed out of a result file, or the row says "to be measured". Parsing is strict; a table that no longer
 * has the expected shape yields no row instead of a guessed one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO } from "./world.ts";

export interface ResultRow {
  id: string;
  measure: string;
  status: "measured" | "to_be_measured";
  value?: string;
  denominator?: string;
  interval?: string;
  limits?: string;
  source?: string;
  group?: string;
}

const read = (path: string): string | undefined => (existsSync(join(REPO, path)) ? readFileSync(join(REPO, path), "utf8") : undefined);

/** "1.000 (48/48; Wilson 0.926 to 1.000)" */
const CELL = /^([\d.]+)\s*\((\d+\/\d+);\s*(Wilson [\d.]+ to [\d.]+)\)/;

function identityRows(): ResultRow[] {
  const md = read("data/identity-corpus/RESULTS.md");
  if (!md) return [];
  const section = md.split(/^## /m).find((s) => s.startsWith("Headline"));
  if (!section) return [];
  const wanted: [string, string][] = [
    ["Precision (links that are true)", "Links that are true (precision)"],
    ["Recall (true links found as CANDIDATE or CONFIRMED)", "True links found (recall)"],
    ["Correct abstention (AMBIGUOUS pairs left AMBIGUOUS)", "Ambiguous pairs left ambiguous"],
    ["False-merge rate (non-matches called a link)", "Non-matches wrongly called a link (false-merge rate)"],
  ];
  const rows: ResultRow[] = [];
  for (const [needle, measure] of wanted) {
    const line = section.split("\n").find((l) => l.startsWith(`| ${needle}`));
    const cell = line?.split("|")[2]?.trim();
    const m = cell ? CELL.exec(cell) : null;
    if (!m) continue;
    rows.push({
      id: `identity-${rows.length + 1}`,
      group: "Linking records across sources",
      measure,
      status: "measured",
      value: m[1]!,
      denominator: m[2]!,
      interval: m[3]!,
      limits: "Leave-one-family-out over 144 labelled pairs from 14 device families. Labels by one builder, not independent reviewers.",
      source: "data/identity-corpus/RESULTS.md",
    });
  }
  return rows;
}

function scoutRows(): ResultRow[] {
  const raw = read("tests/engines/scout/RESULTS.json");
  if (!raw) return [];
  try {
    const j = JSON.parse(raw) as { all?: { injection?: { recall?: R; precision?: R } } };
    const out: ResultRow[] = [];
    const add = (id: string, measure: string, r: R | undefined) => {
      if (!r || typeof r.k !== "number") return;
      out.push({
        id,
        group: "Guarding against instructions in documents",
        measure,
        status: "measured",
        value: r.p.toFixed(3),
        denominator: `${r.k}/${r.n}`,
        interval: `Wilson ${r.lo.toFixed(3)} to ${r.hi.toFixed(3)}`,
        limits: "Evaluation set of 426 labelled requests written by the builder. Not independent.",
        source: "tests/engines/scout/RESULTS.json",
      });
    };
    add("guard-recall", "Injection attempts caught (recall)", j.all?.injection?.recall);
    add("guard-precision", "Blocked requests that were attacks (precision)", j.all?.injection?.precision);
    return out;
  } catch {
    return [];
  }
}
interface R {
  k: number;
  n: number;
  p: number;
  lo: number;
  hi: number;
}

function extractionRows(): ResultRow[] {
  const md = read("tests/extraction/RESULTS.md");
  if (!md) return [];
  const rows: ResultRow[] = [];
  const fields: [string, string][] = [
    ["device version strings", "Software version strings read correctly"],
    ["care settings in the indications", "Care settings read correctly"],
    ["registered trial identifiers", "Trial identifiers read correctly"],
  ];
  for (const [needle, measure] of fields) {
    const line = md.split("\n").find((l) => l.startsWith(`| ${needle} |`));
    const c = line?.split("|").map((x) => x.trim());
    // | field | gold | extracted | correct | wrong | missed | precision | recall |
    if (!c || c.length < 9) continue;
    const gold = c[2]!;
    const correct = c[4]!;
    const recall = c[8]!;
    if (!/^\d+$/.test(gold) || !/^\d+$/.test(correct) || !/^[\d.]+$/.test(recall)) continue;
    rows.push({
      id: `extract-${rows.length + 1}`,
      group: "Reading FDA summaries",
      measure,
      status: "measured",
      value: recall,
      denominator: `${correct}/${gold}`,
      limits: "Development set of 12 summaries the parser was built on, labelled by one reader who also wrote it. In-sample.",
      source: "tests/extraction/RESULTS.md",
    });
  }
  return rows;
}

function gate0Rows(): ResultRow[] {
  const raw = read("evals/gate0/arms/scored.json");
  if (!raw) return [];
  try {
    const s = (JSON.parse(raw) as { summary: { claims: number; nativeVerdictsEmitted: Record<string, number>; derivableFromArmOutput: Record<string, { derivable: number }> } }).summary;
    const out: ResultRow[] = [];
    for (const arm of ["constat", "healthit"]) {
      const name = arm === "constat" ? "Constat (free tier)" : "HealthIT.com Evidence Explorer";
      out.push({
        id: `gate0-${arm}`,
        group: "Same-input test against other tools (their output only)",
        measure: `${name}: claims where the tool itself gives an applicability verdict`,
        status: "measured",
        value: String(s.nativeVerdictsEmitted[arm] ?? 0),
        denominator: `${s.nativeVerdictsEmitted[arm] ?? 0}/${s.claims}`,
        limits: `A verdict could be worked out by hand from the tool's output for ${s.derivableFromArmOutput[arm]?.derivable ?? 0} of ${s.claims} claims. The 26 claims are constructed and the key is the builder's.`,
        source: "evals/gate0/arms/scored.json",
      });
    }
    return out;
  } catch {
    return [];
  }
}

const PLANNED: [string, string][] = [
  ["False-supported rate on a held-out set", "The safety measure: claims called supported that the key says are not."],
  ["Critical mismatches found, against the strongest baseline", "Recall on claims with a known mismatch."],
  ["False-alarm rate", "Well-supported claims that were flagged."],
  ["Correct answers of Supported", "So that refusing everything cannot look good."],
  ["Correct abstention when a source is switched off", "Across the whole drill suite."],
  ["Findings recomputed after a change", "Exactly the dependent findings, and no others."],
  ["Reviewer study: time and correctness with and without the tool", "Needs independent reviewers, which have not been found."],
];

export function buildResults(): { generatedAt: string; note: string; rows: ResultRow[] } {
  const measured = [...identityRows(), ...scoutRows(), ...extractionRows(), ...gate0Rows()];
  const planned: ResultRow[] = PLANNED.map(([measure, limits], i) => ({
    id: `planned-${i + 1}`,
    group: "Planned, not yet measured",
    measure,
    status: "to_be_measured",
    limits,
  }));
  return {
    generatedAt: new Date().toISOString(),
    note: "Each figure below is read from a result file in the repository when this page is served. Nothing on this page is typed in.",
    rows: [...measured, ...planned],
  };
}
