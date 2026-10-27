/**
 * TEST DOUBLE. A deterministic stand-in for a model, used only in tests.
 *
 * It reads the document text between the chunk boundary lines of the prompt it receives and applies fixed
 * extraction rules to it, the way an ideal extractor would. It never reads the carryover, the system prompt or
 * anything outside the boundary. Because it is a fixed rule set, it measures nothing about a real model: it
 * validates the harness (planting, chunking, verification, accounting) and nothing else.
 */
import { PortError, type FailureClass, type ModelPort, type ModelRequest, type ModelResponse } from "../../../../src/ports/index.ts";

export interface RuleModelOptions {
  /** "measured": report usage from byte counts. "none": report no usage. Default "measured". */
  usage?: "measured" | "none";
  /** Calls (1-based, counted per request including retries) that throw this failure. */
  fail?: { call: number; failure: FailureClass }[];
  /** Calls that reply with text that is not JSON. */
  nonJsonCalls?: number[];
  /** Calls whose reply is cut off mid-array. */
  truncateCalls?: number[];
  /** Calls that add one fact whose quote does not exist in the document. */
  hallucinateCalls?: number[];
  /** Calls that cite page 1 for every fact. */
  wrongPageCalls?: number[];
  /** hmem count to put in the receipt-less response. */
  provider?: ModelResponse["provider"];
}

export interface SeenPrompt {
  call: number;
  system: string;
  user: string;
  memoryScope: string;
  bytes: number;
  documentText: string;
  carryover: string;
}

interface RuleFact {
  field: string;
  value: string;
  quote: string;
  page: number;
  number?: number;
}

export class RuleModel implements ModelPort {
  readonly seen: SeenPrompt[] = [];
  private calls = 0;
  constructor(private readonly o: RuleModelOptions = {}) {}

  async complete(req: ModelRequest): Promise<ModelResponse> {
    const call = ++this.calls;
    const documentText = documentRegion(req.user);
    this.seen.push({
      call,
      system: req.system,
      user: req.user,
      memoryScope: req.memoryScope,
      bytes: Buffer.byteLength(req.system, "utf8") + Buffer.byteLength(req.user, "utf8"),
      documentText,
      carryover: req.user.match(/\[CARRYOVER STATE\]\n([\s\S]*?)\n\n/)?.[1] ?? "",
    });
    const failure = this.o.fail?.find((f) => f.call === call);
    if (failure) throw new PortError(failure.failure, `double: injected ${failure.failure} on call ${call}`);

    let facts = extractFacts(documentText);
    if (this.o.wrongPageCalls?.includes(call)) facts = facts.map((f) => ({ ...f, page: 1 }));
    if (this.o.hallucinateCalls?.includes(call)) {
      facts.push({ field: "limitation", value: "not for patients over 90", quote: "This device must never be used in patients over 90 years old.", page: facts[0]?.page ?? 1 });
    }
    let text = JSON.stringify({ facts, definitions: [] });
    if (this.o.nonJsonCalls?.includes(call)) text = "I could not find anything to report in this chunk.";
    if (this.o.truncateCalls?.includes(call)) text = text.slice(0, Math.max(40, Math.floor(text.lastIndexOf("},{") + 1)));

    const measured = (this.o.usage ?? "measured") === "measured";
    const promptBytes = Buffer.byteLength(req.system, "utf8") + Buffer.byteLength(req.user, "utf8");
    return {
      text,
      requestedModel: "test-double/rules-v1",
      routedModel: "test-double/rules-v1",
      provider: this.o.provider ?? "recorded",
      usage: measured ? { promptTokens: Math.ceil(promptBytes / 4), completionTokens: Math.ceil(text.length / 4), measured: true } : { measured: false },
      recorded: false,
    };
  }
}

function documentRegion(user: string): string {
  const m = user.match(/\[DOCUMENT CHUNK[^\n]*boundary ([0-9a-f]{12})\]\n<<<\1\n([\s\S]*?)\n>>>\1/);
  if (m) return m[2] ?? "";
  // Single-pass arms (no chunk header): the whole document block.
  const s = user.match(/<<<DOCUMENT\n([\s\S]*?)\n>>>DOCUMENT/);
  return s?.[1] ?? "";
}

const AGE_BAR = /(?:not (?:indicated|intended|validated|recommended) for(?: use in)?|should not be used (?:in|for)|do(?:es)? not (?:support|extend to)(?: use in)?|contraindicated in)\s+(?:patients?|subjects?|individuals?|persons?|people)\s+(?:who are\s+)?(?:under|younger than|below|aged under|less than)\s+(\d{1,2})(?:\s+years)?/i;
const AGE_BAR_B = /(?:use in|for)\s+(?:patients?|subjects?)\s+(?:under|younger than|below)\s+(\d{1,2})\s+(?:years\s+)?(?:of age\s+)?(?:has not been|was not|is not)\s+(?:established|studied|validated|evaluated)/i;

export function extractFacts(documentText: string): RuleFact[] {
  const out: RuleFact[] = [];
  const sections = documentText.split(/\n*\[PAGE (\d+)(?:, part \d+\/\d+)?\]\n/);
  // split yields: [pre, page, body, page, body, ...]
  for (let i = 1; i < sections.length; i += 2) {
    const page = Number(sections[i]);
    const body = sections[i + 1] ?? "";
    for (const sentence of body.split(/(?<=[.!?])\s+/)) {
      const s = sentence.trim();
      if (s.length < 8) continue;
      const age = s.match(AGE_BAR) ?? s.match(AGE_BAR_B);
      if (age?.[1]) out.push({ field: "limitation", value: `not for patients under ${age[1]}`, quote: s.slice(0, 300), page, number: Number(age[1]) });
      if (/performance in [a-z ]+ settings was not evaluated/i.test(s)) out.push({ field: "limitation", value: "not evaluated outside specialist outpatient clinics", quote: s.slice(0, 300), page });
      if (/results apply only to software version/i.test(s)) out.push({ field: "limitation", value: "results apply only to one software version", quote: s.slice(0, 300), page });
      if (/excluded from the study and the device must not be used/i.test(s)) out.push({ field: "population_exclusion", value: "excluded group, device must not be used", quote: s.slice(0, 300), page });
      if (/validated only with images from/i.test(s)) out.push({ field: "limitation", value: "validated only with one camera", quote: s.slice(0, 300), page });
      const ver = s.match(/(?:software|algorithm)\s+version\s+(\d+(?:\.\d+){1,3})/i);
      if (ver?.[1]) out.push({ field: "software_version", value: `version ${ver[1]}`, quote: s.slice(0, 300), page });
      const n = s.match(/(\d{1,3}(?:,\d{3})+|\d{2,5})\s+(?:patients|participants|subjects)\s+(?:were\s+)?(?:enrolled|prospectively enrolled)/i);
      if (n?.[1]) out.push({ field: "sample_size", value: `${n[1]} participants enrolled`, quote: s.slice(0, 300), page, number: Number(n[1].replace(/,/g, "")) });
      const th = s.match(/(?:operating point|threshold|cut-?off)\s+(?:of|at|was set to|set at)\s+(0?\.\d+|\d+(?:\.\d+)?)/i);
      if (th?.[1]) out.push({ field: "operating_threshold", value: `threshold ${th[1]}`, quote: s.slice(0, 300), page, number: Number(th[1]) });
      const set = s.match(/(?:conducted|collected|performed|enrolled)\b[^.]{0,60}\b(primary care|ophthalmology clinic|emergency department|inpatient|outpatient)\b/i);
      if (set?.[1]) out.push({ field: "setting", value: set[1].toLowerCase(), quote: s.slice(0, 300), page });
    }
  }
  return out;
}
