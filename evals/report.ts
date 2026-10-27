/**
 * Builds evals/RESULTS.md from the result files in evals/results. Every number in the tables is a link to the key of the results
 * file it comes from (`results/<file>.json#<key>`); tests/evals/report-links.test.ts checks that each link resolves. Nothing is typed in
 * by hand except the prose around the tables.
 *
 *   npx tsx evals/report.ts
 */
import { join } from "node:path";
import { EVALS, exists, pct, readJson, writeText } from "./lib/core.ts";

type Sum = Record<string, any>;
interface Res {
  meta: Record<string, any>;
  summaries: Sum;
  detail?: Record<string, any>;
  [k: string]: any;
}

const load = (name: string): Res | undefined => (exists(join(EVALS, "results", name)) ? readJson<Res>(join(EVALS, "results", name)) : undefined);
const link = (file: string, key: string, text: string): string => `[${text}](results/${file}#${encodeURI(key)})`;
const f2 = (x: number | null | undefined): string => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(2));

/** "0.31 (8/26)" linked; with the Wilson interval when asked. */
function rate(file: string, key: string, s: Sum | undefined, opts: { ci?: boolean } = {}): string {
  const v = s?.[key];
  if (!v) return "not run";
  const base = v.rate === null || v.rate === undefined ? `n/a (${v.k}/${v.n})` : `${pct(v.rate)} (${v.k}/${v.n})`;
  const extra = opts.ci && v.rate !== null ? `; Wilson ${pct(v.wilsonLo)} to ${pct(v.wilsonHi)}${v.zeroErrorUpper95 !== undefined ? `; zero observed, exact 95% upper bound ${pct(v.zeroErrorUpper95)}` : ""}` : "";
  return link(file, key, base) + (extra ? ` ${extra.replace(/^; /, "")}` : "");
}

const table = (head: string[], rows: string[][]): string => [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");

const lines: string[] = [];
const out = (...s: string[]): void => void lines.push(...s);

interface CaseRow {
  id: string;
  mutation: string;
  expected: string;
  emitted: string | null;
  error: string | null;
  match: boolean;
  contestable: boolean;
  basis: string[];
}

/**
 * Why the full pipeline's findings are open, counted from the compiler's own reason for each open dimension. A reason that matches
 * none of the known wordings is counted as "other", never dropped, so the counts add up to the open dimensions.
 */
function openCauses(vDetails: Record<string, { unknownOrOpen: string[]; dimensions: Record<string, string> }>): string {
  const KNOWN: [string, RegExp, string][] = [
    ["population", /study records do not state a (patient )?population/i, "the study records state no population, so the measured results cannot be tied to the claimed one"],
    ["population", /cannot be placed against|share terms but are not the same phrase/i, "a claimed condition's wording cannot be placed against the evidence's wording"],
    ["population", /No evidence record in use states a patient population/i, "no record in use states a population"],
    ["population", /names no target condition/i, "the evidence names no target condition"],
    ["population", /claim names no conditions|claim states no age range/i, "the claim leaves out a condition or an age range the evidence states"],
    ["setting", /study records do not state a care setting/i, "the study records state no care setting"],
    ["setting", /cannot be placed in the care setting taxonomy/i, "the claimed setting is not in the taxonomy"],
    ["version", /No evidence record in use states a software version/i, "no record in use states a software version"],
  ];
  const counts = new Map<string, Map<string, number>>();
  for (const [key, v] of Object.entries(vDetails)) {
    if (!key.startsWith("V|")) continue;
    for (const open of v.unknownOrOpen) {
      const [dim, rel] = open.split(":") as [string, string];
      const text = v.dimensions[dim] ?? "";
      const known = KNOWN.find(([d, re]) => d === dim && re.test(text));
      const cause = known ? known[2] : rel === "DISJOINT" ? "the claim and the evidence name different values" : rel === "PARTIAL" ? "the claim asks for more than the evidence covers" : "other";
      const byDim = counts.get(dim) ?? new Map<string, number>();
      byDim.set(cause, (byDim.get(cause) ?? 0) + 1);
      counts.set(dim, byDim);
    }
  }
  const parts = [...counts].map(([dim, byCause]) => `${dim} (${[...byCause.values()].reduce((a, b) => a + b, 0)}): ${[...byCause].sort((a, b) => b[1] - a[1]).map(([c, n]) => `${n} x ${c}`).join("; ")}`);
  return parts.length ? `Why the dimensions are open, from the compiler's own reasons: ${parts.join(". ")}.` : "";
}

/** The findings for the lead, each read from the current results; a statement that the results no longer show is not repeated. */
function currentFindings(): string[] {
  const items: string[] = [];
  const rowsOf = (R: Res | undefined, part: string, arm: string): { id: string; emitted: string | null; status: string }[] => (R?.detail?.[part]?.arms as any[] | undefined)?.find((a) => a.id === arm)?.runs?.[0]?.rows ?? [];
  const keyOf = (R: Res | undefined, part: string, id: string): string => (R?.detail?.[part]?.cases as any[] | undefined)?.find((c) => c.id === id)?.expected ?? "?";
  const gotOf = (R: Res | undefined, part: string, arm: string, id: string): string => rowsOf(R, part, arm).find((r) => r.id === id)?.emitted ?? "no verdict";
  const errors = [...rowsOf(BD, "dev", "V"), ...rowsOf(BD, "dev", "V-M1"), ...rowsOf(BH, "heldout", "V")].filter((r) => r.status !== "ok");
  items.push(
    errors.length === 0
      ? `**Exceptions.** No row of the V or V-M1 arm ended in an exception in this run. The earlier CompilerInvariantError on the Gate 0 claim AN-02 (hand-written evidence, a condition that the study item also lists as an exclusion) no longer occurs: V-M1 gives ${gotOf(BD, "dev", "V-M1", "AN-02")} and V gives ${gotOf(BD, "dev", "V", "AN-02")}; the key says ${keyOf(BD, "dev", "AN-02")}.`
      : `**Exceptions.** ${errors.length} row(s) of the V or V-M1 arms ended in an exception: ${errors.map((e) => e.id).join(", ")}. In the harness an exception is a no-verdict answer and counts against the arm.`,
  );
  items.push(
    `**Extraction to compiler hand-off.** Conditions, exclusions and the study setting are now carried (adapter version 2), and the compiler places a condition only by its closed rules. What still keeps V open is listed under "Why V answers INSUFFICIENT_EVIDENCE so often": mainly study records that state no population or setting, and condition wording that the rules cannot place. The curated condition table is small, was written after the first held-out run, and cites only development documents (ERRATA E-005).`,
  );
  items.push(
    `**Staleness and authorization records.** The compiler now ages an authorization record against the hospital's window as well as dated study evidence. The held-out claim HO-CA-04 (a use beginning four years after clearance, window three years) has the key ${keyOf(BH, "heldout", "HO-CA-04")}; V answered ${gotOf(BH, "heldout", "V", "HO-CA-04")}. This is a design inference, recorded as such in the adapter note.`,
  );
  items.push(
    `**Purpose.** An FDA summary that says both detection and triage is read as the broader purpose (detection aid) once the purpose terms are mapped. On HO-CA-03 the key is ${keyOf(BH, "heldout", "HO-CA-03")} and V answered ${gotOf(BH, "heldout", "V", "HO-CA-03")}; on HO-EF-03 the key is ${keyOf(BH, "heldout", "HO-EF-03")} and V answered ${gotOf(BH, "heldout", "V", "HO-EF-03")}. The sentence "not intended to be used as a diagnostic device" is read as a limit on diagnostic use where the extraction layer finds it; ScopeShift (A) shows the cases in which that changes a label the rule table did not expect.`,
  );
  items.push(`**Not re-checked in this run.** The K253801 subgroup figure that was once reported as a second headline (sensitivity 0.806 beside 0.789): \`tests/extraction/RESULTS.md\` records its current state; nothing in these result files shows it.`);
  return items.map((t, i) => `${i + 1}. ${t}`);
}

/** The ScopeShift (A) misses, grouped by mutation with what the compiler said, and the cause where the reason names one. Nothing here is typed in by case. */
function scopeShiftAMisses(R: Res): string[] {
  const rows = (R["rows"] ?? []) as CaseRow[];
  const missed = rows.filter((r) => !r.match);
  const s = R.summaries;
  const falseSupported = s["falseSupported"] as { k: number; n: number };
  const out2: string[] = [];
  if (missed.length === 0) {
    out2.push("Every case matches the rule table.", "");
  } else {
    out2.push(`**${missed.length} of ${rows.length} cases do not match the rule table**, in ${new Set(missed.map((r) => r.mutation)).size} mutation${new Set(missed.map((r) => r.mutation)).size === 1 ? "" : "s"}:`, "");
    const groups = new Map<string, CaseRow[]>();
    for (const r of missed) groups.set(r.mutation, [...(groups.get(r.mutation) ?? []), r]);
    for (const [m, g] of groups) {
      const total = rows.filter((r) => r.mutation === m).length;
      const gotten = new Map<string, number>();
      for (const r of g) gotten.set(`${r.expected} -> ${r.emitted ?? r.error}`, (gotten.get(`${r.expected} -> ${r.emitted ?? r.error}`) ?? 0) + 1);
      out2.push(`- \`${m}\`, ${g.length} of ${total}: ${[...gotten].map(([k, n]) => `${n} x ${k}`).join("; ")}. The compiler's reason for ${g[0]!.id}: ${(g[0]!.basis[0] ?? "(none recorded)").replace(/\s+/g, " ").slice(0, 260)}`);
    }
    out2.push("");
    const limits = missed.filter((r) => r.mutation === "purpose-escalated" && /limits diagnosis|excludes diagnosis|diagnos/i.test(r.basis[0] ?? ""));
    if (limits.length > 0) {
      out2.push(
        `**Cause of the ${limits.length} \`purpose-escalated\` misses.** The authorization text of those devices itself limits diagnostic use. The compiler now reads such a limit: a reservation it will not interpret gives REQUIRES_DOMAIN_REVIEW, an exclusion gives CONTRADICTED_BY_SPECIFIED_EVIDENCE. Escalating the claim to diagnosis is then not a narrower scope. The rule table has no row for an authorization that limits diagnostic use, so this is a disagreement between the table and the implementation, and the table is what is incomplete. It is reported, not scored away.`,
        "",
      );
    }
  }
  out2.push(
    falseSupported.k === 0
      ? `No case whose key withholds support ended as SUPPORTED_FOR_SCOPE or as a narrower scope the key does not allow (0 of ${falseSupported.n}).`
      : `${falseSupported.k} of ${falseSupported.n} cases whose key withholds support ended as a supported label: ${rows.filter((r) => r.match === false && /^SUPPORTED/.test(r.emitted ?? "")).map((r) => r.id).join(", ")}.`,
    "",
    "The suite changed after the first held-out run (ERRATA E-005): positive controls now copy the conditions and exclusions the evidence states, and a world is not built when the authorization names a condition the study record does not state, since no claim can be supported there.",
    "",
  );
  return out2;
}

// ------------------------------------------------------------------------------------------ load

const A = load("scopeshift-a.json");
const BD = load("scopeshift-b-dev.json");
const BH = load("scopeshift-b-held-out.json");
const ID = load("identityshift.json");
const TS = load("timeshift.json");
const FS = load("failureshift.json");
const DS = load("discoveryshift.json");
const AL = load("adapter-log.json");

out(
  "# Evaluation results",
  "",
  `Generated by \`npx tsx evals/report.ts\` from the files in \`evals/results/\`; do not edit by hand. Protocol: \`docs/06-evaluation-protocol.md\`. Every number is a link to the row of a results file it comes from. Re-run everything with \`npx tsx evals/run-all.ts\`.`,
  "",
  "## What these numbers are, and are not",
  "",
  "- **consistency** results compare the implementation with a rule table or a specification the same builders wrote. They show the code does what the table says. They do not show the table is clinically right.",
  "- **builder-labelled** results are scored against labels one builder wrote from the source documents (a second pass is a mechanical oracle written by the same person). No clinician and no independent reviewer has read any key. **No sentence here claims clinical or independent validation.**",
  "- **domain-validity** results would need qualified, blind reviewers. There are none, so this report contains none.",
  "- Demand is not measured here at all. Cost and latency figures are not reported except where stated.",
  "- Every claim in the sets is CONSTRUCTED (written for the test in the style of a vendor claim); none is a statement by a vendor.",
  "- Development and held-out results are never pooled. Cases of one device are correlated: intervals marked *cluster* come from a seeded bootstrap that resamples whole devices, and the effective sample size is the number of devices, not of cases.",
  "",
);

// ------------------------------------------------------------------------------------------ headline

out("## Headline", "");
const hd = BD?.summaries;
const hh = BH?.summaries;
const g0 = hd?.["dev.gate0Rule"];
out(
  "| Question | Answer | Class |",
  "|---|---|---|",
  `| Gate 0: does a rival match Sakaime on 80 percent or more of the 26 claims (docs/08 Gate 0, evals/gate0/PROTOCOL.md)? | ${g0 ? `**Gap ${g0.gap}** on the rule as written. Read the next paragraph before quoting it.` : "not run"} | builder-labelled |`,
  `| ScopeShift (A): does the compiler agree with the rule table on ${A?.summaries.cases.n ?? "?"} controlled counterfactuals over ${A?.summaries.cases.products ?? "?"} real device summaries (${A?.summaries.cases.clusters ?? "?"} families)? | ${A ? rate("scopeshift-a.json", "exactLabel", A.summaries)  : "not run"} exact; the misses are listed with their cause below | consistency |`,
  `| ScopeShift (B), development: Sakaime V exact label, false-supported, false-alarm | ${hd ? `${rate("scopeshift-b-dev.json", "dev.V.exact", hd)}, ${rate("scopeshift-b-dev.json", "dev.V.falseSupported", hd)}, ${rate("scopeshift-b-dev.json", "dev.V.falseAlarm", hd)}` : "not run"} | builder-labelled |`,
  `| ScopeShift (B), held-out (5 devices, sealed): Sakaime V exact label, false-supported, false-alarm | ${hh ? `${rate("scopeshift-b-held-out.json", "heldout.V.exact", hh)}, ${rate("scopeshift-b-held-out.json", "heldout.V.falseSupported", hh)}, ${rate("scopeshift-b-held-out.json", "heldout.V.falseAlarm", hh)}` : "not run"} | builder-labelled |`,
  `| IdentityShift: false merges and precision (leave-one-family-out, 14 families) | ${ID ? `${rate("identityshift.json", "resolver.falseMergeRate", { "resolver.falseMergeRate": ID.summaries.resolver.falseMergeRate })}; precision ${link("identityshift.json", "resolver.precision", `${pct(ID.summaries.resolver.precision.rate)} (${ID.summaries.resolver.precision.k}/${ID.summaries.resolver.precision.n})`)}` : "not run"} | builder-labelled |`,
  `| TimeShift: stale set equals dependent set; no affected finding missed | ${TS ? `${rate("timeshift.json", "staleSetEqualsDependentSet", TS.summaries)}; ${rate("timeshift.json", "noAffectedFindingMissed", TS.summaries)}` : "not run"} | consistency |`,
  `| FailureShift: share of drills ending in the correct state | ${FS ? rate("failureshift.json", "correctState", FS.summaries) : "not run"} | consistency |`,
  "",
);
if (g0) {
  out(
    "**Reading the Gate 0 verdict.** The rule removes the gap if any rival reaches 0.80 exact accuracy with no more false-supported answers than Sakaime (T-A), or gives Sakaime's verdict on 80 percent of the claims with fewer false-supported answers (T-B), or a no-verdict incumbent's output lets a reviewer re-derive 80 percent of the keys. No rival did, so the rule says the gap stands. That is a statement about the rivals, and it is a weak one, because **the Sakaime arm itself does not reach 0.80**: the full pipeline answered INSUFFICIENT_EVIDENCE on " +
      `${g0.sakaimeEmittedLabels?.INSUFFICIENT_EVIDENCE ?? "?"} of ${g0.rivals?.[0]?.claims ?? 26} development claims, which makes no false-supported error and also confirms ${hd["dev.V.correctSupported"]?.k ?? "?"} of the nine positive controls. The causes are listed under "Why V answers INSUFFICIENT_EVIDENCE so often" (section ScopeShift B): wording the compiler will not place, and study records that state no population or setting. On complete, hand-written evidence the compiler reaches ${link("scopeshift-b-dev.json", "dev.V-M1.exact", pct(hd["dev.V-M1.exact"].rate))} exact, which encodes the key's own vocabulary and is not a result. "Stands" is not evidence of quality.`,
    "",
  );
}

// ------------------------------------------------------------------------------------------ contamination log

out(
  "## Contamination and erratum log",
  "",
  "Full text in `evals/ERRATA.md` and `evals/SEALED.md`.",
  "",
  "- **E-001** The Gate 0 answer key was edited after the builder saw a dry run of the compiler (evidence typing split into authorization and study items; the CP-01 acceptable set widened). Git history cannot show the earlier key (one commit holds it). All 26 Gate 0 claims are **development**, never held-out. CP-01 is also scored with its original acceptable set below.",
  "- **E-002** The extraction layer is not blind to the five held-out documents (they are the documents it was repaired on).",
  "- **E-003** The adapter between extraction and compiler was built against the development claims only, frozen, and its hash recorded in every result row.",
  "- **E-004** What the model arms did and did not do: B4 ran once, a stray duplicate process wrote some model replies twice, and the prompts were written once and not tuned.",
  "- **E-005** The adapter changed to version 2 after the first held-out run (study items dated by their summary's decision date; the staleness window applied to authorization records), and the compiler and extraction layers began to read conditions, exclusions and diagnostic-use limits. The held-out numbers in this report are the run made after those changes: a second look at documents the pipeline had been scored on, not a blind result. The conditions table was written after the first run. The ScopeShift (A) positive controls regressed when conditions were read, because they copied only the age; the suite was then changed to copy what the evidence states, which is a change to the construction made after seeing the compiler's answers.",
  "- **E-006** The compiler (1.2.0) bounds a claim by the regulator's decision summary where the authorization is silent, so a registry entry or a paper cannot widen what the regulator's record contained. The rule is applied where the service assembles evidence; the evaluation adapter does not apply it, so the numbers in this report did not move and say nothing about the change. The held-out run is again a second look.",
  `- Held-out key sealed 2026-10-27T08:09:16Z: claims \`a7e06def...\`, key \`fcd1327e...\`. ${BH ? `Every held-out row was scored against key hash \`${String(BH.meta.heldoutKeySha256).slice(0, 12)}\`.` : "The held-out run has not been made."} The seal is a file hash; the commit that timestamps it is the lead's.`,
  AL ? `- Adapter hash \`${String(AL.meta.frozenAdapterHash).slice(0, 12)}\`. Choices compared on the development claims: ${link("adapter-log.json", "frozenAdapterHash", "adapter-log.json")}.` : "",
  "",
);

// ------------------------------------------------------------------------------------------ ScopeShift A

if (A) {
  const s = A.summaries;
  out(
    "## ScopeShift (A): controlled counterfactuals (consistency)",
    "",
    `Construction: for each real FDA summary, the extraction layer reads an authorization item (and a study item); a claim identical to that scope is the positive control; exactly one dimension is then mutated and the expected label follows from the rule table, written before the compiler was called (\`evals/suites/scopeshift-a.ts\`). **${link("scopeshift-a.json", "cases", `${s.cases.n} cases over ${s.cases.products} summaries in ${s.cases.clusters} device families`)}** (mean ${s.cases.meanClusterSize} per family). The target was at least 20 devices; the fixtures hold 12 devices, a later EyeArt clearance and the five held-out summaries, so the target was not reached. **Effective sample size: ${s.cases.clusters} families.** Where "wider" is contestable the expected label is REQUIRES_DOMAIN_REVIEW and the case is scored on abstention.`,
    "",
    table(
      ["Measure", "Result"],
      [
        ["Exact label, all cases", rate("scopeshift-a.json", "exactLabel", s, { ci: true }) + `; cluster ${pct(s.exactLabel.clusterLo)} to ${pct(s.exactLabel.clusterHi)}`],
        ["Exact label, deterministic cases only", rate("scopeshift-a.json", "deterministicExactLabel", s, { ci: true })],
        ["Positive controls: correct SUPPORTED_FOR_SCOPE", rate("scopeshift-a.json", "positiveControlCorrectSupported", s, { ci: true })],
        ["Positive controls: false alarm", rate("scopeshift-a.json", "positiveControlFalseAlarm", s, { ci: true })],
        ["False-supported (cases whose key withholds support)", rate("scopeshift-a.json", "falseSupported", s, { ci: true })],
        ["Contestable cases: abstained (REQUIRES_DOMAIN_REVIEW or INSUFFICIENT)", rate("scopeshift-a.json", "contestableAbstention", s, { ci: true })],
        ["Cases with no verdict", `${s.noVerdict.k}/${s.noVerdict.n}`],
      ],
    ),
    "",
    table(
      ["Mutation", "Matches the rule table", "Misses"],
      Object.entries(s.byMutation).map(([m, v]: [string, any]) => [m, `${v.match}/${v.n}`, v.mismatchIds.length ? v.mismatchIds.slice(0, 2).join("; ") + (v.mismatchIds.length > 2 ? `; and ${v.mismatchIds.length - 2} more` : "") : ""]),
    ),
    "",
    ...scopeShiftAMisses(A),
    `Not applicable and skipped (no threshold case without a confidence interval, no study item): ${s.skipped.length} device-worlds, listed in the file. The identity-ambiguity mutation of the protocol is not a compiler input; it is covered by IdentityShift, and the product-level mutations here (\`product-replaced\`, \`product-brand-only\`) test only that a product the evidence does not name is not supported.`,
    "",
  );
}

// ------------------------------------------------------------------------------------------ ScopeShift B

const ARMS: [string, string, string][] = [
  ["V", "V: Sakaime full pipeline (extraction, identity layer, compiler)", ""],
  ["V-M1", "V-M1: compiler on the Gate 0 hand-written evidence (leaks the key's encoding; not a result)", "dev"],
  ["V-noident", "V without the identity layer (every name-search candidate attached)", ""],
  ["B1", "B1: keyword rules, all records pooled (no model)", ""],
  ["B2", "B2: source by source (no model)", ""],
  ["B3", "B3: one Nemotron call, all records in the prompt", "model"],
  ["B4", "B4: tool-using Nemotron agent, no compiler, no identity layer", "model"],
];

function bTable(R: Res, file: string, prefix: string, partitionLabel: string): void {
  const s = R.summaries;
  const rows: string[][] = [];
  for (const [id, label, only] of ARMS) {
    if (only === "dev" && prefix !== "dev") continue;
    const model = only === "model";
    const key = (m: string) => (model ? `${prefix}.${id}.run1.${m}` : `${prefix}.${id}.${m}`);
    if (!s[key("exact")]) continue;
    const cell = (m: string): string => {
      if (!model) return rate(file, key(m), s);
      const mw = s[`${prefix}.${id}.${m}.meanWorst`];
      const v = s[key(m)];
      const per = [1, 2, 3].map((r) => s[`${prefix}.${id}.run${r}.${m}`]).filter(Boolean);
      const first = per[0];
      if (!mw || !first) return "n/a";
      const higher = m === "exact" || m === "correctSupported" || m === "criticalMismatchRecall";
      return `${link(file, `${prefix}.${id}.${m}.meanWorst`, `mean ${pct(mw.mean)}, worst ${pct(mw.worst)}`)} (${per.map((p) => `${p.k}/${p.n}`).join(", ")}${higher ? "" : ""})`;
      void v;
    };
    rows.push([label, cell("exact"), cell("falseSupported"), cell("criticalMismatchRecall"), cell("falseAlarm"), cell("correctSupported")]);
  }
  out(
    `### ${partitionLabel}`,
    "",
    table(["Arm", "Exact label", "False-supported (cases the key withholds)", "Critical-mismatch recall (dimension, both values, valid anchor)", "False alarm (positive controls)", "Correct SUPPORTED (positive controls)"], rows),
    "",
    `Model arms: B3 ran ${R.meta.modelRuns.B3} times and B4 ${R.meta.modelRuns.B4} time${R.meta.modelRuns.B4 === 1 ? "" : "s"} (mean and worst, per-run counts in brackets). B4 was limited to one run by the API rate limit: the shared free-tier key allowed about two calls a minute on 2026-10-27, and a tool-using run is about five calls a claim. A call that failed or returned no usable verdict counts as wrong and is shown as no verdict in the file.`,
    "",
  );
}

if (BD) {
  out(
    "## ScopeShift (B): authentic claims (builder-labelled)",
    "",
    `Claims are CONSTRUCTED from real FDA summaries, registry records and publications; labels are builder-labelled (single builder, two passes, not independent). Model: \`${BD.meta.model}\` through NVIDIA's API at temperature 0; replies are recorded under \`results/model-runs\` and replayed on re-run. Access differences between arms: B1 to B4 receive the FDA summary plus **every** candidate study or publication that the labelled identity corpus pairs with the device, including records of other products with the same brand (those candidates are the real collisions the identity-corpus builder selected, not the output of a live search, so the share of wrong candidates is higher than a random search would give); V receives the same documents through the identity layer, which keeps only the candidates it links. B3 and B4 go through a harness client without the product's 32 KB prompt rule (the records are public). B5 (Zetaris natural-language-to-SQL) was **not run**: ${BD.summaries.armsNotRun.B5} B0 (manual research) belongs to the reviewer study and was not run. B6: the Constat and HealthIT arms emit no verdict; their scored results are reused from \`evals/gate0\`: a reviewer could re-derive the key from their output for ${link("scopeshift-b-dev.json", "dev.gate0Rule", `${g0?.ceilingConstat?.k ?? "?"} of ${g0?.ceilingConstat?.n ?? "?"} (Constat) and ${g0?.ceilingHealthit?.k ?? "?"} of ${g0?.ceilingHealthit?.n ?? "?"} (HealthIT)`)} development claims. They were not run on the held-out claims.`,
    "",
  );
  bTable(BD, "scopeshift-b-dev.json", "dev", "Development set: the 26 Gate 0 claims, 12 device families (effective sample size 12)");
  const pairs = BD.summaries["dev.pairedWithV"] as any[];
  out(
    "Paired comparison with V on exact-label correctness (exact McNemar, Holm-corrected across the six comparisons; model arms use the majority of three runs; the difference is V minus the arm with a cluster-bootstrap interval over device families):",
    "",
    table(["Arm", "V right and arm wrong / reverse", "p", "p (Holm)", "Difference in accuracy (cluster 95%)"], pairs.map((p) => [p.arm, `${p.b} / ${p.c}`, f2(p.p), f2(p.pHolm), `${f2(p.diff)} (${f2(p.diffLo)} to ${f2(p.diffHi)})`])),
    "",
    `The comparisons are underpowered: 26 claims in 12 families. A p-value above 0.05 here is a tie, not a finding of equivalence.`,
    "",
  );
  if (g0) {
    out(
      "#### Gate 0 same-input rule, arm by arm",
      "",
      table(
        ["Rival", "Run", "Exact accuracy", "False-supported", "Same verdict as Sakaime", "T-A", "T-B"],
        (g0.rivals as any[]).map((r) => [r.arm, String(r.run), f2(r.exactAccuracy), `${r.falseSupported} (Sakaime ${g0.sakaimeFalseSupported})`, `${r.sameVerdictAsSakaime}/${r.claims}`, r.T_A ? "yes" : "no", r.T_B ? "yes" : "no"]),
      ),
      "",
      `Sakaime's own exact accuracy on this set is ${link("scopeshift-b-dev.json", "dev.gate0Rule", pct(g0.sakaimeExact))} with ${g0.sakaimeFalseSupported} false-supported; labels emitted: ${JSON.stringify(g0.sakaimeEmittedLabels)}. Ceiling reading (incumbents): Constat ${pct(g0.ceilingConstat.rate)}, HealthIT ${pct(g0.ceilingHealthit.rate)}. Verdict: **${g0.gap}**. With V-M1 as the Sakaime arm (compiler on hand-written evidence, comparison only): gap ${g0.withM1.gap}; Sakaime exact ${pct(g0.withM1.sakaimeExact)}.`,
      "",
    );
  }
  const cp = (() => {
    const det0 = BD.detail?.dev;
    if (!det0) return "";
    const items: string[] = [];
    for (const a of det0.arms as any[]) {
      a.runs.forEach((run: any, i: number) => {
        const row = run.rows.find((r: any) => r.id === "CP-01");
        if (row) items.push(`${a.id}${a.runs.length > 1 ? ` run ${i + 1}` : ""}: ${row.emitted ?? "no verdict"}`);
      });
    }
    return items.join("; ");
  })();
  out(
    "#### Sensitivity to the post-hoc edit of the key (ERRATA E-001)",
    "",
    `The edit widened the acceptable set of CP-01 to include CONTRADICTED_BY_SPECIFIED_EVIDENCE. Only an arm that answered CONTRADICTED_BY_SPECIFIED_EVIDENCE on CP-01 gains acceptable credit from it; the exact label is unaffected. CP-01 answers: ${cp}. The hand-written evidence items (V-M1 only) were also re-encoded after the dry run; V and every other arm do not use them.`,
    "",
  );
  // where V is held back
  const det = BD.detail?.dev;
  if (det) {
    const tally: Record<string, number> = {};
    for (const [k, v] of Object.entries(det.vDetails as Record<string, any>)) {
      if (!k.startsWith("V|")) continue;
      for (const x of v.unknownOrOpen as string[]) tally[x] = (tally[x] ?? 0) + 1;
    }
    out(
      "#### Why V answers INSUFFICIENT_EVIDENCE so often (development set)",
      "",
      "Dimensions the finding lists as not contained, over the 26 cases (a case can list several): " + Object.entries(tally).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(", ") + ".",
      "",
      `The extraction layer reads age, setting, purpose, version, dates and headline results from an FDA summary, and (adapter version 2, ERRATA E-005) the conditions and exclusions of the indications and a study setting where the summary states one. The compiler places a claimed condition against the evidence's wording only by its closed rules (normal form, a short curated synonym and subtype table, a closed list of narrowing words); a pair it cannot place is not guessed, and for a claim that rests on a study the study record has to state the population and the setting the results were measured in. ${openCauses(det.vDetails)} The compiler refuses with the missing dimension named, which is the cautious direction: V made ${BD.summaries["dev.V.falseSupported"]?.k ?? "?"} false-supported errors on the development set. V confirms ${BD.summaries["dev.V.correctSupported"]?.k ?? "?"} of the ${BD.summaries["dev.V.correctSupported"]?.n ?? "?"} positive controls from extracted evidence. The hand-written evidence (V-M1) shows what the compiler does when the evidence states every dimension in the key's own vocabulary.`,
      "",
    );
  }
}

if (BH) {
  bTable(BH, "scopeshift-b-held-out.json", "heldout", "Held-out set: 20 sealed claims, 5 devices (effective sample size 5; intervals are wide)");
  const pairs = BH.summaries["heldout.pairedWithV"] as any[];
  out(
    "Paired comparison with V on exact-label correctness (same method as above, five clusters):",
    "",
    table(["Arm", "V right and arm wrong / reverse", "p", "p (Holm)", "Difference in accuracy (cluster 95%)"], pairs.map((p) => [p.arm, `${p.b} / ${p.c}`, f2(p.p), f2(p.pHolm), `${f2(p.diff)} (${f2(p.diffLo)} to ${f2(p.diffHi)})`])),
    "",
    (() => {
      const det = BH.detail?.heldout;
      if (!det) return "";
      const ab: Record<string, string> = { SUPPORTED_FOR_SCOPE: "FULL", SUPPORTED_ONLY_FOR_NARROWER_SCOPE: "NARROW", CONTRADICTED_BY_SPECIFIED_EVIDENCE: "CONTRA", INSUFFICIENT_EVIDENCE: "INSUFF", REQUIRES_DOMAIN_REVIEW: "REVIEW" };
      const short = (l: string | null) => (l ? (ab[l] ?? l) : "none");
      const armRows = (id: string): any[][] => (det.arms as any[]).find((a) => a.id === id)?.runs.map((r: any) => r.rows) ?? [];
      const rows = (det.cases as any[]).map((c, i) => {
        const keyTxt = `${short(c.expected)}${c.acceptable.length ? ` (also ${c.acceptable.map(short).join(", ")})` : ""}${c.contestable ? "; contestable" : ""}`;
        const cellFor = (id: string) => armRows(id).map((r) => short(r[i].emitted) + (r[i].falseSupported ? "!" : "")).join(" / ");
        return [c.id, keyTxt, ...["V", "B1", "B3", "B4"].map(cellFor)];
      });
      return [
        "Per claim (labels as emitted; `!` marks a false-supported answer; B3 shows its three runs). FULL = SUPPORTED_FOR_SCOPE, NARROW = SUPPORTED_ONLY_FOR_NARROWER_SCOPE, CONTRA = CONTRADICTED_BY_SPECIFIED_EVIDENCE, INSUFF = INSUFFICIENT_EVIDENCE, REVIEW = REQUIRES_DOMAIN_REVIEW:",
        "",
        table(["Claim", "Key", "V", "B1", "B3", "B4"], rows),
        "",
      ].join("\n");
    })(),
    "The extraction layer is not blind to these five documents (ERRATA E-002). Held-out here means the key was sealed before any system ran, not that the pipeline had never seen the documents.",
    "",
  );
}

// ------------------------------------------------------------------------------------------ ablations

if (BD) {
  const s = BD.summaries;
  out(
    "## Ablations that can be measured",
    "",
    (() => {
      const v = s["dev.V.exact"].rate as number;
      const vfs = s["dev.V.falseSupported"].k as number;
      const bits = ["B3", "B4"].map((id) => {
        const mw = s[`dev.${id}.exact.meanWorst`];
        const fs = [1, 2, 3].map((r) => s[`dev.${id}.run${r}.falseSupported`]).filter(Boolean);
        return mw ? `${id} ${link("scopeshift-b-dev.json", `dev.${id}.exact.meanWorst`, `mean ${pct(mw.mean)} exact (worst ${pct(mw.worst)})`)} with ${fs.map((f: any) => `${f.k}/${f.n}`).join(", ")} false-supported across ${fs.length} run${fs.length === 1 ? "" : "s"}` : "";
      });
      return `- **Compiler off (B3 and B4 against V).** The generic Nemotron arms have no compiler and no identity layer and read the same documents: ${bits.filter(Boolean).join("; ")}; V ${pct(v)} exact with ${vfs} false-supported. ${[("B3"), ("B4")].every((id) => s[`dev.${id}.exact.meanWorst`] && s[`dev.${id}.exact.meanWorst`].mean > v) ? "Both generic arms are more often exactly right than V, and both make false-supported errors that V does not" : "See the table for which arm is more often exactly right"}. V's advantage on this set is that it does not over-claim, not exact-label accuracy; the paired table gives the size of each difference and its uncertainty.`;
    })(),
    `- **Compiler on complete evidence (V-M1 against B3/B4).** ${link("scopeshift-b-dev.json", "dev.V-M1.exact", pct(s["dev.V-M1.exact"].rate))} exact with ${link("scopeshift-b-dev.json", "dev.V-M1.falseSupported", `${s["dev.V-M1.falseSupported"].k}/${s["dev.V-M1.falseSupported"].n}`)} false-supported. The hand-written items encode the key's own vocabulary, so this is an upper bound on what the compiler can do with the key's evidence, not a product result.`,
    `- **Identity layer off (V-noident against V).** Exact label ${link("scopeshift-b-dev.json", "dev.V-noident.exact", pct(s["dev.V-noident.exact"].rate))} against ${link("scopeshift-b-dev.json", "dev.V.exact", pct(s["dev.V.exact"].rate))}${s["dev.V-noident.exact"].k === s["dev.V.exact"].k ? ": the same number of exact labels" : ": the number of exact labels differs"}. The identity layer's own effect is measured in IdentityShift (false merges ${ID ? link("identityshift.json", "resolver.falseMergeRate", `${ID.summaries.resolver.falseMergeRate.k}/${ID.summaries.resolver.falseMergeRate.n}`) : "n/a"} against the fuzzy-name baseline's ${ID ? link("identityshift.json", "fuzzyNameBaseline.falseMergeRate", `${ID.summaries.fuzzyNameBaseline.falseMergeRate.k}/${ID.summaries.fuzzyNameBaseline.falseMergeRate.n}`) : "n/a"}). Critical-mismatch recall differs: V ${link("scopeshift-b-dev.json", "dev.V.criticalMismatchRecall", rate("scopeshift-b-dev.json", "dev.V.criticalMismatchRecall", s).replace(/\[|\]\(.*?\)/g, "").slice(0, 20))} against V-noident ${rate("scopeshift-b-dev.json", "dev.V-noident.criticalMismatchRecall", s)}.`,
    (() => {
      const ret = (BD.detail?.dev?.retrieval ?? []) as { product: string; candidates: { verdict: string; builderTruth?: string }[] }[];
      const cands = ret.flatMap((r) => r.candidates);
      if (cands.length === 0) return "";
      const non = cands.filter((c) => c.builderTruth === "NON_MATCH");
      const match = cands.filter((c) => c.builderTruth === "MATCH");
      const amb = cands.filter((c) => c.builderTruth === "AMBIGUOUS");
      const link = (xs: typeof cands) => xs.filter((c) => c.verdict === "LINK").length;
      return `- **What the identity layer changes before the compiler is reached.** The labelled corpus pairs the development devices with ${cands.length} candidate studies and publications (${match.length} the builder labelled true links, ${non.length} non-matches such as another module of the same brand, ${amb.length} ambiguous). With the layer off all ${cands.length} are attached to the product. With it on, ${link(non)} of the ${non.length} non-matches and ${link(amb)} of the ${amb.length} ambiguous records reach the compiler, and ${link(match)} of the ${match.length} true links do (of the rest, ${match.filter((c) => c.verdict === "ABSTAIN").length} were left AMBIGUOUS, which shows them to the reviewer, and ${match.filter((c) => c.verdict === "SILENT" || c.verdict === "NO").length} were not proposed or were refused). Candidate verdicts are in the \`retrieval\` section of the file; builder labels are used here only to score them.`;
    })(),
    (() => {
      if (!hh) return "";
      const fsV = hh["heldout.V.falseSupported"];
      const b3 = hh["heldout.B3.exact.meanWorst"];
      const b4 = hh["heldout.B4.exact.meanWorst"];
      const b3f = [1, 2, 3].map((r) => hh[`heldout.B3.run${r}.falseSupported`]).filter(Boolean);
      const b4f = hh["heldout.B4.run1.falseSupported"];
      if (!b3 || !b4 || !fsV) return "";
      return `- **Held-out, compiler off.** V ${rate("scopeshift-b-held-out.json", "heldout.V.exact", hh)} exact with ${rate("scopeshift-b-held-out.json", "heldout.V.falseSupported", hh, { ci: true })} false-supported; B3 ${link("scopeshift-b-held-out.json", "heldout.B3.exact.meanWorst", `mean ${pct(b3.mean)} exact (worst ${pct(b3.worst)})`)} with ${b3f.map((f: any) => `${f.k}/${f.n}`).join(", ")} false-supported across its runs; B4 ${link("scopeshift-b-held-out.json", "heldout.B4.exact.meanWorst", `${pct(b4.mean)} exact`)} with ${b4f.k}/${b4f.n} false-supported (one run). On the version traps the generic arms follow the string: HO-PH-04 (the predicate's version) and HO-SD-02 (the predicate's model number) were answered SUPPORTED_FOR_SCOPE by B3 in every run and by B4. On this set the generic arms are more often exactly right than V and V is the only arm family with no false-supported answer; with 5 devices neither statement has a tight interval.`;
    })(),
    "- Not measured: federation off (Zetaris stopped is a FailureShift drill, not an accuracy ablation), each Meterless engine (their ablations are in `tests/engines/ABLATIONS.md`, `tests/engines/scout/RESULTS.md`, `tests/engines/markovian/MA3-RESULTS.md`), the critic role (built in src/agents/critic.ts; its effect on labels is not ablated, and the traces show no label changed by it), and Nightshift receipts (MA-5).",
    "",
  );
}

// ------------------------------------------------------------------------------------------ identity, time, failure, discovery

if (ID) {
  const s = ID.summaries;
  const row = (name: string, k: string): string[] => [name, rate("identityshift.json", `resolver.${k}`, { [`resolver.${k}`]: s.resolver[k] }), s.resolver[k]?.clusterLo !== undefined ? `${pct(s.resolver[k].clusterLo)} to ${pct(s.resolver[k].clusterHi)}` : ""];
  out(
    "## IdentityShift (builder-labelled)",
    "",
    `The existing leave-one-family-out evaluation of \`src/identity\` on \`data/identity-corpus\`, reproduced without re-tuning (it matches the committed report). ${link("identityshift.json", "cases", `${s.cases.pairs} labelled pairs, ${s.cases.families} device families`)}; **effective sample size ${s.cases.families} families**. One reader labelled the corpus; the study and paper annotations (purpose tags, manufacturer) were supplied by the builder.`,
    "",
    table(["Measure (resolver)", "Pairs as independent", "Families as the unit (cluster 95%)"], [row("Precision", "precision"), row("Recall (CANDIDATE or CONFIRMED)", "recall"), row("Surfaced recall (linked or shown as AMBIGUOUS)", "surfacedRecall"), row("Correct abstention on AMBIGUOUS pairs", "correctAbstention"), row("False-merge rate (NON_MATCH called a link)", "falseMergeRate")]),
    "",
    table(
      ["Fuzzy-name baseline, same pairs", "Result"],
      [["Precision", rate("identityshift.json", "fuzzyNameBaseline.precision", { "fuzzyNameBaseline.precision": s.fuzzyNameBaseline.precision })], ["Recall", rate("identityshift.json", "fuzzyNameBaseline.recall", { "fuzzyNameBaseline.recall": s.fuzzyNameBaseline.recall })], ["False-merge rate", rate("identityshift.json", "fuzzyNameBaseline.falseMergeRate", { "fuzzyNameBaseline.falseMergeRate": s.fuzzyNameBaseline.falseMergeRate })]],
    ),
    "",
    `Paired (exact McNemar, Holm): ${(s.resolverVersusFuzzy as any[]).map((t) => `"${t.name}": resolver only ${t.onlyResolver}, baseline only ${t.onlyBaseline}, p ${t.p.toExponential(1)} (Holm ${t.pHolm.toExponential(1)})`).join("; ")}. Confirmed where the truth is not a match: ${s.resolver.confirmedWhereTruthIsNotMatch}. Recall is the weak number (links the resolver left as AMBIGUOUS or did not propose are listed in \`misses\`); a true link shown as AMBIGUOUS reaches the reviewer. The sweep over all cross-family record pairs is in \`data/identity-corpus/RESULTS.md\`.`,
    "",
  );
}

if (TS) {
  const s = TS.summaries;
  out(
    "## TimeShift (consistency)",
    "",
    `Real World Model and compiler over the authentic scopes of five devices (${link("timeshift.json", "cases", `${s.cases.cases} cases: ${s.cases.changeCases} change events, ${s.cases.controlCases} controls that must change nothing, ${s.cases.notApplicable} not applicable`)}); each case holds ${s.cases.findingsPerCase} findings and changes one device. Change events are constructed: a registry version updated after a finding, a corrected publication, a superseded authorization, a withdrawn record, an unrelated fact, a late older observation. Effective sample size: ${s.cases.devices} devices.`,
    "",
    table(
      ["Check", "Result"],
      [
        ["Back in time: the world as it was before the change, recompiled, reproduces every original finding", rate("timeshift.json", "backInTimeFindingsReproduced", s, { ci: true })],
        ["The engine's stale set equals the dependent set computed independently from the findings' recorded inputs", rate("timeshift.json", "staleSetEqualsDependentSet", s, { ci: true })],
        ["No finding whose output really changed is left unflagged", rate("timeshift.json", "noAffectedFindingMissed", s, { ci: true })],
        ["Findings of the other four devices are left alone", rate("timeshift.json", "findingsOfOtherDevicesLeftAlone", s, { ci: true })],
        ["Controls (unrelated fact, older observation) change nothing", rate("timeshift.json", "controlsChangeNothing", s, { ci: true })],
        ["Recomputing only the stale findings leaves nothing stale and equals a full recompute", rate("timeshift.json", "cleanAfterRecomputingOnlyTheStale", s, { ci: true })],
      ],
    ),
    "",
    `Cost side: ${link("timeshift.json", "overFlagging", `${s.overFlagging.staleFindings} findings were marked stale, ${s.overFlagging.reallyAffected} really changed`)}. The compiler records dependence per evidence item, so a change in one slot marks every finding that read any item of the device; "exact" holds for the dependency the compiler records, not for the narrower dependency a reader would draw. Not measured: wall-clock cost, real registry churn, a snapshot-pair study (Zetaris time travel is tested in infra/zetaris/GATES.md, gate Z-TT).`,
    "",
  );
}

if (FS) {
  const s = FS.summaries;
  out(
    "## FailureShift (consistency)",
    "",
    `Fault injection through the real ports (docs/06 section 7). ${link("failureshift.json", "drills", `${s.drills.n} drills`)}; base cases are the claims a complete evidence set supports (${s.drills.baseCases.join(", ")}), so a source loss has something to change. Expected states: a required source lost gives INSUFFICIENT_EVIDENCE with the reason; a corroborating or optional source lost changes the display only; nothing becomes supported; an outage is not read as empty and an empty answer is not read as an outage.`,
    "",
    table(["Category", "Drills in the correct state"], Object.keys(s.byCategory).map((k) => [k, rate("failureshift.json", `byCategory.${k}`, { [`byCategory.${k}`]: s.byCategory[k] })])),
    "",
    `Overall ${rate("failureshift.json", "correctState", s, { ci: true })}. ${s.failed.length ? `Failed drills: ${s.failed.map((f: any) => f.id).join(", ")}.` : "No drill failed."} Zetaris stopped, run against the real local stack: ${s.zetarisStopped.ran ? `${link("failureshift.json", "zetarisStopped", `the port reported ${s.zetarisStopped.timeline.apiStopped} (with the API up the same port reports ${s.zetarisStopped.timeline.controlApiUp}) after ${s.zetarisStopped.timeline.msToFailure} ms, and the stack answered SELECT 1 again ${s.zetarisStopped.timeline.restoredAfterMs} ms after restart`)}. A refused connection fails at once, which matches infra/zetaris/GATES.md (2 to 7 ms)` : `not run: ${s.zetarisStopped.reason}`}.`,
    "",
    `Scout guard on its own corpus (written by the guard's authors): ${link("failureshift.json", "scoutGuard", `${s.scoutGuard.injections.k} of ${s.scoutGuard.injections.n} injections caught`)}; ${s.scoutGuard.lookalikeFalseBlocks.k} of ${s.scoutGuard.lookalikeFalseBlocks.n} look-alike legitimate requests refused. The held-out slices in \`tests/engines/scout/RESULTS.md\` are lower and are the figures to quote for unseen wording.`,
    "",
    "Not covered: " + (s.notCovered as string[]).join(" "),
    "",
  );
}

if (DS) {
  out("## DiscoveryShift", "", DS.summaries.status === "NOT RUN" ? `Adapter written (\`evals/suites/discoveryshift.ts\`) and run; **NOT RUN**: ${DS.summaries.reason}` : `Read from the runner's results file (\`data/discovery-shift/results.json\`); see ${link("discoveryshift.json", "sourceFile", "discoveryshift.json")}. The cases, sealed expectations and baselines belong to \`src/discovery\` and \`tests/discovery/shift\`.`, "");
  if (DS.summaries.status !== "NOT RUN") {
    const keys = Object.keys(DS.summaries).filter((k) => k.endsWith(".correct"));
    out(table(["Arm / run", "Correct (scored cases, known limits excluded)", "Cluster 95% over base sources"], keys.map((k) => [k.replace(".correct", ""), rate("discoveryshift.json", k, DS.summaries), DS.summaries[k].clusterLo !== undefined ? `${pct(DS.summaries[k].clusterLo)} to ${pct(DS.summaries[k].clusterHi)}` : ""])), "");
  }
}

// ------------------------------------------------------------------------------------------ defects and not run

out(
  "## Defects and findings for the lead",
  "",
  ...currentFindings(),
  "",
  "## What was not run",
  "",
  "- B5 (Zetaris natural-language-to-SQL): BLOCKED, infra/zetaris/GATES.md gate Z-NL.",
  "- B0 and the reviewer study (T8), domain-validity labelling: no reviewers.",
  "- Constat and HealthIT on the held-out claims; Innolitics, ACR AI Central and others (no legitimate access established).",
  "- A blind model-assisted second annotator for the held-out key.",
  "- Nemotron Ultra and the Nightshift route for the generic arms (Lightning only); more than three runs; any prompt tuning of B3 and B4 (the prompts were written once and hashed).",
  "- The Zetaris engine out-of-memory kill drill, concurrent users, cold starts.",
  "- Cost and latency of the arms (token counts are in the model-run files; no timing was taken).",
  "- The 20-device target for ScopeShift (A) and the 30-case target for ScopeShift (B): the fixtures hold fewer devices; counts and effective sample sizes are stated above.",
  "",
);

writeText(join(EVALS, "RESULTS.md"), lines.filter((l, i) => !(l === "" && lines[i - 1] === "")).join("\n") + "\n");
console.log("wrote evals/RESULTS.md");
