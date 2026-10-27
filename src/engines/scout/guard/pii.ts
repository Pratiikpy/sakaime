/**
 * Layer 4: PII and sensitivity.
 *
 * Sakaime's rule is that patient data never enters the system. Anything that looks like a patient identifier
 * blocks the request (and is redacted in the copy kept for the audit trail). Contact details and credentials are
 * redacted. Markers that a document is the vendor's confidential material do not block, but they change the
 * data class, and with it which model lane the text may use.
 */
import type { Redaction, RiskFlag } from "../types.ts";

export type PiiKind = "mrn" | "dob" | "ssn" | "patient-name" | "patient-id" | "email" | "phone" | "card" | "iban" | "credential" | "vendor-confidential";

interface Detector {
  kind: PiiKind;
  re: RegExp;
  /** Extra check on the match, for example a Luhn sum. */
  accept?: (m: string) => boolean;
}

const G = (src: string, flags = "gi"): RegExp => new RegExp(src, flags);

function luhn(digits: string): boolean {
  const d = digits.replace(/\D/g, "");
  if (d.length < 13 || d.length > 19) return false;
  let sum = 0;
  let dbl = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (dbl) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

const DETECTORS: Detector[] = [
  { kind: "mrn", re: G("\\b(?:mrn|medical\\s+record(?:\\s+(?:number|no\\.?|#))?|chart\\s+(?:number|no\\.?|#))\\s*[:#=]?\\s*[A-Z]{0,3}\\d{5,}\\b") },
  { kind: "patient-id", re: G("\\b(?:patient|encounter|accession|visit|study)\\s+(?:id|identifier|number|no\\.?|#)\\s*[:#=]?\\s*[A-Z]{0,3}[-\\s]?\\d{4,}\\b") },
  { kind: "dob", re: G("\\b(?:dob|d\\.o\\.b\\.?|date\\s+of\\s+birth|born\\s+on|birth\\s*date)\\s*[:=]?\\s*(?:\\d{1,2}[/.-]\\d{1,2}[/.-]\\d{2,4}|\\d{4}-\\d{2}-\\d{2}|[A-Z][a-z]{2,8}\\.?\\s+\\d{1,2},?\\s+\\d{4})") },
  { kind: "ssn", re: G("\\b\\d{3}-\\d{2}-\\d{4}\\b", "g") },
  // A named patient: the word "patient" (or a title) followed by a capitalised given and family name. Case-sensitive on the name.
  { kind: "patient-name", re: G("\\b(?:[Pp]atient|[Pp]t\\.?|Mr\\.|Mrs\\.|Ms\\.|Miss)\\s+(?:name\\s*[:=]\\s*)?[A-Z][a-z]{2,}(?:\\s+[A-Z]\\.)?\\s+[A-Z][a-z]{2,}\\b", "g") },
  { kind: "card", re: G("\\b(?:\\d[ -]?){13,19}\\b", "g"), accept: luhn },
  { kind: "iban", re: G("\\b[A-Z]{2}\\d{2}[A-Z0-9]{11,30}\\b", "g") },
  { kind: "email", re: G("\\b[\\w.+-]+@[\\w-]+(?:\\.[\\w-]+)+\\b") },
  { kind: "phone", re: G("(?<![\\w.])(?:\\+?\\d{1,3}[ .-]?)?\\(?\\d{3}\\)?[ .-]\\d{3}[ .-]\\d{4}(?![\\w])", "g") },
  { kind: "credential", re: G("\\b(?:sk-[A-Za-z0-9]{20,}|nvapi-[A-Za-z0-9_-]{20,}|ghp_[A-Za-z0-9]{30,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}|xox[abp]-[A-Za-z0-9-]{20,})\\b", "g") },
  { kind: "credential", re: G("\\b(?:password|passwd|pwd|api[\\s_-]?key|secret|token)\\s*[:=]\\s*\\S{6,}") },
  { kind: "vendor-confidential", re: G("\\b(?:confidential(?:\\s+and\\s+proprietary)?|proprietary(?:\\s+and\\s+confidential)?|trade\\s+secret|under\\s+nda|non-?disclosure|do\\s+not\\s+(?:distribute|share|forward|copy)|for\\s+internal\\s+use\\s+only|restricted\\s*[-:]\\s*vendor|vendor\\s+confidential|company\\s+confidential)\\b") },
];

/** What happens to each kind in a given pack. */
export interface PiiPolicy {
  block: ReadonlySet<PiiKind>;
  redact: ReadonlySet<PiiKind>;
}

export const DEFAULT_PII: PiiPolicy = {
  block: new Set<PiiKind>(["mrn", "patient-id", "dob", "ssn", "patient-name", "card", "credential"]),
  redact: new Set<PiiKind>(["mrn", "patient-id", "dob", "ssn", "patient-name", "card", "iban", "email", "phone", "credential"]),
};

export interface PiiMatch {
  kind: PiiKind;
  start: number;
  end: number;
}

export interface PiiResult {
  verdict: "pass" | "warn" | "block";
  matches: PiiMatch[];
  redactions: Redaction[];
  flags: RiskFlag[];
  redactedText: string;
  vendorConfidential: boolean;
  phi: boolean;
}

export function scanPii(text: string, policy: PiiPolicy = DEFAULT_PII): PiiResult {
  const matches: PiiMatch[] = [];
  for (const d of DETECTORS) {
    for (const m of text.matchAll(d.re)) {
      if (d.accept && !d.accept(m[0])) continue;
      matches.push({ kind: d.kind, start: m.index as number, end: (m.index as number) + m[0].length });
    }
  }
  // Keep the first, widest match where two overlap.
  matches.sort((a, b) => a.start - b.start || b.end - a.end);
  const kept: PiiMatch[] = [];
  for (const m of matches) if (!kept.length || m.start >= (kept[kept.length - 1] as PiiMatch).end) kept.push(m);

  const flags: RiskFlag[] = [];
  const counts = new Map<PiiKind, number>();
  let verdict: PiiResult["verdict"] = "pass";
  let vendorConfidential = false;
  let phi = false;
  for (const m of kept) {
    counts.set(m.kind, (counts.get(m.kind) ?? 0) + 1);
    if (m.kind === "vendor-confidential") {
      vendorConfidential = true;
      if (verdict === "pass") verdict = "warn";
      continue;
    }
    if (m.kind === "mrn" || m.kind === "patient-id" || m.kind === "dob" || m.kind === "patient-name" || m.kind === "ssn") phi = true;
    if (policy.block.has(m.kind)) verdict = "block";
    else if (verdict === "pass") verdict = "warn";
  }
  for (const [kind, n] of counts) {
    const blocking = policy.block.has(kind);
    flags.push({
      layer: "pii",
      verdict: kind === "vendor-confidential" ? "warn" : blocking ? "block" : "warn",
      kind: kind === "vendor-confidential" ? "vendor-confidential" : phi && blocking ? "phi" : kind,
      rule: `pii-${kind}`,
      detail: `${n} ${kind} match${n === 1 ? "" : "es"}`,
    });
  }

  let redactedText = text;
  const redactions: Redaction[] = [];
  const redactKinds = new Map<PiiKind, number>();
  for (const m of [...kept].reverse()) {
    if (!policy.redact.has(m.kind)) continue;
    redactedText = `${redactedText.slice(0, m.start)}[REDACTED:${m.kind}]${redactedText.slice(m.end)}`;
    redactKinds.set(m.kind, (redactKinds.get(m.kind) ?? 0) + 1);
  }
  for (const [kind, count] of redactKinds) redactions.push({ kind, count });
  return { verdict, matches: kept, redactions, flags, redactedText, vendorConfidential, phi };
}
