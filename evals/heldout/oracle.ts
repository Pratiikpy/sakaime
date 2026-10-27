/**
 * Pass 2 of the held-out key: a mechanical oracle over the reader's per-dimension relations.
 *
 * It implements the label table of docs/02-architecture.md section 10 and the precedence stated in src/compiler/index.ts,
 * but shares no code with the compiler. It checks the internal consistency of the key (a hand label and a relation table
 * written for the same claim must agree); it does not show that the relations are right.
 */
import type { Label } from "../lib/types.ts";
import type { Pass2 } from "./data.ts";

export function oracleLabel(p: Pass2): Label {
  // 1. An explicit limit is exceeded, the source says in words that the use is not intended, or an adequate study is wholly below the claim.
  if (p.explicitLimit || p.textNegatesUse || p.contraryAdequate) return "CONTRADICTED_BY_SPECIFIED_EVIDENCE";
  const rel = Object.values(p.relations);
  // 3. A required dimension is unknown or not covered at all.
  if (rel.includes("UNKNOWN") || rel.includes("DISJOINT")) return "INSUFFICIENT_EVIDENCE";
  // 4. Any other flag (a policy window, a term nobody can place).
  if (p.reviewFlag) return "REQUIRES_DOMAIN_REVIEW";
  // 5. Some dimension is only partly covered.
  if (rel.includes("PARTIAL")) return "SUPPORTED_ONLY_FOR_NARROWER_SCOPE";
  // 6. Every stated dimension is contained.
  return "SUPPORTED_FOR_SCOPE";
}
