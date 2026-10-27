import { describe, expect, it } from "vitest";
import fc from "fast-check";
import {
  DecisionLog,
  DecisionRejectedError,
  GENESIS_HASH,
  IdempotencyConflictError,
  SupersessionError,
  currentFindings,
  supersedeFinding,
  verifyDecisionChain,
} from "../../src/dossier/index.ts";
import { FindingSchema } from "../../src/schemas/index.ts";
import { baseInput, fixedClock } from "./helpers.ts";

const findings = baseInput().findings;
const newLog = () => DecisionLog.create({ clock: fixedClock, findings });
const base = { claimId: "c1", findingId: "f1", reviewer: "reviewer-a" } as const;

describe("reviewer decisions", () => {
  it.each([
    ["accept", {}, "accepted"],
    ["narrow", { narrowedScope: { population: { age: { min: 18, max: 65 } } } }, "narrowed"],
    ["request_evidence", { requestedDimensions: ["population"] }, "evidence_requested"],
    ["escalate", { escalateTo: "clinical-lead" }, "escalated"],
  ] as const)("%s is appended to the decision history and sets the state", (action, extra, state) => {
    const log = newLog();
    const { entry, replayed } = log.append({ ...base, idempotencyKey: `k-${action}`, action, ...extra } as Parameters<DecisionLog["append"]>[0]);
    expect(replayed).toBe(false);
    expect(entry).toMatchObject({ seq: 1, id: "dec-0001", history: "decision", action, resultingState: state, prevHash: GENESIS_HASH });
    expect(log.stateOf("f1")).toBe(state);
    expect(log.stateOf("f2")).toBe("unreviewed");
    expect(verifyDecisionChain(log.entries())).toEqual([]);
  });

  it("replaying the same key with the same content records nothing and returns the original entry", () => {
    const log = newLog();
    const first = log.append({ ...base, idempotencyKey: "k1", action: "accept" });
    const again = log.append({ ...base, idempotencyKey: "k1", action: "accept" });
    expect(again.replayed).toBe(true);
    expect(again.entry).toEqual(first.entry);
    expect(log.entries()).toHaveLength(1);
  });

  it("refuses the same key with different content rather than dropping one of the two intentions", () => {
    const log = newLog();
    log.append({ ...base, idempotencyKey: "k1", action: "accept" });
    expect(() => log.append({ ...base, idempotencyKey: "k1", action: "escalate", escalateTo: "lead" })).toThrow(IdempotencyConflictError);
    expect(() => log.append({ ...base, idempotencyKey: "k1", action: "accept", reviewer: "reviewer-b" })).toThrow(IdempotencyConflictError);
    expect(log.entries()).toHaveLength(1);
  });

  it("a different key with the same content is a new decision (two real clicks)", () => {
    const log = newLog();
    log.append({ ...base, idempotencyKey: "k1", action: "accept" });
    const second = log.append({ ...base, idempotencyKey: "k2", action: "accept" });
    expect(second.replayed).toBe(false);
    expect(log.entries()).toHaveLength(2);
  });

  it("the latest decision is the current state, and earlier ones stay in the history", () => {
    const log = newLog();
    log.append({ ...base, idempotencyKey: "k1", action: "request_evidence", requestedDimensions: ["version"] });
    log.append({ ...base, idempotencyKey: "k2", action: "accept" });
    expect(log.stateOf("f1")).toBe("accepted");
    expect(log.decisionsFor("f1").map((e) => e.action)).toEqual(["request_evidence", "accept"]);
  });

  it("rejects junk: unknown finding, wrong claim, empty key, missing narrowed scope, fields for another action", () => {
    const log = newLog();
    expect(() => log.append({ ...base, findingId: "f-none", idempotencyKey: "k", action: "accept" })).toThrow(/unknown finding/);
    expect(() => log.append({ ...base, claimId: "c2", idempotencyKey: "k", action: "accept" })).toThrow(/belongs to claim c1/);
    expect(() => log.append({ ...base, idempotencyKey: "  ", action: "accept" })).toThrow(DecisionRejectedError);
    expect(() => log.append({ ...base, idempotencyKey: "k", action: "narrow" })).toThrow(/narrow requires narrowedScope/);
    expect(() => log.append({ ...base, idempotencyKey: "k", action: "accept", escalateTo: "x" })).toThrow(/escalateTo is only valid for escalate/);
    expect(() => log.append({ ...base, idempotencyKey: "k", action: "dismiss" as never })).toThrow(DecisionRejectedError);
    expect(() => log.append({ ...base, idempotencyKey: "k", action: "request_evidence", requestedDimensions: [] })).toThrow(DecisionRejectedError);
    expect(log.entries()).toEqual([]);
  });

  it("does not touch the finding it is about", () => {
    const before = JSON.stringify(findings);
    const log = newLog();
    log.append({ ...base, idempotencyKey: "k1", action: "accept" });
    expect(JSON.stringify(findings)).toBe(before);
    expect(findings[0]?.reviewerState).toBe("unreviewed");
  });

  it("returns copies, so a caller cannot edit the log through what it was handed", () => {
    const log = newLog();
    const { entry } = log.append({ ...base, idempotencyKey: "k1", action: "accept" });
    entry.reviewer = "someone-else";
    log.entries()[0]!.action = "escalate";
    expect(log.entries()[0]).toMatchObject({ reviewer: "reviewer-a", action: "accept" });
  });
});

describe("kill and resume (C-17)", () => {
  it("resumes from stored entries and a replay after the restart still records nothing", () => {
    const log = newLog();
    log.append({ ...base, idempotencyKey: "k1", action: "request_evidence", requestedDimensions: ["population"] });
    const stored = JSON.parse(JSON.stringify(log.entries()));
    const resumed = DecisionLog.resume(stored, { clock: fixedClock, findings });
    const again = resumed.append({ ...base, idempotencyKey: "k1", action: "request_evidence", requestedDimensions: ["population"] });
    expect(again.replayed).toBe(true);
    expect(resumed.entries()).toHaveLength(1);
    const next = resumed.append({ ...base, idempotencyKey: "k2", action: "accept" });
    expect(next.entry).toMatchObject({ seq: 2, prevHash: stored[0].hash });
  });

  it("refuses to resume from a history that has been edited, reordered or cut", () => {
    const log = newLog();
    log.append({ ...base, idempotencyKey: "k1", action: "accept" });
    log.append({ ...base, claimId: "c2", findingId: "f2", idempotencyKey: "k2", action: "escalate", escalateTo: "lead" });
    const stored = JSON.parse(JSON.stringify(log.entries()));
    const edited = JSON.parse(JSON.stringify(stored));
    edited[0].reviewer = "mallory";
    expect(() => DecisionLog.resume(edited)).toThrow(/dec-0001: (entry hash|request hash)/);
    expect(() => DecisionLog.resume([...stored].reverse())).toThrow(/not intact/);
    expect(() => DecisionLog.resume(stored.slice(1))).toThrow(/dec-0002/);
  });

  it("a kill at any point between decisions resumes to the same chain as an uninterrupted run", () => {
    fc.assert(
      fc.property(
        fc.array(fc.record({ key: fc.integer({ min: 0, max: 4 }), action: fc.constantFrom<"accept" | "escalate">("accept", "escalate") }), { minLength: 1, maxLength: 12 }),
        fc.nat(),
        (ops, killAt) => {
          const apply = (log: DecisionLog, subset: typeof ops) =>
            subset.forEach((op) =>
              log.append({ ...base, idempotencyKey: `key-${op.key}-${op.action}`, action: op.action, ...(op.action === "escalate" ? { escalateTo: "lead" } : {}) }),
            );
          const straight = newLog();
          apply(straight, ops);
          const cut = killAt % (ops.length + 1);
          const first = newLog();
          apply(first, ops.slice(0, cut));
          const resumed = DecisionLog.resume(JSON.parse(JSON.stringify(first.entries())), { clock: fixedClock, findings });
          apply(resumed, ops.slice(cut));
          expect(resumed.entries()).toEqual(straight.entries());
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe("idempotency as a property", () => {
  it("n distinct keys give n entries however many times each is replayed, and the chain stays intact", () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 6 }), { minLength: 0, maxLength: 40 }), (keys) => {
        const log = newLog();
        const seen = new Map<number, string>();
        for (const k of keys) {
          const { entry, replayed } = log.append({ ...base, idempotencyKey: `key-${k}`, action: "accept" });
          expect(replayed).toBe(seen.has(k));
          if (seen.has(k)) expect(entry.hash).toBe(seen.get(k));
          else seen.set(k, entry.hash);
        }
        expect(log.entries()).toHaveLength(new Set(keys).size);
        expect(verifyDecisionChain(log.entries())).toEqual([]);
      }),
      { numRuns: 200 },
    );
  });
});

describe("chain verification", () => {
  const log = newLog();
  log.append({ ...base, idempotencyKey: "k1", action: "accept" });
  log.append({ ...base, claimId: "c2", findingId: "f2", idempotencyKey: "k2", action: "escalate", escalateTo: "lead" });
  const entries = log.entries();

  it("names the entry for each kind of damage", () => {
    const copy = () => JSON.parse(JSON.stringify(entries));
    const a = copy();
    a[1].prevHash = GENESIS_HASH;
    expect(verifyDecisionChain(a)).toEqual([{ item: "dec-0002", reason: "previous-entry hash does not match: an entry before this one was removed, reordered or changed" }, { item: "dec-0002", reason: "entry hash does not match its content" }]);
    const b = copy();
    b[0].resultingState = "escalated";
    expect(verifyDecisionChain(b).map((p) => p.reason)).toContain("action accept cannot result in state escalated");
    const c = copy();
    c[0].note = "added later";
    expect(verifyDecisionChain(c)[0]).toEqual({ item: "dec-0001", reason: "entry hash does not match its content" });
    const d = copy();
    d[0] = { junk: true };
    expect(verifyDecisionChain(d)[0]?.reason).toMatch(/malformed decision entry/);
  });
});

describe("a finding is never rewritten", () => {
  const replacement = () => FindingSchema.parse({ ...findings[0], id: "f1b", label: "SUPPORTED_FOR_SCOPE", computedAt: "2026-10-28T10:00:00.000Z" });

  it("adds a new finding that points at the old one with a reason, and leaves the old one as it was", () => {
    const before = JSON.stringify(findings);
    const next = supersedeFinding(findings, "f1", replacement(), "  vendor supplied the older-adult study  ");
    expect(JSON.stringify(findings)).toBe(before);
    expect(next).toHaveLength(3);
    expect(next[0]).toBe(findings[0]);
    expect(next[2]).toMatchObject({ id: "f1b", supersedes: "f1", supersedesReason: "vendor supplied the older-adult study" });
    expect(currentFindings(next).map((f) => f.id)).toEqual(["f2", "f1b"]);
  });

  it("refuses: no reason, unknown finding, reused id, other claim, a second replacement of the same finding", () => {
    expect(() => supersedeFinding(findings, "f1", replacement(), "  ")).toThrow(/needs a reason/);
    expect(() => supersedeFinding(findings, "f-none", replacement(), "x")).toThrow(/does not exist/);
    expect(() => supersedeFinding(findings, "f1", { ...replacement(), id: "f2" }, "x")).toThrow(/ids are never reused/);
    expect(() => supersedeFinding(findings, "f1", { ...replacement(), claimId: "c2" }, "x")).toThrow(/is for claim c2/);
    const once = supersedeFinding(findings, "f1", replacement(), "x");
    expect(() => supersedeFinding(once, "f1", { ...replacement(), id: "f1c" }, "y")).toThrow(SupersessionError);
  });
});
