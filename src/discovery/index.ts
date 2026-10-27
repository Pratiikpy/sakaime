/**
 * Source discovery and onboarding (docs/02-architecture.md section 5): the Track 1 centrepiece. A source nobody wrote an
 * adapter for is onboarded without a code change, or declined with the reason.
 */
export { onboardSource, resolveReview, requestId, sourceKeyOf, normaliseRequest } from "./pipeline.ts";
export type { ReviewResolution } from "./pipeline.ts";
export { checkDrift, recordBaseline, markDrift, schemaFactId, sourceEntityId } from "./monitor.ts";
export type { DriftReport, DriftStatus } from "./monitor.ts";
export { DEFAULT_CONFIG } from "./types.ts";
export type { DiscoveryDeps, DiscoveryConfig, OnboardRequest, ContractRedeemer, TraceEntry } from "./types.ts";
export { MemoryLedger, JsonFileLedger, MemoryReviewQueue, JsonFileReviewQueue } from "./stores.ts";
export type { OnboardingLedger, ReviewQueue, ReviewTicket, LedgerEntry, StoredMapping } from "./stores.ts";
export { ObjectStoreLander } from "./landing.ts";
export type { SnapshotLander, LandedObject } from "./landing.ts";
export { DEFAULT_HOLDINGS, DEFAULT_JOIN_TARGETS } from "./holdings.ts";
export type { HoldingsMap, HoldingsTarget, JoinTargets } from "./holdings.ts";
export { CANONICAL_FIELDS, canonicalField } from "./canonical.ts";
export { fingerprintOf, schemaHashOf, diffFingerprints } from "./fingerprint.ts";
export { parseProbe } from "./tabular.ts";
export { validateMapping } from "./validate.ts";
export type { FieldVerdict, ValidationReport, Finding } from "./validate.ts";
export { lexicalProposals } from "./lexical.ts";
export { proposeMapping, screenText } from "./propose.ts";
export { tableNameFor } from "./register.ts";
export { openZetaris, zetarisAuthFromEnv, login } from "./zetaris-auth.ts";
export { DEFAULT_ROW_SPECS } from "./holdings.ts";
export type { RowSpecs } from "./holdings.ts";
