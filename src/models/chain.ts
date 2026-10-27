import { PortError, type ModelPort, type ModelResponse } from "../ports/index.ts";
import type { TraceSink } from "./trace.ts";
import type { SakaimeModelRequest } from "./types.ts";

export interface NamedPort {
  name: string;
  port: ModelPort;
}

/**
 * Tries providers in order. The next one is used only when the previous says UNAVAILABLE (and was not cancelled), or,
 * if asked, when Nightshift's receipt was rejected: the answer then comes from the next provider and is labelled with
 * that provider, not as Nightshift's. A refusal (egress), a malformed request and a failed schema are never retried
 * elsewhere, because a different provider would not change them.
 */
export class ProviderChain implements ModelPort {
  constructor(
    private readonly ports: readonly NamedPort[],
    private readonly options: { trace: TraceSink; fallbackOnReceiptRejection?: boolean },
  ) {
    if (ports.length === 0) throw new PortError("INVALID", "a provider chain needs at least one provider");
  }

  async complete(request: SakaimeModelRequest): Promise<ModelResponse> {
    let last: unknown;
    for (const [index, { name, port }] of this.ports.entries()) {
      try {
        return await port.complete(request);
      } catch (error) {
        last = error;
        const isLast = index === this.ports.length - 1;
        if (!(error instanceof PortError) || isLast) throw error;
        const unavailable = error.failure === "UNAVAILABLE" && error.detail?.["cancelled"] !== true;
        const receiptRejected = this.options.fallbackOnReceiptRejection === true && error.detail?.["receiptRejection"] !== undefined;
        if (!unavailable && !receiptRejected) throw error;
        this.options.trace.emit("model.provider_fallback", {
          role: request.role,
          from: name,
          to: this.ports[index + 1]?.name,
          reason: error.message,
          ...(receiptRejected ? { receiptRejection: error.detail?.["receiptRejection"] } : {}),
        });
      }
    }
    throw last;
  }
}
