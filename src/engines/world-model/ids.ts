import { createHash } from "node:crypto";
import { canonicalJson } from "../../util/canonical.ts";

/**
 * Stable, content-addressed identifiers for the World Model. The grammar follows the sponsor's
 * specification (docs/stable-ids.md in third_party/meterless/world-model): an externally keyed
 * entity is the literal `type:system:id`; a name-keyed entity is `ent_` plus the first 16 hex
 * characters of sha256(`type:normalizedName`). The conformance runner pins both forms.
 */

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * NFKD, strip combining marks, strip zero-width characters, lowercase, collapse whitespace, trim.
 * The order follows the reference (marks and zero-width characters are removed before lowercasing)
 * so that identifiers agree with the reference for every input; the two orders differ only for
 * exotic characters. Normalisation never abbreviates or stems: "Acme Corp" and "Acme Corporation"
 * are different names.
 */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[​-‍﻿]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function externalId(type: string, system: string, id: string): string {
  return `${type}:${system}:${id}`;
}

export function entityIdFromName(type: string, name: string): string {
  return `ent_${sha256(`${type}:${normalizeName(name)}`).slice(0, 16)}`;
}

/** Attribute-keyed contexts hash their parent, so week 14 under season 145 differs from season 144. */
export function contextIdFromAttrs(type: string, attrs: Record<string, unknown>, parent?: string): string {
  return `ctx_${sha256(`${type}:${canonicalJson(attrs)}:${parent ?? ""}`).slice(0, 16)}`;
}

/** Re-adding the same edge is a no-op because the id is a pure function of its identity. */
export function relationshipId(from: string, type: string, to: string, context?: string, validFrom?: string): string {
  return `rel_${sha256(`${from}|${type}|${to}|${context ?? ""}|${validFrom ?? ""}`).slice(0, 16)}`;
}

export function factId(
  about: string,
  predicate: string,
  value: unknown,
  assertedAt: string,
  sourceKind: string,
  sourceUrl?: string,
): string {
  return `fact_${sha256(`${about}|${predicate}|${canonicalJson(value)}|${assertedAt}|${sourceKind}|${sourceUrl ?? ""}`).slice(0, 16)}`;
}

export const sha256Hex = sha256;
export { canonicalJson };
