/**
 * The failure drills (docs/01-prd.md F8, tests T5 and T6). Each one makes a real part of the system fail or change, runs the
 * investigation again through the real code, and asserts the invariant that matters:
 *
 *   a lost required source never yields a supported label;       only findings that relied on a changed fact go stale;
 *   a model that is off changes no label;                        an instruction inside a document changes no label.
 *
 * The fault is injected into a port wrapper or into the data a source returns (src/service/faults.ts, mutations.ts), never into
 * the compiler. The result says what happened in plain words and whether the invariant held, with the findings from before and after.
 */
import type { z } from "zod";
import type { DRILLS, DrillResponseSchema } from "../api/contract.ts";
import { staleFindings } from "../compiler/index.ts";
import { PortError } from "../ports/index.ts";
import type { AssertionType, Finding } from "../schemas/index.ts";
import { resolveTarget, SOURCE_TYPES, type DrillName } from "./faults.ts";
import { INJECTED_INSTRUCTION } from "./mutations.ts";
import type { SakaimeService } from "./service.ts";
import { currentFindings } from "./views.ts";
import { CaseWorld } from "./world.ts";

type DrillResponse = z.infer<typeof DrillResponseSchema>;
export type { DrillName };
export type DrillList = typeof DRILLS;

const SUPPORTED = new Set(["SUPPORTED_FOR_SCOPE", "SUPPORTED_ONLY_FOR_NARROWER_SCOPE"]);

const DEFAULT_TARGET: Partial<Record<DrillName, string>> = { source_off: "registry", source_empty: "registry" };

function describeLabels(before: readonly Finding[], after: readonly Finding[]): string {
  const changes: string[] = [];
  for (const a of after) {
    const b = before.find((x) => x.claimId === a.claimId);
    if (b && b.label !== a.label) changes.push(`${a.claimId}: ${b.label} -> ${a.label}`);
  }
  return changes.length === 0 ? "No label changed." : `Labels that changed: ${changes.join("; ")}.`;
}

export async function runDrill(svc: SakaimeService, caseId: string, request: { drill: DrillName; target?: string | undefined }): Promise<DrillResponse> {
  const base = await svc.ensureRun(caseId);
  const baseCtx = { run: base.result, decisions: base.decisions.entries(), mode: await svc.runMode(), stale: new Set<string>(), linkEvents: [] };
  const before = currentFindings(baseCtx);
  const mode = baseCtx.mode;
  const drill = request.drill;

  const respond = (after: Finding[], stale: string[], narrative: string, held: boolean): DrillResponse => ({ drill, before, after, staleFindingIds: stale, narrative, invariantHeld: held, mode });

  // ------------------------------------------------------------ a source is off or answers with nothing
  if (drill === "source_off" || drill === "source_empty" || drill === "zetaris_off" || drill === "truncated_result") {
    const zet = drill === "zetaris_off" || drill === "truncated_result";
    const target = zet ? resolveTarget("hospital", ["hospital-policy"]) : resolveTarget(request.target ?? DEFAULT_TARGET[drill], []);
    const run = await svc.investigate(caseId, { faults: { drill, target }, coreOnly: true, store: false });
    const after = run.results.map((r) => r.finding);
    // What was actually lost is what the run marked lost: a source the plan reads only to look for candidates takes no required evidence with it.
    const health = run.wb.typeHealth();
    const lostTypes = new Set<AssertionType>((Object.keys(health) as AssertionType[]).filter((t) => health[t]!.health !== "OK"));
    const lostFactIds = base.result.wb.world.facts.filter((f) => target.sources.has(f.sourceId) && lostTypes.has(f.assertionType)).map((f) => f.factId);
    const stale = staleFindings(before, lostFactIds).map((f) => f.id);
    let held = true;
    const notes: string[] = [];
    for (const r of run.results) {
      const required = new Set(r.dependencies?.required ?? []);
      const hit = [...lostTypes].filter((t) => required.has(t));
      const was = before.find((b) => b.claimId === r.claim.id);
      if (hit.length > 0) {
        const degraded = r.finding.degraded.some((d) => hit.includes(d.sourceType as AssertionType));
        if (SUPPORTED.has(r.finding.label) || !degraded) {
          held = false;
          notes.push(`${r.claim.id} is ${r.finding.label} although ${hit.join(", ")} evidence was lost`);
        }
      } else if (was && was.label !== r.finding.label) {
        held = false;
        notes.push(`${r.claim.id} changed from ${was.label} to ${r.finding.label} although no evidence it requires was lost`);
      }
    }
    const what =
      drill === "source_off"
        ? `${target.label} was switched off: its requests fail with UNAVAILABLE.`
        : drill === "source_empty"
          ? `${target.label} answered every request with no rows (EMPTY): "none found in the source on that date", which is not "none exist".`
          : drill === "zetaris_off"
            ? "The federation engine was stopped: the statement failed with UNAVAILABLE and no row was invented."
            : "A federated result came back cut short: the completeness check refused it and no partial answer was used.";
    const lostNote = lostTypes.size ? ` Evidence of type ${[...lostTypes].join(", ")} was not read.` : " This case reads that source only to look for further candidates, so no evidence a claim requires was lost; the candidate search is incomplete and says so.";
    return respond(after, stale, `${what}${lostNote} ${describeLabels(before, after)}${notes.length ? ` Violations: ${notes.join("; ")}.` : " No claim that requires the lost evidence is supported; claims that do not require it did not change."}${stale.length ? ` ${stale.length} finding${stale.length === 1 ? "" : "s"} relied on facts from the lost source and ${stale.length === 1 ? "is" : "are"} marked stale.` : ""}`, held);
  }

  // ------------------------------------------------------------ the model route is off
  if (drill === "model_off") {
    const run = await svc.investigate(caseId, { faults: { drill }, store: false });
    const after = run.results.map((r) => r.finding);
    const same = after.every((a) => before.find((b) => b.claimId === a.claimId)?.label === a.label);
    const fromModel = run.prose.lines.filter((l) => l.source === "model").length;
    const held = same && run.status === "complete" && fromModel === 0;
    return respond(after, [], `The model route was switched off. The plan, the critique and the prose fell back to rules and templates (${run.prose.lines.length} templated sentences). ${describeLabels(before, after)} Labels come from the compiler, so a model that is off cannot change one.`, held);
  }

  // ------------------------------------------------------------ an instruction inside a document
  if (drill === "injection_in_document") {
    const spec = svc.caseSpec(caseId);
    const run = await svc.investigate(caseId, { mutations: { injection: { submission: spec.submission, page: 2, text: INJECTED_INSTRUCTION } }, coreOnly: true, store: false });
    const after = run.results.map((r) => r.finding);
    const same = after.every((a) => before.find((b) => b.claimId === a.claimId)?.label === a.label);
    const q = run.wb.quarantined.length;
    const leaked = (run.wb.summary?.stored.text ?? "").includes("NOTE TO THE REVIEWING SYSTEM");
    const held = same && q > 0 && !leaked;
    return respond(after, [], `A decision summary carried this instruction: "${INJECTED_INSTRUCTION.slice(0, 120)}...". The guard set aside ${q} passage${q === 1 ? "" : "s"} before any reader or model saw the page${leaked ? ", but the text reached the stored record" : ""}. ${describeLabels(before, after)} A document is data and cannot change a plan, a label or an export.`, held);
  }

  // ------------------------------------------------------------ a registry record changes after a finding
  const admitted = base.result.wb.studies.find((s) => base.result.wb.links?.admitted.has(`ctgov:${s.study?.nctId}`));
  const cited = admitted ?? base.result.wb.studies[0];
  if (!cited?.study) {
    throw new PortError("INVALID", `case ${caseId} read no registry record, so there is none to change`, { reason: "NO_REGISTRY_RECORD" });
  }
  const nctId = cited.study.nctId;
  const run = await svc.investigate(caseId, { mutations: { registryRevision: { nctId, minimumAge: "22 Years", revisedOn: "2026-10-28" } }, coreOnly: true, store: false });
  const after = run.results.map((r) => r.finding);

  // The revised record's facts that differ from what the original said.
  const baseFacts = base.result.wb.world.facts;
  const slot = (f: { about: string; predicate: string }) => `${f.about}|${f.predicate}`;
  const changedNew = run.wb.world.facts.filter((f) => f.sourceId === "clinicaltrials-v2" && !baseFacts.some((b) => slot(b) === slot(f) && JSON.stringify(b.value) === JSON.stringify(f.value)) && baseFacts.some((b) => slot(b) === slot(f)));
  const replaced = baseFacts.filter((b) => changedNew.some((n) => slot(n) === slot(b) && JSON.stringify(n.value) !== JSON.stringify(b.value)));

  // A scratch copy of the case's world: the original facts and the findings' dependencies, then the change event.
  const scratch = new CaseWorld(`drill-${caseId}-${base.result.runId}`, svc.config.clock);
  try {
    await scratch.restore(baseFacts);
    for (const f of before) await scratch.declare(f.id, f.dependsOnFacts);
    for (const n of changedNew) await scratch.restore([n]);
    const marked = scratch.stale().sort();
    const expected = staleFindings(before, replaced.map((r) => r.factId)).map((f) => f.id).sort();
    // A record no finding relied on changes nothing; one that was relied on marks exactly its dependents.
    const relied = admitted !== undefined;
    const held = JSON.stringify(marked) === JSON.stringify(expected) && (relied ? changedNew.length > 0 : marked.length === 0 && after.every((a) => before.find((b) => b.claimId === a.claimId)?.label === a.label));
    const others = svc.allFindings().filter((f) => !before.some((b) => b.id === f.id));
    const narrative = `Registry record ${nctId} was revised after the findings were made: its minimum age became 22 Years${relied ? ` (${changedNew.length} fact${changedNew.length === 1 ? "" : "s"} changed)` : "; no finding of this case relied on that record, because it is only a candidate"}. ${marked.length} of ${before.length} findings of this case relied on a replaced fact and are marked stale; ${others.length} findings of other cases are untouched. ${describeLabels(before, after)} The earlier findings are kept; a recomputed finding references the one it replaces.`;
    return respond(after, marked, narrative, held);
  } finally {
    scratch.close();
  }
}
