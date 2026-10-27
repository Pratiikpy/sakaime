import { describe, expect, it } from "vitest";
import { HMEM, type MemoryRecord } from "../../../src/engines/hmem/index.ts";
import { DAY, T0, actions, manualClock, memory, rm, tempDir } from "./helpers.ts";

const ids = (rs: MemoryRecord[]) => rs.map((r) => r.id);

describe("sleep previews first", () => {
  it("preview changes nothing, writes nothing to the ledger and explains each action", () => {
    const { hmem, time } = memory();
    const old = hmem.add({ content: "random one-off note about parking near the office", source: "chat" });
    time.advanceDays(40);
    const ledger = hmem.ledger.all().length;
    const before = JSON.stringify(hmem.store.all());
    const p = hmem.sleep.preview();
    expect(JSON.stringify(hmem.store.all())).toBe(before);
    expect(hmem.ledger.all()).toHaveLength(ledger);
    expect(p.toArchive).toEqual([old.id]);
    const action = p.actions.find((a) => a.action === "archive")!;
    expect(action).toMatchObject({ ids: [old.id], expectedLedger: "sleep_archive", ageDays: 40 });
    expect(action.reason).toMatch(/40 days old, 0 accesses/);
    expect(action.guardrails.every((g) => g.status === "clear")).toBe(true);
    expect(action.guardrails.map((g) => g.name)).toEqual(expect.arrayContaining(["relationship-hub", "unresolved-conflict", "pending-review", "high-confidence"]));
  });

  it("archives old, rarely used, unreferenced records; the ledger keeps the full previous state and a backup exists", () => {
    const { hmem, time } = memory();
    const old = hmem.add({ content: "random one-off note about parking near the office", source: "chat" });
    time.advanceDays(40);
    const report = hmem.sleep.execute(hmem.sleep.preview());
    expect(report).toMatchObject({ archived: 1, consolidated: 0, synthesized: 0, skipped: [] });
    expect(hmem.store.get(old.id)).toBeUndefined();
    const entry = hmem.ledger.history(old.id).at(-1)!;
    expect(entry).toMatchObject({ action: "sleep_archive", details: { backupId: report.backupId } });
    expect(entry.previousState?.content).toContain("parking");
    expect(report.ledgerIds.length).toBeGreaterThan(0);
  });
});

describe("archive guardrails", () => {
  function aged(setup: (h: HMEM) => MemoryRecord): { hmem: HMEM; target: MemoryRecord } {
    const { hmem, time } = memory();
    const target = setup(hmem);
    time.advanceDays(40);
    return { hmem, target };
  }
  const protectedBy = (hmem: HMEM, id: string) => hmem.sleep.preview().protectedFromArchive.find((p) => p.id === id)?.guardrail;

  it("a record that replaces another is protected", () => {
    const { hmem, target } = aged((h) => {
      const old = h.add({ content: "old policy text", source: "t" });
      return h.add({ content: "new policy text", source: "t", supersedes: old.id });
    });
    expect(protectedBy(hmem, target.id)).toBe("superseding-or-current");
  });

  it("a derived record is protected", () => {
    const { hmem, target } = aged((h) => h.add({ content: "derived insight", source: "dreaming", derivedFrom: ["mem-x"] }));
    expect(protectedBy(hmem, target.id)).toBe("derived-or-synthesized");
  });

  it("a hub with three or more related records is protected", () => {
    const { hmem, target } = aged((h) => {
      const hub = h.add({ content: "Postgres hub note", source: "t", entities: ["postgres"], tags: ["tech:x"] });
      for (let i = 0; i < 3; i++) h.add({ content: `Postgres satellite ${i}`, source: "t", entities: ["postgres"], tags: ["tech:x"] });
      return hub;
    });
    expect(target.relatedTo.length).toBeGreaterThanOrEqual(3);
    // Satellites reference the hub, so it is also "referenced": either way it must stay.
    expect(hmem.sleep.preview().toArchive).not.toContain(target.id);
  });

  it("a record in an open conflict is protected", () => {
    const { hmem, target } = aged((h) => {
      const a = h.add({ content: "always enable telemetry uploads for diagnostics", source: "t", confidence: 0.6 });
      h.add({ content: "never enable telemetry uploads for diagnostics", source: "t", confidence: 0.6 });
      h.conflicts.scan();
      return a;
    });
    expect(protectedBy(hmem, target.id)).toBe("unresolved-conflict");
  });

  it("a record awaiting review is protected", () => {
    const { hmem, target } = aged((h) => {
      const a = h.add({ content: "a record a reviewer flagged", source: "t" });
      h.feedback(a.id, "wrong");
      return a;
    });
    expect(protectedBy(hmem, target.id)).toBe("pending-review");
  });

  it("a record at or above the confidence threshold is protected, so reviewer-confirmed precedents are not archived", () => {
    const { hmem, target } = aged((h) => h.add({ content: "a confirmed institutional precedent", source: "t", sourceTier: "reviewer" }));
    expect(target.confidence).toBe(0.85);
    expect(protectedBy(hmem, target.id)).toBe("high-confidence");
    const { hmem: lax } = memory({ protectConfidence: 0.95 });
    expect(lax.sleep.preview().protectedFromArchive).toEqual([]);
  });

  it("a record that is used or referenced is not an archive candidate at all", () => {
    const { hmem, time } = memory();
    const used = hmem.add({ content: "frequently used note", source: "t", entities: ["postgres"], tags: ["tech:a"] });
    for (let i = 0; i < 3; i++) hmem.feedback(used.id, "helpful");
    const cited = hmem.add({ content: "cited note", source: "t" });
    hmem.add({ content: "derived from the cited note", source: "t", derivedFrom: [cited.id] });
    time.advanceDays(40);
    const p = hmem.sleep.preview();
    expect(p.toArchive).not.toContain(used.id);
    expect(p.toArchive).not.toContain(cited.id);
  });
});

describe("execute runs exactly what a fresh preview contains", () => {
  it("a record that became ineligible after the preview is skipped and reported, not archived", () => {
    const { hmem, time } = memory();
    const a = hmem.add({ content: "note about the parking lot closure schedule", source: "t" });
    const b = hmem.add({ content: "note about the quarterly tax filing deadline", source: "t" });
    time.advanceDays(40);
    const plan = hmem.sleep.preview();
    expect(plan.toArchive.sort()).toEqual([a.id, b.id].sort());
    for (let i = 0; i < 3; i++) hmem.feedback(b.id, "helpful");
    const report = hmem.sleep.execute(plan);
    expect(report.archived).toBe(1);
    expect(hmem.store.get(a.id)).toBeUndefined();
    expect(hmem.store.get(b.id)).toBeDefined();
    expect(report.skipped).toEqual([{ action: "archive", ids: [b.id], reason: expect.stringMatching(/no longer eligible/) }]);
  });

  it("a forged plan cannot archive a record that was never eligible", () => {
    const { hmem, time } = memory();
    const young = hmem.add({ content: "fresh note about this week's agenda", source: "t" });
    time.advanceDays(1);
    const forged = { ...hmem.sleep.preview(), toArchive: [young.id], toConsolidate: [young.id], toSynthesize: [[young.id, "mem-404"]] };
    const report = hmem.sleep.execute(forged);
    expect(report).toMatchObject({ archived: 0, consolidated: 0, synthesized: 0 });
    expect(report.skipped).toHaveLength(3);
    expect(hmem.store.get(young.id)).toBeDefined();
  });

  it("executing with no plan previews and runs in one step", () => {
    const { hmem, time } = memory();
    hmem.add({ content: "random one-off note about parking near the office", source: "t" });
    time.advanceDays(40);
    expect(hmem.sleep.execute().archived).toBe(1);
  });
});

describe("consolidation", () => {
  it("promotes short-term and working records not accessed for seven days; not younger ones, not review-flagged ones", () => {
    const { hmem, time } = memory();
    const st = hmem.add({ content: "short term note about meeting rooms", source: "t", layer: "short_term" });
    const wk = hmem.add({ content: "working note about badge access", source: "t", layer: "working" });
    const lt = hmem.add({ content: "long term note about holidays", source: "t", layer: "long_term" });
    const flagged = hmem.add({ content: "flagged note about expenses", source: "t", layer: "working" });
    hmem.feedback(flagged.id, "wrong");
    time.advanceDays(6);
    expect(hmem.sleep.preview().toConsolidate).toEqual([]);
    time.advanceDays(2);
    expect(hmem.sleep.preview().toConsolidate.sort()).toEqual([st.id, wk.id].sort());
    hmem.sleep.execute();
    expect([st.layer, wk.layer, lt.layer, flagged.layer]).toEqual(["long_term", "long_term", "long_term", "working"]);
    expect(actions(hmem, st.id)).toEqual(["create", "sleep_consolidate"]);
    expect(hmem.ledger.history(st.id)[1]).toMatchObject({ previousState: { layer: "short_term" }, newState: { layer: "long_term" } });
  });
});

describe("synthesis", () => {
  const text = "The board requires prospective validation for triage devices";

  it("merges near-identical records into one derived record in the lowest confidence of the group, keeping the sources marked superseded", () => {
    const { hmem } = memory();
    const a = hmem.add({ content: text, source: "a", confidence: 0.9, organizationId: "h" });
    const b = hmem.add({ content: text, source: "b", confidence: 0.6, organizationId: "h" });
    const report = hmem.sleep.execute();
    expect(report.synthesized).toBe(1);
    const merged = hmem.store.all().find((m) => m.derivedFrom?.length)!;
    expect(merged).toMatchObject({ content: text, confidence: 0.6, layer: "long_term", organizationId: "h", derivedFrom: [a.id, b.id] });
    expect([a.supersededBy, b.supersededBy]).toEqual([merged.id, merged.id]);
    expect(hmem.store.get(a.id)).toBeDefined();
    expect(actions(hmem, merged.id)).toEqual(["create", "sleep_synthesize"]);
    expect(actions(hmem, a.id).at(-1)).toBe("merge");
    // The result is stable: a second sleep finds nothing new to synthesize.
    expect(hmem.sleep.preview().toSynthesize).toEqual([]);
  });

  it("never combines records of different organizations, different cases or different types", () => {
    const { hmem } = memory();
    hmem.add({ content: text, source: "a", organizationId: "hospital-a" });
    hmem.add({ content: text, source: "b", organizationId: "hospital-b" });
    hmem.add({ content: text, source: "c", organizationId: "hospital-a", caseId: "case-1" });
    hmem.add({ content: text, source: "d", organizationId: "hospital-a", type: "preference" });
    expect(hmem.sleep.preview().toSynthesize).toEqual([]);
    hmem.add({ content: text, source: "e", organizationId: "hospital-a" });
    const groups = hmem.sleep.preview().toSynthesize;
    expect(groups).toHaveLength(1);
    expect(groups[0]!.map((id) => hmem.store.get(id)!.organizationId)).toEqual(["hospital-a", "hospital-a"]);
  });

  it("leaves out superseded, derived, review-flagged and conflicted records", () => {
    const { hmem } = memory();
    const keep = hmem.add({ content: text, source: "a" });
    const keep2 = hmem.add({ content: text, source: "b" });
    const flagged = hmem.add({ content: text, source: "c" });
    hmem.feedback(flagged.id, "wrong");
    hmem.add({ content: text, source: "d", derivedFrom: ["mem-x"] });
    const old = hmem.add({ content: text, source: "e" });
    hmem.add({ content: "something newer", source: "f", supersedes: old.id });
    expect(hmem.sleep.preview().toSynthesize).toEqual([[keep.id, keep2.id]]);
  });

  it("can delete its sources instead, if configured, with a ledger entry for each", () => {
    const { hmem } = memory({ sourceDisposition: "delete" });
    const a = hmem.add({ content: text, source: "a" });
    const b = hmem.add({ content: text, source: "b" });
    hmem.sleep.execute();
    expect(hmem.store.get(a.id)).toBeUndefined();
    expect(hmem.store.get(b.id)).toBeUndefined();
    expect(actions(hmem, a.id).at(-1)).toBe("merge");
    expect(hmem.ledger.history(a.id).at(-1)!.previousState?.content).toBe(text);
  });

  it("different content is joined and labelled, not passed off as one statement", () => {
    const { hmem } = memory();
    hmem.add({ content: `${text} before deployment in clinical settings`, source: "a" });
    hmem.add({ content: `${text} before release in clinical settings`, source: "b" });
    hmem.sleep.execute();
    const merged = hmem.store.all().find((m) => m.derivedFrom?.length)!;
    expect(merged.content).toMatch(/^Synthesis of 2 records: .* \| /);
  });
});

describe("backups survive a restart", () => {
  it("restore returns records archived after the backup was taken, after the process was restarted", () => {
    const dir = tempDir();
    const t = manualClock();
    const a = new HMEM({ persistDir: dir, clock: t.clock });
    const old = a.add({ content: "random one-off note about parking near the office", source: "t" });
    t.advanceDays(40);
    const report = a.sleep.execute();
    expect(a.store.get(old.id)).toBeUndefined();
    a.close();

    const b = new HMEM({ persistDir: dir, clock: t.clock });
    expect(b.sleep.backups().map((x) => x.id)).toEqual([report.backupId]);
    b.sleep.restore(report.backupId, { by: "operator-1" });
    expect(b.store.get(old.id)?.content).toContain("parking");
    const entry = b.ledger.history("*").at(-1)!;
    expect(entry).toMatchObject({ action: "restore", actor: "operator-1", details: { backupId: report.backupId, restored: 1, recreated: [old.id] } });
    // The earlier history is intact: restore does not erase it.
    expect(actions(b, old.id)).toEqual(["create", "sleep_archive"]);
    // A restored store keeps issuing new ids.
    expect(b.add({ content: "after restore", source: "t" }).id).toBe("mem-2");
    b.close();
    rm(dir);
  });

  it("restore removes records created after the backup, and says which; an unknown backup is refused", () => {
    const { hmem, time } = memory();
    hmem.add({ content: "random one-off note about parking near the office", source: "t" });
    time.advanceDays(40);
    const { backupId } = hmem.sleep.execute();
    const later = hmem.add({ content: "written after the backup", source: "t" });
    hmem.sleep.restore(backupId);
    expect(hmem.store.get(later.id)).toBeUndefined();
    expect(hmem.ledger.history("*").at(-1)!.details).toMatchObject({ removedAfterBackup: [later.id] });
    expect(() => hmem.sleep.restore("backup-404")).toThrowError(/unknown backup/);
  });

  it("restoring leaves no open conflict that points at a record the restore removed", () => {
    const { hmem, time } = memory();
    const { backupId } = (() => {
      hmem.add({ content: "an ordinary record", source: "t" });
      time.advanceDays(1);
      return hmem.sleep.execute();
    })();
    hmem.add({ content: "always enable telemetry uploads for diagnostics", source: "t", confidence: 0.6 });
    hmem.add({ content: "never enable telemetry uploads for diagnostics", source: "t", confidence: 0.6 });
    expect(hmem.conflicts.scan()).toHaveLength(1);
    hmem.sleep.restore(backupId);
    expect(hmem.conflicts.queue()).toEqual([]);
  });

  it("execute with an idempotency key runs once", () => {
    const { hmem, time } = memory();
    hmem.add({ content: "random one-off note about parking near the office", source: "t" });
    time.advanceDays(40);
    const first = hmem.sleep.execute(undefined, { idempotencyKey: "nightly-1" });
    const again = hmem.sleep.execute(undefined, { idempotencyKey: "nightly-1" });
    expect(again).toEqual(first);
    expect(hmem.sleep.backups()).toHaveLength(1);
  });
});

describe("dreaming proposes; a reviewer decides", () => {
  const seed = (hmem: HMEM, org?: string) => {
    const o = org ? { organizationId: org } : {};
    return [
      hmem.add({ content: "Triage tools need prospective validation before use", source: "t", layer: "long_term", confidence: 0.8, tags: ["policy"], ...o }),
      hmem.add({ content: "Triage tools need prospective validation before clinical use", source: "t", layer: "long_term", confidence: 0.8, tags: ["policy"], ...o }),
    ];
  };

  it("proposals do not touch memory; approval creates a long-term derived record with a reviewer and the proposal as lineage", () => {
    const { hmem } = memory({ requireReviewer: true });
    const [a, b] = seed(hmem, "hospital-a");
    const count = hmem.store.all().length;
    const [p] = hmem.dreaming.dream().filter((x) => x.type === "insight");
    expect(hmem.store.all()).toHaveLength(count);
    expect(p).toMatchObject({ status: "proposed", origin: "deterministic", organizationId: "hospital-a" });
    expect(p!.derivedFrom.sort()).toEqual([a!.id, b!.id].sort());
    expect(p!.confidence).toBeGreaterThan(0);
    expect(actions(hmem, p!.id)).toEqual(["dream_proposed"]);

    const created = hmem.dreaming.approve(p!.id, "reviewer-1")!;
    expect(created).toMatchObject({ layer: "long_term", kind: "precedent", organizationId: "hospital-a", source: "dreaming", confidence: 0.75 });
    expect(created.derivedFrom).toEqual(p!.derivedFrom);
    expect(created.provenance).toMatchObject({ origin: "dream", reviewer: "reviewer-1", refs: [p!.id] });
    expect(hmem.dreaming.list().find((x) => x.id === p!.id)).toMatchObject({ status: "approved", decidedBy: "reviewer-1", createdRecord: created.id });
    expect(actions(hmem, p!.id)).toEqual(["dream_proposed", "dream_approved"]);
    expect(hmem.ledger.history(p!.id).at(-1)!.actor).toBe("reviewer-1");
  });

  it("a deployment that requires reviewers refuses an anonymous approval or rejection", () => {
    const { hmem } = memory({ requireReviewer: true });
    seed(hmem);
    const [p] = hmem.dreaming.dream();
    expect(() => hmem.dreaming.approve(p!.id)).toThrowError(/reviewer/);
    expect(() => hmem.dreaming.reject(p!.id, " ")).toThrowError(/reviewer/);
    expect(hmem.dreaming.pending()).toContainEqual(expect.objectContaining({ id: p!.id }));
  });

  it("without that setting the sponsor's one-argument approve still works", () => {
    const { hmem } = memory();
    seed(hmem);
    const [p] = hmem.dreaming.dream().filter((x) => x.type === "insight");
    expect(hmem.dreaming.approve(p!.id)).toBeDefined();
  });

  it("a rejected proposal is logged, creates nothing and is not proposed again", () => {
    const { hmem } = memory();
    seed(hmem);
    const first = hmem.dreaming.dream();
    const before = hmem.store.all().length;
    for (const p of first) hmem.dreaming.reject(p.id, "reviewer-1", "not a policy");
    expect(hmem.store.all()).toHaveLength(before);
    expect(hmem.dreaming.dream()).toEqual([]);
    expect(actions(hmem, first[0]!.id)).toEqual(["dream_proposed", "dream_rejected"]);
    expect(() => hmem.dreaming.approve(first[0]!.id)).toThrowError(/no pending proposal/);
  });

  it("dreaming twice does not duplicate pending proposals", () => {
    const { hmem } = memory();
    seed(hmem);
    const n = hmem.dreaming.dream().length;
    expect(n).toBeGreaterThan(0);
    expect(hmem.dreaming.dream()).toEqual([]);
    expect(hmem.dreaming.pending()).toHaveLength(n);
  });

  it("clusters never cross organizations: identical precedents at two hospitals are not consolidated into one", () => {
    const { hmem } = memory();
    seed(hmem, "hospital-a");
    seed(hmem, "hospital-b");
    const insights = hmem.dreaming.dream().filter((p) => p.type === "insight");
    expect(insights).toHaveLength(2);
    for (const p of insights) {
      const orgs = new Set(p.derivedFrom.map((id) => hmem.store.get(id)!.organizationId));
      expect(orgs.size).toBe(1);
      expect([...orgs][0]).toBe(p.organizationId);
    }
  });

  it("review-flagged, superseded and already derived records are not inputs", () => {
    const { hmem } = memory();
    const [a, b] = seed(hmem);
    hmem.feedback(a!.id, "wrong");
    expect(hmem.dreaming.dream().filter((p) => p.type === "insight")).toEqual([]);
    hmem.retrieval.clearReview(a!.id, "r");
    hmem.add({ content: "replacement text", source: "t", supersedes: b!.id });
    expect(hmem.dreaming.dream().filter((p) => p.type === "insight")).toEqual([]);
  });

  it("a domain proposal reclassifies the source record only when approved", () => {
    const { hmem } = memory();
    const m = hmem.add({ content: "retrospective cohort with sensitivity reported", source: "t", tags: [] });
    m.domain = "general";
    hmem.store.sync();
    const p = hmem.dreaming.dream().find((x) => x.type === "domain");
    expect(p).toMatchObject({ suggestedDomain: "clinical" });
    expect(m.domain).toBe("general");
    expect(hmem.dreaming.approve(p!.id, "r")).toBeUndefined();
    expect(m.domain).toBe("clinical");
    expect(actions(hmem, m.id).at(-1)).toBe("update");
  });

  it("proposals and their decisions survive a restart", () => {
    const dir = tempDir();
    const a = new HMEM({ persistDir: dir, clock: () => T0 });
    seed(a);
    a.add({ content: "prefer short bullet answers", type: "preference", source: "t" });
    a.add({ content: "prefer python for scripting", type: "preference", source: "t" });
    const [p, q] = a.dreaming.dream();
    a.dreaming.reject(q!.id, "r");
    a.close();
    const b = new HMEM({ persistDir: dir, clock: () => T0 });
    expect(b.dreaming.list().map((x) => [x.id, x.status])).toEqual([[p!.id, "proposed"], [q!.id, "rejected"]]);
    expect(b.dreaming.dream()).toEqual([]);
    expect(b.dreaming.approve(p!.id, "r")).toBeDefined();
    b.close();
    rm(dir);
  });

  it("a model can write the text of a proposal; if it fails or answers badly the deterministic text stands", async () => {
    const { hmem } = memory();
    seed(hmem);
    const proposals = await hmem.dreaming.dreamWithModel(async (members, draft) => {
      if (draft.type === "insight") return "Triage tools used at this hospital need prospective validation before clinical use.";
      throw new Error("model unavailable");
    });
    const insight = proposals.find((p) => p.type === "insight")!;
    expect(insight).toMatchObject({ origin: "model", content: "Triage tools used at this hospital need prospective validation before clinical use." });
    const invariant = proposals.find((p) => p.type === "invariant");
    if (invariant) expect(invariant.origin).toBe("deterministic");

    const { hmem: other } = memory();
    seed(other);
    const bad = await other.dreaming.dreamWithModel(async () => "no");
    expect(bad.every((p) => p.origin === "deterministic")).toBe(true);
  });

  it("approving twice with the same idempotency key creates one record", () => {
    const { hmem } = memory();
    seed(hmem);
    const [p] = hmem.dreaming.dream().filter((x) => x.type === "insight");
    const first = hmem.dreaming.approve(p!.id, "r", { idempotencyKey: "approve-1" })!;
    const count = hmem.store.all().length;
    expect(hmem.dreaming.approve(p!.id, "r", { idempotencyKey: "approve-1" })!.id).toBe(first.id);
    expect(hmem.store.all()).toHaveLength(count);
    void DAY;
    void ids;
  });
});
