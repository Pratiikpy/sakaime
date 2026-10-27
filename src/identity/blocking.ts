/**
 * Blocking: which pairs are worth comparing at all. Comparing every record with every other is quadratic, so
 * records are bucketed by cheap keys and only records that share a bucket are paired. A pair is kept if any
 * rule puts it together (a union of rules, as in Splink), so one noisy field cannot hide a true pair.
 *
 * Rules: normalised manufacturer (or its alias group), product code, the brand token of a name, the stated use
 * and study size, and every identifier a record owns or cites. Text-heavy records (studies, papers) are
 * blocked on any brand token from the pool's product names that appears in their text, since they rarely have a
 * manufacturer or product code.
 */
import { applicableLinkTypes } from "./exact.ts";
import { canonicalSet } from "./identifiers.ts";
import { nameKeys } from "./compare.ts";
import { aliasGroupOf, foldText, normaliseManufacturer, type AliasGroup } from "./normalize.ts";
import { parseRecord, type IdentityRecord, type IdentityRecordInput } from "./types.ts";
import type { LinkType } from "../schemas/index.ts";

export interface BlockedPair {
  a: IdentityRecord;
  b: IdentityRecord;
  /** Every rule that bucketed this pair together. */
  rules: string[];
  linkTypes: LinkType[];
}

export interface BlockingResult {
  pairs: BlockedPair[];
  totalPossible: number;
  /** 1 - kept/possible: the share of comparisons avoided. */
  reduction: number;
}

function brandTokens(record: IdentityRecord): string[] {
  const keys = nameKeys(record);
  return [...keys.primary, ...keys.aliases].map((n) => n.tokens[0]).filter((t): t is string => t !== undefined && t.length >= 2);
}

export function blockingKeys(record: IdentityRecord, vocabulary: ReadonlySet<string>, aliasGroups?: readonly AliasGroup[]): string[] {
  const keys = new Set<string>();
  for (const m of [record.manufacturer, record.sponsor]) {
    if (!m) continue;
    const key = normaliseManufacturer(m).key;
    if (key) keys.add(`mfr:${aliasGroupOf(key, aliasGroups) ?? key}`);
  }
  if (record.productCode) keys.add(`code:${record.productCode.toUpperCase()}`);
  // Records with no brand or manufacturer (many papers and registry entries) are reached through the use they
  // describe and the size of the study, which is highly selective when it is stated.
  for (const tag of record.purposeTags) keys.add(`purpose:${foldText(tag).trim()}`);
  if (record.enrollment) keys.add(`enrollment:${record.enrollment}`);
  for (const t of brandTokens(record)) keys.add(`brand:${t}`);
  for (const t of nameKeys(record).textTokens) if (vocabulary.has(t)) keys.add(`brand:${t}`);
  for (const id of canonicalSet("submission", record.ids.submission)) keys.add(`sub:${id}`);
  for (const kind of ["nct", "pmid", "doi", "udiDi"] as const) for (const id of canonicalSet(kind, record.ids[kind])) keys.add(`${kind}:${id}`);
  for (const m of record.mentions) {
    const bucket = canonicalSet(m.type, [m.value])[0];
    if (bucket) keys.add(`${m.type}:${bucket}`);
  }
  return [...keys];
}

export function generatePairs(inputs: readonly IdentityRecordInput[], aliasGroups?: readonly AliasGroup[]): BlockingResult {
  const records = inputs.map((r) => parseRecord(r));
  const seen = new Set<string>();
  for (const r of records) {
    if (seen.has(r.id)) throw new Error(`duplicate record id in pool: ${r.id}`);
    seen.add(r.id);
  }
  const vocabulary = new Set<string>();
  for (const r of records) for (const t of brandTokens(r)) vocabulary.add(t);

  const buckets = new Map<string, number[]>();
  records.forEach((r, i) => {
    for (const key of blockingKeys(r, vocabulary, aliasGroups)) {
      if (!buckets.has(key)) buckets.set(key, []);
      buckets.get(key)!.push(i);
    }
  });

  const rulesByPair = new Map<string, Set<string>>();
  for (const [key, members] of buckets) {
    const rule = key.slice(0, key.indexOf(":"));
    for (let x = 0; x < members.length; x++) {
      for (let y = x + 1; y < members.length; y++) {
        const [i, j] = members[x]! < members[y]! ? [members[x]!, members[y]!] : [members[y]!, members[x]!];
        const pk = `${i}:${j}`;
        if (!rulesByPair.has(pk)) rulesByPair.set(pk, new Set());
        rulesByPair.get(pk)!.add(rule);
      }
    }
  }

  const pairs: BlockedPair[] = [];
  for (const [pk, rules] of rulesByPair) {
    const [i, j] = pk.split(":").map(Number) as [number, number];
    const a = records[i]!;
    const b = records[j]!;
    const linkTypes = applicableLinkTypes(a, b);
    if (linkTypes.length === 0) continue;
    pairs.push({ a, b, rules: [...rules].sort(), linkTypes });
  }
  pairs.sort((p, q) => (p.a.id + "|" + p.b.id < q.a.id + "|" + q.b.id ? -1 : 1));
  const n = records.length;
  const totalPossible = (n * (n - 1)) / 2;
  return { pairs, totalPossible, reduction: totalPossible === 0 ? 0 : 1 - pairs.length / totalPossible };
}
