import { validateMapping, type ValidationContext, type ValidationReport } from "../../../src/discovery/validate.ts";
import { DEFAULT_HOLDINGS } from "../../../src/discovery/holdings.ts";
import type { Proposal } from "../../../src/discovery/lexical.ts";
import { parseProbe } from "../../../src/discovery/tabular.ts";
import { EngineDouble, ObjectStoreDouble } from "./doubles.ts";
import { HELD_TABLES, T0, csv } from "./fixtures.ts";

let engine: EngineDouble | undefined;
export async function sharedEngine(): Promise<EngineDouble> {
  engine ??= await EngineDouble.create(new ObjectStoreDouble(), HELD_TABLES);
  return engine;
}
export function closeSharedEngine(): void {
  engine?.close();
  engine = undefined;
}

export const proposal = (sourceField: string, canonicalField: string, proposer: Proposal["proposer"] = "model"): Proposal => ({ sourceField, canonicalField, confidence: 0.9, proposer });

/** Validate a single-purpose table. `cols` maps each header to its cells. */
export async function check(
  cols: Record<string, (string | number | null)[]>,
  maps: Record<string, string>,
  over: Partial<ValidationContext> & { proposer?: Proposal["proposer"] } = {},
): Promise<ValidationReport> {
  const names = Object.keys(cols);
  const n = Math.max(...names.map((k) => cols[k]!.length));
  const rows = Array.from({ length: n }, (_, i) => names.map((k) => cols[k]![i] ?? null));
  const table = parseProbe(new TextEncoder().encode(csv(names, rows)));
  const { proposer, ...ctx } = over;
  return validateMapping(
    {
      table,
      description: "",
      now: new Date(T0),
      federation: await sharedEngine(),
      holdings: DEFAULT_HOLDINGS,
      joinSample: 200,
      ...ctx,
    },
    Object.entries(maps).map(([s, c]) => proposal(s, c, proposer)),
  );
}

export const verdictOf = (r: ValidationReport, sourceField: string) => r.fields.find((f) => f.sourceField === sourceField)!;
