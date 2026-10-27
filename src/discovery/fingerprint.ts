/**
 * Schema fingerprint of a probed table: a stable hash of the field paths and the type of each, independent of
 * column order, record order, key order and of which values happened to be in the sample.
 *
 * Types are read from the text, not from the container format, so a CSV and a JSON export of the same data share
 * a fingerprint, and a date that changes from 2020-08-13 to 13/08/2020 or a fraction that becomes "95%" changes it.
 * Missing-value codes are ignored when typing a column. A column with no values at all is typed "empty".
 *
 * Integers and non-integers are one type ("number"): a column of whole numbers in one sample and with a decimal in
 * the next has not changed shape.
 */
import { diffShapes, type ShapeDiff } from "../sources/contract.ts";
import { hashOf } from "../util/canonical.ts";
import type { ProbeTable } from "./tabular.ts";
import { isNullToken, parseNumber, readDate, type Cell } from "./values.ts";

export type Shape = Record<string, string>;

function typeOf(cell: Cell): string {
  if (typeof cell === "boolean") return "boolean";
  if (typeof cell === "number") return "number";
  const s = cell as string;
  if (/^(true|false)$/i.test(s.trim())) return "boolean";
  // Whole-token numbers only: "95%" and "1,5" are text in this fingerprint because a consumer cannot cast them.
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s.trim())) return "number";
  const d = readDate(s, false);
  if (d.families.length > 0 && !/^\d{8,13}$/.test(s.trim())) {
    // The writing of the date is part of the shape: 2020-08-03 and 03/08/2020 are different columns to a consumer.
    if (d.families.includes("iso")) return "date";
    if (d.families.includes("dmy") || d.families.includes("mdy")) return "date-slash";
    return `date-${d.families[0]}`;
  }
  return "string";
}

export function shapeOfTable(table: ProbeTable): Shape {
  const shape: Shape = {};
  for (const column of table.columns) {
    const types = new Set<string>();
    for (const row of table.rows) {
      const cell = row[column] ?? null;
      if (isNullToken(cell)) continue;
      types.add(typeOf(cell));
    }
    shape[column] = types.size === 0 ? "empty" : [...types].sort().join("|");
  }
  return shape;
}

export const schemaHashOf = (shape: Shape): string => hashOf({ fields: shape });

export interface Fingerprint {
  schemaHash: string;
  shape: Shape;
}

export function fingerprintOf(table: ProbeTable): Fingerprint {
  const shape = shapeOfTable(table);
  return { schemaHash: schemaHashOf(shape), shape };
}

/** A column that was empty in either sample says nothing about its type, so it is not counted as a retype. */
export function diffFingerprints(stored: Shape, current: Shape): ShapeDiff {
  const d = diffShapes(stored, current);
  return { ...d, retyped: d.retyped.filter((r) => r.from !== "empty" && r.to !== "empty") };
}

export const isDrift = (d: ShapeDiff): boolean => d.removed.length > 0 || d.retyped.length > 0 || d.added.length > 0;

/** One line for a reviewer. */
export function describeDiff(d: ShapeDiff): string {
  const parts: string[] = [];
  if (d.removed.length > 0) parts.push(`removed: ${d.removed.slice(0, 6).join(", ")}${d.removed.length > 6 ? ` and ${d.removed.length - 6} more` : ""}`);
  if (d.added.length > 0) parts.push(`added: ${d.added.slice(0, 6).join(", ")}${d.added.length > 6 ? ` and ${d.added.length - 6} more` : ""}`);
  if (d.retyped.length > 0) parts.push(`retyped: ${d.retyped.slice(0, 6).map((r) => `${r.path} ${r.from} to ${r.to}`).join("; ")}`);
  return parts.join("; ") || "no change";
}
