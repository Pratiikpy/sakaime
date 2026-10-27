/**
 * Reviewer decisions on links, recorded as an append-only, hash-chained ledger.
 *
 * A reviewer decision is the only way, besides an exact identifier, for a link to reach CONFIRMED, and the only
 * way for a link to be REJECTED against the evidence. Every decision carries an idempotency key, because a
 * resumed investigation can replay a step: repeating a decision with the same key returns the stored event and
 * appends nothing; reusing a key for a different decision is an error.
 */
import { PortError, systemClock, type Clock } from "../ports/index.ts";
import { LinkSchema, type Link, type LinkState } from "../schemas/index.ts";
import { hashOf } from "../util/canonical.ts";

export interface ReviewerDecision {
  idempotencyKey: string;
  reviewerId: string;
  decision: "CONFIRM" | "REJECT";
  note?: string;
}

export interface LinkEvent {
  eventId: string;
  idempotencyKey: string;
  linkId: string;
  linkType: Link["type"];
  from: string;
  to: string;
  decision: ReviewerDecision["decision"];
  reviewerId: string;
  note?: string;
  decidedAt: string;
  priorState: LinkState;
  newState: LinkState;
  /** Hash of the evidence the reviewer saw: basis, score, waterfall and flags. */
  evidenceDigest: string;
  prevHash: string;
  hash: string;
}

const GENESIS = "0".repeat(64);

function digestOf(link: Link): string {
  return hashOf({ basis: link.basis, score: link.score, waterfall: link.waterfall, flags: link.flags, state: link.state });
}

function payloadHash(link: Link, d: ReviewerDecision): string {
  return hashOf({ linkId: link.id, decision: d.decision, reviewerId: d.reviewerId, note: d.note ?? null });
}

export class ReviewLedger {
  private readonly chain: LinkEvent[] = [];
  private readonly byKey = new Map<string, { event: LinkEvent; payload: string }>();

  constructor(private readonly clock: Clock = systemClock) {}

  /** Records a decision about a link. Idempotent on the key. */
  record(linkInput: Link, decision: ReviewerDecision): LinkEvent {
    const link = LinkSchema.parse(linkInput);
    if (decision.idempotencyKey.trim() === "") throw new PortError("INVALID", "a reviewer decision needs an idempotency key");
    if (decision.reviewerId.trim() === "") throw new PortError("INVALID", "a reviewer decision needs a reviewer id");
    if (decision.decision !== "CONFIRM" && decision.decision !== "REJECT") throw new PortError("INVALID", `unknown decision ${String(decision.decision)}`);

    const payload = payloadHash(link, decision);
    const existing = this.byKey.get(decision.idempotencyKey);
    if (existing) {
      if (existing.payload !== payload) {
        throw new PortError("INVALID", `idempotency key ${decision.idempotencyKey} was already used for a different decision`, { key: decision.idempotencyKey });
      }
      return existing.event;
    }

    const newState: LinkState = decision.decision === "CONFIRM" ? "CONFIRMED" : "REJECTED";
    const prevHash = this.chain.length === 0 ? GENESIS : this.chain[this.chain.length - 1]!.hash;
    const body = {
      eventId: `evt-${this.chain.length + 1}-${payload.slice(0, 12)}`,
      idempotencyKey: decision.idempotencyKey,
      linkId: link.id,
      linkType: link.type,
      from: link.from,
      to: link.to,
      decision: decision.decision,
      reviewerId: decision.reviewerId,
      ...(decision.note ? { note: decision.note } : {}),
      decidedAt: this.clock.now().toISOString(),
      priorState: link.state,
      newState,
      evidenceDigest: digestOf(link),
      prevHash,
    };
    const event: LinkEvent = { ...body, hash: hashOf(body) };
    this.chain.push(event);
    this.byKey.set(decision.idempotencyKey, { event, payload });
    return event;
  }

  events(): readonly LinkEvent[] {
    return this.chain;
  }

  /** Recomputes every hash and link in the chain. False means the history was altered. */
  verify(events: readonly LinkEvent[] = this.chain): boolean {
    let prev = GENESIS;
    for (const e of events) {
      const { hash, ...body } = e;
      if (e.prevHash !== prev || hashOf(body) !== hash) return false;
      prev = hash;
    }
    return true;
  }

  /** The link as the reviewers left it: the latest decision about it, if any, sets the state. */
  apply(linkInput: Link): Link {
    const link = LinkSchema.parse(linkInput);
    const latest = [...this.chain].reverse().find((e) => e.linkId === link.id);
    if (!latest) return link;
    const overrode = latest.newState === "CONFIRMED" && (link.state === "REJECTED" || link.state === "AMBIGUOUS");
    return LinkSchema.parse({
      ...link,
      state: latest.newState,
      basis: [...link.basis, `reviewer ${latest.reviewerId} ${latest.decision === "CONFIRM" ? "confirmed" : "rejected"} this link (${latest.eventId})`],
      decidedBy: latest.reviewerId,
      decidedAt: latest.decidedAt,
      flags: overrode ? [...link.flags, `reviewer-overrode-${link.state.toLowerCase()}`] : link.flags,
    });
  }
}
