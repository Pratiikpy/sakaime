/**
 * Case definitions: a vendor packet's claim sentences plus the hospital's own intended use for one product.
 *
 * A case file is an input, validated with Zod when it is loaded. The claim sentences and the hospital cases they come from
 * are CONSTRUCTED rows in data/silos (the vendor packets and the review database); a test compares the two so the
 * file and the silos cannot drift apart. Nothing in a case file is evidence: it is the question the evidence is held against.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PortError } from "../ports/index.ts";
import { ClaimedPerformanceSchema, ScopeSchema, SourceDependenciesSchema, type Claim } from "../schemas/index.ts";

export const CaseClaimSchema = z.object({
  id: z.string().min(1),
  text: z.string().min(1),
  use: ScopeSchema,
  performance: ClaimedPerformanceSchema.optional(),
  /** The camera or other equipment the claim names. Not a compiler dimension: it is checked against hospital policy. */
  equipment: z.string().min(1).optional(),
});
export type CaseClaim = z.infer<typeof CaseClaimSchema>;

export const CaseSpecSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{2,60}$/),
  title: z.string().min(1),
  productLabel: z.string().min(1),
  constructedNotice: z.string().min(1),
  vendor: z.object({ name: z.string().min(1), aliases: z.array(z.string().min(1)).default([]) }),
  product: z.object({ name: z.string().min(1), condition: z.string().min(1).optional() }),
  /** K, DEN or P number the vendor cites. */
  submission: z.string().regex(/^(K\d{6}|DEN\d{6,7}|P\d{6})$/),
  hospital: z.object({ caseId: z.string().min(1), packetId: z.string().min(1), submissionId: z.string().min(1) }),
  /** The hospital reviewer's own question, in structured form. It is compiled like a claim and is the headline. */
  intended: CaseClaimSchema,
  claims: z.array(CaseClaimSchema).min(1),
  dependencies: SourceDependenciesSchema,
});
export type CaseSpec = z.infer<typeof CaseSpecSchema>;

export interface LoadedCase {
  spec: CaseSpec;
  file: string;
}

export function loadCases(dir: string): LoadedCase[] {
  const files = readdirSync(dir).filter((f) => f.endsWith(".json")).sort();
  const out: LoadedCase[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    const path = join(dir, f);
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(path, "utf8"));
    } catch (error) {
      throw new PortError("INVALID", `case file ${f} is not valid JSON: ${(error as Error).message}`);
    }
    const parsed = CaseSpecSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new PortError("INVALID", `case file ${f} is not a valid case: ${issue?.path.join(".") || "(root)"}: ${issue?.message}`);
    }
    if (seen.has(parsed.data.id)) throw new PortError("INVALID", `two case files define the id ${parsed.data.id}`);
    seen.add(parsed.data.id);
    out.push({ spec: parsed.data, file: f });
  }
  if (out.length === 0) throw new PortError("INVALID", `no case files found in ${dir}`);
  return out;
}

/** The compiler's Claim for one sentence of a case. */
export function claimOf(spec: CaseSpec, c: CaseClaim): Claim {
  return {
    id: c.id,
    text: c.text,
    use: c.use,
    ...(c.performance ? { performance: c.performance } : {}),
    dependencies: spec.dependencies,
  };
}

/** All claims of a case, headline first. */
export function allClaims(spec: CaseSpec): CaseClaim[] {
  return [spec.intended, ...spec.claims];
}
