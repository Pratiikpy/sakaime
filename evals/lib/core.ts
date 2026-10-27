/** Small shared helpers for the evaluation suites: hashing, stable JSON, file access, text normalisation. */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dirname, "..", "..");
export const EVALS = join(ROOT, "evals");
export const RESULTS_DIR = join(EVALS, "results");
export const FIXTURES = join(ROOT, "research", "feasibility", "fixtures");

export function sha256(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

/** JSON with object keys sorted, so a hash does not depend on key order. */
export function stableJson(value: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.entries(v as Record<string, unknown>)
          .filter(([, x]) => x !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, x]) => [k, walk(x)]),
      );
    }
    return v;
  };
  return JSON.stringify(walk(value));
}

export const hashOfJson = (value: unknown): string => sha256(stableJson(value));

export function readText(path: string): string {
  return readFileSync(path, "utf8");
}

export function readJson<T = unknown>(path: string): T {
  return JSON.parse(readText(path)) as T;
}

export function writeText(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

export function writeJson(path: string, value: unknown): void {
  writeText(path, JSON.stringify(value, null, 2) + "\n");
}

export function exists(path: string): boolean {
  return existsSync(path);
}

/** Whitespace-collapsed text, the form in which a quote is compared with its source. */
export function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function quoteInText(quote: string, text: string): boolean {
  return squash(text).includes(squash(quote));
}

export function round(x: number, digits = 4): number {
  if (!Number.isFinite(x)) return x;
  const f = 10 ** digits;
  return Math.round(x * f) / f;
}

export function pct(x: number): string {
  return Number.isFinite(x) ? `${(x * 100).toFixed(1)}%` : "n/a";
}

/** A dated, hashed record of one run, written beside the results rows. */
export interface RunStamp {
  suite: string;
  startedAt: string;
  node: string;
  seed: number;
}

export function stamp(suite: string, seed: number): RunStamp {
  return { suite, startedAt: new Date().toISOString(), node: process.version, seed };
}
