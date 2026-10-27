import { z } from "zod";
import { PortError } from "../ports/index.ts";
import { MAX_PROMPT_BYTES, type LaneLocation } from "./types.ts";

/*
 * The role map (decision D-025, docs/04-meterless-plan.md s3.5).
 *
 * Model identifiers below were read from a live `GET /models` against the hackathon key and a live Nightshift on
 * 2026-10-27, and each was sent a one-line prompt that same day (see tests/models/live.test.ts for the re-check).
 * Nothing here is guessed: an id that did not answer is not in the map.
 */

export const NEMOTRON_LIGHTNING = "nvidia/nemotron-3.5-lightning-30b-a3b";
export const NEMOTRON_ULTRA = "nvidia/nemotron-3-ultra-550b-a55b";
export const NEMOTRON_SUPER_VL = "nvidia/nemotron-3.5-super-vl-120b-a12b";
/** Listed by Nightshift under `local-runtime/`. Listed is not runnable: whether this machine can serve it is NOT VERIFIED. */
export const LOCAL_LIGHTNING = "local-runtime/nemotron-3.5-lightning-30b-a3b";

export interface ModelProfile {
  id: string;
  label: string;
  location: LaneLocation;
  /** The tier Nightshift's signed receipt named for this model on 2026-10-27. Absent where it was not observed. */
  receiptTier?: string;
  /** Prompts above this are not sent to the model. Super VL fails in waves on large prompts (D-025), so it is capped lower. */
  maxPromptBytes: number;
  /** True when the model may only appear in a role that also names a fallback. */
  requiresFallback: boolean;
  evidence: string;
}

export const MODEL_PROFILES: readonly ModelProfile[] = [
  {
    id: NEMOTRON_LIGHTNING,
    label: "Nemotron 3.5 Lightning 30B A3B",
    location: "remote",
    receiptTier: "A",
    maxPromptBytes: MAX_PROMPT_BYTES,
    requiresFallback: false,
    evidence: "answered through NVIDIA and through Nightshift on 2026-10-27; the receipt named tier A",
  },
  {
    id: NEMOTRON_ULTRA,
    label: "Nemotron 3 Ultra 550B A55B",
    location: "remote",
    receiptTier: "C",
    maxPromptBytes: MAX_PROMPT_BYTES,
    requiresFallback: false,
    evidence: "answered through NVIDIA and through Nightshift on 2026-10-27 (29.8 s once, 0.6 s another time); the receipt named tier C",
  },
  {
    id: NEMOTRON_SUPER_VL,
    label: "Nemotron 3.5 Super VL 120B A12B",
    location: "remote",
    receiptTier: "C",
    maxPromptBytes: 24 * 1024,
    requiresFallback: true,
    evidence: "answered through NVIDIA and through Nightshift on 2026-10-27; reported by the sponsor to fail in waves and on large prompts, so capped at 24 KB and never used without a fallback",
  },
  {
    id: LOCAL_LIGHTNING,
    label: "Nemotron 3.5 Lightning 30B (local runtime)",
    location: "local",
    maxPromptBytes: 12 * 1024,
    requiresFallback: false,
    evidence: "listed by Nightshift's /v1/models on 2026-10-27; never called here, so whether it runs on this machine is NOT VERIFIED. The 12 KB cap is a conservative placeholder, not a measurement",
  },
];

export interface RoleSpec {
  role: string;
  model: string;
  fallbacks: string[];
  /** Model used when the call must stay on this machine. Absent means the role has no local lane. */
  localModel?: string;
  thinking: boolean;
  temperature: number;
  maxTokens: number;
  rationale: string;
}

const ModelIdSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{2,120}$/, "not a plausible model identifier");

const RoleOverrideSchema = z.union([
  ModelIdSchema,
  z
    .object({
      model: ModelIdSchema,
      fallbacks: z.array(ModelIdSchema).max(4).optional(),
      localModel: ModelIdSchema.optional(),
      thinking: z.boolean().optional(),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(16).max(16384).optional(),
    })
    .strict(),
]);
const OverridesSchema = z.record(RoleOverrideSchema);

export const DEFAULT_ROLE_SPECS: readonly RoleSpec[] = [
  { role: "planner", model: NEMOTRON_LIGHTNING, fallbacks: [NEMOTRON_ULTRA], localModel: LOCAL_LIGHTNING, thinking: false, temperature: 0, maxTokens: 2048, rationale: "high volume, short structured plans" },
  { role: "discoverer", model: NEMOTRON_LIGHTNING, fallbacks: [NEMOTRON_ULTRA], localModel: LOCAL_LIGHTNING, thinking: false, temperature: 0, maxTokens: 2048, rationale: "mapping proposals from a bounded sample; a deterministic validator follows" },
  { role: "extractor", model: NEMOTRON_LIGHTNING, fallbacks: [NEMOTRON_ULTRA], localModel: LOCAL_LIGHTNING, thinking: false, temperature: 0, maxTokens: 4096, rationale: "highest volume: one call per document chunk; quote-exists is checked in code" },
  { role: "support_checker", model: NEMOTRON_LIGHTNING, fallbacks: [NEMOTRON_ULTRA], localModel: LOCAL_LIGHTNING, thinking: false, temperature: 0, maxTokens: 1024, rationale: "semantic-support check in a separate context that sees only the passage and the assertion" },
  { role: "reporter", model: NEMOTRON_LIGHTNING, fallbacks: [NEMOTRON_ULTRA], localModel: LOCAL_LIGHTNING, thinking: false, temperature: 0, maxTokens: 2048, rationale: "prose from verified findings only; code rejects sentences without a finding id" },
  { role: "resolver", model: NEMOTRON_ULTRA, fallbacks: [NEMOTRON_LIGHTNING], localModel: LOCAL_LIGHTNING, thinking: false, temperature: 0, maxTokens: 2048, rationale: "identity adjudication inside the uncertain band; low volume, high consequence" },
  { role: "critic", model: NEMOTRON_ULTRA, fallbacks: [NEMOTRON_LIGHTNING], localModel: LOCAL_LIGHTNING, thinking: false, temperature: 0, maxTokens: 2048, rationale: "tries to break each draft finding; a stronger and different model than the one that drafted it" },
];

export interface ResolvedRole {
  spec: RoleSpec;
  candidates: string[];
}

export class RoleMap {
  private readonly byRole = new Map<string, RoleSpec>();
  private readonly profiles = new Map<string, ModelProfile>();

  constructor(
    specs: readonly RoleSpec[] = DEFAULT_ROLE_SPECS,
    profiles: readonly ModelProfile[] = MODEL_PROFILES,
  ) {
    for (const p of profiles) this.profiles.set(p.id, p);
    for (const s of specs) {
      if (this.byRole.has(s.role)) throw new PortError("INVALID", `role ${s.role} is declared twice`);
      this.byRole.set(s.role, { ...s, fallbacks: [...s.fallbacks] });
    }
    this.validate();
  }

  /** Reads `SAKAIME_ROLE_MODELS`: a JSON object of role to model id, or role to `{ model, fallbacks, ... }`. */
  static fromEnv(env: Record<string, string | undefined>): RoleMap {
    const raw = env["SAKAIME_ROLE_MODELS"];
    if (!raw || !raw.trim()) return new RoleMap();
    return new RoleMap().withOverrides(raw);
  }

  withOverrides(json: string | Record<string, unknown>): RoleMap {
    let parsed: unknown;
    try {
      parsed = typeof json === "string" ? JSON.parse(json) : json;
    } catch {
      throw new PortError("INVALID", "SAKAIME_ROLE_MODELS is not valid JSON");
    }
    const result = OverridesSchema.safeParse(parsed);
    if (!result.success) {
      throw new PortError("INVALID", `SAKAIME_ROLE_MODELS is not a map of role to model: ${result.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
    }
    const specs = new Map(this.byRole);
    for (const [role, override] of Object.entries(result.data)) {
      const current = specs.get(role);
      if (!current) throw new PortError("INVALID", `SAKAIME_ROLE_MODELS names an unknown role "${role}"; known roles: ${[...specs.keys()].join(", ")}`);
      const o = typeof override === "string" ? { model: override } : override;
      const next: RoleSpec = { ...current, model: o.model };
      // Changing the primary model resets the fallbacks to the ones the caller named; inheriting a fallback chosen for a different primary would be a guess.
      next.fallbacks = o.fallbacks ?? (o.model === current.model ? current.fallbacks : []);
      if (o.localModel !== undefined) next.localModel = o.localModel;
      if (o.thinking !== undefined) next.thinking = o.thinking;
      if (o.temperature !== undefined) next.temperature = o.temperature;
      if (o.maxTokens !== undefined) next.maxTokens = o.maxTokens;
      specs.set(role, next);
    }
    return new RoleMap([...specs.values()], [...this.profiles.values()]);
  }

  roles(): string[] {
    return [...this.byRole.keys()];
  }

  profile(model: string): ModelProfile | undefined {
    return this.profiles.get(model);
  }

  spec(role: string): RoleSpec {
    const spec = this.byRole.get(role);
    if (!spec) throw new PortError("INVALID", `unknown role "${role}"; known roles: ${this.roles().join(", ")}. A role is never mapped to a model by guesswork.`);
    return spec;
  }

  /**
   * The models to try for a call, best first. Remote: the role's model then its fallbacks, skipping any whose size cap the
   * prompt exceeds. Local: only the role's local model. Availability and health filtering is applied by the caller.
   */
  candidates(role: string, promptBytes: number, lane: LaneLocation): string[] {
    const spec = this.spec(role);
    if (lane === "local") {
      if (!spec.localModel) throw new PortError("UNAVAILABLE", `role ${role} has no local model, so it cannot run in the local lane`);
      const cap = this.profile(spec.localModel)?.maxPromptBytes ?? MAX_PROMPT_BYTES;
      if (promptBytes > cap) {
        throw new PortError("INVALID", `the prompt is ${promptBytes} bytes; the local model ${spec.localModel} is capped at ${cap}. Chunk the input.`, { promptBytes, cap });
      }
      return [spec.localModel];
    }
    const chain = [spec.model, ...spec.fallbacks].filter((m, i, all) => all.indexOf(m) === i);
    const fitting = chain.filter((m) => promptBytes <= (this.profile(m)?.maxPromptBytes ?? MAX_PROMPT_BYTES));
    if (fitting.length === 0) {
      throw new PortError("INVALID", `the prompt is ${promptBytes} bytes, above the cap of every model for role ${role}. Chunk the input.`, { promptBytes });
    }
    return fitting;
  }

  private validate(): void {
    for (const spec of this.byRole.values()) {
      const chain = [spec.model, ...spec.fallbacks];
      chain.forEach((model, index) => {
        const profile = this.profiles.get(model);
        if (profile?.location === "local") {
          throw new PortError("INVALID", `role ${spec.role} lists the local model ${model} in its remote chain; local models belong in localModel`);
        }
        if (profile?.requiresFallback) {
          // The fallback must come after it and must not share its failure mode.
          const safeAfter = chain.slice(index + 1).some((m) => !this.profiles.get(m)?.requiresFallback);
          if (!safeAfter) {
            throw new PortError("INVALID", `role ${spec.role} uses ${model}, which may only be used when a fallback that does not share its failure mode follows it`);
          }
        }
      });
      if (spec.localModel && this.profiles.get(spec.localModel)?.location === "remote") {
        throw new PortError("INVALID", `role ${spec.role} names the remote model ${spec.localModel} as its local model`);
      }
    }
  }
}
