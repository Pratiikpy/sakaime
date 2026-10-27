/**
 * Route: turn an intent's abstract capabilities into concrete tools.
 *
 * Selection, in priority order: drop tools the user's role may not use; drop tools that are not available in
 * this mode or right now; choose the cheapest, then the fastest; on a tie prefer a local tool. A capability
 * with no usable tool fails routing. It is never replaced by a tool outside the intent's scope.
 *
 * With no graph supplied (a foreign registry that brings only capability names), each capability is its own
 * tool id, and the plan says so.
 */
import { readFileSync } from "node:fs";
import type { ToolStep } from "./types.ts";

export interface GraphEdge {
  tool: string;
  local: boolean;
  latencyMs: number;
  cost: number;
  available: boolean;
  roles: string[];
  /** Limit the tool to live or sample (cassette) runs. Absent means both. */
  modes?: ("live" | "sample")[];
}

export interface GraphFile {
  version: number;
  capabilities: Record<string, GraphEdge[]>;
}

export type RunMode = "live" | "sample";

export class CapabilityGraph {
  private readonly down = new Set<string>();

  constructor(
    private readonly file: GraphFile | undefined,
    private readonly mode: RunMode = "live",
  ) {}

  static load(path: string | undefined, mode: RunMode = "live"): CapabilityGraph {
    if (!path) return new CapabilityGraph(undefined, mode);
    return new CapabilityGraph(JSON.parse(readFileSync(path, "utf8")) as GraphFile, mode);
  }

  get isIdentity(): boolean {
    return this.file === undefined;
  }

  /** Mark a tool unavailable (or available again), for example after a health check fails. */
  setAvailable(tool: string, available: boolean): void {
    if (available) this.down.delete(tool);
    else this.down.add(tool);
  }

  resolve(capability: string, ctx: { role: string }): string | undefined {
    if (!this.file) return capability;
    const edges = this.file.capabilities[capability] ?? [];
    const usable = edges
      .filter((e) => e.roles.includes("*") || e.roles.includes(ctx.role))
      .filter((e) => e.available && !this.down.has(e.tool) && (!e.modes || e.modes.includes(this.mode)))
      .sort((a, b) => a.cost - b.cost || a.latencyMs - b.latencyMs || Number(b.local) - Number(a.local));
    return usable[0]?.tool;
  }

  plan(capabilities: readonly string[], ctx: { role: string }, input: Record<string, unknown>): { steps: ToolStep[]; failed: string[] } {
    const steps: ToolStep[] = [];
    const failed: string[] = [];
    for (const capability of capabilities) {
      const tool = this.resolve(capability, ctx);
      if (tool === undefined) failed.push(capability);
      else steps.push({ capability, tool, input });
    }
    return { steps, failed };
  }
}
