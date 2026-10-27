/**
 * The recorded run: what a sample-mode investigation of every case produced, reduced to the parts that must not change.
 *
 * The committed file records, per case and per claim, the label and the relation on every dimension, the federation
 * statements that were sent with their result hashes, and the hashes of the stored records. Two sample runs must agree on it
 * byte for byte (FR-17); the judge script and the replay test both compare against the committed copy.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { InvestigationResult } from "../agents/investigation.ts";
import { canonicalJson, hashOf } from "../util/canonical.ts";

export interface RecordedClaim {
  claimId: string;
  findingId: string;
  label: string;
  ruleVersion: string;
  relations: Record<string, string>;
  dependsOnFacts: number;
}

export interface RecordedCase {
  caseId: string;
  claims: RecordedClaim[];
  federation: { statement: string; respHash: string; rows: number }[];
  records: { id: string; contentHash: string; textHash: string }[];
  links: { id: string; type: string; state: string }[];
  /** The model replies this run used, by role, so a missing recording is visible in the diff. */
  modelCalls: { role: string; recorded: boolean }[];
}

export interface RecordedRun {
  format: "sakaime.sample-run/1";
  note: string;
  cases: RecordedCase[];
  /** Hash of everything above, for a one-line comparison. */
  digest: string;
}

export function recordedCase(run: InvestigationResult): RecordedCase {
  const wb = run.wb;
  return {
    caseId: run.spec.id,
    claims: run.results.map((r) => ({
      claimId: r.claim.id,
      findingId: r.finding.id,
      label: r.finding.label,
      ruleVersion: r.finding.ruleVersion,
      relations: Object.fromEntries(r.finding.mechanicalCoverage.map((a) => [a.dimension, a.relation])),
      dependsOnFacts: r.finding.dependsOnFacts.length,
    })),
    federation: wb.federation.reads.map((f) => ({ statement: f.statement, respHash: f.result.respHash, rows: f.result.rows.length })),
    records: [...wb.extracted.values()].map((e) => ({ id: e.stored.id, contentHash: e.stored.contentHash, textHash: e.stored.textHash })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    links: (wb.links?.links ?? []).map((l) => ({ id: l.link.id, type: l.link.type, state: l.link.state })).sort((a, b) => (a.id < b.id ? -1 : 1)),
    modelCalls: (wb.env.model?.calls ?? []).map((c) => ({ role: c.role, recorded: c.response?.recorded ?? false })),
  };
}

export function recordedRun(runs: readonly InvestigationResult[]): RecordedRun {
  const cases = runs.map(recordedCase).sort((a, b) => (a.caseId < b.caseId ? -1 : 1));
  const body = { format: "sakaime.sample-run/1" as const, note: "Labels, relations, federation statements and record hashes of the sample run. Sample mode must reproduce this byte for byte.", cases };
  return { ...body, digest: hashOf(body) };
}

export const serialiseRun = (r: RecordedRun): string => `${JSON.stringify(JSON.parse(canonicalJson(r)), null, 2)}\n`;

export function writeRecordedRun(dir: string, r: RecordedRun): string {
  const file = join(dir, "labels.json");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, serialiseRun(r));
  return file;
}

export function readRecordedRun(dir: string): RecordedRun | undefined {
  const file = join(dir, "labels.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as RecordedRun) : undefined;
}
