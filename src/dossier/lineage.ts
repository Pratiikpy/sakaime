/**
 * OpenLineage-style lineage events for the dossier.
 *
 * The event model (run, job, input and output datasets, facets) follows the OpenLineage specification
 * 2-0-2 (Apache-2.0, https://github.com/OpenLineage/OpenLineage). This is a small emitter written for
 * this product; no OpenLineage code is copied. What differs from a generic emitter:
 *   - facets carry the evidence anchors (with their text hashes) and the rule version that produced a finding,
 *     so a finding can be traced to the exact quoted passages and the exact rule set;
 *   - run ids are deterministic, so the same inputs and clock give a byte-identical dossier;
 *   - custom facets use the `sakaime_` prefix required by the specification for non-standard facets.
 *
 * Custom facets are defined by the Zod schemas in this file. They are not hosted anywhere, so their
 * `_schemaURL` is a URN that names the facet and its version rather than a fetchable document.
 */
import { z } from "zod";
import type { EvidenceAnchor, Finding } from "../schemas/index.ts";
import { sha256Hex } from "../util/canonical.ts";
import type { Clock } from "../ports/index.ts";

export const LINEAGE_PRODUCER = "urn:sakaime:dossier:lineage:1.0.0";
export const OPENLINEAGE_RUN_EVENT_SCHEMA = "https://openlineage.io/spec/2-0-2/OpenLineage.json#/$defs/RunEvent";

const STANDARD_FACET_SCHEMA = {
  version: "https://openlineage.io/spec/facets/1-0-1/DatasetVersionDatasetFacet.json#/$defs/DatasetVersionDatasetFacet",
  schema: "https://openlineage.io/spec/facets/1-2-0/SchemaDatasetFacet.json#/$defs/SchemaDatasetFacet",
  sql: "https://openlineage.io/spec/facets/1-1-0/SQLJobFacet.json#/$defs/SQLJobFacet",
  parent: "https://openlineage.io/spec/facets/1-2-0/ParentRunFacet.json#/$defs/ParentRunFacet",
  errorMessage: "https://openlineage.io/spec/facets/1-0-1/ErrorMessageRunFacet.json#/$defs/ErrorMessageRunFacet",
} as const;

export function customFacetSchemaUrl(facetName: string): string {
  return `urn:sakaime:lineage:facet:${facetName}:1`;
}

// ---------------------------------------------------------------- schemas

export const FacetSchema = z
  .object({
    _producer: z.string().min(1),
    _schemaURL: z.string().min(1),
  })
  .passthrough();
export type Facet = z.infer<typeof FacetSchema>;
const FacetMap = z.record(z.string().min(1), FacetSchema);
export type FacetMapT = z.infer<typeof FacetMap>;

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const LineageDatasetSchema = z.object({
  namespace: z.string().min(1),
  name: z.string().min(1),
  facets: FacetMap.optional(),
  inputFacets: FacetMap.optional(),
  outputFacets: FacetMap.optional(),
});
export type LineageDataset = z.infer<typeof LineageDatasetSchema>;

export const EVENT_TYPES = ["START", "RUNNING", "COMPLETE", "ABORT", "FAIL", "OTHER"] as const;

export const LineageEventSchema = z.object({
  eventType: z.enum(EVENT_TYPES),
  eventTime: z.string().datetime({ offset: true }),
  run: z.object({ runId: z.string().regex(RUN_ID, "run id must be a UUID"), facets: FacetMap.optional() }),
  job: z.object({ namespace: z.string().min(1), name: z.string().min(1), facets: FacetMap.optional() }),
  inputs: z.array(LineageDatasetSchema).default([]),
  outputs: z.array(LineageDatasetSchema).default([]),
  producer: z.string().min(1),
  schemaURL: z.string().min(1),
});
export type LineageEvent = z.infer<typeof LineageEventSchema>;

export const TERMINAL_EVENTS = ["COMPLETE", "ABORT", "FAIL"] as const;

// ---------------------------------------------------------------- namespaces and names

export const NS = {
  source: "sakaime.source",
  record: "sakaime.record",
  federation: "sakaime.federation",
  model: "sakaime.model",
  assertion: "sakaime.assertion",
  evidence: "sakaime.evidence",
  claim: "sakaime.claim",
  finding: "sakaime.finding",
  job: "sakaime",
} as const;

export const JOBS = {
  sourceRead: "source.read",
  federationQuery: "federation.query",
  extractEvidence: "extract.evidence",
  compile: "applicability.compile",
  modelPrefix: "model.",
} as const;

// ---------------------------------------------------------------- facets

function customFacet<T extends Record<string, unknown>>(facetName: string, body: T): Facet & T {
  return { _producer: LINEAGE_PRODUCER, _schemaURL: customFacetSchemaUrl(facetName), ...body };
}

function standardFacet<T extends Record<string, unknown>>(kind: keyof typeof STANDARD_FACET_SCHEMA, body: T): Facet & T {
  return { _producer: LINEAGE_PRODUCER, _schemaURL: STANDARD_FACET_SCHEMA[kind], ...body };
}

export interface AnchorRef {
  anchorId: string;
  recordId: string;
  textHash: string;
}

/** Dataset facet `sakaime_anchors`: the quoted passages a dataset rests on, by id and text hash. */
export function anchorsFacet(anchors: readonly Pick<EvidenceAnchor, "id" | "recordId" | "textHash">[]): Facet & { anchors: AnchorRef[] } {
  const refs = anchors
    .map((a) => ({ anchorId: a.id, recordId: a.recordId, textHash: a.textHash }))
    .sort((a, b) => (a.anchorId < b.anchorId ? -1 : a.anchorId > b.anchorId ? 1 : 0));
  return customFacet("AnchorsDatasetFacet", { anchors: refs });
}

/** Job facet `sakaime_ruleVersion`: which executable rule set produced the output. */
export function ruleVersionFacet(ruleVersion: string, registryVersion: string): Facet & { ruleVersion: string; registryVersion: string } {
  return customFacet("RuleVersionJobFacet", { ruleVersion, registryVersion });
}

export function findingFacet(finding: Pick<Finding, "label" | "claimId">): Facet & { label: string; claimId: string } {
  return customFacet("FindingOutputDatasetFacet", { label: finding.label, claimId: finding.claimId });
}

export function receiptFacet(input: {
  receiptId?: string;
  routedModel: string;
  provider: string;
  label: "live" | "recorded" | "fallback";
  receipted: boolean;
}): Facet & typeof input {
  return customFacet("ReceiptRunFacet", input);
}

export function federationFacet(input: {
  queryId: string;
  respHash: string;
  servedFrom: string;
  label: "live" | "recorded" | "fallback";
  total: number;
}): Facet & typeof input {
  return customFacet("FederationRunFacet", input);
}

export function recordVersionFacet(contentHash: string): Facet & { datasetVersion: string } {
  return standardFacet("version", { datasetVersion: contentHash });
}

export function schemaFacet(columns: readonly { name: string; type: string }[]): Facet & { fields: { name: string; type: string }[] } {
  return standardFacet("schema", { fields: columns.map((c) => ({ name: c.name, type: c.type })) });
}

export function sqlFacet(query: string, dialect: string): Facet & { query: string; dialect: string } {
  return standardFacet("sql", { query, dialect });
}

export function parentFacet(parent: { runId: string; jobNamespace: string; jobName: string }): Facet {
  return standardFacet("parent", { run: { runId: parent.runId }, job: { namespace: parent.jobNamespace, name: parent.jobName } });
}

export function errorMessageFacet(message: string): Facet & { message: string; programmingLanguage: string } {
  return standardFacet("errorMessage", { message, programmingLanguage: "typescript" });
}

/** Anchors a finding cites, in a stable order. Used by the emitter and by the verifier. */
export function findingAnchorIds(finding: Pick<Finding, "mechanicalCoverage" | "mismatches">): string[] {
  const ids = new Set<string>();
  for (const a of finding.mechanicalCoverage) for (const id of a.anchorIds) ids.add(id);
  for (const m of finding.mismatches) for (const id of m.anchorIds) ids.add(id);
  return [...ids].sort();
}

// ---------------------------------------------------------------- deterministic run ids

/** A UUID (version 5 layout) derived from a seed, so identical inputs give identical run ids. */
export function deterministicRunId(seed: string): string {
  const hex = sha256Hex(`sakaime.lineage.run|${seed}`);
  const variant = ((Number.parseInt(hex.charAt(16), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

// ---------------------------------------------------------------- emitter

export interface JobRef {
  namespace?: string;
  name: string;
  facets?: FacetMapT;
}

export interface StartOptions {
  /** Distinguishes runs of the same job. Required for determinism when a job runs more than once. */
  runKey: string;
  inputs?: LineageDataset[];
  runFacets?: FacetMapT;
  parent?: { runId: string; jobNamespace: string; jobName: string };
  /** Event time; defaults to the emitter clock. */
  at?: string;
}

export interface FinishOptions {
  outputs?: LineageDataset[];
  runFacets?: FacetMapT;
  at?: string;
}

export interface RunHandle {
  readonly runId: string;
  complete(options?: FinishOptions): LineageEvent;
  fail(error: string, options?: FinishOptions): LineageEvent;
  abort(reason: string, options?: FinishOptions): LineageEvent;
}

/**
 * Collects START and terminal events. Every run gets exactly one START and exactly one terminal event;
 * finishing a run twice is a programming error and throws, so a dossier never carries an ambiguous run.
 */
export class LineageEmitter {
  private readonly collected: LineageEvent[] = [];
  private readonly open = new Map<string, { job: Required<Pick<JobRef, "namespace" | "name">> & { facets?: FacetMapT }; inputs: LineageDataset[]; runFacets: FacetMapT }>();
  private readonly used = new Set<string>();

  constructor(private readonly clock: Clock) {}

  start(job: JobRef, options: StartOptions): RunHandle {
    const namespace = job.namespace ?? NS.job;
    const runId = deterministicRunId(`${namespace}|${job.name}|${options.runKey}`);
    if (this.used.has(runId)) throw new Error(`lineage: run key already used for job ${job.name}: ${options.runKey}`);
    this.used.add(runId);
    const runFacets: FacetMapT = { ...(options.runFacets ?? {}) };
    if (options.parent) runFacets.parent = parentFacet(options.parent);
    const jobEntry = { namespace, name: job.name, ...(job.facets ? { facets: job.facets } : {}) };
    this.open.set(runId, { job: jobEntry, inputs: options.inputs ?? [], runFacets });
    this.collected.push(
      LineageEventSchema.parse({
        eventType: "START",
        eventTime: options.at ?? this.clock.now().toISOString(),
        run: { runId, ...(Object.keys(runFacets).length ? { facets: runFacets } : {}) },
        job: jobEntry,
        inputs: options.inputs ?? [],
        outputs: [],
        producer: LINEAGE_PRODUCER,
        schemaURL: OPENLINEAGE_RUN_EVENT_SCHEMA,
      }),
    );
    const finish = (eventType: "COMPLETE" | "FAIL" | "ABORT", finishOptions: FinishOptions | undefined, extra: FacetMapT): LineageEvent => {
      const state = this.open.get(runId);
      if (!state) throw new Error(`lineage: run ${runId} was already finished`);
      this.open.delete(runId);
      const facets: FacetMapT = { ...state.runFacets, ...(finishOptions?.runFacets ?? {}), ...extra };
      const event = LineageEventSchema.parse({
        eventType,
        eventTime: finishOptions?.at ?? this.clock.now().toISOString(),
        run: { runId, ...(Object.keys(facets).length ? { facets } : {}) },
        job: state.job,
        inputs: state.inputs,
        outputs: eventType === "COMPLETE" ? (finishOptions?.outputs ?? []) : [],
        producer: LINEAGE_PRODUCER,
        schemaURL: OPENLINEAGE_RUN_EVENT_SCHEMA,
      });
      this.collected.push(event);
      return event;
    };
    return {
      runId,
      complete: (o) => finish("COMPLETE", o, {}),
      fail: (error, o) => finish("FAIL", o, { errorMessage: errorMessageFacet(error) }),
      abort: (reason, o) => finish("ABORT", o, { errorMessage: errorMessageFacet(reason) }),
    };
  }

  /** Runs started and never finished. A dossier is not built while this is non-empty. */
  unfinished(): string[] {
    return [...this.open.keys()];
  }

  events(): LineageEvent[] {
    return this.collected.map((e) => structuredClone(e));
  }
}

/** Stable id of an event inside the dossier's lineage section. */
export function lineageEventId(event: Pick<LineageEvent, "run" | "eventType">): string {
  return `${event.run.runId}/${event.eventType}`;
}
