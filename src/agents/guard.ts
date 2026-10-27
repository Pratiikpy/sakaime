/**
 * The Guard role: Scout Intent in front of every reviewer request, and the screen for text found in documents.
 *
 * A request to certify a product as safe, to approve a purchase, to contact a vendor or to send data out is recognised and
 * refused here; it never reaches a plan. Text from a document is data: instruction-like spans are set aside and shown to the
 * reviewer, and nothing in a document can change a plan, a label or an export.
 */
import { SAKAIME_REGISTRY_PATH, Scout, scanDocument, type Decision, type ExecutionContract, type ContractExecutor } from "../engines/scout/index.ts";
import type { GuardResponseSchema } from "../api/contract.ts";
import type { z } from "zod";

type GuardResponse = z.infer<typeof GuardResponseSchema>;

export interface GuardOptions {
  /** Per-deployment secret for signing execution contracts. Without one a random secret is made and contracts verify only in this process. */
  secret?: string;
  clock: () => Date;
}

export interface GuardDecision {
  /** Absent for document text, which is scanned rather than decided. */
  decision?: Decision;
  response: GuardResponse;
}

export class Guard {
  readonly scout: Scout;

  constructor(options: GuardOptions) {
    this.scout = new Scout({
      intentRegistry: SAKAIME_REGISTRY_PATH,
      policyPack: ["default", "adversarial-tight"],
      ...(options.secret ? { secret: options.secret } : {}),
      clock: options.clock,
    });
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
    const findings = decision.risk.flags.map((f) => ({ layer: f.layer, ...(f.evidence ? { span: f.evidence.slice(0, 160) } : {}), reason: f.detail ?? `${f.kind} (${f.rule})` }));
    const response: GuardResponse = {
      allowed,
      intent: decision.intent?.id ?? decision.ignoredIntent ?? "GENERAL",
      findings,
      message: allowed
        ? `Request understood as ${decision.intent?.id ?? "a general question"}.`
        : decision.decision === "clarify"
          ? (decision.clarification?.question ?? "The request needs clarifying before it can be acted on.")
          : decision.risk.reason ?? "This request is one the product refuses: it describes evidence coverage only and never certifies, approves, contacts a vendor or sends data out.",
    };
    return { decision, response };
  }

  /** A contract for exporting one dossier, issued by Scout to the reviewer. Undefined when Scout refuses. */
  async exportContract(reviewer: string, caseId: string, role = "reviewer"): Promise<ExecutionContract | undefined> {
    const d = await this.scout.decide({ prompt: `Export the dossier for case ${caseId}`, user: { id: reviewer, role, cases: [caseId] }, surface: "api", context: { caseId } });
    return d.executionContract;
  }
}
