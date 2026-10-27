/**
 * The investigation loop: a bounded state machine over the roles, not a free-running agent.
 *
 *   guard -> plan -> retrieve -> resolve -> federate -> compile -> [replan -> retrieve ... -> compile] -> critique -> [revise] -> report -> done
 *
 * Roles: Guard (Scout), Planner, Discoverer, Retriever, Resolver, Extractor, Compiler, Critic, Reporter. Several are mostly
 * code. Models are asked only where a proposal is useful (the plan's extra searches, a pair in the uncertain band, a second
 * opinion on an assertion, an adversarial reading, the prose), and whatever comes back is checked by code before it counts.
 *
 * Bounds, all in code: a cap on turns, a timeout on every external call, capped retries, a per-case budget of calls, and
 * cancellation. Branching: an UNKNOWN on a required dimension sends the Planner to unread candidate records before the Critic
 * runs; a Critic objection the code confirms sets the contested evidence aside and compiles again; a source that keeps failing
 * leaves the claim at INSUFFICIENT_EVIDENCE with the reason, never at a label the evidence does not support.
 * Every decision is one line of the trace with the reason it was taken.
 */
import { supersede } from "../compiler/index.ts";
import { PortError, type ModelResponse } from "../ports/index.ts";
import type { Finding } from "../schemas/index.ts";
import { allClaims } from "../service/cases.ts";
import type { AssembledEvidence } from "../service/assemble.ts";
import type { ReadStep, StepOutcome } from "../service/reader.ts";
import { Workbench, type ClaimResult, type WorkbenchEnv } from "../service/workbench.ts";
import { CancelledError, brief, errorMessage, throwIfCancelled } from "../service/util.ts";
import type { CaseSpec } from "../service/cases.ts";
import { CRITIC_JSON_SCHEMA, codeChecks, criticPrompt, findingView, linkNotes, vetObjections, type CriticNote } from "./critic.ts";
import type { Guard } from "./guard.ts";
import { candidateStudyStep, discoverySteps, followupSteps, initialSteps, paperStep, PLAN_JSON_SCHEMA, vetSuggestion } from "./plan.ts";
import { REPORT_JSON_SCHEMA, composeProse, reportPrompt, type ProseResult } from "./report.ts";
import type { TraceEmitter } from "./trace.ts";

export type InvestigationStatus = "complete" | "refused" | "cancelled" | "failed";
type State = "guard" | "plan" | "retrieve" | "resolve" | "federate" | "compile" | "replan" | "critique" | "revise" | "report" | "done";

export interface InvestigationEnv extends WorkbenchEnv {
  guard: Guard;
  trace: TraceEmitter;
  reviewer: { id: string; role: string };
  /** Skip the Planner, Critic and Reporter models (drills that test the deterministic core only). */
  coreOnly?: boolean;
}

export interface SupersededFinding {
  older: Finding;
  /** The newer finding as it is stored: it names the older one and the reason. */
  newer: Finding;
  reason: string;
  /** revision: the critic's confirmed objection set evidence aside. replan: more evidence was read. */
  kind: "revision" | "replan";
  /** The evidence items the older finding was compiled from, so the dossier can reproduce it. */
  olderEvidenceIds: string[];
}

export interface InvestigationResult {
  status: InvestigationStatus;
  reason?: string;
  runId: string;
  spec: CaseSpec;
  wb: Workbench;
  trace: TraceEmitter;
  results: ClaimResult[];
  /** Findings replaced during the run; both are kept. */
  history: SupersededFinding[];
  critic: CriticNote[];
  prose: ProseResult;
  plan: { step: ReadStep; outcome?: StepOutcome }[];
  planNotes: string[];
  turns: number;
  startedAt: string;
  finishedAt: string;
}

const REQUEST_TEXT = (spec: CaseSpec): string => `Review the evidence behind the claims for ${spec.productLabel} against the hospital's intended use.`;

export class Investigation {
  readonly wb: Workbench;
  private state: State = "guard";
  private readonly plan: { step: ReadStep; outcome?: StepOutcome }[] = [];
  private readonly planNotes: string[] = [];
  private queue: ReadStep[] = [];
  private pendingNcts: string[] = [];
  private pendingPmids: string[] = [];
  private turns = 0;
  private critic: CriticNote[] = [];
  private history: SupersededFinding[] = [];
  private prose: ProseResult = { lines: [], rejected: [], modelCalled: false };
  private revised = false;

  constructor(
    readonly spec: CaseSpec,
    readonly env: InvestigationEnv,
  ) {
    this.wb = new Workbench(spec, env);
  }

  private say(role: Parameters<TraceEmitter["emit"]>[0]["role"], decision: string, detail?: Record<string, unknown>, extra: { model?: { routedModel: string; recorded: boolean; receiptId?: string }; federation?: { queryId: string; servedFrom: string } } = {}): void {
    this.env.trace.emit({ role, decision, ...(detail ? { detail } : {}), ...extra });
  }

  private go(next: State, why: string): void {
    this.say("system", `state ${this.state} -> ${next}: ${why}`, { from: this.state, to: next, turn: this.turns });
    this.state = next;
  }

  async run(): Promise<InvestigationResult> {
    const startedAt = this.env.config.clock.now().toISOString();
    let status: InvestigationStatus = "complete";
    let reason: string | undefined;
    try {
      this.say("system", `investigation of ${this.spec.id} started in ${this.env.config.sample ? "sample" : "live"} mode`, { caseId: this.spec.id, runId: this.env.runId, claims: allClaims(this.spec).length });
      while (this.state !== "done") {
        throwIfCancelled(this.env.signal);
        switch (this.state) {
          case "guard":
            if (!(await this.guard())) {
              status = "refused";
              reason = "the guard refused the request";
              this.state = "done";
            }
            break;
          case "plan":
            await this.planStage();
            break;
          case "retrieve":
            await this.retrieveStage();
            break;
          case "resolve":
            await this.resolveStage();
            break;
          case "federate":
            await this.federateStage();
            break;
          case "compile":
            await this.compileStage();
            break;
          case "replan":
            this.replanStage();
            break;
          case "critique":
            await this.critiqueStage();
            break;
          case "revise":
            await this.reviseStage();
            break;
          case "report":
            await this.reportStage();
            break;
        }
      }
    } catch (error) {
      if (error instanceof CancelledError) {
        status = "cancelled";
        reason = "cancelled by the caller";
      } else {
        status = "failed";
        reason = brief(errorMessage(error));
        this.say("system", `the investigation stopped: ${reason}`, { error: reason });
      }
    }
    const finishedAt = this.env.config.clock.now().toISOString();
    this.env.trace.emit({ role: "system", decision: `investigation ${status}${reason ? `: ${reason}` : ""}`, detail: { status, turns: this.turns, budget: this.env.budget.snapshot() }, done: true });
    return {
      status,
      ...(reason ? { reason } : {}),
      runId: this.env.runId,
      spec: this.spec,
      wb: this.wb,
      trace: this.env.trace,
      results: this.wb.results,
      history: this.history,
      critic: this.critic,
      prose: this.prose,
      plan: this.plan,
      planNotes: this.planNotes,
      turns: this.turns,
      startedAt,
      finishedAt,
    };
  }

  // ---------------------------------------------------------------- guard

  private async guard(): Promise<boolean> {
    const { response, decision } = await this.env.guard.screen(REQUEST_TEXT(this.spec), "reviewer", this.env.reviewer, this.spec.id);
    this.say("guard", response.allowed ? `request understood as ${response.intent}; the investigation may proceed` : `request refused: ${response.message}`, { intent: response.intent, findings: response.findings, scoutDecision: decision?.decision, policyPack: decision?.policyPackVersion });
    if (response.allowed) this.go("plan", "the request is an evidence review the product performs");
    return response.allowed;
  }

  // ---------------------------------------------------------------- model helper

  private async ask(role: string, prompt: { system: string; user: string }, schema: Record<string, unknown>, maxTokens: number, purpose: string): Promise<{ json: unknown; response: ModelResponse } | undefined> {
    const model = this.wb.env.model;
    if (!model || this.env.coreOnly) {
      this.planNotes.push(`${role}: no model call (${this.env.coreOnly ? "core-only run" : (this.env.modelNote ?? "no model is configured")}); the rule path was used`);
      return undefined;
    }
    try {
      this.env.budget.spend("model", purpose);
      const response = await model.complete({ role, system: prompt.system, user: prompt.user, jsonSchema: schema, maxTokens, dataClass: "public", memoryScope: this.env.newScope() });
      const json = response.json ?? parseJson(response.text);
      return { json, response };
    } catch (error) {
      if (error instanceof CancelledError) throw error;
      const e = error instanceof PortError ? error : new PortError("UNAVAILABLE", errorMessage(error));
      this.say(role as never, `the ${role} model call failed (${e.failure}): ${brief(e.message, 160)}; the rule path was used`, { failure: e.failure, purpose });
      this.planNotes.push(`${role}: the model call failed (${e.failure}); the rule path was used`);
      return undefined;
    }
  }

  private modelTag(r: ModelResponse): { routedModel: string; recorded: boolean; receiptId?: string } {
    return { routedModel: r.routedModel, recorded: r.recorded, ...(r.receipt?.receiptId ? { receiptId: r.receipt.receiptId } : {}) };
  }

  // ---------------------------------------------------------------- plan

  private async planStage(): Promise<void> {
    const steps = [...initialSteps(this.spec)];
    const disc = discoverySteps(this.spec);
    if (disc.refusal) {
      this.say("planner", `no search by vendor and product was built: ${disc.refusal.message}`, { reason: disc.refusal.reason });
      this.planNotes.push(`discovery searches refused: ${disc.refusal.reason}`);
    }
    // The Discoverer picks sources from the registered source cards by what each can establish.
    const registered = [...this.env.connectors.keys()];
    const needed = new Set(["regulator", "registry", "literature"]);
    this.say("discoverer", `${registered.length} source cards are registered; the plan uses ${[...new Set([...steps, ...disc.steps].map((s) => s.source))].join(", ")} and the FDA decision-summary reader`, {
      registered,
      coverage: { regulator: ["openfda-510k", "openfda-udi", "fda-accessdata-pdf"], registry: ["clinicaltrials-v2"], literature: ["pubmed-eutils", "europepmc"] },
      needed: [...needed],
      licences: Object.fromEntries([...this.env.connectors].map(([id, c]) => [id, c.card.license])),
    });

    let extra: ReadStep[] = [];
    const asked = await this.ask(
      "planner",
      {
        system: [
          "You plan evidence searches for a hospital reviewer. You choose among allowed searches only; you cannot add any other action.",
          "Allowed sources: clinicaltrials-v2, pubmed-eutils, europepmc. A search names the vendor and the product exactly as given and may add one plain condition phrase.",
          "Suggest at most two searches that would find studies or papers the planned searches could miss, and list the sub-questions the evidence must answer. Reply with JSON only.",
        ].join("\n"),
        user: JSON.stringify({
          vendor: this.spec.vendor.name,
          vendorAliases: this.spec.vendor.aliases,
          product: this.spec.product.name,
          condition: this.spec.product.condition ?? null,
          submission: this.spec.submission,
          alreadyPlanned: [...steps, ...disc.steps].map((s) => ({ source: s.source, query: s.query })),
          claimedUses: allClaims(this.spec).map((c) => ({ id: c.id, use: c.use, performance: c.performance ?? null })),
        }),
      },
      PLAN_JSON_SCHEMA,
      900,
      "plan",
    );
    if (asked) {
      const vetted = vetSuggestion(asked.json, this.spec, [...steps, ...disc.steps]);
      extra = vetted.extra;
      this.say("planner", `the model proposed ${vetted.extra.length} extra search${vetted.extra.length === 1 ? "" : "es"} that passed the checks and ${vetted.dropped.length} that did not; ${vetted.subQuestions.length} sub-questions recorded`, { subQuestions: vetted.subQuestions, extra: vetted.extra.map((s) => ({ source: s.source, query: s.query })), dropped: vetted.dropped }, { model: this.modelTag(asked.response) });
    } else {
      this.say("planner", "no model plan was available; the rule plan is used (regulator record, device records, decision summary, cited studies, searches by vendor and product)");
    }
    this.queue = [...steps];
    this.discovery = [...disc.steps, ...extra];
    this.say("planner", `plan: ${this.queue.length} regulator reads, the decision summary, then ${this.discovery.length} searches; cited studies are added once the summary is read`, { steps: [...this.queue, ...this.discovery].map((s) => ({ id: s.id, source: s.source, why: s.why })) });
    this.go("retrieve", "the plan is set");
  }

  private discovery: ReadStep[] = [];

  // ---------------------------------------------------------------- retrieve and extract

  private async runStep(step: ReadStep): Promise<void> {
    const entry: { step: ReadStep; outcome?: StepOutcome } = { step };
    this.plan.push(entry);
    const knownPmids = new Set(this.wb.candidatePmids);
    const knownNcts = new Set(this.wb.candidateNcts.map((c) => c.nctId));
    const { outcome, records } = await this.wb.retrieve(step);
    entry.outcome = outcome;
    const detail = { stepId: step.id, source: step.source, query: step.query, status: outcome.status, attempts: outcome.attempts, servedFrom: outcome.servedFrom, ms: outcome.ms, idempotencyKey: outcome.idempotencyKey, cached: outcome.cached };
    if (outcome.status === "OK") this.say("retriever", `${step.source}: ${outcome.detail} (${step.why})`, detail);
    else if (outcome.status === "EMPTY") this.say("retriever", `${step.source}: ${outcome.detail}. That is a statement about this search only.`, detail);
    else this.say("retriever", `${step.source} failed (${outcome.status}): ${outcome.detail}. This is not an empty result; the evidence it would have given is missing.`, detail);
    for (const ex of records) {
      this.say("extractor", `read ${ex.stored.kind} ${ex.stored.id.slice(0, 60)}: ${ex.counts.quotePassed} assertions kept, support ${ex.counts.supportPass} passed, ${ex.counts.supportFail} failed, ${ex.counts.supportUnchecked} unchecked${ex.opinions.length ? `; ${ex.opinions.length} second opinions` : ""}`, { record: ex.stored.id, counts: ex.counts, limits: ex.limits, opinions: ex.opinions });
    }
    // Branching after a read: a paper search that found papers adds them; a registry search that found studies adds them.
    if (step.source === "pubmed-eutils" && step.kind === "followup" && step.query["nct_id"] !== undefined) {
      const fresh = this.wb.candidatePmids.filter((p) => !knownPmids.has(p));
      for (const pmid of fresh.slice(0, 2)) this.queue.push(paperStep(pmid, "followup"));
      if (fresh.length) this.say("planner", `${fresh.length} paper${fresh.length === 1 ? "" : "s"} cite ${String(step.query["nct_id"])}; the first ${Math.min(2, fresh.length)} will be read`, { pmids: fresh });
    }
    if (step.kind === "discovery") {
      for (const c of this.wb.candidateNcts.filter((x) => !knownNcts.has(x.nctId))) if (!this.pendingNcts.includes(c.nctId)) this.pendingNcts.push(c.nctId);
      for (const p of this.wb.candidatePmids.filter((x) => !knownPmids.has(x))) if (!this.pendingPmids.includes(p)) this.pendingPmids.push(p);
    }
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0) {
      throwIfCancelled(this.env.signal);
      const step = this.queue.shift()!;
      try {
        await this.runStep(step);
      } catch (error) {
        if (error instanceof CancelledError) throw error;
        throw error;
      }
    }
  }

  private async retrieveStage(): Promise<void> {
    await this.drain();
    if (!this.wb.summary && !this.wb.documentFailure) {
      const ex = await this.wb.readSummary();
      if (ex) {
        this.say("retriever", `decision summary for ${this.spec.submission}: ${ex.stored.servedFrom} document, ${ex.doc.pages.length} pages`, { record: ex.stored.id, contentHash: ex.stored.contentHash, textHash: ex.stored.textHash, sourceUrl: ex.stored.url });
        this.say("extractor", `read the decision summary: ${ex.counts.quotePassed} assertions kept, support ${ex.counts.supportPass} passed, ${ex.counts.supportFail} failed, ${ex.counts.supportUnchecked} unchecked${ex.opinions.length ? `; ${ex.opinions.length} second opinions` : ""}`, { counts: ex.counts, limits: ex.limits, opinions: ex.opinions, absent: Object.entries(ex.fields).filter(([, v]) => v.status === "absent").map(([k]) => k) });
        if (this.wb.quarantined.length > 0) {
          this.say("guard", `${this.wb.quarantined.length} instruction-like passage${this.wb.quarantined.length === 1 ? "" : "s"} in the document were set aside before any reader or model saw the page`, { quarantined: this.wb.quarantined.map((q) => ({ page: q.page, kind: q.kind, reason: q.reason, text: q.text.slice(0, 160) })) });
        }
        if (this.wb.citedNcts.length > 0) {
          this.say("planner", `the summary cites ${this.wb.citedNcts.join(", ")}; reading ${this.wb.citedNcts.length === 1 ? "that registry record" : "those registry records"} and the papers that cite ${this.wb.citedNcts.length === 1 ? "it" : "them"}`, { cited: this.wb.citedNcts });
          for (const nct of this.wb.citedNcts) this.queue.push(...followupSteps(nct));
        } else {
          this.say("planner", "the summary cites no registry study; the link from this product to any study rests on the searches alone and stays a candidate until confirmed");
        }
      } else {
        const f = this.wb.documentFailure as { failure: string; message: string } | undefined;
        this.say("retriever", `the decision summary could not be read (${f?.failure}): ${f?.message}. The study and authorization evidence it carries is missing; this is not an empty document.`, { failure: f });
      }
      await this.drain();
    }
    if (this.discovery.length > 0) {
      this.queue.push(...this.discovery);
      this.discovery = [];
      await this.drain();
      // Round one reads the first candidates the searches returned; the rest wait for a replan if the claims still need them.
      const first = this.takeCandidates(Math.ceil(this.env.config.limits.maxCandidates / 2));
      if (first.length) {
        this.say("planner", `the searches returned ${this.pendingNcts.length + first.filter((s) => s.source === "clinicaltrials-v2").length} registry studies and ${this.pendingPmids.length + first.filter((s) => s.source === "pubmed-eutils").length} papers not yet read; reading the first ${first.length}`, { steps: first.map((s) => s.id) });
        this.queue.push(...first);
        await this.drain();
      }
    }
    this.go("resolve", "the sources the plan names have been read or have failed");
  }

  private takeCandidates(n: number): ReadStep[] {
    const out: ReadStep[] = [];
    const read = (id: string) => this.plan.some((p) => p.step.id === id && p.outcome);
    while (out.length < n && this.pendingNcts.length > 0) {
      const nct = this.pendingNcts.shift()!;
      const step = candidateStudyStep(nct);
      if (!read(step.id)) out.push(step);
    }
    while (out.length < n && this.pendingPmids.length > 0) {
      const pmid = this.pendingPmids.shift()!;
      const step = paperStep(pmid, "candidate");
      if (!read(step.id) && !this.wb.publications.some((p) => p.article?.pmid === pmid)) out.push(step);
    }
    return out;
  }

  // ---------------------------------------------------------------- resolve

  private async resolveStage(): Promise<void> {
    const links = await this.wb.resolveLinks();
    const counts = { CONFIRMED: 0, CANDIDATE: 0, AMBIGUOUS: 0, REJECTED: 0 };
    for (const l of links.links) counts[l.link.state] += 1;
    this.say("resolver", `${links.links.length} links resolved: ${counts.CONFIRMED} confirmed, ${counts.CANDIDATE} candidate, ${counts.AMBIGUOUS} ambiguous, ${counts.REJECTED} rejected; ${links.admitted.size} record${links.admitted.size === 1 ? "" : "s"} admitted as evidence for ${this.spec.submission}`, { counts, admitted: [...links.admitted.keys()] });
    for (const l of links.links.filter((x) => x.link.state !== "CONFIRMED" || x.derived)) {
      this.say(
        "resolver",
        `${l.link.type} ${l.fromLabel} -> ${l.toLabel}: ${l.link.state}${l.derived ? " (derived by chaining confirmed links)" : ""}; ${l.link.state === "CONFIRMED" ? "admitted" : "not used as evidence until a reviewer decides"}${l.link.flags.length ? `; ${l.link.flags[0]}` : ""}`,
        { linkId: l.link.id, state: l.link.state, candidateClass: l.candidateClass, score: l.link.score, flags: l.link.flags, reasons: l.reasons, ...(l.modelNote ? { modelNote: l.modelNote } : {}) },
      );
    }
    this.go("federate", "identity is resolved; the hospital's own requirements are next");
  }

  // ---------------------------------------------------------------- federate

  private async federateStage(): Promise<void> {
    const fed = await this.wb.readFederation();
    if (fed.status === "ok") {
      const m = fed.reads[0]!;
      this.say("retriever", `one Zetaris statement joined the hospital database, the registry snapshots and the vendor packet export: ${m.result.rows.length} rows in ${m.result.elapsedMs} ms (${m.result.servedFrom}); a second read took the ${fed.requirements.length} hospital requirements and ${fed.precedents.length} precedents`, { queryId: m.result.queryId, respHash: m.result.respHash, rows: m.result.rows.length, total: m.result.total }, { federation: { queryId: m.result.queryId, servedFrom: m.result.servedFrom } });
    } else {
      this.say("retriever", `the federation engine did not answer (${fed.failure?.failure}): ${fed.failure?.message}. The hospital's requirements are missing, so claims that depend on them cannot be supported.`, { failure: fed.failure });
    }
    this.go("compile", "all reads are done");
  }

  // ---------------------------------------------------------------- compile

  private async compileStage(): Promise<void> {
    this.env.budget.spend("turn", "compile turn");
    this.turns += 1;
    const asm: AssembledEvidence = await this.wb.assemble();
    this.say("compiler", `assembled ${asm.items.length} evidence items from ${new Set(asm.items.map((i) => asm.itemRecord.get(i.id))).size} stored records, backed by ${asm.facts.length} facts; ${asm.notExtracted.length} things could not be extracted and are listed`, { items: asm.items.map((i) => ({ id: i.id, type: i.assertionType })), notExtracted: asm.notExtracted });
    const before = new Map(this.wb.results.map((r) => [r.claim.id, r.finding] as const));
    const results = await this.wb.compileAll();
    for (const r of results) {
      const prev = before.get(r.claim.id);
      if (prev && prev.id !== r.finding.id) {
        try {
          this.history.push({ older: prev, newer: supersede(r.finding, prev, "new evidence was read after the earlier finding"), reason: "new evidence was read after the earlier finding", kind: "replan", olderEvidenceIds: [] });
        } catch {
          /* identical ids are not a change */
        }
      }
      this.say("compiler", `${r.claim.id}: ${r.finding.label}. ${r.detail.labelBasis[0] ?? ""}`.trim(), { findingId: r.finding.id, claimId: r.claim.id, label: r.finding.label, ruleVersion: r.finding.ruleVersion, basis: r.detail.labelBasis, relations: Object.fromEntries(r.finding.mechanicalCoverage.map((a) => [a.dimension, a.relation])), flags: r.finding.expertReviewFlags.map((f) => f.ruleId), degraded: r.finding.degraded.map((d) => `${d.sourceType}:${d.dependency}`) });
    }
    const unknown = results.filter((r) => r.finding.mismatches.some((m) => m.relation === "UNKNOWN"));
    const more = this.pendingNcts.length + this.pendingPmids.length;
    if (unknown.length > 0 && more > 0 && this.env.budget.remaining("turn") > 1 && this.turns < this.env.config.limits.maxTurns) {
      this.go("replan", `${unknown.length} claim${unknown.length === 1 ? "" : "s"} still ha${unknown.length === 1 ? "s" : "ve"} an unknown required dimension and ${more} candidate records are unread`);
    } else {
      this.go("critique", unknown.length > 0 ? "unknown dimensions remain and no further source is left to read; the findings say so" : "no required dimension is unknown");
    }
  }

  private replanStage(): void {
    const next = this.takeCandidates(this.env.config.limits.maxCandidates);
    this.say("planner", `replan: reading ${next.length} more candidate records because a required dimension is still unknown`, { steps: next.map((s) => s.id) });
    this.queue.push(...next);
    this.replanned = true;
    this.go("retrieve", "the plan was extended");
  }

  private replanned = false;

  // ---------------------------------------------------------------- critique and revise

  private async critiqueStage(): Promise<void> {
    const anchors = new Map(this.wb.assembled!.anchors.map((a) => [a.id, a]));
    const results = this.wb.results;
    const notes: CriticNote[] = [];
    for (const r of results) notes.push(...codeChecks(r, anchors));
    notes.push(...linkNotes(this.wb.links?.links ?? [], results));
    this.say("critic", `code checks on ${results.length} findings: ${notes.filter((n) => n.status === "confirmed").length} confirmed objections, ${notes.filter((n) => n.status === "info").length} open facts for the reviewer`, { notes: notes.map((n) => ({ id: n.id, kind: n.kind, status: n.status, findingId: n.findingId })) });

    const prompt = criticPrompt(results.map((r) => findingView(r, anchors)));
    const asked = await this.ask("critic", prompt, CRITIC_JSON_SCHEMA, 1200, "critique");
    if (asked) {
      const vetted = vetObjections(asked.json, results, anchors);
      notes.push(...vetted);
      this.say("critic", `the adversarial model raised ${vetted.length} objection${vetted.length === 1 ? "" : "s"}: ${vetted.filter((v) => v.status === "confirmed").length} confirmed by code, ${vetted.filter((v) => v.status === "unverified").length} unverified, ${vetted.filter((v) => v.status === "dismissed").length} dismissed, ${vetted.filter((v) => v.status === "info").length} already stated`, { objections: vetted.map((v) => ({ findingId: v.findingId, kind: v.kind, status: v.status, text: v.text, check: v.check })) }, { model: this.modelTag(asked.response) });
    }
    this.critic = notes;
    const actionable = notes.filter((n) => n.status === "confirmed" && n.itemIds && n.itemIds.length > 0);
    if (actionable.length > 0 && !this.revised && this.turns < this.env.config.limits.maxTurns) this.go("revise", `${actionable.length} objection${actionable.length === 1 ? " is" : "s are"} confirmed by code and name evidence to set aside`);
    else this.go("report", actionable.length > 0 ? "a confirmed objection remains after one revision; it is reported as open" : "no confirmed objection names evidence to set aside");
  }

  private async reviseStage(): Promise<void> {
    this.revised = true;
    this.env.budget.spend("turn", "revision turn");
    this.turns += 1;
    const byClaim = new Map<string, Set<string>>();
    for (const n of this.critic.filter((x) => x.status === "confirmed" && x.itemIds?.length)) {
      const set = byClaim.get(n.claimId) ?? new Set<string>();
      n.itemIds!.forEach((i) => set.add(i));
      byClaim.set(n.claimId, set);
    }
    for (const [claimId, items] of byClaim) {
      const i = this.wb.results.findIndex((r) => r.claim.id === claimId);
      if (i < 0) continue;
      const old = this.wb.results[i]!;
      const revised = await this.wb.compileClaim(old.claim, items);
      await this.wb.world.declare(revised.finding.id, revised.finding.dependsOnFacts);
      this.wb.results[i] = revised;
      const reason = `the critic's objection was confirmed by code; ${[...items].join(", ")} was set aside`;
      this.history.push({ older: old.finding, newer: supersede(revised.finding, old.finding, reason), reason, kind: "revision", olderEvidenceIds: old.evidence.map((i) => i.id) });
      for (const n of this.critic.filter((x) => x.claimId === claimId && x.status === "confirmed")) n.status = "applied";
      this.say("compiler", `${claimId}: recompiled without ${[...items].join(", ")}: ${old.finding.label} -> ${revised.finding.label}; the earlier finding is kept and the new one references it`, { oldFindingId: old.finding.id, newFindingId: revised.finding.id });
    }
    this.go("critique", "the revised findings are checked again");
  }

  // ---------------------------------------------------------------- report

  private async reportStage(): Promise<void> {
    const results = this.wb.results;
    const anchors = new Map(this.wb.assembled!.anchors.map((a) => [a.id, a]));
    const ctx = { findings: results.map((r) => r.finding), claims: new Map(results.map((r) => [r.finding.claimId, r.compiled])), anchors };
    const asked = await this.ask("reporter", reportPrompt(results, anchors), REPORT_JSON_SCHEMA, 2200, "report");
    const sentences = (asked?.json as { sentences?: unknown[] } | undefined)?.sentences;
    this.prose = composeProse(
      results,
      ctx,
      asked && Array.isArray(sentences) ? { sentences, recorded: asked.response.recorded, routedModel: asked.response.routedModel, ...(asked.response.receipt?.receiptId ? { receiptId: asked.response.receipt.receiptId } : {}) } : undefined,
      asked ? undefined : "no model sentences were available; templated sentences from the compiler's wording were used",
    );
    const fromModel = this.prose.lines.filter((l) => l.source === "model").length;
    this.say(
      "reporter",
      `${this.prose.lines.length} sentences, each tied to a finding id: ${fromModel} from the model, ${this.prose.lines.length - fromModel} from templates; code rejected ${this.prose.rejected.length}`,
      { rejected: this.prose.rejected.map((r) => ({ reason: r.reason, text: r.text?.slice(0, 120) })) },
      asked ? { model: this.modelTag(asked.response) } : {},
    );
    this.go("done", "the report is written");
  }
}

function parseJson(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)```$/.exec(t);
  try {
    return JSON.parse(fenced ? fenced[1]! : t);
  } catch {
    return undefined;
  }
}
