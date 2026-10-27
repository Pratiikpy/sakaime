/**
 * Stage 5: semantic and cross-source validation. Deterministic code; no model is consulted.
 *
 * A mapping can be correct in type and wrong in meaning, and the second kind is the one that does damage: a
 * sensitivity that arrives as 93.2 instead of 0.932, an enrolled count that is really the planned count, a column
 * of applicant names filed under device_name. Each canonical field therefore carries an expectation (unit, range,
 * identifier family, meaning) and every proposed mapping is checked against what the sample values and the
 * column's own name and description actually say.
 *
 * Verdicts:
 *   rejected      the evidence contradicts the mapping. It is never registered and never overridden by a reviewer.
 *   needs_review  the evidence neither supports nor contradicts it (a 0..100 scale, a numeric missing-value code,
 *                 an ambiguous day/month order, a meaning no cue settles). A reviewer may accept it.
 *   renamed/ok    every check passed; "renamed" when the column's name is not the canonical id.
 *
 * Unknown is never promoted to ok. A check that could not run (the federation port was down) is recorded as such
 * and, where the mapping depends on it, becomes a hold.
 */
import type { FederationPort } from "../ports/index.ts";
import { ALL_KEY_FIELDS, KEY_FIELDS, canonicalField, leafName, nameTokens, normalName, type CanonicalField, type RecordKind } from "./canonical.ts";
import { CROSS_GROUPS, DEFAULT_ROW_SPECS, agreement, joinRate, type AgreementEvidence, type HoldingsMap, type JoinEvidence, type RowSpecs } from "./holdings.ts";
import { ID_FAMILIES, canonicalise, familiesOf, idFamily, matchesAsWritten } from "./identifiers.ts";
import { nameEvidence, type Proposal } from "./lexical.ts";
import { canonicalTable, normaliseEnum, type AppliedField, type Conversion } from "./normalise.ts";
import type { ProbeTable } from "./tabular.ts";
import { isNullToken, isSentinel, normaliseDate, parseAgeYears, parseNumber, readDateColumn, text, type Cell, type DateFamily } from "./values.ts";

export type Severity = "reject" | "hold" | "note";

export interface Finding {
  rule: string;
  severity: Severity;
  message: string;
  /** For holds: `${rule}#${detail}`, the key a reviewer's acceptance is recorded under. */
  signature?: string;
  data?: Record<string, unknown>;
}

/** What a reviewer (or the memory of an earlier review of the same shape) has already accepted for one column. */
export interface FieldApproval {
  by: string;
  signatures: string[];
  /** The day/month order the reviewer chose for an ambiguous date column. */
  dateFamily?: DateFamily;
  /** The scale the reviewer accepted a proportion column in. */
  representation?: "percent" | "fraction";
}

export type FieldCheck = "ok" | "renamed" | "rejected" | "needs_review";

export interface FieldVerdict {
  sourceField: string;
  canonicalField: string;
  check: FieldCheck;
  reason?: string;
  confidence?: number;
  proposer: Proposal["proposer"];
  unit?: string;
  conversions: Conversion[];
  findings: Finding[];
  join?: JoinEvidence;
  /**
   * A model proposal that the values contradict and that nothing in the source's own wording supports. It says nothing
   * about the source, only that the model guessed; the column is left unmapped and the source is judged without it.
   */
  discarded?: boolean;
}

export interface ValidationContext {
  table: ProbeTable;
  description: string;
  now: Date;
  federation: FederationPort;
  holdings: HoldingsMap;
  joinSample: number;
  expectedJoinRate?: number;
  /** Reviewer or memory approvals, by source field. */
  approvals?: ReadonlyMap<string, FieldApproval>;
  /** Source fields whose name or values tried to instruct the mapper. */
  flagged?: ReadonlyMap<string, string>;
  /** Columns the model and the name matcher map to different canonical fields: column -> the matcher's field. */
  disagreements?: ReadonlyMap<string, string>;
  /** Approved table-level holds, by signature. */
  tableApprovals?: readonly string[];
  /** Where the rest of a held record lives, to compare mapped columns with the record the key finds. */
  rowSpecs?: RowSpecs;
  /** Do not query the federation port (the drift check compares values, not holdings). */
  skipJoin?: boolean;
  /** Hint when the caller knows what the source is. */
  kindHint?: RecordKind;
}

export interface ValidationReport {
  agreement?: AgreementEvidence[];
  kind: RecordKind;
  fields: FieldVerdict[];
  tableFindings: Finding[];
  keyField?: string;
  duplicates: { exact: number; conflicting: number };
  joins: JoinEvidence[];
  /** Source fields the proposal did not map. */
  unmapped: string[];
}

// ---------------------------------------------------------------- collecting findings

class Collector {
  findings: Finding[] = [];
  conversions: Conversion[] = [];
  unit: string | undefined;
  constructor(private readonly approval: FieldApproval | undefined, private readonly approved: readonly string[] = approval?.signatures ?? []) {}

  reject(rule: string, message: string, data?: Record<string, unknown>): void {
    this.findings.push({ rule, severity: "reject", message, ...(data ? { data } : {}) });
  }
  note(rule: string, message: string, data?: Record<string, unknown>): void {
    this.findings.push({ rule, severity: "note", message, ...(data ? { data } : {}) });
  }
  /** A hold a reviewer can accept. If their acceptance covers exactly this signature it becomes a note. */
  hold(rule: string, detail: string, message: string, data?: Record<string, unknown>): void {
    const signature = `${rule}#${detail}`;
    if (this.approved.includes(signature)) this.note(rule, `${message} (accepted by ${this.approval?.by ?? "a reviewer"})`, data);
    else this.findings.push({ rule, severity: "hold", message, signature, ...(data ? { data } : {}) });
  }
  get rejected(): boolean {
    return this.findings.some((f) => f.severity === "reject");
  }
  addConversion(c: Conversion): void {
    if (!this.conversions.some((x) => JSON.stringify(x) === JSON.stringify(c))) this.conversions.push(c);
  }
}

const quote = (v: unknown): string => JSON.stringify(typeof v === "string" ? v.slice(0, 40) : v);
const share = (n: number, d: number): string => `${n} of ${d}`;
const pct = (x: number): string => `${Math.round(x * 100)}%`;

// ---------------------------------------------------------------- numeric fields

function nullCodeConversion(c: Collector, tokens: (string | number)[]): void {
  c.addConversion({ kind: "null_codes", tokens });
}

function checkProportion(cells: Cell[], c: Collector, approval: FieldApproval | undefined): void {
  const parsed = cells.map(parseNumber);
  const bad = cells.filter((_, i) => parsed[i] === null);
  if (bad.length > 0) {
    if (bad.length / cells.length >= 0.5) {
      c.reject("numeric", `${share(bad.length, cells.length)} values are not plain numbers (for example ${quote(bad[0])})`);
      return;
    }
    c.hold("unparseable", String(bad.length), `${share(bad.length, cells.length)} values are not plain numbers (for example ${quote(bad[0])})`);
  }
  const nums = parsed.filter((n): n is NonNullable<typeof n> => n !== null);
  if (nums.some((n) => n.decimalComma)) c.hold("decimal-comma", "decimal-comma", "values use a decimal comma, which another locale reads differently");
  const sentinels = [...new Set(nums.filter((n) => isSentinel(n.value)).map((n) => n.value))].sort((a, b) => a - b);
  if (sentinels.length > 0) {
    c.hold("null-code", `sentinel:${sentinels.join(",")}`, `the value${sentinels.length > 1 ? "s" : ""} ${sentinels.join(", ")} look${sentinels.length > 1 ? "" : "s"} like a missing-value code, not a measurement`);
    nullCodeConversion(c, sentinels);
  }
  const rest = nums.filter((n) => !isSentinel(n.value));
  if (rest.length === 0) {
    c.hold("no-values", "all-missing", "the probe holds no usable values to check");
    return;
  }
  const outside = rest.find((n) => n.value < 0 || n.value > 100);
  if (outside) {
    c.reject("range", `the value ${outside.value} lies outside every proportion scale (0 to 100)`);
    return;
  }
  const values = rest.map((n) => n.value);
  if (values.every((v) => v === 0 || v === 1)) {
    c.hold("binary", "zero-one", "every value is 0 or 1: this looks like a flag, not a rate");
    return;
  }
  const fractional = values.filter((v) => v > 0 && v < 1).length;
  const big = values.filter((v) => v > 1).length;
  if (big > 0 && fractional > 0) {
    if (fractional / values.length >= 0.25 && big / values.length >= 0.25) {
      c.reject("scale-mixed", `the values mix a 0 to 1 scale (${fractional}) and a 0 to 100 scale (${big})`);
      return;
    }
    c.hold("scale-mixed", "minor", `${fractional} value${fractional > 1 ? "s" : ""} below 1 sit among values on a 0 to 100 scale`);
  }
  const percentSign = rest.some((n) => n.percent);
  const representation = percentSign || big > 0 ? "percent" : "fraction";
  const max = Math.max(...values);
  if (representation === "percent") {
    c.hold("scale", "percent", `the values are on a 0 to 100 scale (largest ${max}${percentSign ? ", written with a percent sign" : ""}); the canonical field is a fraction between 0 and 1`);
    c.addConversion({ kind: "percent_to_fraction" });
    c.unit = "percent to fraction";
  } else {
    if (approval?.representation === "percent") {
      c.hold("scale", "changed-to-fraction", "this column was accepted on a 0 to 100 scale but its values now read as fractions between 0 and 1");
    }
    c.unit = "fraction";
  }
}

function checkCount(cells: Cell[], c: Collector, field: CanonicalField): void {
  const parsed = cells.map(parseNumber);
  const bad = cells.filter((_, i) => parsed[i] === null);
  if (bad.length / cells.length >= 0.5) {
    c.reject("numeric", `${share(bad.length, cells.length)} values are not plain numbers (for example ${quote(bad[0])})`);
    return;
  }
  if (bad.length > 0) c.hold("unparseable", String(bad.length), `${share(bad.length, cells.length)} values are not plain numbers (for example ${quote(bad[0])})`);
  const nums = parsed.filter((n): n is NonNullable<typeof n> => n !== null);
  if (nums.some((n) => n.percent)) {
    c.reject("unit", "the values carry a percent sign; a count is not a percentage");
    return;
  }
  if (nums.some((n) => n.decimalComma)) c.hold("decimal-comma", "decimal-comma", "values use a decimal comma, which another locale reads differently");
  const sentinels = [...new Set(nums.filter((n) => isSentinel(n.value)).map((n) => n.value))].sort((a, b) => a - b);
  if (sentinels.length > 0) {
    c.hold("null-code", `sentinel:${sentinels.join(",")}`, `the value${sentinels.length > 1 ? "s" : ""} ${sentinels.join(", ")} look${sentinels.length > 1 ? "" : "s"} like a missing-value code, not a count`);
    nullCodeConversion(c, sentinels);
  }
  const rest = nums.filter((n) => !isSentinel(n.value)).map((n) => n.value);
  if (rest.length === 0) {
    c.hold("no-values", "all-missing", "the probe holds no usable values to check");
    return;
  }
  if (rest.every((v) => v >= 0 && v <= 1) && rest.some((v) => !Number.isInteger(v))) {
    c.reject("unit", "every value lies between 0 and 1 with a fraction part: these are proportions, not counts");
    return;
  }
  const fractional = rest.find((v) => !Number.isInteger(v));
  if (fractional !== undefined) {
    c.reject("integer", `the value ${fractional} is not a whole number; a count is`);
    return;
  }
  const range = field.range ?? { min: 0, max: Number.MAX_SAFE_INTEGER };
  const out = rest.find((v) => v < range.min || v > range.max);
  if (out !== undefined) c.reject("range", `the value ${out} lies outside ${range.min} to ${range.max}`);
  else c.unit = field.unit ?? "count";
}

function checkAge(cells: Cell[], c: Collector, field: CanonicalField): void {
  const ages = cells.map((v) => parseAgeYears(v));
  const bad = cells.filter((_, i) => ages[i] === null);
  if (bad.length / cells.length >= 0.5) {
    c.reject("numeric", `${share(bad.length, cells.length)} values are not ages (for example ${quote(bad[0])})`);
    return;
  }
  if (bad.length > 0) c.hold("unparseable", String(bad.length), `${share(bad.length, cells.length)} values are not ages (for example ${quote(bad[0])})`);
  const nums = ages.filter((n): n is number => n !== null);
  const sentinels = [...new Set(nums.filter((n) => isSentinel(n) || n === 999).map((n) => n))].sort((a, b) => a - b);
  if (sentinels.length > 0) {
    c.hold("null-code", `sentinel:${sentinels.join(",")}`, `the value${sentinels.length > 1 ? "s" : ""} ${sentinels.join(", ")} look${sentinels.length > 1 ? "" : "s"} like a missing-value code, not an age`);
    nullCodeConversion(c, sentinels);
  }
  const rest = nums.filter((n) => !sentinels.includes(n));
  const range = field.range ?? { min: 0, max: 120 };
  const out = rest.find((n) => n < range.min || n > range.max);
  if (out !== undefined) c.reject("range", `the age ${out} lies outside ${range.min} to ${range.max} years`);
  else if (cells.some((v) => typeof v === "string" && /[a-z]/i.test(v))) {
    c.addConversion({ kind: "age_units" });
    c.unit = "years";
  } else c.unit = "years";
}

function checkYear(cells: Cell[], c: Collector, now: Date): void {
  const parsed = cells.map(parseNumber);
  const bad = cells.filter((_, i) => parsed[i] === null || !Number.isInteger(parsed[i]!.value));
  if (bad.length / cells.length >= 0.5) {
    c.reject("numeric", `${share(bad.length, cells.length)} values are not whole years (for example ${quote(bad[0])})`);
    return;
  }
  if (bad.length > 0) c.hold("unparseable", String(bad.length), `${share(bad.length, cells.length)} values are not whole years (for example ${quote(bad[0])})`);
  const years = parsed.filter((n): n is NonNullable<typeof n> => n !== null).map((n) => n.value);
  const sentinels = [...new Set(years.filter((y) => isSentinel(y) || y === 0))].sort((a, b) => a - b);
  if (sentinels.length > 0) {
    c.hold("null-code", `sentinel:${sentinels.join(",")}`, `the value${sentinels.length > 1 ? "s" : ""} ${sentinels.join(", ")} look${sentinels.length > 1 ? "" : "s"} like a missing-value code, not a year`);
    nullCodeConversion(c, sentinels);
  }
  const rest = years.filter((y) => !sentinels.includes(y));
  const out = rest.find((y) => y < 1900 || y > now.getUTCFullYear() + 1);
  if (out !== undefined) c.reject("range", `${out} is not a plausible year (1900 to ${now.getUTCFullYear() + 1}); two-digit years are not accepted`);
  else c.unit = "year";
}

// ---------------------------------------------------------------- dates

function checkDate(values: string[], c: Collector, field: CanonicalField, now: Date, approval: FieldApproval | undefined): void {
  const col = readDateColumn(values, false);
  const unreadable = col.unparseable.length;
  if (unreadable > 0) {
    if (unreadable / values.length >= 0.2) c.reject("date-format", `${share(unreadable, values.length)} values are not dates in a recognised format (for example ${quote(col.unparseable[0])})`);
    else c.hold("unparseable", String(unreadable), `${share(unreadable, values.length)} values are not dates in a recognised format (for example ${quote(col.unparseable[0])})`);
    if (c.rejected) return;
  }
  if (col.impossible.length > 0) {
    c.reject("date-impossible", `${col.impossible.length} value${col.impossible.length > 1 ? "s name" : " names"} a day that does not exist (for example ${quote(col.impossible[0])})`);
    return;
  }
  if (col.mixed) {
    c.reject("date-format", "the values use more than one date format, so no single reading is right for all of them");
    return;
  }
  let family = col.family;
  let normalised = col.normalised;
  if (col.ambiguous) {
    // Re-read under the chosen order only if a reviewer chose one; every value must still be a real date under it.
    const chosen = approval?.dateFamily;
    if (chosen && approval?.signatures.includes("date-ambiguous#dmy|mdy")) {
      const reread = new Map<string, string>();
      const bad: string[] = [];
      for (const v of new Set(values)) {
        const iso = normaliseDate(v, chosen, false);
        if (iso === null) bad.push(v);
        else reread.set(v, iso);
      }
      if (bad.length > 0) {
        c.reject("date-impossible", `under the chosen ${chosen === "dmy" ? "day-first" : "month-first"} order, ${quote(bad[0])} is not a real date`);
        return;
      }
      family = chosen;
      normalised = reread;
      c.note("date-ambiguous", `day and month order chosen by ${approval.by}: ${chosen === "dmy" ? "day first" : "month first"}`);
    } else {
      c.hold("date-ambiguous", "dmy|mdy", "every value could be read day-first or month-first (no day above 12 appears), so the order cannot be determined from the data");
      return;
    }
  }
  if (!family) return;
  if (family !== "iso") {
    c.addConversion({ kind: "date", family });
    c.unit = `date ${family} to ISO`;
  } else c.unit = "ISO date";
  if (col.zoned > 0) c.note("timezone", `${col.zoned} value${col.zoned > 1 ? "s" : ""} carried a UTC offset; the calendar date as written is kept`);
  const win = field.dateWindow;
  if (win) {
    const latest = new Date(Date.UTC(now.getUTCFullYear() + win.futureYears, now.getUTCMonth(), now.getUTCDate())).toISOString().slice(0, 10);
    const outside = [...normalised.values()].find((iso) => iso.slice(0, 10) < win.from.slice(0, iso.length > 7 ? 10 : iso.length) || iso.slice(0, 10) > latest.slice(0, iso.length > 7 ? 10 : iso.length));
    if (outside !== undefined) c.reject("date-range", `the date ${outside} lies outside the plausible window ${win.from} to ${latest}`);
  }
}

// ---------------------------------------------------------------- identifiers and codes

function checkIdentifier(values: string[], c: Collector, field: CanonicalField): { weak: boolean } {
  const family = idFamily(field.id);
  if (!family) return { weak: false };
  const bad: string[] = [];
  let lexical = 0;
  for (const v of values) {
    if (matchesAsWritten(family, v)) continue;
    if (canonicalise(family, v) !== null) {
      lexical += 1;
      continue;
    }
    bad.push(v);
  }
  if (bad.length > 0) {
    const others = new Map<string, number>();
    for (const v of bad) for (const f of familiesOf(v)) if (f !== field.id) others.set(f, (others.get(f) ?? 0) + 1);
    const [topFamily, topCount] = [...others.entries()].sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
    if (topFamily && topCount / values.length >= 0.9) {
      c.reject("id-family", `the values are ${topFamily} identifiers, not ${field.id} (for example ${quote(bad[0])})`);
      return { weak: family.weak };
    }
    const fraction = bad.length / values.length;
    if (fraction > 0.05) {
      c.reject("id-pattern", `${share(bad.length, values.length)} values are not a valid ${field.id} (for example ${quote(bad[0])})`);
      return { weak: family.weak };
    }
    c.hold("id-pattern", String(bad.length), `${share(bad.length, values.length)} values are not a valid ${field.id} (for example ${quote(bad[0])})`);
  }
  if (lexical > 0) {
    c.addConversion({ kind: "identifier", family: field.id });
    c.note("id-format", `${share(lexical, values.length)} values were written with different case, spacing or a URL around the identifier and were normalised`);
  }
  return { weak: family.weak };
}

// ---------------------------------------------------------------- text, enum, version, meaning

function medianLength(values: string[]): number {
  const lens = values.map((v) => v.length).sort((a, b) => a - b);
  return lens[Math.floor(lens.length / 2)] ?? 0;
}

function checkText(values: string[], c: Collector, field: CanonicalField): void {
  const numeric = values.filter((v) => parseNumber(v) !== null).length;
  if (numeric / values.length > 0.8) {
    c.reject("text-shape", `${share(numeric, values.length)} values are numbers; ${field.id} holds names or titles`);
    return;
  }
  const idLike = values.filter((v) => ID_FAMILIES.some((f) => !f.weak && matchesAsWritten(f, v))).length;
  if (idLike / values.length > 0.8) {
    c.reject("text-shape", `${share(idLike, values.length)} values are identifiers; ${field.id} holds names or titles`);
    return;
  }
  if (field.type === "text" && medianLength(values) > 400) c.hold("text-length", "long", "the values are paragraphs, not a name or a title");
}

function checkEnum(values: string[], c: Collector, field: CanonicalField): void {
  const allowed = new Set(field.values ?? []);
  const normalised = values.map((v) => normaliseEnum(field.id, v));
  const unknown = [...new Set(normalised.filter((v) => !allowed.has(v)))];
  if (unknown.length === 0) {
    if (values.some((v, i) => v !== normalised[i])) c.addConversion({ kind: "enum_case" });
    return;
  }
  const known = normalised.filter((v) => allowed.has(v)).length;
  if (known / values.length >= 0.8) c.hold("enum-values", unknown.slice(0, 3).join("|"), `${unknown.length} value${unknown.length > 1 ? "s are" : " is"} not in the allowed set (for example ${quote(unknown[0])})`);
  else c.reject("enum-values", `${share(values.length - known, values.length)} values are not ${field.id} values (for example ${quote(unknown[0])})`);
}

function checkVersion(values: string[], c: Collector): void {
  const bad = values.filter((v) => !/^v?\d+(\.\d+){0,3}([-+][\w.]+)?$/i.test(v.trim()));
  if (bad.length / values.length > 0.05) c.reject("version-shape", `${share(bad.length, values.length)} values are not version numbers (for example ${quote(bad[0])})`);
  else if (bad.length > 0) c.hold("version-shape", String(bad.length), `${share(bad.length, values.length)} values are not version numbers (for example ${quote(bad[0])})`);
}

/** The clause of the description that talks about this column, if it names it. */
function localDescription(sourceField: string, description: string): string | undefined {
  const d = normalName(description);
  const leaf = nameTokens(leafName(sourceField)).join(" ");
  if (leaf.length < 3) return undefined;
  // Name tokens are letters and digits, so the phrase needs no escaping; the spaces make it match whole words.
  const found = new RegExp(`(^| )${leaf}( |$)`).exec(d);
  if (!found) return undefined;
  const at = found.index + found[1]!.length;
  // What follows the mention up to a negation ("not who was enrolled") describes something else.
  const after = d.slice(at, at + leaf.length + 80).split(/ (?:not|rather than|as opposed to|instead of|unlike|excluding) /)[0]!;
  return d.slice(Math.max(0, at - 40), at) + after;
}

function checkMeaning(field: CanonicalField, sourceField: string, description: string, values: string[], c: Collector): void {
  const m = field.meaning;
  if (!m) return;
  const path = nameTokens(sourceField).join(" ");
  const local = localDescription(sourceField, description);
  const headerSelf = m.header.test(path);
  const headerContrary = m.contrary.test(path);
  const descSelf = local ? m.header.test(local) : false;
  const descContrary = local ? m.contrary.test(local) : false;
  let selfRate = 0;
  let contraryRate = 0;
  if (m.valueSelf && m.valueContrary && values.length > 0) {
    selfRate = values.filter((v) => m.valueSelf!.test(v)).length / values.length;
    contraryRate = values.filter((v) => m.valueContrary!.test(v)).length / values.length;
  }
  const valueContrary = contraryRate >= 0.4 && contraryRate > selfRate;
  const valueSelf = selfRate >= 0.4 && selfRate > contraryRate;
  const contrary = headerContrary || descContrary || valueContrary;
  const self = headerSelf || descSelf || valueSelf;
  const why = headerContrary ? `its name "${sourceField}"` : descContrary ? "the description" : "its values";
  if (m.contraryIsQualifier && (headerContrary || descContrary)) {
    c.reject("meaning", `${headerContrary ? `its name "${sourceField}"` : "the description"} marks it as ${m.confusableWith}, which is a different quantity from ${field.id}`);
  } else if (headerContrary && !headerSelf) {
    c.reject("meaning", `${why} reads as ${m.confusableWith}, which is a different quantity from ${field.id}`);
  } else if (contrary && !self) {
    c.reject("meaning", `${why} reads as ${m.confusableWith}, which is a different quantity from ${field.id}`);
  } else if (contrary && self) {
    c.hold("meaning", "conflict", `the name, description and values point to both ${field.id} and ${m.confusableWith}`);
  } else if (!self) {
    c.hold("meaning", "no-cue", `nothing in the name, the description or the values says whether this is ${field.id} or ${m.confusableWith}`);
  }
}

// ---------------------------------------------------------------- join evidence

interface JoinSummary {
  own?: JoinEvidence;
  cross: JoinEvidence[];
  unavailable?: string;
}

async function gatherJoin(ctx: ValidationContext, field: CanonicalField, canonicalValues: string[]): Promise<JoinSummary> {
  const own = await joinRate(ctx.federation, field.id, canonicalValues, ctx.holdings, ctx.joinSample);
  if (!own.ok) return { cross: [], unavailable: `${own.failure}: ${own.message}` };
  const summary: JoinSummary = { own: own.evidence, cross: [] };
  if (own.evidence.rate < 0.2) {
    const group = CROSS_GROUPS.find((g) => g.includes(field.id)) ?? [];
    for (const other of group) {
      if (other === field.id || !ctx.holdings[other]) continue;
      const r = await joinRate(ctx.federation, other, canonicalValues, ctx.holdings, ctx.joinSample);
      if (r.ok) summary.cross.push({ ...r.evidence, field: other });
    }
  }
  return summary;
}

function judgeJoin(join: JoinSummary, field: CanonicalField, expected: number | undefined, c: Collector, mustCorroborate: boolean): void {
  if (join.unavailable) {
    if (expected !== undefined || mustCorroborate) c.hold("join-unavailable", join.unavailable.split(":")[0] ?? "unavailable", `the sample could not be checked against the records we hold (${join.unavailable})`);
    else c.note("join-unavailable", `the sample could not be checked against the records we hold (${join.unavailable})`);
    return;
  }
  const own = join.own!;
  if (own.checked === 0) return;
  const best = [...join.cross].sort((a, b) => b.rate - a.rate)[0];
  const t = `${own.target.database}.${own.target.table}.${own.target.column}`;
  const summary = `${own.matched} of ${own.checked} distinct values join to ${t}`;
  if (best && best.rate >= 0.5 && own.rate < best.rate / 2) {
    c.reject("join-other-field", `${summary}, but ${best.matched} of ${best.checked} join to ${best.field} (${best.target.database}.${best.target.table}.${best.target.column}): the values are ${best.field}, not ${field.id}`, { own: own.rate, other: best.field, otherRate: best.rate });
    return;
  }
  c.note("join", expected !== undefined ? `${summary} (the source as a whole is expected to overlap by at least ${pct(expected)})` : summary, { rate: own.rate });
}

// ---------------------------------------------------------------- one field

const CORROBORATED_TYPES: ReadonlySet<CanonicalField["type"]> = new Set(["text", "date", "year", "proportion", "age_years", "count", "version", "meaning_text"]);

async function validateField(ctx: ValidationContext, p: Proposal): Promise<FieldVerdict> {
  const field = canonicalField(p.canonicalField)!;
  const approval = ctx.approvals?.get(p.sourceField);
  const c = new Collector(approval);
  const column = ctx.table.rows.map((r) => (r[p.sourceField] ?? null) as Cell);
  const present = column.filter((v) => !isNullToken(v));
  const strings = present.map(text);
  let join: JoinEvidence | undefined;

  const injected = ctx.flagged?.get(p.sourceField);
  if (injected) c.hold("injection", "source-text", `text in this column's name or values tried to instruct the mapper (${injected}); it was treated as data`);

  const disagree = ctx.disagreements?.get(p.sourceField);
  if (disagree && disagree !== p.canonicalField) c.hold("proposer-disagreement", `${p.canonicalField}!=${disagree}`, `the model maps this column to ${p.canonicalField}, but its name is a known name for ${disagree}`);

  const textNulls = [...new Set(column.filter((v): v is string => typeof v === "string" && v.trim() !== "" && isNullToken(v)))];
  if (textNulls.length > 0) {
    nullCodeConversion(c, textNulls);
    c.note("null-code", `the missing-value code${textNulls.length > 1 ? "s" : ""} ${textNulls.map((t) => quote(t)).join(", ")} ${textNulls.length > 1 ? "were" : "was"} read as empty`);
  }

  if (present.length === 0) {
    c.hold("no-values", "all-missing", "the probe holds no values for this column, so the mapping cannot be checked");
  } else {
    switch (field.type) {
      case "proportion":
        checkProportion(present, c, approval);
        break;
      case "count":
        checkCount(present, c, field);
        break;
      case "age_years":
        checkAge(present, c, field);
        break;
      case "year":
        checkYear(present, c, ctx.now);
        break;
      case "date":
        checkDate(strings, c, field, ctx.now, approval);
        break;
      case "identifier":
      case "code": {
        const { weak } = checkIdentifier(strings, c, field);
        if (!c.rejected) {
          const canonical = strings.map((v) => canonicalise(idFamily(field.id)!, v)).filter((v): v is string => v !== null);
          if (ctx.holdings[field.id] && !ctx.skipJoin) {
            const j = await gatherJoin(ctx, field, canonical);
            join = j.own;
            judgeJoin(j, field, ctx.expectedJoinRate, c, weak);
          } else if (weak && p.proposer !== "memory") {
            c.hold("weak-id", "no-evidence", "a bare number is weak evidence of an identifier and there are no held records to check it against");
          }
          const evidence = nameEvidence(field.id, p.sourceField, ctx.description);
          if (weak && evidence === "none" && !(join && join.rate > 0) && p.proposer !== "memory" && !c.findings.some((f) => f.rule === "weak-id")) {
            c.hold("weak-id", "no-evidence", "a bare run of digits could be many things; neither the column name nor a join to held records says these are PubMed identifiers");
          }
        }
        break;
      }
      case "text":
      case "meaning_text": {
        checkText(strings, c, field);
        if (!c.rejected && ctx.holdings[field.id] && !ctx.skipJoin) {
          const j = await gatherJoin(ctx, field, strings);
          join = j.own;
          judgeJoin(j, field, undefined, c, false);
        }
        break;
      }
      case "enum":
        checkEnum(strings, c, field);
        break;
      case "version":
        checkVersion(strings, c);
        break;
    }
    if (!c.rejected && field.type === "meaning_text") checkMeaning(field, p.sourceField, ctx.description, strings, c);
    if (!c.rejected && field.type === "count" && field.meaning) checkMeaning(field, p.sourceField, ctx.description, strings, c);
  }

  // A value-only check cannot tell sensitivity from specificity or a decision date from a received date. Something
  // else has to: the column's name, what the description says about it, or the records we hold.
  if (!c.rejected && CORROBORATED_TYPES.has(field.type) && !field.meaning) {
    const evidence = nameEvidence(field.id, p.sourceField, ctx.description);
    const joined = join !== undefined && join.rate >= 0.3;
    if (evidence === "none" && !joined && p.proposer !== "memory") {
      c.hold("uncorroborated", "name", `the name "${p.sourceField}" and the description do not say this column is ${field.id}; the values alone cannot tell it from a similar field`);
    }
  }

  const hasReject = c.findings.some((f) => f.severity === "reject");
  const holds = c.findings.filter((f) => f.severity === "hold");
  const check: FieldCheck = hasReject ? "rejected" : holds.length > 0 ? "needs_review" : normalName(leafName(p.sourceField)) === normalName(p.canonicalField) ? "ok" : "renamed";
  const lead = c.findings.find((f) => f.severity === "reject") ?? holds[0];
  const discarded = hasReject && p.proposer === "model" && nameEvidence(p.canonicalField, p.sourceField, ctx.description) === "none";
  return {
    sourceField: p.sourceField,
    canonicalField: p.canonicalField,
    check,
    ...(lead ? { reason: lead.message } : c.findings.find((f) => f.severity === "note") ? { reason: c.findings.find((f) => f.severity === "note")!.message } : {}),
    confidence: p.confidence,
    proposer: p.proposer,
    ...(c.unit ? { unit: c.unit } : {}),
    conversions: c.conversions,
    findings: c.findings,
    ...(join ? { join } : {}),
    ...(discarded ? { discarded } : {}),
  };
}

// ---------------------------------------------------------------- the table

/** Recompute a verdict's check and reason from its findings. */
function settle(v: FieldVerdict): void {
  const reject = v.findings.find((f) => f.severity === "reject");
  const hold = v.findings.find((f) => f.severity === "hold");
  const note = v.findings.find((f) => f.severity === "note");
  v.check = reject ? "rejected" : hold ? "needs_review" : normalName(leafName(v.sourceField)) === normalName(v.canonicalField) ? "ok" : "renamed";
  const lead = reject ?? hold ?? note;
  if (lead) v.reason = lead.message;
  else delete v.reason;
}

/** The canonical field a rejection's own evidence points to, when it names one. */
function alternativeFor(v: FieldVerdict): string | undefined {
  const finding = v.findings.find((f) => f.severity === "reject");
  if (!finding) return undefined;
  if (finding.rule === "meaning") {
    const partner = canonicalField(v.canonicalField)?.meaning?.confusableWith;
    return partner && canonicalField(partner) ? partner : undefined;
  }
  if (finding.rule === "join-other-field") {
    const other = finding.data?.["other"];
    return typeof other === "string" && canonicalField(other) ? other : undefined;
  }
  if (finding.rule === "id-family") {
    const m = /are (\w+) identifiers/.exec(finding.message);
    return m && canonicalField(m[1]!) ? m[1] : undefined;
  }
  return undefined;
}

function inferKind(fields: FieldVerdict[], hint: RecordKind | undefined): RecordKind {
  const usable = fields.filter((f) => f.check !== "rejected").map((f) => canonicalField(f.canonicalField)!);
  if (usable.some((f) => f.home === "performance")) return "performance";
  if (hint && usable.some((f) => f.home === hint)) return hint;
  const counts = new Map<RecordKind, number>();
  // The identifier that keys the records says what they are; a title or a date only agrees with it.
  for (const f of usable) counts.set(f.home, (counts.get(f.home) ?? 0) + (ALL_KEY_FIELDS.includes(f.id) ? 10 : 1));
  const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : (hint ?? "authorization");
}

/**
 * The columns of rows that join on a key, compared with the held record for that key. A column that disagrees on most
 * rows is held: the source may be newer than what we hold, or the column may not be what its name says.
 */
async function checkAgreement(ctx: ValidationContext, fields: FieldVerdict[]): Promise<AgreementEvidence[]> {
  if (ctx.skipJoin) return [];
  const specs = ctx.rowSpecs ?? DEFAULT_ROW_SPECS;
  const usable = fields.filter((f) => f.check !== "rejected");
  const keyField = ALL_KEY_FIELDS.find((k) => specs[k] && usable.some((f) => f.canonicalField === k));
  if (!keyField) return [];
  const spec = specs[keyField]!;
  const canonical = canonicalTable(ctx.table, appliedOf(fields));
  const out = await agreement(ctx.federation, spec, keyField, canonical, ctx.joinSample);
  if (!Array.isArray(out)) return [];
  for (const e of out) {
    const verdict = usable.find((f) => f.canonicalField === e.field);
    if (!verdict || e.compared < 3) continue;
    const what = `${e.agreed} of ${e.compared} rows that join on ${keyField} agree with the held ${spec.table}.${e.column}`;
    if (e.rate >= 0.5) {
      verdict.findings.push({ rule: "agreement", severity: "note", message: what });
      continue;
    }
    const sig = `held-record-disagreement#${e.field}`;
    const approved = ctx.approvals?.get(verdict.sourceField)?.signatures.includes(sig);
    verdict.findings.push({
      rule: "held-record-disagreement",
      severity: approved ? "note" : "hold",
      message: `${what}${e.example ? ` (for ${e.example.key} the source says ${JSON.stringify(e.example.source)} and the held record says ${JSON.stringify(e.example.held)})` : ""}; the source may be newer, or this column is not what its name says`,
      signature: sig,
    });
    settle(verdict);
  }
  return out;
}

function appliedOf(fields: FieldVerdict[]): AppliedField[] {
  return fields.filter((f) => f.check !== "rejected").map((f) => ({ sourceField: f.sourceField, canonicalField: f.canonicalField, conversions: f.conversions }));
}

export async function validateMapping(ctx: ValidationContext, proposals: readonly Proposal[]): Promise<ValidationReport> {
  const unique: Proposal[] = [];
  const seenSource = new Set<string>();
  for (const p of proposals) {
    if (seenSource.has(p.sourceField) || !canonicalField(p.canonicalField) || !ctx.table.columns.includes(p.sourceField)) continue;
    seenSource.add(p.sourceField);
    unique.push(p);
  }
  const fields: FieldVerdict[] = [];
  for (const p of unique) fields.push(await validateField(ctx, p));

  // A rejection that names the field the evidence points to is tried once as that field, and checked like any other
  // mapping. The model mixed up two neighbours (a target and a study population); the checks, not the model, decide
  // whether the neighbour is right. If it is not, the original rejection stands.
  for (let i = 0; i < fields.length; i += 1) {
    const rejected = fields[i]!;
    if (rejected.check !== "rejected" || rejected.proposer === "repair") continue;
    const alternative = alternativeFor(rejected);
    if (!alternative || fields.some((f) => f !== rejected && f.check !== "rejected" && f.canonicalField === alternative)) continue;
    const retry = await validateField(ctx, { sourceField: rejected.sourceField, canonicalField: alternative, confidence: rejected.confidence ?? 0.5, proposer: "repair" });
    if (retry.check === "rejected") continue;
    // The name supports the original field and the values support the alternative: the source contradicts itself, and a
    // person decides which half to believe. The identifier case is the exception worth keeping: a family is a pattern.
    if (nameEvidence(rejected.canonicalField, rejected.sourceField, ctx.description) !== "none" && nameEvidence(alternative, rejected.sourceField, ctx.description) === "none") {
      const sig = `repair-conflict#${rejected.canonicalField}>${alternative}`;
      const approved = ctx.approvals?.get(rejected.sourceField)?.signatures.includes(sig);
      retry.findings.push({ rule: "repair-conflict", severity: approved ? "note" : "hold", message: `the name "${rejected.sourceField}" says ${rejected.canonicalField} but the values read as ${alternative}`, signature: sig });
      if (!approved) {
        retry.check = "needs_review";
        retry.reason = `the name "${rejected.sourceField}" says ${rejected.canonicalField} but the values read as ${alternative}`;
      }
    }
    retry.findings.unshift({ rule: "repair", severity: "note", message: `the model proposed ${rejected.canonicalField}, which the evidence contradicts (${rejected.reason}); ${alternative} was checked instead and holds up` });
    if (retry.check !== "needs_review") retry.reason = retry.findings[0]!.message;
    fields[i] = retry;
  }

  // Two columns claiming one canonical field: neither can be trusted without a person choosing.
  const byTarget = new Map<string, FieldVerdict[]>();
  for (const v of fields) if (v.check !== "rejected") byTarget.set(v.canonicalField, [...(byTarget.get(v.canonicalField) ?? []), v]);
  for (const [target, list] of byTarget) {
    if (list.length < 2) continue;
    for (const v of list) {
      const approved = ctx.approvals?.get(v.sourceField)?.signatures.includes(`duplicate-target#${target}`);
      const f: Finding = { rule: "duplicate-target", severity: approved ? "note" : "hold", message: `${list.map((x) => `"${x.sourceField}"`).join(" and ")} are both proposed as ${target}`, signature: `duplicate-target#${target}` };
      v.findings.push(f);
      if (!approved && v.check !== "needs_review") {
        v.check = "needs_review";
        v.reason = f.message;
      }
    }
  }

  const kind = inferKind(fields, ctx.kindHint);
  // A title column in a table whose kind is known: the title of that kind of record, when nothing else is held against it.
  for (const v of fields) {
    if (v.check !== "needs_review") continue;
    const canon = canonicalField(v.canonicalField)!;
    const holds = v.findings.filter((f) => f.severity === "hold");
    if (!canon.contextHead || canon.home !== kind || holds.some((f) => f.rule !== "uncorroborated")) continue;
    if (!nameTokens(leafName(v.sourceField)).includes(canon.contextHead)) continue;
    v.findings = v.findings.map((f) => (f.rule === "uncorroborated" ? { rule: f.rule, severity: "note" as const, message: `the ${canon.contextHead} column of a ${kind} source` } : f));
    settle(v);
  }
  const tableFindings: Finding[] = [];
  const agreements = await checkAgreement(ctx, fields);
  const keys = KEY_FIELDS[kind];
  const keyField = keys.find((k) => fields.some((f) => f.canonicalField === k && f.check !== "rejected"));
  if (!keyField) {
    tableFindings.push({ rule: "no-key", severity: "reject", message: `no usable identifier was mapped (a ${kind} source needs one of ${keys.join(", ")}), so its rows cannot be joined to anything` });
  }

  if (ctx.table.terminated === false && ctx.table.format === "csv") {
    const sig = "csv-unterminated#cut";
    const approved = ctx.tableApprovals?.includes(sig);
    tableFindings.push({
      rule: "csv-unterminated",
      severity: approved ? "note" : "hold",
      message: "the file does not end with a line break, which is how a cut-off export looks (a cut that falls inside the last field leaves every row the right width); a person confirms it is complete",
      signature: sig,
    });
  }

  // The overlap the requester declared is a property of the source: at least one identifier must reach it.
  const expected = ctx.expectedJoinRate;
  const keyJoins = fields.filter((f) => f.check !== "rejected" && f.join && f.join.checked > 0 && ALL_KEY_FIELDS.includes(f.canonicalField));
  if (expected !== undefined && keyJoins.length > 0) {
    const best = keyJoins.reduce((x, y) => (y.join!.rate > x.join!.rate ? y : x));
    const rate = best.join!.rate;
    const what = `${best.join!.matched} of ${best.join!.checked} distinct ${best.canonicalField} values join to held records`;
    if (rate >= expected) tableFindings.push({ rule: "join", severity: "note", message: `${what} (expected at least ${pct(expected)})` });
    else if (rate === 0 && expected >= 0.5) tableFindings.push({ rule: "join-expected", severity: "reject", message: `${what}; the source was expected to overlap held records by at least ${pct(expected)}` });
    else {
      const sig = `join-low#${pct(rate)}`;
      const approved = ctx.tableApprovals?.includes(sig);
      tableFindings.push({ rule: "join-low", severity: approved ? "note" : "hold", message: `${what}, below the expected ${pct(expected)}`, signature: sig });
    }
  }

  // Duplicates: exact repeats are dropped and counted; one key with different contents is a conflict for a person.
  let conflicting = 0;
  let exact = 0;
  if (keyField && fields.length > 0) {
    const applied = appliedOf(fields);
    const full = canonicalTable(ctx.table, applied);
    exact = full.exactDuplicatesDropped;
    if (kind !== "performance") {
      const at = full.columns.indexOf(keyField);
      const seen = new Map<string, number>();
      for (const row of full.rows) {
        const k = row[at];
        if (k === null || k === undefined) continue;
        seen.set(k, (seen.get(k) ?? 0) + 1);
      }
      conflicting = [...seen.values()].filter((n) => n > 1).length;
      if (conflicting > 0) {
        const sig = `duplicate-key#${conflicting}`;
        const approved = ctx.tableApprovals?.includes(sig);
        tableFindings.push({
          rule: "duplicate-key",
          severity: approved ? "note" : "hold",
          message: `${conflicting} ${keyField} value${conflicting > 1 ? "s appear" : " appears"} on more than one record with different contents; a person must say which record is authoritative`,
          signature: sig,
        });
      }
    }
    if (exact > 0) tableFindings.push({ rule: "duplicate-rows", severity: "note", message: `${exact} exact duplicate record${exact > 1 ? "s were" : " was"} kept once` });
  }

  const joins = fields.map((f) => f.join).filter((j): j is JoinEvidence => j !== undefined);
  const mapped = new Set(fields.map((f) => f.sourceField));
  return {
    kind,
    fields,
    tableFindings,
    ...(agreements.length ? { agreement: agreements } : {}),
    ...(keyField ? { keyField } : {}),
    duplicates: { exact, conflicting },
    joins,
    unmapped: ctx.table.columns.filter((c) => !mapped.has(c)),
  };
}

export type { Proposal };
