import type { MemoryRecord, Scope } from "./types.ts";

/**
 * Who may see a record.
 *
 * A record with an `organizationId` is visible only to a query for that organization: a precedent
 * one hospital wrote is not another hospital's guidance, and is never presented as general clinical
 * guidance. A record with a `caseId` is further limited to that case. A query that names no
 * organization sees only records that belong to none. This is stricter than the sponsor's recall
 * rules (which filter only when the query names a scope), because the cost of leaking one
 * institution's judgement into another's review is higher than the cost of a miss.
 *
 * Chat, mission and goal-run scoping follow the specification: a query that names one excludes
 * records bound to a different one; records bound to none are included unless `includeUnscoped`
 * is false.
 */
export function visibleTo(record: MemoryRecord, scope: Scope, includeUnscoped = true): boolean {
  if (record.organizationId !== undefined && record.organizationId !== scope.organizationId) return false;
  if (record.caseId !== undefined && record.caseId !== scope.caseId) return false;
  for (const key of ["chatId", "missionId", "goalRunId"] as const) {
    const wanted = scope[key];
    if (wanted === undefined) continue;
    const has = record[key];
    if (has === undefined) {
      if (!includeUnscoped) return false;
    } else if (has !== wanted) return false;
  }
  return true;
}

/** Records may be compared for conflicts when the narrower scope's owner could see the other. */
export function comparable(a: MemoryRecord, b: MemoryRecord): boolean {
  if (a.organizationId !== b.organizationId) return false;
  return a.caseId === undefined || b.caseId === undefined || a.caseId === b.caseId;
}

/** Strict grouping key for synthesis and dreaming: records in different groups are never combined. */
export function scopeKey(r: MemoryRecord): string {
  return `${r.organizationId ?? ""}\u0000${r.caseId ?? ""}`;
}
