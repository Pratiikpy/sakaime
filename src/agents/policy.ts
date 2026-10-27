/**
 * Wording and prose rules.
 *
 * The product describes evidence coverage and nothing else. It never says a thing is safe, cleared, compliant or approved,
 * and it does not use the vocabulary of proof or superlatives about itself. The check is on text our code or a model wrote
 * for the reviewer; quoted source text is data and is not linted.
 *
 * Prose (FR-16): every sentence the Reporter produces is tied to a finding id, and a sentence without one, or with one that
 * names no finding of the case, is rejected by code. A number in a sentence must be traceable to the finding it cites, to the
 * claim, or to an anchor of that finding; a number from nowhere is rejected.
 */
import { numbersInPassage, numbersInRendered, traces, leafTexts } from "../dossier/trace.ts";
import type { Claim, EvidenceAnchor, Finding } from "../schemas/index.ts";

const BANNED: [RegExp, string][] = [
  [/\bbest\b/i, "best"],
  [/\bproof\b|\bproven\b|\bproves?\b/i, "proof"],
  [/\bguarantee[sd]?\b/i, "guaranteed"],
  [/\baccurate(?:ly)?\b/i, "accurate"],
  [/\bproduction[- ]ready\b/i, "production-ready"],
  [/\bstate[- ]of[- ]the[- ]art\b/i, "state-of-the-art"],
  [/\bvalidated\b/i, "validated"],
  [/\b(?:is|are|was|were|deemed|considered|found|declared)\s+(?:safe|cleared|compliant|approved|certified)\b/i, "a verdict of safety, clearance, compliance or approval"],
  [/\b(?:safe|compliant|certified|approved)\s+(?:for|to)\s+(?:use|deploy|deployment|procure|purchase)\b/i, "a verdict of safety, compliance or approval"],
];

/** Names of the banned expressions found in `text`. Empty means the wording is acceptable. */
export function lintWording(text: string): string[] {
  const found: string[] = [];
  for (const [re, name] of BANNED) if (re.test(text) && !found.includes(name)) found.push(name);
  return found;
}

export interface ProseSentence {
  findingId?: unknown;
  text?: unknown;
}

export interface AcceptedSentence {
  findingId: string;
  text: string;
}

export interface Rejection {
  index: number;
  reason: string;
  text?: string;
}

export interface ProseCheck {
  accepted: AcceptedSentence[];
  rejected: Rejection[];
}

export interface ProseContext {
  findings: readonly Finding[];
  claims: ReadonlyMap<string, Claim>;
  anchors: ReadonlyMap<string, EvidenceAnchor>;
}

function allowedNumbers(f: Finding, claim: Claim | undefined, anchors: ReadonlyMap<string, EvidenceAnchor>): number[] {
  const out: number[] = [];
  const anchorIds = new Set<string>();
  for (const a of f.mechanicalCoverage) a.anchorIds.forEach((id) => anchorIds.add(id));
  for (const m of f.mismatches) m.anchorIds.forEach((id) => anchorIds.add(id));
  for (const id of anchorIds) out.push(...numbersInPassage(anchors.get(id)?.text ?? ""));
  if (claim) out.push(...numbersInPassage(`${claim.id} ${claim.text ?? ""} ${leafTexts(claim.use).join(" ")} ${leafTexts(claim.performance).join(" ")}`));
  const rendered = [
    ...f.mechanicalCoverage.flatMap((a) => [a.claimed, a.established]),
    ...f.mismatches.flatMap((m) => [m.claimed, m.established]),
    ...f.requiredEvidence.map((r) => r.request),
    ...leafTexts(f.supportedScope),
  ].filter((x): x is string => typeof x === "string");
  for (const r of rendered) out.push(...numbersInPassage(r));
  return out;
}

/** Accepts only sentences tied to a finding of this case, free of banned wording, whose numbers trace to that finding's sources. */
export function checkProse(sentences: readonly ProseSentence[], ctx: ProseContext): ProseCheck {
  const byId = new Map(ctx.findings.map((f) => [f.id, f]));
  const accepted: AcceptedSentence[] = [];
  const rejected: Rejection[] = [];
  sentences.forEach((s, index) => {
    const text = typeof s.text === "string" ? s.text.trim() : "";
    if (typeof s.findingId !== "string" || s.findingId === "") return void rejected.push({ index, reason: "the sentence names no finding id", ...(text ? { text } : {}) });
    const f = byId.get(s.findingId);
    if (!f) return void rejected.push({ index, reason: `finding id ${s.findingId.slice(0, 40)} is not a finding of this case`, ...(text ? { text } : {}) });
    if (text.length < 8 || text.length > 500) return void rejected.push({ index, reason: "the sentence is empty or longer than 500 characters", ...(text ? { text: text.slice(0, 80) } : {}) });
    const words = lintWording(text);
    if (words.length > 0) return void rejected.push({ index, reason: `banned wording: ${words.join(", ")}`, text });
    const allowed = allowedNumbers(f, ctx.claims.get(f.claimId), ctx.anchors);
    for (const n of numbersInRendered(text)) {
      if (!traces(n.value, allowed)) return void rejected.push({ index, reason: `the number ${n.token} does not appear in the finding, the claim or an anchor of the finding`, text });
    }
    accepted.push({ findingId: s.findingId, text });
  });
  return { accepted, rejected };
}
