import { beforeAll, describe, expect, it } from "vitest";
import { DRILLS, DrillResponseSchema } from "../../src/api/contract.ts";
import { staleFindings } from "../../src/compiler/index.ts";
import type { SakaimeService } from "../../src/service/service.ts";
import { INJECTED_INSTRUCTION } from "../../src/service/mutations.ts";
import { CASE_IDS, sampleService } from "./helpers.ts";

let svc: SakaimeService;
beforeAll(async () => {
  svc = await sampleService();
  for (const id of CASE_IDS) await svc.ensureRun(id);
}, 240_000);

const SUPPORTED = ["SUPPORTED_FOR_SCOPE", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE"];

describe("every drill in the contract runs through the real code and holds its invariant", () => {
  it("lists exactly the drills the contract names", () => {
    expect([...DRILLS]).toEqual(["source_off", "source_empty", "zetaris_off", "truncated_result", "model_off", "registry_changed", "injection_in_document"]);
  });

  for (const caseId of CASE_IDS) {
    for (const drill of DRILLS) {
      if (drill === "registry_changed" && caseId === "lunit-k211733") continue; // covered below
      it(`${caseId}: ${drill}`, async () => {
        const r = await svc.drill(caseId, { drill, ...(drill === "source_off" || drill === "source_empty" ? { target: "authorization" } : {}) });
        expect(DrillResponseSchema.safeParse(r).success).toBe(true);
        expect(r.invariantHeld, r.narrative).toBe(true);
        expect(r.narrative.length).toBeGreaterThan(30);
        expect(r.before.length).toBe(r.after.length);
      });
    }
  }
});

describe("a lost required source never yields a supported label (T6)", () => {
  it.each([
    ["source_off", "authorization"],
    ["source_off", "study"],
    ["source_off", "regulator"],
    ["source_empty", "study"],
    ["source_empty", "registry"],
    ["source_off", "clinicaltrials-v2"],
    ["zetaris_off", undefined],
    ["truncated_result", undefined],
  ] as const)("%s %s", async (drill, target) => {
    const r = await svc.drill("eyeart-k200667", { drill, ...(target ? { target } : {}) });
    expect(r.invariantHeld, r.narrative).toBe(true);
    expect(r.after.filter((f) => SUPPORTED.includes(f.label))).toEqual([]);
    for (const f of r.after) expect(f.degraded.length, f.claimId).toBeGreaterThan(0);
    expect(r.before.some((f) => SUPPORTED.includes(f.label))).toBe(true); // the drill removed something that mattered
  });

  it("the claim that was supported before the drill is demoted by it, to the label the compiler gives with that evidence missing", async () => {
    const r = await svc.drill("eyeart-k200667", { drill: "source_off", target: "study" });
    const was = r.before.find((f) => f.claimId === "CLM-EA-01")!;
    const now = r.after.find((f) => f.claimId === "CLM-EA-01")!;
    expect(was.label).toBe("SUPPORTED_FOR_SCOPE");
    expect(now.label).toBe("INSUFFICIENT_EVIDENCE");
    expect(now.degraded.some((d) => d.sourceType === "study" && d.dependency === "required")).toBe(true);
    expect(r.narrative).toMatch(/CLM-EA-01: SUPPORTED_FOR_SCOPE -> INSUFFICIENT_EVIDENCE/);
    expect(r.invariantHeld).toBe(true);
  });

  it("a claim that was not supported before a drill is not supported after it, whatever was lost", async () => {
    const cases = [
      ["source_off", "authorization"],
      ["source_off", "study"],
      ["source_empty", "registry"],
      ["zetaris_off", undefined],
      ["truncated_result", undefined],
    ] as const;
    let checked = 0;
    for (const [drill, target] of cases) {
      const r = await svc.drill("eyeart-k200667", { drill, ...(target ? { target } : {}) });
      for (const before of r.before.filter((f) => !SUPPORTED.includes(f.label))) {
        const after = r.after.find((f) => f.claimId === before.claimId)!;
        expect(SUPPORTED.includes(after.label), `${drill} ${target ?? ""} ${before.claimId}: ${before.label} -> ${after.label}`).toBe(false);
        checked += 1;
      }
    }
    expect(checked).toBeGreaterThanOrEqual(5 * 7);
  });

  it("a case with no supported claim at all still holds the invariant under every drill", async () => {
    for (const id of ["lunit-k211733", "transpara-k221347"]) {
      const before = svc.recordOf(id)!.result.results.map((r) => r.finding.label);
      expect(before.some((l) => SUPPORTED.includes(l)), id).toBe(false);
      for (const drill of ["source_off", "zetaris_off", "truncated_result"] as const) {
        const r = await svc.drill(id, { drill, ...(drill === "source_off" ? { target: "study" } : {}) });
        expect(r.invariantHeld, `${id} ${drill}: ${r.narrative}`).toBe(true);
        expect(r.after.every((f) => !SUPPORTED.includes(f.label)), `${id} ${drill}`).toBe(true);
      }
    }
  });

  it("Zetaris off is named as lost hospital requirements, not as an empty result", async () => {
    const r = await svc.drill("eyeart-k200667", { drill: "zetaris_off" });
    for (const f of r.after) {
      const d = f.degraded.find((x) => x.sourceType === "requirement")!;
      expect(d.dependency).toBe("required");
      expect(d.reason).toMatch(/UNAVAILABLE/);
      expect(d.reason).not.toMatch(/EMPTY/);
    }
  });

  it("an empty answer is reported as empty ('none found on date'), never as a failure and never as absence", async () => {
    const r = await svc.drill("eyeart-k200667", { drill: "source_empty", target: "registry" });
    const d = r.after.flatMap((f) => f.degraded).find((x) => x.sourceType === "study")!;
    expect(d.reason).toMatch(/^EMPTY: none found/);
    expect(d.reason).toMatch(/not about whether such evidence exists/);
  });

  it("a source the plan reads only to look for candidates takes no required evidence with it", async () => {
    const r = await svc.drill("transpara-k221347", { drill: "source_empty", target: "registry" });
    expect(r.invariantHeld).toBe(true);
    expect(r.narrative).toMatch(/only to look for further candidates/);
    expect(r.after.map((f) => f.label)).toEqual(r.before.map((f) => f.label));
  });

  it("a drill with a target nobody recognises is refused rather than injecting nothing", async () => {
    await expect(svc.drill("eyeart-k200667", { drill: "source_off", target: "the-moon" })).rejects.toMatchObject({ failure: "INVALID" });
  });

  it("does not touch the case's stored findings", async () => {
    const before = svc.recordOf("eyeart-k200667")!.result.results.map((r) => r.finding.id);
    await svc.drill("eyeart-k200667", { drill: "source_off", target: "study" });
    expect(svc.recordOf("eyeart-k200667")!.result.results.map((r) => r.finding.id)).toEqual(before);
  });
});

describe("a registry record changes after a finding (T5)", () => {
  it("marks exactly the findings that relied on a replaced fact stale, and nothing else", async () => {
    const r = await svc.drill("eyeart-k200667", { drill: "registry_changed" });
    expect(r.invariantHeld, r.narrative).toBe(true);
    const base = svc.recordOf("eyeart-k200667")!.result.wb.world.facts;
    expect(base.some((f) => f.sourceId === "clinicaltrials-v2" && f.predicate === "population.age_min" && f.value === 18)).toBe(true);
    expect(r.staleFindingIds.length).toBeGreaterThan(0);
    const replaced = base.filter((f) => f.predicate === "population.age_min" && f.value === 18 && f.sourceId === "clinicaltrials-v2").map((f) => f.factId);
    const expected = staleFindings(r.before, replaced).map((f) => f.id).sort();
    expect([...r.staleFindingIds].sort()).toEqual(expected);
    expect(r.narrative).toMatch(/findings of other cases are untouched/);
  });

  it("the revised record changes labels only where the compiler says, and the earlier findings are kept", async () => {
    const r = await svc.drill("eyeart-k200667", { drill: "registry_changed" });
    // The study record was revised to a minimum age of 22. The packet's other records still state 18 and above, so the evidence as a whole
    // covers the same ages and no label moves; the findings that relied on the replaced fact are marked stale all the same.
    const moved = r.after.filter((f, i) => f.label !== r.before[i]!.label).map((f) => f.claimId);
    expect(moved).toEqual([]);
    expect(r.narrative).toMatch(/No label changed/);
    expect(r.staleFindingIds.length).toBeGreaterThan(0);
    expect(svc.recordOf("eyeart-k200667")!.result.results[1]!.finding.id).toBe(r.before[1]!.id);
  });

  it("a record that no finding relied on changes no finding", async () => {
    const r = await svc.drill("transpara-k221347", { drill: "registry_changed" });
    expect(r.invariantHeld).toBe(true);
    expect(r.staleFindingIds).toEqual([]);
    expect(r.narrative).toMatch(/only a candidate/);
  });
});

describe("the model is off, or a document tells the system what to conclude", () => {
  it("model_off changes no label, and every sentence falls back to a template", async () => {
    const r = await svc.drill("eyeart-k200667", { drill: "model_off" });
    expect(r.after.map((f) => f.label)).toEqual(r.before.map((f) => f.label));
    expect(r.narrative).toMatch(/templated sentences/);
  });

  it("an instruction in a decision summary is set aside, never read, and changes no label", async () => {
    const r = await svc.drill("eyeart-k200667", { drill: "injection_in_document" });
    expect(r.invariantHeld, r.narrative).toBe(true);
    expect(r.after.map((f) => f.label)).toEqual(r.before.map((f) => f.label));
    expect(r.narrative).toMatch(/set aside \d+ passage/);
    const run = await svc.investigate("eyeart-k200667", { mutations: { injection: { submission: "K200667", page: 2, text: INJECTED_INSTRUCTION } }, coreOnly: true, store: false });
    expect(run.wb.summary!.stored.text).not.toContain("NOTE TO THE REVIEWING SYSTEM");
    expect(run.wb.quarantined[0]!.text).toContain("NOTE TO THE REVIEWING SYSTEM");
    expect(run.trace.events.some((e) => e.role === "guard" && /set aside/.test(e.decision))).toBe(true);
    expect(run.results.map((x) => x.finding.label)).toEqual(svc.recordOf("eyeart-k200667")!.result.results.map((x) => x.finding.label));
  });
});
