/**
 * Live measurement of the optional classifier: the same held-out and dev prompts through Scout with the rules
 * alone and with a Nemotron classifier that can only tighten. Reads NVIDIA_API_KEY from .env (never printed).
 * Writes tests/engines/scout/results/classifier-live.json; evals/scout/run.ts folds it into RESULTS.md.
 *
 *   npx tsx evals/scout/classifier-live.ts [--model nvidia/nemotron-3.5-lightning-30b-a3b]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { HarnessChatPort } from "../../src/engines/markovian/ablation/harnessPort.ts";
import { PortError, type ModelPort, type ModelRequest, type ModelResponse } from "../../src/ports/index.ts";
import { IntentRegistry } from "../../src/engines/scout/registry.ts";
import { SAKAIME_REGISTRY_PATH, Scout } from "../../src/engines/scout/scout.ts";
import { loadCorpus, type CorpusRow } from "./corpus.ts";
import { execute, grade, type Outcome } from "./grader.ts";

const root = resolve(import.meta.dirname, "..", "..");
const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 && process.argv[i + 1] ? (process.argv[i + 1] as string) : d;
};

function readEnv(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m?.[1] && m[2] !== undefined) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function main(): Promise<void> {
  const env = { ...process.env, ...readEnv(resolve(root, ".env")) } as Record<string, string | undefined>;
  if (!env.NVIDIA_API_KEY || env.NVIDIA_API_KEY.length < 8) {
    console.log("classifier live run: NOT RUN (no NVIDIA_API_KEY)");
    process.exit(3);
  }
  const model = arg("model", "nvidia/nemotron-3.5-lightning-30b-a3b");
  const port = new HarnessChatPort({ apiKey: env.NVIDIA_API_KEY, baseUrl: env.NVIDIA_BASE_URL || "https://integrate.api.nvidia.com/v1", model, minGapMs: 1500, timeoutMs: 60_000 });
  // The hosted API answers a fast run with HTTP 429. The product client backs off; this harness client does not, so retry here.
  const retrying: ModelPort = {
    async complete(r: ModelRequest): Promise<ModelResponse> {
      for (let attempt = 1; ; attempt++) {
        try {
          return await port.complete(r);
        } catch (err) {
          if (!(err instanceof PortError) || err.failure !== "UNAVAILABLE" || attempt >= 5) throw err;
          await new Promise((res) => setTimeout(res, 2500 * attempt));
        }
      }
    },
  };
  const reg = IntentRegistry.load(SAKAIME_REGISTRY_PATH);
  const caps = (i: string): readonly string[] => reg.get(i)?.capabilities ?? [];
  const risk = (i: string): "low" | "medium" | "high" | undefined => reg.get(i)?.riskClass;
  const all = loadCorpus(resolve(root, "data/scout-corpus"));
  // Everything the classifier could change: the held-out files, plus the dev attacks and look-alikes (its false blocks).
  const rows: CorpusRow[] = all.filter((r) => r.split === "heldout" || r.expected.injection === true || r.lookalike === true || r.expected.intent === "certify_safe");

  const rulesOnly = new Scout({ intentRegistry: SAKAIME_REGISTRY_PATH, policyPack: ["default", "adversarial-tight"] });
  const withModel = new Scout({ intentRegistry: SAKAIME_REGISTRY_PATH, policyPack: ["default", "adversarial-tight"], classifier: retrying });
  const base = await execute(rulesOnly, rows);
  console.log(`rules only: ${rows.length} prompts`);
  const t0 = Date.now();
  const tight: Outcome[] = [];
  for (const [i, row] of rows.entries()) {
    tight.push((await execute(withModel, [row]))[0] as Outcome);
    if ((i + 1) % 25 === 0) console.log(`  classifier arm ${i + 1}/${rows.length}`);
  }
  const used = tight.filter((o) => (o.decision?.classifier ?? "not-used") !== "not-used");
  const flips = tight.filter((o, i) => o.decision && base[i]?.decision && o.decision.decision !== base[i]?.decision?.decision);
  const slice = (name: string, pred: (r: CorpusRow) => boolean): unknown => ({
    name,
    rulesOnly: grade(base.filter((o) => pred(o.row)), caps, risk),
    withClassifier: grade(tight.filter((o) => pred(o.row)), caps, risk),
  });
  const out = {
    generatedAt: new Date().toISOString(),
    model,
    rows: rows.length,
    classifierCalls: port.requests.length,
    classifierUsedOnRows: used.length,
    classifierStatus: Object.fromEntries(["tightened", "no-change", "failed"].map((s) => [s, used.filter((o) => o.decision?.classifier === s).length])),
    decisionsChanged: flips.length,
    changedRows: flips.map((o) => ({ id: o.row.id, from: base.find((b) => b.row.id === o.row.id)?.decision?.decision, to: o.decision?.decision, expected: o.row.expected.decision, lookalike: o.row.lookalike === true })),
    wallSeconds: Math.round((Date.now() - t0) / 1000),
    httpStatuses: port.requests.reduce<Record<string, number>>((m, r) => ({ ...m, [String(r.status)]: (m[String(r.status)] ?? 0) + 1 }), {}),
    slices: [
      slice("held-out (3 files)", (r) => r.split === "heldout"),
      slice("held-out 3 only (rules were frozen before it was written)", (r) => r.id.startsWith("h3-")),
      slice("dev attacks and look-alikes", (r) => r.split === "dev"),
    ],
  };
  // The external set: generic injections the rules were never tuned on.
  const extPath = resolve(root, "data/scout-corpus/external/deepset-prompt-injections-test.json");
  const external: Record<string, unknown> = {};
  if (existsSync(extPath)) {
    const ext = JSON.parse(readFileSync(extPath, "utf8")) as { id: string; text: string; label: number }[];
    const tally = { rules: { tp: 0, fn: 0, fp: 0, tn: 0 }, withClassifier: { tp: 0, fn: 0, fp: 0, tn: 0 } };
    const blocked = (d: Awaited<ReturnType<Scout["decide"]>>): boolean => d.risk.flags.some((f) => f.layer === "injection" && f.verdict === "block");
    for (const [i, r] of ext.entries()) {
      const input = { prompt: r.text, user: { id: `ext-${i}`, role: "reviewer" }, surface: "chat" };
      const a = blocked(await rulesOnly.decide(input));
      const b = blocked(await withModel.decide(input));
      for (const [arm, hit] of [["rules", a], ["withClassifier", b]] as const) {
        const t = tally[arm];
        if (r.label === 1) hit ? t.tp++ : t.fn++;
        else hit ? t.fp++ : t.tn++;
      }
      if ((i + 1) % 25 === 0) console.log(`  external ${i + 1}/${ext.length}`);
    }
    Object.assign(external, { rows: ext.length, ...tally });
  }
  Object.assign(out, { external, classifierCalls: port.requests.length, httpStatuses: port.requests.reduce<Record<string, number>>((m, r) => ({ ...m, [String(r.status)]: (m[String(r.status)] ?? 0) + 1 }), {}) });

  const path = resolve(root, "tests/engines/scout/results/classifier-live.json");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out, null, 2)}\n`);
  console.log(`written ${path}`);
  for (const s of out.slices as { name: string; rulesOnly: ReturnType<typeof grade>; withClassifier: ReturnType<typeof grade> }[]) {
    const f = (r: { k: number; n: number }): string => `${r.k}/${r.n}`;
    console.log(`${s.name}: injection recall ${f(s.rulesOnly.injection.recall)} -> ${f(s.withClassifier.injection.recall)}; look-alikes refused ${f(s.rulesOnly.lookalike.falseBlock)} -> ${f(s.withClassifier.lookalike.falseBlock)}; certify blocked ${f(s.rulesOnly.certify.strictBlock)} -> ${f(s.withClassifier.certify.strictBlock)}; decision ${f(s.rulesOnly.decision)} -> ${f(s.withClassifier.decision)}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
