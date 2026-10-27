/**
 * Accepted schema mappings in H-MEM, so a shape that has been mapped (and, where needed, reviewed) is not put to the
 * model again. Records are scoped to the organisation: one hospital's accepted mapping is never another's.
 *
 * What is stored is the mapping and the reviewer's acceptances, not a verdict about the data. The validators run on
 * every new sample, and a stored acceptance only covers the exact holds it was given for: a column accepted as a
 * 0 to 100 scale that now arrives as fractions is held again.
 */
import type { HMEM } from "../engines/hmem/index.ts";
import type { MemoryRecord } from "../engines/hmem/types.ts";
import { hashOf } from "../util/canonical.ts";
import type { StoredMapping } from "./stores.ts";

export const MAPPING_KIND = "schema_mapping";

function payloadOf(record: MemoryRecord): StoredMapping | undefined {
  const at = record.content.indexOf("{");
  if (at < 0) return undefined;
  try {
    return JSON.parse(record.content.slice(at)) as StoredMapping;
  } catch {
    return undefined;
  }
}

/** The current (not superseded) accepted mapping for a schema hash in this organisation. */
export function findMapping(hmem: HMEM, orgId: string, schemaHash: string): { record: MemoryRecord; mapping: StoredMapping } | undefined {
  const tag = `schema:${schemaHash}`;
  const hits = hmem.store
    .all()
    .filter((r) => r.kind === MAPPING_KIND && r.organizationId === orgId && r.tags.includes(tag) && r.supersededBy === undefined)
    .sort((a, b) => b.timestamp - a.timestamp);
  for (const record of hits) {
    const mapping = payloadOf(record);
    if (mapping && mapping.schemaHash === schemaHash) return { record, mapping };
  }
  return undefined;
}

export function rememberMapping(hmem: HMEM, orgId: string, mapping: StoredMapping): MemoryRecord {
  const prior = findMapping(hmem, orgId, mapping.schemaHash);
  const digest = hashOf(mapping.fields).slice(0, 16);
  if (prior && hashOf(prior.mapping.fields) === hashOf(mapping.fields) && JSON.stringify(prior.mapping.tableSignatures) === JSON.stringify(mapping.tableSignatures)) return prior.record;
  const fields = mapping.fields.map((f) => `${f.sourceField} -> ${f.canonicalField}`).join("; ");
  return hmem.add({
    content: `Schema mapping ${mapping.schemaHash.slice(0, 12)} for a ${mapping.recordKind} source, accepted by ${mapping.basis === "reviewer" ? `reviewer ${mapping.acceptedBy}` : "the validators"}: ${fields}. ${JSON.stringify(mapping)}`,
    source: mapping.basis === "reviewer" ? `reviewer:${mapping.acceptedBy}` : "discovery:semantic-validator",
    type: "factual",
    kind: MAPPING_KIND,
    tags: [MAPPING_KIND, `schema:${mapping.schemaHash}`, `kind:${mapping.recordKind}`],
    organizationId: orgId,
    ...(mapping.basis === "reviewer" ? { sourceTier: "reviewer" as const } : { confidence: 0.7 }),
    provenance: {
      origin: mapping.basis === "reviewer" ? "reviewer" : "tool",
      learnedAt: Date.parse(mapping.acceptedAt) || 0,
      label: `schema mapping ${mapping.schemaHash.slice(0, 12)}`,
      ...(mapping.basis === "reviewer" ? { reviewer: mapping.acceptedBy } : {}),
    },
    ...(prior ? { supersedes: prior.record.id } : {}),
    idempotencyKey: `schema-mapping:${orgId}:${mapping.schemaHash}:${digest}`,
  });
}
