/**
 * Scout Intent for Sakaime: intent, guard, route, signed execution contract.
 *
 * Scout decides; it executes nothing. Every downstream action acts on a signed contract it issued, and the
 * executor (not Scout) refuses a contract that is unsigned, altered, expired, replayed, out of scope or
 * missing a required approval.
 */

export type RiskClass = "low" | "medium" | "high";
export type RiskLevel = RiskClass | "block";

export type DecisionKind = "proceed" | "clarify" | "block" | "quarantine";

/** Where the text came from. Text from a document has no authority: it can never select an intent. */
export type Surface = "chat" | "api" | "cli" | "document";

export interface ParameterSpec {
  /** Semantic names that must be bound before the intent may proceed (see interpret.ts for the binders). */
  required?: string[];
  /** Any one of these satisfies the requirement as a group. */
  requiredAnyOf?: string[][];
  properties?: Record<string, unknown>;
}

export interface Trigger {
  /** A regular expression (source only, case-insensitive) matched against the normalised request. */
  phrase: string;
  weight: number;
}

export interface Intent {
  id: string;
  category: string;
  description: string;
  parameters: ParameterSpec;
  capabilities: string[];
  riskClass: RiskClass;
  surfaces: string[];
  roles: string[];
  examples: string[];
  version: number;
  /** Extension: explicit lexical triggers. Without them the scorer derives features from id, examples and description. */
  triggers?: Trigger[];
  /** Extension: an intent that is never executed. "block" always refuses; "clarify" always asks. */
  guarded?: "block" | "clarify";
  /** Extension: the contract may be redeemed once (writes and exports). */
  singleUse?: boolean;
  /** Extension: the user must be assigned to the case in context. */
  requiresAssignment?: boolean;
  /** Extension: what to offer instead when the intent is refused. */
  alternatives?: string[];
  /** Extension: the role the model port should use for this intent's model calls. */
  modelRole?: string;
}

export interface RegistryFile {
  version: number;
  note?: string;
  graph?: string;
  intents: Intent[];
}

export interface UserRef {
  id: string;
  role: string;
  /** Case ids the user is assigned to. */
  cases?: string[];
}

export interface DecideInput {
  prompt: string;
  user?: UserRef;
  surface?: string;
  context?: DecideContext;
}

export interface DecideContext {
  caseId?: string;
  findingId?: string;
  /** The intent of the previous turn, for the contextual term. */
  previousIntent?: string;
  /** Data class of the material the request refers to. */
  dataClass?: "public" | "vendor-confidential";
  /** Where the prompt came from when it was lifted out of a document, for the audit trail. */
  documentId?: string;
  page?: number;
}

export interface IntentCandidate {
  intent: string;
  score: number;
  /** Character span of the prompt this candidate explains (multi-intent). */
  span?: [number, number];
  lexical: number;
  semantic: number;
  contextual: number;
  /** True for the GENERAL entry added when no intent cleared the reject band. */
  fallback?: boolean;
}

export type GuardLayerName = "injection" | "policy" | "scope" | "pii" | "rate";
export type GuardVerdict = "pass" | "warn" | "block";

export interface RiskFlag {
  layer: GuardLayerName;
  verdict: Exclude<GuardVerdict, "pass">;
  kind: string;
  /** Rule or check that produced it. */
  rule: string;
  score?: number;
  detail?: string;
  /** Matched span in the text the layer examined, and a short stub of it. Payloads are never stored in full. */
  span?: [number, number];
  evidence?: string;
}

export interface Redaction {
  kind: string;
  count: number;
}

export interface ApprovalSpec {
  kind: "user-confirm" | "operator-review";
  reason: string;
}

export interface ApprovalRecord {
  kind: "user-confirm" | "operator-review";
  by: string;
  at: string;
  decision: "approve" | "reject";
  /** The contract this approval is for. A record for another contract is not accepted. */
  contractId?: string;
}

export interface Risk {
  level: RiskLevel;
  flags: RiskFlag[];
  redactions: Redaction[];
  approvalsRequired: ApprovalSpec[];
  reason?: string;
}

export interface Clarification {
  kind: "low-confidence" | "tie" | "missing-parameter" | "confirm-high-risk";
  question: string;
  /** At most four, each mapping to an intent. */
  options: { intent: string; label: string }[];
  missing?: string[];
}

export interface ToolStep {
  capability: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface ModelProfileRef {
  id: string;
  lane: "remote" | "local" | "none";
  role: string;
  dataClass: "public" | "vendor-confidential" | "phi";
}

export type ContractStatus = "ready" | "awaiting-approval" | "awaiting-clarification";

export interface ExecutionContract {
  contractId: string;
  parentId?: string;
  traceId: string;
  status: ContractStatus;
  intent: {
    primary: { id: string; version: number; riskClass: RiskClass };
    parameters: Record<string, unknown>;
    references: Record<string, string>;
    confidence: number;
    alternates: { intent: string; score: number }[];
    /** Further intents of a multi-intent request, in order of appearance. */
    secondary: string[];
  };
  risk: { level: RiskClass; flags: RiskFlag[]; redactions: Redaction[]; approvals: ApprovalRecord[] };
  toolPlan: ToolStep[];
  modelProfile: ModelProfileRef;
  scope: {
    user: { id: string; role: string };
    surface: string;
    capabilities: string[];
    caseId?: string;
    singleUse: boolean;
  };
  issuedAt: string;
  expiresAt: string;
  registryVersion: number;
  /** Hash of the registry the contract was issued under, so an executor can tell it changed. */
  registryHash: string;
  policyPackVersion: string;
  /** When the first contract of this chain was issued; a chain of refreshes is bounded from here. */
  chainStartedAt: string;
  signedBy: "scout";
  signature: string;
}

export interface Decision {
  decision: DecisionKind;
  traceId: string;
  candidates: IntentCandidate[];
  /** The intent chosen, if any, even when the decision is to clarify. */
  intent?: { id: string; confidence: number };
  /** Further intents when the request holds several, in order of appearance. */
  intents: string[];
  risk: Risk;
  clarification?: Clarification;
  toolPlan: ToolStep[];
  /** Absent when the request is blocked or quarantined. */
  executionContract?: ExecutionContract;
  /** What to offer in place of a refused request. */
  suggestions?: string[];
  /** Prompt with PII removed; use this, not the original, for anything downstream. */
  redactedPrompt?: string;
  routing?: { failed: string[] };
  /** Intents not acted on because the text came from a document. */
  ignoredIntent?: string;
  classifier?: "not-used" | "tightened" | "no-change" | "failed";
  overrides?: never[];
  timing: { latencyMs: number };
  policyPackVersion: string;
  registryVersion: number;
}

export interface ScoutEvent {
  event: "scout.decision" | "scout.clarification" | "contract.issued" | "contract.verified" | "contract.refused" | "contract.expired";
  at: string;
  traceId?: string;
  contractId?: string;
  detail: Record<string, unknown>;
}

export type Telemetry = (event: ScoutEvent) => void;
