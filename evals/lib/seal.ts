/**
 * The seal on the held-out key (docs/06 section 2: held-out labels are written and sealed first; the hash is committed).
 *
 * evals/heldout/seal.json records the sha256 of the case inputs and of the key. Every run of a held-out suite calls
 * verifySeal() first and refuses to run if either file differs, and every result row carries the key hash it was scored against.
 * Changing the key after seeing system output therefore cannot be done without breaking the seal, and the break is visible.
 */
import { join } from "node:path";
import { EVALS, exists, readJson, readText, sha256, writeJson } from "./core.ts";

export const SEALED_FILES = ["claims.jsonl", "key.json"] as const;

export interface Seal {
  sealedAt: string;
  files: Record<string, string>;
  note: string;
}

export const SEAL_PATH = join(EVALS, "heldout", "seal.json");

export function currentHashes(dir = join(EVALS, "heldout")): Record<string, string> {
  return Object.fromEntries(SEALED_FILES.map((f) => [f, sha256(readText(join(dir, f)))]));
}

export class SealBrokenError extends Error {
  constructor(readonly differences: string[]) {
    super(`held-out seal broken: ${differences.join("; ")}`);
    this.name = "SealBrokenError";
  }
}

export function verifySeal(dir = join(EVALS, "heldout")): Seal {
  const sealPath = join(dir, "seal.json");
  if (!exists(sealPath)) throw new SealBrokenError(["no seal.json: the key has not been sealed"]);
  const seal = readJson<Seal>(sealPath);
  const now = currentHashes(dir);
  const diffs = SEALED_FILES.filter((f) => seal.files[f] !== now[f]).map((f) => `${f} is ${now[f]?.slice(0, 12)}, sealed as ${seal.files[f]?.slice(0, 12)}`);
  if (diffs.length > 0) throw new SealBrokenError(diffs);
  return seal;
}

export function writeSeal(dir = join(EVALS, "heldout")): Seal {
  const seal: Seal = {
    sealedAt: new Date().toISOString(),
    files: currentHashes(dir),
    note: "Hashes of the held-out case inputs and key. See evals/SEALED.md for what was and was not done before sealing.",
  };
  writeJson(join(dir, "seal.json"), seal);
  return seal;
}
