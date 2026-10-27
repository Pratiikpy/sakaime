/** Case loaders. An arm is handed `ArmInput` (no key); the key is read only by the graders. */
import { join } from "node:path";
import { EVALS, readJson, readText } from "./core.ts";
import { verifySeal } from "./seal.ts";
import { ClaimSchema } from "../../src/schemas/index.ts";
import type { CaseKey, EvalCase, KeyMismatch } from "./types.ts";
import type { Dimension } from "../../src/schemas/index.ts";

export type ArmInput = Omit<EvalCase, "key">;

export function stripKey(c: EvalCase): ArmInput {
  const { key: _key, ...rest } = c;
  return rest;
}

interface Gate0Line {
  id: string;
  device: string;
  kind: string;
  text: string;
  claim: unknown;
  evidenceSetIds: string[];
  key: { expectedLabel: EvalCase["key"]["expectedLabel"]; acceptableLabels: EvalCase["key"]["acceptableLabels"]; keyConfidence: "clear" | "contestable"; mismatchDimensions: string[]; note?: string };
}

/** The Gate 0 claim families: claim ids share a two-letter prefix per device family (EA covers K200667 and K223357). */
export const FAMILY_OF_PREFIX: Record<string, string> = {
  EA: "eyeart", TR: "transpara", LU: "lunit", VZ: "viz", BC: "briefcase", MS: "mammoscreen", PG: "paige", GI: "gigenius", HF: "heartflow", AN: "anumana", ID: "idxdr", CP: "caption",
};

export function loadDevCases(): { cases: EvalCase[]; handSetIds: Map<string, string[]> } {
  const lines = readText(join(EVALS, "gate0", "claims.jsonl")).trim().split("\n").map((l) => JSON.parse(l) as Gate0Line);
  const handSetIds = new Map<string, string[]>();
  const cases = lines.map((l): EvalCase => {
    const claim = ClaimSchema.parse(l.claim);
    handSetIds.set(l.id, l.evidenceSetIds);
    const mismatches: KeyMismatch[] = l.key.mismatchDimensions.map((d) => ({ dimension: d as Dimension, claimed: "", established: "" }));
    return {
      id: l.id,
      cluster: FAMILY_OF_PREFIX[l.id.split("-")[0] as string] ?? l.id.split("-")[0]!,
      product: claim.use.product as string,
      kind: l.kind === "positive control" ? "positive control" : "mismatch",
      partition: "development",
      text: l.text,
      claim,
      key: { expectedLabel: l.key.expectedLabel, acceptableLabels: l.key.acceptableLabels, keyConfidence: l.key.keyConfidence, mismatches, ...(l.key.note ? { note: l.key.note } : {}) } satisfies CaseKey,
    };
  });
  return { cases, handSetIds };
}

export function loadHeldoutCases(): { cases: EvalCase[]; keyHash: string } {
  const seal = verifySeal();
  const inputs = readText(join(EVALS, "heldout", "claims.jsonl")).trim().split("\n").map((l) => JSON.parse(l) as Omit<EvalCase, "key"> & { constructed?: boolean; notice?: string });
  const keys = readJson<{ keys: Record<string, { key: CaseKey }> }>(join(EVALS, "heldout", "key.json")).keys;
  const cases = inputs.map((i): EvalCase => {
    const k = keys[i.id];
    if (!k) throw new Error(`no key for held-out case ${i.id}`);
    const { constructed: _c, notice: _n, ...rest } = i;
    return { ...rest, claim: ClaimSchema.parse(i.claim), key: k.key };
  });
  return { cases, keyHash: seal.files["key.json"] as string };
}
