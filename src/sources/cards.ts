/**
 * Source cards: declarative YAML, one per source family, schema-checked at load.
 *
 * A card is the single place that says what a source is, where it may be reached, how fast it may be asked,
 * which fields identify a record, and what has and has not been verified. The allowlist the safe fetcher
 * enforces is built from the cards, so a host only becomes reachable by being written down here.
 *
 * Every number in a card carries its basis. Anything not read from the source's own documentation or
 * observed in a recorded response stays under `verification.notVerified`; nothing is filled in to look complete.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { SourceCard } from "../ports/index.ts";
import { DataClassSchema } from "../schemas/common.ts";
import { SourceKindSchema } from "../schemas/evidence.ts";
import { ContractPathSchema } from "./contract.ts";
import { HostAllowlist, type AllowedHost } from "./safe-fetch.ts";

export const CONNECTOR_KEYS = [
  "openfda-510k",
  "openfda-udi",
  "openfda-pma",
  "clinicaltrials-v2",
  "pubmed",
  "europepmc",
  "crossref",
  "fda-pdf",
  "fda-ai-list",
] as const;
export type ConnectorKey = (typeof CONNECTOR_KEYS)[number];

const RateSchema = z.object({
  requests: z.number().int().positive(),
  perSeconds: z.number().positive(),
  perDay: z.number().int().positive().optional(),
  /** Where the number comes from: a documentation page or a recorded response header. */
  basis: z.string().min(1),
});

export const SourceCardFileSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
    title: z.string().min(1),
    kind: SourceKindSchema,
    connector: z.enum(CONNECTOR_KEYS),
    baseUrl: z.string().url().startsWith("https://"),
    hosts: z
      .array(
        z.object({
          host: z.string().min(1),
          ports: z.array(z.number().int().positive()).optional(),
          pathPrefixes: z.array(z.string().startsWith("/")).optional(),
        }),
      )
      .min(1),
    auth: z.enum(["none", "key"]),
    /** Limits the source documents or exposes in response headers. Honoured as hard caps. */
    rateLimit: RateSchema.optional(),
    /** Our own pacing where no limit is documented. Never presented as the source's limit. */
    politeness: z.object({ requests: z.number().int().positive(), perSeconds: z.number().positive(), basis: z.string().min(1) }).optional(),
    /** Cards that share one allowance (the three openFDA endpoints share one per-IP quota). */
    rateLimitGroup: z.string().optional(),
    maxConcurrent: z.number().int().positive().optional(),
    identifierFields: z.array(z.string()).min(1),
    supportedPredicates: z.array(z.string()),
    cadenceHours: z.number().positive().optional(),
    license: z.string().min(1),
    dataClass: DataClassSchema,
    schemaVersion: z.string().min(1),
    /** Contracts per operation (for example `search` and `study` for ClinicalTrials.gov). */
    responseContracts: z.record(z.string(), z.array(ContractPathSchema)).default({}),
    probe: z.object({ operation: z.string(), query: z.record(z.string(), z.union([z.string(), z.number()])), limit: z.number().int().positive().optional(), description: z.string() }),
    /** "pinned-snapshot" when the live source refuses scripted access and a hashed snapshot is served instead. */
    access: z.enum(["live", "pinned-snapshot"]).default("live"),
    snapshot: z.object({ manifest: z.string() }).optional(),
    verification: z.object({
      verifiedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      evidence: z.array(z.string()).min(1),
      /** Facts that were looked for and not established. Kept visible on purpose. */
      notVerified: z.array(z.string()),
    }),
  })
  .superRefine((card, ctx) => {
    if (card.access === "pinned-snapshot" && !card.snapshot) ctx.addIssue({ code: "custom", message: "a pinned-snapshot card needs a snapshot manifest", path: ["snapshot"] });
    if (card.rateLimit?.perDay && !card.rateLimitGroup) ctx.addIssue({ code: "custom", message: "a card with a daily cap must name its rateLimitGroup so the counter is shared", path: ["rateLimitGroup"] });
    for (const h of card.hosts) {
      if (!/^[a-z0-9.-]+$/.test(h.host)) ctx.addIssue({ code: "custom", message: `host "${h.host}" must be a lower-case DNS name`, path: ["hosts"] });
    }
    const baseHost = new URL(card.baseUrl).hostname;
    if (!card.hosts.some((h) => h.host === baseHost)) ctx.addIssue({ code: "custom", message: `baseUrl host ${baseHost} is not in hosts`, path: ["baseUrl"] });
  });
export type SourceCardFile = z.infer<typeof SourceCardFileSchema>;

export interface LoadedCard {
  /** The port-level card connectors expose through describe(). */
  card: SourceCard;
  /** The full card as written. */
  file: SourceCardFile;
}

export const defaultCardsDir = (): string => fileURLToPath(new URL("../../data/sources/", import.meta.url));

export function toPortCard(file: SourceCardFile): SourceCard {
  return {
    id: file.id,
    kind: file.kind,
    baseUrl: file.baseUrl,
    auth: file.auth,
    ...(file.rateLimit ? { rateLimit: { requests: file.rateLimit.requests, perSeconds: file.rateLimit.perSeconds, ...(file.rateLimit.perDay ? { perDay: file.rateLimit.perDay } : {}) } } : {}),
    identifierFields: file.identifierFields,
    supportedPredicates: file.supportedPredicates,
    ...(file.cadenceHours ? { cadenceHours: file.cadenceHours } : {}),
    license: file.license,
    dataClass: file.dataClass,
  };
}

export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardError";
  }
}

export function parseCard(text: string, origin: string): LoadedCard {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (err) {
    throw new CardError(`${origin}: invalid YAML: ${(err as Error).message}`);
  }
  const parsed = SourceCardFileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new CardError(`${origin}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  return { card: toPortCard(parsed.data), file: parsed.data };
}

/** Load every `*.yaml` card in a directory, in file-name order. Duplicate ids are an error. */
export function loadSourceCards(dir: string = defaultCardsDir()): LoadedCard[] {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith(".yaml")).sort();
  if (files.length === 0) throw new CardError(`no source cards found in ${dir}`);
  const cards = files.map((f) => parseCard(fs.readFileSync(path.join(dir, f), "utf8"), f));
  const seen = new Set<string>();
  for (const { file } of cards) {
    if (seen.has(file.id)) throw new CardError(`duplicate source card id "${file.id}"`);
    seen.add(file.id);
  }
  return cards;
}

/** The allowlist the safe fetcher enforces: exactly the hosts and path prefixes the cards name. */
export function allowlistFromCards(cards: LoadedCard[]): HostAllowlist {
  const entries: AllowedHost[] = [];
  for (const { file } of cards) {
    for (const h of file.hosts) entries.push({ host: h.host, ports: h.ports, pathPrefixes: h.pathPrefixes, grantedBy: file.id });
  }
  return new HostAllowlist(entries);
}
