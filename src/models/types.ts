import type { ModelRequest } from "../ports/index.ts";

/**
 * Per-call options the shared `ModelRequest` has no field for. Declared here rather than in the port because the port
 * is a frozen contract; every client in this directory accepts this superset, so a plain `ModelRequest` still works.
 */
export interface ModelCallOptions {
  /** Cancels the call, including any backoff wait. A cancelled call fails with UNAVAILABLE and `detail.cancelled`. */
  signal?: AbortSignal;
  /** Recorded consent that lets vendor-confidential content reach a remote lane (see ConsentLedger). */
  consentToken?: string;
  /** What the consent must name (for example `case:K123456`). Compared with the grant's subject. */
  consentSubject?: string;
}

export type SakaimeModelRequest = ModelRequest & ModelCallOptions;

/** Where a model call is processed. Storage being local does not make processing local. */
export type LaneLocation = "remote" | "local";

export interface LaneDescriptor {
  id: string;
  location: LaneLocation;
  /** A host name or a label for where the prompt goes. */
  destination: string;
  /** True only when the lane has been exercised on this machine and answered. */
  verified: boolean;
  note?: string;
}

/** The hard ceiling for one prompt. Callers that hold more must chunk (the Markovian reader does). */
export const MAX_PROMPT_BYTES = 32 * 1024;
