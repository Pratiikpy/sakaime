import { ConsentLedger, EgressPolicy, ForbiddenValues, PromptLog } from "../../../src/models/egress.ts";
import { MemoryTraceSink } from "../../../src/models/trace.ts";
import type { SakaimeModelRequest } from "../../../src/models/types.ts";
import { ReceiptLedger } from "../../../src/models/receipt.ts";

let counter = 0;
export const newScope = (): string => `test-scope-${++counter}-${Math.random().toString(16).slice(2, 8)}`;

export function request(overrides: Partial<SakaimeModelRequest> = {}): SakaimeModelRequest {
  return {
    role: "planner",
    system: "You are a careful assistant.",
    user: "Say hello.",
    dataClass: "public",
    memoryScope: newScope(),
    ...overrides,
  };
}

/** Transport settings that never wait: sleeps are recorded, jitter is fixed at its midpoint. */
export function instantTransport(extra: Record<string, unknown> = {}): { transport: Record<string, unknown>; sleeps: number[] } {
  const sleeps: number[] = [];
  return {
    sleeps,
    transport: {
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      random: () => 0.5,
      backoffBaseMs: 1000,
      backoffCapMs: 20_000,
      ...extra,
    },
  };
}

export function harness() {
  const trace = new MemoryTraceSink();
  const forbidden = new ForbiddenValues();
  const consents = new ConsentLedger();
  const egress = new EgressPolicy({ consents, trace, forbidden });
  const promptLog = new PromptLog({ forbidden });
  const ledger = new ReceiptLedger();
  return { trace, forbidden, consents, egress, promptLog, ledger };
}
