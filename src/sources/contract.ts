/**
 * Response contracts and schema fingerprints.
 *
 * A source card declares the paths a connector depends on and their JSON types. A response that lacks a
 * required path, or carries one with another type, has drifted: the connector stops and says DRIFTED instead of
 * mapping the wrong field into evidence. Fields the card does not mention may appear, disappear or change
 * freely; they are not part of the contract, so an optional field missing from one record does not raise a
 * false alarm.
 *
 * Path syntax: dot-separated keys; a trailing `[]` on a key means "that key holds an array, check each element".
 * `results[].k_number` reads: `results` is an array, and every element has a string `k_number`.
 */
import { z } from "zod";
import { hashOf } from "../util/canonical.ts";

export const JSON_TYPES = ["string", "number", "boolean", "object", "array", "null", "any"] as const;
export type JsonType = (typeof JSON_TYPES)[number];

export const ContractPathSchema = z.object({
  path: z.string().min(1),
  type: z.enum(JSON_TYPES),
  /** An optional path may be absent; when present it must still have the stated type. */
  optional: z.boolean().default(false),
});
export type ContractPath = z.infer<typeof ContractPathSchema>;

export function jsonTypeOf(value: unknown): Exclude<JsonType, "any"> {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "object";
  }
}

interface Reached {
  present: boolean;
  value?: unknown;
  /** Set when a parent on the way was not the expected container. */
  blockedAt?: string;
}

function reach(node: unknown, segments: string[], trail: string): Reached[] {
  if (segments.length === 0) return [{ present: true, value: node }];
  const [head, ...rest] = segments as [string, ...string[]];
  const isArray = head.endsWith("[]");
  const key = isArray ? head.slice(0, -2) : head;
  if (node === null || typeof node !== "object" || Array.isArray(node)) {
    return [{ present: false, blockedAt: trail || "$" }];
  }
  const record = node as Record<string, unknown>;
  if (!(key in record)) return [{ present: false }];
  const child = record[key];
  const here = trail ? `${trail}.${key}` : key;
  if (!isArray) return reach(child, rest, here);
  if (!Array.isArray(child)) return [{ present: false, blockedAt: here }];
  if (rest.length === 0) return [{ present: true, value: child }];
  return child.flatMap((item) => reach(item, rest, `${here}[]`));
}

export interface ContractViolation {
  path: string;
  problem: "missing" | "wrong-type" | "not-a-container";
  expected: JsonType;
  observed?: string;
}

export interface ContractCheck {
  ok: boolean;
  violations: ContractViolation[];
  /** Hash of the required paths with the types actually observed. Stable while the response satisfies the contract. */
  fingerprint: string;
}

export function checkContract(json: unknown, contract: ContractPath[]): ContractCheck {
  const violations: ContractViolation[] = [];
  const observed: Array<[string, string]> = [];
  for (const rule of contract) {
    // A trailing [] on the last segment means the value itself must be an array; strip it for traversal.
    const segments = rule.path.split(".");
    const results = reach(json, segments, "");
    const seen = new Set<string>();
    let missing = false;
    for (const hit of results) {
      if (!hit.present) {
        if (hit.blockedAt !== undefined) {
          violations.push({ path: rule.path, problem: "not-a-container", expected: rule.type, observed: `parent ${hit.blockedAt} is not the expected container` });
        } else {
          missing = true;
        }
        continue;
      }
      const type = jsonTypeOf(hit.value);
      seen.add(type);
      if (rule.type !== "any" && type !== rule.type) {
        violations.push({ path: rule.path, problem: "wrong-type", expected: rule.type, observed: type });
      }
    }
    if (missing && !rule.optional) violations.push({ path: rule.path, problem: "missing", expected: rule.type });
    if (!rule.optional) observed.push([rule.path, [...seen].sort().join("|") || "absent"]);
  }
  // De-duplicate repeated violations from many array elements: one line per path and problem.
  const unique = new Map<string, ContractViolation>();
  for (const v of violations) unique.set(`${v.path}|${v.problem}|${v.observed ?? ""}`, v);
  const list = [...unique.values()];
  return { ok: list.length === 0, violations: list, fingerprint: hashOf(observed.sort(([a], [b]) => (a < b ? -1 : 1))) };
}

export const describeViolations = (violations: ContractViolation[]): string =>
  violations
    .slice(0, 6)
    .map((v) => (v.problem === "missing" ? `${v.path} is missing` : v.problem === "wrong-type" ? `${v.path} is ${v.observed}, expected ${v.expected}` : `${v.path}: ${v.observed}`))
    .join("; ") + (violations.length > 6 ? `; and ${violations.length - 6} more` : "");

// ---------------------------------------------------------------- generic shape fingerprint (for unknown sources)

/**
 * Every path in a JSON document with the set of types seen there (arrays are merged element-wise). Used when no
 * card exists yet, for example to onboard a source nobody wrote an adapter for; known sources use contracts.
 */
export function shapeOf(json: unknown): Record<string, string> {
  const types = new Map<string, Set<string>>();
  const visit = (node: unknown, path: string): void => {
    const type = jsonTypeOf(node);
    if (!types.has(path)) types.set(path, new Set());
    types.get(path)!.add(type);
    if (type === "array") for (const item of node as unknown[]) visit(item, `${path}[]`);
    else if (type === "object") for (const [k, v] of Object.entries(node as Record<string, unknown>)) visit(v, path ? `${path}.${k}` : k);
  };
  visit(json, "");
  const out: Record<string, string> = {};
  for (const [path, set] of [...types.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) out[path || "$"] = [...set].sort().join("|");
  return out;
}

export const shapeFingerprint = (json: unknown): string => hashOf(shapeOf(json));

export interface ShapeDiff {
  removed: string[];
  retyped: Array<{ path: string; from: string; to: string }>;
  added: string[];
}

/** Compare two shapes. Removed and retyped paths are drift; added paths are reported but are not drift by themselves. */
export function diffShapes(stored: Record<string, string>, current: Record<string, string>): ShapeDiff {
  const removed = Object.keys(stored).filter((p) => !(p in current));
  const retyped = Object.keys(stored)
    .filter((p) => p in current && stored[p] !== current[p])
    .map((p) => ({ path: p, from: stored[p]!, to: current[p]! }));
  const added = Object.keys(current).filter((p) => !(p in stored));
  return { removed, retyped, added };
}
