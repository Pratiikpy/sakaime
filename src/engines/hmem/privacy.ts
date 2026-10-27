import type { MemoryRecord } from "./types.ts";

/**
 * The privacy filter that runs between retrieval and prompt formatting
 * (selected memories -> privacy filter -> grouped context -> model prompt). The reference has no
 * such step. This one does two things: it omits records whose tags mark them as not for a prompt,
 * and it masks identifier-shaped text in the records that remain.
 *
 * The patterns are a safety net for text that should never have been stored (Sakaime stores no
 * patient data), not a de-identification method. They will miss things; the guarantee that matters
 * is that nothing tagged sensitive reaches a prompt.
 */

export interface RedactionResult {
  /** Null when the record must not be injected at all. */
  text: string | null;
  hits: string[];
}

export interface Redactor {
  apply(record: MemoryRecord): RedactionResult;
}

const DEFAULT_OMIT_TAGS = ["private", "secret", "pii", "health", "financial", "work-confidential"];

const DEFAULT_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "email", re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g },
  { label: "ssn", re: /\b\d{3}-\d{2}-\d{4}\b/g },
  { label: "mrn", re: /\b(?:MRN|medical record(?: number)?)[:#\s]*[A-Z0-9-]{4,}\b/gi },
  { label: "dob", re: /\b(?:DOB|date of birth|born)[:\s]+\S+(?:\s+\d{1,4})?/gi },
  { label: "phone", re: /(?<!\d)(?:\+?\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}(?!\d)/g },
  { label: "secret", re: /\b(?:sk|pk|nvapi|ghp|xox[bap])[-_][A-Za-z0-9_-]{16,}\b/g },
  { label: "long-number", re: /(?<![\w.])\d{9,}(?![\w.])/g },
];

export interface RedactorOptions {
  omitTags?: readonly string[];
  patterns?: { label: string; re: RegExp }[];
}

export function createRedactor(opts: RedactorOptions = {}): Redactor {
  const omit = new Set((opts.omitTags ?? DEFAULT_OMIT_TAGS).map((t) => t.toLowerCase()));
  const patterns = opts.patterns ?? DEFAULT_PATTERNS;
  return {
    apply(record) {
      if (record.tags.some((t) => omit.has(t.toLowerCase()))) return { text: null, hits: ["omitted-by-tag"] };
      let text = record.content;
      const hits: string[] = [];
      for (const { label, re } of patterns) {
        text = text.replace(re, () => {
          hits.push(label);
          return `[REDACTED:${label}]`;
        });
      }
      return { text, hits };
    },
  };
}
