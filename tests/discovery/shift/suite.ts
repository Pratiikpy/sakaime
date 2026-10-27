/**
 * Runs the DiscoveryShift cases through the onboarding pipeline (and its ablations) and the hardcoded baseline.
 *
 * Every case gets fresh dependencies: its own memory, ledger, engine and object store, so no case can borrow a mapping
 * accepted for another. The engine is the test double over DuckDB (tests/discovery/helpers/doubles.ts) holding the real
 * silo files as the data we hold; the live Zetaris registration has its own run (live.test.ts, LIVE.md).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { onboardSource } from "../../../src/discovery/index.ts";
import { createModelStack, readEnvFile, type ModelStack } from "../../../src/models/index.ts";
import type { ModelPort } from "../../../src/ports/index.ts";
import { harness, ROOT, urlOf } from "../helpers/fixtures.ts";
import { hardcodedEtl } from "./baseline.ts";
import { categorise, type Actual, type Category, type Expected, type Label } from "./score.ts";

export const SHIFT_DIR = resolve(ROOT, "data", "discovery-shift");
export const CASSETTE_DIR = join(SHIFT_DIR, "model-cassettes");

export interface CaseSpec {
  id: string;
  cluster: string;
  class: string;
  mutation: string;
  file: string;
  format: string;
  sha256: string;
  description: string;
  expectedJoinRate?: number;
  query?: string;
}

export interface Sealed {
  cases: CaseSpec[];
  expected: Record<string, Expected>;
  ok: boolean;
  problems: string[];
  hashes: { expected: string; cases: string };
}

const sha = (b: Buffer | string): string => createHash("sha256").update(b).digest("hex");

/** Loads the suite and checks it against SEALED.md and against its own per-file hashes. */
export function loadSealed(): Sealed {
  const problems: string[] = [];
  const expectedRaw = readFileSync(join(SHIFT_DIR, "expected.json"));
  const casesRaw = readFileSync(join(SHIFT_DIR, "cases.json"));
  const sealed = readFileSync(join(SHIFT_DIR, "SEALED.md"), "utf8");
  const hashes = { expected: sha(expectedRaw), cases: sha(casesRaw) };
  if (!sealed.includes(hashes.expected)) problems.push("expected.json does not match the hash in SEALED.md");
  if (!sealed.includes(hashes.cases)) problems.push("cases.json does not match the hash in SEALED.md");
  const cases = (JSON.parse(casesRaw.toString("utf8")) as { cases: CaseSpec[] }).cases;
  for (const c of cases) {
    if (sha(readFileSync(join(SHIFT_DIR, c.file))) !== c.sha256) problems.push(`${c.file} does not match its recorded hash`);
  }
  return { cases, expected: JSON.parse(expectedRaw.toString("utf8")) as Record<string, Expected>, ok: problems.length === 0, problems, hashes };
}

export type Arm = "full" | "lexical" | "nojoin";
export type Mode = "replay" | "record" | "live";

export interface CaseResult {
  id: string;
  cluster: string;
  class: string;
  label: Label;
  category: Category;
  detail?: string;
  reason?: string;
  accepted: Record<string, string>;
  /** Fields the validator held or rejected, with the reason. */
  open: { sourceField: string; canonicalField: string; check: string; reason?: string }[];
  stages: string;
  recorded: boolean;
  proposer?: string;
  ms: number;
  knownLimit?: string;
  baseline: { label: Label; category: Category; reason?: string };
}

export async function makeModel(mode: Mode): Promise<{ port: ModelPort; stack: ModelStack }> {
  const env = { ...process.env, ...readEnvFile(join(ROOT, ".env")) };
  const stack = await createModelStack({ env, mode: mode === "replay" ? "recorded" : mode === "record" ? "record" : "live", cassetteDir: CASSETTE_DIR });
  if (mode !== "replay") await stack.beginRun();
  return { port: stack.port, stack };
}

export async function runCase(spec: CaseSpec, expected: Expected, o: { port: ModelPort; arm: Arm }): Promise<CaseResult> {
  const text = readFileSync(join(SHIFT_DIR, spec.file), "utf8");
  const g = await harness({ model: o.port, config: { useModel: o.arm !== "lexical" } });
  try {
    // Without the federated cross-source checks: no joins to held records and no comparison with the held record for a key.
    if (o.arm === "nojoin") {
      g.deps.holdings = {};
      g.deps.rowSpecs = {};
    }
    const url = `${urlOf(`${spec.id}.${spec.format}`)}${spec.query ?? ""}`;
    g.fetcher.set(url, text);
    const started = performance.now();
    const request = await g.request(`${spec.id}.${spec.format}`, { url, description: spec.description, ...(spec.expectedJoinRate !== undefined ? { expectedJoinRate: spec.expectedJoinRate } : {}), contract: await g.contract("rev-1", url) });
    const result = await onboardSource(request, g.deps);
    const ms = Math.round(performance.now() - started);
    const label: Label = result.outcome === "registered" ? "mapped" : result.outcome === "held_for_review" ? "held" : "declined";
    const accepted = Object.fromEntries(result.mapping.filter((m) => m.check === "ok" || m.check === "renamed").map((m) => [m.sourceField, m.canonicalField]));
    const actual: Actual = { label, accepted };
    const scored = categorise(expected, actual);
    const proposal = result.stages.find((s) => s.stage === "mapping_proposal")?.detail as { proposer?: string } | undefined;
    const base = hardcodedEtl(spec.cluster, text);
    const baseScored = categorise(expected, { label: base.label, accepted: base.label === "mapped" ? Object.fromEntries(Object.entries(expected.mapping ?? {}).filter(([h]) => Object.values(NATIVE_HEADERS[spec.cluster] ?? []).includes(h))) : {} });
    return {
      id: spec.id,
      cluster: spec.cluster,
      class: spec.class,
      label,
      category: scored.category,
      ...(scored.detail ? { detail: scored.detail } : {}),
      ...(result.reason ? { reason: result.reason } : {}),
      accepted,
      open: result.mapping.filter((m) => m.check === "needs_review" || m.check === "rejected").map((m) => ({ sourceField: m.sourceField, canonicalField: m.canonicalField, check: m.check, ...(m.reason ? { reason: m.reason } : {}) })),
      stages: result.stages.map((s) => s.status[0]).join(""),
      recorded: result.recorded,
      ...(proposal?.proposer ? { proposer: proposal.proposer } : {}),
      ms,
      ...(expected.knownLimit ? { knownLimit: expected.knownLimit } : {}),
      baseline: { label: base.label, category: baseScored.category, ...(base.reason ? { reason: base.reason } : {}) },
    };
  } finally {
    g.close();
  }
}

/** The headers of each base layout, so the baseline's "mapping" is the fixed one. */
const NATIVE_HEADERS: Record<string, string[]> = {
  A: ["k_number", "device_name", "applicant", "product_code", "decision_date", "device_class"],
  B: ["nct_id", "brief_title", "overall_status", "enrollment_count", "start_date", "minimum_age_years", "eligibility_summary"],
  C: ["pmid", "pub_year", "sensitivity", "specificity", "nct_id"],
  D: ["pmid", "doi", "pub_year", "title"],
};

export async function runSuite(o: { mode: Mode; arm: Arm; only?: string[]; log?: (line: string) => void }): Promise<{ results: CaseResult[]; sealed: Sealed; model?: string[] }> {
  const sealed = loadSealed();
  if (!sealed.ok) throw new Error(`the suite does not match what was sealed: ${sealed.problems.join("; ")}`);
  if (o.mode === "replay" && !existsSync(CASSETTE_DIR) && o.arm !== "lexical") throw new Error("no model recordings: run with --mode record first");
  const { port, stack } = await makeModel(o.mode);
  const results: CaseResult[] = [];
  for (const spec of sealed.cases) {
    if (o.only && !o.only.includes(spec.id)) continue;
    const r = await runCase(spec, sealed.expected[spec.id]!, { port, arm: o.arm });
    results.push(r);
    o.log?.(`${spec.id.padEnd(8)} ${r.label.padEnd(8)} ${r.category.padEnd(14)} ${r.stages} ${r.ms} ms`);
  }
  return { results, sealed, model: stack.notes };
}
