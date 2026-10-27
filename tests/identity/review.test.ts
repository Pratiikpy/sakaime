import { describe, expect, it } from "vitest";
import { PortError } from "../../src/ports/index.ts";
import { ReviewLedger, type ReviewerDecision } from "../../src/identity/review.ts";
import { resolve2 } from "./helpers.ts";

const clock = (start = Date.UTC(2026, 9, 27, 12, 0, 0)) => {
  let t = start;
  return { now: () => new Date((t += 1000)) };
};

const weakLink = () => resolve2("pubmed:33904171", "510k:DEN200080", "STUDY_EVALUATES").link!;
const confirm = (key: string, reviewerId = "reviewer-1"): ReviewerDecision => ({ idempotencyKey: key, reviewerId, decision: "CONFIRM", note: "abstract names the product" });

describe("reviewer confirmation", () => {
  it("is the way an uncertain link reaches CONFIRMED, with an auditable event", () => {
    const ledger = new ReviewLedger(clock());
    const link = weakLink();
    expect(link.state).not.toBe("CONFIRMED");
    const event = ledger.record(link, confirm("k1"));
    expect(event).toMatchObject({ decision: "CONFIRM", priorState: link.state, newState: "CONFIRMED", reviewerId: "reviewer-1", linkId: link.id, idempotencyKey: "k1" });
    expect(event.evidenceDigest).toMatch(/^[0-9a-f]{64}$/);
    const applied = ledger.apply(link);
    expect(applied.state).toBe("CONFIRMED");
    expect(applied.decidedBy).toBe("reviewer-1");
    expect(applied.decidedAt).toBe(event.decidedAt);
    expect(applied.basis.join(" ")).toMatch(/reviewer reviewer-1 confirmed/);
  });

  it("can reject an exact-identifier link, and records that it overrode the evidence", () => {
    const ledger = new ReviewLedger(clock());
    const exact = resolve2("ctgov:NCT03112005", "510k:K200667", "STUDY_EVALUATES").link!;
    expect(exact.state).toBe("CONFIRMED");
    ledger.record(exact, { idempotencyKey: "r1", reviewerId: "reviewer-2", decision: "REJECT", note: "wrong study" });
    expect(ledger.apply(exact).state).toBe("REJECTED");
  });

  it("marks a confirmation that overrides a rejection", () => {
    const ledger = new ReviewLedger(clock());
    const rejected = resolve2("list:K251153", "list:K231355", "SAME_SUBMISSION").link!;
    expect(rejected.state).toBe("REJECTED");
    ledger.record(rejected, confirm("o1"));
    const applied = ledger.apply(rejected);
    expect(applied.state).toBe("CONFIRMED");
    expect(applied.flags).toContain("reviewer-overrode-rejected");
  });

  it("is idempotent on the key: a replay returns the stored event and appends nothing", () => {
    const ledger = new ReviewLedger(clock());
    const link = weakLink();
    const first = ledger.record(link, confirm("same"));
    const again = ledger.record(link, confirm("same"));
    expect(again).toBe(first);
    expect(ledger.events()).toHaveLength(1);
  });

  it("refuses to reuse a key for a different decision", () => {
    const ledger = new ReviewLedger(clock());
    const link = weakLink();
    ledger.record(link, confirm("dup"));
    expect(() => ledger.record(link, { idempotencyKey: "dup", reviewerId: "reviewer-1", decision: "REJECT" })).toThrow(PortError);
    expect(() => ledger.record(link, { ...confirm("dup"), reviewerId: "someone-else" })).toThrow(/already used/);
    expect(ledger.events()).toHaveLength(1);
  });

  it("the latest decision about a link sets its state", () => {
    const ledger = new ReviewLedger(clock());
    const link = weakLink();
    ledger.record(link, confirm("a"));
    ledger.record(link, { idempotencyKey: "b", reviewerId: "reviewer-3", decision: "REJECT" });
    expect(ledger.apply(link).state).toBe("REJECTED");
  });

  it("leaves a link no reviewer has decided exactly as it was", () => {
    const ledger = new ReviewLedger(clock());
    const link = weakLink();
    expect(ledger.apply(link)).toEqual(link);
  });

  it("chains events by hash, so an edited history is detected", () => {
    const ledger = new ReviewLedger(clock());
    const link = weakLink();
    ledger.record(link, confirm("e1"));
    ledger.record(link, { idempotencyKey: "e2", reviewerId: "reviewer-2", decision: "REJECT" });
    expect(ledger.verify()).toBe(true);
    const tampered = ledger.events().map((e) => ({ ...e }));
    tampered[0]!.reviewerId = "someone-else";
    expect(ledger.verify(tampered)).toBe(false);
    const dropped = ledger.events().slice(1);
    expect(ledger.verify(dropped)).toBe(false);
  });

  it("rejects an empty key, an empty reviewer, an unknown decision and a malformed link", () => {
    const ledger = new ReviewLedger(clock());
    const link = weakLink();
    expect(() => ledger.record(link, { ...confirm("x"), idempotencyKey: " " })).toThrow(PortError);
    expect(() => ledger.record(link, { ...confirm("x"), reviewerId: "" })).toThrow(PortError);
    expect(() => ledger.record(link, { ...confirm("x"), decision: "APPROVE" as never })).toThrow(PortError);
    expect(() => ledger.record({ ...link, state: "SAFE" as never }, confirm("y"))).toThrow();
    expect(ledger.events()).toHaveLength(0);
  });
});
