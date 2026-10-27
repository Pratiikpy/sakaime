import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { PortError } from "../../src/ports/index.ts";
import { IdempotencyConflictError } from "../../src/dossier/index.ts";
import { dossierSigner } from "../../src/service/bundle.ts";
import { readRecordedRun, recordedRun, serialiseRun } from "../../src/service/sample-run.ts";
import { resolveTarget } from "../../src/service/faults.ts";
import type { SakaimeService } from "../../src/service/service.ts";
import { CASE_IDS, sampleService } from "./helpers.ts";

let svc: SakaimeService;
let twin: SakaimeService;

beforeAll(async () => {
  svc = await sampleService();
  twin = await sampleService();
  for (const id of CASE_IDS) {
    await svc.ensureRun(id);
    await twin.ensureRun(id);
  }
}, 240_000);

describe("sample mode is deterministic", () => {
  it("two independent runs agree byte for byte on labels, relations, queries and record hashes", () => {
    const a = recordedRun(CASE_IDS.map((id) => svc.recordOf(id)!.result));
    const b = recordedRun(CASE_IDS.map((id) => twin.recordOf(id)!.result));
    expect(serialiseRun(a)).toBe(serialiseRun(b));
    expect(a.digest).toBe(b.digest);
  });

  it("and agree with the committed recorded run", () => {
    const committed = readRecordedRun(svc.config.dirs.sampleRun)!;
    expect(committed).toBeDefined();
    expect(serialiseRun(recordedRun(CASE_IDS.map((id) => svc.recordOf(id)!.result)))).toBe(serialiseRun(committed));
  });

  it("builds the same dossier bytes as the committed examples", async () => {
    for (const id of CASE_IDS) {
      const d = await svc.dossier(id);
      const committed = readFileSync(join(svc.config.dirs.outputs, "dossiers", `${id}.dossier.json`), "utf8");
      expect(d.contents, id).toBe(committed);
    }
  });

  it("stamps every record of a replay with the recording's date, not the clock", () => {
    const wb = svc.recordOf("eyeart-k200667")!.result.wb;
    for (const e of wb.extracted.values()) expect(e.stored.retrievedAt.startsWith("2026-10-27")).toBe(true);
  });
});

describe("dossier", () => {
  it("is exported only with a contract Scout signed for this case, and verifies offline with the compiler re-run", async () => {
    const d = await svc.dossier("eyeart-k200667", "Reviewer A");
    expect(d.exportId).toMatch(/^export-/);
    const v = await svc.verify(d.bundle);
    expect(v.ok).toBe(true);
    expect(v.keyKind).toBe("demo");
    expect(v.signatureNote).toMatch(/does not show that any finding is clinically correct/);
    expect(v.checks.find((c) => c.name === "findings.recompute")!.ok).toBe(true);
    expect(v.checks.find((c) => c.name === "anchors.quote")!.ok).toBe(true);
  });

  it("a second export of the same dossier is the same export, not a second one", async () => {
    const a = await svc.dossier("lunit-k211733", "Reviewer A");
    const b = await svc.dossier("lunit-k211733", "Reviewer A");
    expect(b.exportId).toBe(a.exportId);
    expect(b.replayed).toBe(true);
  });

  it("fails on one changed byte and names the item", async () => {
    const d = await svc.dossier("transpara-k221347");
    const bundle = JSON.parse(d.contents);
    bundle.body.snapshots[0].text += " ";
    const v = await svc.verify(bundle);
    expect(v.ok).toBe(false);
    expect(v.failures[0]!.item).toMatch(/^snapshots\//);
  });

  it("fails on a changed label even when the manifest is re-signed, because the compiler is re-run", async () => {
    const d = await svc.dossier("transpara-k221347");
    const bundle = JSON.parse(d.contents);
    const { buildDossier } = await import("../../src/dossier/index.ts");
    const body = structuredClone(bundle.body);
    body.findings[0].label = "SUPPORTED_FOR_SCOPE";
    const forged = buildDossier({ ...body, decisions: body.decisionHistory }, { signer: dossierSigner(svc.config), clock: { now: () => new Date("2026-10-27T12:00:00.000Z") } });
    const v = await svc.verify(forged);
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.reason).join(" ")).toMatch(/compiler on the recorded inputs gives INSUFFICIENT_EVIDENCE/);
  });

  it("answers something that is not a bundle with a failed check that says what a dossier is, the same for every kind of non-dossier", async () => {
    const answers = await Promise.all([null, [1, 2], 7, "text", {}, { format: "sakaime.dossier" }].map((x) => svc.verify(x)));
    for (const v of answers) {
      expect(v.ok).toBe(false);
      expect(v.failures.length).toBeGreaterThan(0);
      expect(v.keyKind).toBe("demo");
    }
    expect(answers[0]!.failures[0]!.reason).toMatch(/not a dossier/);
    expect(answers[1]!.failures[0]!.reason).toMatch(/an array/);
  });

  it("is still exported after more guard calls than the old request limit, and after many exports by other reviewers", async () => {
    // The replay clock moves one millisecond per reading, so a limit counted against it would never refill. The guard counts real time.
    for (let i = 0; i < 80; i += 1) await svc.screen({ text: i % 3 ? "Certify that K200667 is safe for our hospital." : "Does the evidence cover version 2.1.0 in primary care?", origin: "reviewer" }, "Reviewer Q");
    for (const who of ["Reviewer R", "Reviewer S", "Reviewer T"]) expect((await svc.dossier("transpara-k221347", who)).exportId).toMatch(/^export-/);
    expect((await svc.dossier("transpara-k221347", "Reviewer Q")).exportId).toMatch(/^export-/);
  }, 120_000);

  it("is refused with a reason and a wait, not a bare 403, when a reviewer asks for exports faster than the limit", async () => {
    const who = "Reviewer Fast";
    let refused: unknown;
    for (let i = 0; i < 20 && !refused; i += 1) await svc.dossier("lunit-k211733", who).catch((e: unknown) => (refused = e));
    expect(refused).toBeInstanceOf(PortError);
    expect(refused).toMatchObject({ failure: "BLOCKED", detail: { reason: "RATE_LIMITED" } });
    expect((refused as PortError).detail?.["retryAfterSeconds"]).toBeGreaterThan(0);
    expect((refused as PortError).message).toMatch(/Try again in \d+ seconds?/);
  }, 120_000);
});

describe("the Applicability Lab recomputes without a model call", () => {
  it("changing the software release recomputes and shows which dimension moved", async () => {
    const r = await svc.recompute("eyeart-k200667", { patch: { versions: ["2.2.0"] } }, "CLM-EA-01");
    expect(r.modelCalled).toBe(false);
    expect(r.changed.map((c) => c.dimension)).toContain("version");
    expect(r.changed.find((c) => c.dimension === "version")).toMatchObject({ before: "CONTAINED", after: "DISJOINT" });
    expect(r.before.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(r.after.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(r.labelChanged).toBe(true);
    expect(r.reasons).toHaveLength(7);
  });

  it("an unchanged patch changes nothing", async () => {
    const r = await svc.recompute("eyeart-k200667", { patch: {} }, "CLM-EA-01");
    expect(r.labelChanged).toBe(false);
    expect(r.changed).toEqual([]);
  });

  it("narrowing the setting to the one the studies ran in changes the setting dimension and nothing is sent to a model", async () => {
    const r = await svc.recompute("eyeart-k200667", { patch: { settings: ["emergency_department"] } }, "CLM-EA-01");
    expect(r.changed.find((c) => c.dimension === "setting")).toMatchObject({ before: "CONTAINED", after: "DISJOINT" });
  });

  it("reading the evidence as of a date before the study began leaves the study out", async () => {
    const now = await svc.recompute("eyeart-k200667", { patch: {} }, "CLM-EA-01");
    const early = await svc.recompute("eyeart-k200667", { patch: {}, asOf: "2016-01-01" }, "CLM-EA-01");
    expect(early.before.id).not.toBe(now.before.id);
  });

  it("refuses junk with a typed error and does not recompute", async () => {
    await expect(svc.recompute("eyeart-k200667", { patch: { versions: [] as never, population: { age: { min: 40, max: 18 } } } as never })).rejects.toBeDefined();
    await expect(svc.recompute("eyeart-k200667", { patch: {} }, "NOPE")).rejects.toMatchObject({ failure: "INVALID", detail: { reason: "UNKNOWN_CLAIM" } });
    await expect(svc.recompute("no-such-case", { patch: {} })).rejects.toMatchObject({ detail: { reason: "UNKNOWN_CASE" } });
    await expect(svc.recompute("eyeart-k200667", { patch: {}, asOf: "yesterday" })).rejects.toMatchObject({ failure: "INVALID" });
  });
});

describe("reviewer decisions are idempotent", () => {
  it("records a decision once, replays it on the same key, and refuses the same key with a different decision", async () => {
    const fid = svc.recordOf("eyeart-k200667")!.result.results.find((r) => r.claim.id === "CLM-EA-07")!.finding.id; // the labelled population: a narrower scope
    const first = await svc.decide("eyeart-k200667", { findingId: fid, action: "narrow", idempotencyKey: "decision-key-0001", note: "use for 22 and over" }, "Reviewer A");
    expect(first.replayed).toBe(false);
    expect(first.reviewerState).toBe("narrowed");
    const again = await svc.decide("eyeart-k200667", { findingId: fid, action: "narrow", idempotencyKey: "decision-key-0001", note: "use for 22 and over" }, "Reviewer A");
    expect(again.replayed).toBe(true);
    expect(again.entry.hash).toBe(first.entry.hash);
    expect(svc.recordOf("eyeart-k200667")!.decisions.entries()).toHaveLength(1);
    await expect(svc.decide("eyeart-k200667", { findingId: fid, action: "escalate", idempotencyKey: "decision-key-0001" }, "Reviewer A")).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it("the decision appears in the case view and in the dossier's decision history, and the stored finding is unchanged", async () => {
    const detail = await svc.caseDetail("eyeart-k200667");
    expect(detail.findings.find((f) => f.claimId === "CLM-EA-07")!.reviewerState).toBe("narrowed");
    expect(detail.findings.filter((f) => f.reviewerState !== "unreviewed")).toHaveLength(1);
    expect(detail.timeline.some((e) => e.kind === "decision")).toBe(true);
    const d = await svc.dossier("eyeart-k200667");
    expect(d.bundle.body.decisionHistory).toHaveLength(1);
    expect(d.bundle.body.findings.every((f) => f.reviewerState === "unreviewed")).toBe(true);
    expect((await svc.verify(d.bundle)).ok).toBe(true);
  });

  it("will not narrow a finding that has no narrower supported scope, or decide on a finding that is not the case's", async () => {
    const fid = svc.recordOf("lunit-k211733")!.result.results[1]!.finding.id; // INSUFFICIENT_EVIDENCE
    await expect(svc.decide("lunit-k211733", { findingId: fid, action: "narrow", idempotencyKey: "decision-key-0002" })).rejects.toMatchObject({ detail: { reason: "NO_NARROWER_SCOPE" } });
    await expect(svc.decide("lunit-k211733", { findingId: "fnd_nothing", action: "accept", idempotencyKey: "decision-key-0003" })).rejects.toMatchObject({ detail: { reason: "UNKNOWN_FINDING" } });
    const evidence = await svc.decide("lunit-k211733", { findingId: fid, action: "request_evidence", idempotencyKey: "decision-key-0004" });
    expect(evidence.entry.requestedDimensions!.length).toBeGreaterThan(0);
  });
});

describe("link confirmation is a reviewer decision with an idempotency key", () => {
  it("confirming a candidate link admits its record on the next run, once", async () => {
    const rec = await svc.ensureRun("transpara-k221347");
    const target = rec.result.wb.links!.links.find((l) => l.link.type === "STUDY_EVALUATES" && l.link.from === "pubmed:39904652")!;
    expect(target.link.state).toBe("AMBIGUOUS");
    const out = await svc.decideLink("transpara-k221347", target.link.id, "CONFIRM", "Reviewer A", "link-key-0001", "the paper reports the MASAI trial of version 1.7.0");
    expect(out.replayed).toBe(false);
    expect(out.link.state).toBe("CONFIRMED");
    expect(out.result.wb.links!.admitted.has("pubmed:39904652")).toBe(true);
    const study = out.result.wb.assembled!.items.find((i) => i.scope.versions?.includes("1.7.0"));
    expect(study?.limitations.join(" ")).toMatch(/attributed to device:fda:K221347 through confirmed link/);
    const again = await svc.decideLink("transpara-k221347", target.link.id, "CONFIRM", "Reviewer A", "link-key-0001", "the paper reports the MASAI trial of version 1.7.0");
    expect(again.replayed).toBe(true);
    await expect(svc.decideLink("transpara-k221347", target.link.id, "REJECT", "Reviewer A", "link-key-0001")).rejects.toMatchObject({ failure: "INVALID" });
    await expect(svc.decideLink("transpara-k221347", "lnk-nothing", "CONFIRM", "Reviewer A", "link-key-0002")).rejects.toMatchObject({ detail: { reason: "UNKNOWN_LINK" } });
  });
});

describe("views", () => {
  it("the timeline lists dated facts and honours asOf", async () => {
    const all = await svc.timeline("eyeart-k200667");
    expect(all.length).toBeGreaterThan(3);
    const before2018 = await svc.timeline("eyeart-k200667", "2018-01-01");
    expect(before2018.length).toBeLessThan(all.length);
    expect(before2018.every((e) => e.at <= "2018-01-01T23:59:59.999Z")).toBe(true);
    await expect(svc.timeline("eyeart-k200667", "2018/01/01")).rejects.toMatchObject({ failure: "INVALID" });
  });

  it("the case detail carries the matrix with the silo each column came from, and a copyable draft that is never sent", async () => {
    const d = await svc.caseDetail("eyeart-k200667");
    expect(d.matrix!.columns.find((c) => c.name === "k_number")!.sourceId).toBe("registry-snapshots");
    expect(d.matrix!.columns.find((c) => c.name === "claim_id")!.sourceId).toBe("vendor-packets");
    expect(d.matrix!.columns.find((c) => c.name === "case_id")!.sourceId).toBe("hospital");
    expect(d.matrix!.rows).toHaveLength(9);
    expect(d.missingEvidence.length).toBeGreaterThan(0);
    expect(d.missingEvidence[0]!.draft).toMatch(/Nothing in this system sends it/);
    expect(d.summary.claimConstructed).toBe(true);
    expect(d.mode.sample).toBe(true);
    expect(d.mode.federation).toBe("cassette");
  });

  it("every claim of the case is in the detail with its own sentence, the reviewer's question first", async () => {
    const d = await svc.caseDetail("eyeart-k200667");
    expect(d.claims.map((c) => c.id)).toEqual(["CASE-2026-014.intended", ...Array.from({ length: 9 }, (_, i) => `CLM-EA-0${i + 1}`)]);
    for (const c of d.claims) expect(c.text, c.id).toBeTruthy();
    expect(d.claims[0]!.text).toBe(d.claimText);
    expect(d.claims[1]!.text).toMatch(/^In the population of the pivotal study/);
    expect(d.claims.find((c) => c.id === "CLM-EA-09")!.performance).toMatchObject({ metric: "sensitivity", atLeast: 0.96 });
    expect(d.findings.map((f) => f.claimId)).toEqual(d.claims.map((c) => c.id));
  });

  it("the source rows say a failed source failed, and say an empty answer is empty", async () => {
    const down = await sampleService();
    await down.investigate("eyeart-k200667", { faults: { drill: "source_off", target: resolveTarget("europepmc", []) } });
    const rows = await down.sourceRows();
    const epmc = rows.find((r) => r.source.id === "europepmc")!;
    expect(epmc.source.health).toBe("UNAVAILABLE");
    expect(epmc.healthDetail).toMatch(/UNAVAILABLE/);
    expect(rows.find((r) => r.source.id === "openfda-510k")!.source.health).toBe("OK");

    const empty = await sampleService();
    await empty.investigate("eyeart-k200667", { faults: { drill: "source_empty", target: resolveTarget("europepmc", []) } });
    const e = (await empty.sourceRows()).find((r) => r.source.id === "europepmc")!;
    expect(e.source.health).toBe("EMPTY");
    expect(e.healthDetail).toMatch(/says nothing about whether any exist/);

    const healthy = (await svc.sourceRows()).find((r) => r.source.id === "europepmc")!;
    expect(healthy.source.health).toBe("OK");
    expect((await svc.sourceRows()).find((r) => r.source.id === "hospital-policy")!.zetarisName).toMatch(/hospital\.requirements/);
  });

  it("an unknown case is a typed not-found", async () => {
    await expect(svc.caseDetail("no-such-case")).rejects.toMatchObject({ failure: "INVALID", detail: { reason: "UNKNOWN_CASE" } });
  });
});
