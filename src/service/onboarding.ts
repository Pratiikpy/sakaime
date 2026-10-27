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
import { DEFAULT_CONFIG, JsonFileLedger, MemoryLedger, MemoryReviewQueue, ObjectStoreLander, onboardSource, type DiscoveryDeps, type SnapshotLander } from "../discovery/index.ts";
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

  async propose(input: { description: string; url: string }, actor: string): Promise<OnboardingResult> {
    const deps = this.build();
    // The registration contract: Scout recognises the request as adding a source and signs a short-lived, scope-limited contract.
    const decision = await this.parts.guard.scout.decide({ prompt: `Add this source: ${input.url} (${input.description})`, user: { id: actor, role: "reviewer" }, surface: "api" });
    if (decision.decision === "block" || decision.decision === "quarantine") {
      throw new PortError("REFUSED", `the guard refused the request: ${decision.risk.reason ?? "it matched a guarded intent"}`, { intent: decision.intent?.id });
    }
    return onboardSource({ description: input.description, url: input.url, orgId: "hospital-a", actor, ...(decision.executionContract ? { contract: decision.executionContract } : {}) }, deps);
  }

  close(): void {
    this.hmem.close();
    this.world.close();
  }
}
