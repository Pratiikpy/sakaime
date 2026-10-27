/**
 * Derives the lineage events for a dossier from its own contents:
 *   source.read            source            -> record      (content hash as dataset version, anchors on the record)
 *   federation.query       silos             -> result      (SQL job facet, result schema, served-from label)
 *   model.<role>           records           -> fields      (receipt facet: receipted or not, live or recorded)
 *   extract.evidence       records           -> evidence item (anchors)
 *   applicability.compile  claim + items     -> finding     (rule version job facet, anchors and label on the output)
 *
 * A reader can walk from a finding back to the quoted passages, the records they sit in, the queries and the model
 * calls that produced them, each step carrying the rule or receipt it ran under.
 */
import type { Clock } from "../ports/index.ts";
import type { DossierBody } from "./schema.ts";
import {
  JOBS,
  LineageEmitter,
  NS,
  anchorsFacet,
  federationFacet,
  findingAnchorIds,
  findingFacet,
  receiptFacet,
  recordVersionFacet,
  ruleVersionFacet,
  schemaFacet,
  sqlFacet,
} from "./lineage.ts";
import type { LineageDataset, LineageEvent } from "./lineage.ts";

export type LineageSource = Pick<
  DossierBody,
  "rules" | "claims" | "findings" | "compilerRuns" | "evidenceItems" | "anchors" | "snapshots" | "federation" | "models"
>;

export function deriveLineage(source: LineageSource, fallbackTime: string): LineageEvent[] {
  const emitter = new LineageEmitter({ now: () => new Date(fallbackTime) } satisfies Clock);
  const anchorsByRecord = new Map<string, DossierBody["anchors"]>();
  const anchorsById = new Map(source.anchors.map((a) => [a.id, a]));
  for (const a of source.anchors) anchorsByRecord.set(a.recordId, [...(anchorsByRecord.get(a.recordId) ?? []), a]);
  const recordTime = new Map(source.snapshots.map((s) => [s.id, s.retrievedAt]));
  const itemsById = new Map(source.evidenceItems.map((i) => [i.id, i]));

  for (const snap of source.snapshots) {
    const run = emitter.start(
      { name: JOBS.sourceRead },
      { runKey: snap.id, at: snap.retrievedAt, inputs: [{ namespace: NS.source, name: snap.sourceId }] },
    );
    run.complete({
      at: snap.retrievedAt,
      outputs: [
        {
          namespace: NS.record,
          name: snap.id,
          facets: { version: recordVersionFacet(snap.contentHash), sakaime_anchors: anchorsFacet(anchorsByRecord.get(snap.id) ?? []) },
        },
      ],
    });
  }

  for (const q of source.federation) {
    const run = emitter.start(
      { name: JOBS.federationQuery, facets: { sql: sqlFacet(q.statement, "zetaris") } },
      {
        runKey: q.queryId,
        at: q.at,
        inputs: q.sourceIds.map((id): LineageDataset => ({ namespace: NS.source, name: id })),
        runFacets: { sakaime_federation: federationFacet({ queryId: q.queryId, respHash: q.respHash, servedFrom: q.servedFrom, label: q.label, total: q.total }) },
      },
    );
    run.complete({ at: q.at, outputs: [{ namespace: NS.federation, name: q.queryId, facets: { schema: schemaFacet(q.columns) } }] });
  }

  for (const reply of source.models) {
    const run = emitter.start(
      { name: `${JOBS.modelPrefix}${reply.role}` },
      {
        runKey: reply.id,
        at: reply.at,
        inputs: reply.inputRecordIds.map((id): LineageDataset => ({ namespace: NS.record, name: id })),
        runFacets: {
          sakaime_receipt: receiptFacet({
            ...(reply.receipt ? { receiptId: reply.receipt.receiptId } : {}),
            routedModel: reply.routedModel,
            provider: reply.provider,
            label: reply.label,
            receipted: reply.receipt !== undefined,
          }),
        },
      },
    );
    run.complete({ at: reply.at, outputs: reply.derives.map((id): LineageDataset => ({ namespace: NS.assertion, name: id })) });
  }

  for (const item of source.evidenceItems) {
    const itemAnchorIds = new Set([...item.anchorIds, ...item.results.map((r) => r.anchorId).filter((id): id is string => id !== undefined)]);
    const anchors = [...itemAnchorIds].map((id) => anchorsById.get(id)).filter((a): a is NonNullable<typeof a> => a !== undefined);
    const recordIds = [...new Set(anchors.map((a) => a.recordId))].sort();
    const times = recordIds.map((id) => recordTime.get(id)).filter((t): t is string => t !== undefined).sort();
    const at = times.length > 0 ? (times[times.length - 1] as string) : fallbackTime;
    const run = emitter.start(
      { name: JOBS.extractEvidence },
      { runKey: item.id, at, inputs: recordIds.map((id): LineageDataset => ({ namespace: NS.record, name: id })) },
    );
    run.complete({ at, outputs: [{ namespace: NS.evidence, name: item.id, facets: { sakaime_anchors: anchorsFacet(anchors) } }] });
  }

  const runByFinding = new Map(source.compilerRuns.map((r) => [r.findingId, r]));
  for (const finding of source.findings) {
    const at = finding.computedAt ?? fallbackTime;
    const itemIds = (runByFinding.get(finding.id)?.evidenceItemIds ?? []).filter((id) => itemsById.has(id));
    const citedAnchors = findingAnchorIds(finding)
      .map((id) => anchorsById.get(id))
      .filter((a): a is NonNullable<typeof a> => a !== undefined);
    const run = emitter.start(
      { name: JOBS.compile, facets: { sakaime_ruleVersion: ruleVersionFacet(finding.ruleVersion, source.rules.registryVersion) } },
      {
        runKey: finding.id,
        at,
        inputs: [{ namespace: NS.claim, name: finding.claimId }, ...itemIds.map((id): LineageDataset => ({ namespace: NS.evidence, name: id }))],
      },
    );
    run.complete({
      at,
      outputs: [
        {
          namespace: NS.finding,
          name: finding.id,
          facets: { sakaime_finding: findingFacet(finding), sakaime_anchors: anchorsFacet(citedAnchors) },
        },
      ],
    });
  }

  if (emitter.unfinished().length > 0) throw new Error("lineage: runs left open while deriving a dossier");
  return emitter.events();
}
