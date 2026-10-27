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
import type { Workbench } from "./workbench.ts";
import type { Finding } from "../schemas/index.ts";
import { DIMENSIONS } from "../schemas/index.ts";
import type { ExtractedRecord } from "./evidence.ts";
import { chainOf, supersessionReason, type ArchivedChain } from "./history.ts";
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
  /** Findings a later run replaced after a reviewer decided on them. */
  archive: ArchivedChain[];
}

/** What a reader calls a stored record, from the identifier it carries rather than the id the store gave it. */
export function recordLabel(e: ExtractedRecord, submission: string): string {
  switch (e.stored.kind) {
    case "ctgov-study":
      return `ClinicalTrials.gov ${e.study?.nctId ?? "registry record"}`;
    case "pubmed-article":
      return e.article?.pmid ? `PubMed article ${e.article.pmid}` : "PubMed article";
    case "fda-summary":
      return `FDA decision summary ${submission}`;
    case "openfda-510k":
      return `openFDA 510(k) record ${submission}`;
    case "openfda-udi":
      return "openFDA device identifier record";
  }
}

/** The label of the record each evidence item was built from. */
export function evidenceLabels(wb: Workbench): Map<string, string> {
  const out = new Map<string, string>();
  const byRecord = new Map([...wb.extracted.values()].map((e) => [e.stored.id, recordLabel(e, wb.spec.submission)]));
  for (const [itemId, recordId] of wb.assembled?.itemRecord ?? []) out.set(itemId, byRecord.get(recordId) ?? "a stored record");
  return out;
}

const EVIDENCE_ID = /\bev-[a-z0-9]+(?:-[a-z0-9]+)+\b/g;

/** A sentence with each evidence item id in it replaced by the record the item was built from. */
export function readableText(text: string, labels: ReadonlyMap<string, string>): string {
  return text.replace(EVIDENCE_ID, (id) => labels.get(id) ?? "a stored record");
}

/**
 * The compiler writes a result it found as "<evidence item id>: sensitivity 0.951", once per reported figure. A reviewer reads the
 * record, not the id, and a figure reported twice is one figure. The finding in the dossier keeps the compiler's text unchanged.
 */
export function readableEstablished(text: string | undefined, labels: ReadonlyMap<string, string>): string | undefined {
  if (text === undefined || !new RegExp(EVIDENCE_ID.source).test(text)) return text;
  const grouped = new Map<string, string[]>();
  const plain: string[] = [];
  for (const part of text.split("; ")) {
    const m = /^(ev-[a-z0-9]+(?:-[a-z0-9]+)+): (.*)$/.exec(part);
    if (!m) {
      plain.push(readableText(part, labels));
      continue;
    }
    const label = labels.get(m[1]!) ?? "a stored record";
    const list = grouped.get(label) ?? [];
    if (!list.includes(m[2]!)) list.push(m[2]!);
    grouped.set(label, list);
  }
  return [...plain, ...[...grouped].map(([label, figures]) => `${label}: ${figures.join(", ")}`)].join("; ");
}

function readableFinding(f: Finding, labels: ReadonlyMap<string, string>): Finding {
  return {
    ...f,
    expertReviewFlags: f.expertReviewFlags.map((x) => ({ ...x, reason: readableText(x.reason, labels) })),
    requiredEvidence: f.requiredEvidence.map((x) => ({ ...x, request: readableText(x.request, labels) })),
    degraded: f.degraded.map((x) => ({ ...x, reason: readableText(x.reason, labels) })),
    mechanicalCoverage: f.mechanicalCoverage.map((a) => {
      const established = readableEstablished(a.established, labels);
      return established === a.established ? a : { ...a, ...(established !== undefined ? { established } : {}) };
    }),
    mismatches: f.mismatches.map((m) => {
      const established = readableEstablished(m.established, labels);
      return established === m.established ? m : { ...m, ...(established !== undefined ? { established } : {}) };
    }),
  };
}

const REVIEW_STATE: Record<string, Finding["reviewerState"]> = {
  unreviewed: "unreviewed",
  accepted: "accepted",
  narrowed: "narrowed",
  evidence_requested: "evidence_requested",
  escalated: "escalated",
};

/** A finding as a reader is shown it: the compiler's text with evidence ids replaced by the record they stand for. */
export function humanizeFinding(run: InvestigationResult, f: Finding): Finding {
  return readableFinding(f, evidenceLabels(run.wb));
}

export function currentFindings(ctx: ViewContext): Finding[] {
  const labels = evidenceLabels(ctx.run.wb);
  return ctx.run.results.map((r) => ({ ...readableFinding(r.finding, labels), reviewerState: REVIEW_STATE[reviewStateOf(ctx.decisions, r.finding.id)] ?? "unreviewed" }));
}

export function dimensionViews(ctx: ViewContext): Record<string, DimensionView[]> {
  const out: Record<string, DimensionView[]> = {};
  const labels = evidenceLabels(ctx.run.wb);
  for (const r of ctx.run.results) {
    const reasons = new Map(r.detail.reasons.map((x) => [x.dimension, x]));
    const shown = readableFinding(r.finding, labels);
    out[r.finding.id] = DIMENSIONS.map((d) => {
      const a = shown.mechanicalCoverage.find((x) => x.dimension === d);
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
  const extractedOf = new Map([...wb.extracted.values()].map((e) => [e.stored.id, recordLabel(e, ctx.run.spec.submission)]));
  const typeOf = new Map(asm.assertions.map((a) => [a.anchorId, a.assertionType]));
  const out: AnchorView[] = [];
  for (const a of asm.anchors) {
    const rules = cited.get(a.id);
    if (!rules) continue;
    const rec = stored.get(a.recordId);
    out.push({
      ...a,
      sourceId: rec?.sourceId ?? "unknown",
      sourceLabel: extractedOf.get(a.recordId) ?? "unknown record",
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
  // A finding a reviewer decided on that a later run replaced: both stay, and the reason is on the record.
  for (const chain of ctx.archive) {
    const now = run.results.find((r) => r.claim.id === chain.claimId)?.finding;
    const last = chain.members[chain.members.length - 1];
    if (!now || !last) continue;
    events.push({ at: run.finishedAt, kind: "finding_recomputed", summary: brief(`The finding for ${chain.claimId} that a reviewer had decided on was replaced by a new one. ${supersessionReason(last.finding, now)}`, 400), factIds: [], findingIds: [last.finding.id, now.id] });
  }
  for (const d of ctx.decisions) events.push({ at: d.at, kind: "decision", summary: `${d.reviewer}: ${d.action}${d.note ? ` (${brief(d.note, 80)})` : ""}`, factIds: [], findingIds: [d.findingId] });
  for (const id of ctx.stale) events.push({ at: run.finishedAt, kind: "finding_stale", summary: "a fact this finding relied on changed", factIds: [], findingIds: [id] });
  void asm;
  const cutoff = asOf ? `${asOf}T23:59:59.999Z` : undefined;
  return events.filter((e) => cutoff === undefined || e.at <= cutoff).sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.summary < b.summary ? -1 : 1));
}

/**
 * The rows of the Source Console as one case's last run saw them. Health is what the run observed: a source that answered is OK, one
 * that answered with nothing is EMPTY, one that failed carries its failure. STALE is kept for a source whose last successful read is
 * older than the cadence its card declares. A source this case did not read has no observation of its own and is not shown as
 * out of date; it says it was not read.
 */
export function sourceRows(ctx: ViewContext, now: Date = new Date(ctx.run.finishedAt)): SourceRow[] {
  return rowsOf(ctx, now).map((r) => r.row);
}

interface ObservedRow {
  row: SourceRow;
  /** The run read this source (it answered, was empty, or failed). */
  read: boolean;
}

function rowsOf(ctx: ViewContext, now: Date): ObservedRow[] {
  const wb = ctx.run.wb;
  const rows: ObservedRow[] = [];
  for (const [id, connector] of wb.env.connectors) {
    const outcomes = wb.outcomes.filter((o) => o.step.source === id);
    const failure = wb.failures.find((f) => f.source === id);
    const ok = [...outcomes].reverse().find((o) => o.status === "OK");
    const empty = outcomes.find((o) => o.status === "EMPTY");
    // The decision summaries are read through the document provider, not through a connector step, so the run's record of them is the summary.
    const viaDocuments = id === "fda-accessdata-pdf";
    const read = viaDocuments ? wb.summary !== undefined || wb.documentFailure !== undefined : outcomes.length > 0;
    const lastRead = viaDocuments ? wb.summary?.stored.retrievedAt : (ok ?? empty)?.records[0]?.retrievedAt;
    const cadenceMs = connector.card.cadenceHours ? connector.card.cadenceHours * 3_600_000 : undefined;
    const answered = viaDocuments ? wb.summary !== undefined : ok !== undefined;
    const older = cadenceMs !== undefined && answered && lastRead !== undefined && now.getTime() - Date.parse(lastRead) > cadenceMs;
    let health: SourceRow["source"]["health"] = "OK";
    if (failure) health = (["UNAVAILABLE", "FORBIDDEN", "DRIFTED", "BLOCKED"].includes(failure.status) ? failure.status : "UNAVAILABLE") as SourceRow["source"]["health"];
    else if (!viaDocuments && empty && !ok) health = "EMPTY";
    else if (older) health = "STALE";
    const day = lastRead?.slice(0, 10) ?? ctx.run.finishedAt.slice(0, 10);
    const detail = failure
      ? `${failure.status}: ${failure.detail}`
      : !read
        ? "not read by this case; no failure has been seen for it"
        : !viaDocuments && empty && !ok
          ? `answered, no rows found on ${day}; that says nothing about whether any exist`
          : older
            ? `last read on ${day}; its card expects a refresh every ${connector.card.cadenceHours} hours, so this snapshot is out of date`
            : viaDocuments
              ? `read the decision summary on ${day}`
              : `answered ${outcomes.filter((o) => o.status === "OK").length} read(s); last on ${day}`;
    rows.push({
      read,
      row: {
        source: {
          id,
          kind: (["regulator", "registry", "literature", "vendor", "hospital"].includes(connector.card.kind) ? connector.card.kind : "other") as never,
          access: "connector",
          descriptor: `${id}: ${assertionTypesOf(id).join(", ") || "reference"} records`,
          license: connector.card.license,
          health,
          ...(viaDocuments ? (wb.summary ? { lastSuccessAt: wb.summary.stored.retrievedAt } : {}) : ok?.records[0]?.retrievedAt ? { lastSuccessAt: ok.records[0].retrievedAt } : {}),
          dataClass: connector.card.dataClass,
        },
        healthDetail: detail,
        authorityNotes: connector.card.kind === "regulator" ? "authoritative for what use was authorized" : connector.card.kind === "registry" ? "authoritative that a study exists and what it registered, not for its results" : "authoritative for what a paper reported, not for the product's authorization",
      },
    });
  }
  const policy = policyRow(ctx);
  rows.push({ read: true, row: policy });
  return rows;
}

const HEALTH_RANK: Record<SourceRow["source"]["health"], number> = { OK: 0, STALE: 1, EMPTY: 2, DRIFTED: 3, BLOCKED: 4, FORBIDDEN: 5, UNAVAILABLE: 6 };

/** The Source Console across every case investigated so far: each source as the worst observation of it, or as unread. */
export function sourceRowsAcross(ctxs: ViewContext[], now: Date): SourceRow[] {
  const perCase = ctxs.map((c) => rowsOf(c, now));
  const first = perCase[0];
  if (!first) return [];
  return first.map((_, i) => {
    const candidates = perCase.map((rows) => rows[i]!).filter((r) => r.read);
    if (candidates.length === 0) {
      const row = first[i]!.row;
      return { ...row, healthDetail: "not read by any case investigated so far; no failure has been seen for it", observed: false };
    }
    return candidates.reduce((worst, r) => (HEALTH_RANK[r.row.source.health] > HEALTH_RANK[worst.row.source.health] ? r : worst)).row;
  });
}

function policyRow(ctx: ViewContext): SourceRow {
  const wb = ctx.run.wb;
  return {
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
  };
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
    claims: run.results.map((r) => r.compiled),
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
