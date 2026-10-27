import type { Dimension, EvidenceItem, ExpertFlag, Relation, Scope } from "../schemas/index.ts";

export type Layer = "authorization" | "study";

/** A limit stated by the authorization record that the claim runs past. Only these can produce CONTRADICTED from an authorization. */
export interface Explicit {
  ruleId: "R10-POP-LABEL-EXCLUDED" | "R21-PREDATES-AUTH";
  text: string;
}

/** What comparing one claimed value with one established value yields. */
export interface Outcome<V> {
  relation: Relation;
  /** Present for PARTIAL when one narrower scope can be stated. */
  narrower?: V;
  /** Plain-language account of the relation. */
  detail: string;
  /** The part of the claim the evidence does not cover, rendered. */
  gap?: string;
  /** Deterministic rules that decided the relation. */
  ruleIds: string[];
  flags: ExpertFlag[];
  explicit: Explicit[];
  /** UNKNOWN because a human must place a term, not because evidence is missing. */
  pending?: boolean;
  /** The terms a reviewer must place, when `pending`. */
  term?: string;
}

/** How one dimension is read from a claim and from an evidence item, and how two values are compared. */
export interface Ops<V> {
  dimension: Dimension;
  claim(use: Scope): V | undefined;
  item(item: EvidenceItem): V | undefined;
  union(a: V, b: V): V;
  /** Combine what two layers establish: the claim must lie inside both. */
  meet(a: V, b: V): V;
  relate(claimed: V, established: V): Outcome<V>;
  /** True when two layers have nothing in common on this dimension. */
  isEmpty(v: V): boolean;
  render(v: V): string;
  /** The claimed scope restricted to `v`, as fields of a Scope. */
  toScope(v: V): Partial<Scope>;
}

/** The result for one dimension, before it is shaped into the Finding's schema types. */
export interface DimResult {
  dimension: Dimension;
  relation: Relation;
  claimed?: string;
  established?: string;
  evidenceIds: string[];
  anchorIds: string[];
  reason: string;
  /** What would settle a non-CONTAINED dimension, specific enough to send to a vendor. */
  request?: string;
  ruleIds: string[];
  flags: ExpertFlag[];
  explicit: Explicit[];
  pending: boolean;
  /** UNKNOWN only because other dimensions are not contained, so listing it again would repeat them. */
  derived?: boolean;
  /** For PARTIAL: the scope fields the evidence does cover. */
  narrower?: Partial<Scope>;
}

export interface TraceStep {
  ruleId: string;
  dimension?: Dimension;
  effect: string;
}
