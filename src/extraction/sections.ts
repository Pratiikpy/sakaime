/**
 * Heading detection for FDA decision summaries.
 *
 * De Novo decision summaries use lettered headings (A. De Novo Number ... N. Conclusion). 510(k) summaries follow the
 * order of 21 CFR 807.92 under free-text headings (Submitter, Device Description, Intended Use, Performance Data...).
 * Headings are used to say where a statement sits, not to decide whether it is true.
 */
import type { DocumentText } from "./types.ts";

export type SectionKind =
  | "identity"
  | "indications"
  | "device_description"
  | "predicate"
  | "nonclinical"
  | "performance"
  | "clinical"
  | "labeling"
  | "conclusion"
  | "other";

export interface Section {
  title: string;
  kind: SectionKind;
  page: number;
  /** Offsets into the page text of the heading line. */
  start: number;
  end: number;
  /** Letter or number label when the heading has one ("F", "6"). */
  label?: string;
}

const KNOWN: { re: RegExp; kind: SectionKind }[] = [
  { re: /^(?:intended\s+use\s*\/\s*)?indications?\s+for\s+use$/i, kind: "indications" },
  { re: /^intended\s+use$/i, kind: "indications" },
  { re: /^device\s+description$|^description\s+of\s+the\s+device$/i, kind: "device_description" },
  { re: /^(?:legally\s+marketed\s+)?predicate\s+devices?$|^substantial\s+equivalence/i, kind: "predicate" },
  { re: /^summary\s+of\s+technological\s+characteristics|^technological\s+characteristics$/i, kind: "predicate" },
  { re: /^non-?clinical|^bench\s+(?:testing|studies)|^summary\s+of\s+nonclinical/i, kind: "nonclinical" },
  { re: /^performance\s+(?:data|characteristics|testing)|^pivotal\s+study|^standalone\s+performance/i, kind: "performance" },
  { re: /^(?:summary\s+of\s+)?clinical\s+(?:information|performance|data|study|studies|testing|tests|validation)/i, kind: "clinical" },
  { re: /^(?:proposed\s+)?labeling$/i, kind: "labeling" },
  { re: /^conclusions?$/i, kind: "conclusion" },
  { re: /^submitter$|^name\s+of\s+device|^de\s+novo\s+number|^proprietary\s+and\s+established/i, kind: "identity" },
];

function classify(title: string): SectionKind {
  const t = title.trim().replace(/[:.]+$/, "");
  for (const k of KNOWN) if (k.re.test(t)) return k.kind;
  return "other";
}

const LETTERED = /^\s{0,6}([A-N])\.\s+([A-Z][^\n]{2,90}?)\s*:?\s*$/;
const NUMBERED = /^\s{0,6}(\d{1,2})\.\s+([A-Z][A-Za-z0-9 ,/&()'-]{3,80}?)\s*:?\s*$/;
const ALLCAPS = /^\s{0,6}([A-Z][A-Z0-9 /&,'()-]{5,70})\s*$/;
const PLAIN = /^\s{0,6}([A-Z][A-Za-z0-9 ,/&()'-]{3,70}?)\s*:?\s*$/;

/**
 * Find headings in reading order. A lettered heading is accepted only if its letter follows the previous lettered
 * heading (A, B, C...), which keeps list items such as "B. cases" from being read as sections.
 */
export function findSections(doc: DocumentText): Section[] {
  const out: Section[] = [];
  let lastLetter = 0;
  for (const page of doc.pages) {
    let pos = 0;
    for (const line of page.text.split("\n")) {
      const start = pos;
      pos += line.length + 1;
      if (line.trim().length === 0 || line.length > 110) continue;
      let label: string | undefined;
      let title: string | undefined;
      let m = LETTERED.exec(line);
      if (m) {
        const idx = (m[1] as string).charCodeAt(0) - 64;
        if (idx === lastLetter + 1 || (lastLetter === 0 && idx <= 2)) {
          lastLetter = idx;
          label = m[1];
          title = m[2];
        }
      }
      if (!title) {
        m = NUMBERED.exec(line);
        if (m && classify(m[2] as string) !== "other") {
          label = m[1];
          title = m[2];
        }
      }
      if (!title) {
        const plain = PLAIN.exec(line);
        const caps = ALLCAPS.exec(line);
        const candidate = (caps?.[1] ?? plain?.[1])?.trim();
        if (candidate && classify(candidate) !== "other") title = candidate;
        else if (caps && /[A-Z]{4}/.test(caps[1] as string) && !/\d{3,}/.test(caps[1] as string)) title = (caps[1] as string).trim();
      }
      if (title) {
        const entry: Section = { title: title.trim(), kind: classify(title), page: page.page, start, end: start + line.length };
        if (label !== undefined) entry.label = label;
        out.push(entry);
      }
    }
  }
  return out;
}

/** The nearest heading at or before a position, across pages. */
export function sectionAt(sections: Section[], page: number, offset: number): Section | undefined {
  let found: Section | undefined;
  for (const s of sections) {
    if (s.page < page || (s.page === page && s.start <= offset)) found = s;
    else break;
  }
  return found;
}
