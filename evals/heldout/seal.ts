/**
 * Seals the held-out key: records the hashes of claims.jsonl and key.json in seal.json. Run once, after build.ts, and
 * before any system is run on the held-out claims. Refuses to overwrite an existing seal.
 *
 *   npx tsx evals/heldout/seal.ts
 */
import { exists } from "../lib/core.ts";
import { SEAL_PATH, writeSeal } from "../lib/seal.ts";

if (exists(SEAL_PATH)) {
  console.error("seal.json already exists; a sealed key is never re-sealed. Record any change as a dated erratum in evals/ERRATA.md instead.");
  process.exit(1);
}
const seal = writeSeal();
console.log(JSON.stringify(seal, null, 2));
