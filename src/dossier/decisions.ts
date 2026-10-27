/**
 * Reviewer decisions (C-17, FR-25).
 *
 * The decision history is append-only and hash-chained: each entry commits to the previous entry's hash, so
 * removing, reordering or editing an entry breaks the chain at a named position. A decision carries an
 * idempotency key; replaying the same key with the same content returns the existing entry and records nothing,
 * so a retried request or a resumed run never produces a duplicate. The same key with different content is a
 * conflict and is refused, because accepting it would silently drop one of the two intentions.
 *
 * Findings are never rewritten. A reviewer's decision does not touch the finding it is about; the current state
 * of a finding is read from this log. A recomputed finding is a new finding that points at the old one with a reason.
 */
import { z } from "zod";
import type { Clock } from "../ports/index.ts";
import { systemClock } from "../ports/index.ts";
import type { Finding } from "../schemas/index.ts";
import { DimensionSchema, ScopeSchema } from "../schemas/index.ts";
import { hashOf } from "../util/canonical.ts";
import { DecisionActionSchema, DecisionEntrySchema, GENESIS_HASH } from "./schema.ts";
import type { DecisionAction, DecisionEntry } from "./schema.ts";

export type ReviewState = "unreviewed" | DecisionEntry["resultingState"];

const STATE_OF: Record<DecisionAction, DecisionEntry["resultingState"]> = {
  accept: "accepted",
  narrow: "narrowed",
  request_evidence: "evidence_requested",
  escalate: "escalated",
};

export const DecisionInputSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    claimId: z.string().min(1),
    findingId: z.string().min(1),
    action: DecisionActionSchema,
    reviewer: z.string().trim().min(1),
    note: z.string().optional(),
    /** Required for `narrow`: the scope the reviewer is willing to rely on. */
    narrowedScope: ScopeSchema.optional(),
    /** For `request_evidence`: which dimensions the reviewer wants settled. */
    requestedDimensions: z.array(DimensionSchema).min(1).optional(),
    /** For `escalate`: who it goes to. */
    escalateTo: z.string().trim().min(1).optional(),
  })
  .superRefine((v, ctx) => {
    if (v.action === "narrow" && !v.narrowedScope) ctx.addIssue({ code: "custom", message: "narrow requires narrowedScope", path: ["narrowedScope"] });
    if (v.action !== "narrow" && v.narrowedScope) ctx.addIssue({ code: "custom", message: "narrowedScope is only valid for narrow", path: ["narrowedScope"] });
    if (v.action !== "request_evidence" && v.requestedDimensions) ctx.addIssue({ code: "custom", message: "requestedDimensions is only valid for request_evidence", path: ["requestedDimensions"] });
    if (v.action !== "escalate" && v.escalateTo) ctx.addIssue({ code: "custom", message: "escalateTo is only valid for escalate", path: ["escalateTo"] });
  });
export type DecisionInput = z.input<typeof DecisionInputSchema>;

export class IdempotencyConflictError extends Error {
  constructor(public readonly idempotencyKey: string) {
    super(`idempotency key ${idempotencyKey} was already used for a different decision`);
    this.name = "IdempotencyConflictError";
  }
}

export class DecisionRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DecisionRejectedError";
  }
}

export function decisionRequestHash(input: z.output<typeof DecisionInputSchema>): string {
  return hashOf({
    claimId: input.claimId,
    findingId: input.findingId,
    action: input.action,
    reviewer: input.reviewer,
    note: input.note,
    narrowedScope: input.narrowedScope,
    requestedDimensions: input.requestedDimensions,
    escalateTo: input.escalateTo,
  });
}

export function decisionEntryHash(entry: Omit<DecisionEntry, "hash">): string {
  return hashOf(entry);
}

export function decisionEntryId(seq: number): string {
  return `dec-${String(seq).padStart(4, "0")}`;
}

export interface ChainProblem {
  /** Entry id, or "decisionHistory" for a problem with the log as a whole. */
  item: string;
  reason: string;
}

/**
 * Checks a decision history: shape, contiguous sequence, chain links, entry hashes, request hashes, state mapping,
 * and unique idempotency keys. Returns every problem found; an empty list means the chain is intact.
 */
export function verifyDecisionChain(entries: readonly unknown[]): ChainProblem[] {
  const problems: ChainProblem[] = [];
  let prev = GENESIS_HASH;
  const seenKeys = new Map<string, string>();
  entries.forEach((raw, index) => {
    const parsed = DecisionEntrySchema.safeParse(raw);
    const idGuess = raw !== null && typeof raw === "object" && typeof (raw as { id?: unknown }).id === "string" ? (raw as { id: string }).id : `decisionHistory[${index}]`;
    if (!parsed.success) {
      problems.push({ item: idGuess, reason: `malformed decision entry: ${parsed.error.issues[0]?.message ?? "invalid"}` });
      return;
    }
    const e = parsed.data;
    if (e.seq !== index + 1) problems.push({ item: e.id, reason: `sequence is ${e.seq}, expected ${index + 1}` });
    if (e.id !== decisionEntryId(e.seq)) problems.push({ item: e.id, reason: `id does not match sequence ${e.seq}` });
    if (e.prevHash !== prev) problems.push({ item: e.id, reason: "previous-entry hash does not match: an entry before this one was removed, reordered or changed" });
    const { hash, ...rest } = e;
    if (decisionEntryHash(rest) !== hash) problems.push({ item: e.id, reason: "entry hash does not match its content" });
    if (STATE_OF[e.action] !== e.resultingState) problems.push({ item: e.id, reason: `action ${e.action} cannot result in state ${e.resultingState}` });
    const recomputed = decisionRequestHash(DecisionInputSchema.parse(inputOf(e)));
    if (recomputed !== e.requestHash) problems.push({ item: e.id, reason: "request hash does not match the decision content" });
    const firstWithKey = seenKeys.get(e.idempotencyKey);
    if (firstWithKey !== undefined) problems.push({ item: e.id, reason: `idempotency key repeated; first used by ${firstWithKey}` });
    else seenKeys.set(e.idempotencyKey, e.id);
    prev = hash;
  });
  return problems;
}

function inputOf(e: DecisionEntry): DecisionInput {
  return {
    idempotencyKey: e.idempotencyKey,
    claimId: e.claimId,
    findingId: e.findingId,
    action: e.action,
    reviewer: e.reviewer,
    ...(e.note !== undefined ? { note: e.note } : {}),
    ...(e.narrowedScope ? { narrowedScope: e.narrowedScope } : {}),
    ...(e.requestedDimensions ? { requestedDimensions: e.requestedDimensions } : {}),
    ...(e.escalateTo ? { escalateTo: e.escalateTo } : {}),
  };
}

export interface AppendResult {
  entry: DecisionEntry;
  /** True when the key had been used before with the same content; nothing was recorded. */
  replayed: boolean;
}

export interface DecisionLogOptions {
  clock?: Clock;
  /** When given, decisions on an unknown finding, or with the wrong claim id, are rejected. */
  findings?: readonly Pick<Finding, "id" | "claimId">[];
}

export class DecisionLog {
  private readonly log: DecisionEntry[];
  private readonly byKey = new Map<string, DecisionEntry>();
  private readonly clock: Clock;
  private readonly findings: ReadonlyMap<string, Pick<Finding, "id" | "claimId">> | undefined;

  private constructor(entries: DecisionEntry[], options: DecisionLogOptions) {
    this.log = entries;
    for (const e of entries) this.byKey.set(e.idempotencyKey, e);
    this.clock = options.clock ?? systemClock;
    this.findings = options.findings ? new Map(options.findings.map((f) => [f.id, f])) : undefined;
  }

  static create(options: DecisionLogOptions = {}): DecisionLog {
    return new DecisionLog([], options);
  }

  /** Rebuilds a log from stored entries after checking the whole chain. Throws if the stored history is not intact. */
  static resume(entries: readonly unknown[], options: DecisionLogOptions = {}): DecisionLog {
    const problems = verifyDecisionChain(entries);
    if (problems.length > 0) {
      throw new DecisionRejectedError(`stored decision history is not intact: ${problems.map((p) => `${p.item}: ${p.reason}`).join("; ")}`);
    }
    return new DecisionLog(entries.map((e) => DecisionEntrySchema.parse(e)), options);
  }

  append(rawInput: DecisionInput): AppendResult {
    const parsed = DecisionInputSchema.safeParse(rawInput);
    if (!parsed.success) {
      throw new DecisionRejectedError(`invalid decision: ${parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    }
    const input = parsed.data;
    const requestHash = decisionRequestHash(input);

    const existing = this.byKey.get(input.idempotencyKey);
    if (existing) {
      if (existing.requestHash !== requestHash) throw new IdempotencyConflictError(input.idempotencyKey);
      return { entry: structuredClone(existing), replayed: true };
    }

    if (this.findings) {
      const finding = this.findings.get(input.findingId);
      if (!finding) throw new DecisionRejectedError(`unknown finding ${input.findingId}`);
      if (finding.claimId !== input.claimId) throw new DecisionRejectedError(`finding ${input.findingId} belongs to claim ${finding.claimId}, not ${input.claimId}`);
    }

    const seq = this.log.length + 1;
    const prevHash = this.log.length === 0 ? GENESIS_HASH : (this.log[this.log.length - 1] as DecisionEntry).hash;
    const body: Omit<DecisionEntry, "hash"> = {
      id: decisionEntryId(seq),
      history: "decision",
      seq,
      idempotencyKey: input.idempotencyKey,
      requestHash,
      claimId: input.claimId,
      findingId: input.findingId,
      action: input.action,
      resultingState: STATE_OF[input.action],
      reviewer: input.reviewer,
      at: this.clock.now().toISOString(),
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.narrowedScope ? { narrowedScope: input.narrowedScope } : {}),
      ...(input.requestedDimensions ? { requestedDimensions: input.requestedDimensions } : {}),
      ...(input.escalateTo ? { escalateTo: input.escalateTo } : {}),
      prevHash,
    };
    const entry: DecisionEntry = DecisionEntrySchema.parse({ ...body, hash: decisionEntryHash(body) });
    this.log.push(entry);
    this.byKey.set(entry.idempotencyKey, entry);
    return { entry: structuredClone(entry), replayed: false };
  }

  entries(): DecisionEntry[] {
    return this.log.map((e) => structuredClone(e));
  }

  entryForKey(idempotencyKey: string): DecisionEntry | undefined {
    const e = this.byKey.get(idempotencyKey);
    return e ? structuredClone(e) : undefined;
  }

  /** The current review state of a finding: its latest decision, or unreviewed. */
  stateOf(findingId: string): ReviewState {
    return reviewStateOf(this.log, findingId);
  }

  decisionsFor(findingId: string): DecisionEntry[] {
    return this.log.filter((e) => e.findingId === findingId).map((e) => structuredClone(e));
  }
}

export function reviewStateOf(entries: readonly Pick<DecisionEntry, "findingId" | "resultingState">[], findingId: string): ReviewState {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i] as Pick<DecisionEntry, "findingId" | "resultingState">;
    if (e.findingId === findingId) return e.resultingState;
  }
  return "unreviewed";
}

// ---------------------------------------------------------------- supersession

export class SupersessionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupersessionError";
  }
}

/**
 * Records a recomputed finding as a new finding that points at the one it replaces. Returns a new list; the old finding
 * is not touched (it is the same object in the result) and stays in the list. A finding can be superseded once: a chain,
 * not a fork, so "the current finding for this claim" has one answer.
 */
export function supersedeFinding(existing: readonly Finding[], oldId: string, replacement: Finding, reason: string): Finding[] {
  const trimmed = reason.trim();
  if (trimmed === "") throw new SupersessionError("a replacement finding needs a reason");
  const old = existing.find((f) => f.id === oldId);
  if (!old) throw new SupersessionError(`finding ${oldId} does not exist`);
  if (existing.some((f) => f.id === replacement.id)) throw new SupersessionError(`finding id ${replacement.id} is already in use; ids are never reused`);
  if (replacement.claimId !== old.claimId) throw new SupersessionError(`replacement is for claim ${replacement.claimId}, the finding it replaces is for ${old.claimId}`);
  if (existing.some((f) => f.supersedes === oldId)) throw new SupersessionError(`finding ${oldId} has already been superseded`);
  return [...existing, { ...replacement, supersedes: oldId, supersedesReason: trimmed }];
}

/** Findings that no later finding supersedes. */
export function currentFindings(findings: readonly Finding[]): Finding[] {
  const superseded = new Set(findings.map((f) => f.supersedes).filter((id): id is string => id !== undefined));
  return findings.filter((f) => !superseded.has(f.id));
}
