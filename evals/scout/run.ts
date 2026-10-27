/**
 * Runs the Sakaime Scout corpus through the stricter grader and writes tests/engines/scout/RESULTS.md.
 *
 *   npx tsx evals/scout/run.ts [--stock <abs path to the stock runner index.ts>] [--out <path>]
 *
 * Every number in the file is produced by this script from the corpus and the code as they are. Nothing is
 * edited by hand afterwards.
 */
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Scout, SAKAIME_REGISTRY_PATH } from "../../src/engines/scout/scout.ts";
import { IntentRegistry } from "../../src/engines/scout/registry.ts";
import { runMA4, type AttackCase } from "../../src/engines/scout/ablation.ts";
import { fmt, pct, wilson, type Rate } from "../../src/engines/scout/stats.ts";
import { loadCorpus, type CorpusRow } from "./corpus.ts";
import { baselines, execute, gates, grade, type Report } from "./grader.ts";

const root = resolve(import.meta.dirname, "..", "..");
const arg = (n: string, d?: string): string | undefined => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : d;
};

const registry = IntentRegistry.load(SAKAIME_REGISTRY_PATH);
const capsOf = (id: string): readonly string[] => registry.get(id)?.capabilities ?? [];
const riskOf = (id: string): "low" | "medium" | "high" | undefined => registry.get(id)?.riskClass;

function table(head: string[], rows: string[][]): string {
  return [`| ${head.join(" | ")} |`, `|${head.map(() => "---").join("|")}|`, ...rows.map((r) => `| ${r.join(" | ")} |`)].join("\n");
}
const r1 = (x: Rate): string => (x.n === 0 ? "n/a" : `${pct(x.p)} (${x.k}/${x.n}; CI ${pct(x.lo)} to ${pct(x.hi)})`);

function section(title: string, rep: Report): string {
  const g = gates(rep);
  const lines: string[] = [];
  lines.push(`### ${title}`, "", `${rep.rows} prompts, ${rep.errors} errors, ${rep.skipped} skipped.`, "");
  lines.push(table(["Gate", "Threshold", "Result [95% interval]", "Verdict"], g.map((x) => [x.name, x.threshold, x.value, x.pass ? "met" : "NOT MET"])), "");
  lines.push(
    table(
      ["Metric", "Result"],
      [
        ["Decision (proceed, clarify, block, quarantine)", r1(rep.decision)],
        ["Intent top-1", r1(rep.intentTop1)],
        ["Intent top-3", r1(rep.intentTop3)],
        ["Multi-intent exact set", `${r1(rep.multiIntent)}; micro F1 ${rep.multiIntentF1.toFixed(3)}`],
        ["Clarification precision", r1(rep.clarification.precision)],
        ["Clarification recall", r1(rep.clarification.recall)],
        ["Clarification kind correct", r1(rep.clarification.kind)],
        ["Clarification rate (share of all prompts)", r1(rep.clarification.rate)],
        ["Risk level exact", r1(rep.risk)],
        ["Tool plan exact", r1(rep.toolPlan)],
        ["Refusing layer correct", r1(rep.refusedBy)],
        ["Redaction present when expected", r1(rep.redaction)],
        ["Data class correct", r1(rep.dataClass)],
        ["Injection recall", r1(rep.injection.recall)],
        ["Injection precision", r1(rep.injection.precision)],
        ["Injection false-positive rate", r1(rep.injection.falsePositiveRate)],
        ["Look-alike requests refused", r1(rep.lookalike.falseBlock)],
        ["Hard look-alikes refused", r1(rep.lookalike.hardFalseBlock)],
        ["certify_safe: blocked", r1(rep.certify.strictBlock)],
        ["certify_safe: blocked or clarified", r1(rep.certify.blockOrClarify)],
        ["Latency p50 / p95 / max (ms)", `${rep.latency.p50.toFixed(2)} / ${rep.latency.p95.toFixed(2)} / ${rep.latency.max.toFixed(2)}; under 16 ms: ${r1(rep.latency.under16ms)}`],
      ],
    ),
    "",
  );
  const srcRows = Object.entries(rep.injection.bySource).map(([k, v]) => [`source: ${k}`, r1(v)]);
  const goalRows = Object.entries(rep.injection.byGoal).map(([k, v]) => [`goal: ${k}`, r1(v)]);
  if (srcRows.length) lines.push("Injection recall by where the text came from and what it tried:", "", table(["Slice", "Recall"], [...srcRows, ...goalRows]), "");
  return lines.join("\n");
}

async function external(path: string): Promise<string> {
  if (!existsSync(path)) return "NOT RUN: the file data/scout-corpus/external/deepset-prompt-injections-test.json is not present.";
  const rows = JSON.parse(readFileSync(path, "utf8")) as { id: string; text: string; label: number }[];
  const scout = new Scout({ intentRegistry: SAKAIME_REGISTRY_PATH, policyPack: ["default", "adversarial-tight"] });
  const german = (t: string): boolean => /[äöüß]|\b(und|der|die|das|ich|nicht|Sie|ist|wie|zu)\b/.test(t);
  const acc: Record<"all" | "en" | "de", { tp: number; fn: number; fp: number; tn: number }> = {
    all: { tp: 0, fn: 0, fp: 0, tn: 0 },
    en: { tp: 0, fn: 0, fp: 0, tn: 0 },
    de: { tp: 0, fn: 0, fp: 0, tn: 0 },
  };
  for (const [i, r] of rows.entries()) {
    const d = await scout.decide({ prompt: r.text, user: { id: `ext-${i}`, role: "reviewer" }, surface: "chat" });
    const hit = d.risk.flags.some((f) => f.layer === "injection" && f.verdict === "block");
    for (const k of ["all", german(r.text) ? "de" : "en"] as const) {
      const a = acc[k];
      if (r.label === 1) hit ? a.tp++ : a.fn++;
      else hit ? a.fp++ : a.tn++;
    }
  }
  const line = (name: string, a: { tp: number; fn: number; fp: number; tn: number }): string[] => [name, r1(wilson(a.tp, a.tp + a.fn)), r1(wilson(a.fp, a.fp + a.tn))];
  return table(["Subset", "Recall on label 1 (injection)", "False-block rate on label 0 (benign)"], [line("all 116", acc.all), line("English", acc.en), line("German", acc.de)]);
}

function stock(runner: string | undefined): string {
  if (!runner || !existsSync(runner)) return "NOT RUN in this report: no stock runner path was given (--stock).";
  const cwd = resolve(runner, "..", "..");
  const res = spawnSync(process.execPath, [resolve(root, "node_modules/tsx/dist/cli.mjs"), runner, "all"], { cwd, env: { ...process.env, SCOUT_IMPL: resolve(root, "src/engines/scout/index.ts") }, encoding: "utf8", timeout: 180_000 });
  const out = `${res.stdout}\n${res.stderr}`;
  const skipped = (out.match(/^Skipped /gm) ?? []).length;
  const metrics = [...out.matchAll(/│\s*(intent_top1|intent_top3_recall|injection_precision|injection_recall|tool_precision|clarification_rate|override_frequency)\s*│\s*([0-9.]+)\s*│/g)].map((m) => [m[1] as string, m[2] as string]);
  const loaded = out.match(/Loaded (\d+) examples/)?.[1];
  return [`Exit code ${res.status}; ${loaded ?? "?"} examples loaded; skipped prompts: ${skipped}.`, "", table(["Stock metric", "Value"], metrics)].join("\n");
}

async function main(): Promise<void> {
  const corpusDir = resolve(root, "data/scout-corpus");
  const rows = loadCorpus(corpusDir);
  const hash = (f: string): string => createHash("sha256").update(readFileSync(resolve(corpusDir, f))).digest("hex").slice(0, 16);

  const scout = new Scout({ intentRegistry: SAKAIME_REGISTRY_PATH, policyPack: ["default", "adversarial-tight"] });
  const outcomes = await execute(scout, rows);
  const by = (pred: (r: CorpusRow) => boolean): Report => grade(outcomes.filter((o) => pred(o.row)), capsOf, riskOf);
  const all = by(() => true);
  const dev = by((r) => r.split === "dev");
  const held = by((r) => r.split === "heldout");
  const h3 = by((r) => r.id.startsWith("h3-"));

  // composition
  const count = (f: (r: CorpusRow) => boolean): number => rows.filter(f).length;
  const comp = table(
    ["Slice", "Prompts"],
    [
      ["Total", String(rows.length)],
      ["dev / heldout", `${count((r) => r.split === "dev")} / ${count((r) => r.split === "heldout")}`],
      ["Injections (expected.injection = true)", String(count((r) => r.expected.injection === true))],
      ["  typed by a user / lifted from a document", `${count((r) => r.expected.injection === true && r.attack?.source === "user")} / ${count((r) => r.expected.injection === true && r.attack?.source === "document")}`],
      ["Look-alike requests that must not be refused", String(count((r) => r.lookalike === true))],
      ["  on a document surface", String(count((r) => r.lookalike === true && r.surface === "document"))],
      ["certify_safe requests", String(count((r) => r.expected.intent === "certify_safe"))],
      ["Other guarded requests (procurement, vendor contact, exfiltration)", String(count((r) => ["approve_procurement", "contact_vendor", "exfiltrate"].includes(r.expected.intent ?? "")))],
      ["Multi-intent", String(count((r) => r.expected.intents !== undefined))],
      ["Expected to clarify", String(count((r) => r.expected.decision === "clarify"))],
      ["Policy, PII and URL checks", String(count((r) => r.file === "policy-and-pii.jsonl"))],
      ["Verbatim copies of a registry example", String(rows.filter((r) => registry.intents.some((i) => i.examples.includes(r.prompt))).length)],
    ],
  );

  const baseTable = table(
    ["Baseline", "Decisions correct", "Injection recall", "Look-alikes refused", "certify_safe blocked", "Balanced (recall + 1 - false-block) / 2"],
    baselines(rows.filter((r) => r.split === "dev" || r.split === "heldout")).map((b) => [b.name, pct(b.decisionsCorrect.p), pct(b.injectionRecall.p), pct(b.lookalikeFalseBlock.p), pct(b.certifyBlock.p), b.balanced.toFixed(3)]),
  );
  const realBalanced = (all.injection.recall.p + (1 - all.lookalike.falseBlock.p)) / 2;

  const attackCases: AttackCase[] = rows
    .filter((r) => r.expected.injection === true && r.attack)
    .map((r) => ({ id: r.id, prompt: r.prompt, surface: r.surface, role: r.user?.role, cases: r.user?.cases, context: r.context, goal: (r.attack as NonNullable<CorpusRow["attack"]>).goal, source: (r.attack as NonNullable<CorpusRow["attack"]>).source }));
  const ma4 = await runMA4(attackCases, { registry: SAKAIME_REGISTRY_PATH, certifyPrompts: rows.filter((r) => r.expected.intent === "certify_safe").map((r) => r.prompt) });
  const ma4Table = table(
    ["Arm", "Attacks that got through", "User-typed", "From documents", "certify_safe requests accepted"],
    ma4.arms.map((a, i) => [a.arm, r1(a.attacks), r1(a.bySource.user ?? wilson(0, 0)), r1(a.bySource.document ?? wilson(0, 0)), r1((ma4.certify[i] as { accepted: Rate }).accepted)]),
  );

  const stockOut = stock(arg("stock"));
  const ext = await external(resolve(corpusDir, "external/deepset-prompt-injections-test.json"));

  const failures = [...all.failures];
  const md: string[] = [];
  md.push("# Scout Intent results", "");
  md.push(`Generated by \`evals/scout/run.ts\` on ${new Date().toISOString()}. Registry: \`src/engines/scout/registry/sakaime.intents.json\` (${registry.intents.length} intents, version ${registry.version}). Policy packs: default + adversarial-tight. Corpus files and the first 16 hex characters of their SHA-256:`, "");
  md.push(["heldout.jsonl", "heldout2.jsonl", "heldout3.jsonl", "intents.jsonl", "guarded-and-clarify.jsonl", "injections.jsonl", "lookalikes.jsonl", "policy-and-pii.jsonl"].map((f) => `- \`${f}\` ${hash(f)}`).join("\n"), "");
  md.push("## What was measured, and what it does not show", "");
  md.push(
    [
      "- The corpus was written by the same people who wrote the guard. The dev split was used to tune rules and triggers. Three held-out files were written in different wording and kept out of tuning until their first run; see the table of runs. They are still written by the same authors as the guard, and are small.",
      "- Intervals are 95% Wilson intervals. With corpora of this size they are wide: a gate marked met on the point estimate can have a lower bound well under its threshold.",
      "- A refusal is judged by the decision, not by the quality of its explanation. Latency is measured on the machine that ran this file.",
      "- The scorer's `semantic` term is a TF-IDF cosine over example words, not an embedding model. Paraphrases that share no vocabulary with the registry are the expected failure, and are what the held-out intent rows test.",
    ].join("\n"),
    "",
  );
  md.push("## Corpus", "", comp, "");
  const prog = resolve(root, "tests/engines/scout/progression.json");
  if (existsSync(prog)) {
    const p = JSON.parse(readFileSync(prog, "utf8")) as Record<string, Record<string, string | number>>;
    md.push(
      "## Held-out runs in order, as they happened",
      "",
      "Each held-out file was run before any rule was changed to fit it. After a file's first run its failure classes were read and fixed, so it stopped being out-of-sample; the next file was written blind. The last row is the figure to quote for the rules alone.",
      "",
      table(["Run", "Prompts", "Injection recall", "certify_safe blocked", "Decisions correct", "Look-alikes refused"], Object.entries(p).map(([k, v]) => [k, String(v.rows), String(v["injection recall"]), String(v["certify_safe blocked"]), String(v.decision), String(v["look-alikes refused"])])),
      "",
    );
  }
  const cls = resolve(root, "tests/engines/scout/results/classifier-live.json");
  if (existsSync(cls)) {
    const c = JSON.parse(readFileSync(cls, "utf8")) as {
      generatedAt: string; model: string; rows: number; classifierCalls: number; classifierUsedOnRows: number; classifierStatus: Record<string, number>; decisionsChanged: number; wallSeconds: number;
      slices: { name: string; rulesOnly: Report; withClassifier: Report }[];
      external?: { rows?: number; rules?: { tp: number; fn: number; fp: number; tn: number }; withClassifier?: { tp: number; fn: number; fp: number; tn: number } };
    };
    const f = (r: Rate): string => `${r.k}/${r.n}`;
    md.push(
      "## Optional classifier (live, tightens only)",
      "",
      `Model ${c.model}, run ${c.generatedAt}. ${c.classifierCalls} calls on ${c.classifierUsedOnRows} of ${c.rows} prompts (it is asked only about requests the rules did not understand well and about document text shaped like an order); statuses ${JSON.stringify(c.classifierStatus)}; ${c.decisionsChanged} decisions changed; ${c.wallSeconds} s. The held-out 3 file was written before the classifier question about certification existed in its present form, so the certify column there is not blind.`,
      "",
      table(
        ["Slice", "Injection recall (rules / + classifier)", "Look-alikes refused", "certify_safe blocked", "Decisions correct"],
        c.slices.map((s) => [s.name, `${f(s.rulesOnly.injection.recall)} / ${f(s.withClassifier.injection.recall)}`, `${f(s.rulesOnly.lookalike.falseBlock)} / ${f(s.withClassifier.lookalike.falseBlock)}`, `${f(s.rulesOnly.certify.strictBlock)} / ${f(s.withClassifier.certify.strictBlock)}`, `${f(s.rulesOnly.decision)} / ${f(s.withClassifier.decision)}`]),
      ),
      "",
    );
    const ex = c.external;
    if (ex?.rules && ex.withClassifier) {
      const row = (name: string, t: { tp: number; fn: number; fp: number; tn: number }): string[] => [name, r1(wilson(t.tp, t.tp + t.fn)), r1(wilson(t.fp, t.fp + t.tn))];
      md.push("On the external deepset set (generic injections, never used for tuning), same model:", "", table(["Arm", "Recall on label 1", "False-block rate on label 0"], [row("rules only", ex.rules), row("rules + classifier", ex.withClassifier)]), "");
    }
  }
  md.push("## Held-out 3 only: blind for the rules (read this first)", "", section("Held-out 3", h3));
  md.push("## All held-out files, current state", "", "heldout and heldout2 were read and fixed after their first run, so they now measure what was fixed, not what generalises.", "", section("Held-out (3 files)", held));
  md.push("## Dev split (rules were tuned on this)", "", section("Dev", dev));
  md.push("## All prompts", "", section("All", all));
  md.push("## A guard that does nothing sensible, on the same prompts", "", baseTable, "", `The Scout result on the same metrics: injection recall ${pct(all.injection.recall.p)}, look-alikes refused ${pct(all.lookalike.falseBlock.p)}, balanced ${realBalanced.toFixed(3)}. A block-everything guard scores recall 100% and balanced 0.500; a block-nothing guard scores 0.500 too. The false-block rate is what separates them from a real guard.`, "");
  md.push("## MA-4: attacks that get through, with and without the guard", "", ma4Table, "", "No-guard lets everything through by construction; it is the reference point. The keyword filter is a blocklist of a few well-known phrases. The step from no-injection-layer to full is what the injection layer adds on top of the rest of the guard (policy, PII, rate and the guarded intents).", "");
  md.push("## External check: deepset/prompt-injections (test split, Apache-2.0)", "", ext, "", "This set is generic (it is not about medical-AI evidence), partly German, and its labels count some role-play prompts as injections that Sakaime deliberately lets through. It is an independent sanity check on generic recall and false blocks, not a measure of Sakaime's use.", "");
  md.push("## Stock sponsor harness (unmodified runner, Sakaime-independent registry)", "", stockOut, "", "The stock corpus has 32 examples, many of them verbatim registry examples, and its scoring has the weaknesses listed in `evals/scout/grader.ts`. A perfect score there is not evidence of quality.", "");
  md.push("## Every prompt that failed a check", "");
  if (failures.length === 0) md.push("None.");
  else md.push(table(["Id", "Prompt", "Failed", "Expected", "Got"], failures.map((f) => [f.id, f.prompt.replace(/\s+/g, " ").replace(/\|/g, "/").slice(0, 90), f.failed.join("; ").replace(/\|/g, "/"), f.expected, f.actual.replace(/\|/g, "/").slice(0, 120)])));
  md.push("");
  if (all.invariants.detail.length) md.push("## Invariant violations", "", all.invariants.detail.map((d) => `- ${d}`).join("\n"), "");

  const outPath = resolve(root, arg("out", "tests/engines/scout/RESULTS.md") as string);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${md.join("\n")}\n`);
  writeFileSync(outPath.replace(/\.md$/, ".json"), `${JSON.stringify({ all, dev, heldout: held, ma4: { cases: ma4.cases, arms: ma4.arms.map((a) => ({ arm: a.arm, attacks: a.attacks })) } }, null, 2)}\n`);
  console.log(`wrote ${outPath}`);
  for (const [n, rep] of [["heldout 3 (blind)", h3], ["heldout (3 files)", held], ["dev", dev], ["all", all]] as const) {
    console.log(`\n${n}: ${rep.rows} prompts`);
    for (const g of gates(rep)) console.log(`  ${g.pass ? "met    " : "NOT MET"} ${g.name}: ${g.value} (needs ${g.threshold})`);
  }
  console.log(`\nfailed rows: ${failures.length}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void fmt;
