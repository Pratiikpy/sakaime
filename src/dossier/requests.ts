/**
 * Missing-evidence requests (F6).
 *
 * Turns a finding's `requiredEvidence` into plain text a reviewer can copy into an email to the vendor. This module
 * only builds text. It has no network code and no way to send anything; the reviewer sends it, or does not.
 */
import { currentFindings } from "./decisions.ts";
import { DIMENSIONS } from "../schemas/index.ts";
import type { Claim, Dimension, Finding, Label, Relation, Scope } from "../schemas/index.ts";

export const NOT_SENT_NOTICE = "Draft for the reviewer to edit and send. Nothing in this system sends it.";

const RELATION_RANK: Record<Relation, number> = { DISJOINT: 0, PARTIAL: 1, UNKNOWN: 2, CONTAINED: 3 };
const LABEL_RANK: Record<Label, number> = {
  INSUFFICIENT_EVIDENCE: 0,
  SUPPORTED_ONLY_FOR_NARROWER_SCOPE: 1,
  REQUIRES_DOMAIN_REVIEW: 2,
  CONTRADICTED_BY_SPECIFIED_EVIDENCE: 3,
  SUPPORTED_FOR_SCOPE: 4,
};

export interface MissingEvidenceItem {
  claimId: string;
  findingId: string;
  label: Label;
  dimension: Dimension;
  /** How the claimed scope relates to what the evidence establishes on this dimension. */
  relation: Relation;
  request: string;
  /** 1 is asked first. */
  priority: number;
}

function relationOf(finding: Finding, dimension: Dimension): Relation {
  return finding.mechanicalCoverage.find((a) => a.dimension === dimension)?.relation ?? "UNKNOWN";
}

/**
 * The reviewer's list across all current findings. Findings that cannot be supported yet come before those that already are;
 * within a finding, a dimension the evidence contradicts or only partly covers comes before one it says nothing about.
 */
export function missingEvidenceList(findings: readonly Finding[]): MissingEvidenceItem[] {
  const rows: Omit<MissingEvidenceItem, "priority">[] = [];
  for (const f of currentFindings(findings)) {
    for (const r of f.requiredEvidence) {
      rows.push({ claimId: f.claimId, findingId: f.id, label: f.label, dimension: r.dimension, relation: relationOf(f, r.dimension), request: r.request });
    }
  }
  rows.sort(
    (a, b) =>
      LABEL_RANK[a.label] - LABEL_RANK[b.label] ||
      RELATION_RANK[a.relation] - RELATION_RANK[b.relation] ||
      DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension) ||
      (a.findingId < b.findingId ? -1 : a.findingId > b.findingId ? 1 : 0),
  );
  return rows.map((r, i) => ({ ...r, priority: i + 1 }));
}

export interface EvidenceRequestDraft {
  claimId: string;
  findingId: string;
  subject: string;
  /** Copyable plain text. */
  body: string;
  items: { dimension: Dimension; relation: Relation; request: string }[];
  /** Always true. The draft is text only; this module has no way to send it. */
  neverSent: true;
  notice: string;
}

export interface DraftOptions {
  /** Name used in the salutation, for example the vendor's regulatory team. */
  addressee?: string;
  /** Who is asking, for the sign-off. */
  sender?: string;
  /** Product name as the buyer knows it; falls back to the product identity in the claim. */
  productName?: string;
}

function renderScope(use: Scope): string[] {
  const lines: string[] = [];
  if (use.product) lines.push(`Product: ${use.product}`);
  if (use.versions?.length) lines.push(`Software version: ${use.versions.join(", ")}`);
  const p = use.population;
  if (p) {
    const parts: string[] = [];
    if (p.age) parts.push(p.age.min !== undefined && p.age.max !== undefined ? `ages ${p.age.min} to ${p.age.max}` : p.age.min !== undefined ? `ages ${p.age.min} and over` : p.age.max !== undefined ? `ages up to ${p.age.max}` : "");
    if (p.conditions?.length) parts.push(p.conditions.join(", "));
    if (p.exclusions?.length) parts.push(`excluding ${p.exclusions.join(", ")}`);
    const text = parts.filter(Boolean).join("; ");
    if (text) lines.push(`Population: ${text}`);
  }
  if (use.settings?.length) lines.push(`Care setting: ${use.settings.join(", ")}`);
  if (use.purpose) lines.push(`Intended purpose: ${use.purpose}`);
  if (use.timing?.from) lines.push(`Planned start: ${use.timing.from}`);
  if (use.operatingPoint) lines.push(`Operating point: ${use.operatingPoint}`);
  return lines;
}

/** One finding to one request letter. Returns undefined when the finding names nothing to ask for. */
export function draftEvidenceRequest(finding: Finding, claim: Claim, options: DraftOptions = {}): EvidenceRequestDraft | undefined {
  if (finding.claimId !== claim.id) throw new Error(`finding ${finding.id} is for claim ${finding.claimId}, not ${claim.id}`);
  if (finding.requiredEvidence.length === 0) return undefined;

  const items = [...finding.requiredEvidence]
    .map((r) => ({ dimension: r.dimension, relation: relationOf(finding, r.dimension), request: r.request }))
    .sort((a, b) => RELATION_RANK[a.relation] - RELATION_RANK[b.relation] || DIMENSIONS.indexOf(a.dimension) - DIMENSIONS.indexOf(b.dimension));

  const product = options.productName ?? claim.use.product ?? "the product";
  const version = claim.use.versions?.length ? ` ${claim.use.versions.join(", ")}` : "";
  const subject = `Request for evidence: ${product}${version}`;
  const lines: string[] = [];
  lines.push(`Dear ${options.addressee ?? "regulatory and clinical affairs team"},`, "");
  lines.push("We are assessing the product below for a specific use. The documents we hold do not yet settle the points listed, and we would like to see the evidence for each.", "");
  lines.push("Our intended use:");
  for (const l of renderScope(claim.use)) lines.push(`  ${l}`);
  if (claim.performance) lines.push(`  Performance relied on: ${claim.performance.metric} at least ${claim.performance.atLeast}`);
  lines.push("", "What we are asking for:", "");
  items.forEach((it, i) => lines.push(`${i + 1}. ${capitalise(it.dimension)}: ${it.request}`));
  lines.push("", "For each item, please send the document, or confirm in writing, and name the document, version and page where it can be read.", "");
  lines.push("Thank you.");
  if (options.sender) lines.push(options.sender);

  return { claimId: claim.id, findingId: finding.id, subject, body: lines.join("\n"), items, neverSent: true, notice: NOT_SENT_NOTICE };
}

/** One draft per current finding that has something to ask for, in list priority order. */
export function draftEvidenceRequests(findings: readonly Finding[], claims: readonly Claim[], options: DraftOptions = {}): EvidenceRequestDraft[] {
  const byClaim = new Map(claims.map((c) => [c.id, c]));
  const order = new Map(missingEvidenceList(findings).map((m) => [m.findingId, m.priority]));
  const drafts: EvidenceRequestDraft[] = [];
  for (const f of currentFindings(findings)) {
    const claim = byClaim.get(f.claimId);
    if (!claim) continue;
    const d = draftEvidenceRequest(f, claim, options);
    if (d) drafts.push(d);
  }
  return drafts.sort((a, b) => (order.get(a.findingId) ?? Infinity) - (order.get(b.findingId) ?? Infinity));
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
