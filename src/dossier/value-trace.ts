/**
 * Ties an extracted assertion's value and unit to the passage it is anchored to (verifier check `assertions.values`).
 *
 * A dossier stores each assertion next to a verbatim quote. The quote check proves the quote is in the stored record; it
 * says nothing about whether the assertion's `value` came from that quote. Without this tie, someone holding the signing
 * key can change a product code (SESE to DENG) or a sample size (90 to 9000), re-sign, and every hash, the signature and
 * the quote check still pass. Here the value must be visible in the quote, by the rule that fits its predicate:
 *
 *   - a number is one of the numbers printed in the quote (a proportion also as its percentage; a count also as a word up
 *     to twenty, which is what the extractor accepts), or the age bound the quote states (summariseAge, so "subjects 21
 *     years old or younger" gives 22), or a registry age ("6 Months" gives 0.5), or, for a counted list, the line count;
 *   - a controlled term (setting, purpose, population group) is a term whose lexicon pattern matches the quote;
 *   - a date is the date in any ordinary rendering (ISO, "August 3, 2020", "2021-Nov-01", 8/3/2020);
 *   - any other string is in the quote after the same whitespace, dash, quote and ligature normalisation the quote check
 *     applies, ignoring case;
 *   - a list is held to this for each of its strings; a boolean has no text form and is not checked.
 *   - two extractor outputs are not quotations and have their own rule: `indication.purpose_exclusion` is the fixed word
 *     "diagnosis" and the quote must be a sentence that excludes diagnostic use (the extractor's own test), and
 *     `study.device_mix` is a vendor name followed by a percentage, each of which must be in the quote.
 *
 * For the extractor's own assertions (structured and pattern) the unit must be one it can emit (a counted thing it knows,
 * years, or proportion), and a counted unit read from running text must also be a word of the quote. A proportion must lie
 * between 0 and 1 whatever the method.
 *
 * This is a consistency check on stored data, not a re-extraction: it never decides whether the value is the right
 * reading of the quote, only that it is not invented. With a demo key it cannot establish who made the quote either; see
 * the verifier's notes on signers.
 */
import { parseAgeBounds, parseRegistryAge, summariseAge } from "../extraction/age.ts";
import { parseNumberToken } from "../extraction/document.ts";
import { TERM_PREDICATES } from "../extraction/lexicon.ts";
import { buildKey, numericTokens } from "../extraction/normalize.ts";
import { diagnosticExclusion } from "../extraction/population.ts";
import { unitClass } from "../extraction/support.ts";

export interface TracedAssertion {
  predicate: string;
  value: string | number | boolean | string[];
  unit?: string | undefined;
  extractionMethod: string;
}

const NUMBER_WORDS = ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const NON_COUNT_UNITS = new Set(["years", "proportion"]);

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const key = (s: string): string => buildKey(s).key.toLowerCase();

function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

function numberInText(value: number, text: string): boolean {
  const printed = numericTokens(text).map(parseNumberToken);
  if (printed.some((p) => closeTo(p, value))) return true;
  // a proportion is printed as a percentage ("0.912" for "91.2%"); the reverse is not accepted for counts
  if (value >= 0 && value <= 1 && printed.some((p) => closeTo(p, value * 100))) return true;
  if (Number.isInteger(value) && value >= 1 && value <= 20) return new RegExp(String.raw`\b${NUMBER_WORDS[value - 1]}\b`, "i").test(text);
  return false;
}

function dateInText(value: string, text: string): boolean {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(value);
  if (!m) return false;
  const [, y, mm, dd] = m as unknown as [string, string, string, string | undefined];
  const month = Number(mm);
  if (month < 1 || month > 12) return false;
  const name = MONTHS[month - 1] as string;
  const names = `(?:${name}|${name.slice(0, 3)}\\.?)`;
  const day = dd === undefined ? undefined : String(Number(dd));
  const forms: string[] = [escapeRe(value)];
  if (day === undefined) {
    forms.push(`${names}\\s+${y}`, `${y}[-/ ]${names}`);
  } else {
    const d0 = `0?${day}`;
    forms.push(
      `${names}\\s+${d0}(?:st|nd|rd|th)?,?\\s+${y}`,
      `${d0}(?:st|nd|rd|th)?\\s+${names},?\\s+${y}`,
      `${y}[-/ ]${names}[-/ ]${d0}`,
      `0?${month}/${d0}/${y}`,
      `${d0}/0?${month}/${y}`,
      `${y}/0?${month}/${d0}`,
      `${y}${mm}${dd}`,
    );
  }
  return new RegExp(`(?<![\\d])(?:${forms.join("|")})(?![\\d])`, "i").test(text);
}

function stringInText(value: string, text: string): boolean {
  const k = key(value);
  return k.length > 0 && key(text).includes(k);
}

function numberProblem(a: TracedAssertion, value: number, text: string): string | undefined {
  if (!Number.isFinite(value)) return "the value is not a finite number";
  if (a.predicate === "study.site_count" && a.extractionMethod === "structured") {
    // The registry's location list is quoted whole, one site per line, and the count is the number of lines.
    const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "").length;
    return lines === value ? undefined : `the quoted location list has ${lines} line${lines === 1 ? "" : "s"}, not ${value}`;
  }
  if (numberInText(value, text)) return undefined;
  if (a.predicate === "population.age_min" || a.predicate === "population.age_max") {
    const bounds = summariseAge(parseAgeBounds(text));
    if ((a.predicate === "population.age_min" ? bounds.min : bounds.max) === value) return undefined;
  }
  if (parseRegistryAge(text.trim()) === value) return undefined;
  return `${value} is not stated in the quoted passage`;
}

export interface ValueProblem {
  /** Which stored field is not supported by the quote. */
  field: "value" | "unit";
  reason: string;
}

/** The problem with an assertion's value or unit against its quote, or undefined when both are visible in it. */
export function assertionValueProblem(a: TracedAssertion, quote: string): ValueProblem | undefined {
  const unit = unitProblem(a, quote);
  if (unit) return { field: "unit", reason: unit };
  const reason = valueProblem(a, quote);
  return reason ? { field: "value", reason } : undefined;
}

function valueProblem(a: TracedAssertion, quote: string): string | undefined {
  const v = a.value;
  if (typeof v === "boolean") return undefined;
  if (typeof v === "number") return numberProblem(a, v, quote);
  if (a.predicate === "indication.purpose_exclusion") {
    if (v !== "diagnosis") return `the only value of ${a.predicate} is "diagnosis"`;
    return diagnosticExclusion(quote) === undefined ? "the quoted passage does not exclude diagnostic use" : undefined;
  }
  if (a.predicate === "study.device_mix" && typeof v === "string") {
    const m = /^(.+?)\s+(\d+(?:\.\d+)?)%$/.exec(v);
    if (!m) return `${v} is not a vendor name followed by a percentage`;
    if (!stringInText(m[1] as string, quote)) return `the vendor "${m[1]}" is not in the quoted passage`;
    return numberInText(Number(m[2]), quote) ? undefined : `${m[2]}% is not stated in the quoted passage`;
  }
  const strings = Array.isArray(v) ? v : [v];
  for (const s of strings) {
    if (typeof s !== "string") return "the value is a list with an item that is not a string";
    if (s.trim() === "") return "the value is empty";
    const terms = TERM_PREDICATES[a.predicate];
    if (terms) {
      const lexeme = terms.find(([term]) => term === s);
      if (!lexeme) return `"${s}" is not a term of the controlled list for ${a.predicate}`;
      if (!lexeme[1].test(quote)) return `the quoted passage does not contain "${s}" (no wording of that term is present)`;
      continue;
    }
    if (/^\d{4}-\d{2}(?:-\d{2})?$/.test(s) && !stringInText(s, quote)) {
      if (!dateInText(s, quote)) return `the date ${s} is not in the quoted passage in any ordinary form`;
      continue;
    }
    if (!stringInText(s, quote)) return `"${s.length > 60 ? `${s.slice(0, 57)}...` : s}" does not appear in the quoted passage`;
  }
  return undefined;
}

function unitProblem(a: TracedAssertion, quote: string): string | undefined {
  const unit = a.unit;
  if (unit === undefined) return undefined;
  if (typeof a.value !== "number") return `a unit (${unit}) is given for a value that is not a number`;
  if (unit === "proportion") return a.value >= 0 && a.value <= 1 ? undefined : `a proportion must lie between 0 and 1, not ${a.value}`;
  if (NON_COUNT_UNITS.has(unit)) return undefined;
  // Units chosen by a model or typed by a reviewer are free text; only the extractor's own vocabulary can be held to a list.
  if (a.extractionMethod !== "pattern" && a.extractionMethod !== "structured") return undefined;
  if (unitClass(unit) === undefined) return `"${unit}" is not a unit the extractor emits`;
  // A counted thing read from running text is a word of the quote; a structured field carries its unit by definition.
  if (a.extractionMethod === "pattern" && !new RegExp(String.raw`\b${escapeRe(unit)}\b`, "i").test(quote)) return `the unit "${unit}" is not a word of the quoted passage`;
  return undefined;
}
