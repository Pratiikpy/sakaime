import { beforeEach, describe, expect, it } from "vitest";
import type { SakaimeService } from "../../src/service/service.ts";
import { sampleService } from "./helpers.ts";

const CASE = "eyeart-k200667";

let svc: SakaimeService;
beforeEach(async () => {
  svc = await sampleService();
  await svc.ensureRun(CASE);
}, 240_000);

const findingOf = (claimId: string) => svc.recordOf(CASE)!.result.results.find((r) => r.claim.id === claimId)!.finding;

/** A re-run in which the pivotal study's registry record has been revised: the evidence moves, so findings that rest on it do too. */
const rerunWithRevisedRegistryRecord = async () => {
  const run = svc.recordOf(CASE)!.result;
  const admitted = run.wb.studies.find((s) => run.wb.links?.admitted.has(`ctgov:${s.study?.nctId}`))!;
  return svc.investigate(CASE, { mutations: { registryRevision: { nctId: admitted.study!.nctId, minimumAge: "22 Years", revisedOn: "2026-10-28" } }, coreOnly: true });
};

describe("finding ids are the same for the same inputs", () => {
  it("investigating a case again against the same records and policy gives the same finding ids", async () => {
    const before = svc.recordOf(CASE)!.result.results.map((r) => r.finding.id);
    const again = await svc.investigate(CASE, { coreOnly: true });
    expect(again.results.map((r) => r.finding.id)).toEqual(before);
    for (const r of again.results) expect(r.finding.dependsOnFacts, r.claim.id).toEqual(svc.recordOf(CASE)!.result.results.find((x) => x.claim.id === r.claim.id)!.finding.dependsOnFacts);
  });

  it("a hospital policy row that was read in an earlier run keeps the fact it was given, so the requirement items do not change the id", async () => {
    const policy = (r: { wb: { world: { facts: { sourceId: string; factId: string }[] } } }) => r.wb.world.facts.filter((f) => f.sourceId === "hospital-policy").map((f) => f.factId).sort();
    const first = policy(svc.recordOf(CASE)!.result);
    expect(first.length).toBeGreaterThan(0);
    expect(policy(await svc.investigate(CASE, { coreOnly: true }))).toEqual(first);
  });
});

describe("a decision survives a re-run that reproduces the finding", () => {
  it("keeps the reviewer state and the decision, and the dossier still verifies with no superseded finding", async () => {
    const f = findingOf("CLM-EA-01");
    await svc.decide(CASE, { findingId: f.id, action: "accept", idempotencyKey: "history-key-0001", note: "the claim is the population studied" }, "Reviewer A");

    await svc.investigate(CASE, { coreOnly: true });

    expect(findingOf("CLM-EA-01").id).toBe(f.id);
    const detail = await svc.caseDetail(CASE);
    expect(detail.findings.find((x) => x.id === f.id)!.reviewerState).toBe("accepted");
    const d = await svc.dossier(CASE, "Reviewer A");
    expect(d.bundle.body.decisionHistory).toHaveLength(1);
    expect(d.bundle.body.findings.some((x) => x.supersedes !== undefined)).toBe(false);
    const v = await svc.verify(d.bundle);
    expect(v.failures, JSON.stringify(v.failures)).toEqual([]);
    expect(v.ok).toBe(true);
  }, 120_000);
});

describe("a decision on a finding that a re-run replaced stays in the dossier, with the finding", () => {
  it("lists the decided finding as superseded, with the reason, and the dossier verifies", async () => {
    const decided = findingOf("CLM-EA-01");
    const other = findingOf("CLM-EA-07");
    await svc.decide(CASE, { findingId: decided.id, action: "accept", idempotencyKey: "history-key-0002", note: "as studied" }, "Reviewer A");
    await svc.decide(CASE, { findingId: other.id, action: "narrow", idempotencyKey: "history-key-0003" }, "Reviewer A");

    await rerunWithRevisedRegistryRecord();

    // The evidence behind the claim changed, so the finding has a new id and starts unreviewed.
    const now = findingOf("CLM-EA-01");
    expect(now.id).not.toBe(decided.id);
    const detail = await svc.caseDetail(CASE);
    expect(detail.findings.find((x) => x.claimId === "CLM-EA-01")!.reviewerState).toBe("unreviewed");
    expect(detail.timeline.some((e) => e.kind === "finding_recomputed" && /CLM-EA-01/.test(e.summary))).toBe(true);

    // The decision log is untouched, and the dossier holds the finding the decision is about.
    const d = await svc.dossier(CASE, "Reviewer A");
    const body = d.bundle.body;
    expect(body.decisionHistory.map((x) => x.findingId).sort()).toEqual([decided.id, other.id].sort());
    const old = body.findings.find((x) => x.id === decided.id)!;
    expect(old, "the decided finding is in the dossier").toBeDefined();
    expect(old.label).toBe(decided.label);
    const replacement = body.findings.find((x) => x.supersedes === decided.id)!;
    expect(replacement.id).toBe(now.id);
    expect(replacement.supersedesReason).toMatch(/investigated again/);
    expect(replacement.supersedesReason).not.toMatch(/fnd_|fact_|ev-/);
    expect(body.compilerRuns.map((c) => c.findingId)).toContain(decided.id);
    expect(body.findings.every((x) => x.reviewerState === "unreviewed")).toBe(true);

    const v = await svc.verify(d.bundle);
    expect(v.failures, JSON.stringify(v.failures)).toEqual([]);
    expect(v.ok).toBe(true);
    expect(v.checks.find((c) => c.name === "findings.recompute")!.ok).toBe(true);
    expect(v.checks.find((c) => c.name === "findings.supersession")!.ok).toBe(true);
  }, 120_000);

  it("a second re-run does not lose the first superseded finding", async () => {
    const decided = findingOf("CLM-EA-01");
    await svc.decide(CASE, { findingId: decided.id, action: "accept", idempotencyKey: "history-key-0004" }, "Reviewer A");
    await rerunWithRevisedRegistryRecord();
    await svc.investigate(CASE, { coreOnly: true, mutations: { registryRevision: { nctId: svc.recordOf(CASE)!.result.wb.studies.find((s) => s.study)!.study!.nctId, minimumAge: "25 Years", revisedOn: "2026-10-29" } } });

    const d = await svc.dossier(CASE, "Reviewer A");
    expect(d.bundle.body.findings.some((x) => x.id === decided.id)).toBe(true);
    const chain = d.bundle.body.findings.filter((x) => x.claimId === "CLM-EA-01");
    expect(chain.length).toBeGreaterThanOrEqual(2);
    expect(chain[0]!.supersedes).toBeUndefined();
    chain.slice(1).forEach((x, i) => expect(x.supersedes, x.id).toBe(chain[i]!.id));
    expect((await svc.verify(d.bundle)).ok).toBe(true);
  }, 120_000);

  it("a finding nobody decided on is replaced without being kept, and the old id cannot be decided on", async () => {
    const undecided = findingOf("CLM-EA-03");
    await rerunWithRevisedRegistryRecord();
    const d = await svc.dossier(CASE, "Reviewer A");
    expect(d.bundle.body.findings.some((x) => x.id === undecided.id)).toBe(false);
    await expect(svc.decide(CASE, { findingId: undecided.id, action: "accept", idempotencyKey: "history-key-0005" })).rejects.toMatchObject({ detail: { reason: "UNKNOWN_FINDING" } });
  }, 120_000);
});
