/**
 * Interpret: bind the parts of a request that an intent needs (a URL, a record id, a case, a finding) and
 * decide which required ones are still missing. An unresolved required parameter is a reason to ask, not to
 * guess. Interpret never changes a score.
 */
import type { DecideContext, Intent } from "./types.ts";

export interface Bindings {
  /** Semantic keys the registry's required parameters refer to: url, ref, ref2, link, caseId, finding, claim. */
  bound: Record<string, unknown>;
  /** Typed facts found in the text, for the plan: age bound, setting, version, date, destination. */
  parameters: Record<string, unknown>;
  /** Stable ids of the records the request refers to. */
  references: Record<string, string>;
  urls: string[];
  refs: string[];
}

const URL_RE = /https?:\/\/(?:\[[0-9a-f:.]+\]|[^\s<>"')\[\]\/?#]+)[^\s<>"')]*/gi;
const REF_RE = /\b(?:(K\d{6})|(DEN\d{6})|(P\d{6}(?:\/S\d{1,3})?)|(NCT\d{8})|PMID[:\s]*(\d{5,9}))\b/gi;
const SETTINGS: [RegExp, string][] = [
  [/\bemergency\s+(?:department|room)\b|\bED\b|\ber\b/i, "emergency_department"],
  [/\bprimary\s+care\b|\bgp\s+practice\b|\bfamily\s+(?:medicine|practice)\b/i, "primary_care"],
  [/\binpatient\b|\bin-patient\b|\bhospital\s+ward\b|\bwards?\b/i, "inpatient"],
  [/\boutpatient\b|\bout-patient\b|\bspecialist\s+clinic\b|\bclinic\b/i, "outpatient"],
  [/\bicu\b|\bintensive\s+care\b/i, "icu"],
  [/\bscreening\s+(?:programme|program|clinic)\b|\bscreening\b/i, "screening"],
];

function clean(url: string): string {
  return url.replace(/[.,;:!?]+$/, "");
}

export function bind(prompt: string, context?: DecideContext): Bindings {
  const bound: Record<string, unknown> = {};
  const parameters: Record<string, unknown> = {};
  const references: Record<string, string> = {};

  const urls = [...prompt.matchAll(URL_RE)].map((m) => clean(m[0]));
  if (urls.length) {
    bound.url = urls[0];
    parameters.url = urls[0];
  }

  const refs: string[] = [];
  for (const m of prompt.matchAll(REF_RE)) {
    if (m[1]) {
      const id = m[1].toUpperCase();
      if (!refs.includes(id)) refs.push(id);
      references.device = `device:fda:${id}`;
    } else if (m[2] || m[3]) {
      const id = (m[2] ?? m[3] ?? "").toUpperCase();
      if (!refs.includes(id)) refs.push(id);
      references.authorization = `authorization:fda:${id}`;
    } else if (m[4]) {
      const id = m[4].toUpperCase();
      if (!refs.includes(id)) refs.push(id);
      references.study = `study:nct:${id}`;
    } else if (m[5]) {
      const id = `PMID${m[5]}`;
      if (!refs.includes(id)) refs.push(id);
      references.publication = `study:pmid:${m[5]}`;
    }
  }
  if (refs.length) bound.ref = refs[0];
  if (refs.length >= 2) bound.ref2 = [refs[0], refs[1]];

  const caseId = prompt.match(/\bCASE-[A-Z0-9]+(?:-[A-Z0-9]+)*\b/i)?.[0]?.toUpperCase() ?? context?.caseId;
  if (caseId) {
    bound.caseId = caseId;
    references.case = caseId;
  }
  const link = prompt.match(/\bLINK-\d+\b/i)?.[0]?.toUpperCase();
  if (link) {
    bound.link = link;
    references.link = link;
  }
  const finding = prompt.match(/\bfinding[\s#:-]*(F?-?\d{1,5})\b/i)?.[1] ?? prompt.match(/\b(F\d{1,5})\b/)?.[1] ?? context?.findingId;
  if (finding) {
    const f = String(finding).toUpperCase().replace(/^F?-?/, "F");
    bound.finding = f;
    references.finding = f;
  }
  const quoted = prompt.match(/["“]([^"”]{25,400})["”]/)?.[1] ?? prompt.match(/\bthe claim that\s+(.{20,300})/i)?.[1];
  if (quoted) {
    bound.claim = quoted.trim();
    parameters.claimText = quoted.trim();
  }

  const age = prompt.match(/\b(?:under|below|younger\s+than|less\s+than|aged\s+under)\s+(\d{1,2})\b/i);
  if (age?.[1]) parameters.ageBound = { direction: "under", years: Number(age[1]) };
  const over = prompt.match(/\b(?:over|above|older\s+than|aged\s+over)\s+(\d{1,2})\b/i);
  if (over?.[1] && !age) parameters.ageBound = { direction: "over", years: Number(over[1]) };
  if (/\bpaediatric|pediatric|children|child\b|neonat|adolescent|infant/i.test(prompt)) parameters.population = "pediatric";
  else if (/\badults?\b/i.test(prompt)) parameters.population = "adult";
  for (const [re, name] of SETTINGS) {
    if (re.test(prompt)) {
      parameters.setting = name;
      break;
    }
  }
  const ver = prompt.match(/\b(?:version|ver\.?|v|build|release)\s*(\d+(?:\.\d+){1,3})\b/i)?.[1];
  if (ver) parameters.version = ver;
  const date = prompt.match(/\b(\d{4}-\d{2}-\d{2})\b/)?.[1];
  if (date) parameters.date = date;
  const dest = prompt.match(/\b(?:to|at|via)\s+((?:https?:\/\/\S+)|(?:[\w.+-]+@[\w-]+(?:\.[\w-]+)+))/i)?.[1];
  if (dest) parameters.destination = clean(dest);
  return { bound, parameters, references, urls, refs };
}

/** The required parameters the intent still lacks. Empty when the request can go ahead. */
export function missingParameters(intent: Intent, b: Bindings): string[] {
  const spec = intent.parameters;
  const missing: string[] = [];
  for (const k of spec.required ?? []) if (b.bound[k] === undefined) missing.push(k);
  const groups = spec.requiredAnyOf;
  if (groups && groups.length > 0 && !groups.some((g) => g.every((k) => b.bound[k] !== undefined))) {
    missing.push(groups.map((g) => g.join("+")).join(" or "));
  }
  return missing;
}
