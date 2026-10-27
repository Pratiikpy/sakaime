/**
 * The Guard role: Scout Intent in front of every reviewer request, and the screen for text found in documents.
 *
 * A request to certify a product as safe, to approve a purchase, to contact a vendor or to send data out is recognised and
 * refused here; it never reaches a plan. Text from a document is data: instruction-like spans are set aside and shown to the
 * reviewer, and nothing in a document can change a plan, a label or an export.
 */
import { randomBytes } from "node:crypto";
import { SAKAIME_REGISTRY_PATH, Scout, scanDocument, type Decision, type ExecutionContract, type ContractExecutor } from "../engines/scout/index.ts";
import type { GuardResponseSchema } from "../api/contract.ts";
import type { z } from "zod";

type GuardResponse = z.infer<typeof GuardResponseSchema>;

export interface GuardOptions {
  /** Per-deployment secret for signing execution contracts. Without one a random secret is made and contracts verify only in this process. */
  secret?: string;
  clock: () => Date;
}

/** The four requests the registry recognises only to refuse them, in the words a reviewer reads. */
const GUARDED_REFUSAL: Readonly<Record<string, string>> = {
  certify_safe: "Certifying a product for use is not something Sakaime does.",
  approve_procurement: "Approving a purchase is not something Sakaime does.",
  contact_vendor: "Contacting a vendor is not something Sakaime does.",
  exfiltrate: "Sending data out of the system is not something Sakaime does.",
};

/** What the intents the product does act on are called when it says what it understood. */
const INTENT_PHRASE: Readonly<Record<string, string>> = {
  GENERAL: "a general question",
  review_claim: "a request to check whether the evidence covers a claim",
  compare_scope: "a request to compare the claimed use with the evidenced scope",
  add_source: "a request to add an evidence source",
  confirm_link: "a request to confirm or reject a link between two records",
  request_evidence_list: "a request for the evidence still missing",
  export_dossier: "a request to export the signed dossier",
  explain_finding: "a request to explain a finding",
  what_changed: "a request to say what changed",
};

const EXFILTRATION_NOTE = "Sakaime does not send data outside the system. A signed dossier can be exported to the case store.";

/** Why a guard layer fired, with the registry's intent ids and rule names turned into plain sentences. */
function plainReason(rule: string, detail: string | undefined, kind: string): string {
  const intent = /^guarded-intent:(.+)$/.exec(rule)?.[1] ?? (kind === "exfiltration" ? "exfiltrate" : undefined);
  if (intent && GUARDED_REFUSAL[intent]) return GUARDED_REFUSAL[intent]!;
  return detail ?? `${kind} (${rule})`;
}

/** How a request for an export contract ended. A refusal says why, and for a rate limit how long to wait. */
export type ExportContractResult =
  | { ok: true; contract: ExecutionContract }
  | { ok: false; kind: "rate_limited"; reason: string; retryAfterSeconds: number }
  | { ok: false; kind: "refused"; reason: string };

export interface GuardDecision {
  /** Absent for document text, which is scanned rather than decided. */
  decision?: Decision;
  response: GuardResponse;
}

export class Guard {
  /** Screens reviewer requests and issues the registration contract. Its limits are the reviewer's allowance for asking. */
  readonly scout: Scout;
  /**
   * Issues export contracts, and only those. It is a second Scout with the same registry, policy pack and signing secret, so the
   * same executor verifies what it signs, but it keeps its own rate limits and recent-request memory. A reviewer who asked many
   * questions, or whose prompts the guard refused, still gets the dossier they are entitled to; a reviewer who asks for exports
   * too fast is told how long to wait instead of being refused without a reason.
   */
  private readonly exporter: Scout;

  constructor(options: GuardOptions) {
    // One secret for both, so a contract signed by either verifies in this process. Without one it is random and lives in memory.
    const secret = options.secret ?? randomBytes(32).toString("hex");
    const common = { intentRegistry: SAKAIME_REGISTRY_PATH, policyPack: ["default", "adversarial-tight"], secret, clock: options.clock };
    this.scout = new Scout(common);
    this.exporter = new Scout(common);
  }

  executor(): ContractExecutor {
    return this.scout.executor({ engine: "sakaime-service" });
  }

  /** A reviewer's request or text lifted out of a document. */
  async screen(text: string, origin: "reviewer" | "document", user: { id: string; role: string; cases?: string[] } = { id: "reviewer", role: "reviewer" }, caseId?: string): Promise<GuardDecision> {
    if (origin === "document") {
      const scan = scanDocument(text);
      const findings = scan.findings.map((f) => ({ layer: f.kind === "injection" ? "injection" : f.kind, span: f.matched.slice(0, 160), reason: f.reason }));
      const allowed = !scan.quarantine;
      const response: GuardResponse = {
        allowed,
        intent: allowed ? "document_text" : "quarantined_instruction",
        findings,
        message: allowed ? "The text contains no instruction and is treated as data." : "The text asks to be obeyed. It is set aside, shown to the reviewer, and cannot change a plan, a label or an export.",
      };
      return { response };
    }
    const decision = await this.scout.decide({ prompt: text, user, surface: "api", ...(caseId ? { context: { caseId } } : {}) });
    const allowed = decision.decision === "proceed";
    const findings = decision.risk.flags.map((f) => ({ layer: f.layer, ...(f.evidence ? { span: f.evidence.slice(0, 160) } : {}), reason: plainReason(f.rule, f.detail, f.kind) }));
    // A request to send data out is caught by the injection layer when it is worded as a command; it is the same request.
    const sendsOut = decision.risk.flags.some((f) => f.layer === "injection" && f.kind === "exfiltration");
    const guardedId = decision.intent?.id && GUARDED_REFUSAL[decision.intent.id] ? decision.intent.id : sendsOut ? "exfiltrate" : undefined;
    const refusal = guardedId ? [GUARDED_REFUSAL[guardedId]!, decision.intent?.id === guardedId ? decision.suggestions?.[0] : guardedId === "exfiltrate" ? EXFILTRATION_NOTE : undefined].filter(Boolean).join(" ") : undefined;
    const response: GuardResponse = {
      allowed,
      intent: decision.intent?.id ?? decision.ignoredIntent ?? "GENERAL",
      findings,
      message: allowed
        ? `Understood as ${INTENT_PHRASE[decision.intent?.id ?? "GENERAL"] ?? "a request Sakaime acts on"}.`
        : decision.decision === "clarify"
          ? (decision.clarification?.question ?? "The request needs clarifying before it can be acted on.")
          : (refusal ?? (decision.risk.reason === "the request contains an injection" ? "The request tells Sakaime to ignore its own rules, so it was not carried out." : (decision.risk.reason ?? "This request is one the product refuses: it describes evidence coverage only and never certifies, approves, contacts a vendor or sends data out."))),
    };
    return { decision, response };
  }

  /** A contract for exporting one dossier, issued by Scout to the reviewer. Undefined when Scout refuses. */
  async exportContract(reviewer: string, caseId: string, role = "reviewer"): Promise<ExecutionContract | undefined> {
    const r = await this.issueExportContract(reviewer, caseId, role);
    return r.ok ? r.contract : undefined;
  }

  /**
   * A fresh contract for one export, awaiting the reviewer's confirmation: the request for the dossier is that confirmation, so
   * it is recorded here and the contract comes back ready. Issued at the moment of the request, so its five minutes never run
   * out before it is used.
   */
  async issueExportContract(reviewer: string, caseId: string, role = "reviewer"): Promise<ExportContractResult> {
    const d = await this.exporter.decide({ prompt: `Export the dossier for case ${caseId}`, user: { id: reviewer, role, cases: [caseId] }, surface: "api", context: { caseId } });
    if (!d.executionContract) {
      const limit = d.risk.flags.find((f) => f.layer === "rate");
      if (limit) {
        const seconds = Number(/retry after (\d+) s/.exec(limit.detail ?? "")?.[1] ?? 1);
        return { ok: false, kind: "rate_limited", retryAfterSeconds: seconds, reason: `Too many export requests in a short time. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.` };
      }
      return { ok: false, kind: "refused", reason: d.risk.reason ?? "Scout did not issue a contract for this export." };
    }
    const approved = this.exporter.approve(d.executionContract, { kind: "user-confirm", by: reviewer, decision: "approve" });
    if (!approved.ok) return { ok: false, kind: "refused", reason: `The export contract was not approved: ${approved.reason}` };
    return { ok: true, contract: approved.contract };
  }
}
