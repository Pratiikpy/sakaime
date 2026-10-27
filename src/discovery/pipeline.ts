/**
 * Source discovery and onboarding: the eight-stage pipeline of docs/02-architecture.md section 5.
 *
 *   1 authorization        allowlist-first, SSRF-safe: a pasted URL outside the allowlist, or resolving to a private,
 *                          loopback, link-local or metadata address, is refused with the reason
 *   2 capability_discovery what the source card says, and what Zetaris already holds
 *   3 bounded_probe        a few rows, a schema fingerprint, compared with any stored one (DRIFTED)
 *   4 mapping_proposal     a model proposes the mapping from names and examples; public data only
 *   5 semantic_validation  deterministic: units, ranges, identifier shapes, null codes, dates, meaning, joins
 *   6 human_review         uncertain mappings are held; accepted mappings are remembered by schema hash
 *   7 registration         a Scout contract is redeemed, a snapshot is landed, the table is registered in Zetaris,
 *                          and the new source is joined with an existing silo
 *   8 monitoring           a baseline in the World Model; `checkDrift` compares later
 *
 * A model proposal alone never registers anything: stage 5 decides, and stage 7 needs a signed contract. A stage
 * that does not pass stops the run with the reason, and the unreached stages are reported as such.
 */
import { OnboardingResultSchema, ONBOARDING_STAGES, ProposeSourceRequestSchema } from "../api/contract.ts";
import { PortError } from "../ports/index.ts";
import { discoverCatalog } from "../federation/catalog.ts";
import type { DataClass } from "../schemas/common.ts";
import type { LoadedCard } from "../sources/cards.ts";
import { validateUrl, vetResolution } from "../sources/safe-fetch.ts";
import { hashOf } from "../util/canonical.ts";
import { DEFAULT_HOLDINGS, DEFAULT_JOIN_TARGETS } from "./holdings.ts";
import { diffFingerprints, describeDiff, isDrift } from "./fingerprint.ts";
import { findMapping, rememberMapping } from "./memory.ts";
import { markDrift, recordBaseline } from "./monitor.ts";
import { familyOf, probe, type Fetched, type ProbeOutcome } from "./probe.ts";
import { proposeMapping, screenValues, type ProposalResult } from "./propose.ts";
import { canonicalField } from "./canonical.ts";
import { isNullToken, text as cellText } from "./values.ts";
import type { Proposal } from "./lexical.ts";
import type { AppliedField } from "./normalise.ts";
import { registerSource, type RegistrationOutcome } from "./register.ts";
import type { LedgerEntry, ReviewTicket, StoredMapping } from "./stores.ts";
import { DEFAULT_CONFIG, type DiscoveryConfig, type DiscoveryDeps, type MappingField, type OnboardRequest, type OnboardingResult, type OnboardingStage } from "./types.ts";
import { validateMapping, type FieldApproval, type FieldVerdict, type Finding, type ValidationReport } from "./validate.ts";
import type { ProbeTable } from "./tabular.ts";
import type { DateFamily } from "./values.ts";
import type { Fingerprint } from "./fingerprint.ts";

// ---------------------------------------------------------------- identity of a request

export function normaliseRequest(r: Pick<OnboardRequest, "description" | "url" | "orgId">): { description: string; url: string; orgId: string } {
  let url = r.url.trim();
  try {
    const u = new URL(url);
    u.hash = "";
    url = u.href;
  } catch {
    /* an unparseable URL is refused at stage 1; keep it as written for the id */
  }
  return { description: r.description.replace(/\s+/g, " ").trim(), url, orgId: r.orgId };
}

/** The idempotency key: the same description, URL and organisation always give the same id. */
export const requestId = (r: Pick<OnboardRequest, "description" | "url" | "orgId">): string => hashOf(normaliseRequest(r));
/** The same URL for the same organisation, whatever was said about it. */
export const sourceKeyOf = (r: Pick<OnboardRequest, "url" | "orgId">): string => {
  const n = normaliseRequest({ ...r, description: "" });
  return hashOf({ url: n.url, orgId: n.orgId });
};

// ---------------------------------------------------------------- the run

const CAPTION: Record<OnboardingStage["stage"], string> = {
  authorization: "authorization",
  capability_discovery: "capability discovery",
  bounded_probe: "bounded probe",
  mapping_proposal: "mapping proposal",
  semantic_validation: "semantic validation",
  human_review: "human review",
  registration: "registration",
  monitoring: "monitoring",
};

const short = (s: string, n = 220): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export interface ReviewResolution {
  reviewer: string;
  decision: "accept" | "reject";
  note?: string;
  /** For a column whose day/month order is ambiguous: the order the reviewer says is right. */
  dateChoices?: Record<string, "dmy" | "mdy">;
  /**
   * Where two columns were proposed as one canonical field, the one to keep (canonical field to source field). The others
   * are left unmapped. Without a choice the duplicate stays held.
   */
  columnChoices?: Record<string, string>;
  /** A fresh Scout contract naming source.register. The contract presented with the original request is already spent. */
  contract?: unknown;
}

interface Resumed {
  ticket: ReviewTicket;
  resolution: ReviewResolution;
}

class OnboardingRun {
  readonly cfg: DiscoveryConfig;
  readonly id: string;
  readonly sourceKey: string;
  readonly now: Date;
  private stages: OnboardingStage[] = [];
  private card: LoadedCard | undefined;
  private sourceKind = "other";
  private dataClass: DataClass = "phi";
  private license = "UNSPECIFIED";
  private fetched!: Fetched;
  private table!: ProbeTable;
  private fingerprint!: Fingerprint;
  private proposal!: ProposalResult;
  private approvals = new Map<string, FieldApproval>();
  private tableApprovals: string[] = [];
  private report!: ValidationReport;
  private memoryBasis: StoredMapping | undefined;
  private reviewer: { by: string; note?: string } | undefined;
  private registration: RegistrationOutcome | undefined;
  private sourceId: string | undefined;
  private drift: { hash: string; message: string } | undefined;

  constructor(
    private readonly request: OnboardRequest,
    private readonly deps: DiscoveryDeps,
    private readonly resumed?: Resumed,
  ) {
    this.cfg = { ...DEFAULT_CONFIG, ...deps.config };
    this.id = requestId(request);
    this.sourceKey = sourceKeyOf(request);
    this.now = deps.clock.now();
  }

  // -------------------------------------------------------------- bookkeeping

  private trace(stage: OnboardingStage["stage"] | "pipeline", decision: string, detail?: Record<string, unknown>): void {
    this.deps.trace?.({ at: this.deps.clock.now().toISOString(), stage, decision, ...(detail ? { detail } : {}) });
  }

  private add(stage: OnboardingStage["stage"], status: OnboardingStage["status"], summary: string, detail?: Record<string, unknown>): OnboardingStage {
    const s: OnboardingStage = { stage, status, summary, ...(detail ? { detail } : {}) };
    this.stages.push(s);
    this.trace(stage, `${status}: ${summary}`, detail);
    return s;
  }

  private mapping(): MappingField[] {
    return (this.report?.fields ?? []).map((f) => ({
      sourceField: f.sourceField,
      canonicalField: f.canonicalField,
      ...(f.unit ? { unit: f.unit } : {}),
      ...(f.confidence !== undefined ? { confidence: Math.max(0, Math.min(1, f.confidence)) } : {}),
      check: f.check,
      ...(f.reason ? { reason: short(f.discarded ? `Discarded, the column is left unmapped: ${f.reason}` : f.reason, 300) } : {}),
    }));
  }

  /** Close the run: fill the stages that were not reached, validate the shape, record it, and return it. */
  private finish(outcome: OnboardingResult["outcome"], reason: string | undefined, o: { retryable?: boolean; registered?: boolean; beforeRecord?: (result: OnboardingResult) => void } = {}): OnboardingResult {
    const reached = new Set(this.stages.map((s) => s.stage));
    const last = this.stages[this.stages.length - 1];
    for (const name of ONBOARDING_STAGES) {
      if (reached.has(name)) continue;
      this.stages.push(
        outcome === "held_for_review"
          ? { stage: name, status: "pending", summary: `waiting for a reviewer before ${CAPTION[name]}` }
          : { stage: name, status: "skipped", summary: `not reached: ${last ? CAPTION[last.stage] : "an earlier stage"} did not pass` },
      );
    }
    this.stages.sort((a, b) => ONBOARDING_STAGES.indexOf(a.stage) - ONBOARDING_STAGES.indexOf(b.stage));
    const table = this.registration;
    const result = OnboardingResultSchema.parse({
      id: this.id,
      outcome,
      ...(reason ? { reason: short(reason, 600) } : {}),
      stages: this.stages,
      mapping: this.mapping(),
      ...(table ? { sourceId: this.sourceId, zetarisName: table.fullName } : {}),
      ...(this.fingerprint ? { schemaHash: this.fingerprint.schemaHash } : {}),
      recorded: this.proposal?.recorded ?? false,
    });
    const entry: LedgerEntry = {
      id: this.id,
      sourceKey: this.sourceKey,
      orgId: this.request.orgId,
      state: outcome === "registered" ? "registered" : outcome === "held_for_review" ? "held" : "declined",
      retryable: outcome === "declined" && (o.retryable ?? false),
      result,
      url: this.request.url,
      description: this.request.description,
      ...(this.report ? { recordKind: this.report.kind } : {}),
      ...(this.fingerprint ? { schemaHash: this.fingerprint.schemaHash, shape: this.fingerprint.shape } : {}),
      ...(o.registered ? { mapping: this.storedMapping(this.reviewer ? "reviewer" : (this.memoryBasis?.basis ?? "validators")) } : {}),
      ...(table && o.registered ? { table: { database: this.cfg.database, name: table.tableName, uri: table.uri, rows: table.rows, snapshotSha256: table.snapshotSha256 }, sourceId: this.sourceId } : {}),
      updatedAt: this.deps.clock.now().toISOString(),
    };
    // Whatever a reviewer will need is stored before the ledger says the run is waiting for them.
    o.beforeRecord?.(result);
    this.deps.ledger.put(entry);
    return result;
  }

  private decline(stage: OnboardingStage["stage"], summary: string, reason: string, retryable: boolean, detail?: Record<string, unknown>): OnboardingResult {
    this.add(stage, "failed", summary, detail);
    return this.finish("declined", reason, { retryable });
  }

  // -------------------------------------------------------------- the run

  async execute(): Promise<OnboardingResult> {
    const stop =
      (await this.authorize()) ??
      (await this.capability()) ??
      (await this.boundedProbe()) ??
      (await this.proposeStage()) ??
      (await this.validateStage()) ??
      (await this.reviewStage()) ??
      (await this.registerStage());
    return stop;
  }

  /** Continue a held onboarding from the ticket the reviewer decided. */
  async resume(): Promise<OnboardingResult> {
    const { ticket, resolution } = this.resumed!;
    this.stages = ticket.stages.filter((s) => ["authorization", "capability_discovery", "bounded_probe", "mapping_proposal"].includes(s.stage)).map((s) => ({ ...s }));
    this.card = this.deps.sources.cards.find((c) => c.file.id === ticket.cardId);
    this.sourceKind = ticket.sourceKind;
    this.dataClass = ticket.dataClass as DataClass;
    this.license = ticket.license;
    this.fetched = { ...ticket.fetched, redirects: 0, servedFrom: "live" };
    this.table = ticket.table;
    this.fingerprint = ticket.fingerprint;
    this.proposal = {
      proposals: ticket.proposals,
      proposer: ticket.proposer === "memory" ? "model" : ticket.proposer,
      recorded: ticket.recorded,
      dropped: [],
      flagged: new Map(ticket.flagged),
      disagreements: new Map(ticket.disagreements),
      ...(ticket.descriptionFlag ? { descriptionFlag: ticket.descriptionFlag } : {}),
      promptBytes: 0,
    };
    if (resolution.decision === "reject") {
      this.reviewer = { by: resolution.reviewer, ...(resolution.note ? { note: resolution.note } : {}) };
      this.report = ticket.report;
      this.add("semantic_validation", "held", ticket.result.stages.find((s) => s.stage === "semantic_validation")?.summary ?? "held for review");
      this.add("human_review", "failed", `rejected by ${resolution.reviewer}${resolution.note ? `: ${short(resolution.note, 200)}` : ""}`);
      return this.finish("declined", `Rejected by reviewer ${resolution.reviewer}${resolution.note ? `: ${resolution.note}` : ""}.`, { retryable: false });
    }
    // The reviewer accepts exactly the holds that were shown to them, for exactly the findings recorded then.
    const left = new Set<string>();
    for (const h of ticket.holds) {
      const duplicate = `duplicate-target#${h.canonicalField}`;
      const chosen = resolution.columnChoices?.[h.canonicalField];
      if (h.signatures.includes(duplicate) && chosen !== undefined && chosen !== h.sourceField) left.add(h.sourceField);
    }
    this.proposal.proposals = this.proposal.proposals.filter((x) => !left.has(x.sourceField));
    for (const h of ticket.holds) {
      if (left.has(h.sourceField)) continue;
      const choice = resolution.dateChoices?.[h.sourceField];
      const duplicate = `duplicate-target#${h.canonicalField}`;
      const signatures = h.signatures.filter((s) => (s !== "date-ambiguous#dmy|mdy" || choice !== undefined) && (s !== duplicate || resolution.columnChoices?.[h.canonicalField] === h.sourceField));
      this.approvals.set(h.sourceField, {
        by: resolution.reviewer,
        signatures,
        ...(signatures.includes("scale#percent") ? { representation: "percent" as const } : {}),
        ...(choice ? { dateFamily: choice as DateFamily } : {}),
      });
    }
    this.tableApprovals = [...ticket.tableHolds];
    this.reviewer = { by: resolution.reviewer, ...(resolution.note ? { note: resolution.note } : {}) };
    return (await this.validateStage()) ?? (await this.reviewStage()) ?? (await this.registerStage(resolution.contract));
  }

  // -------------------------------------------------------------- 1 authorization

  private async authorize(): Promise<OnboardingResult | undefined> {
    const { request, deps } = this;
    const parsed = ProposeSourceRequestSchema.safeParse({ description: request.description, url: request.url });
    if (!parsed.success || !request.orgId?.trim() || !request.actor?.trim()) {
      const why = !parsed.success ? parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ") : "an organisation and an actor are required";
      return this.decline("authorization", `The request is malformed: ${why}`, `The request is malformed (${why}).`, false);
    }
    let allowed;
    try {
      allowed = validateUrl(request.url, deps.sources.allowlist);
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      return this.decline("authorization", `Refused: ${e.message}`, `${e.message}. Only hosts named by a source card can be onboarded.`, false, {
        failure: e.failure,
        allowlisted: deps.sources.allowlist.hosts(),
      });
    }
    let addresses: string[] | undefined;
    if (deps.sources.resolver) {
      try {
        addresses = vetResolution(allowed.host, await deps.sources.resolver(allowed.host)).map((a) => a.address);
      } catch (e) {
        if (!(e instanceof PortError)) throw e;
        const transient = e.failure === "UNAVAILABLE";
        return this.decline("authorization", `Refused: ${e.message}`, transient ? `${e.message}. Try again later.` : `${e.message}. A host that resolves to a private, loopback, link-local or metadata address is never fetched.`, transient, {
          failure: e.failure,
          host: allowed.host,
          ...(e.detail ?? {}),
        });
      }
    }
    this.card = deps.sources.cards.find((c) => c.file.id === allowed.grantedBy);
    this.add(
      "authorization",
      "passed",
      `${allowed.host} is on the allowlist${allowed.grantedBy ? ` (source card ${allowed.grantedBy})` : ""}${addresses ? `; it resolves only to public addresses (${addresses.slice(0, 3).join(", ")})` : "; DNS was not checked in this mode"}`,
      { host: allowed.host, port: allowed.port, grantedBy: allowed.grantedBy ?? null, https: true, ...(addresses ? { resolvedAddresses: addresses } : { dnsChecked: false }) },
    );
    return undefined;
  }

  // -------------------------------------------------------------- 2 capability discovery

  private async capability(): Promise<OnboardingResult | undefined> {
    const { deps } = this;
    const card = this.card;
    let catalog: Awaited<ReturnType<typeof discoverCatalog>> | undefined;
    let catalogFailure: string | undefined;
    try {
      catalog = await discoverCatalog(deps.federation, { clock: deps.clock });
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      catalogFailure = `${e.failure}: ${e.message}`;
    }
    if (card) {
      this.sourceKind = card.file.kind;
      this.dataClass = card.file.dataClass;
      this.license = card.file.license;
    }
    const draft = card
      ? undefined
      : { id: "draft", baseUrl: new URL(this.request.url).origin, auth: "none", identifierFields: [] as string[], license: "UNSPECIFIED", dataClass: "phi", basis: "inferred from the description; not a verified card, so the most restrictive data class applies" };
    if (!card && !catalog) {
      return this.decline("capability_discovery", "Nothing is known about this source: it has no source card and the Zetaris catalog could not be read", `No source card describes this host and the Zetaris catalog could not be read (${catalogFailure}). Try again later.`, true, { zetaris: { reachable: false, failure: catalogFailure } });
    }
    const onboarded = catalog?.tables[`zetaris:${this.cfg.database.toLowerCase()}`] ?? [];
    this.add(
      "capability_discovery",
      "passed",
      `${card ? `source card ${card.file.id} read (identifier fields ${card.file.identifierFields.join(", ")}; ${card.file.dataClass} data; ${card.file.license.split(/[,;(]/)[0]})` : "no source card; a draft was inferred and the most restrictive data class applies"}; ${catalog ? `Zetaris lists ${catalog.databases.length} databases${onboarded.length ? `, ${onboarded.length} onboarded tables` : ""}` : `Zetaris catalog unavailable (${catalogFailure})`}`,
      {
        ...(card
          ? {
              card: {
                id: card.file.id,
                kind: card.file.kind,
                identifierFields: card.file.identifierFields,
                supportedPredicates: card.file.supportedPredicates,
                rateLimit: card.file.rateLimit ?? null,
                cadenceHours: card.file.cadenceHours ?? null,
                license: card.file.license,
                dataClass: card.file.dataClass,
                verifiedOn: card.file.verification.verifiedOn,
                notVerified: card.file.verification.notVerified.length,
              },
            }
          : { cardDraft: draft }),
        zetaris: catalog ? { reachable: true, databases: catalog.databases.map((d) => d.name), onboardedTables: onboarded, queryIds: catalog.queryIds } : { reachable: false, failure: catalogFailure },
      },
    );
    return undefined;
  }

  // -------------------------------------------------------------- 3 bounded probe

  private async boundedProbe(): Promise<OnboardingResult | undefined> {
    const outcome: ProbeOutcome = await probe({
      fetcher: this.deps.sources.fetcher,
      url: this.request.url,
      family: familyOf(this.card),
      maxBytes: this.cfg.maxProbeBytes,
      maxRows: this.cfg.maxRows,
      now: this.now,
    });
    if (outcome.kind === "failed") {
      const reason =
        outcome.failure === "TRUNCATED"
          ? `The response was cut short: ${outcome.message}.`
          : outcome.failure === "UNAVAILABLE"
            ? `The source could not be reached: ${outcome.message}. This is not a statement about whether it holds records.`
            : `The source could not be probed (${outcome.failure}): ${outcome.message}.`;
      return this.decline("bounded_probe", `${outcome.failure}: ${outcome.message}`, reason, outcome.retryable, { failure: outcome.failure, ...(outcome.fetched ? { http: outcome.fetched } : {}) });
    }
    if (outcome.kind === "empty") {
      return this.decline("bounded_probe", `EMPTY: ${outcome.reason}`, `The source answered on ${this.now.toISOString().slice(0, 10)} with no records, so there is nothing to map. That does not show that no records exist.`, true, { failure: "EMPTY", http: outcome.fetched });
    }
    this.fetched = outcome.fetched;
    this.table = outcome.table;
    this.fingerprint = outcome.fingerprint;

    const prior = this.deps.ledger.registeredBySource(this.sourceKey);
    const detail: Record<string, unknown> = {
      http: outcome.fetched,
      format: outcome.table.format,
      ...(outcome.table.container ? { container: outcome.table.container } : {}),
      rows: outcome.table.rows.length,
      columns: outcome.table.columns,
      bytes: outcome.table.bytes,
      sha256: outcome.table.sha256,
      ...(outcome.table.declaredTotal !== undefined ? { declaredTotal: outcome.table.declaredTotal } : {}),
      schemaHash: outcome.fingerprint.schemaHash,
      shape: outcome.fingerprint.shape,
      sample: outcome.table.rows.slice(0, 3),
    };
    if (prior?.shape && prior.schemaHash !== outcome.fingerprint.schemaHash) {
      const diff = diffFingerprints(prior.shape, outcome.fingerprint.shape);
      if (isDrift(diff)) {
        const stale = prior.sourceId ? await markDrift(this.deps, prior, outcome.fingerprint.schemaHash, "shape", this.now.toISOString()) : [];
        this.add("bounded_probe", "held", `DRIFTED: the shape changed since ${prior.updatedAt.slice(0, 10)}: ${describeDiff(diff)}`, { ...detail, drift: diff, previousSchemaHash: prior.schemaHash, staleFindingIds: stale });
        // The run goes on, so the reviewer is shown the new layout mapped and checked; the change itself is what they confirm.
        this.drift = { hash: outcome.fingerprint.schemaHash, message: `the source changed shape since it was registered (${describeDiff(diff)}); ${stale.length} dependent finding${stale.length === 1 ? " was" : "s were"} marked stale` };
        return undefined;
      }
    }
    this.add("bounded_probe", "passed", `${outcome.table.rows.length} records, ${outcome.table.columns.length} fields (${outcome.table.format}); schema ${outcome.fingerprint.schemaHash.slice(0, 12)}${prior ? "; same shape as the registered source" : ""}`, detail);
    return undefined;
  }

  // -------------------------------------------------------------- 4 mapping proposal

  private async proposeStage(): Promise<OnboardingResult | undefined> {
    const { deps } = this;
    const remembered = findMapping(deps.hmem, this.request.orgId, this.fingerprint.schemaHash);
    if (remembered) {
      const m = remembered.mapping;
      this.memoryBasis = m;
      this.proposal = {
        proposals: m.fields.map((f): Proposal => ({ sourceField: f.sourceField, canonicalField: f.canonicalField, confidence: 1, proposer: "memory" })),
        proposer: "model",
        recorded: false,
        dropped: [],
        flagged: new Map(),
        disagreements: new Map(),
        promptBytes: 0,
      };
      for (const f of m.fields) {
        this.approvals.set(f.sourceField, { by: m.acceptedBy, signatures: f.signatures, ...(f.representation ? { representation: f.representation } : {}), ...(f.dateFamily ? { dateFamily: f.dateFamily as DateFamily } : {}) });
      }
      this.tableApprovals = [...m.tableSignatures];
      this.add("mapping_proposal", "passed", `reused the mapping accepted by ${m.basis === "reviewer" ? `reviewer ${m.acceptedBy}` : "the validators"} on ${m.acceptedAt.slice(0, 10)} for this exact schema (${m.fields.length} fields); the model was not asked again`, {
        proposer: "memory",
        memoryRecord: remembered.record.id,
        schemaHash: this.fingerprint.schemaHash,
      });
      return undefined;
    }

    const modelAllowed = this.dataClass === "public" && this.cfg.useModel;
    this.proposal = await proposeMapping({
      table: this.table,
      description: this.request.description,
      dataClass: this.dataClass,
      models: deps.models,
      memoryScope: `discovery:${this.id}`,
      minConfidence: this.cfg.minModelConfidence,
      modelOff: !modelAllowed,
    });
    const p = this.proposal;
    if (p.proposals.length === 0) {
      return this.decline("mapping_proposal", `no column could be mapped to a canonical field${p.failure ? ` (${p.failure.failure}: ${p.failure.message})` : ""}`, "No column of this source could be mapped to a field Sakaime knows. Nothing was registered.", p.failure?.failure === "UNAVAILABLE", {
        proposer: p.proposer,
        dropped: p.dropped,
        ...(p.failure ? { failure: p.failure } : {}),
      });
    }
    this.add(
      "mapping_proposal",
      "passed",
      p.proposer === "model"
        ? `${p.model?.routedModel ?? "the model"} proposed ${p.proposals.filter((x) => x.proposer === "model").length} mappings${p.recorded ? " (replayed from a recording)" : ""}; the validator decides`
        : `${!this.cfg.useModel ? "the model is switched off" : modelAllowed ? "the model could not be used" : `the data class is ${this.dataClass}, so no model was asked`}; ${p.proposals.length} mappings came from column names and identifier shapes alone`,
      {
        proposer: p.proposer,
        recorded: p.recorded,
        ...(p.model ? { model: p.model } : {}),
        proposals: p.proposals.map((x) => ({ sourceField: x.sourceField, canonicalField: x.canonicalField, confidence: x.confidence, proposer: x.proposer })),
        dropped: p.dropped,
        flagged: [...p.flagged.entries()],
        disagreements: [...p.disagreements.entries()],
        ...(p.descriptionFlag ? { descriptionFlag: p.descriptionFlag } : {}),
        ...(p.failure ? { modelFailure: p.failure } : {}),
        promptBytes: p.promptBytes,
        dataClass: this.dataClass,
      },
    );
    return undefined;
  }

  // -------------------------------------------------------------- 5 semantic validation

  private async validateStage(): Promise<OnboardingResult | undefined> {
    const { deps, proposal } = this;
    // The names and the first few values were screened for the prompt. The snapshot carries every value of a mapped text
    // column into a table that agents query, so every value is screened too.
    const flagged = new Map(proposal.flagged);
    for (const prop of proposal.proposals) {
      const type = canonicalField(prop.canonicalField)?.type;
      if ((type !== "text" && type !== "meaning_text") || flagged.has(prop.sourceField) || !this.table.columns.includes(prop.sourceField)) continue;
      const hit = screenValues(this.table.rows.map((r) => r[prop.sourceField] ?? null).filter((c) => !isNullToken(c)).map(cellText));
      if (hit) flagged.set(prop.sourceField, hit);
    }
    const report = await validateMapping(
      {
        table: this.table,
        description: this.request.description,
        now: this.now,
        federation: deps.federation,
        holdings: deps.holdings ?? DEFAULT_HOLDINGS,
        ...(deps.rowSpecs ? { rowSpecs: deps.rowSpecs } : {}),
        joinSample: this.cfg.joinSample,
        ...(this.request.expectedJoinRate !== undefined ? { expectedJoinRate: this.request.expectedJoinRate } : {}),
        approvals: this.approvals,
        flagged,
        disagreements: proposal.disagreements,
        tableApprovals: this.tableApprovals,
      },
      proposal.proposals,
    );
    // A column whose name or sample tried to instruct the mapper is reported even when nothing was mapped to it: the
    // source is trying to steer whatever reads it, and a person should know.
    const mappedColumns = new Set(report.fields.map((f) => f.sourceField));
    for (const [column, why] of proposal.flagged) {
      if (mappedColumns.has(column)) continue;
      const sig = `injection#unmapped:${column.slice(0, 40)}`;
      report.tableFindings.push({ rule: "injection", severity: this.tableApprovals.includes(sig) ? "note" : "hold", message: `the column "${column.slice(0, 60)}" carried instruction-like text (${why}); it was left unmapped and the text never reached the mapper`, signature: sig });
    }
    if (this.drift) {
      const sig = `drift#${this.drift.hash.slice(0, 12)}`;
      report.tableFindings.push({ rule: "drift", severity: this.tableApprovals.includes(sig) ? "note" : "hold", message: `${this.drift.message}; a person confirms the new layout before it is registered`, signature: sig });
    }
    if (proposal.descriptionFlag) {
      const sig = "injection#description";
      const approved = this.tableApprovals.includes(sig);
      report.tableFindings.push({ rule: "injection", severity: approved ? "note" : "hold", message: `the description contained instruction-like text (${proposal.descriptionFlag}); it was removed before the mapper saw it`, signature: sig });
    }
    this.report = report;

    const rejected = report.fields.filter((f) => f.check === "rejected" && !f.discarded);
    const tableRejects = report.tableFindings.filter((f) => f.severity === "reject");
    const holds = report.fields.filter((f) => f.check === "needs_review");
    const tableHolds = report.tableFindings.filter((f) => f.severity === "hold");
    const detail = this.validationDetail(report);

    if (rejected.length > 0 || tableRejects.length > 0) {
      const first = rejected[0];
      const why = first ? `the column "${first.sourceField}" cannot be mapped to ${first.canonicalField}: ${first.reason}` : tableRejects[0]!.message;
      this.add("semantic_validation", "failed", `${rejected.length + tableRejects.length} finding${rejected.length + tableRejects.length === 1 ? "" : "s"} rejected the mapping: ${why}`, detail);
      return this.finish("declined", `Not registered: ${why}. A mapping the evidence contradicts is not registered, and a reviewer cannot override it.`, { retryable: false });
    }
    if (holds.length > 0 || tableHolds.length > 0) {
      this.add("semantic_validation", "held", `${holds.length + tableHolds.length} finding${holds.length + tableHolds.length === 1 ? " needs" : "s need"} a reviewer: ${holds[0] ? `${holds[0].sourceField}: ${holds[0].reason}` : tableHolds[0]!.message}`, detail);
      return undefined;
    }
    const dropped = report.fields.filter((f) => f.discarded).length;
    this.add("semantic_validation", "passed", `${report.fields.length} fields checked; none rejected, none held${dropped ? `; ${dropped} model proposal${dropped === 1 ? " was" : "s were"} discarded as unsupported and contradicted by the values` : ""}${report.keyField ? `; key ${report.keyField}` : ""}`, detail);
    return undefined;
  }

  private validationDetail(report: ValidationReport): Record<string, unknown> {
    const brief = (f: Finding) => ({ rule: f.rule, severity: f.severity, message: short(f.message, 300) });
    return {
      recordKind: report.kind,
      ...(report.keyField ? { keyField: report.keyField } : {}),
      fields: report.fields.map((f) => ({
        sourceField: f.sourceField,
        canonicalField: f.canonicalField,
        check: f.check,
        proposer: f.proposer,
        ...(f.unit ? { unit: f.unit } : {}),
        findings: f.findings.map(brief),
        ...(f.join ? { join: { checked: f.join.checked, matched: f.join.matched, rate: f.join.rate, target: `${f.join.target.database}.${f.join.target.table}.${f.join.target.column}`, queryId: f.join.queryId, servedFrom: f.join.servedFrom } } : {}),
      })),
      tableFindings: report.tableFindings.map(brief),
      duplicates: report.duplicates,
      ...(report.agreement ? { agreement: report.agreement } : {}),
      unmapped: report.unmapped,
      discarded: report.fields.filter((f) => f.discarded).map((f) => ({ sourceField: f.sourceField, canonicalField: f.canonicalField, reason: f.reason })),
    };
  }

  // -------------------------------------------------------------- 6 human review

  private storedMapping(basis: StoredMapping["basis"]): StoredMapping {
    const used = (f: FieldVerdict) => this.approvals.get(f.sourceField);
    return {
      schemaHash: this.fingerprint.schemaHash,
      recordKind: this.report.kind,
      fields: this.report.fields
        .filter((f) => f.check === "ok" || f.check === "renamed")
        .map((f) => {
          const a = used(f);
          const signatures = a?.signatures ?? [];
          return {
            sourceField: f.sourceField,
            canonicalField: f.canonicalField,
            ...(f.unit ? { unit: f.unit } : {}),
            conversions: f.conversions,
            signatures,
            ...(a?.representation ? { representation: a.representation } : {}),
            ...(a?.dateFamily ? { dateFamily: a.dateFamily } : {}),
          };
        }),
      tableSignatures: [...this.tableApprovals],
      basis,
      acceptedBy: this.reviewer?.by ?? this.memoryBasis?.acceptedBy ?? "validators",
      acceptedAt: this.memoryBasis?.acceptedAt ?? this.now.toISOString(),
    };
  }

  private async reviewStage(): Promise<OnboardingResult | undefined> {
    const { deps, report } = this;
    const holds = report.fields.filter((f) => f.check === "needs_review");
    const tableHolds = report.tableFindings.filter((f) => f.severity === "hold");
    if (holds.length > 0 || tableHolds.length > 0) {
      const ticket: ReviewTicket = {
        id: this.id,
        createdAt: this.now.toISOString(),
        status: "pending",
        request: { description: this.request.description, url: this.request.url, orgId: this.request.orgId, actor: this.request.actor, ...(this.request.caseId ? { caseId: this.request.caseId } : {}), ...(this.request.expectedJoinRate !== undefined ? { expectedJoinRate: this.request.expectedJoinRate } : {}) },
        table: this.table,
        fingerprint: this.fingerprint,
        proposals: this.proposal.proposals,
        proposer: this.memoryBasis ? "memory" : this.proposal.proposer,
        recorded: this.proposal.recorded,
        sourceId: this.card?.file.id ?? "draft",
        sourceKind: this.sourceKind,
        dataClass: this.dataClass,
        license: this.license,
        ...(this.card ? { cardId: this.card.file.id } : {}),
        fetched: { finalUrl: this.fetched.finalUrl, status: this.fetched.status, sha256: this.fetched.sha256, at: this.fetched.at },
        flagged: [...this.proposal.flagged.entries()],
        disagreements: [...this.proposal.disagreements.entries()],
        ...(this.proposal.descriptionFlag ? { descriptionFlag: this.proposal.descriptionFlag } : {}),
        stages: [],
        report,
        holds: holds.map((f) => ({ sourceField: f.sourceField, canonicalField: f.canonicalField, signatures: f.findings.filter((x) => x.severity === "hold" && x.signature).map((x) => x.signature!) })),
        tableHolds: tableHolds.map((f) => f.signature!).filter(Boolean),
        needsDateChoice: holds.filter((f) => f.findings.some((x) => x.signature === "date-ambiguous#dmy|mdy")).map((f) => f.sourceField),
        result: undefined as unknown as OnboardingResult,
      };
      const reason = `${holds.length + tableHolds.length} finding${holds.length + tableHolds.length === 1 ? "" : "s"} for a reviewer: ${[...holds.map((f) => `${f.sourceField} as ${f.canonicalField}: ${f.reason}`), ...tableHolds.map((f) => f.message)].slice(0, 3).join(" | ")}`;
      this.add("human_review", "held", `held for a reviewer: ${holds.length} column${holds.length === 1 ? "" : "s"}${tableHolds.length ? ` and ${tableHolds.length} table-level finding${tableHolds.length === 1 ? "" : "s"}` : ""}`, {
        ticket: this.id,
        holds: ticket.holds,
        tableHolds: ticket.tableHolds,
        needsDateChoice: ticket.needsDateChoice,
      });
      return this.finish("held_for_review", reason, {
        beforeRecord: (result) => {
          ticket.stages = result.stages.map((s) => ({ ...s }));
          ticket.result = result;
          deps.reviews.put(ticket);
        },
      });
    }
    const basis: StoredMapping["basis"] = this.reviewer ? "reviewer" : "validators";
    const stored = this.storedMapping(basis);
    if (stored.fields.length === 0) return this.decline("human_review", "no field survived validation", "No column survived validation, so nothing was registered.", false);
    const record = this.memoryBasis && !this.reviewer ? undefined : rememberMapping(deps.hmem, this.request.orgId, stored);
    this.add("human_review", "passed", this.reviewer ? `accepted by reviewer ${this.reviewer.by}${this.reviewer.note ? `: ${short(this.reviewer.note, 160)}` : ""}; the mapping is stored under schema ${this.fingerprint.schemaHash.slice(0, 12)}` : this.memoryBasis ? "no field needed review; the stored mapping still validates" : `no field needed review; the mapping is stored under schema ${this.fingerprint.schemaHash.slice(0, 12)}`, {
      reviewer: this.reviewer?.by ?? null,
      ...(record ? { memoryRecord: record.id } : {}),
    });
    return undefined;
  }

  // -------------------------------------------------------------- 7 registration, 8 monitoring

  private async registerStage(contractOverride?: unknown): Promise<OnboardingResult> {
    const { deps, request } = this;
    const contract = contractOverride ?? request.contract;
    if (contract === undefined || contract === null) {
      return this.decline("registration", "refused: no Scout execution contract was presented", "Registration needs a signed Scout execution contract that names source.register; none was presented. The mapping has passed the checks and is remembered, so resubmitting with a contract registers without asking the model again.", true);
    }
    const redeemed = deps.executor.redeem(contract, { using: ["source.register"], actor: request.actor, ...(request.caseId ? { caseId: request.caseId } : {}) });
    if (!redeemed.ok) {
      return this.decline("registration", `refused: the execution contract was rejected (${redeemed.reason}): ${redeemed.detail}`, `Registration was refused because the execution contract is not valid (${redeemed.reason}). Request a new contract and resubmit.`, true, { reason: redeemed.reason });
    }
    const applied: AppliedField[] = this.report.fields.filter((f) => f.check === "ok" || f.check === "renamed").map((f) => ({ sourceField: f.sourceField, canonicalField: f.canonicalField, conversions: f.conversions }));
    let outcome: RegistrationOutcome;
    try {
      outcome = await registerSource(deps, this.cfg, { id: this.id, kind: this.report.kind, table: this.table, fields: applied, ...(this.report.keyField ? { keyField: this.report.keyField } : {}), fetched: this.fetched }, deps.joins ?? DEFAULT_JOIN_TARGETS);
    } catch (e) {
      if (!(e instanceof PortError)) throw e;
      return this.decline("registration", `${e.failure}: ${e.message}`, `Registration did not complete (${e.failure}): ${e.message}. The contract was used; request a new one to retry. Nothing is registered twice if you do.`, e.failure === "UNAVAILABLE", { failure: e.failure, ...(e.detail ?? {}) });
    }
    this.registration = outcome;
    this.sourceId = `onboarded:${outcome.tableName}`;
    this.add(
      "registration",
      "passed",
      `${outcome.kept ? "found the table already registered and verified it" : "landed the snapshot and registered"} ${outcome.fullName} (${outcome.rows} rows)${outcome.join ? `; joined with ${outcome.join.rows} existing record${outcome.join.rows === 1 ? "" : "s"} in one federated query` : outcome.joinSkipped ? `; ${outcome.joinSkipped}` : ""}`,
      {
        table: outcome.fullName,
        uri: outcome.uri,
        rows: outcome.rows,
        snapshotSha256: outcome.snapshotSha256,
        kept: outcome.kept,
        databaseCreated: outcome.databaseCreated,
        exactDuplicatesDropped: outcome.exactDuplicatesDropped,
        queryIds: outcome.queryIds,
        contract: { id: (contract as { contractId?: string }).contractId ?? null, capability: "source.register" },
        ...(outcome.join ? { join: outcome.join } : { joinSkipped: outcome.joinSkipped }),
      },
    );

    const baseline = await recordBaseline(deps, { sourceId: this.sourceId, url: request.url, schemaHash: this.fingerprint.schemaHash, kind: this.report.kind, table: outcome.fullName });
    this.add("monitoring", "passed", `baseline recorded: schema ${this.fingerprint.schemaHash.slice(0, 12)} as a fact about ${baseline.entityId}; a later drift check marks the findings that depend on it stale`, {
      entity: baseline.entityId,
      schemaFact: baseline.schemaFactId,
    });
    return this.finish("registered", undefined, { registered: true });
  }
}

// ---------------------------------------------------------------- entry points

/**
 * Onboard a source nobody wrote an adapter for, without a code change, or decline it with the reason.
 * Idempotent: the same description, URL and organisation never register twice, and a request that was held or
 * registered returns its recorded result.
 */
export async function onboardSource(request: OnboardRequest, deps: DiscoveryDeps): Promise<OnboardingResult> {
  const id = requestId(request);
  return exclusively(deps.ledger, id, async () => {
    const prior = deps.ledger.get(id);
    if (prior) {
      if (prior.state === "registered" || prior.state === "held") return prior.result;
      if (!prior.retryable && !request.retry) return prior.result;
    }
    return new OnboardingRun(request, deps).execute();
  });
}

const running = new WeakMap<object, Map<string, Promise<unknown>>>();

/**
 * Two calls for one request at the same moment run one after the other, so the second sees what the first recorded and
 * replays it instead of registering a second time. Per ledger, because the ledger is what makes a request unique.
 */
async function exclusively<T>(scope: object, key: string, run: () => Promise<T>): Promise<T> {
  const queues = running.get(scope) ?? running.set(scope, new Map()).get(scope)!;
  const before = queues.get(key) ?? Promise.resolve();
  const mine = before.then(run, run);
  const tail = mine.catch(() => undefined);
  queues.set(key, tail);
  try {
    return await mine;
  } finally {
    if (queues.get(key) === tail) queues.delete(key);
  }
}

/**
 * A reviewer's decision on a held onboarding. Acceptance covers exactly the findings that were shown; a rejection by
 * the validator is never overridden. On acceptance the run continues with a fresh contract.
 */
export function resolveReview(ticketId: string, resolution: ReviewResolution, deps: DiscoveryDeps): Promise<OnboardingResult> {
  return exclusively(deps.ledger, ticketId, () => resolveNow(ticketId, resolution, deps));
}

async function resolveNow(ticketId: string, resolution: ReviewResolution, deps: DiscoveryDeps): Promise<OnboardingResult> {
  const ticket = deps.reviews.get(ticketId);
  if (!ticket) throw new PortError("INVALID", `no review ticket ${ticketId}`, { reason: "UNKNOWN_TICKET" });
  if (ticket.status !== "pending") {
    const entry = deps.ledger.get(ticketId);
    // An accepted review whose registration was refused (no contract, an expired one, the engine down) can be completed:
    // the acceptance stands and a fresh contract is all that is missing.
    const completing = ticket.status === "accepted" && resolution.decision === "accept" && resolution.contract !== undefined && entry?.state === "declined" && entry.retryable;
    if (!completing) {
      if (entry) return entry.result;
      throw new PortError("INVALID", `ticket ${ticketId} is already ${ticket.status}`, { reason: "RESOLVED" });
    }
  }
  if (!resolution.reviewer?.trim()) throw new PortError("INVALID", "a reviewer name is required", { reason: "NO_REVIEWER" });
  const run = new OnboardingRun({ ...ticket.request }, deps, { ticket, resolution });
  const result = await run.resume();
  const decided = resolution.decision === "reject" || result.stages.find((s) => s.stage === "human_review")?.status === "passed";
  // A decision that left findings open has already stored a new ticket under the same id; only a settled one closes it.
  if (decided) {
    deps.reviews.put({
      ...ticket,
      status: resolution.decision === "reject" ? "rejected" : "accepted",
      resolvedBy: resolution.reviewer,
      resolvedAt: deps.clock.now().toISOString(),
      ...(resolution.note ? { resolutionNote: resolution.note } : {}),
    });
  }
  return result;
}
