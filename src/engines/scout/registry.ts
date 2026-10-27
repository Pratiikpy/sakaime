import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { hashOf } from "../../util/canonical.ts";
import type { Intent, RegistryFile } from "./types.ts";

export class RegistryError extends Error {
  constructor(message: string) {
    super(`Scout registry: ${message}`);
    this.name = "RegistryError";
  }
}

const TriggerSchema = z.object({ phrase: z.string().min(1), weight: z.number().finite().min(-3).max(3) });

const IntentSchema = z
  .object({
    id: z.string().min(1),
    category: z.string().min(1),
    description: z.string().min(1),
    parameters: z
      .object({ required: z.array(z.string()).optional(), requiredAnyOf: z.array(z.array(z.string()).min(1)).optional(), properties: z.record(z.string(), z.unknown()).optional() })
      .passthrough()
      .default({}),
    capabilities: z.array(z.string().min(1)).default([]),
    riskClass: z.enum(["low", "medium", "high"]),
    surfaces: z.array(z.string().min(1)).min(1),
    roles: z.array(z.string().min(1)).min(1),
    examples: z.array(z.string().min(1)).min(1, "an intent without examples cannot be classified or evaluated"),
    version: z.number().int().positive(),
    triggers: z.array(TriggerSchema).optional(),
    guarded: z.enum(["block", "clarify"]).optional(),
    singleUse: z.boolean().optional(),
    requiresAssignment: z.boolean().optional(),
    alternatives: z.array(z.string()).optional(),
    modelRole: z.string().optional(),
  })
  .passthrough();

const RegistrySchema = z.object({ version: z.number().int().positive(), note: z.string().optional(), graph: z.string().optional(), intents: z.array(IntentSchema).min(1) }).passthrough();

/** The closed set of intents. If an intent is not here it cannot be acted on. */
export class IntentRegistry {
  readonly version: number;
  /** Hash of the canonical registry, stamped on contracts so an executor can tell the registry changed under it. */
  readonly hash: string;
  readonly intents: ReadonlyArray<Intent>;
  readonly graphPath?: string;
  private readonly byId: Map<string, Intent>;

  constructor(file: RegistryFile, graphPath?: string) {
    const ids = new Set<string>();
    for (const i of file.intents) {
      if (ids.has(i.id)) throw new RegistryError(`duplicate intent id ${JSON.stringify(i.id)}`);
      ids.add(i.id);
    }
    if (!ids.has("GENERAL")) throw new RegistryError("the registry needs a GENERAL intent: the fallback below the reject band");
    for (const i of file.intents) {
      for (const a of i.alternatives ?? []) if (!ids.has(a)) throw new RegistryError(`${i.id} offers alternative ${JSON.stringify(a)}, which is not in the registry`);
      for (const t of i.triggers ?? []) {
        try {
          new RegExp(t.phrase);
        } catch {
          throw new RegistryError(`${i.id} has a trigger that is not a valid pattern: ${JSON.stringify(t.phrase)}`);
        }
      }
    }
    this.version = file.version;
    this.intents = file.intents;
    this.graphPath = graphPath;
    this.byId = new Map(file.intents.map((i) => [i.id, i]));
    this.hash = hashOf({ version: file.version, intents: file.intents });
  }

  get(id: string): Intent | undefined {
    return this.byId.get(id);
  }

  has(id: string): boolean {
    return this.byId.has(id);
  }

  get ids(): string[] {
    return [...this.byId.keys()];
  }

  /** Every capability name some intent declares, plus the intent ids: the tools a request may legitimately name. */
  get knownTools(): Set<string> {
    const s = new Set<string>(this.ids);
    for (const i of this.intents) for (const c of i.capabilities) s.add(c);
    return s;
  }

  static load(source: string | RegistryFile | IntentRegistry): IntentRegistry {
    if (source instanceof IntentRegistry) return source;
    if (typeof source !== "string") return IntentRegistry.fromObject(source);
    let text: string;
    try {
      text = readFileSync(source, "utf8");
    } catch (err) {
      throw new RegistryError(`cannot read ${source}: ${(err as Error).message}`);
    }
    let obj: unknown;
    try {
      obj = JSON.parse(text);
    } catch (err) {
      throw new RegistryError(`${source} is not JSON: ${(err as Error).message}`);
    }
    const graph = typeof (obj as { graph?: unknown })?.graph === "string" ? (obj as { graph: string }).graph : undefined;
    return IntentRegistry.fromObject(obj, graph ? (isAbsolute(graph) ? graph : resolve(dirname(source), graph)) : undefined);
  }

  private static fromObject(obj: unknown, graphPath?: string): IntentRegistry {
    const parsed = RegistrySchema.safeParse(obj);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      throw new RegistryError(`${first?.path.join(".") || "registry"}: ${first?.message}`);
    }
    return new IntentRegistry(parsed.data as unknown as RegistryFile, graphPath);
  }
}
