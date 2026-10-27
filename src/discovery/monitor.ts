/**
 * Stage 8: monitoring. A registered source gets a baseline in the World Model (its schema hash as a fact about the
 * source), and `checkDrift` re-probes it later and compares.
 *
 * Two kinds of change matter and are told apart:
 *   DRIFTED          the shape changed (a field removed, added or retyped, found by comparing fingerprints)
 *   SEMANTIC_DRIFT   the shape is the same but the accepted mapping no longer validates (a column accepted as a
 *                    0..100 scale now holds fractions, a date column changed its order)
 * Either one asserts a new schema-hash fact, which makes the previous fact lose its slot; every finding that declared
 * a dependency on the old fact is marked stale by the World Model, and the report names them. An unreachable source is
 * UNAVAILABLE, never drift, and an empty answer is EMPTY, never "no change".
 */
import type { z } from "zod";
import type { OnboardingStageSchema } from "../api/contract.ts";
import { diffFingerprints, describeDiff, isDrift } from "./fingerprint.ts";
import { DEFAULT_HOLDINGS } from "./holdings.ts";
import { familyOf, probe } from "./probe.ts";
import { validateMapping, type FieldApproval } from "./validate.ts";
import type { LedgerEntry } from "./stores.ts";
import { DEFAULT_CONFIG, type DiscoveryDeps } from "./types.ts";
import type { Proposal } from "./lexical.ts";
import type { DateFamily } from "./values.ts";

type Stage = z.infer<typeof OnboardingStageSchema>;

export const sourceEntityId = (sourceId: string): string => `source:sakaime:${sourceId}`;

/** The id of the schema-hash fact a finding should declare a dependency on. */
export function schemaFactId(deps: Pick<DiscoveryDeps, "worldModel">, sourceId: string): string | undefined {
  return deps.worldModel.resolve(sourceEntityId(sourceId), "schema_hash").winner?.id;
}

export async function recordBaseline(
  deps: Pick<DiscoveryDeps, "worldModel" | "clock">,
  args: { sourceId: string; url: string; schemaHash: string; kind: string; table: string },
): Promise<{ entityId: string; schemaFactId: string }> {
  const at = deps.clock.now().toISOString();
  const entity = await deps.worldModel.upsertEntity({
    type: "source",
    externalKey: { system: "sakaime", id: args.sourceId },
    name: args.sourceId,
    attrs: { url: args.url, recordKind: args.kind, zetarisTable: args.table },
    source: { kind: "discovery", by: "discovery-fabric", at, url: args.url },
  });
  const fact = await deps.worldModel.assertFact({
    about: entity.id,
    predicate: "schema_hash",
    value: args.schemaHash,
    confidence: 1,
    source: { kind: "discovery", by: "discovery-fabric", at, url: args.url, checksum: args.schemaHash },
  });
  return { entityId: entity.id, schemaFactId: fact.id };
}

export type DriftStatus = "UNCHANGED" | "DRIFTED" | "SEMANTIC_DRIFT" | "UNAVAILABLE" | "EMPTY" | "NOT_REGISTERED";

export interface DriftReport {
  status: DriftStatus;
  detail: string;
  checkedAt: string;
  schemaHash?: string;
  previousSchemaHash?: string;
  diff?: ReturnType<typeof diffFingerprints>;
  /** Findings the World Model marked stale because of this check. */
  staleFindingIds: string[];
  /** Fields whose accepted mapping no longer validates. */
  semantic?: { sourceField: string; canonicalField: string; reason: string }[];
  stage: Stage;
}

function approvalsOf(entry: LedgerEntry): Map<string, FieldApproval> {
  const out = new Map<string, FieldApproval>();
  for (const f of entry.mapping?.fields ?? []) {
    out.set(f.sourceField, {
      by: entry.mapping?.acceptedBy ?? "memory",
      signatures: f.signatures,
      ...(f.representation ? { representation: f.representation } : {}),
      ...(f.dateFamily ? { dateFamily: f.dateFamily as DateFamily } : {}),
    });
  }
  return out;
}

/**
 * Asserts a new schema-hash fact about the source. The previous fact loses its slot, and the World Model marks every
 * finding that declared a dependency on it stale. Returns those findings.
 */
export async function markDrift(deps: Pick<DiscoveryDeps, "worldModel">, entry: Pick<LedgerEntry, "sourceId" | "url">, hash: string, kind: string, at: string): Promise<string[]> {
  const sourceId = entry.sourceId!;
  const about = sourceEntityId(sourceId);
  const oldFact = schemaFactId(deps, sourceId);
  const source = { kind: "discovery", by: "discovery-fabric", at, ...(entry.url ? { url: entry.url } : {}) };
  await deps.worldModel.assertFact({ about, predicate: "schema_hash", value: hash, confidence: 1, source: { ...source, checksum: hash } });
  await deps.worldModel.assertFact({ about, predicate: "drift", value: kind, confidence: 1, source });
  return oldFact ? deps.worldModel.staleDependents([oldFact]) : [];
}

export async function checkDrift(id: string, deps: DiscoveryDeps): Promise<DriftReport> {
  const cfg = { ...DEFAULT_CONFIG, ...deps.config };
  const now = deps.clock.now();
  const checkedAt = now.toISOString();
  const done = (status: DriftStatus, detail: string, extra: Partial<DriftReport> = {}): DriftReport => ({
    status,
    detail,
    checkedAt,
    staleFindingIds: [],
    ...extra,
    stage: { stage: "monitoring", status: status === "UNCHANGED" ? "passed" : status === "NOT_REGISTERED" ? "skipped" : "held", summary: detail, detail: { status, ...(extra.diff ? { diff: extra.diff } : {}) } },
  });

  const entry = deps.ledger.get(id);
  if (!entry || entry.state !== "registered" || !entry.url || !entry.shape || !entry.sourceId || !entry.mapping) {
    return done("NOT_REGISTERED", "this request has not registered a source, so there is nothing to monitor");
  }
  const card = deps.sources.cards.find((c) => {
    try {
      return c.file.hosts.some((h) => h.host === new URL(entry.url!).hostname);
    } catch {
      return false;
    }
  });
  const outcome = await probe({ fetcher: deps.sources.fetcher, url: entry.url, family: familyOf(card), maxBytes: cfg.maxProbeBytes, maxRows: cfg.maxRows, now });
  if (outcome.kind === "failed") return done("UNAVAILABLE", `the source could not be read (${outcome.failure}): ${outcome.message}`);
  if (outcome.kind === "empty") return done("EMPTY", `the source answered with no records on ${checkedAt.slice(0, 10)}: ${outcome.reason}. That is not the same as no change, and it is not a statement that nothing exists`);

  const previous = entry.schemaHash!;
  const diff = diffFingerprints(entry.shape, outcome.fingerprint.shape);
  const markStale = (hash: string, kind: string): Promise<string[]> => markDrift(deps, entry, hash, kind, checkedAt);

  if (isDrift(diff)) {
    const stale = await markStale(outcome.fingerprint.schemaHash, "shape");
    return done("DRIFTED", `the shape of the source changed: ${describeDiff(diff)}. ${stale.length} dependent finding${stale.length === 1 ? " is" : "s are"} marked stale`, {
      diff,
      schemaHash: outcome.fingerprint.schemaHash,
      previousSchemaHash: previous,
      staleFindingIds: stale,
    });
  }

  // Same shape: do the accepted mappings still hold for today's values?
  const proposals: Proposal[] = entry.mapping.fields.map((f) => ({ sourceField: f.sourceField, canonicalField: f.canonicalField, confidence: 1, proposer: "memory" }));
  const report = await validateMapping(
    {
      table: outcome.table,
      description: entry.description ?? "",
      now,
      federation: deps.federation,
      holdings: deps.holdings ?? DEFAULT_HOLDINGS,
      joinSample: cfg.joinSample,
      approvals: approvalsOf(entry),
      tableApprovals: entry.mapping.tableSignatures,
      skipJoin: true,
    },
    proposals,
  );
  const broken = report.fields.filter((f) => f.check === "rejected" || f.check === "needs_review");
  if (broken.length > 0) {
    const stale = await markStale(`${previous}:semantic:${outcome.table.sha256.slice(0, 12)}`, "semantic");
    return done(
      "SEMANTIC_DRIFT",
      `the shape is unchanged but ${broken.length} accepted mapping${broken.length === 1 ? "" : "s"} no longer validate: ${broken.map((b) => `${b.sourceField} (${b.reason})`).slice(0, 3).join("; ")}. ${stale.length} dependent finding${stale.length === 1 ? " is" : "s are"} marked stale`,
      {
        schemaHash: previous,
        staleFindingIds: stale,
        semantic: broken.map((b) => ({ sourceField: b.sourceField, canonicalField: b.canonicalField, reason: b.reason ?? "" })),
      },
    );
  }
  return done("UNCHANGED", `the shape and the accepted mappings are unchanged on ${checkedAt.slice(0, 10)} (schema ${previous.slice(0, 12)})`, { schemaHash: previous, previousSchemaHash: previous });
}
