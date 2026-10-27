/**
 * The Sakaime service: one object that owns the ports, the cases, the recorded investigations and the reviewer's decisions,
 * and answers every route of the HTTP contract. The HTTP layer is a thin skin over it; the judge script and the tests use
 * the same object.
 *
 * Modes. SAMPLE_MODE replays recorded real responses for every external read while the compiler, the identity scorer, the
 * verifiers and the guard run for real on them. Live mode reads the public sources, Zetaris and a model. A question with no
 * recording in sample mode abstains visibly (a rule path, a templated sentence) and is never answered by invention.
 */
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { z } from "zod";
import { Investigation, type InvestigationResult } from "../agents/investigation.ts";
import { Guard } from "../agents/guard.ts";
import { TraceEmitter } from "../agents/trace.ts";
import type {
  DecisionRequestSchema,
  DrillRequestSchema,
  DrillResponseSchema,
  GuardRequestSchema,
  GuardResponseSchema,
  HealthResponseSchema,
  RecomputeRequestSchema,
  RecomputeResponseSchema,
  VerifyResponseSchema,
} from "../api/contract.ts";
import { COMPILER_VERSION, applyPatch, compileDetailed, diffFindings } from "../compiler/index.ts";
import {
  DecisionLog,
  signatureNoteFor,
  createFileExportLedger,
  createMemoryExportLedger,
  exportDossier,
  serializeDossier,
  verifyDossier,
  type DecisionEntry,
  type DossierBundle,
  type ExportLedger,
} from "../dossier/index.ts";
import { ReviewLedger } from "../identity/index.ts";
import { auditCassettes, createModelStack, describeAudit, describeAuditChecks, verifyStoredReceipt, type CassetteAudit, type ModelStack } from "../models/index.ts";
import { PortError, type FederationPort, type ModelPort } from "../ports/index.ts";
import type { Finding, Link } from "../schemas/index.ts";
import { baseCompileOptions } from "./bridge.ts";
import { archiveSuperseded, type ArchivedChain } from "./history.ts";
import { Budget } from "./budget.ts";
import { buildCaseDossier, dossierSigner, recomputeFn, requiredDimensionsOf } from "./bundle.ts";
import { loadCases, type LoadedCase } from "./cases.ts";
import { SERVICE_VERSION, loadConfig, loadDotEnv, replaysSources, resumesRecording, type ConfigOverrides, type ServiceConfig } from "./config.ts";
import { ConsentingModelPort } from "./consent.ts";
import { ResumingModelPort } from "./resume.ts";
import { createFederation, type FederationSetup } from "./federation.ts";
import { FaultInjectingModel, resolveTarget, type FaultPlan } from "./faults.ts";
import { runDrill } from "./drills.ts";
import { Onboarding } from "./onboarding.ts";
import type { OnboardingResult } from "../api/contract.ts";
import { LoggedModelPort, scopeFactory } from "./model-log.ts";
import type { Mutations } from "./mutations.ts";
import type { StepOutcome } from "./reader.ts";
import { LiveDocuments, RecordedDocuments, createSources, type DocumentProvider, type SourceSetup } from "./sources.ts";
import { dimensionViews, currentFindings, detailOf, summaryOf, timeline as timelineOf, sourceRowsAcross, humanizeFinding, type CaseDetail, type CaseSummary, type RunMode, type SourceRow, type TimelineEvent, type ViewContext } from "./views.ts";
import { CancelledError, brief, errorMessage } from "./util.ts";
import { join as pjoin } from "node:path";
import type { Fetcher } from "../sources/index.ts";

type Recompute = z.infer<typeof RecomputeResponseSchema>;
type RecomputeRequest = z.infer<typeof RecomputeRequestSchema>;
type DrillRequest = z.infer<typeof DrillRequestSchema>;
type DrillResponse = z.infer<typeof DrillResponseSchema>;
type DecisionRequest = z.infer<typeof DecisionRequestSchema>;
type GuardRequest = z.infer<typeof GuardRequestSchema>;
type GuardResponse = z.infer<typeof GuardResponseSchema>;
type VerifyResponse = z.infer<typeof VerifyResponseSchema>;
type HealthResponse = z.infer<typeof HealthResponseSchema>;

export interface ServiceOverrides {
  /** Replace the model route. `null` switches models off. */
  model?: ModelPort | null;
  /** Replace the federation engine. `null` switches it off. */
  federation?: FederationPort | null;
  fetcher?: Fetcher;
  documents?: DocumentProvider;
  /** Contract signing secret, so a test can issue and redeem contracts. */
  guardSecret?: string;
}

export interface CaseRecord {
  result: InvestigationResult;
  decisions: DecisionLog;
  /** Findings the World Model has marked stale by a change since the run. */
  stale: Set<string>;
  linkEvents: { at: string; linkId: string; decision: string; reviewer: string }[];
  /** Findings a re-run replaced after a reviewer decided on them, kept with what they were computed from. */
  archive: ArchivedChain[];
}

export interface InvestigateOptions {
  signal?: AbortSignal;
  onEvent?: (e: import("../api/contract.ts").TraceEvent) => void;
  faults?: FaultPlan;
  mutations?: Mutations;
  /** Do not call the planner, critic or reporter models. */
  coreOnly?: boolean;
  /** Keep the result as the case's current record. Default true. */
  store?: boolean;
  reviewer?: { id: string; role: string };
}

export class SakaimeService {
  readonly cases: LoadedCase[];
  readonly guard: Guard;
  readonly sources: SourceSetup;
  readonly federation: FederationSetup;
  readonly linkLedger: ReviewLedger;
  private stack: ModelStack | undefined;
  private modelNote: string | undefined;
  private readonly records = new Map<string, CaseRecord>();
  private readonly inflight = new Map<string, Promise<CaseRecord>>();
  private readonly cache = new Map<string, StepOutcome>();
  private readonly policyStamps = new Map<string, { at: string; queryId: string }>();
  private readonly traces = new Map<string, TraceEmitter>();
  private readonly exportLedger: ExportLedger;
  private runSeq = new Map<string, number>();
  private fedCheck: { at: number; reachable: boolean } | undefined;
  private onboarding: Onboarding | undefined;
  private resuming: ResumingModelPort | undefined;
  private cassetteAudit: CassetteAudit | undefined;

  private constructor(
    readonly config: ServiceConfig,
    private readonly overrides: ServiceOverrides,
    stack: ModelStack | undefined,
    modelNote: string | undefined,
  ) {
    this.cases = loadCases(config.dirs.cases);
    // The guard's rate limits and contract lifetimes are about real time. The replay clock moves one millisecond per reading and
    // would never refill a bucket, so a long sample session would end with every request refused as "too many".
    this.guard = new Guard({ clock: () => new Date(), ...(overrides.guardSecret ? { secret: overrides.guardSecret } : {}) });
    this.sources = createSources(config, overrides.fetcher ? { fetcher: overrides.fetcher } : {});
    this.federation = overrides.federation === null ? { mode: "off", reachable: false, notes: ["federation was switched off"] } : overrides.federation ? { port: overrides.federation, mode: config.sample ? "cassette" : "live", reachable: true, notes: [] } : createFederation(config);
    this.linkLedger = new ReviewLedger(config.clock);
    this.stack = stack;
    this.modelNote = modelNote;
    this.exportLedger = config.sample ? createMemoryExportLedger() : createFileExportLedger(pjoin(config.dirs.state, "exports.jsonl"));
  }

  static async create(overrides: ConfigOverrides & { service?: ServiceOverrides } = {}): Promise<SakaimeService> {
    const { service, ...cfg } = overrides;
    if (!cfg.env) loadDotEnv();
    const config = loadConfig(cfg);
    const so = service ?? {};
    let stack: ModelStack | undefined;
    let note: string | undefined;
    if (so.model === undefined) {
      try {
        stack = await createModelStack({
          env: config.env,
          mode: config.sample ? "recorded" : config.record ? "record" : "live",
          cassetteDir: config.dirs.modelCassettes,
          // The key id the committed recordings were signed under, so a machine without Nightshift can still re-verify them.
          trustedKeyFile: join(dirname(config.dirs.sampleRun), "receipt-key.json"),
        });
      } catch (error) {
        note = error instanceof PortError ? error.message : errorMessage(error);
      }
    } else if (so.model === null) {
      note = "the model route was switched off";
    }
    return new SakaimeService(config, so, stack, note);
  }

  // ---------------------------------------------------------------- mode and health

  private modelPort(): ModelPort | undefined {
    if (this.overrides.model === null) return undefined;
    if (this.overrides.model) return this.overrides.model;
    if (this.stack && resumesRecording(this.config)) return (this.resuming ??= new ResumingModelPort(this.stack.port, this.config.dirs.modelCassettes));
    return this.stack?.port;
  }

  /** Read once: every recording's route and whether its receipt still verifies against the pinned key. */
  private audit(): CassetteAudit {
    return (this.cassetteAudit ??= auditCassettes(this.config.dirs.modelCassettes, { trustedKeyIds: this.stack?.keyIds ?? [] }));
  }

  /**
   * Which route answered model calls in a live or recording run, from what the stack actually did: Nightshift when it
   * answered anything or nothing was asked yet, NVIDIA only when Nightshift is not configured or every answer so far came
   * from the fallback.
   */
  private liveRoute(): { model: "nightshift" | "nvidia"; nightshiftAnswered: number; nvidiaAnswered: number } {
    const calls = this.stack?.trace.of("model.call") ?? [];
    const nightshiftAnswered = calls.filter((c) => c["provider"] === "nightshift").length;
    const nvidiaAnswered = calls.filter((c) => c["provider"] === "nvidia").length;
    const model = !this.stack?.nightshift || (nightshiftAnswered === 0 && nvidiaAnswered > 0) ? "nvidia" : "nightshift";
    return { model, nightshiftAnswered, nvidiaAnswered };
  }

  async runMode(): Promise<RunMode> {
    const notes: string[] = [];
    const replaying = this.config.sample || this.stack?.mode === "recorded";
    const audit = this.config.sample ? this.audit() : undefined;
    const recordings = audit?.total ?? 0;
    const off = this.overrides.model === null || !this.modelPort() || (this.config.sample && recordings === 0 && !this.overrides.model);
    const route = off || replaying ? undefined : this.liveRoute();
    const model: RunMode["model"] = off ? "off" : replaying ? "recorded" : (route as NonNullable<typeof route>).model;
    if (model === "off") notes.push(`no model route: ${this.config.sample && !this.modelNote ? "no model recordings are committed for sample mode" : (this.modelNote ?? "none configured")}; the rule path is used for planning, critique and prose`);
    if (model === "recorded" && audit) {
      notes.push(describeAudit(audit), ...(describeAuditChecks(audit) ? [describeAuditChecks(audit) as string] : []), "a question with no recording abstains instead of being answered");
      for (const r of audit.receiptRejected.slice(0, 3)) notes.push(`the receipt stored with ${r.file} did not re-verify (${r.reason}); that reply is shown as unreceipted`);
    } else if (model === "recorded") {
      notes.push("model answers are replayed from recordings; a question with no recording abstains instead of being answered");
    }
    if (this.stack && route) {
      // O-22: say which provider is in use, and why it is not Nightshift when it is not.
      for (const n of this.stack.notes.filter((x) => /^(Nightshift (is not|was not)|NVIDIA's API is configured)/.test(x))) notes.push(n);
      const fallbacks = this.stack.trace.of("model.provider_fallback");
      if (fallbacks.length > 0) {
        const why = String(fallbacks[0]?.["reason"] ?? "").slice(0, 140);
        notes.push(`${fallbacks.length} model call${fallbacks.length === 1 ? "" : "s"} fell back from Nightshift to NVIDIA's API (first reason: ${why}); ${route.nvidiaAnswered === 1 ? "that answer is" : "those answers are"} labelled nvidia and carry no receipt`);
      }
      const rejected = this.stack.ledger.rejected();
      if (rejected.length > 0) {
        const codes = [...new Set(rejected.map((r) => r.code))].join(", ");
        const memory = this.stack.ledger.excludedForMemory().length;
        notes.push(`${rejected.length} Nightshift receipt${rejected.length === 1 ? " was" : "s were"} rejected (${codes}) and the call${rejected.length === 1 ? " was" : "s were"} excluded${memory > 0 ? `; ${memory} showed remembered context` : ""}`);
      }
    }
    if (this.federation.mode === "off") notes.push(`no federation engine: ${this.federation.notes[0] ?? "not configured"}; the hospital's requirements cannot be read`);
    if (this.federation.mode === "cassette") notes.push("Zetaris answers are replayed from recordings of the real engine");
    if (this.config.sample) notes.push("every public source is read from recordings dated 2026-10-27");
    for (const rec of this.records.values()) {
      for (const f of rec.result.wb.failures.filter((x) => x.kind !== "candidate")) {
        const n = `${f.source} did not answer in the last run of ${rec.result.spec.id} (${f.status})`;
        if (!notes.includes(n)) notes.push(n);
      }
    }
    // Reachable means a probe or a call succeeded, not that a key is configured. A replay contacts nothing, so it claims nothing.
    const nightshiftReachable = !replaying && Boolean(this.stack?.nightshift) && (this.stack?.nightshift?.availability()?.status === "ok" || (route?.nightshiftAnswered ?? 0) > 0);
    return {
      sample: this.config.sample,
      federation: this.federation.mode,
      model,
      sources: this.config.sample ? "cassette" : "live",
      zetarisReachable: await this.zetarisReachable(),
      nightshiftReachable,
      degradedNotes: notes,
    };
  }

  private async zetarisReachable(): Promise<boolean> {
    if (!this.federation.port) return false;
    if (this.fedCheck && Date.now() - this.fedCheck.at < 15_000) return this.fedCheck.reachable;
    let reachable = false;
    try {
      const c = await Promise.race([this.federation.port.check(), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout")), 4000))]);
      reachable = c.health === "OK" || c.health === "STALE";
    } catch {
      reachable = false;
    }
    this.fedCheck = { at: Date.now(), reachable };
    return reachable;
  }

  /** In sample mode: the keys of the model recordings that were replayed, and the requests that had none. For pruning and for checks. */
  modelReplayReport(): { hits: Set<string>; misses: { role: string; promptKey: string }[] } {
    const events = this.stack?.trace.events ?? [];
    return {
      hits: new Set(events.filter((e) => e.kind === "cassette.hit").map((e) => String(e["promptKey"]))),
      misses: events.filter((e) => e.kind === "cassette.miss").map((e) => ({ role: String(e["role"]), promptKey: String(e["promptKey"]) })),
    };
  }

  async health(): Promise<HealthResponse> {
    return { ok: true, version: SERVICE_VERSION, mode: await this.runMode(), ruleVersion: ruleVersionString() };
  }

  // ---------------------------------------------------------------- investigations

  caseSpec(id: string): LoadedCase["spec"] {
    const c = this.cases.find((x) => x.spec.id === id);
    if (!c) throw new PortError("INVALID", `no case named ${id.slice(0, 60)}`, { reason: "UNKNOWN_CASE", known: this.cases.map((x) => x.spec.id) });
    return c.spec;
  }

  private nextRunId(caseId: string): string {
    const n = (this.runSeq.get(caseId) ?? 0) + 1;
    this.runSeq.set(caseId, n);
    return this.config.sample ? `run-${caseId}-${n}` : `run-${caseId}-${Date.now().toString(36)}-${n}`;
  }

  private documents(): DocumentProvider {
    if (this.overrides.documents) return this.overrides.documents;
    if (replaysSources(this.config)) return new RecordedDocuments(this.config.dirs.root, join(this.config.dirs.documents, "manifest.json"));
    const connector = this.sources.layer.connectors.get("fda-accessdata-pdf");
    if (!connector) throw new PortError("INVALID", "no FDA decision-summary connector is registered");
    return new LiveDocuments(connector);
  }

  async investigate(caseId: string, options: InvestigateOptions = {}): Promise<InvestigationResult> {
    const spec = this.caseSpec(caseId);
    const runId = this.nextRunId(caseId);
    const traceFile = this.config.sample ? undefined : join(this.config.dirs.state, "traces", `${runId}.jsonl`);
    const trace = new TraceEmitter(runId, this.config.clock, traceFile);
    if (options.onEvent) trace.subscribe(options.onEvent);
    this.traces.set(runId, trace);

    if (!this.config.sample && this.stack) await this.stack.beginRun().catch(() => undefined);
    const port = this.modelPort();
    // Prompts that carry a vendor packet reach a remote model only under a recorded consent. A replay sends nothing anywhere, so it
    // records no consent; a live or recording run records one for a constructed case and presents it with each such request.
    const leaves = Boolean(port) && !this.config.sample && this.stack !== undefined && this.stack.mode !== "recorded";
    const base = port && leaves && this.stack ? new ConsentingModelPort(port, { ledger: this.stack.consents, caseId: spec.id, constructedNotice: spec.constructedNotice, remoteDestinations: () => this.stack!.policy.mode().lanes.filter((l) => l.location === "remote").map((l) => l.destination) }) : port;
    const modelOff = options.faults?.drill === "model_off";
    const logged = base || modelOff ? new LoggedModelPort(modelOff ? new FaultInjectingModel() : base!, { clock: this.config.clock, timeoutMs: this.config.limits.callTimeoutMs, ...(options.signal ? { signal: options.signal } : {}), idPrefix: "model" }) : undefined;

    const investigation = new Investigation(spec, {
      config: this.config,
      runId,
      connectors: this.sources.layer.connectors,
      documents: this.documents(),
      federation: this.federation.port,
      model: logged,
      ...(this.modelNote && !logged ? { modelNote: this.modelNote } : {}),
      ...(options.faults ? { faults: options.faults } : {}),
      ...(options.mutations ? { mutations: options.mutations } : {}),
      ...(this.config.sample ? {} : { cache: this.cache }),
      ledger: this.linkLedger,
      policyStamps: this.policyStamps,
      budget: new Budget(this.config.limits),
      newScope: scopeFactory(runId),
      ...(options.signal ? { signal: options.signal } : {}),
      maxOpinions: 6,
      guard: this.guard,
      trace,
      reviewer: options.reviewer ?? { id: "reviewer", role: "reviewer" },
      ...(options.coreOnly ? { coreOnly: true } : {}),
    });
    const result = await investigation.run();
    if (options.store !== false && result.status === "complete") {
      const prior = this.records.get(caseId);
      const decisions = prior?.decisions ?? DecisionLog.create({ clock: this.config.clock });
      // A decision stays attached to its finding. If this run produced a different finding for a claim a reviewer had decided on,
      // the older one is kept so the dossier can list it as superseded and the decision history still resolves.
      const archive = prior ? archiveSuperseded(prior.result, prior.archive, result, decisions.entries()) : [];
      this.records.set(caseId, { result, decisions, stale: new Set(), linkEvents: prior?.linkEvents ?? [], archive });
    }
    if (result.status === "refused") throw new PortError("REFUSED", result.reason ?? "the guard refused the request", { runId });
    if (result.status === "cancelled") throw new CancelledError();
    if (result.status === "failed") throw new PortError("UNAVAILABLE", `the investigation of ${caseId} stopped: ${result.reason ?? "unknown cause"}`, { runId, reason: "INVESTIGATION_FAILED" });
    return result;
  }

  /** Runs the case once and keeps it. Concurrent callers share the run. */
  async ensureRun(caseId: string): Promise<CaseRecord> {
    this.caseSpec(caseId);
    const have = this.records.get(caseId);
    if (have) return have;
    const flying = this.inflight.get(caseId);
    if (flying) return flying;
    const p = (async () => {
      const result = await this.investigate(caseId);
      if (result.status !== "complete") throw new PortError("UNAVAILABLE", `the investigation of ${caseId} ended ${result.status}${result.reason ? `: ${result.reason}` : ""}`, { runId: result.runId });
      return this.records.get(caseId)!;
    })().finally(() => this.inflight.delete(caseId));
    this.inflight.set(caseId, p);
    return p;
  }

  recordOf(caseId: string): CaseRecord | undefined {
    return this.records.get(caseId);
  }

  traceOf(runId: string): TraceEmitter | undefined {
    return this.traces.get(runId);
  }

  // ---------------------------------------------------------------- views

  private async ctx(caseId: string): Promise<ViewContext> {
    const rec = await this.ensureRun(caseId);
    return { run: rec.result, decisions: rec.decisions.entries(), mode: await this.runMode(), stale: rec.stale, linkEvents: rec.linkEvents, archive: rec.archive };
  }

  async listCases(): Promise<CaseSummary[]> {
    const out: CaseSummary[] = [];
    for (const c of this.cases) {
      const rec = this.records.get(c.spec.id);
      if (rec) {
        out.push(summaryOf({ run: rec.result, decisions: rec.decisions.entries(), mode: await this.runMode(), stale: rec.stale, linkEvents: rec.linkEvents, archive: rec.archive }));
      } else {
        out.push({ id: c.spec.id, title: c.spec.title, productLabel: c.spec.productLabel, claimConstructed: true, openQuestions: 0, staleFindings: 0, reviewerState: "not yet investigated", updatedAt: this.config.clock.now().toISOString() });
      }
    }
    return out;
  }

  async caseDetail(caseId: string): Promise<CaseDetail> {
    return detailOf(await this.ctx(caseId));
  }

  async timeline(caseId: string, asOf?: string): Promise<TimelineEvent[]> {
    if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new PortError("INVALID", "asOf must be a date written YYYY-MM-DD", { asOf: asOf.slice(0, 20) });
    return timelineOf(await this.ctx(caseId), asOf);
  }

  async sourceRows(): Promise<SourceRow[]> {
    // The console shows each source as the investigations so far saw it. A source no case has read says so, with the health it last
    // had, rather than a state it was never observed in. Before any investigation exists, the first case is investigated.
    if (this.records.size === 0) await this.ensureRun(this.cases[0]!.spec.id);
    const mode = await this.runMode();
    return sourceRowsAcross([...this.records.values()].map((rec) => ({ run: rec.result, decisions: [], mode, stale: new Set<string>(), linkEvents: [], archive: [] })), this.config.clock.now());
  }

  // ---------------------------------------------------------------- the Applicability Lab

  async recompute(caseId: string, request: RecomputeRequest, claimId?: string): Promise<Recompute> {
    const rec = await this.ensureRun(caseId);
    const results = rec.result.results;
    const r = claimId ? results.find((x) => x.claim.id === claimId || x.finding.id === claimId) : results[0];
    if (!r) throw new PortError("INVALID", `case ${caseId} has no claim ${String(claimId).slice(0, 60)}`, { reason: "UNKNOWN_CLAIM" });
    const started = performance.now();
    const asOf = request.asOf;
    if (asOf !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) throw new PortError("INVALID", "asOf must be a date written YYYY-MM-DD");
    // Time travel: evidence that did not yet exist on the date is not read.
    const evidence = asOf ? r.evidence.filter((i) => !(i.scope.timing?.from && i.scope.timing.from > asOf)) : r.evidence;
    const before = asOf ? compileDetailed(r.compiled, evidence, r.options).finding : r.finding;
    const patched = applyPatch(r.compiled, { use: request.patch as never });
    const after = compileDetailed(patched, evidence, { ...r.options, requiredDimensions: requiredDimensionsOf(patched) });
    const diff = diffFindings(before, after.finding);
    const shown = (f: Finding): Finding => humanizeFinding(rec.result, f);
    return {
      before: shown(before),
      after: shown(after.finding),
      changed: diff.dimensions.map((d) => ({ dimension: d.dimension, before: d.from, after: d.to })),
      labelChanged: diff.label.changed,
      reasons: after.reasons.map((x) => {
        const a = shown(after.finding).mechanicalCoverage.find((m) => m.dimension === x.dimension);
        return { dimension: x.dimension, relation: x.relation, ...(a?.claimed !== undefined ? { claimed: a.claimed } : {}), ...(a?.established !== undefined ? { established: a.established } : {}), reason: x.text, anchorIds: a?.anchorIds ?? [] };
      }),
      modelCalled: false,
      elapsedMs: Math.round(performance.now() - started),
    };
  }

  // ---------------------------------------------------------------- add a source

  /** "Add a source" from a description and a URL. Idempotent: the same request never registers twice. */
  async proposeSource(input: { description: string; url: string; retry?: boolean | undefined }, reviewer = "reviewer"): Promise<OnboardingResult> {
    this.onboarding ??= new Onboarding({ config: this.config, guard: this.guard, sources: this.sources, federation: this.federation, model: this.modelPort(), ...(this.modelNote ? { modelNote: this.modelNote } : {}) });
    return this.onboarding.propose(input, reviewer);
  }

  // ---------------------------------------------------------------- drills

  async drill(caseId: string, request: DrillRequest): Promise<DrillResponse> {
    return runDrill(this, caseId, request);
  }

  // ---------------------------------------------------------------- reviewer decisions and link confirmation

  async decide(caseId: string, request: DecisionRequest, reviewer = "reviewer"): Promise<{ entry: DecisionEntry; replayed: boolean; reviewerState: Finding["reviewerState"] }> {
    const rec = await this.ensureRun(caseId);
    const r = rec.result.results.find((x) => x.finding.id === request.findingId);
    if (!r) throw new PortError("INVALID", `finding ${request.findingId.slice(0, 60)} is not a current finding of ${caseId}`, { reason: "UNKNOWN_FINDING" });
    const f = r.finding;
    const base = { idempotencyKey: request.idempotencyKey, claimId: f.claimId, findingId: f.id, reviewer, ...(request.note ? { note: request.note } : {}) };
    let input;
    switch (request.action) {
      case "accept":
        input = { ...base, action: "accept" as const };
        break;
      case "narrow":
        if (!f.supportedScope) throw new PortError("INVALID", "this finding has no narrower supported scope to narrow to; the compiler states one only for SUPPORTED_ONLY_FOR_NARROWER_SCOPE", { reason: "NO_NARROWER_SCOPE", label: f.label });
        input = { ...base, action: "narrow" as const, narrowedScope: f.supportedScope as never };
        break;
      case "request_evidence": {
        const dims = [...new Set(f.requiredEvidence.map((q) => q.dimension))];
        if (dims.length === 0) throw new PortError("INVALID", "this finding asks for no further evidence", { reason: "NOTHING_TO_REQUEST" });
        input = { ...base, action: "request_evidence" as const, requestedDimensions: dims };
        break;
      }
      case "escalate":
        input = { ...base, action: "escalate" as const, escalateTo: "AI evaluation committee" };
        break;
    }
    const { entry, replayed } = rec.decisions.append(input);
    return { entry, replayed, reviewerState: ({ accepted: "accepted", narrowed: "narrowed", evidence_requested: "evidence_requested", escalated: "escalated" } as const)[entry.resultingState] };
  }

  /** A reviewer confirms or rejects a candidate link. Idempotent on the key. The case is investigated again so the evidence follows the decision. */
  async decideLink(caseId: string, linkId: string, decision: "CONFIRM" | "REJECT", reviewer: string, idempotencyKey: string, note?: string): Promise<{ replayed: boolean; link: Link; result: InvestigationResult }> {
    const rec = await this.ensureRun(caseId);
    const known = rec.result.wb.links?.links.find((l) => l.link.id === linkId);
    if (!known) throw new PortError("INVALID", `no link ${linkId.slice(0, 60)} in case ${caseId}`, { reason: "UNKNOWN_LINK" });
    const before = this.linkLedger.events().length;
    const event = this.linkLedger.record(known.link, { idempotencyKey, reviewerId: reviewer, decision, ...(note ? { note } : {}) });
    const replayed = this.linkLedger.events().length === before;
    if (!replayed) rec.linkEvents.push({ at: event.decidedAt, linkId, decision, reviewer });
    const result = replayed ? rec.result : await this.investigate(caseId, { reviewer: { id: reviewer, role: "reviewer" } });
    const link = this.records.get(caseId)!.result.wb.links?.links.find((l) => l.link.id === linkId)?.link ?? known.link;
    return { replayed, link, result };
  }

  // ---------------------------------------------------------------- guard, dossier, verify

  async screen(request: GuardRequest, reviewer = "reviewer"): Promise<GuardResponse> {
    return (await this.guard.screen(request.text, request.origin, { id: reviewer, role: "reviewer" })).response;
  }

  async dossier(caseId: string, reviewer = "reviewer"): Promise<{ bundle: DossierBundle; contents: string; exportId: string; replayed: boolean }> {
    const rec = await this.ensureRun(caseId);
    const links = (rec.result.wb.links?.links ?? []).map((l) => l.link);
    const signer = dossierSigner(this.config);
    const bundle = buildCaseDossier({ run: rec.result, config: this.config, signer, decisions: rec.decisions.entries(), links, archive: rec.archive });
    const verify = this.verifyOptions();
    // The export guard: a dossier leaves only with a signed contract Scout issued for this case and this reviewer. The contract is
    // issued now, for this request, and redeemed at once, so a lifetime of five minutes cannot run out between the two.
    const issued = await this.guard.issueExportContract(reviewer, caseId);
    if (!issued.ok) {
      if (issued.kind === "rate_limited") throw new PortError("BLOCKED", issued.reason, { reason: "RATE_LIMITED", retryAfterSeconds: issued.retryAfterSeconds, caseId });
      throw new PortError("FORBIDDEN", `The dossier was not released: ${issued.reason}`, { caseId, reason: "EXPORT_REFUSED" });
    }
    const executor = this.guard.executor();
    const outcome = await exportDossier(bundle, {
      contract: issued.contract,
      verifyContract: (contract) => {
        const v = executor.redeem(contract, { using: ["dossier.export"], actor: reviewer, caseId });
        return v.ok ? { valid: true } : { valid: false, reason: `${v.reason}: ${v.detail}` };
      },
      idempotencyKey: `export:${caseId}:${bundle.manifest.root.slice(0, 24)}`,
      ledger: this.exportLedger,
      verify,
    });
    if (outcome.status !== "exported") throw new PortError("REFUSED", `the dossier export was refused (${outcome.code}): ${outcome.reason}`, { code: outcome.code });
    return { bundle, contents: outcome.contents, exportId: outcome.exportId, replayed: outcome.replayed };
  }

  /**
   * What a dossier is checked with: the compiler, and the compute receipts stored with its model replies. A receipt is accepted only
   * if its Ed25519 signature verifies, it was signed by a key pinned on this machine (the installed Nightshift's, or the key id
   * committed beside the recordings), it names the model that was requested, and it shows no remembered context. With no key pinned
   * a receipt is rejected, not waved through: a receipt that cannot be checked is not shown as receipted.
   */
  private verifyOptions(): { recompute: typeof recomputeFn; verifyReceipt: NonNullable<Parameters<typeof verifyDossier>[1]["verifyReceipt"]> } {
    const trusted = this.stack?.keyIds ?? [];
    return {
      recompute: recomputeFn,
      verifyReceipt: (receipt, reply) => {
        if (trusted.length === 0) return { valid: false, reason: "no receipt signing key is pinned on this machine, so the receipt's signature cannot be tied to the Nightshift installation" };
        const check = verifyStoredReceipt(receipt, { requestedModel: reply.requestedModel }, { trustedKeyIds: trusted });
        return check.ok ? { valid: true } : { valid: false, reason: check.reason };
      },
    };
  }

  async verify(bundle: unknown): Promise<VerifyResponse> {
    // Whatever parses as JSON is checked. Something that is not a dossier is a failed check with the reason, the same answer for an
    // array, a number, null and an object with the wrong parts, never a different status for each.
    if (bundle === null || typeof bundle !== "object" || Array.isArray(bundle)) {
      const what = bundle === null ? "null" : Array.isArray(bundle) ? "an array" : `a ${typeof bundle}`;
      const reason = `the body is ${what}, not a dossier. A dossier is a JSON object with a "manifest" and a "body".`;
      return { ok: false, checks: [{ name: "bundle.shape", ok: false, detail: `FAIL: ${reason}` }], failures: [{ item: "(body)", reason }], signatureNote: signatureNoteFor("demo"), keyKind: "demo" };
    }
    const result = await verifyDossier(bundle, this.verifyOptions());
    const key = (bundle as { manifest?: { signing?: { keyStatus?: string } } }).manifest?.signing?.keyStatus;
    return {
      ok: result.ok,
      checks: result.checks.map((c) => ({ name: c.id, ok: c.status !== "FAIL", detail: `${c.status}: ${c.detail}` })),
      failures: result.failures.map((f) => ({ item: f.item, reason: f.reason })),
      signatureNote: signatureNoteFor(key === "pinned" ? "pinned" : "demo"),
      keyKind: key === "pinned" ? "pinned" : "demo",
    };
  }

  /** Serialised bundle for files. */
  static serialise(bundle: DossierBundle): string {
    return serializeDossier(bundle);
  }

  // ---------------------------------------------------------------- lifecycle

  close(): void {
    this.onboarding?.close();
    for (const rec of this.records.values()) rec.result.wb.close();
    this.records.clear();
  }

  /** The findings of every investigated case, for the cross-case drill checks. */
  allFindings(): Finding[] {
    return [...this.records.values()].flatMap((r) => currentFindings({ run: r.result, decisions: r.decisions.entries(), mode: {} as RunMode, stale: r.stale, linkEvents: [], archive: r.archive }));
  }

  dimensions(caseId: string): Record<string, unknown> {
    const rec = this.records.get(caseId);
    return rec ? dimensionViews({ run: rec.result, decisions: [], mode: {} as RunMode, stale: new Set(), linkEvents: [], archive: [] }) : {};
  }

  describe(): string {
    return brief(`SakaimeService(${this.config.sample ? "sample" : "live"}, ${this.cases.length} cases)`);
  }
}

function countJson(dir: string): number {
  try {
    return readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

export function ruleVersionString(): string {
  const base = baseCompileOptions();
  const d = compileDetailed({ id: "probe", use: { product: "device:fda:K000000" } }, [], { ...base });
  return d.finding.ruleVersion;
}

export { COMPILER_VERSION, CancelledError, resolveTarget };
