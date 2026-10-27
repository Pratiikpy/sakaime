/**
 * Fault injection for the drills (docs/01-prd.md F8, contract DRILLS).
 *
 * The faults live in wrappers around the ports, not in the compiler: the compiler is a pure function and has no idea a
 * drill is running. A wrapper makes a port fail the way the real one fails (the same PortError classes, the same EMPTY
 * result shape), so the behaviour under test is the behaviour the product has when that thing really breaks.
 *
 *   source_off        a named source throws UNAVAILABLE
 *   source_empty      a named source answers, with no rows (EMPTY: "none found in X on date D")
 *   zetaris_off       the federation engine throws UNAVAILABLE
 *   truncated_result  a federated result comes back cut short and is refused by the real completeness check
 *   model_off         the model route throws UNAVAILABLE
 *
 * registry_changed and injection_in_document are not port failures: they change the data a source returns. They are
 * carried to the pipeline as mutations and applied to the record before it is read.
 */
import {
  PortError,
  type CheckResult,
  type Connector,
  type FederationPort,
  type FederationQueryOptions,
  type FederationResult,
  type ModelPort,
  type ModelRequest,
  type ModelResponse,
  type ReadRequest,
  type SourceCard,
} from "../ports/index.ts";
import type { AssertionType } from "../schemas/index.ts";
import { DRILLS } from "../api/contract.ts";
import { assertComplete } from "../federation/result.ts";
import type { ConnectorReadResult } from "../sources/index.ts";
import type { DocumentProvider, SummaryDocument } from "./sources.ts";

export type DrillName = (typeof DRILLS)[number];

/** Which assertion types each source feeds. A lost source takes the whole type with it (see pipeline: conservative loss). */
export const SOURCE_TYPES: Readonly<Record<string, readonly AssertionType[]>> = {
  "openfda-510k": ["authorization"],
  "openfda-udi": ["vendor"],
  "openfda-pma": ["authorization"],
  "fda-accessdata-pdf": ["authorization", "study"],
  "fda-ai-list": ["authorization"],
  "clinicaltrials-v2": ["study"],
  "pubmed-eutils": ["study"],
  europepmc: ["study"],
  crossref: ["study"],
  "hospital-policy": ["requirement"],
};

const ALIASES: Readonly<Record<string, readonly string[]>> = {
  fda: ["openfda-510k", "openfda-udi", "openfda-pma", "fda-accessdata-pdf", "fda-ai-list"],
  regulator: ["openfda-510k", "openfda-pma", "fda-accessdata-pdf", "fda-ai-list"],
  "fda-summary": ["fda-accessdata-pdf"],
  registry: ["clinicaltrials-v2"],
  ctgov: ["clinicaltrials-v2"],
  clinicaltrials: ["clinicaltrials-v2"],
  literature: ["pubmed-eutils", "europepmc", "crossref"],
  hospital: ["hospital-policy"],
  zetaris: ["hospital-policy"],
};

export interface ResolvedTarget {
  sources: ReadonlySet<string>;
  /** The target as the reviewer wrote it. */
  label: string;
}

/**
 * A drill target names an assertion type (authorization, study, requirement), a source id, or a family (fda, registry,
 * literature, hospital). An unrecognised target is rejected: a drill that silently injects nothing proves nothing.
 */
export function resolveTarget(target: string | undefined, defaults: readonly string[]): ResolvedTarget {
  if (target === undefined || target.trim() === "") return { sources: new Set(defaults), label: defaults.join(", ") };
  const t = target.trim().toLowerCase();
  const ids = new Set<string>();
  if (t in SOURCE_TYPES) ids.add(t);
  if (ALIASES[t]) for (const id of ALIASES[t]!) ids.add(id);
  for (const [id, types] of Object.entries(SOURCE_TYPES)) if (types.includes(t as AssertionType)) ids.add(id);
  if (ids.size === 0) {
    throw new PortError("INVALID", `unknown drill target "${target.slice(0, 60)}"; use an evidence type (authorization, study, requirement), a source id (${Object.keys(SOURCE_TYPES).join(", ")}) or a family (fda, registry, literature, hospital)`, { target });
  }
  return { sources: ids, label: target.trim() };
}

export interface FaultPlan {
  drill: DrillName;
  target?: ResolvedTarget;
}

// ---------------------------------------------------------------- connector

export class FaultInjectingConnector implements Connector {
  constructor(
    private readonly inner: Connector,
    private readonly mode: "off" | "empty",
  ) {}

  get card(): SourceCard {
    return this.inner.card;
  }
  describe(): SourceCard {
    return this.inner.describe();
  }

  async check(): Promise<CheckResult> {
    const checkedAt = new Date().toISOString();
    return this.mode === "off"
      ? { health: "UNAVAILABLE", detail: "drill: this source is switched off", latencyMs: 0, checkedAt }
      : { health: "EMPTY", detail: "drill: this source answers with no rows", latencyMs: 0, checkedAt };
  }

  async discover(): Promise<{ sample: unknown[]; schemaHash: string }> {
    if (this.mode === "off") throw new PortError("UNAVAILABLE", `drill: ${this.card.id} is switched off`, { drill: true, retryable: false });
    return this.inner.discover();
  }

  async read(_request: ReadRequest): Promise<ConnectorReadResult> {
    if (this.mode === "off") throw new PortError("UNAVAILABLE", `drill: ${this.card.id} is switched off`, { drill: true, retryable: false });
    const day = new Date().toISOString().slice(0, 10);
    return {
      health: "EMPTY",
      records: [],
      servedFrom: "live",
      complete: true,
      total: 0,
      returned: 0,
      notes: [`drill: ${this.card.id} answered with no rows. None found in ${this.card.id} on ${day}; this does not show that none exist.`],
      contents: new Map(),
    };
  }
}

// ---------------------------------------------------------------- documents

export class FaultInjectingDocuments implements DocumentProvider {
  constructor(
    private readonly inner: DocumentProvider,
    private readonly mode: "off" | "empty",
  ) {}
  get servedFrom(): "live" | "recorded" {
    return this.inner.servedFrom;
  }
  async summary(submission: string): Promise<SummaryDocument> {
    if (this.mode === "off") throw new PortError("UNAVAILABLE", "drill: the FDA decision-summary source is switched off", { drill: true, submission, retryable: false });
    throw new PortError("UNAVAILABLE", `drill: no decision summary found for ${submission}; an absent file is not an empty search`, { drill: true, submission, notFound: true, retryable: false });
  }
}

// ---------------------------------------------------------------- federation

export class FaultInjectingFederation implements FederationPort {
  constructor(
    private readonly inner: FederationPort | undefined,
    private readonly fault: "off" | "truncated",
  ) {}

  get mode(): FederationPort["mode"] {
    return this.inner?.mode ?? "live";
  }

  async sql(statement: string, options?: FederationQueryOptions): Promise<FederationResult> {
    if (this.fault === "off") {
      throw new PortError("UNAVAILABLE", "drill: the federation engine is stopped (Could not create ResultSet: null)", { drill: true, retryable: false, reason: "ENGINE_STOPPED" });
    }
    if (!this.inner) throw new PortError("UNAVAILABLE", "no federation port is configured", { retryable: false });
    const result = await this.inner.sql(statement, options);
    // Cut the answer short and run the same completeness check the real ports run. It refuses; it never returns a part.
    const cut = Math.max(0, result.rows.length - 1);
    assertComplete(cut, Math.max(result.total, result.rows.length), options?.limit ?? 5000);
    return result;
  }

  async check(): Promise<CheckResult> {
    const checkedAt = new Date().toISOString();
    return this.fault === "off"
      ? { health: "UNAVAILABLE", detail: "drill: the federation engine is stopped", latencyMs: 0, checkedAt }
      : (this.inner?.check() ?? { health: "UNAVAILABLE", detail: "no federation port", latencyMs: 0, checkedAt });
  }
}

// ---------------------------------------------------------------- model

export class FaultInjectingModel implements ModelPort {
  async complete(request: ModelRequest): Promise<ModelResponse> {
    throw new PortError("UNAVAILABLE", `drill: the model route is switched off (role ${request.role})`, { drill: true, retryable: false, role: request.role });
  }
}
