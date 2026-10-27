/**
 * Mismatch flags: facts a reader must see next to a link that do not change its state. A study run on version
 * 1.7.0 still reports on the Transpara product cleared as 1.7.2; the link says so and the flag says what differs.
 * The version compiler downstream uses these, so they are specific: they name both values.
 */
import { aliasGroupOf, containsTokenRun, MANUFACTURER_ALIAS_GROUPS, normaliseManufacturer, normaliseName, PRODUCT_ALIAS_GROUPS, type AliasGroup } from "./normalize.ts";
import { canonicalSet } from "./identifiers.ts";
import { AMBIGUOUS_NAME_TOKENS, effectiveVersion, FAMILY_NAME_MIN_ROWS, nameKeys } from "./compare.ts";
import type { ComparisonOutcome, IdentityRecord } from "./types.ts";
import { compareVersions, parseVersion } from "./version.ts";

/** The members of a product alias group that a record names, in its names, aliases or text. */
function namedMembers(record: IdentityRecord, group: AliasGroup): string[] {
  const keys = nameKeys(record);
  const namePools = [...keys.primary.map((p) => p.tokens), ...keys.aliases.map((p) => p.tokens)];
  return group.names.filter((n) => {
    const tokens = normaliseName(n).tokens;
    if (namePools.some((pool) => containsTokenRun(pool, tokens))) return true;
    // A common word found in prose ("contact") is not the product; only distinctive names count in free text.
    return !tokens.every((t) => AMBIGUOUS_NAME_TOKENS.has(t)) && containsTokenRun(keys.textTokens, tokens);
  });
}

export interface FlagContext {
  /** Other known records, used to see how many releases share a submission number. */
  knownRecords?: readonly IdentityRecord[];
  aliasGroups?: readonly AliasGroup[];
}

function outcome(outcomes: readonly ComparisonOutcome[], field: ComparisonOutcome["field"]): ComparisonOutcome | undefined {
  return outcomes.find((o) => o.field === field);
}

function releasesUnder(submission: string, known: readonly IdentityRecord[]): string[] {
  const versions = new Set<string>();
  for (const r of known) {
    if (!canonicalSet("submission", r.ids.submission).includes(submission)) continue;
    const v = effectiveVersion(r);
    // Free-text labels such as "Guidance" or "AI" are not release numbers and are not counted as releases.
    if (v && parseVersion(v).kind !== "label" && parseVersion(v).kind !== "none") versions.add(v.trim().toLowerCase());
  }
  return [...versions];
}

export function mismatchFlags(a: IdentityRecord, b: IdentityRecord, outcomes: readonly ComparisonOutcome[], ctx: FlagContext = {}): string[] {
  const flags: string[] = [];

  const va = effectiveVersion(a);
  const vb = effectiveVersion(b);
  if (va && vb) {
    const cmp = compareVersions(va, vb);
    if (cmp.relation === "DIFFERENT" || cmp.relation === "SAME_RELEASE_LINE") {
      flags.push(`version-differs: ${va} versus ${vb} (${cmp.reason})`);
    } else if (cmp.relation === "UNKNOWN") {
      flags.push(`version-not-comparable: ${va} versus ${vb} (${cmp.reason})`);
    }
    if (cmp.buildDiffers) flags.push(`build-differs: ${va} versus ${vb}`);
  } else if (va || vb) {
    flags.push(`version-stated-on-one-side-only: ${va ?? vb}`);
  }

  const purpose = outcome(outcomes, "purpose");
  if (purpose?.level === "DISAGREE") flags.push(`intended-use-differs: ${purpose.detail ?? ""}`.trim());
  if (purpose?.level === "PARTIAL") flags.push(`intended-use-partly-differs: ${purpose.detail ?? ""}`.trim());

  const module = outcome(outcomes, "module");
  if (module?.level === "DISAGREE") flags.push(`module-differs: ${module.detail ?? ""}`.trim());

  const mfr = outcome(outcomes, "manufacturer");
  if (mfr?.level === "ALIAS" && a.manufacturer && b.manufacturer) {
    const groups = ctx.aliasGroups ?? MANUFACTURER_ALIAS_GROUPS;
    const group = groups.find((g) => g.id === aliasGroupOf(normaliseManufacturer(a.manufacturer!).key, groups));
    flags.push(`owner-alias-drift: ${a.manufacturer} and ${b.manufacturer}${group ? ` (${group.citation})` : ""}`);
  }
  const nameLevel = outcome(outcomes, "name")?.level;
  if (mfr?.level === "DIFFERENT" && (nameLevel === "EXACT" || nameLevel === "CONTAINS" || nameLevel === "FAMILY_NAME" || nameLevel === "OVERLAP")) {
    flags.push(`same-name-different-company: ${a.manufacturer} versus ${b.manufacturer}`);
  }

  for (const group of PRODUCT_ALIAS_GROUPS) {
    const left = namedMembers(a, group);
    const right = namedMembers(b, group);
    const drift = left.some((x) => right.some((y) => x !== y));
    if (drift) flags.push(`product-name-drift: ${group.names.join(" and ")} (${group.citation})`);
  }

  const name = outcome(outcomes, "name");
  if (name?.level === "FAMILY_NAME") {
    flags.push(`family-name: at least ${FAMILY_NAME_MIN_ROWS} reference rows share this name (${name.detail ?? ""}); the name alone does not identify one product`);
  }
  if (name?.level === "GENERIC_CONTAINS") flags.push(`generic-name-match: only the common word "${name.detail ?? ""}" matched`);

  if (ctx.knownRecords) {
    const shared = new Set<string>();
    for (const sub of [...canonicalSet("submission", a.ids.submission), ...canonicalSet("submission", b.ids.submission)]) shared.add(sub);
    for (const sub of [...shared].sort()) {
      const releases = releasesUnder(sub, [...ctx.knownRecords, a, b]);
      if (releases.length > 1) flags.push(`multiple-releases-under-submission: ${sub} carries ${releases.length} distinct version labels`);
    }
  }
  return [...new Set(flags)];
}
