import { z } from "zod";
import { AssertionTypeSchema, DataClassSchema, LinkStateSchema, LinkTypeSchema, SourceHealthSchema } from "./common.ts";

export const IsoDateTime = z.string().datetime({ offset: true });
export const Sha256 = z.string().regex(/^[0-9a-f]{64}$/, "expected lowercase hex sha256");

/** Where a source sits in the evidence ecosystem. Authority is decided per assertion type, not per kind. */
export const SOURCE_KINDS = ["regulator", "registry", "literature", "vendor", "hospital", "other"] as const;
export const SourceKindSchema = z.enum(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const SOURCE_ACCESS = ["zetaris", "connector", "file"] as const;
export const SourceAccessSchema = z.enum(SOURCE_ACCESS);

export const SourceSchema = z.object({
  id: z.string().min(1),
  kind: SourceKindSchema,
  access: SourceAccessSchema,
  /** Human description of what the source holds. */
  descriptor: z.string().min(1),
  license: z.string().min(1),
  /** Fingerprint of the response shape; a change raises DRIFTED. */
  schemaHash: Sha256.optional(),
  health: SourceHealthSchema,
  lastSuccessAt: IsoDateTime.optional(),
  dataClass: DataClassSchema,
});
export type Source = z.infer<typeof SourceSchema>;

/** Immutable. A newer fetch of the same request is a new record, never an update. */
export const EvidenceRecordSchema = z.object({
  id: z.string().min(1),
  sourceId: z.string().min(1),
  retrievedAt: IsoDateTime,
  sourcePublishedAt: IsoDateTime.optional(),
  validFrom: IsoDateTime.optional(),
  validTo: IsoDateTime.optional(),
  /** Hash of the request that produced it (method, url, canonical query). */
  requestHash: Sha256,
  /** Hash of the stored content bytes. */
  contentHash: Sha256,
  schemaVersion: z.string().min(1),
  license: z.string().min(1),
  /** Relative path of the stored content under the evidence store, or an inline JSON payload. */
  contentRef: z.string().min(1).optional(),
  payload: z.unknown().optional(),
});
export type EvidenceRecord = z.infer<typeof EvidenceRecordSchema>;

export const EvidenceAnchorSchema = z.object({
  id: z.string().min(1),
  recordId: z.string().min(1),
  page: z.number().int().positive().optional(),
  jsonPath: z.string().optional(),
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
  /** The verbatim passage. */
  text: z.string().min(1),
  textHash: Sha256,
});
export type EvidenceAnchor = z.infer<typeof EvidenceAnchorSchema>;

export const EXTRACTION_METHODS = ["structured", "pattern", "model", "reviewer"] as const;
export const SUPPORT_STATES = ["PASS", "FAIL", "UNCHECKED"] as const;

/**
 * One extracted statement. Quote-exists and semantic support are separate checks:
 * a quote can exist verbatim and still not state what the assertion claims.
 */
export const EvidenceAssertionSchema = z.object({
  id: z.string().min(1),
  subjectId: z.string().min(1),
  predicate: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(z.string())]),
  unit: z.string().optional(),
  appliesToVersion: z.string().optional(),
  assertionType: AssertionTypeSchema,
  anchorId: z.string().min(1),
  extractionMethod: z.enum(EXTRACTION_METHODS),
  quoteVerified: z.boolean(),
  supportVerified: z.enum(SUPPORT_STATES),
});
export type EvidenceAssertion = z.infer<typeof EvidenceAssertionSchema>;

/** Bi-temporal fact. History is never deleted; supersession sets supersededAt. */
export const FactSchema = z.object({
  id: z.string().min(1),
  subject: z.string().min(1),
  predicate: z.string().min(1),
  object: z.string().min(1),
  validFrom: IsoDateTime.optional(),
  validTo: IsoDateTime.optional(),
  recordedAt: IsoDateTime,
  supersededAt: IsoDateTime.optional(),
  sourceId: z.string().min(1),
  assertionType: AssertionTypeSchema,
  anchorId: z.string().optional(),
  hash: Sha256,
});
export type Fact = z.infer<typeof FactSchema>;

/** A weight contribution in a Fellegi-Sunter style waterfall. */
export const WaterfallStepSchema = z.object({
  field: z.string(),
  level: z.string(),
  weight: z.number(),
});

export const LinkSchema = z.object({
  id: z.string().min(1),
  type: LinkTypeSchema,
  from: z.string().min(1),
  to: z.string().min(1),
  state: LinkStateSchema,
  /** Why the link holds or is only a candidate: identifiers shared, reviewer, or score. */
  basis: z.array(z.string()).default([]),
  score: z.number().optional(),
  waterfall: z.array(WaterfallStepSchema).optional(),
  decidedBy: z.string().optional(),
  decidedAt: IsoDateTime.optional(),
  /** Mismatch flags such as "version differs" that do not change the link state but must be shown. */
  flags: z.array(z.string()).default([]),
});
export type Link = z.infer<typeof LinkSchema>;
