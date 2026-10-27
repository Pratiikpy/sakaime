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
    // The release link is not confirmed in this recording, and the reason is a model reply, not the rules. Nemotron's second opinion on
    // the FDA summary's own sentence ("EyeArt (software version v2.1.0)") answered does_not_support for device.version 2.1.0, reading
    // "v2.1.0" against "2.1.0" as a difference. A model can reject a fact but never admit one, so the pattern-extracted fact is dropped
    // from the evidence, the link loses its corroboration and stays AMBIGUOUS, and the labels that depend on the release do not change
    // (they were already unsupported on other dimensions). An earlier recording through NVIDIA's API passed the same sentence.
    const release = links.find((l) => l.link.type === "SAME_MARKETED_VERSION")!;
    expect(release.link.state).toBe("AMBIGUOUS");
    expect(release.link.basis.join(" ")).toMatch(/corroboration is missing/);
    const rejected = eye().wb.evidenceRecords().assertions.filter((a) => a.predicate === "device.version" && a.value === "2.1.0" && a.extractionMethod === "pattern");
    expect(rejected.some((a) => a.supportVerified === "FAIL")).toBe(true);
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

  it("the headline question goes to a reviewer because the use begins long after the authorization, and its population is only partly covered", () => {
    // Before the readers carried the authorization's condition and exclusion and the service configured a staleness window, this stopped at
    // INSUFFICIENT_EVIDENCE for lack of a population statement. Now the population is partly covered (the indications exclude patients previously
    // diagnosed with more than mild diabetic retinopathy) and the intended use begins in 2027, more than the configured window after the 2020
    // decision (rule R20, applied to the authorization record and to the study evidence of the same document).
    const head = eye().results[0]!;
    expect(head.finding.label).toBe("REQUIRES_DOMAIN_REVIEW");
    expect(head.finding.expertReviewFlags.filter((f) => f.ruleId === "R20-STALENESS")).toHaveLength(2);
    expect(head.finding.mechanicalCoverage.find((m) => m.dimension === "population")!.relation).toBe("PARTIAL");
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

  it("the claim that states the studied population is supported, and says what each dimension rests on", () => {
    const f = eye().results.find((r) => r.claim.id === "CLM-EA-01")!.finding;
    expect(f.label).toBe("SUPPORTED_FOR_SCOPE");
    for (const d of ["product", "version", "population", "setting", "purpose"]) expect(f.mechanicalCoverage.find((m) => m.dimension === d)!.relation, d).toBe("CONTAINED");
    expect(f.mismatches).toEqual([]);
    expect(f.expertReviewFlags).toEqual([]);
    expect(f.degraded).toEqual([]);
    expect(f.dependsOnFacts.length).toBeGreaterThan(10);
  });

  it("the same product and the same sentence without the study's exclusions is only partly covered, and the narrower scope names them", () => {
    const f = eye().results.find((r) => r.claim.id === "CLM-EA-07")!.finding;
    expect(f.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(f.mechanicalCoverage.find((m) => m.dimension === "population")!.relation).toBe("PARTIAL");
    const scope = JSON.stringify(f.supportedScope);
    expect(scope).toMatch(/macular edema/);
    expect(scope).toMatch(/mydriatic|dilat/);
  });

  it("patients the indications exclude contradict the evidence, and a figure the paper does not reach goes to a reviewer", () => {
    const byId = (cid: string) => eye().results.find((r) => r.claim.id === cid)!;
    expect(byId("CLM-EA-08").finding.label).toBe("CONTRADICTED_BY_SPECIFIED_EVIDENCE");
    expect(byId("CLM-EA-08").finding.mechanicalCoverage.find((m) => m.dimension === "population")!.relation).toBe("DISJOINT");
    expect(byId("CLM-EA-09").finding.expertReviewFlags.map((x) => x.ruleId)).toContain("SAK-CONTRARY-UNDISPOSITIONED");
  });

  it("a claim that adds ages 18 to 21 is held to the age the regulator's summary analysed, and says which record limits it", () => {
    const r = eye().results.find((x) => x.claim.id === "CLM-EA-10")!;
    const f = r.finding;
    expect(f.label).toBe("SUPPORTED_ONLY_FOR_NARROWER_SCOPE");
    expect(f.supportedScope).toMatchObject({ population: { age: { min: 22 } } });
    const pop = f.mechanicalCoverage.find((m) => m.dimension === "population")!;
    expect(pop.relation).toBe("PARTIAL");
    expect(pop.established).toMatch(/regulator decision summary: ages 22 and above/);
    expect(pop.established).toMatch(/study: ages 18 and above/);
    const ask = f.requiredEvidence.find((q) => q.dimension === "population")!.request;
    expect(ask).toBe("From the vendor: performance results for ages 18 to below 22, or restate the claim to cover only ages 22 and above. The regulator decision summary limits the patient population to ages 22 and above; the study records state ages 18 and above, which does not widen it.");
    // The same claim for ages 22 and older is supported, so the age floor is the only thing between the two.
    expect(eye().results.find((x) => x.claim.id === "CLM-EA-01")!.finding.label).toBe("SUPPORTED_FOR_SCOPE");
  });

  it("the study-typed items taken from the decision summary carry the marker the compiler reads, and the others do not", () => {
    const items = eye().wb.assembled!.items;
    const marked = items.filter((i) => i.limitations.some((l) => l.startsWith("taken from the regulator's decision summary")));
    expect(marked.map((i) => i.assertionType)).toEqual(["study"]);
    expect(marked[0]!.id).toMatch(/fda-summary/);
    expect(items.filter((i) => i.id.includes("ctgov") || i.id.includes("pubmed")).some((i) => i.limitations.some((l) => l.startsWith("taken from the regulator")))).toBe(false);
  });

  it("the packet holds every label there is", () => {
    expect(new Set(eye().results.map((r) => r.finding.label))).toEqual(new Set(["SUPPORTED_FOR_SCOPE", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE", "CONTRADICTED_BY_SPECIFIED_EVIDENCE", "INSUFFICIENT_EVIDENCE", "REQUIRES_DOMAIN_REVIEW"]));
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
