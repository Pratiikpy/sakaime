/**
 * The Resolver's mechanism: which stored records describe the same submission, study and release.
 *
 * Records are turned into identity records (extracted features, not raw payloads) and every pair that a link type can
 * carry is resolved by the identity layer: exact identifier first, then the explainable score with its corroboration
 * gate. A model may annotate a pair in the uncertain band; it cannot change a state. A reviewer decision is the only
 * other way to CONFIRMED.
 *
 * Only a CONFIRMED link lets a record's results count as evidence for the product. CANDIDATE and AMBIGUOUS links are
 * kept and shown, with the flags that say what differs (a version, a purpose, an owner), but the compiler never sees
 * them. A publication reaches the product through the study it reports when both hops are confirmed by identifiers; that
 * chain is written down as a derived link with its basis.
 */
import {
  DEFAULT_MODEL,
  linkId,
  resolveLink,
  type AdjudicateHook,
  type IdentityRecordInput,
  parseRecord,
  type LinkResolution,
  type ReviewLedger,
} from "../identity/index.ts";
import { PortError } from "../ports/index.ts";
import type { Link, LinkState, LinkType } from "../schemas/index.ts";
import { LinkSchema } from "../schemas/index.ts";
import type { CaseSpec } from "./cases.ts";
import type { ExtractedRecord } from "./evidence.ts";
import { versionsStated } from "./evidence.ts";
import { brief } from "./util.ts";

export type CandidateClassView = "EXACT_IDENTIFIER" | "STRONG_TEXT" | "WEAK_NAME_ONLY" | "NONE";

export interface ResolvedLink {
  link: Link;
  fromLabel: string;
  toLabel: string;
  candidateClass: CandidateClassView;
  /** Plain-language reasons from the resolver. */
  reasons: string[];
  /** The model's proposal, if one was asked for and accepted as well formed. Never a state change. */
  modelNote?: string;
  derived: boolean;
}

export interface LinkInputs {
  spec: CaseSpec;
  clearance?: ExtractedRecord;
  summary?: ExtractedRecord;
  udi: ExtractedRecord[];
  studies: ExtractedRecord[];
  publications: ExtractedRecord[];
}

export interface ResolvedLinks {
  links: ResolvedLink[];
  /** Records whose results may count as evidence for the product: the link that admits them is CONFIRMED. */
  admitted: Map<string, { linkId: string; basis: string[] }>;
  records: IdentityRecordInput[];
}

const CLASS_MAP: Record<string, CandidateClassView> = {
  "EXACT-IDENTIFIER": "EXACT_IDENTIFIER",
  "STRONG-TEXT": "STRONG_TEXT",
  "WEAK-NAME-ONLY": "WEAK_NAME_ONLY",
  NONE: "NONE",
};

const idOf = {
  submission: (n: string) => `510k:${n}`,
  gudid: (di: string) => `gudid:${di}`,
  study: (nct: string) => `ctgov:${nct}`,
  publication: (pmid: string) => `pubmed:${pmid}`,
};

const clip = (s: string | undefined, n: number): string | undefined => (s === undefined ? undefined : s.length <= n ? s : s.slice(0, n));

function anchorsOf(ex: ExtractedRecord | undefined, predicate: string): { value: string; text: string }[] {
  if (!ex) return [];
  return ex.kept.filter((k) => k.assertion.predicate === predicate && k.assertion.quoteVerified).map((k) => ({ value: String(k.assertion.value), text: k.anchor.text }));
}

export function submissionRecord(spec: CaseSpec, clearance: ExtractedRecord | undefined, summary: ExtractedRecord | undefined): IdentityRecordInput {
  const c = clearance?.clearances?.find((x) => x.number === spec.submission) ?? clearance?.clearances?.[0];
  const versions = versionsStated(summary?.kept ?? []);
  const purposes = [...new Set(anchorsOf(summary, "indication.purpose_term").map((a) => a.value))];
  const mentions = anchorsOf(summary, "document.cites_nct").map((a) => ({ type: "nct" as const, value: a.value, channel: "text" as const, context: clip(a.text, 1200)! }));
  return {
    id: idOf.submission(spec.submission),
    kind: "AuthorizationSubmission",
    source: clearance?.stored.sourceId ?? "fda-accessdata-pdf",
    name: c?.deviceName ?? spec.product.name,
    manufacturer: c?.applicant ?? spec.vendor.name,
    ...(c?.productCode ? { productCode: c.productCode } : {}),
    ...(c?.decisionDate && /^\d{4}-\d{2}-\d{2}$/.test(c.decisionDate) ? { date: c.decisionDate } : {}),
    ...(versions.length === 1 ? { version: versions[0]! } : {}),
    purposeTags: purposes,
    ids: { submission: [spec.submission] },
    mentions,
  };
}

export function gudidRecords(spec: CaseSpec, udi: ExtractedRecord[]): IdentityRecordInput[] {
  const out: IdentityRecordInput[] = [];
  for (const ex of udi) {
    for (const d of ex.udi ?? []) {
      if (!d.primaryDi) continue;
      out.push({
        id: idOf.gudid(d.primaryDi),
        kind: "SoftwareRelease",
        source: ex.stored.sourceId,
        ...(d.brandName ? { name: d.brandName } : {}),
        ...(d.companyName ? { manufacturer: d.companyName } : {}),
        ...(d.versionOrModel ? { version: d.versionOrModel } : {}),
        ...(d.productCodes[0] ? { productCode: d.productCodes[0] } : {}),
        ids: { submission: d.premarketSubmissions.map((s) => s.number), udiDi: [d.primaryDi] },
      });
    }
  }
  return out.filter((r, i, all) => all.findIndex((x) => x.id === r.id) === i && (r.ids?.submission ?? []).includes(spec.submission));
}

export function studyRecord(ex: ExtractedRecord): IdentityRecordInput | undefined {
  const s = ex.study;
  if (!s) return undefined;
  const mentions = [
    ...s.submissionsMentioned.map((value) => ({ type: "submission" as const, value, channel: "text" as const })),
    ...s.references.filter((r) => r.pmid).map((r) => ({ type: "pmid" as const, value: r.pmid!, channel: "field" as const, role: /RESULT/i.test(r.type ?? "") ? ("report" as const) : ("background" as const) })),
  ];
  return {
    id: idOf.study(s.nctId),
    kind: "Study",
    source: ex.stored.sourceId,
    ...(s.title ? { name: s.title } : {}),
    aliases: s.interventions.slice(0, 20),
    ...(s.sponsor ? { sponsor: s.sponsor, manufacturer: s.sponsor } : {}),
    ...(s.enrollment ? { enrollment: s.enrollment.count } : {}),
    ...(s.startDate && /^\d{4}(-\d{2}(-\d{2})?)?$/.test(s.startDate) ? { date: s.startDate } : {}),
    ...(ex.studyText || s.interventions.length ? { text: clip(`${s.title ?? ""}. ${ex.studyText ?? s.interventions.join(". ")}`, 4000)! } : {}),
    ids: { nct: [s.nctId] },
    mentions,
  };
}

export function publicationRecord(ex: ExtractedRecord): IdentityRecordInput | undefined {
  const a = ex.article;
  if (!a) return undefined;
  const databank = new Set(ex.kept.filter((k) => k.assertion.predicate === "document.cites_nct" && (k.detail.qualifiers ?? []).includes("databank")).map((k) => String(k.assertion.value)));
  const mentions = anchorsOf(ex, "document.cites_nct").map((m) =>
    databank.has(m.value) ? { type: "nct" as const, value: m.value, channel: "field" as const } : { type: "nct" as const, value: m.value, channel: "text" as const, context: clip(m.text, 1200)! },
  );
  const text = [a.title, ...a.abstractSections.map((s) => s.text)].filter(Boolean).join(" ");
  const version = versionsStated(ex.kept.filter((k) => k.assertion.subjectId.startsWith("pub:")))[0];
  return {
    id: idOf.publication(a.pmid),
    kind: "Publication",
    source: ex.stored.sourceId,
    ...(a.title ? { name: a.title } : {}),
    text: clip(text, 20000) ?? "",
    ...(a.year ? { date: String(a.year) } : {}),
    ...(version ? { version } : {}),
    ids: { pmid: [a.pmid], ...(a.doi ? { doi: [a.doi] } : {}) },
    mentions,
  };
}

// ---------------------------------------------------------------- resolution

function labelOf(r: IdentityRecordInput): string {
  const name = r.name ? brief(r.name, 70) : r.id;
  switch (r.kind) {
    case "AuthorizationSubmission":
      return `FDA ${r.ids?.submission?.[0] ?? ""} (${name})`.trim();
    case "SoftwareRelease":
      return `GUDID release${r.version ? ` ${r.version}` : ""} of ${name}`;
    case "Study":
    case "RegistryEntry":
      return `ClinicalTrials.gov ${r.ids?.nct?.[0] ?? ""}: ${name}`;
    case "Publication":
      return `PubMed ${r.ids?.pmid?.[0] ?? ""}: ${name}`;
    default:
      return name;
  }
}

function toResolved(res: LinkResolution, from: IdentityRecordInput, to: IdentityRecordInput): ResolvedLink | undefined {
  if (!res.link) return undefined;
  const note = res.modelProposal
    ? res.modelProposal.accepted
      ? `model proposal ${res.modelProposal.verdict}: ${brief(res.modelProposal.rationale, 200)} (unverified; the state is unchanged)`
      : `model proposal rejected: ${res.modelProposal.rejection ?? "invalid"}`
    : undefined;
  return {
    link: res.link,
    fromLabel: labelOf(from),
    toLabel: labelOf(to),
    candidateClass: CLASS_MAP[res.candidateClass] ?? "NONE",
    reasons: res.reasons,
    ...(note ? { modelNote: note } : {}),
    derived: false,
  };
}

export interface ResolveOptions {
  adjudicate?: AdjudicateHook;
  ledger?: ReviewLedger;
}

export async function resolveCaseLinks(inputs: LinkInputs, options: ResolveOptions = {}): Promise<ResolvedLinks> {
  const sub = submissionRecord(inputs.spec, inputs.clearance, inputs.summary);
  const gudids = gudidRecords(inputs.spec, inputs.udi);
  const studies = inputs.studies.map(studyRecord).filter((r): r is IdentityRecordInput => r !== undefined);
  const pubs = inputs.publications.map(publicationRecord).filter((r): r is IdentityRecordInput => r !== undefined);
  const known = [sub, ...gudids, ...studies, ...pubs];
  const parsedKnown = known.map((r) => parseRecord(r));

  const results: ResolvedLink[] = [];
  const resolve = async (a: IdentityRecordInput, b: IdentityRecordInput, type: LinkType): Promise<void> => {
    let res: LinkResolution;
    try {
      res = await resolveLink(a, b, type, { model: DEFAULT_MODEL, knownRecords: parsedKnown, ...(options.adjudicate ? { adjudicate: options.adjudicate } : {}) });
    } catch (error) {
      // A pair the link type cannot carry is not a link. Anything else is a defect and must not be hidden.
      if (error instanceof PortError && error.failure === "INVALID") return;
      throw error;
    }
    const r = toResolved(res, a, b);
    if (r) results.push(r);
  };

  for (const g of gudids) {
    await resolve(g, sub, "SAME_SUBMISSION");
    await resolve(g, sub, "SAME_MARKETED_VERSION");
  }
  for (const s of studies) await resolve(s, sub, "STUDY_EVALUATES");
  for (const p of pubs) {
    await resolve(p, sub, "STUDY_EVALUATES");
    for (const s of studies) await resolve(p, s, "PUBLICATION_REPORTS");
  }

  // A reviewer's earlier decisions override the resolver's state.
  const withLedger = options.ledger ? results.map((r) => ({ ...r, link: options.ledger!.apply(r.link) })) : results;

  // Chain: a publication that reports a study that evaluates the product evaluates the product, when both hops are confirmed.
  const confirmed = (type: LinkType, from: string, to: string): ResolvedLink | undefined =>
    withLedger.find((r) => r.link.type === type && r.link.from === from && r.link.to === to && r.link.state === "CONFIRMED");
  const derived: ResolvedLink[] = [];
  for (const p of pubs) {
    for (const s of studies) {
      const hop1 = confirmed("PUBLICATION_REPORTS", p.id, s.id);
      const hop2 = confirmed("STUDY_EVALUATES", s.id, sub.id);
      const direct = withLedger.find((r) => r.link.type === "STUDY_EVALUATES" && r.link.from === p.id && r.link.to === sub.id);
      if (!hop1 || !hop2 || direct?.link.state === "CONFIRMED" || direct?.link.state === "REJECTED") continue;
      const link = LinkSchema.parse({
        id: linkId("STUDY_EVALUATES", p.id, sub.id),
        type: "STUDY_EVALUATES",
        from: p.id,
        to: sub.id,
        state: "CONFIRMED",
        basis: [`derived by chaining two confirmed links: ${hop1.link.id} (${hop1.link.basis.join("; ")}) and ${hop2.link.id} (${hop2.link.basis.join("; ")})`],
        flags: [...new Set([...(direct?.link.flags ?? []), "derived-by-chain: the identifiers connect the paper to the product through the registry study; the release it evaluated is read from the paper's own text"])],
      });
      derived.push({ link, fromLabel: labelOf(p), toLabel: labelOf(sub), candidateClass: "EXACT_IDENTIFIER", reasons: ["both hops are confirmed by identifiers"], derived: true });
    }
  }
  const all = [...withLedger.filter((r) => !derived.some((d) => d.link.id === r.link.id)), ...derived];

  const admitted = new Map<string, { linkId: string; basis: string[] }>();
  for (const r of all) {
    if (r.link.type !== "STUDY_EVALUATES" || r.link.state !== "CONFIRMED" || r.link.to !== sub.id) continue;
    admitted.set(r.link.from, { linkId: r.link.id, basis: r.link.basis });
  }
  return { links: all.sort((a, b) => (a.link.id < b.link.id ? -1 : 1)), admitted, records: known };
}

export const IDENTITY_ID = idOf;

export type { LinkState };
