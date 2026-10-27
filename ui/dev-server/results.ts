/**
 * Reads the published result files and turns the figures into the rows the About screen shows. Nothing is typed in:
 * a figure is parsed out of a result file, or the row says "to be measured". Parsing is strict; a table that no longer
 * has the expected shape yields no row instead of a guessed one.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

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

interface Rate {
  k: number;
  n: number;
  rate: number | null;
  wilsonLo?: number;
  wilsonHi?: number;
}

/**
 * Headline figures from the evaluation runs in evals/results. Each row names the file and key it was read from. A missing file or
 * key yields no row, never a guessed one, and the limits text repeats what the run's own report says about what the figure is not.
 */
function evalRows(): ResultRow[] {
  const wanted: { file: string; path: string[]; id: string; group: string; measure: string; limits: string }[] = [
    {
      file: "scopeshift-a.json",
      path: ["exactLabel"],
      id: "scopeshift-a-exact",
      group: "The rules against a rule table",
      measure: "Answers that match the rule table on controlled one-change cases",
      limits: "Consistency check on 236 cases over 18 real FDA summaries, 17 device families. It shows the code does what the table says, not that the table is clinically right.",
    },
    {
      file: "scopeshift-a.json",
      path: ["falseSupported"],
      id: "scopeshift-a-false-supported",
      group: "The rules against a rule table",
      measure: "Cases called supported although the key withholds support",
      limits: "Same 236 cases. Lower is better; this is the safety measure, and it is not zero.",
    },
    {
      file: "scopeshift-b-held-out.json",
      path: ["heldout.V.exact"],
      id: "scopeshift-b-exact",
      group: "The whole pipeline on documents held out from development",
      measure: "Answers that match the builder's key (exact label)",
      limits: "Five held-out devices, key sealed before the run. Labels by one builder, not independent reviewers. The shortfall is in the hand-off from document reading to the rules, not in the rules themselves.",
    },
    {
      file: "scopeshift-b-held-out.json",
      path: ["heldout.V.falseSupported"],
      id: "scopeshift-b-false-supported",
      group: "The whole pipeline on documents held out from development",
      measure: "Claims called supported although the key withholds support",
      limits: "Same held-out set. Zero here is partly because the pipeline abstains on most claims; read it with the exact-label row.",
    },
    {
      file: "scopeshift-b-held-out.json",
      path: ["heldout.V.falseAlarm"],
      id: "scopeshift-b-false-alarm",
      group: "The whole pipeline on documents held out from development",
      measure: "Well-supported claims that were flagged",
      limits: "Same held-out set; a small number of claims.",
    },
    {
      file: "timeshift.json",
      path: ["staleSetEqualsDependentSet"],
      id: "timeshift-stale-set",
      group: "Changes after a finding was made",
      measure: "Cases where the findings marked out of date are exactly the dependent ones",
      limits: "Consistency check on 27 constructed changes over 5 devices.",
    },
    {
      file: "failureshift.json",
      path: ["correctState"],
      id: "failureshift-correct",
      group: "Failure behaviour",
      measure: "Drills that end in the correct state",
      limits: "157 drills over 11 base cases. A source that could not be reached is never read as a source with nothing in it.",
    },
    {
      file: "discoveryshift.json",
      path: ["full.run1.correct"],
      id: "discoveryshift-full",
      group: "Finding and mapping new sources",
      measure: "New sources mapped, held or declined correctly",
      limits: "100 scored cases from 4 base sources; the interval across base sources is wide. Labels by one builder.",
    },
  ];
  const out: ResultRow[] = [];
  for (const w of wanted) {
    const raw = read(`evals/results/${w.file}`);
    if (!raw) continue;
    try {
      const summaries = (JSON.parse(raw) as { summaries?: Record<string, unknown> }).summaries ?? {};
      // Result files use either a flat dotted key ("heldout.V.exact") or a plain one.
      const v = (summaries[w.path.join(".")] ?? w.path.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], summaries)) as Rate | undefined;
      if (!v || typeof v.k !== "number" || typeof v.n !== "number" || typeof v.rate !== "number") continue;
      out.push({
        id: w.id,
        group: w.group,
        measure: w.measure,
        status: "measured",
        value: v.rate.toFixed(3),
        denominator: `${v.k}/${v.n}`,
        ...(typeof v.wilsonLo === "number" && typeof v.wilsonHi === "number" ? { interval: `Wilson ${v.wilsonLo.toFixed(3)} to ${v.wilsonHi.toFixed(3)}` } : {}),
        limits: w.limits,
        source: `evals/results/${w.file}`,
      });
    } catch {
      // An unreadable file yields no rows.
    }
  }
  return out;
}

const PLANNED: [string, string][] = [
  ["Critical mismatches found, against the strongest baseline", "Recall on claims with a known mismatch, on a set larger than the 26 constructed claims."],
  ["Correct answers of Supported on real vendor claims", "So that refusing everything cannot look good. The constructed positive controls are in the rows above."],
  ["Agreement of an independent clinician with the builder's keys", "No clinician has read any key."],
  ["Reviewer study: time and correctness with and without the tool", "Needs independent reviewers, which have not been found."],
];

export function buildResults(): { generatedAt: string; note: string; rows: ResultRow[] } {
  const measured = [...evalRows(), ...identityRows(), ...scoutRows(), ...extractionRows(), ...gate0Rows()];
  const planned: ResultRow[] = PLANNED.map(([measure, limits], i) => ({
    id: `planned-${i + 1}`,
    group: "Planned, not yet measured",
    measure,
    status: "to_be_measured",
    limits,
  }));
  return {
    generatedAt: new Date().toISOString(),
    note: "Each figure below is read from a result file in the repository when the app is built. Nothing on this page is typed in.",
    rows: [...measured, ...planned],
  };
}
