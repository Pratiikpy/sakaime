/**
 * The labelled corpus: record pairs and hard negatives built from the real devices and collisions in the
 * feasibility report. Every record carries a `fixtureRef` back to the pinned public data; every pair carries
 * the reason for its label and the report section it came from. All labels are builder-labelled by a single
 * reader, and the file says so on every pair.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { LinkTypeSchema } from "../schemas/index.ts";
import { IdentityRecordSchema, type IdentityRecord } from "./types.ts";

export const TRUTHS = ["MATCH", "NON_MATCH", "AMBIGUOUS"] as const;

export const CorpusRecordSchema = z.object({ family: z.string().min(1), record: IdentityRecordSchema }).strict();

export const CorpusPairSchema = z
  .object({
    id: z.string().min(1),
    /** The device family the pair is clustered under for splitting and for cluster-robust statistics. */
    family: z.string().min(1),
    linkType: LinkTypeSchema,
    a: z.string().min(1),
    b: z.string().min(1),
    /** MATCH: the link holds. NON_MATCH: it does not. AMBIGUOUS: the records do not settle it. */
    truth: z.enum(TRUTHS),
    /** identifier: decided by an identifier or structured field in the records. reading: decided by the builder reading text. */
    labelBasis: z.enum(["identifier", "reading"]),
    /** True where a reasonable reader could label the pair differently. */
    contestable: z.boolean(),
    /** True where an exact identifier should take the link to CONFIRMED. */
    expectConfirmed: z.boolean(),
    /** Prefixes of mismatch flags a reviewer should see on this pair. */
    expectedFlags: z.array(z.string()),
    reason: z.string().min(1),
    reportSection: z.string().min(1),
    labelling: z.object({ reader: z.string(), readers: z.number().int().positive(), independent: z.boolean() }).strict(),
  })
  .strict();
export type CorpusPair = z.infer<typeof CorpusPairSchema>;

export interface Corpus {
  records: Map<string, { family: string; record: IdentityRecord }>;
  pairs: CorpusPair[];
}

export function defaultCorpusDir(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "data", "identity-corpus");
}

export function loadCorpus(dir: string = defaultCorpusDir()): Corpus {
  const rawRecords = JSON.parse(readFileSync(join(dir, "records.json"), "utf8")) as unknown;
  const rawPairs = JSON.parse(readFileSync(join(dir, "pairs.json"), "utf8")) as unknown;
  const records = new Map<string, { family: string; record: IdentityRecord }>();
  for (const r of z.array(CorpusRecordSchema).parse(rawRecords)) {
    if (records.has(r.record.id)) throw new Error(`corpus has two records with id ${r.record.id}`);
    records.set(r.record.id, r);
  }
  const pairs = z.array(CorpusPairSchema).parse(rawPairs);
  const seen = new Set<string>();
  for (const p of pairs) {
    if (seen.has(p.id)) throw new Error(`corpus has two pairs with id ${p.id}`);
    seen.add(p.id);
    for (const ref of [p.a, p.b]) if (!records.has(ref)) throw new Error(`pair ${p.id} refers to unknown record ${ref}`);
  }
  return { records, pairs };
}
