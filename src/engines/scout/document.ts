/**
 * Document guard. Text lifted out of a vendor PDF, a registry page or a study report has no authority: it is
 * data. Before it can influence anything it goes through the same guard as a request, with the lower bar for
 * text that has no business giving orders. A page that speaks to the machine reader or tells reviewers what to
 * conclude is quarantined, and the reviewer is shown the exact span.
 */
import { composePacks, type ComposedPack } from "./guard/packs.ts";
import { detectInjection, type InjectionHit } from "./guard/injection.ts";
import { scanPii, type PiiKind } from "./guard/pii.ts";
import { analyse } from "./text.ts";

export interface DocumentFinding {
  kind: "injection" | "patient-identifier" | "vendor-confidential" | "hidden-text";
  rule: string;
  family: string;
  score: number;
  /** Span in the original text. */
  start: number;
  end: number;
  matched: string;
  action: "quarantine" | "flag";
  reason: string;
}

/** One stretch of the original text to set aside: the sentence or sentences that carry the instruction. */
export interface QuarantinedSpan {
  start: number;
  end: number;
  text: string;
  /** The rules that fired inside it. */
  rules: string[];
}

export interface DocumentScan {
  /** True when nothing in the text asks to be obeyed and no patient identifier is present. */
  clean: boolean;
  quarantine: boolean;
  score: number;
  findings: DocumentFinding[];
  /** The quarantined findings merged and widened to whole sentences: what to hide from the model and show the reviewer. */
  quarantinedSpans: QuarantinedSpan[];
  /** Evidence that the text was disguised: hidden characters, look-alike letters, encoded payloads. */
  obfuscation: string[];
}

export interface DocumentScanOptions {
  packs?: ComposedPack | string | string[];
  knownTools?: ReadonlySet<string>;
}

const PHI: ReadonlySet<PiiKind> = new Set<PiiKind>(["mrn", "patient-id", "dob", "patient-name", "ssn"]);

export function scanDocument(text: string, o: DocumentScanOptions = {}): DocumentScan {
  const packs = o.packs && typeof o.packs === "object" && "pack" in o.packs ? o.packs : composePacks(o.packs as string | string[] | undefined);
  const analysis = analyse(text);
  const inj = detectInjection(text, packs.pack.injection, { surface: "doc", knownTools: o.knownTools ?? new Set() }, analysis);
  const findings: DocumentFinding[] = [];
  const blocked = inj.verdict === "block";
  for (const h of inj.hits) {
    if (h.score < packs.pack.injection.warnAt.doc) continue;
    findings.push(toFinding(h, blocked));
  }
  const pii = scanPii(text, packs.pack.pii);
  for (const m of pii.matches) {
    if (PHI.has(m.kind)) {
      findings.push({ kind: "patient-identifier", rule: `pii-${m.kind}`, family: "pii", score: 1, start: m.start, end: m.end, matched: `[${m.kind}]`, action: "quarantine", reason: "patient identifiers do not enter Sakaime" });
    } else if (m.kind === "vendor-confidential") {
      findings.push({ kind: "vendor-confidential", rule: "pii-vendor-confidential", family: "pii", score: 1, start: m.start, end: m.end, matched: text.slice(m.start, m.end), action: "flag", reason: "vendor-confidential marker: use the local model lane" });
    }
  }
  for (const [a, b] of analysis.hiddenSpans) {
    findings.push({ kind: "hidden-text", rule: "hidden-markup", family: "markup", score: 0.3, start: a, end: b, matched: text.slice(a, Math.min(b, a + 80)), action: "flag", reason: "text hidden in comments or invisible markup" });
  }
  const quarantine = findings.some((f) => f.action === "quarantine");
  return { clean: findings.length === 0, quarantine, score: inj.score, findings: findings.sort((x, y) => x.start - y.start), quarantinedSpans: mergeToSentences(text, findings.filter((f) => f.action === "quarantine")), obfuscation: analysis.flags };
}

const SENTENCE_END = /[.!?\n]/;

/** Merge findings that sit in the same sentence or run together, and widen each to its whole sentence(s). */
function mergeToSentences(text: string, findings: DocumentFinding[]): QuarantinedSpan[] {
  const sorted = [...findings].sort((a, b) => a.start - b.start);
  const spans: { start: number; end: number; rules: Set<string> }[] = [];
  for (const f of sorted) {
    let start = f.start;
    let end = f.end;
    for (let i = start - 1; i >= Math.max(0, start - 300); i--) {
      if (SENTENCE_END.test(text[i] as string)) break;
      start = i;
    }
    for (let i = end; i < Math.min(text.length, end + 300); i++) {
      end = i + 1;
      if (SENTENCE_END.test(text[i] as string)) break;
    }
    const last = spans[spans.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.rules.add(f.rule);
    } else spans.push({ start, end, rules: new Set([f.rule]) });
  }
  return spans.map((x) => ({ start: x.start, end: x.end, text: text.slice(x.start, Math.min(x.end, x.start + 400)), rules: [...x.rules] }));
}

function toFinding(h: InjectionHit, blocked: boolean): DocumentFinding {
  return {
    kind: "injection",
    rule: h.rule,
    family: h.kind,
    score: Number(h.score.toFixed(3)),
    start: h.span[0],
    end: h.span[1],
    matched: h.evidence,
    action: blocked ? "quarantine" : "flag",
    reason: reasonFor(h),
  };
}

function reasonFor(h: InjectionHit): string {
  switch (h.kind) {
    case "document-directive":
      return "the text gives orders to whoever reads it";
    case "exfiltration":
      return "the text asks for data to be sent out or revealed";
    case "role-drift":
      return "the text tries to change the reader's role";
    case "tool-ref":
      return "the text names an action or tool outside the task";
    case "concealment":
      return "the text asks that something be kept from the reviewer";
    case "obfuscation":
      return "the text matches an attack only after decoding or normalising it";
    default:
      return "the text tries to override the rules the reader runs under";
  }
}

export interface ScreenSpan {
  page: number;
  start: number;
  end: number;
  matched: string;
  kind: string;
  reason: string;
}

/**
 * Adapter for the Markovian reader's screen hook: the spans to mask in what the model sees. Only quarantined
 * findings are returned, so ordinary text is never altered.
 */
export function documentScreen(o: DocumentScanOptions = {}): (page: { page: number; text: string }) => ScreenSpan[] {
  return (page) => {
    const scan = scanDocument(page.text, o);
    if (!scan.quarantine) return [];
    return scan.quarantinedSpans.map((sp) => {
      const inside = scan.findings.filter((f) => f.action === "quarantine" && f.start >= sp.start && f.end <= sp.end);
      const phi = inside.some((f) => f.kind === "patient-identifier");
      return { page: page.page, start: sp.start, end: sp.end, matched: phi ? "[patient identifier]" : sp.text, kind: phi ? "patient-identifier" : "document-instruction", reason: inside[0]?.reason ?? "instruction-like text" };
    });
  };
}
