/**
 * The shapes the web app reads (src/api/contract.ts), built from a finished investigation.
 *
 * Nothing here decides a label or recomputes one: labels come from the compiler through the investigation, and the UI is
 * shown exactly what the compiler returned. These functions only arrange it: a finding with the reason for each dimension, the
 * quoted passages behind it, the links with their candidate classes, the timeline of facts and decisions, and the list of what
 * would settle each open point.
 */
import type { z } from "zod";
import type {
  AnchorViewSchema,
  CaseDetailSchema,
  CaseSummarySchema,
  DimensionViewSchema,
  LinkViewSchema,
  MissingEvidenceItemSchema,
  RunModeSchema,
  SourceRowSchema,
  TimelineEventSchema,
} from "../api/contract.ts";
import { NOT_SENT_NOTICE, draftEvidenceRequest, missingEvidenceList, reviewStateOf, type DecisionEntry } from "../dossier/index.ts";
import type { InvestigationResult } from "../agents/investigation.ts";
import type { Finding } from "../schemas/index.ts";
import { DIMENSIONS } from "../schemas/index.ts";
import { matrixView } from "./federation.ts";
import { assertionTypesOf } from "./reader.ts";
import { brief } from "./util.ts";

export type CaseSummary = z.infer<typeof CaseSummarySchema>;
export type CaseDetail = z.infer<typeof CaseDetailSchema>;
export type DimensionView = z.infer<typeof DimensionViewSchema>;
export type AnchorView = z.infer<typeof AnchorViewSchema>;
export type LinkView = z.infer<typeof LinkViewSchema>;
export type MissingEvidenceItem = z.infer<typeof MissingEvidenceItemSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type RunMode = z.infer<typeof RunModeSchema>;
export type SourceRow = z.infer<typeof SourceRowSchema>;

export interface ViewContext {
  run: InvestigationResult;
  decisions: DecisionEntry[];
  mode: RunMode;
  /** Findings the World Model currently marks stale. */
  stale: ReadonlySet<string>;
  /** Link states a reviewer set after the run. */
  linkEvents: { at: string; linkId: string; decision: string; reviewer: string }[];
}

const REVIEW_STATE: Record<string, Finding["reviewerState"]> = {
  unreviewed: "unreviewed",
  accepted: "accepted",
  narrowed: "narrowed",
  evidence_requested: "evidence_requested",
  escalated: "escalated",
};

export function currentFindings(ctx: ViewContext): Finding[] {
  return ctx.run.results.map((r) => ({ ...r.finding, reviewerState: REVIEW_STATE[reviewStateOf(ctx.decisions, r.finding.id)] ?? "unreviewed" }));
}

export function dimensionViews(ctx: ViewContext): Record<string, DimensionView[]> {
  const out: Record<string, DimensionView[]> = {};
  for (const r of ctx.run.results) {
    const reasons = new Map(r.detail.reasons.map((x) => [x.dimension, x]));
    out[r.finding.id] = DIMENSIONS.map((d) => {
      const a = r.finding.mechanicalCoverage.find((x) => x.dimension === d);
      const why = reasons.get(d);
      return {
        dimension: d,
        relation: a?.relation ?? "UNKNOWN",
        ...(a?.claimed !== undefined ? { claimed: a.claimed } : {}),
        ...(a?.established !== undefined ? { established: a.established } : {}),
        reason: why?.text ?? "this dimension was not assessed",
        anchorIds: a?.anchorIds ?? [],
      };
    });
  }
  return out;
}

export function anchorViews(ctx: ViewContext): AnchorView[] {
  const wb = ctx.run.wb;
  const asm = wb.assembled;
  if (!asm) return [];
  const cited = new Map<string, Set<string>>();
  for (const r of ctx.run.results) {
    for (const a of r.finding.mechanicalCoverage) {
      const rules = r.detail.reasons.find((x) => x.dimension === a.dimension)?.ruleIds ?? [];
      for (const id of a.anchorIds) {
        const set = cited.get(id) ?? new Set<string>();
        rules.forEach((x) => set.add(x));
        cited.set(id, set);
      }
    }
    for (const m of r.finding.mismatches) for (const id of m.anchorIds) if (!cited.has(id)) cited.set(id, new Set());
  }
  const stored = new Map([...wb.extracted.values()].map((e) => [e.stored.id, e.stored]));
  const typeOf = new Map(asm.assertions.map((a) => [a.anchorId, a.assertionType]));
  const out: AnchorView[] = [];
  for (const a of asm.anchors) {
    const rules = cited.get(a.id);
    if (!rules) continue;
    const rec = stored.get(a.recordId);
    out.push({
      ...a,
      sourceId: rec?.sourceId ?? "unknown",
      sourceLabel: rec ? `${rec.kind.replace(/-/g, " ")} ${rec.id.split(":").slice(-1)[0]?.slice(0, 40) ?? ""}`.trim() : "unknown record",
      retrievedAt: rec?.retrievedAt ?? ctx.run.finishedAt,
      ...(rec?.sourcePublishedAt ? { sourcePublishedAt: rec.sourcePublishedAt } : {}),
      assertionType: typeOf.get(a.id) ?? "study",
      ruleIds: [...rules].sort(),
    });
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function linkViews(ctx: ViewContext): LinkView[] {
  return (ctx.run.wb.links?.links ?? []).map((l) => ({ ...l.link, fromLabel: l.fromLabel, toLabel: l.toLabel, candidateClass: l.candidateClass }));
}

export function missingEvidence(ctx: ViewContext): MissingEvidenceItem[] {
  const findings = currentFindings(ctx);
  const byClaim = new Map(ctx.run.results.map((r) => [r.finding.claimId, r.compiled]));
  const drafts = new Map<string, string>();
  const out: MissingEvidenceItem[] = [];
  for (const m of missingEvidenceList(findings)) {
    const f = findings.find((x) => x.id === m.findingId)!;
    const claim = byClaim.get(f.claimId);
    if (!drafts.has(f.id) && claim) {
      const letter = draftEvidenceRequest(f, claim, { sender: "(reviewer)" });
      drafts.set(f.id, letter ? [NOT_SENT_NOTICE, "", letter.body].join("\n") : "");
    }
    out.push({ findingId: m.findingId, dimension: m.dimension, request: m.request, draft: drafts.get(f.id) ?? m.request });
  }
  // An unsettled candidate link is a question the reviewer has to answer, and the product cannot answer it.
  const head = ctx.run.results[0];
  if (head) {
    for (const l of ctx.run.wb.links?.links ?? []) {
      if ((l.link.state !== "CANDIDATE" && l.link.state !== "AMBIGUOUS") || l.link.type !== "STUDY_EVALUATES") continue;
      const flag = l.link.flags.find((x) => /^version-differs/.test(x));
      if (!flag && l.candidateClass === "WEAK_NAME_ONLY") continue;
      const request = `Confirm or reject the link between ${l.fromLabel} and ${l.toLabel}. ${flag ? flag.replace(/^version-differs: /, "The release differs: ") : "It matches by name and text but no identifier connects them"}. Until a reviewer decides, its results are not counted.`;
      out.push({ findingId: head.finding.id, dimension: flag ? "version" : "product", request, draft: [NOT_SENT_NOTICE, "", request].join("\n") });
    }
  }
  return out;
}

export function timeline(ctx: ViewContext, asOf?: string): TimelineEvent[] {
  const run = ctx.run;
  const asm = run.wb.assembled;
  const events: TimelineEvent[] = [];
  const dependents = (factId: string): string[] => run.results.filter((r) => r.finding.dependsOnFacts.includes(factId)).map((r) => r.finding.id);
  const cited = new Set<string>();
  for (const r of run.results) for (const a of r.finding.mechanicalCoverage) a.anchorIds.forEach((id) => cited.add(id));
  const dateIso = (d: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d);
  for (const f of run.wb.world.facts) {
    const isDate = f.validFrom !== undefined;
    const isPolicy = f.sourceId === "hospital-policy";
    if (!(isDate || isPolicy || (f.anchorId && cited.has(f.anchorId)))) continue;
    const ids = dependents(f.factId);
    if (ids.length === 0 && !isDate) continue;
    events.push({
      at: f.validFrom ? dateIso(f.validFrom) : f.recordedAt,
      kind: "fact_asserted",
      summary: brief(`${f.predicate} = ${typeof f.value === "string" ? f.value : JSON.stringify(f.value)} (${f.sourceId})`, 200),
      factIds: [f.factId],
      findingIds: ids,
    });
  }
  for (const l of run.wb.links?.links ?? []) {
    if (l.link.state !== "CONFIRMED") continue;
    events.push({ at: l.link.decidedAt ?? run.finishedAt, kind: "link_confirmed", summary: brief(`${l.link.type}: ${l.fromLabel} -> ${l.toLabel}${l.derived ? " (derived)" : ""}`, 200), factIds: [], findingIds: [] });
  }
  for (const h of run.history) events.push({ at: run.finishedAt, kind: "finding_recomputed", summary: brief(`${h.kind}: ${h.reason}`, 200), factIds: [], findingIds: [h.newer.id] });
  for (const d of ctx.decisions) events.push({ at: d.at, kind: "decision", summary: `${d.reviewer}: ${d.action}${d.note ? ` (${brief(d.note, 80)})` : ""}`, factIds: [], findingIds: [d.findingId] });
  for (const id of ctx.stale) events.push({ at: run.finishedAt, kind: "finding_stale", summary: "a fact this finding relied on changed", factIds: [], findingIds: [id] });
  void asm;
  const cutoff = asOf ? `${asOf}T23:59:59.999Z` : undefined;
  return events.filter((e) => cutoff === undefined || e.at <= cutoff).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.summary < b.summary ? -1 : 1));
}

export function sourceRows(ctx: ViewContext): SourceRow[] {
  const wb = ctx.run.wb;
  const rows: SourceRow[] = [];
  for (const [id, connector] of wb.env.connectors) {
    const outcomes = wb.outcomes.filter((o) => o.step.source === id);
    const failure = wb.failures.find((f) => f.source === id);
    const ok = [...outcomes].reverse().find((o) => o.status === "OK");
    const empty = outcomes.find((o) => o.status === "EMPTY");
    const health: SourceRow["source"]["health"] = failure ? (["UNAVAILABLE", "FORBIDDEN", "DRIFTED", "BLOCKED"].includes(failure.status) ? (failure.status as never) : "UNAVAILABLE") : outcomes.length === 0 ? "STALE" : empty && !ok ? "EMPTY" : "OK";
    const day = (ok ?? empty)?.records[0]?.retrievedAt?.slice(0, 10) ?? ctx.run.finishedAt.slice(0, 10);
    rows.push({
      source: {
        id,
        kind: (["regulator", "registry", "literature", "vendor", "hospital"].includes(connector.card.kind) ? connector.card.kind : "other") as never,
        access: "connector",
        descriptor: `${id}: ${assertionTypesOf(id).join(", ") || "reference"} records`,
        license: connector.card.license,
        health,
        ...(ok?.records[0]?.retrievedAt ? { lastSuccessAt: ok.records[0].retrievedAt } : {}),
        dataClass: connector.card.dataClass,
      },
      healthDetail: failure ? `${failure.status}: ${failure.detail}` : outcomes.length === 0 ? "not used by this case" : empty && !ok ? `answered, no rows found on ${day}; that says nothing about whether any exist` : `answered ${outcomes.filter((o) => o.status === "OK").length} read(s); last on ${day}`,
      authorityNotes: connector.card.kind === "regulator" ? "authoritative for what use was authorized" : connector.card.kind === "registry" ? "authoritative that a study exists and what it registered, not for its results" : "authoritative for what a paper reported, not for the product's authorization",
    });
  }
  rows.push({
    source: {
      id: "hospital-policy",
      kind: "hospital",
      access: "zetaris",
      descriptor: "Hospital review database: requirements and precedents (constructed)",
      license: "constructed for this demonstration",
      health: wb.federation.status === "ok" ? "OK" : "UNAVAILABLE",
      ...(wb.federation.reads[0] ? { lastSuccessAt: wb.federation.reads[0].at } : {}),
      dataClass: "public",
    },
    healthDetail: wb.federation.status === "ok" ? `answered through ${wb.federation.reads[0]?.result.servedFrom}; ${wb.federation.requirements.length} requirements, ${wb.federation.precedents.length} precedents` : `${wb.federation.failure?.failure ?? "UNAVAILABLE"}: ${wb.federation.failure?.message ?? "no federation engine"}`,
    zetarisName: "hospital.requirements, hospital.precedents, hospital.cases",
    ...(wb.federation.reads[0] ? { rowCount: wb.federation.reads[0].result.rows.length } : {}),
    authorityNotes: "authoritative for what this hospital requires; says nothing about what a product has shown",
  });
  return rows;
}

export function summaryOf(ctx: ViewContext): CaseSummary {
  const run = ctx.run;
  const findings = currentFindings(ctx);
  const head = findings[0];
  const open = findings.filter((f) => f.label !== "SUPPORTED_FOR_SCOPE" && f.reviewerState === "unreviewed").length;
  const links = (run.wb.links?.links ?? []).filter((l) => (l.link.state === "CANDIDATE" || l.link.state === "AMBIGUOUS") && l.link.type === "STUDY_EVALUATES" && (l.link.flags.some((x) => /^version-differs/.test(x)) || l.candidateClass !== "WEAK_NAME_ONLY")).length;
  const states = new Set(findings.map((f) => f.reviewerState));
  return {
    id: run.spec.id,
    title: run.spec.title,
    productLabel: run.spec.productLabel,
    claimConstructed: true,
    ...(head ? { headlineLabel: head.label } : {}),
    openQuestions: open + links,
    staleFindings: findings.filter((f) => ctx.stale.has(f.id)).length,
    reviewerState: states.size === 1 && head ? head.reviewerState : [...states].filter((s) => s !== "unreviewed").join(", ") || "unreviewed",
    updatedAt: run.finishedAt,
  };
}

export function detailOf(ctx: ViewContext): CaseDetail {
  const run = ctx.run;
  const head = run.results[0]!;
  const asm = run.wb.assembled!;
  void asm;
  const firstMatrix = run.wb.federation.reads[0];
  return {
    summary: summaryOf(ctx),
    claim: head.compiled,
    claimText: run.spec.intended.text,
    findings: currentFindings(ctx),
    dimensions: dimensionViews(ctx),
    anchors: anchorViews(ctx),
    links: linkViews(ctx),
    ...(firstMatrix ? { matrix: matrixView(firstMatrix) } : {}),
    timeline: timeline(ctx),
    missingEvidence: missingEvidence(ctx),
    sources: sourceRows(ctx),
    mode: ctx.mode,
  };
}
