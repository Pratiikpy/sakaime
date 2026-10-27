/**
 * Identity layer types. Records are the inputs the resolver compares; they are extracted features, not
 * raw payloads. Everything the resolver may use is a named field, so every comparison can be explained.
 */
import { z } from "zod";
import { LinkSchema, LinkStateSchema, LinkTypeSchema, type Link, type LinkState, type LinkType } from "../schemas/index.ts";
import { PortError } from "../ports/index.ts";

export const ENTITY_KINDS = [
  "Manufacturer",
  "ProductFamily",
  "MarketedDevice",
  "SoftwareRelease",
  "AuthorizationSubmission",
  "Study",
  "RegistryEntry",
  "Publication",
] as const;
export const EntityKindSchema = z.enum(ENTITY_KINDS);
export type EntityKind = z.infer<typeof EntityKindSchema>;

export const MENTION_TYPES = ["submission", "nct", "pmid", "doi"] as const;

/**
 * An identifier that a record cites but does not own. `field` means a structured field named it (a registry
 * reference list, an intervention name, a PubMed databank accession); `text` means it was found in prose and
 * the surrounding passage is kept so the role of the cited thing can be judged.
 */
export const MentionSchema = z
  .object({
    type: z.enum(MENTION_TYPES),
    value: z.string().min(1).max(200),
    channel: z.enum(["field", "text"]),
    /** Only meaningful on structured mentions: the source itself says whether it is a result or background reference. */
    role: z.enum(["report", "background"]).optional(),
    context: z.string().max(1200).optional(),
  })
  .strict();
export type Mention = z.infer<typeof MentionSchema>;

const DateString = z.string().regex(/^\d{4}(-\d{2}(-\d{2})?)?$/, "expected YYYY, YYYY-MM or YYYY-MM-DD");

export const OwnIdsSchema = z
  .object({
    /** FDA submission numbers this record is keyed by or tied to (K, DEN, P with optional supplement). */
    submission: z.array(z.string().min(1).max(40)).default([]),
    nct: z.array(z.string().min(1).max(20)).default([]),
    pmid: z.array(z.string().min(1).max(12)).default([]),
    doi: z.array(z.string().min(1).max(200)).default([]),
    /** Device identifier of a specific marketed version (GUDID). */
    udiDi: z.array(z.string().min(1).max(40)).default([]),
  })
  .strict();
export type OwnIds = z.infer<typeof OwnIdsSchema>;

export const IdentityRecordSchema = z
  .object({
    id: z.string().min(1).max(200),
    kind: EntityKindSchema,
    /** Which source produced the record (for display and audit only; never used for scoring). */
    source: z.string().min(1).max(100),
    /** Where in the pinned fixtures or snapshot the record came from. */
    fixtureRef: z.string().max(300).optional(),
    name: z.string().max(1000).optional(),
    /** Alternate names: registry intervention names, former names. */
    aliases: z.array(z.string().max(500)).max(50).default([]),
    /** Title and abstract or description; searched for the other record's name. */
    text: z.string().max(20000).optional(),
    manufacturer: z.string().max(300).optional(),
    /** Registry sponsor. Kept apart from manufacturer because an academic sponsor says nothing about who makes the device. */
    sponsor: z.string().max(300).optional(),
    productCode: z.string().max(10).optional(),
    version: z.string().max(100).optional(),
    module: z.string().max(100).optional(),
    purposeTags: z.array(z.string().max(80)).max(30).default([]),
    date: DateString.optional(),
    enrollment: z.number().int().nonnegative().optional(),
    ids: OwnIdsSchema.prefault({}),
    mentions: z.array(MentionSchema).max(200).default([]),
    /** Record ids this record explicitly declares it replaces. */
    supersedes: z.array(z.string().min(1).max(200)).default([]),
  })
  .strict();
export type IdentityRecord = z.infer<typeof IdentityRecordSchema>;
export type IdentityRecordInput = z.input<typeof IdentityRecordSchema>;

/** Parses a record, turning any shape problem into the product's INVALID failure class. */
export function parseRecord(input: unknown, label = "record"): IdentityRecord {
  const parsed = IdentityRecordSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new PortError("INVALID", `${label} is not a valid identity record: ${first?.path.join(".") || "(root)"}: ${first?.message}`, {
      issues: parsed.error.issues.slice(0, 5).map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return parsed.data;
}

/** Candidate classes from the feasibility report, each with a defined meaning. */
export const CANDIDATE_CLASSES = ["EXACT-IDENTIFIER", "STRONG-TEXT", "WEAK-NAME-ONLY", "NONE"] as const;
export type CandidateClass = (typeof CANDIDATE_CLASSES)[number];

/** How a link may be worded to a reader. Only the first value is a fact. */
export const PRESENTATIONS = ["CONFIRMED_FACT", "STRONG_CANDIDATE", "WEAK_CANDIDATE", "REJECTED", "NOT_LINKED"] as const;
export type Presentation = (typeof PRESENTATIONS)[number];

export const SCORER_FIELDS = ["name", "manufacturer", "productCode", "version", "module", "purpose", "date", "enrollment"] as const;
export type ScorerField = (typeof SCORER_FIELDS)[number];

export interface ComparisonOutcome {
  field: ScorerField;
  level: string;
  detail?: string;
}

export { LinkSchema, LinkStateSchema, LinkTypeSchema };
export type { Link, LinkState, LinkType };
