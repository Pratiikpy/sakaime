/**
 * The service's adapter to source discovery (src/discovery): "Add a source" from a description and a URL.
 *
 * The pipeline itself lives in src/discovery and runs the eight stages of docs/02-architecture.md section 5. This file only
 * wires its dependencies to what the service holds: the source cards and allowlist, the federation port, the model route, the
 * memory engines, a Scout executor for the registration contract and an object store for landed snapshots. Where a dependency
 * is not available in the current mode (no model, no object store, a federation cassette that cannot take DDL) it is replaced by
 * one that says so, so the pipeline stops at the stage that needs it and reports why. Nothing is faked to get further.
 */
import { join } from "node:path";
import { DEFAULT_CONFIG, JsonFileLedger, MemoryLedger, MemoryReviewQueue, ObjectStoreLander, onboardSource, requestId, type DiscoveryDeps, type SnapshotLander } from "../discovery/index.ts";
import { ONBOARDING_STAGES } from "../api/contract.ts";
import { validateUrl } from "../sources/safe-fetch.ts";
import { HMEM } from "../engines/hmem/index.ts";
import { WorldModel } from "../engines/world-model/index.ts";
import { PortError, type ModelPort } from "../ports/index.ts";
import type { OnboardingResult } from "../api/contract.ts";
import type { Guard } from "../agents/guard.ts";
import type { ServiceConfig } from "./config.ts";
import type { FederationSetup } from "./federation.ts";
import type { SourceSetup } from "./sources.ts";

class NoModel implements ModelPort {
  constructor(private readonly why: string) {}
  async complete(): Promise<never> {
    throw new PortError("UNAVAILABLE", `no model route is available for the mapping proposal: ${this.why}`, { retryable: false });
  }
}

class NoLander implements SnapshotLander {
  async put(): Promise<never> {
    throw new PortError("UNAVAILABLE", "no object store is configured to land the snapshot; set SAKAIME_OBJECT_STORE_URL (live mode only)", { retryable: false });
  }
}

export interface OnboardingParts {
  config: ServiceConfig;
  guard: Guard;
  sources: SourceSetup;
  federation: FederationSetup;
  model: ModelPort | undefined;
  modelNote?: string;
}

export class Onboarding {
  private deps: DiscoveryDeps | undefined;
  private readonly hmem: HMEM;
  private readonly world: WorldModel;

  constructor(private readonly parts: OnboardingParts) {
    this.hmem = new HMEM({ clock: () => parts.config.clock.now().getTime(), actor: "sakaime-service" });
    this.world = new WorldModel({ storage: "memory", namespace: "onboarding", clock: () => parts.config.clock.now() });
  }

  private build(): DiscoveryDeps {
    if (this.deps) return this.deps;
    const p = this.parts;
    if (!p.federation.port) throw new PortError("UNAVAILABLE", `no federation engine is available to register a source: ${p.federation.notes[0] ?? "not configured"}`, { retryable: false });
    const endpoint = p.config.env["SAKAIME_OBJECT_STORE_URL"];
    this.deps = {
      sources: { allowlist: p.sources.layer.allowlist, cards: p.sources.layer.cards, fetcher: p.sources.layer.fetcher },
      federation: p.federation.port,
      models: p.model ?? new NoModel(p.modelNote ?? "none configured"),
      hmem: this.hmem,
      worldModel: this.world,
      executor: p.guard.executor(),
      landing: endpoint && !p.config.sample ? new ObjectStoreLander({ endpoint }) : new NoLander(),
      ledger: p.config.sample ? new MemoryLedger() : new JsonFileLedger(join(p.config.dirs.state, "onboarding.json")),
      reviews: new MemoryReviewQueue(),
      clock: p.config.clock,
      config: { ...DEFAULT_CONFIG },
    };
    return this.deps;
  }

  /** Answers already given, by request id: a repeated request gets the same answer, byte for byte, until a retry is asked for. */
  private readonly answers = new Map<string, Promise<OnboardingResult>>();

  /**
   * "Add a source". Every outcome is an OnboardingResult: registered, held for a reviewer, or declined with the reason. A host
   * off the allowlist, a metadata or private address and a request the guard refuses all end at stage 1 as declined; none is an
   * error. The same request again returns what was answered the first time. A decline that the pipeline marks retryable (the
   * source was down, say) is run again only when the caller sets `retry`.
   */
  async propose(input: { description: string; url: string; retry?: boolean | undefined }, actor: string): Promise<OnboardingResult> {
    const deps = this.build();
    const request = { description: input.description, url: input.url, orgId: "hospital-a", actor };
    const id = requestId(request);
    const known = this.answers.get(id);
    if (known && !input.retry) return structuredClone(await known);
    const run = this.run(request, id, deps, input.retry === true);
    this.answers.set(id, run);
    try {
      return structuredClone(await run);
    } catch (error) {
      if (this.answers.get(id) === run) this.answers.delete(id);
      throw error;
    }
  }

  private async run(request: { description: string; url: string; orgId: string; actor: string }, id: string, deps: DiscoveryDeps, retry: boolean): Promise<OnboardingResult> {
    // The registration contract: Scout recognises the request as adding a source and signs a short-lived, scope-limited contract.
    const decision = await this.parts.guard.scout.decide({ prompt: `Add this source: ${request.url} (${request.description})`, user: { id: request.actor, role: "reviewer" }, surface: "api" });
    if (decision.decision === "block" || decision.decision === "quarantine") {
      // Where the address itself is what is wrong, the pipeline's own first stage says so in its own words, as it does for any host
      // off the allowlist. Where the address is acceptable and the guard refused the request for another reason, say that.
      let addressRefused = false;
      try {
        validateUrl(request.url, deps.sources.allowlist);
      } catch {
        addressRefused = true;
      }
      if (addressRefused) return onboardSource({ ...request, ...(retry ? { retry: true } : {}) }, deps);
      return this.declinedByGuard(id, decision.risk.reason ?? "it matched a guarded intent");
    }
    return onboardSource({ ...request, ...(decision.executionContract ? { contract: decision.executionContract } : {}), ...(retry ? { retry: true } : {}) }, deps);
  }

  /** The shape the pipeline gives a request it declines at its first stage, for a request the guard refused. */
  private declinedByGuard(id: string, why: string): OnboardingResult {
    const reason = `The guard refused the request: ${why}`;
    return {
      id,
      outcome: "declined",
      reason,
      stages: ONBOARDING_STAGES.map((stage) =>
        stage === "authorization"
          ? { stage, status: "failed" as const, summary: `Refused: ${why}`, detail: { guard: true } }
          : { stage, status: "skipped" as const, summary: "not reached: authorization did not pass" },
      ),
      mapping: [],
      recorded: false,
    };
  }

  close(): void {
    this.hmem.close();
    this.world.close();
  }
}
