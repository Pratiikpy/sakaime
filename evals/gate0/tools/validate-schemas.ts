// Validates claims.jsonl and evidence-sets.json against the shared schemas (src/schemas/scope.ts).
// Run from the repository root: npx tsx evals/gate0/tools/validate-schemas.ts
import { readFileSync } from "node:fs";
import { ClaimSchema, EvidenceItemSchema, LabelSchema, DimensionSchema } from "../../../src/schemas/index.ts";

const claims = readFileSync("evals/gate0/claims.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const sets = JSON.parse(readFileSync("evals/gate0/evidence-sets.json", "utf8")).items;
let bad = 0;
for (const c of claims) {
  const r = ClaimSchema.safeParse(c.claim);
  if (!r.success) { bad++; console.log("claim", c.id, r.error.issues[0]); }
  const k = LabelSchema.safeParse(c.key.expectedLabel);
  if (!k.success) { bad++; console.log("label", c.id); }
  for (const a of c.key.acceptableLabels) if (!LabelSchema.safeParse(a).success) { bad++; console.log("acceptable label", c.id, a); }
  const dimMap: Record<string, string> = { population: "population", version: "version", purpose: "purpose", timing: "timing", metric: "metric", setting: "setting", product: "product" };
  for (const d of c.key.mismatchDimensions) if (!DimensionSchema.safeParse(dimMap[d]).success) { bad++; console.log("dimension", c.id, d); }
}
for (const e of sets) {
  const { anchors, ...item } = e;
  const r = EvidenceItemSchema.safeParse({ ...item, anchorIds: anchors.map((a: { id: string }) => a.id) });
  if (!r.success) { bad++; console.log("evidence", e.id, r.error.issues[0]); }
}
console.log(`validated ${claims.length} claims and ${sets.length} evidence items, ${bad} problems`);
process.exit(bad ? 1 : 0);
