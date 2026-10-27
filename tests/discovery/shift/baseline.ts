/**
 * The comparison arm: a hardcoded extraction, written the way a team writes one for a source it knows. It expects the base
 * layout's field names, casts each value to the type its name implies, and fails the load on a missing field or a value that
 * will not cast. It has no semantic checks: a fraction that turns into a percentage, a missing-value code or a swapped
 * meaning loads without a word. This is the "hardcoded ETL" of docs/02-architecture.md section 5.
 */
import { parse } from "csv-parse/sync";
import type { Label } from "./score.ts";

type Kind = "text" | "id" | "date" | "float" | "int" | "year";

const SCHEMAS: Record<string, Record<string, Kind>> = {
  A: { k_number: "id", device_name: "text", applicant: "text", product_code: "text", decision_date: "date", device_class: "text" },
  B: { nct_id: "id", brief_title: "text", overall_status: "text", enrollment_count: "int", start_date: "date", minimum_age_years: "int", eligibility_summary: "text" },
  C: { pmid: "id", pub_year: "year", sensitivity: "float", specificity: "float", nct_id: "text" },
  D: { pmid: "id", doi: "text", pub_year: "year", title: "text" },
};

const NULLS = new Set(["", "NA", "N/A", "null", "NULL", "-"]);

function records(text: string): Record<string, unknown>[] {
  const t = text.trimStart();
  if (t.startsWith("[")) return JSON.parse(text) as Record<string, unknown>[];
  if (t.startsWith("{")) {
    try {
      const root = JSON.parse(text) as Record<string, unknown>;
      const rows = (root["results"] ?? root["data"] ?? root["records"]) as Record<string, unknown>[] | undefined;
      if (!rows) throw new Error("no results array");
      return rows;
    } catch (e) {
      if (text.split("\n").filter(Boolean).length > 1 && text.split("\n").filter(Boolean).every((l) => l.startsWith("{"))) return text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
      throw e;
    }
  }
  return parse(text, { columns: true, skip_empty_lines: true }) as Record<string, unknown>[];
}

function cast(value: unknown, kind: Kind): boolean {
  const s = value === null || value === undefined ? "" : String(value).trim();
  if (NULLS.has(s)) return true;
  switch (kind) {
    case "text":
    case "id":
      return true;
    case "float":
      return Number.isFinite(Number(s));
    case "int":
    case "year":
      return /^-?\d+$/.test(s);
    case "date":
      return /^\d{4}-\d{2}(-\d{2})?$/.test(s) && !Number.isNaN(Date.parse(s.length === 7 ? `${s}-01` : s));
  }
}

/** mapped if the load succeeds, declined if it throws. The baseline never holds anything for a person. */
export function hardcodedEtl(cluster: string, text: string): { label: Label; reason?: string } {
  const schema = SCHEMAS[cluster]!;
  let rows: Record<string, unknown>[];
  try {
    rows = records(text);
  } catch (e) {
    return { label: "declined", reason: `the file could not be read: ${(e as Error).message.slice(0, 80)}` };
  }
  if (rows.length === 0) return { label: "declined", reason: "no rows" };
  for (const name of Object.keys(schema)) {
    if (!(name in rows[0]!)) return { label: "declined", reason: `field ${name} is missing` };
  }
  for (const [name, kind] of Object.entries(schema)) {
    for (const row of rows) {
      if (!cast(row[name], kind)) return { label: "declined", reason: `${name}: ${JSON.stringify(row[name])} does not cast` };
    }
  }
  return { label: "mapped" };
}
