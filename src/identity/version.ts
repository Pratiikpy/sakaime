/**
 * Version-string parsing and comparison.
 *
 * Software releases in the sources are written as semantic-style numbers (1.7.2), vendor labels (V2, "FFRct
 * version 3"), product generations ("(3)"), algorithm identifiers (1010), build hashes and pre-release words
 * (Alpha). They are not on one scale, so the comparison answers only what can be known and returns UNKNOWN
 * for everything else. It never guesses that two labels from different schemes mean the same release.
 */
import { foldText } from "./normalize.ts";

export type ParsedVersion =
  | { kind: "none"; raw: string }
  | { kind: "semver"; raw: string; parts: (number | "*")[]; revision?: string; qualifier?: string }
  | { kind: "generation"; raw: string; n: number }
  | { kind: "algorithm-id"; raw: string; id: string }
  | { kind: "build"; raw: string; hash: string }
  | { kind: "prerelease"; raw: string; label: string }
  | { kind: "label"; raw: string; label: string };

export const VERSION_RELATIONS = ["EXACT", "SAME_RELEASE_LINE", "DIFFERENT", "UNKNOWN"] as const;
export type VersionRelation = (typeof VERSION_RELATIONS)[number];

export interface VersionComparison {
  relation: VersionRelation;
  reason: string;
  a: ParsedVersion;
  b: ParsedVersion;
  /** Set when the difference is a research or pre-release build against a locked release. */
  buildDiffers: boolean;
}

const PRERELEASE = /^(alpha|beta|rc\d*|research|prototype|investigational|preview|pre-?release)$/;
const SEMVER = /^v?\.?\s*(\d+(?:\.(?:\d+|[xyz*]))*)(?:\s+(rev\w+))?$/;
const SEMVER_WILDCARD_ONLY = /^v?\.?\s*(\d+)\.([xyz*])(?:\.[xyz*])*$/;

export function parseVersion(raw: string | undefined | null): ParsedVersion {
  const text = typeof raw === "string" ? raw : "";
  const folded = foldText(text).trim();
  if (folded === "") return { kind: "none", raw: text };

  const generation = /^\(\s*(\d{1,2})\s*\)$/.exec(folded);
  if (generation) return { kind: "generation", raw: text, n: Number(generation[1]) };

  const algorithm = /^(?:alg:)?(\d{4})$/.exec(folded);
  if (algorithm) return { kind: "algorithm-id", raw: text, id: algorithm[1]! };

  if (PRERELEASE.test(folded)) return { kind: "prerelease", raw: text, label: folded };

  // "ffrct version 3": a qualifier word before the number names a sub-product, so it travels with the number.
  const qualified = /^([a-z][a-z0-9-]*)\s+version\s+(\d+(?:\.\d+)*)$/.exec(folded);
  if (qualified) {
    const parts = qualified[2]!.split(".").map(Number);
    return { kind: "semver", raw: text, parts, qualifier: qualified[1]! };
  }

  const sem = SEMVER.exec(folded);
  if (sem) {
    const parts = sem[1]!.split(".").map((p): number | "*" => (/^\d+$/.test(p) ? Number(p) : "*"));
    return { kind: "semver", raw: text, parts, ...(sem[2] ? { revision: sem[2] } : {}) };
  }
  const wild = SEMVER_WILDCARD_ONLY.exec(folded);
  if (wild) return { kind: "semver", raw: text, parts: [Number(wild[1]), "*"] };

  const compact = folded.replace(/\s+/g, "");
  if (/^[0-9a-f]{7,64}$/.test(compact) && /\d/.test(compact) && /[a-f]/.test(compact)) {
    return { kind: "build", raw: text, hash: compact };
  }
  return { kind: "label", raw: text, label: folded };
}

function result(relation: VersionRelation, reason: string, a: ParsedVersion, b: ParsedVersion, buildDiffers = false): VersionComparison {
  return { relation, reason, a, b, buildDiffers };
}

/** Parts without trailing zeros, so 1.0 equals 1.0.0 and 1.1.0.0 equals 1.1. */
function trimmed(parts: (number | "*")[]): (number | "*")[] {
  const out = [...parts];
  while (out.length > 1 && out[out.length - 1] === 0) out.pop();
  return out;
}

export function compareVersions(left: string | undefined | null, right: string | undefined | null): VersionComparison {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (a.kind === "none" || b.kind === "none") return result("UNKNOWN", "a version is missing on one side", a, b);

  if (a.kind === "semver" && b.kind === "semver") return compareSemver(a, b);

  if (a.kind === "generation" && b.kind === "generation") {
    return a.n === b.n ? result("EXACT", "same product generation", a, b) : result("DIFFERENT", `generation ${a.n} versus ${b.n}`, a, b);
  }
  if (a.kind === "algorithm-id" && b.kind === "algorithm-id") {
    return a.id === b.id ? result("EXACT", "same algorithm identifier", a, b) : result("DIFFERENT", `algorithm ${a.id} versus ${b.id}`, a, b);
  }
  if (a.kind === "build" && b.kind === "build") {
    return a.hash === b.hash ? result("EXACT", "same build hash", a, b) : result("DIFFERENT", "different build hashes", a, b);
  }
  if (a.kind === "prerelease" && b.kind === "prerelease") {
    return a.label === b.label ? result("EXACT", "same pre-release label", a, b) : result("UNKNOWN", "different pre-release labels cannot be ordered", a, b);
  }
  if ((a.kind === "prerelease" && b.kind === "semver") || (a.kind === "semver" && b.kind === "prerelease")) {
    const semver = a.kind === "semver" ? a : b;
    if (semver.kind === "semver" && semver.parts.includes("*")) return result("UNKNOWN", "a pre-release build against a wildcard release label", a, b);
    return result("DIFFERENT", "a pre-release build is not the locked release", a, b, true);
  }
  if (a.kind === "label" && b.kind === "label") {
    return a.label === b.label ? result("EXACT", "same vendor label", a, b) : result("UNKNOWN", "two vendor labels with no shared scale", a, b);
  }
  return result("UNKNOWN", `${a.kind} and ${b.kind} are not on one scale`, a, b);
}

type Semver = Extract<ParsedVersion, { kind: "semver" }>;

function compareSemver(a: Semver, b: Semver): VersionComparison {
  if ((a.qualifier ?? "") !== (b.qualifier ?? "")) {
    return result("UNKNOWN", "labels carry different qualifiers", a, b);
  }
  const pa = trimmed(a.parts);
  const pb = trimmed(b.parts);
  const wildcard = pa.includes("*") || pb.includes("*");

  if (wildcard) {
    // Compare only the concrete prefix. A match there cannot prove equality, only compatibility.
    const limit = Math.min(firstWildcard(pa), firstWildcard(pb));
    for (let i = 0; i < limit; i++) {
      const x = pa[i] ?? 0;
      const y = pb[i] ?? 0;
      if (x !== y) return result("DIFFERENT", `concrete components differ at position ${i + 1}`, a, b);
    }
    return limit >= 2
      ? result("SAME_RELEASE_LINE", "equal major and minor with a wildcard component", a, b)
      : result("UNKNOWN", "a wildcard label is compatible but not equal", a, b);
  }

  const coarse = a.parts.length !== b.parts.length && (a.parts.length === 1 || b.parts.length === 1);
  if (!coarse && pa.length === pb.length && pa.every((v, i) => v === pb[i])) {
    if ((a.revision ?? "") !== (b.revision ?? "")) {
      return result("SAME_RELEASE_LINE", "same number, revision differs or is stated on one side only", a, b);
    }
    return result("EXACT", pa.length !== a.parts.length || pb.length !== b.parts.length ? "equal after trailing zeros" : "identical", a, b);
  }

  if (coarse) {
    // A coarse label such as "V2" against "2.3": compatible if the major matches, but it settles nothing.
    return a.parts[0] === b.parts[0]
      ? result("UNKNOWN", "one label is coarser than the other", a, b)
      : result("DIFFERENT", `major ${String(a.parts[0])} versus ${String(b.parts[0])}`, a, b);
  }
  const lineA = [a.parts[0] ?? 0, a.parts[1] ?? 0];
  const lineB = [b.parts[0] ?? 0, b.parts[1] ?? 0];
  if (lineA[0] === lineB[0] && lineA[1] === lineB[1]) {
    return result("SAME_RELEASE_LINE", "same major and minor, later components differ", a, b);
  }
  return result("DIFFERENT", `release line ${lineA.join(".")} versus ${lineB.join(".")}`, a, b);
}

function firstWildcard(parts: (number | "*")[]): number {
  const i = parts.indexOf("*");
  return i === -1 ? parts.length : i;
}

/** True when the label names a concrete release (no wildcard, not a bare pre-release word). */
export function isFullySpecified(version: string | undefined | null): boolean {
  const p = parseVersion(version);
  if (p.kind === "semver") return !p.parts.includes("*");
  return p.kind === "generation" || p.kind === "algorithm-id" || p.kind === "build";
}
