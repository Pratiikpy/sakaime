/**
 * ScopeShift (B): authentic claims (docs/06 section 3). Two partitions, never pooled:
 *
 *   development  the 26 Gate 0 claims (the key was edited after a dry run, ERRATA.md E-001)
 *   held-out     the 20 sealed claims (evals/SEALED.md)
 *
 * Arms (docs/06 section 4): V, V on the Gate 0 hand-written evidence (M1, development only), V without the identity layer,
 * B1, B2, B3, B4, B5 (not run) and B6 (the Constat and HealthIT results scored in evals/gate0).
 *
 *   npx tsx evals/suites/scopeshift-b.ts [--partition dev|held-out|both] [--no-model] [--runs 3] [--concurrency 3]
 */
import { join } from "node:path";
import { exactVector, scoreCase, summarise, type ArmSummary, type CaseScore } from "../lib/grade.ts";
import { loadDevCases, loadHeldoutCases, stripKey } from "../lib/cases.ts";
import { EVALS, hashOfJson, readJson, round, stamp } from "../lib/core.ts";
import { retrieve, type Doc, type Retrieval } from "../lib/documents.ts";
import { ADAPTER, ADAPTER_HASH, V_FULL, runV, toArmOutput, type VConfig, type VRun } from "../lib/pipeline.ts";
import { b1, b2 } from "../lib/baselines.ts";
import { CachedModel, MODEL, PROMPT_HASH, livePort, runB3, runB4 } from "../lib/model-arms.ts";
import { rateRow, writeResult } from "../lib/results.ts";
import type { ArmOutput, EvalCase } from "../lib/types.ts";
import { holm, mcnemarExact, meanAndWorst, pairedDifferenceBootstrap } from "../stats/index.ts";

type Partition = "dev" | "heldout";

interface ArmRun {
  outputs: Map<string, ArmOutput>;
  scores: CaseScore[];
  summary: ArmSummary;
}

interface ArmResult {
  id: string;
  label: string;
  note: string;
  runs: ArmRun[];
}

const args = process.argv.slice(2);
const opt = (name: string, d: string): string => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? (args[i + 1] as string) : d;
};
const PARTITION = opt("partition", "both") as "dev" | "held-out" | "both";
const NO_MODEL = args.includes("--no-model");
const RUNS = Number(opt("runs", "3"));
const B4_RUNS = Number(opt("b4-runs", "1"));
const CONCURRENCY = Number(opt("concurrency", "3"));
const SEED = 20261027;

async function pool<T, R>(items: readonly T[], size: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

function scoreRun(cases: readonly EvalCase[], outputs: Map<string, ArmOutput>): ArmRun {
  const scores = cases.map((c) => scoreCase(c, outputs.get(c.id) ?? { label: null, status: "none", mismatches: [], detail: "arm produced no output" }));
  return { outputs, scores, summary: summarise(scores, SEED) };
}

function majorityVector(order: readonly string[], runs: readonly ArmRun[]): boolean[] {
  const vecs = runs.map((r) => exactVector(order, r.scores));
  return order.map((_, i) => vecs.filter((v) => v[i]).length * 2 > vecs.length);
}

async function main(): Promise<void> {
  const dev = loadDevCases();
  const held = PARTITION === "dev" ? undefined : loadHeldoutCases();
  const partitions: { name: Partition; cases: EvalCase[]; handIds?: Map<string, string[]>; part: "development" | "held-out" }[] = [];
  if (PARTITION !== "held-out") partitions.push({ name: "dev", cases: dev.cases, handIds: dev.handSetIds, part: "development" });
  if (held && PARTITION !== "dev") partitions.push({ name: "heldout", cases: held.cases, part: "held-out" });

  const port = NO_MODEL ? undefined : livePort();
  const b3 = new CachedModel("b3", port, NO_MODEL ? "recorded-only" : "live");
  const b4 = new CachedModel("b4", port, NO_MODEL ? "recorded-only" : "live");
  const summaries: Record<string, unknown> = {};
  const detail: Record<string, unknown> = {};
  const started = stamp("scopeshift-b", SEED);

  for (const p of partitions) {
    const retrievals = new Map<string, Retrieval>();
    for (const c of p.cases) if (!retrievals.has(c.product)) retrievals.set(c.product, await retrieve(c.product, p.part));
    const docsOf = (c: EvalCase): Doc[] => {
      const r = retrievals.get(c.product) as Retrieval;
      return [r.fda, ...r.candidates.map((x) => x.doc)];
    };

    const arms: ArmResult[] = [];
    const vDetails: Record<string, Record<string, unknown>> = {};

    const deterministic = async (id: string, label: string, note: string, f: (c: EvalCase) => Promise<ArmOutput> | ArmOutput): Promise<void> => {
      const outputs = new Map<string, ArmOutput>();
      for (const c of p.cases) outputs.set(c.id, await f(c));
      arms.push({ id, label, note, runs: [scoreRun(p.cases, outputs)] });
    };

    const vArm = (id: string, label: string, note: string, cfg: VConfig): Promise<void> =>
      deterministic(id, label, note, async (c) => {
        const run: VRun = await runV(c, retrievals.get(c.product) as Retrieval, cfg, p.handIds?.get(c.id) ?? []);
        vDetails[`${id}|${c.id}`] = {
          error: run.error ?? null,
          itemsUsed: run.items.length,
          recordsUsed: run.usedRecords,
          recordsExcluded: run.excludedRecords,
          dimensions: run.reasons,
          unknownOrOpen: run.finding?.mismatches.map((m) => `${m.dimension}:${m.relation}`) ?? [],
        };
        return toArmOutput(run);
      });

    await vArm("V", "Sakaime full: extraction, identity layer, compiler", "M2: evidence extracted from the documents, candidates filtered by the identity resolver", V_FULL);
    if (p.name === "dev") await vArm("V-M1", "Sakaime compiler on the Gate 0 hand-written evidence (M1)", "leaks the key's own evidence encoding; never the G2 result", { ...V_FULL, evidence: "hand" });
    await vArm("V-noident", "Sakaime without the identity layer", "every candidate a name search returns is attached to the product", { ...V_FULL, identity: "off" });
    await deterministic("B1", "B1 keyword rules over all records pooled", "no model; pooled text; supports or says insufficient", (c) => b1(c, docsOf(c)));
    await deterministic("B2", "B2 source by source", "no model; one record must satisfy every stated field", (c) => b2(c, docsOf(c)));

    // model arms: RUNS runs each, in a pool
    for (const [id, label, nRuns, fn] of [
      ["B3", "B3 one Nemotron call with all records", RUNS, (c: EvalCase, run: number) => runB3(b3, stripKey(c), docsOf(c), run)],
      ["B4", "B4 tool-using Nemotron agent", B4_RUNS, (c: EvalCase, run: number) => runB4(b4, stripKey(c), docsOf(c), run)],
    ] as const) {
      const tasks = Array.from({ length: nRuns }, (_, r) => r + 1).flatMap((run) => p.cases.map((c) => ({ run, c })));
      const results = await pool(tasks, CONCURRENCY, async (t) => ({ ...t, out: await fn(t.c, t.run) }));
      const runs: ArmRun[] = [];
      for (let r = 1; r <= nRuns; r++) {
        const outputs = new Map(results.filter((x) => x.run === r).map((x) => [x.c.id, x.out] as const));
        runs.push(scoreRun(p.cases, outputs));
      }
      arms.push({ id, label, note: `${MODEL} through the NVIDIA API, temperature 0, ${nRuns} run${nRuns === 1 ? "" : "s"}; replies cached under results/model-runs (recorded when replayed)`, runs });
    }

    // summaries
    const order = p.cases.map((c) => c.id);
    for (const a of arms) {
      a.runs.forEach((run, ri) => {
        const isModel = a.id === "B3" || a.id === "B4";
        const prefix = isModel ? `${p.name}.${a.id}.run${ri + 1}` : `${p.name}.${a.id}`;
        const s = run.summary;
        summaries[`${prefix}.n`] = { cases: s.n, clusters: s.clusters, effective: s.effective };
        for (const [k, v] of Object.entries({ exact: s.exact, acceptable: s.acceptable, exactClear: s.exactClear, exactContestable: s.exactContestable, falseSupported: s.falseSupported, criticalMismatchRecall: s.criticalMismatchRecall, criticalMismatchDimensionRecall: s.criticalMismatchDimensionRecall, falseAlarm: s.falseAlarm, correctSupported: s.correctSupported, correctAbstention: s.correctAbstention })) {
          summaries[`${prefix}.${k}`] = rateRow(v);
        }
        summaries[`${prefix}.noVerdict`] = s.noVerdict;
        summaries[`${prefix}.emittedLabels`] = s.emittedLabels;
      });
      if (a.id === "B3" || a.id === "B4") {
        for (const metric of ["exact", "falseSupported", "falseAlarm", "correctSupported", "criticalMismatchRecall"] as const) {
          const vals = a.runs.map((r) => r.summary[metric].rate).filter(Number.isFinite);
          const higher = metric === "exact" || metric === "correctSupported" || metric === "criticalMismatchRecall";
          summaries[`${p.name}.${a.id}.${metric}.meanWorst`] = meanAndWorst(vals, higher);
        }
      }
    }

    // paired comparisons with V on exact correctness, Holm over the family
    const V = arms.find((a) => a.id === "V") as ArmResult;
    const vVec = exactVector(order, V.runs[0]!.scores);
    const comparisons: { arm: string; b: number; c: number; p: number; pHolm: number; diff: number; diffLo: number; diffHi: number }[] = [];
    for (const a of arms.filter((x) => x.id !== "V")) {
      const vec = a.runs.length > 1 ? majorityVector(order, a.runs) : exactVector(order, a.runs[0]!.scores);
      let onlyV = 0;
      let onlyA = 0;
      order.forEach((_, i) => {
        if (vVec[i] && !vec[i]) onlyV++;
        else if (!vVec[i] && vec[i]) onlyA++;
      });
      const mc = mcnemarExact(onlyV, onlyA);
      const boot = pairedDifferenceBootstrap(order.map((id, i) => ({ cluster: (p.cases.find((c) => c.id === id) as EvalCase).cluster, a: vVec[i] as boolean, b: vec[i] as boolean })), { seed: SEED, resamples: 2000 });
      comparisons.push({ arm: a.id, b: onlyV, c: onlyA, p: mc.p, pHolm: 0, diff: boot.estimate, diffLo: boot.lo, diffHi: boot.hi });
    }
    const adj = holm(comparisons.map((x) => x.p));
    comparisons.forEach((x, i) => (x.pHolm = adj[i] as number));
    summaries[`${p.name}.pairedWithV`] = comparisons.map((x) => ({ ...x, diff: round(x.diff), diffLo: round(x.diffLo), diffHi: round(x.diffHi), note: "exact-label correctness; V minus arm; b = V right and arm wrong, c = the reverse; model arms use the majority of runs" }));

    // per-case rows, for the failure inspection in RESULTS.md
    detail[p.name] = {
      cases: p.cases.map((c) => ({ id: c.id, cluster: c.cluster, product: c.product, kind: c.kind, expected: c.key.expectedLabel, acceptable: c.key.acceptableLabels, contestable: c.key.keyConfidence === "contestable", keyDimensions: c.key.mismatches.map((m) => m.dimension) })),
      arms: arms.map((a) => ({
        id: a.id,
        label: a.label,
        note: a.note,
        runs: a.runs.map((r) => ({
          rows: r.scores.map((s) => ({ id: s.id, emitted: s.emitted, status: s.status, exact: s.exact, acceptable: s.acceptable, falseSupported: s.falseSupported, namedDimensions: (r.outputs.get(s.id)?.mismatches ?? []).map((m) => m.dimension), detail: r.outputs.get(s.id)?.detail ?? null })),
        })),
      })),
      vDetails,
      retrieval: [...retrievals.values()].map((r) => ({ product: r.product, fdaOrigin: r.fda.origin, candidates: r.candidates.map((x) => ({ record: x.recordId, kind: x.kind, verdict: x.verdict, state: x.state, builderTruth: x.truth })) })),
    };

    if (p.name === "dev") {
      // Gate 0 same-input rule (evals/gate0/PROTOCOL.md section 1)
      const scored = readJson<{ summary: { derivableFromArmOutput: { constat: { claims: number; derivable: number }; healthit: { claims: number; derivable: number } } }; rows: unknown[] }>(join(EVALS, "gate0", "arms", "scored.json"));
      const sc = scored.summary.derivableFromArmOutput;
      const ceilingConstat = sc.constat.derivable / sc.constat.claims;
      const ceilingHealthit = sc.healthit.derivable / sc.healthit.claims;
      const gate = (sakArm: ArmResult, name: string) => {
        const sak = sakArm.runs[0]!.scores;
        const fsSak = sak.filter((s) => s.falseSupported).length;
        const rival = (a: ArmResult) =>
          a.runs.map((run, ri) => {
            const acc = run.summary.exact.rate;
            const fs = run.scores.filter((s) => s.falseSupported).length;
            let same = 0;
            for (const s of run.scores) if (s.emitted !== null && s.emitted === sak.find((x) => x.id === s.id)?.emitted) same++;
            const tA = acc >= 0.8 && fs <= fsSak;
            const tB = same / run.scores.length >= 0.8 && fs < fsSak;
            return { arm: a.id, run: ri + 1, exactAccuracy: round(acc), falseSupported: fs, sameVerdictAsSakaime: same, claims: run.scores.length, shareSame: round(same / run.scores.length), T_A: tA, T_B: tB };
          });
        const rows = arms.filter((a) => !a.id.startsWith("V")).flatMap(rival);
        const removed = rows.some((r) => r.T_A || r.T_B) || ceilingConstat >= 0.8 || ceilingHealthit >= 0.8;
        return {
          sakaimeArm: name,
          sakaimeExact: round(sakArm.runs[0]!.summary.exact.rate),
          sakaimeFalseSupported: fsSak,
          sakaimeEmittedLabels: sakArm.runs[0]!.summary.emittedLabels,
          rivals: rows,
          gap: removed ? "REMOVED" : "STANDS",
        };
      };
      const M1 = arms.find((a) => a.id === "V-M1") as ArmResult;
      summaries["dev.gate0Rule"] = {
        ...gate(V, "V (M2: extraction, identity layer, compiler) - the G2 result"),
        ceilingConstat: { k: sc.constat.derivable, n: sc.constat.claims, rate: round(ceilingConstat) },
        ceilingHealthit: { k: sc.healthit.derivable, n: sc.healthit.claims, rate: round(ceilingHealthit) },
        reading:
          "The gap is removed if any rival satisfies T-A (exact accuracy at least 0.80 and no more false-supported than Sakaime), T-B (same verdict as Sakaime on at least 80 percent with fewer false-supported), or a ceiling of at least 80 percent. Any single run of a model arm counts. STANDS means no rival tested here removed it; it is not a statement about quality.",
        withM1: { ...gate(M1, "V-M1 (compiler on hand-written evidence; leaks the key encoding, reported for comparison only)") },
      };
    }
  }

  summaries["armsNotRun"] = {
    B5: "Zetaris natural-language-to-SQL: BLOCKED. No natural-language-to-SQL service exists in the local build (infra/zetaris/GATES.md, gate Z-NL: three ways of finding one are written down there).",
    B0: "Manual source-by-source research is the reviewer study (T8); no reviewers were available.",
    B6: "Constat free MCP and the HealthIT.com ledger emit no verdict and take no claim input. Their scored results on the 26 development claims are reused from evals/gate0/arms/scored.json (derivable from their output: Constat 7 of 26, HealthIT 0 of 26) and are not available for the held-out claims: no lookups were made for the five held-out devices.",
  };
  writeResult(`scopeshift-b${PARTITION === "both" ? "" : "-" + PARTITION}.json`, {
    meta: {
      ...started,
      class: ["builder-labelled"],
      description: "ScopeShift (B): authentic claims. Labels are builder-labelled, single builder, two passes, not independent. Development and held-out partitions are never pooled.",
      model: MODEL,
      modelRuns: { B3: RUNS, B4: B4_RUNS },
      promptHash: PROMPT_HASH,
      adapterHash: ADAPTER_HASH,
      adapter: ADAPTER,
      heldoutKeySha256: held?.keyHash ?? null,
      modelCalls: { b3: { live: b3.calls, replayed: b3.replays, retried: b3.retries }, b4: { live: b4.calls, replayed: b4.replays, retried: b4.retries } },
      resultsHash: hashOfJson(summaries).slice(0, 16),
    },
    summaries,
    detail,
  });
  console.log(`wrote scopeshift-b (${PARTITION}); model calls live B3 ${b3.calls} B4 ${b4.calls}, replayed B3 ${b3.replays} B4 ${b4.replays}`);
}

await main();
