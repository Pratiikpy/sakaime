/**
 * The model layer: ModelPort implementations for Nemotron through Nightshift and through NVIDIA's API, a recorded
 * replay port, the role map, signed-receipt verification and the egress policy. See docs/04-meterless-plan.md s3.5
 * and docs/02-architecture.md s12.
 */
export { NvidiaClient, NVIDIA_DEFAULT_BASE_URL } from "./nvidia.ts";
export { NightshiftClient, NIGHTSHIFT_DEFAULT_BASE_URL } from "./nightshift.ts";
export { ChatModelClient } from "./client.ts";
export { ProviderChain } from "./chain.ts";
export { RecordedModelPort, RecordingModelPort, CASSETTE_SCHEMA } from "./cassette.ts";
export { promptKey } from "./keys.ts";
export { auditCassettes, describeAudit, describeAuditChecks } from "./audit.ts";
export type { CassetteAudit } from "./audit.ts";
export {
  RoleMap,
  DEFAULT_ROLE_SPECS,
  MODEL_PROFILES,
  NEMOTRON_LIGHTNING,
  NEMOTRON_ULTRA,
  NEMOTRON_SUPER_VL,
  LOCAL_LIGHTNING,
} from "./roles.ts";
export type { RoleSpec, ModelProfile } from "./roles.ts";
export { ModelHealth, selectUsable } from "./availability.ts";
export type { AvailabilitySnapshot } from "./availability.ts";
export { extractJson, stripReasoning, SchemaValidator, combineUsage } from "./structured.ts";
export {
  ReceiptLedger,
  receiptCoverage,
  verifyLiveReceipt,
  verifyStoredReceipt,
  verifyEnvelopeSignature,
  hmemCount,
  keyIdOf,
  readInstalledKeyId,
  readInstalledNightshiftVersion,
  defaultReceiptLogPath,
  RECEIPT_SCHEMA,
} from "./receipt.ts";
export type { ReceiptPolicy, ReceiptVerdict, ReceiptRejection, ReceiptCoverage, ModelDerivedItem } from "./receipt.ts";
export { ConsentLedger, EgressPolicy, EgressRouter, ForbiddenValues, PromptLog, scanForPhi } from "./egress.ts";
export type { ConsentGrant, EgressDecision, EgressMode } from "./egress.ts";
export { MemoryTraceSink, JsonlTraceSink, FanoutTraceSink } from "./trace.ts";
export type { TraceSink, TraceEvent } from "./trace.ts";
export { createModelStack, readEnvFile, MODEL_ENV_NAMES } from "./stack.ts";
export type { ModelStack, ModelStackOptions, ModelMode } from "./stack.ts";
export { MAX_PROMPT_BYTES } from "./types.ts";
export type { SakaimeModelRequest, ModelCallOptions, LaneDescriptor, LaneLocation } from "./types.ts";
