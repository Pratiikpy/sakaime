/**
 * Reference-population statistics for the scorer. The FDA AI list is the population: 40% of its rows share a
 * normalised device name with another row, so a name match alone cannot identify one product. This counts how
 * many rows carry each normalised name; names carried by FAMILY_NAME_MIN_ROWS or more rows are kept.
 */
import { FAMILY_NAME_MIN_ROWS } from "./compare.ts";
import { normaliseName, splitDeviceCell } from "./normalize.ts";
import type { ScorerModel } from "./scorer.ts";

/** `deviceCells` is the Device column of the list, one entry per row. A row packing several devices counts each distinct name once. */
export function buildReference(deviceCells: readonly string[]): ScorerModel["reference"] {
  const counts = new Map<string, number>();
  for (const cell of deviceCells) {
    const keys = new Set(splitDeviceCell(cell).map((d) => normaliseName(d).key).filter((k) => k !== ""));
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const familyNames: Record<string, number> = {};
  for (const [key, n] of [...counts].sort(([a], [b]) => (a < b ? -1 : 1))) if (n >= FAMILY_NAME_MIN_ROWS) familyNames[key] = n;
  return { totalRows: deviceCells.length, familyNames };
}
