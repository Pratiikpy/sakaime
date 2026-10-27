/**
 * Field comparisons: each returns a named level, never a number. The Fellegi-Sunter scorer turns levels into
 * weights; the levels themselves are what a reviewer reads in the waterfall.
 *
 * "UNKNOWN" means a field is missing on at least one side. It always carries zero weight: an absent field is
 * not evidence of a match or of a mismatch.
 */
import {
  aliasGroupOf,
  containsTokenRun,
  foldText,
  jaroWinkler,
  normaliseManufacturer,
  normaliseName,
  splitDeviceCell,
  tokenize,
  type AliasGroup,
} from "./normalize.ts";
import type { ComparisonOutcome, IdentityRecord } from "./types.ts";
import { compareVersions } from "./version.ts";

/** Words that name a technique or an everyday thing rather than one product; a bare match on them is weak. */
export const AMBIGUOUS_NAME_TOKENS: ReadonlySet<string> = new Set([
  "contact", "briefcase", "caption", "aurora", "ffrct", "guidance", "genius", "insight", "analysis", "triage", "eko",
]);

/** Rows of the reference list that share one normalised name before the name stops identifying a product. */
export const FAMILY_NAME_MIN_ROWS = 3;

export interface CompareContext {
  /** Normalised device-name key -> number of reference-list rows carrying it (see ScorerModel.reference). */
  familyNames?: Readonly<Record<string, number>>;
  aliasGroups?: readonly AliasGroup[];
}

export interface NameKeys {
  /** Names the record gives for itself, normalised. */
  primary: { key: string; tokens: string[]; versions: string[] }[];
  /** Registry intervention names and former names. */
  aliases: { key: string; tokens: string[] }[];
  /** Tokens of the title or description. */
  textTokens: string[];
}

export function nameKeys(record: IdentityRecord): NameKeys {
  const primary = (record.name ? splitDeviceCell(record.name) : []).map((n) => normaliseName(n)).filter((n) => n.key !== "");
  const aliases = record.aliases.map((n) => normaliseName(n)).filter((n) => n.key !== "");
  return {
    primary: primary.map((n) => ({ key: n.key, tokens: n.tokens, versions: n.versions })),
    aliases: aliases.map((n) => ({ key: n.key, tokens: n.tokens })),
    textTokens: record.text ? tokenize(foldText(record.text)) : [],
  };
}

/** The release a record states: its version field, else the single version token in its name. Never a guess among several. */
export function effectiveVersion(record: Pick<IdentityRecord, "name" | "version">): string | undefined {
  if (record.version && record.version.trim() !== "") return record.version;
  if (!record.name) return undefined;
  const devices = splitDeviceCell(record.name);
  if (devices.length !== 1) return undefined;
  const { versions } = normaliseName(devices[0]!);
  return versions.length === 1 ? versions[0] : undefined;
}

/** Words a product name may end with that describe the kind of product rather than naming it ("Lunit INSIGHT CXR Triage"). */
const TRAILING_DESCRIPTORS = new Set(["triage", "analysis", "system", "algorithm", "device", "module", "application", "platform", "detection", "solution"]);

function withoutTrailingDescriptors(tokens: readonly string[]): string[] {
  const out = [...tokens];
  while (out.length > 1 && TRAILING_DESCRIPTORS.has(out[out.length - 1]!)) out.pop();
  return out;
}

function isGenericRun(tokens: readonly string[]): boolean {
  return tokens.length > 0 && tokens.every((t) => AMBIGUOUS_NAME_TOKENS.has(t));
}

function totalChars(tokens: readonly string[]): number {
  return tokens.reduce((n, t) => n + t.length, 0);
}

function tokenJaccard(a: readonly string[], b: readonly string[]): number {
  const sa = new Set(a.filter((t) => t.length > 1));
  const sb = new Set(b.filter((t) => t.length > 1));
  if (sa.size === 0 || sb.size === 0) return 0;
  let shared = 0;
  for (const t of sa) if (sb.has(t)) shared++;
  return shared / (sa.size + sb.size - shared);
}

export function compareName(a: IdentityRecord, b: IdentityRecord, ctx: CompareContext): ComparisonOutcome {
  const ka = nameKeys(a);
  const kb = nameKeys(b);
  const hasA = ka.primary.length + ka.aliases.length > 0 || ka.textTokens.length > 0;
  const hasB = kb.primary.length + kb.aliases.length > 0 || kb.textTokens.length > 0;
  if (!hasA || !hasB) return { field: "name", level: "UNKNOWN" };

  const tagged = (k: NameKeys) => [
    ...k.primary.map((n) => ({ key: n.key, tokens: n.tokens, primary: true })),
    ...k.aliases.map((n) => ({ key: n.key, tokens: n.tokens, primary: false })),
  ];
  const namesA = tagged(ka);
  const namesB = tagged(kb);

  // Exact: an equal normalised name, where at least one side is a primary name.
  for (const x of namesA) {
    for (const y of namesB) {
      if (x.key === y.key && (x.primary || y.primary)) {
        const rows = ctx.familyNames?.[x.key] ?? 0;
        if (rows >= FAMILY_NAME_MIN_ROWS) return { field: "name", level: "FAMILY_NAME", detail: `${x.key} (${rows} reference rows)` };
        return { field: "name", level: "EXACT", detail: x.key };
      }
    }
  }

  // Contains: one side's name appears as whole tokens inside the other's names or text. A name found in free
  // text is weaker than one found in another record's name, so only the former can be "generic".
  const contains = (needles: { key: string; tokens: string[] }[], hay: NameKeys): { key: string; via: "name" | "text" } | undefined => {
    for (const n of needles) {
      for (const tokens of [n.tokens, withoutTrailingDescriptors(n.tokens)]) {
        if (totalChars(tokens) < 4) continue;
        if ([...hay.primary, ...hay.aliases].some((p) => containsTokenRun(p.tokens, tokens))) return { key: tokens.join(" "), via: "name" };
        if (containsTokenRun(hay.textTokens, tokens)) return { key: tokens.join(" "), via: "text" };
      }
    }
    return undefined;
  };
  const hit = contains(ka.primary, kb) ?? contains(kb.primary, ka);
  if (hit !== undefined) {
    const rows = ctx.familyNames?.[hit.key] ?? 0;
    if (rows >= FAMILY_NAME_MIN_ROWS) return { field: "name", level: "FAMILY_NAME", detail: `${hit.key} contained (${rows} reference rows)` };
    return { field: "name", level: hit.via === "text" && isGenericRun(hit.key.split(" ")) ? "GENERIC_CONTAINS" : "CONTAINS", detail: hit.key };
  }

  // Overlap: close token sets or near-identical compact keys.
  let best = 0;
  let bestJw = 0;
  for (const x of namesA) {
    for (const y of namesB) {
      best = Math.max(best, tokenJaccard(x.tokens, y.tokens));
      bestJw = Math.max(bestJw, jaroWinkler(x.key.replace(/ /g, ""), y.key.replace(/ /g, "")));
    }
  }
  if (best >= 0.5 || bestJw >= 0.94) return { field: "name", level: "OVERLAP", detail: `jaccard ${best.toFixed(2)}, jw ${bestJw.toFixed(2)}` };
  if (namesA.length === 0 || namesB.length === 0) return { field: "name", level: "UNKNOWN" };
  return { field: "name", level: "DIFFERENT" };
}

/** True when a product name contains the first word of a company name: the brand is the company ("Paige Prostate"). */
function brandContainsCompany(records: readonly IdentityRecord[]): boolean {
  const firsts = new Set<string>();
  for (const r of records) {
    for (const m of [r.manufacturer, r.sponsor]) {
      if (!m) continue;
      const first = tokenize(foldText(m)).find((t) => t.length >= 3);
      if (first) firsts.add(first);
    }
  }
  return records.some((r) => nameKeys(r).primary.some((n) => n.tokens.some((t) => firsts.has(t))));
}

export const BRAND_IS_COMPANY = "brand-contains-manufacturer";

export function compareManufacturer(a: IdentityRecord, b: IdentityRecord, ctx: CompareContext): ComparisonOutcome {
  const outcome = compareManufacturerRaw(a, b, ctx);
  if ((outcome.level === "EXACT" || outcome.level === "ALIAS" || outcome.level === "FUZZY") && brandContainsCompany([a, b])) {
    return { ...outcome, detail: [outcome.detail, BRAND_IS_COMPANY].filter(Boolean).join("; ") };
  }
  return outcome;
}

function compareManufacturerRaw(a: IdentityRecord, b: IdentityRecord, ctx: CompareContext): ComparisonOutcome {
  const level = (x: string, y: string): { level: string; detail?: string } => {
    const kx = normaliseManufacturer(x).key;
    const ky = normaliseManufacturer(y).key;
    if (kx === "" || ky === "") return { level: "UNKNOWN" };
    if (kx === ky) return { level: "EXACT" };
    const gx = aliasGroupOf(kx, ctx.aliasGroups);
    if (gx !== undefined && gx === aliasGroupOf(ky, ctx.aliasGroups)) return { level: "ALIAS", detail: gx };
    if (jaroWinkler(kx, ky) >= 0.93) return { level: "FUZZY", detail: `jw ${jaroWinkler(kx, ky).toFixed(2)}` };
    return { level: "DIFFERENT" };
  };
  if (a.manufacturer && b.manufacturer) {
    const r = level(a.manufacturer, b.manufacturer);
    return { field: "manufacturer", ...r };
  }
  // A sponsor says nothing about who makes the device, so it can raise belief but never lower it.
  const sideA = a.manufacturer ?? a.sponsor;
  const sideB = b.manufacturer ?? b.sponsor;
  if (sideA && sideB && (a.manufacturer || b.manufacturer)) {
    const r = level(sideA, sideB);
    if (r.level !== "DIFFERENT") return { field: "manufacturer", ...r };
  }
  return { field: "manufacturer", level: "UNKNOWN" };
}

export function compareProductCode(a: IdentityRecord, b: IdentityRecord): ComparisonOutcome {
  if (!a.productCode || !b.productCode) return { field: "productCode", level: "UNKNOWN" };
  return { field: "productCode", level: a.productCode.toUpperCase() === b.productCode.toUpperCase() ? "EXACT" : "DIFFERENT" };
}

export function compareVersionField(a: IdentityRecord, b: IdentityRecord): ComparisonOutcome {
  const cmp = compareVersions(effectiveVersion(a), effectiveVersion(b));
  return { field: "version", level: cmp.relation, detail: cmp.reason };
}

export function compareModule(a: IdentityRecord, b: IdentityRecord): ComparisonOutcome {
  if (!a.module || !b.module) return { field: "module", level: "UNKNOWN" };
  const x = tokenize(foldText(a.module));
  const y = tokenize(foldText(b.module));
  if (x.length === 0 || y.length === 0) return { field: "module", level: "UNKNOWN" };
  const agree = containsTokenRun(x, y) || containsTokenRun(y, x);
  return { field: "module", level: agree ? "AGREE" : "DISAGREE", detail: `${a.module} versus ${b.module}` };
}

function tagSet(tags: readonly string[]): Set<string> {
  return new Set(tags.map((t) => foldText(t).trim()).filter((t) => t !== ""));
}

export function comparePurpose(a: IdentityRecord, b: IdentityRecord): ComparisonOutcome {
  const x = tagSet(a.purposeTags);
  const y = tagSet(b.purposeTags);
  if (x.size === 0 || y.size === 0) return { field: "purpose", level: "UNKNOWN" };
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  const overlap = shared / Math.min(x.size, y.size);
  const detail = `${[...x].join("|")} versus ${[...y].join("|")}`;
  if (overlap >= 0.999) return { field: "purpose", level: "AGREE", detail };
  if (overlap > 0) return { field: "purpose", level: "PARTIAL", detail };
  return { field: "purpose", level: "DISAGREE", detail };
}

function yearFraction(date: string | undefined): number | undefined {
  if (!date) return undefined;
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(date);
  if (!m) return undefined;
  const month = m[2] ? Number(m[2]) : 7;
  const day = m[3] ? Number(m[3]) : 15;
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  return Number(m[1]) + (month - 1) / 12 + (day - 1) / 365;
}

export function compareDate(a: IdentityRecord, b: IdentityRecord): ComparisonOutcome {
  const x = yearFraction(a.date);
  const y = yearFraction(b.date);
  if (x === undefined || y === undefined) return { field: "date", level: "UNKNOWN" };
  const gap = Math.abs(x - y);
  const level = gap <= 1 ? "WITHIN_1Y" : gap <= 3 ? "WITHIN_3Y" : gap <= 6 ? "WITHIN_6Y" : "FAR";
  return { field: "date", level, detail: `${gap.toFixed(1)} years` };
}

export function compareEnrollment(a: IdentityRecord, b: IdentityRecord): ComparisonOutcome {
  const x = a.enrollment;
  const y = b.enrollment;
  if (!x || !y) return { field: "enrollment", level: "UNKNOWN" };
  if (x === y) return { field: "enrollment", level: "EXACT" };
  return { field: "enrollment", level: Math.abs(x - y) / Math.max(x, y) <= 0.1 ? "CLOSE" : "DIFFERENT", detail: `${x} versus ${y}` };
}

/** All field comparisons for one pair, in the fixed field order. */
export function compareRecords(a: IdentityRecord, b: IdentityRecord, ctx: CompareContext = {}): ComparisonOutcome[] {
  return [
    compareName(a, b, ctx),
    compareManufacturer(a, b, ctx),
    compareProductCode(a, b),
    compareVersionField(a, b),
    compareModule(a, b),
    comparePurpose(a, b),
    compareDate(a, b),
    compareEnrollment(a, b),
  ];
}
