/**
 * Helpers that turn the objects the ports return into the records a dossier stores, so the label (live or recorded)
 * and the receipt status are derived once, in one place, from the port's own fields.
 */
import type { FederationResult, ModelResponse } from "../ports/index.ts";
import type { EvidenceRecord, DataClass } from "../schemas/index.ts";
import { hashOf, sha256Hex } from "../util/canonical.ts";
import type { FederationQuery, ModelReply, ServedLabel, Snapshot } from "./schema.ts";

export function snapshotFromRecord(input: { record: Omit<EvidenceRecord, "payload" | "contentRef">; text: string; contentKind: Snapshot["contentKind"] }): Snapshot {
  const { record, text, contentKind } = input;
  return { ...record, contentKind, text, textHash: sha256Hex(text) };
}

export function federationLabel(servedFrom: FederationResult["servedFrom"]): ServedLabel {
  return servedFrom === "cassette" ? "recorded" : servedFrom === "fallback" ? "fallback" : "live";
}

export function federationQueryFromResult(
  result: FederationResult,
  context: { statement: string; identity?: string; at: string; sourceIds?: string[]; keepResult?: boolean },
): FederationQuery {
  const stored = { columns: result.columns.map((c) => ({ name: c.name, type: c.type })), rows: result.rows };
  return {
    queryId: result.queryId,
    statement: context.statement,
    ...(context.identity !== undefined ? { identity: context.identity } : {}),
    at: context.at,
    servedFrom: result.servedFrom,
    label: federationLabel(result.servedFrom),
    total: result.total,
    rowCount: result.rows.length,
    columns: stored.columns,
    respHash: result.respHash,
    sourceIds: context.sourceIds ?? [],
    ...(context.keepResult ? { result: stored, resultDigest: hashOf(stored) } : {}),
  };
}

export function modelReplyFromResponse(
  response: ModelResponse,
  context: { id: string; at: string; role: string; dataClass: DataClass; derives?: string[]; inputRecordIds?: string[] },
): ModelReply {
  return {
    id: context.id,
    at: context.at,
    role: context.role,
    requestedModel: response.requestedModel,
    routedModel: response.routedModel,
    provider: response.provider,
    recorded: response.recorded,
    label: response.recorded ? "recorded" : "live",
    dataClass: context.dataClass,
    textHash: sha256Hex(response.text),
    usage: response.usage,
    ...(response.receipt ? { receipt: response.receipt } : {}),
    derives: context.derives ?? [],
    inputRecordIds: context.inputRecordIds ?? [],
  };
}
