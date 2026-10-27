/**
 * Link resolution: the order of evidence for one pair and one link type.
 *
 *   1. an exact identifier appropriate to the link type (exact.ts)
 *   2. otherwise the explainable Fellegi-Sunter score with a corroboration gate (scorer.ts)
 *   3. optionally a model proposal, inside the uncertain band only, which can annotate but never change a state
 *   4. a reviewer decision (review.ts), the only other way to CONFIRMED
 *
 * Invariants, each covered by a test:
 *   - CONFIRMED comes only from an exact identifier or a reviewer.
 *   - The uncertain band yields CANDIDATE or AMBIGUOUS, never CONFIRMED, and AMBIGUOUS where corroboration is missing.
 *   - A model proposal cannot alter the state in either direction.
 *   - Flags never change the state.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { PortError } from "../ports/index.ts";
import { LinkSchema, LinkTypeSchema, type Link, type LinkState, type LinkType } from "../schemas/index.ts";
import { compareRecords, type CompareContext } from "./compare.ts";
import { exactEvidence, orient, type ExactVerdict } from "./exact.ts";
import { mismatchFlags } from "./flags.ts";
import { foldText, type AliasGroup } from "./normalize.ts";
import { corroboration, scoreOutcomes, type GateResult, type PairScore, type ScorerModel } from "./scorer.ts";
import {
  parseRecord,
  type CandidateClass,
  type ComparisonOutcome,
  type IdentityRecord,
  type IdentityRecordInput,
  type Presentation,
} from "./types.ts";

// ------------------------------------------------------------------------------------------ model proposals

const CITABLE_FIELDS = ["name", "aliases", "text", "manufacturer", "sponsor", "productCode", "version", "module", "purposeTags", "date", "enrollment"] as const;
export type CitableField = (typeof CITABLE_FIELDS)[number];

const CitationSchema = z.object({ record: z.enum(["from", "to"]), field: z.enum(CITABLE_FIELDS), quote: z.string().min(1).max(400) }).strict();
export const ProposalSchema = z
  .object({
    verdict: z.enum(["SAME", "DIFFERENT", "UNSURE"]),
    citations: z.array(CitationSchema).min(1).max(12),
    rationale: z.string().max(2000),
  })
  .strict();
export type Proposal = z.infer<typeof ProposalSchema>;

export interface AdjudicationRequest {
  linkType: LinkType;
  /** The records in link direction. */
  from: IdentityRecord;
  to: IdentityRecord;
  weight: number;
  waterfall: PairScore["waterfall"];
  /** Fields a citation may name. */
  citableFields: readonly CitableField[];
}

/** A model call supplied by the caller. It may propose; it cannot decide. */
export type AdjudicateHook = (request: AdjudicationRequest) => Promise<unknown>;

export interface ModelProposalRecord {
  verdict: Proposal["verdict"] | "INVALID";
  accepted: boolean;
  rationale: string;
  citations: Proposal["citations"];
  rejection?: string;
}

function fieldText(record: IdentityRecord, field: CitableField): string {
  switch (field) {
    case "aliases":
      return record.aliases.join(" | ");
    case "purposeTags":
      return record.purposeTags.join(" | ");
    case "enrollment":
      return record.enrollment === undefined ? "" : String(record.enrollment);
    default:
      return String(record[field] ?? "");
  }
}

/** A proposal is usable only if it has a recognised shape and every quoted passage really occurs in the field it names. */
export function validateProposal(raw: unknown, from: IdentityRecord, to: IdentityRecord): ModelProposalRecord {
  const parsed = ProposalSchema.safeParse(raw);
  if (!parsed.success) {
    return { verdict: "INVALID", accepted: false, rationale: "", citations: [], rejection: `malformed proposal: ${parsed.error.issues[0]?.message ?? "unknown"}` };
  }
  const p = parsed.data;
  for (const c of p.citations) {
    const haystack = foldText(fieldText(c.record === "from" ? from : to, c.field)).replace(/\s+/g, " ");
    const needle = foldText(c.quote).replace(/\s+/g, " ").trim();
    if (needle === "" || !haystack.includes(needle)) {
      return { ...p, accepted: false, rejection: `citation not found in ${c.record}.${c.field}: "${c.quote.slice(0, 80)}"` };
    }
  }
  return { ...p, accepted: true };
}

// ------------------------------------------------------------------------------------------ resolution

export interface ResolveOptions {
  model: ScorerModel;
  /** Other known records, used for the multiple-releases flag. */
  knownRecords?: readonly IdentityRecord[];
  aliasGroups?: readonly AliasGroup[];
  adjudicate?: AdjudicateHook;
  adjudicateTimeoutMs?: number;
}

export interface LinkResolution {
  linkType: LinkType;
  /** Null when the pair is not proposed as a link at all. */
  link: Link | null;
  candidateClass: CandidateClass;
  presentation: Presentation;
  orientation: { from: string; to: string };
  exact: ExactVerdict;
  comparisons: ComparisonOutcome[];
  score?: PairScore;
  gate?: GateResult;
  reasons: string[];
  /** Mismatch and corroboration flags for display. Present even when no link is proposed. */
  flags: string[];
  modelProposal?: ModelProposalRecord;
  /** True when the pair sits in the uncertain band and a model proposal may be requested. */
  adjudicable: boolean;
}

export function linkId(linkType: LinkType, fromId: string, toId: string): string {
  return `lnk-${createHash("sha256").update(`${linkType}\u0000${fromId}\u0000${toId}`).digest("hex").slice(0, 16)}`;
}

const PRESENTATION_FOR: Record<LinkState, Presentation> = {
  CONFIRMED: "CONFIRMED_FACT",
  CANDIDATE: "STRONG_CANDIDATE",
  AMBIGUOUS: "WEAK_CANDIDATE",
  REJECTED: "REJECTED",
};

function makeLink(
  linkType: LinkType,
  from: IdentityRecord,
  to: IdentityRecord,
  state: LinkState,
  basis: string[],
  flags: string[],
  score: PairScore | undefined,
): Link {
  return LinkSchema.parse({
    id: linkId(linkType, from.id, to.id),
    type: linkType,
    from: from.id,
    to: to.id,
    state,
    basis,
    flags: [...new Set(flags)],
    ...(score
      ? { score: score.weight, waterfall: score.waterfall.map((w) => ({ field: w.field, level: w.level, weight: w.weight })) }
      : {}),
  });
}

function compareContext(options: ResolveOptions): CompareContext {
  return { familyNames: options.model.reference.familyNames, ...(options.aliasGroups ? { aliasGroups: options.aliasGroups } : {}) };
}

function assertLinkType(linkType: unknown): asserts linkType is LinkType {
  if (!LinkTypeSchema.safeParse(linkType).success) {
    throw new PortError("INVALID", `unknown link type ${JSON.stringify(String(linkType)).slice(0, 60)}`);
  }
}

/** Resolves one pair for one link type without any model call. Throws PortError("INVALID") on junk. */
export function resolveDeterministic(
  aInput: IdentityRecordInput,
  bInput: IdentityRecordInput,
  linkType: LinkType,
  options: ResolveOptions,
): LinkResolution {
  assertLinkType(linkType);
  const a = parseRecord(aInput, "first record");
  const b = parseRecord(bInput, "second record");
  const { from, to } = orient(linkType, a, b);
  const exact = exactEvidence(linkType, from, to);
  const comparisons = compareRecords(from, to, compareContext(options));
  const flagCtx = { ...(options.knownRecords ? { knownRecords: options.knownRecords } : {}), ...(options.aliasGroups ? { aliasGroups: options.aliasGroups } : {}) };
  const display = mismatchFlags(from, to, comparisons, flagCtx);
  const orientation = { from: from.id, to: to.id };
  const hasSomething = comparisons.some((c) => c.level !== "UNKNOWN");
  const score = linkType === "SUPERSEDES" ? undefined : scoreOutcomes(options.model, linkType, comparisons);

  const base = { linkType, orientation, exact, comparisons, ...(score ? { score } : {}) };

  if (exact.kind !== "NONE") {
    const state: LinkState = exact.kind;
    const flags = [...display, ...exact.flags];
    const nameLevel = comparisons.find((c) => c.field === "name")?.level;
    const mfrLevel = comparisons.find((c) => c.field === "manufacturer")?.level;
    if (state === "CONFIRMED" && nameLevel === "DIFFERENT" && mfrLevel === "DIFFERENT") {
      flags.push("identifier-name-conflict: the identifier agrees but name and manufacturer both differ; check for a data-entry error");
    }
    const link = makeLink(linkType, from, to, state, exact.basis, flags, score);
    return {
      ...base,
      link,
      candidateClass: state === "REJECTED" ? "NONE" : "EXACT-IDENTIFIER",
      presentation: PRESENTATION_FOR[state],
      reasons: [...exact.basis, ...exact.notes],
      flags: link.flags,
      adjudicable: false,
    };
  }

  if (linkType === "SUPERSEDES" || !score) {
    return { ...base, link: null, candidateClass: "NONE", presentation: "NOT_LINKED", reasons: exact.notes, flags: display, adjudicable: false };
  }

  if (!hasSomething) {
    const link = makeLink(linkType, from, to, "AMBIGUOUS", ["no comparable field on both records; nothing can be said"], display, score);
    return { ...base, link, candidateClass: "NONE", presentation: "WEAK_CANDIDATE", reasons: ["no comparable field"], flags: link.flags, adjudicable: false };
  }

  const gate = corroboration(comparisons, linkType);
  const summary = `evidence ${score.weight} bits; band edges ${score.bandEdges.lower} to ${score.bandEdges.upper}; ${score.band.toLowerCase()}`;
  const gateFlags = gate.blockers.map((x) => `blocked-from-strong: ${x}`);

  if (score.band === "ABOVE" && gate.strong) {
    const link = makeLink(linkType, from, to, "CANDIDATE", [summary, `corroborated by ${gate.families.join(", ")}`], [...display, ...gateFlags], score);
    return { ...base, gate, link, candidateClass: "STRONG-TEXT", presentation: "STRONG_CANDIDATE", reasons: [summary], flags: link.flags, adjudicable: false };
  }
  if (score.band === "BELOW") {
    // A matching brand with disagreeing details (another module, another use, another owner) is exactly what a
    // reviewer needs to see, with the flags that say what differs. Dropping it would hide the finding.
    const mfrLevel = comparisons.find((c) => c.field === "manufacturer")?.level;
    const codeLevel = comparisons.find((c) => c.field === "productCode")?.level;
    const surfaced = gate.brandEvidence && (mfrLevel !== "DIFFERENT" || codeLevel === "EXACT");
    if (surfaced) {
      const why = "the brand matches but other fields disagree; surfaced so the difference is seen";
      const link = makeLink(linkType, from, to, "AMBIGUOUS", [summary, why], [...display, ...gateFlags], score);
      return { ...base, gate, link, candidateClass: "WEAK-NAME-ONLY", presentation: "WEAK_CANDIDATE", reasons: [summary, why], flags: link.flags, adjudicable: false };
    }
    return { ...base, gate, link: null, candidateClass: "NONE", presentation: "NOT_LINKED", reasons: [summary], flags: [...display, ...gateFlags], adjudicable: false };
  }
  const why = score.band === "ABOVE" ? "score is high but corroboration is missing" : "score is inside the uncertain band";
  const link = makeLink(linkType, from, to, "AMBIGUOUS", [summary, why], [...display, ...gateFlags], score);
  return {
    ...base,
    gate,
    link,
    candidateClass: gate.nameEvidence ? "WEAK-NAME-ONLY" : "NONE",
    presentation: "WEAK_CANDIDATE",
    reasons: [summary, why],
    flags: link.flags,
    adjudicable: score.band === "UNCERTAIN",
  };
}

/**
 * Resolves a pair and, when a hook is supplied and the pair sits in the uncertain band, records the model's
 * proposal beside it. The proposal is validated and attached; the link state is the one the deterministic
 * steps produced. A hook that fails, times out or returns something malformed is reported, not trusted.
 */
export async function resolveLink(
  aInput: IdentityRecordInput,
  bInput: IdentityRecordInput,
  linkType: LinkType,
  options: ResolveOptions,
): Promise<LinkResolution> {
  const base = resolveDeterministic(aInput, bInput, linkType, options);
  if (!options.adjudicate || !base.adjudicable || !base.link || !base.score) return base;

  const a = parseRecord(aInput, "first record");
  const b = parseRecord(bInput, "second record");
  const { from, to } = orient(linkType, a, b);
  const request: AdjudicationRequest = {
    linkType,
    from,
    to,
    weight: base.score.weight,
    waterfall: base.score.waterfall,
    citableFields: CITABLE_FIELDS,
  };
  const timeoutMs = options.adjudicateTimeoutMs ?? 15000;
  let raw: unknown;
  try {
    raw = await withTimeout(options.adjudicate(request), timeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return annotate(base, undefined, `adjudication-unavailable: ${reason.slice(0, 120)}`);
  }
  const proposal = validateProposal(raw, from, to);
  const flag = proposal.accepted
    ? `model-hint-${proposal.verdict.toLowerCase()}: unverified proposal, the link state is unchanged and a reviewer decides`
    : `model-hint-rejected: ${proposal.rejection ?? "invalid"}`;
  return annotate(base, proposal, flag);
}

function annotate(base: LinkResolution, proposal: ModelProposalRecord | undefined, flag: string): LinkResolution {
  const link = base.link ? { ...base.link, flags: [...base.link.flags, flag] } : base.link;
  return { ...base, link, flags: [...base.flags, flag], ...(proposal ? { modelProposal: proposal } : {}) };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new PortError("UNAVAILABLE", `adjudication timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// ------------------------------------------------------------------------------------------ ranking

const STATE_RANK: Record<LinkState, number> = { CONFIRMED: 4, CANDIDATE: 3, AMBIGUOUS: 2, REJECTED: 1 };

export interface RankedCandidate {
  other: IdentityRecord;
  resolution: LinkResolution;
}

/**
 * Candidates for one record against a pool, strongest first. Order is by state, then evidence weight, then
 * record id, so the same pool in any order gives the same ranking. Pairs the link type cannot apply to are skipped.
 */
export function rankCandidates(
  target: IdentityRecordInput,
  pool: readonly IdentityRecordInput[],
  linkType: LinkType,
  options: ResolveOptions,
): RankedCandidate[] {
  assertLinkType(linkType);
  const t = parseRecord(target, "target record");
  const out: RankedCandidate[] = [];
  for (const raw of pool) {
    const other = parseRecord(raw, "pool record");
    if (other.id === t.id) continue;
    let resolution: LinkResolution;
    try {
      resolution = resolveDeterministic(t, other, linkType, options);
    } catch (err) {
      if (err instanceof PortError && err.failure === "INVALID") continue;
      throw err;
    }
    if (resolution.link) out.push({ other, resolution });
  }
  return out.sort((x, y) => {
    const sx = STATE_RANK[x.resolution.link!.state];
    const sy = STATE_RANK[y.resolution.link!.state];
    if (sx !== sy) return sy - sx;
    const wx = x.resolution.score?.weight ?? 0;
    const wy = y.resolution.score?.weight ?? 0;
    if (wx !== wy) return wy - wx;
    return x.other.id < y.other.id ? -1 : x.other.id > y.other.id ? 1 : 0;
  });
}
