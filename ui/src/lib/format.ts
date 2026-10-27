import type { AnchorView, Dimension, DimensionView, Finding } from "../api/types";
import type { FindingTypeKey } from "./vocab";

const dateFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const dateTimeFmt = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

/** Dates are shown in UTC so that a reviewer in another zone reads the same day as the record. */
export function formatDate(iso: string | undefined): string {
  if (!iso) return "not stated";
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso}T00:00:00Z` : iso);
  return Number.isNaN(d.getTime()) ? iso : dateFmt.format(d);
}

export function formatDateTime(iso: string | undefined): string {
  if (!iso) return "not stated";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : `${dateTimeFmt.format(d)} UTC`;
}

export function formatMs(ms: number): string {
  if (ms < 1) return "under 1 ms";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

export const shortHash = (h: string | undefined, n = 10): string => (h ? (h.length > n + 1 ? `${h.slice(0, n)}…` : h) : "none");

export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

export const caseId = (s: string): string => encodeURIComponent(s);

/**
 * The finding-type tag. The contract carries no type, so it is read from what decided the finding: which kind of
 * record each non-contained dimension rests on. A finding can carry more than one tag.
 */
export function findingTypes(finding: Finding, dims: DimensionView[], anchors: AnchorView[]): FindingTypeKey[] {
  const byId = new Map(anchors.map((a) => [a.id, a]));
  const out = new Set<FindingTypeKey>();
  const typeOf = (d: DimensionView): AnchorView["assertionType"][] => d.anchorIds.map((id) => byId.get(id)?.assertionType).filter((x): x is string => !!x);
  const open = dims.filter((d) => d.relation !== "CONTAINED");
  const focus = open.length > 0 ? open : dims;
  for (const d of focus) {
    const types = typeOf(d);
    if (types.includes("requirement")) out.add("policy");
    if (types.includes("authorization")) out.add("authorization");
    if (types.includes("study")) out.add(d.dimension === ("metric" as Dimension) ? "performance" : "reporting");
    if (types.length === 0 && d.relation === "UNKNOWN") out.add("reporting");
  }
  if (finding.label === "REQUIRES_DOMAIN_REVIEW" || finding.expertReviewFlags.length > 0) out.add("judgement");
  if (out.size === 0) out.add("authorization");
  return [...out];
}

/** Rendered scope values come from the server as strings; show a clear word when a side is silent. */
export const sideText = (v: string | undefined): string => (v && v.trim() ? v : "Not stated");

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

export function newKey(): string {
  const c = globalThis.crypto;
  return c && "randomUUID" in c ? c.randomUUID() : `k-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
