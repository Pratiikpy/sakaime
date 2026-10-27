import { beforeAll, describe, expect, it } from "vitest";
import { compileDetailed } from "../../src/compiler/index.ts";
import { recomputeFn } from "../../src/service/bundle.ts";
import type { InvestigationResult } from "../../src/agents/investigation.ts";
import { TraceEventSchema } from "../../src/api/contract.ts";
import { resolveTarget } from "../../src/service/faults.ts";
import type { SakaimeService } from "../../src/service/service.ts";
import { CASE_IDS, EXPECTED_LABELS, sampleService } from "./helpers.ts";

let svc: SakaimeService;
const runs = new Map<string, InvestigationResult>();

beforeAll(async () => {
  svc = await sampleService();
  for (const id of CASE_IDS) runs.set(id, await svc.investigate(id));
}, 240_000);

const run = (id: string): InvestigationResult => runs.get(id)!;

describe.each(CASE_IDS)("%s in sample mode", (id) => {
  it("completes, and every claim gets the label the pipeline derives from the recorded records", () => {
    const r = run(id);
    expect(r.status).toBe("complete");
    const got = Object.fromEntries(r.results.map((x) => [x.claim.id, x.finding.label]));
    expect(got).toEqual(EXPECTED_LABELS[id]);
  });

  it("every label equals what the compiler returns on the same evidence, and what the dossier verifier's recompute returns", async () => {
    for (const x of run(id).results) {
      const again = compileDetailed(x.compiled, x.evidence, x.options);
      expect(again.finding.id, x.claim.id).toBe(x.finding.id);
      expect(again.finding.label, x.claim.id).toBe(x.finding.label);
      const v = await recomputeFn(x.compiled, x.evidence, x.finding.ruleVersion);
      expect(v.label, x.claim.id).toBe(x.finding.label);
    }
  });

  it("every anchor a finding cites is a verified quotation inside a stored record", () => {
    const wb = run(id).wb;
    const asm = wb.assembled!;
    const anchors = new Map(asm.anchors.map((a) => [a.id, a]));
    const text = new Map([...wb.extracted.values()].map((e) => [e.stored.id, e.stored.text]));
    const assertionByAnchor = new Map(asm.assertions.map((a) => [a.anchorId, a]));
    for (const x of run(id).results) {
      for (const cov of x.finding.mechanicalCoverage) {
        for (const aid of cov.anchorIds) {
          const a = anchors.get(aid);
          expect(a, `anchor ${aid}`).toBeDefined();
          expect(text.get(a!.recordId)?.includes(a!.text), `quote of ${aid} exists verbatim`).toBe(true);
          const asr = assertionByAnchor.get(aid);
          if (asr) expect(asr.quoteVerified).toBe(true);
        }
      }
    }
  });

  it("only CONFIRMED links admit a record as evidence; candidates are shown and never used", () => {
    const links = run(id).wb.links!;
    const admittedLinkIds = new Set([...links.admitted.values()].map((a) => a.linkId));
    for (const l of links.links) {
      if (l.link.type === "STUDY_EVALUATES" && admittedLinkIds.has(l.link.id)) expect(l.link.state).toBe("CONFIRMED");
      if (l.link.state === "CANDIDATE" || l.link.state === "AMBIGUOUS") expect(admittedLinkIds.has(l.link.id)).toBe(false);
    }
  });

  it("the Evidence Matrix came from one Zetaris statement over the hospital, registry and vendor silos, replayed from a recording", () => {
    const fed = run(id).wb.federation;
    expect(fed.status).toBe("ok");
    const matrix = fed.reads[0]!;
    expect(matrix.result.servedFrom).toBe("cassette");
    expect(matrix.statement).toMatch(/FROM hospital\.cases/);
    expect(matrix.statement).toMatch(/sk_registry\.fda_510k/);
    expect(matrix.statement).toMatch(/sk_vendor\.vendor_claims/);
    expect(matrix.result.rows.length).toBe(run(id).spec.claims.length);
  });

  it("the trace is one schema-valid line per decision with a reason, in the order the roles run", () => {
    const events = run(id).trace.events;
    events.forEach((e, i) => {
      expect(TraceEventSchema.safeParse(e).success).toBe(true);
      expect(e.seq).toBe(i);
      expect(e.decision.length).toBeGreaterThan(10);
    });
    expect(events.at(-1)!.done).toBe(true);
    expect(events.filter((e) => e.done)).toHaveLength(1);
    const first = (role: string) => events.findIndex((e) => e.role === role);
    expect(first("guard")).toBeLessThan(first("planner"));
    expect(first("planner")).toBeLessThan(first("retriever"));
    expect(first("retriever")).toBeLessThan(first("extractor"));
    expect(first("extractor")).toBeLessThan(first("resolver"));
    expect(first("resolver")).toBeLessThan(first("compiler"));
    expect(first("compiler")).toBeLessThan(first("critic"));
    expect(first("critic")).toBeLessThan(first("reporter"));
    expect(events.map((e) => e.role)).toContain("discoverer");
  });

  it("every sentence of the prose is tied to a finding id of the case", () => {
    const ids = new Set(run(id).results.map((x) => x.finding.id));
    expect(run(id).prose.lines.length).toBeGreaterThan(0);
    for (const l of run(id).prose.lines) expect(ids.has(l.findingId)).toBe(true);
    for (const x of run(id).results) expect(run(id).prose.lines.some((l) => l.findingId === x.finding.id)).toBe(true);
  });
});

describe("EyeArt K200667, the case with a registry study", () => {
  const eye = (): InvestigationResult => run("eyeart-k200667");

  it("follows the chain FDA summary -> NCT03112005 -> PubMed 34779843 with a derived link for the paper", () => {
    const links = eye().wb.links!.links;
    const study = links.find((l) => l.link.type === "STUDY_EVALUATES" && l.link.from === "ctgov:NCT03112005")!;
    expect(study.link.state).toBe("CONFIRMED");
    expect(study.link.basis.join(" ")).toMatch(/cites NCT03112005/);
    const paper = links.find((l) => l.link.type === "STUDY_EVALUATES" && l.link.from === "pubmed:34779843")!;
    expect(paper.link.state).toBe("CONFIRMED");
    expect(paper.derived).toBe(true);
    expect(paper.link.basis.join(" ")).toMatch(/chaining two confirmed links/);
    expect(links.find((l) => l.link.type === "SAME_MARKETED_VERSION")!.link.state).toBe("CONFIRMED");
  });

  it("keeps registry studies that only share the product name as candidates and does not use them", () => {
    const cand = eye().wb.links!.links.filter((l) => l.link.type === "STUDY_EVALUATES" && l.link.state !== "CONFIRMED");
    expect(cand.length).toBeGreaterThan(0);
    for (const c of cand) expect(eye().wb.links!.admitted.has(c.link.from)).toBe(false);
  });

  it("says which fields it could not extract instead of filling them", () => {
    const notes = eye().wb.assembled!.notExtracted.join("\n");
    expect(notes).toMatch(/result\.sensitivity was searched for and is not stated/);
    expect(notes).toMatch(/table row/);
    const fdaStudy = eye().wb.assembled!.items.find((i) => i.assertionType === "study" && i.id.includes("fda-summary"))!;
    expect(fdaStudy.results).toEqual([]);
  });

  it("the headline question stops at INSUFFICIENT_EVIDENCE because no result attaches to the claimed scope, and says what would settle it", () => {
    const head = eye().results[0]!;
    expect(head.finding.label).toBe("INSUFFICIENT_EVIDENCE");
    const metric = head.finding.mechanicalCoverage.find((m) => m.dimension === "metric")!;
    expect(metric.relation).toBe("UNKNOWN");
    expect(head.detail.reasons.find((r) => r.dimension === "metric")!.text).toMatch(/do not cover the claimed scope/);
  });

  it("an overreaching vendor claim is held to the hospital's own requirements read through Zetaris", () => {
    const byId = (cid: string) => eye().results.find((r) => r.claim.id === cid)!;
    expect(byId("CLM-EA-02").finding.expertReviewFlags.map((f) => f.ruleId)).toContain("SAK-REQUIREMENT");
    expect(byId("CLM-EA-02").finding.expertReviewFlags[0]!.reason).toMatch(/REQ-02/);
    expect(byId("CLM-EA-05").finding.expertReviewFlags[0]!.reason).toMatch(/PRE-03/);
    expect(byId("CLM-EA-03").finding.mechanicalCoverage.find((m) => m.dimension === "setting")!.relation).toBe("DISJOINT");
    expect(byId("CLM-EA-04").finding.mechanicalCoverage.find((m) => m.dimension === "version")!.relation).toBe("DISJOINT");
    expect(byId("CLM-EA-06").finding.mechanicalCoverage.find((m) => m.dimension === "purpose")!.relation).toBe("PARTIAL");
    const unassessed = byId("CLM-EA-01").requirements.unassessed.map((u) => u.id);
    expect(unassessed).toEqual(expect.arrayContaining(["REQ-03", "REQ-05"]));
  });
});

describe("Transpara K221347 against a trial that used another version", () => {
  it("shows the paper that reports MASAI as an ambiguous candidate with a version-differs flag, and does not use it", () => {
    const wb = run("transpara-k221347").wb;
    const masai = wb.links!.links.find((l) => l.link.type === "STUDY_EVALUATES" && l.link.from === "pubmed:39904652")!;
    expect(masai.link.state).toBe("AMBIGUOUS");
    expect(masai.link.flags.join(" ")).toMatch(/version-differs: 1\.7\.0 versus 1\.7\.2/);
    expect(wb.links!.admitted.has("pubmed:39904652")).toBe(false);
    expect(wb.publications.find((p) => p.article?.pmid === "39904652")!.kept.some((k) => k.assertion.predicate === "device.version" && k.assertion.value === "1.7.0")).toBe(true);
  });

  it("asks for the population and the setting by name when the summary does not state them", () => {
    const f = run("transpara-k221347").results[1]!.finding;
    expect(f.requiredEvidence.map((r) => r.dimension)).toEqual(expect.arrayContaining(["population", "setting"]));
  });
});

describe("Lunit INSIGHT CXR Triage, whose summary states no release", () => {
  it("cannot place the claimed release and asks the vendor for it", () => {
    const f = run("lunit-k211733").results[1]!.finding;
    expect(f.mechanicalCoverage.find((m) => m.dimension === "version")!.relation).toBe("UNKNOWN");
    expect(f.requiredEvidence.find((r) => r.dimension === "version")!.request).toMatch(/software version/);
  });

  it("keeps the independent studies of the same brand as unresolved candidates", () => {
    const l = run("lunit-k211733").wb.links!.links.filter((x) => x.link.type === "STUDY_EVALUATES" && x.link.state !== "CONFIRMED");
    expect(l.length).toBeGreaterThan(0);
    expect(run("lunit-k211733").wb.links!.admitted.size).toBe(0);
  });
});

describe("a source that failed is reported as failed, and one that answered with nothing as empty", () => {
  const europepmc = (drill: "source_off" | "source_empty") => ({ drill, target: resolveTarget("europepmc", []) });

  it("a source that is down is UNAVAILABLE, is listed as a failure, and is not read as 'nothing found'", async () => {
    const r = await svc.investigate("eyeart-k200667", { faults: europepmc("source_off"), store: false });
    const out = r.wb.outcomes.find((o) => o.step.source === "europepmc")!;
    expect(out.status).toBe("UNAVAILABLE");
    expect(out.records).toEqual([]);
    expect(r.wb.failures.find((x) => x.source === "europepmc")?.status).toBe("UNAVAILABLE");
    expect(r.trace.events.some((e) => e.role === "retriever" && /europepmc/.test(e.decision) && /UNAVAILABLE/.test(e.decision))).toBe(true);
  }, 120_000);

  it("a source that answers with no rows is EMPTY, says 'none found', and is not a failure", async () => {
    const r = await svc.investigate("eyeart-k200667", { faults: europepmc("source_empty"), store: false });
    const out = r.wb.outcomes.find((o) => o.step.source === "europepmc")!;
    expect(out.status).toBe("EMPTY");
    expect(out.detail).toMatch(/none found/i);
    expect(out.detail).toMatch(/does not show that none exist/);
    expect(r.wb.failures.find((x) => x.source === "europepmc")).toBeUndefined();
  }, 120_000);

  it("a source used only to look for candidates leaves the labels as they were, in either state", async () => {
    for (const drill of ["source_off", "source_empty"] as const) {
      const r = await svc.investigate("eyeart-k200667", { faults: europepmc(drill), store: false });
      expect(Object.fromEntries(r.results.map((x) => [x.claim.id, x.finding.label]))).toEqual(EXPECTED_LABELS["eyeart-k200667"]);
    }
  }, 240_000);

  it("the recorded run itself read every source it planned: nothing was down when it was recorded", () => {
    const wb = run("eyeart-k200667").wb;
    expect(wb.failures).toEqual([]);
    expect(wb.outcomes.every((o) => o.status === "OK" || o.status === "EMPTY")).toBe(true);
  });
});
