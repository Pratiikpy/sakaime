import { z } from "zod";

/**
 * The typed vocabulary of the document reader and the checks every extracted fact must pass before it is
 * allowed into the ledger. A model proposes; code verifies that the quote exists on the cited page and that a
 * stated number appears in the quote. Provenance is not truth: a verified quote shows where text came from,
 * not that it supports a claim. The semantic check belongs to the extraction layer that consumes these facts.
 */

export const FACT_FIELDS = [
  "population_inclusion",
  "population_exclusion",
  "age_range",
  "setting",
  "software_version",
  "device_identity",
  "intended_use",
  "operating_threshold",
  "sample_size",
  "subgroup_result",
  "limitation",
  "data_collection_period",
  "comparator",
  "performance_result",
] as const;
export type FactField = (typeof FACT_FIELDS)[number];

/** The checklist the carryover tracks. A group is "found" when any of its fields has a verified fact. */
export const CHECKLIST = [
  { key: "population", fields: ["population_inclusion", "population_exclusion", "age_range"] },
  { key: "setting", fields: ["setting"] },
  { key: "software_version", fields: ["software_version"] },
  { key: "threshold", fields: ["operating_threshold"] },
  { key: "sample_size", fields: ["sample_size"] },
  { key: "subgroup_results", fields: ["subgroup_result"] },
  { key: "limitations", fields: ["limitation"] },
] as const satisfies ReadonlyArray<{ key: string; fields: readonly FactField[] }>;
export type ChecklistKey = (typeof CHECKLIST)[number]["key"];

/** What survives first when the carryover must shrink: restrictions that narrow a verdict come last to go. */
export const FIELD_PRIORITY: readonly FactField[] = [
  "limitation",
  "population_exclusion",
  "age_range",
  "population_inclusion",
  "software_version",
  "setting",
  "operating_threshold",
  "sample_size",
  "subgroup_result",
  "intended_use",
  "device_identity",
  "data_collection_period",
  "comparator",
  "performance_result",
];

export const RELATION_KINDS = ["restates", "narrows", "contradicts"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

const IntLike = z.union([z.number().int().positive(), z.string().regex(/^\d{1,6}$/).transform(Number)]).pipe(z.number().int().positive());
const NumLike = z.union([z.number().finite(), z.string().regex(/^-?\d+(\.\d+)?$/).transform(Number)]).pipe(z.number().finite());

/** Models write null for a field that does not apply; treat it as absent. */
const orAbsent = <T extends z.ZodTypeAny>(schema: T) => z.preprocess((v) => (v === null || v === "" ? undefined : v), schema.optional());

export const RawFactSchema = z.object({
  field: z.enum(FACT_FIELDS),
  value: z.string().trim().min(1).max(400),
  quote: z.string().trim().min(8).max(900),
  page: IntLike,
  number: orAbsent(NumLike),
  unit: orAbsent(z.string().trim().max(32)),
  relates_to: orAbsent(z.object({ fact_id: z.string().regex(/^F\d{1,4}$/), kind: z.enum(RELATION_KINDS) })),
});
export type RawFact = z.infer<typeof RawFactSchema>;

export const RawDefinitionSchema = z.object({
  term: z.string().trim().min(1).max(60),
  meaning: z.string().trim().min(1).max(200),
  quote: z.string().trim().min(8).max(600),
  page: IntLike,
});
export type RawDefinition = z.infer<typeof RawDefinitionSchema>;

/** The JSON Schema sent with each model request. Mirrors RawFactSchema; the reply is validated again in code. */
export const MODEL_OUTPUT_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      maxItems: 30,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["field", "value", "quote", "page"],
        properties: {
          field: { type: "string", enum: [...FACT_FIELDS] },
          value: { type: "string", maxLength: 400 },
          quote: { type: "string", maxLength: 900 },
          page: { type: "integer", minimum: 1 },
          number: { type: "number" },
          unit: { type: "string", maxLength: 32 },
          relates_to: {
            type: "object",
            additionalProperties: false,
            required: ["fact_id", "kind"],
            properties: { fact_id: { type: "string" }, kind: { type: "string", enum: [...RELATION_KINDS] } },
          },
        },
      },
    },
    definitions: {
      type: "array",
      maxItems: 8,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["term", "meaning", "quote", "page"],
        properties: {
          term: { type: "string" },
          meaning: { type: "string" },
          quote: { type: "string" },
          page: { type: "integer", minimum: 1 },
        },
      },
    },
  },
};

// ---------------------------------------------------------------- matching

const ch = (...codes: number[]): string => String.fromCodePoint(...codes);
/** Soft hyphen and the zero-width and direction marks a PDF text layer leaves in words. */
const INVISIBLE = new RegExp(`[${ch(0xad)}${ch(0x200b)}-${ch(0x200f)}${ch(0x2060)}${ch(0xfeff)}]`, "g");
const SINGLE_QUOTES = new RegExp(`[${ch(0x2018, 0x2019, 0x201a, 0x2032)}]`, "g");
const DOUBLE_QUOTES = new RegExp(`[${ch(0x201c, 0x201d, 0x201e, 0x2033)}]`, "g");
const DASHES = new RegExp(`[${ch(0x2010)}-${ch(0x2015)}${ch(0x2212)}]`, "g");

/** Fold typographic variants so that a quote copied from a PDF text layer matches the model's rendering of it. */
export function normaliseForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(INVISIBLE, "")
    .replace(/-\s*\n\s*/g, "")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(DASHES, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * True when the quote exists in the page text. An elided quote ("... ") is accepted when each fragment of at
 * least eight characters appears, in order. Case and whitespace are not significant.
 */
export function quoteExists(pageText: string, quote: string): boolean {
  const hay = normaliseForMatch(pageText);
  const fragments = normaliseForMatch(quote)
    .split(new RegExp(String.raw`\s*(?:\.{3}|${ch(0x2026)})\s*`))
    .map((f) => f.trim())
    .filter((f) => f.length > 0);
  if (fragments.length === 0) return false;
  if (!fragments.some((f) => f.length >= 8)) return false;
  let from = 0;
  for (const f of fragments) {
    if (f.length < 8) continue;
    const at = hay.indexOf(f, from);
    if (at < 0) return false;
    from = at + f.length;
  }
  return true;
}

/** Numbers appearing in a quote, as values: thousands separators removed, "85%" read as 85 and as 0.85. */
export function numbersIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+|\d+)?(\.\d+)?(\s?%)?/g)) {
    if (!m[1] && !m[2]) continue;
    const n = Number(`${(m[1] ?? "").replace(/,/g, "") || "0"}${m[2] ?? ""}`);
    if (!Number.isFinite(n)) continue;
    out.push(n);
    if (m[3]) out.push(n / 100);
  }
  return out;
}

export function numberAppearsIn(text: string, n: number): boolean {
  return numbersIn(text).some((v) => Math.abs(v - n) <= 1e-9 * Math.max(1, Math.abs(n)) || Math.abs(v * 100 - n) <= 1e-9 * Math.max(1, Math.abs(n)));
}

export function normaliseValue(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}.<>=%+-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------- model output parsing

export interface ParsedModelOutput {
  facts: unknown[];
  definitions: unknown[];
  /** True when the reply was cut off and the complete items before the cut were recovered. */
  salvaged: boolean;
}

/** Extract the JSON object from a reply that may be fenced or wrapped in prose. Returns undefined when nothing usable is there. */
export function parseModelOutput(text: string): ParsedModelOutput | undefined {
  const unfenced = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const first = unfenced.indexOf("{");
  const last = unfenced.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      const obj = JSON.parse(unfenced.slice(first, last + 1)) as unknown;
      if (obj && typeof obj === "object" && !Array.isArray(obj)) {
        const o = obj as Record<string, unknown>;
        if (Array.isArray(o.facts)) return { facts: o.facts, definitions: Array.isArray(o.definitions) ? o.definitions : [], salvaged: false };
      }
    } catch {
      // fall through to salvage
    }
  }
  return salvage(unfenced);
}

/** Recover the complete objects of the "facts" array from a reply that stops mid-way. */
function salvage(text: string): ParsedModelOutput | undefined {
  const at = text.search(/"facts"\s*:\s*\[/);
  if (at < 0) return undefined;
  const items: unknown[] = [];
  let i = text.indexOf("[", at) + 1;
  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i] as string)) i++;
    if (text[i] !== "{") break;
    let depth = 0;
    let inStr = false;
    let esc = false;
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j] as string;
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    if (depth !== 0) break;
    try {
      items.push(JSON.parse(text.slice(i, j + 1)));
    } catch {
      break;
    }
    i = j + 1;
  }
  return items.length > 0 ? { facts: items, definitions: [], salvaged: true } : undefined;
}
