/**
 * Types shared by the source discovery and onboarding pipeline (docs/02-architecture.md section 5).
 *
 * The public result is `OnboardingResult` from src/api/contract.ts. Everything here is either an input to the
 * pipeline (request, dependencies) or an internal record that ends up inside a stage's `detail`.
 */
import type { z } from "zod";
import type { OnboardingStageSchema, MappingFieldSchema, OnboardingResult } from "../api/contract.ts";
import type { Clock, FederationPort, ModelPort } from "../ports/index.ts";
import type { HMEM } from "../engines/hmem/index.ts";
import type { VerifyResult } from "../engines/scout/contract.ts";
import type { WorldModel } from "../engines/world-model/index.ts";
import type { LoadedCard } from "../sources/cards.ts";
import type { Fetcher } from "../sources/fetcher.ts";
import type { HostAllowlist, Resolver } from "../sources/safe-fetch.ts";
import type { HoldingsMap, JoinTargets, RowSpecs } from "./holdings.ts";
import type { OnboardingLedger, ReviewQueue } from "./stores.ts";
import type { SnapshotLander } from "./landing.ts";

export type OnboardingStage = z.infer<typeof OnboardingStageSchema>;
export type MappingField = z.infer<typeof MappingFieldSchema>;
export type { OnboardingResult };

export interface OnboardRequest {
  /** One line saying what the source holds. Untrusted text: it reaches a model only after the injection screen. */
  description: string;
  /** Must resolve inside the allowlist built from the source cards. */
  url: string;
  /** Organisation the mapping memory and the ledger are scoped to. */
  orgId: string;
  /** The authenticated user the Scout contract was issued to. */
  actor: string;
  caseId?: string;
  /** A signed Scout execution contract naming `source.register`. Without one the pipeline stops before registration. */
  contract?: unknown;
  /** What the source is expected to join to in the data we hold, 0..1. Absent means no expectation is declared. */
  expectedJoinRate?: number;
  /** Re-run a request whose earlier attempt was declined for a transient reason. */
  retry?: boolean;
}

/** A Scout executor, narrowed to what registration needs. `ContractExecutor` satisfies it. */
export interface ContractRedeemer {
  redeem(contract: unknown, use: { using: readonly string[]; actor?: string; caseId?: string }): VerifyResult;
}

export interface DiscoveryConfig {
  /** Zetaris lightning database the normalised snapshots are registered under. */
  database: string;
  /** Object-store bucket the snapshots are landed in. */
  bucket: string;
  /** Extra OPTIONS for the filestore table (S3 endpoint as the Zetaris containers see it). */
  filestoreOptions: string;
  /** Zetaris identity that runs DDL; read probes use the port's default identity. */
  adminIdentity: string;
  /** Roles granted SELECT on the registered database. */
  grantRoles: string[];
  /** Largest response the bounded probe will accept, in bytes. */
  maxProbeBytes: number;
  /** Most rows a bounded endpoint may return. */
  maxRows: number;
  /** Rows shown to the model per column are drawn from the first this-many records. */
  sampleRows: number;
  /** Model replies with lower confidence are not used as proposals. */
  minModelConfidence: number;
  /** Most distinct values sent to a join probe. */
  joinSample: number;
  /** Switch the model off: the proposal then comes from column names and identifier shapes alone (the ablation). */
  useModel: boolean;
}

export const DEFAULT_CONFIG: DiscoveryConfig = {
  database: "sk_onboarded",
  bucket: "sakaime-onboarded",
  filestoreOptions: 'isS3BucketPublic "true", s3Endpoint "http://object-store:9090", useS3PathStyleAccess "true"',
  adminIdentity: "admin",
  grantRoles: ["agent_readonly", "case_reviewer_assigned", "case_reviewer_unassigned"],
  maxProbeBytes: 2 * 1024 * 1024,
  maxRows: 5000,
  sampleRows: 25,
  minModelConfidence: 0.5,
  joinSample: 200,
  useModel: true,
};

export interface TraceEntry {
  at: string;
  stage: OnboardingStage["stage"] | "pipeline";
  decision: string;
  detail?: Record<string, unknown>;
}

export interface DiscoveryDeps {
  sources: { allowlist: HostAllowlist; cards: LoadedCard[]; fetcher: Fetcher; resolver?: Resolver };
  /** Read probes (catalog, joins) run as the default identity; DDL runs as `config.adminIdentity` with the admin policy. */
  federation: FederationPort;
  models: ModelPort;
  hmem: HMEM;
  worldModel: WorldModel;
  executor: ContractRedeemer;
  landing: SnapshotLander;
  ledger: OnboardingLedger;
  reviews: ReviewQueue;
  clock: Clock;
  /** Where the data we already hold lives, per canonical field. Defaults to the Sakaime silos. */
  holdings?: HoldingsMap;
  /** Where the rest of a held record lives, by key, to compare mapped columns with. Defaults to the Sakaime silos. */
  rowSpecs?: RowSpecs;
  /** Which silo a registered source is joined with, per key field. Defaults to the Sakaime silos. */
  joins?: JoinTargets;
  config?: Partial<DiscoveryConfig>;
  trace?: (entry: TraceEntry) => void;
}

/** Why a stage did not pass, for the outcome mapping. */
export type StopKind = "declined" | "held";
