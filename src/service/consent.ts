/**
 * Consent for prompts that carry a vendor packet.
 *
 * The planner, critic and reporter prompts carry the structured fields of the vendor packet and the hospital's intended use. In
 * production that is vendor-confidential content, and the egress policy lets it reach a remote model only under a recorded,
 * unexpired consent that names the case and the destination. The cases shipped here are constructed: every packet is synthetic, no
 * real vendor is named as the author of a claim, and there is no patient data. For such a case this port records that fact as a
 * consent in the ledger (granted by the demo-data policy, marked synthetic, scoped to the case and to the remote lanes that exist)
 * and presents it with each vendor-confidential request, so the policy evaluates and logs every call instead of being bypassed by
 * a "public" label. A case that does not declare itself constructed gets no consent and the request is refused.
 */
import type { ConsentGrant, ConsentLedger } from "../models/index.ts";
import type { ModelPort, ModelRequest, ModelResponse } from "../ports/index.ts";

const CONSENT_TTL_MS = 6 * 60 * 60 * 1000;

export interface ConsentingOptions {
  ledger: ConsentLedger;
  caseId: string;
  /** The case's own statement that its data is constructed; absent means the case is not demo data. */
  constructedNotice: string | undefined;
  /** Destinations of the remote lanes that exist, so the consent names where the data may go. */
  remoteDestinations: () => string[];
}

export class ConsentingModelPort implements ModelPort {
  private grant: ConsentGrant | undefined;

  constructor(
    private readonly inner: ModelPort,
    private readonly options: ConsentingOptions,
  ) {}

  /** The grant made for this case, if a vendor-confidential request has needed one. */
  consent(): ConsentGrant | undefined {
    return this.grant;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.dataClass !== "vendor-confidential") return this.inner.complete(request);
    const subject = `case:${this.options.caseId}`;
    const notice = this.options.constructedNotice?.trim();
    if (!this.grant && notice) {
      const destinations = this.options.remoteDestinations();
      this.grant = this.options.ledger.grant({
        subject,
        ...(destinations.length > 0 ? { destinations } : {}),
        grantedBy: "Sakaime demo-data policy",
        reason: `The data of ${this.options.caseId} is constructed demo data (${notice.slice(0, 160)}). It names no real vendor claim and holds no patient data.`,
        ttlMs: CONSENT_TTL_MS,
        synthetic: true,
      });
    }
    // Without a consent the request goes on as it is and the egress policy refuses it, which is the point.
    const withConsent = this.grant ? { ...request, consentToken: this.grant.id, consentSubject: subject } : request;
    return this.inner.complete(withConsent as ModelRequest);
  }
}
