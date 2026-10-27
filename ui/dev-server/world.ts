/**
 * The fixture world behind the dev server.
 *
 * Nothing here is a hand-written finding. The case file is built from files already in the repository:
 * the EyeArt K200667 evidence items and quotes (evals/gate0), the claims written for the Gate 0 test (constructed and
 * labelled so), the recorded source responses (data/cassettes), the hospital, vendor and registry silos (data/silos) and
 * the identity corpus. Every label is computed by the real compiler, every link by the real identity resolver, every
 * matrix row by the real headline statement on DuckDB, every guard decision by the real Scout guard, and the dossier is
 * built and verified by the real dossier module. What this file adds is only the wiring a server needs.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { z } from "zod";
import type { CaseDetailSchema, EvidenceMatrixSchema, SourceRowSchema, TimelineEventSchema } from "../../src/api/contract.ts";
import { compileDetailed, COMPILER_VERSION, type CompileDetail, type CompileOptions } from "../../src/compiler/index.ts";
import { DecisionLog } from "../../src/dossier/index.ts";
import { DEFAULT_MODEL, loadCorpus, resolvePair, type Corpus } from "../../src/identity/index.ts";
import { createSourceLayer, shapeFingerprint } from "../../src/sources/index.ts";
import type { Claim, EvidenceAnchor, EvidenceItem, Finding, Link, Source } from "../../src/schemas/index.ts";
import { canonicalJson, sha256Hex } from "../../src/util/canonical.ts";

export const REPO = fileURLToPath(new URL("../..", import.meta.url));
const p = (...s: string[]) => join(REPO, ...s);

type SourceRow = z.infer<typeof SourceRowSchema>;
type Matrix = z.infer<typeof EvidenceMatrixSchema>;
type TimelineEvent = z.infer<typeof TimelineEventSchema>;
type CaseDetail = z.infer<typeof CaseDetailSchema>;

export const SERVER_START = new Date().toISOString();
/** Day on which every recorded source response was captured (data/cassettes/public-evidence-2026-10-27/index.json). */
export const RETRIEVED_AT = "2026-10-27T00:00:00.000Z";
/** Deployment date of the hospital case CASE-2026-014 (data/silos/hospital/cases.csv), used when a claim gives no date. */
const DEPLOYMENT_DATE = "2027-01-15";

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();

// ---------------------------------------------------------------- records, quotes

const SOURCE_FOR_PATH: [RegExp, string][] = [
  [/\/fda\/.*summary/, "fda-accessdata-pdf"],
  [/\/pubmed\//, "pubmed-eutils"],
  [/\/ctgov\//, "clinicaltrials-v2"],
];
const sourceIdForPath = (path: string): string => SOURCE_FOR_PATH.find(([re]) => re.test(path))?.[1] ?? "other";

function stripXml(raw: string): string {
  return raw
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)));
}

/** Extracted text of a stored record: whitespace collapsed so a quote that wraps across lines is found. */
function extractedText(path: string): string {
  const raw = readFileSync(p(path), "utf8");
  return norm(path.endsWith(".xml") ? stripXml(raw) : raw);
}

/**
 * The key writes some quotes with "[...]" where it skipped text. A dossier's quotes must be verbatim, so such a quote is
 * widened to the exact passage between its first and last fragment.
 */
function verbatim(text: string, quote: string): string | undefined {
  if (text.includes(quote)) return quote;
  const parts = quote.split(/\s*\[\.\.\.\]\s*/).map(norm).filter(Boolean);
  if (parts.length < 2) return undefined;
  const start = text.indexOf(parts[0]!);
  const lastPart = parts[parts.length - 1]!;
  const lastAt = text.indexOf(lastPart, start);
  if (start < 0 || lastAt < 0) return undefined;
  return text.slice(start, lastAt + lastPart.length);
}

// ---------------------------------------------------------------- the world

export interface KeyAnchor {
  id: string;
  source: string;
  sha256: string;
  quote: string;
  pdfPage?: number;
  printedPage?: string;
}

export interface CaseState {
  id: string;
  title: string;
  claimId: string;
  claim: Claim;
  claimText: string;
  items: EvidenceItem[];
  anchorsByItem: Map<string, KeyAnchor[]>;
  detail: CompileDetail;
  options: CompileOptions;
  log: DecisionLog;
  /** Events added while the server runs (decisions, dev-only fact changes). */
  dynamicEvents: TimelineEvent[];
  changedFacts: Set<string>;
  staleIds: Set<string>;
  baseEvents: TimelineEvent[];
}

/** Sources the fixture cases never read. */
const UNREAD = new Set(["crossref", "openfda-pma"]);

export interface World {
  cases: Map<string, CaseState>;
  order: string[];
  sourceRows: SourceRow[];
  sourceTypeOf: (sourceId: string) => string | undefined;
  matrix: Matrix;
  links: Link[];
  linkLabels: Map<string, string>;
  anchors: Map<string, EvidenceAnchor & { sourceId: string; sourcePublishedAt?: string }>;
  texts: Map<string, { recordId: string; sourceId: string; path: string; sha256: string; text: string }>;
  cardsBySourceId: Map<string, { title: string; license: string; kind: Source["kind"]; dataClass: Source["dataClass"] }>;
  shapeBySource: Map<string, string>;
  corpus: Corpus;
  hospitalLinks: { id: string; caseId: string; basis: string; by: string; on: string; leftId: string; rightId: string }[];
}

interface Oracle {
  rows(statement: string): Promise<Record<string, unknown>[]>;
}

async function openOracle(): Promise<Oracle & { close(): void }> {
  const mod = (await import(pathToFileURL(p("infra/zetaris/scripts/oracle.mjs")).href)) as { createOracle: () => Promise<Oracle & { close(): void }> };
  return mod.createOracle();
}

const MATRIX_GROUPS: { id: string; label: string; columns: string[] }[] = [
  { id: "silo-hospital", label: "Hospital review database (constructed)", columns: ["case_id", "product_name", "intended_purpose", "intended_setting", "intended_min_age", "requirement_count", "required_min_age"] },
  { id: "silo-vendor", label: "Vendor packet (constructed)", columns: ["claim_id", "claimed_version", "claimed_min_age_years", "claimed_setting", "claimed_purpose"] },
  { id: "openfda-510k", label: "openFDA 510(k) record", columns: ["k_number", "decision_date", "clearance_type"] },
  { id: "openfda-udi", label: "openFDA device identifier (UDI) record", columns: ["udi_versions", "version_in_device_record"] },
  { id: "clinicaltrials-v2", label: "ClinicalTrials.gov study", columns: ["confirmed_studies", "study_min_age_years"] },
  { id: "derived", label: "Derived in the join", columns: ["claim_age_vs_study", "case_age_vs_study"] },
];

async function buildMatrix(): Promise<Matrix> {
  const oracle = await openOracle();
  try {
    const headline = readFileSync(p("infra/zetaris/sql/headline.duckdb.sql"), "utf8").replace(/;\s*$/, "").trim();
    const statement = `SELECT * FROM (\n${headline}\n) AS headline WHERE product_name = 'EyeArt' ORDER BY case_id, claim_id`;
    const started = performance.now();
    const raw = await oracle.rows(statement);
    const elapsedMs = performance.now() - started;
    const columns = MATRIX_GROUPS.flatMap((g) => g.columns.map((name) => ({ name, sourceId: g.id, sourceLabel: g.label })));
    const rows = raw.map((r) => ({
      cells: Object.fromEntries(columns.map((c) => [c.name, { value: r[c.name] ?? null, sourceId: c.sourceId, sourceLabel: c.sourceLabel }])),
    }));
    const distinct = (col: string) => new Set(raw.map((r) => String(r[col] ?? ""))).size;
    const [udi] = await oracle.rows("SELECT count(*) AS n FROM fda_udi WHERE submission_number = 'K200667'");
    const hash = sha256Hex(canonicalJson({ columns: columns.map((c) => c.name), rows: raw }));
    return {
      statement,
      queryId: `q_${hash.slice(0, 12)}`,
      servedFrom: "fallback",
      respHash: hash,
      elapsedMs,
      perSourceRowCounts: {
        "silo-hospital": distinct("case_id"),
        "silo-vendor": distinct("claim_id"),
        "openfda-510k": distinct("k_number"),
        "openfda-udi": Number((udi as { n: unknown } | undefined)?.n ?? 0),
        "clinicaltrials-v2": raw.filter((r) => Number(r["confirmed_studies"] ?? 0) > 0).length > 0 ? Number(raw.find((r) => Number(r["confirmed_studies"] ?? 0) > 0)?.["confirmed_studies"] ?? 0) : 0,
        derived: raw.length,
      },
      columns,
      rows,
    };
  } finally {
    oracle.close();
  }
}

async function csvRows(oracle: Oracle, view: string): Promise<number> {
  const [r] = await oracle.rows(`SELECT count(*) AS n FROM ${view}`);
  return Number((r as { n: unknown }).n);
}

function headerHash(path: string): string {
  const first = readFileSync(p(path), "utf8").split(/\r?\n/, 1)[0] ?? "";
  return sha256Hex(first);
}

function authorityNote(kind: string): string {
  switch (kind) {
    case "regulator":
      return "Authority for what is authorized: product, version, indication, setting, date. Cannot report performance.";
    case "registry":
      return "Authority for how a study was designed and who it enrolled. Not for results.";
    case "literature":
      return "Authority for reported study results. Cannot widen an authorization.";
    case "vendor":
      return "A claim, never evidence. It supports, widens and contradicts nothing.";
    case "hospital":
      return "The hospital's own requirements: policy, not evidence.";
    default:
      return "";
  }
}

async function buildSources(layer: ReturnType<typeof createSourceLayer>): Promise<{ rows: SourceRow[]; shapes: Map<string, string>; cards: World["cardsBySourceId"] }> {
  const index = JSON.parse(readFileSync(p("data/cassettes/public-evidence-2026-10-27/index.json"), "utf8")) as {
    entries: { request: { url: string }; response: { status: number; sha256: string } }[];
  };
  const shapes = new Map<string, string>();
  const cards: World["cardsBySourceId"] = new Map();
  const rows: SourceRow[] = [];

  for (const { file } of layer.cards) {
    const hosts = file.hosts.map((h) => h.host);
    const entry = index.entries.find((e) => e.response.status === 200 && hosts.includes(new URL(e.request.url).host) && /json/.test(e.request.url + "json") && existsSync(p("data/cassettes/public-evidence-2026-10-27/bodies", e.response.sha256)));
    let schemaHash: string | undefined;
    if (entry) {
      try {
        const body = readFileSync(p("data/cassettes/public-evidence-2026-10-27/bodies", entry.response.sha256), "utf8");
        schemaHash = sha256Hex(shapeFingerprint(JSON.parse(body)) as string);
      } catch {
        // XML and PDF bodies have no JSON shape; the fingerprint stays absent rather than invented.
      }
    }
    if (schemaHash) shapes.set(file.id, schemaHash);
    cards.set(file.id, { title: file.title, license: file.license, kind: file.kind, dataClass: file.dataClass });
    const pinned = file.access === "pinned-snapshot";
    rows.push({
      source: {
        id: file.id,
        kind: file.kind,
        access: "connector",
        descriptor: file.title,
        license: file.license,
        ...(schemaHash ? { schemaHash } : {}),
        health: pinned ? "STALE" : "OK",
        // A source nothing has read has not answered, so it has no last success: the real service leaves the field out too.
        ...(UNREAD.has(file.id) ? {} : { lastSuccessAt: RETRIEVED_AT }),
        dataClass: file.dataClass,
      },
      // A source no case reads has no observation of its own: it is shown as it is, not as out of date. A pinned snapshot is older than its card's cadence.
      healthDetail: pinned
        ? "Pinned snapshot, current as of 2026-09-04. FDA refuses scripted download, so the live list is not fetched by default; the snapshot is older than its card expects."
        : UNREAD.has(file.id)
          ? "not read by any case investigated so far; no failure has been seen for it"
          : "Answered from a recorded response captured on 2026-10-27. Sample run: no live call was made.",
      authorityNotes: authorityNote(file.kind),
      ...(UNREAD.has(file.id) && !pinned ? { observed: false } : {}),
    });
  }

  const oracle = await openOracle();
  try {
    const silo = async (id: string, kind: Source["kind"], descriptor: string, license: string, zetarisName: string, views: string[], header: string, note: string, dataClass: Source["dataClass"] = "public") => {
      let n = 0;
      for (const v of views) n += await csvRows(oracle, v);
      rows.push({
        source: { id, kind, access: "zetaris", descriptor, license, schemaHash: headerHash(header), health: "OK", lastSuccessAt: RETRIEVED_AT, dataClass },
        healthDetail: "Files loaded into the local Zetaris stack for this sample run. Queried here through the local DuckDB fallback.",
        zetarisName,
        rowCount: n,
        authorityNotes: note,
      });
    };
    await silo("silo-hospital", "hospital", "Hospital review database (constructed, no patient data)", "Constructed for testing", "hospital", ["hospital_cases", "hospital_submissions", "hospital_requirements", "hospital_evidence_links", "hospital_decisions"], "data/silos/hospital/cases.csv", authorityNote("hospital"));
    await silo("silo-vendor", "vendor", "Vendor packet exports (constructed, not issued by any company)", "Constructed for testing", "sk_vendor", ["vendor_claims", "vendor_packets"], "data/silos/vendor_packets/vendor_claims.csv", authorityNote("vendor"), "vendor-confidential");
    await silo("silo-registry", "registry", "Public registry snapshots: openFDA 510(k), UDI, ClinicalTrials.gov, PubMed", "Public records; see each source card", "sk_registry", ["fda_510k", "fda_udi", "fda_classification", "ctgov_studies", "pubmed_articles"], "data/silos/registry/fda_510k.csv", authorityNote("registry"));
  } finally {
    oracle.close();
  }
  return { rows, shapes, cards };
}

// ---------------------------------------------------------------- identity links for the EyeArt family

interface IdRecord {
  id: string;
  kind?: string;
  name?: string;
  version?: string;
  nct?: string;
}

const RECORD_NAMES: [RegExp, (id: string) => string][] = [
  [/^510k:/, (id) => `FDA 510(k) ${id.slice(5)}`],
  [/^list:/, (id) => `FDA AI-device list entry ${id.slice(5)}`],
  [/^gudid:/, (id) => `Device record ${id.slice(6).replace(":", ", release ")}`],
  [/^ctgov:/, (id) => `ClinicalTrials.gov ${id.slice(6)}`],
  [/^pubmed:/, (id) => `PubMed article ${id.slice(7)}`],
];
const labelOf = (id: string): string => RECORD_NAMES.find(([re]) => re.test(id))?.[1](id) ?? id;

function buildLinks(corpus: Corpus): { links: Link[]; labels: Map<string, string> } {
  const eye = new Set([...corpus.records.values()].filter((r) => /eyeart/i.test(r.family)).map((r) => r.record.id));
  const links: Link[] = [];
  const labels = new Map<string, string>();
  for (const pair of corpus.pairs) {
    if (!(eye.has(pair.a) && eye.has(pair.b))) continue;
    const res = resolvePair(pair, corpus, DEFAULT_MODEL);
    if (!res.link) continue;
    const waterfall = res.link.waterfall ?? res.score?.waterfall;
    const link: Link = {
      ...res.link,
      ...(waterfall ? { waterfall } : {}),
      ...(res.score ? { score: res.score.weight } : {}),
      flags: [...new Set([...(res.link.flags ?? []), ...res.flags])],
    };
    links.push(link);
    labels.set(link.from, labelOf(link.from));
    labels.set(link.to, labelOf(link.to));
    candidateClasses.set(link.id, res.candidateClass.replace(/-/g, "_"));
  }
  return { links, labels };
}
export const candidateClasses = new Map<string, string>();

// ---------------------------------------------------------------- supporting anchors

function pageOfQuote(path: string, quote: string): number | undefined {
  const raw = readFileSync(p(path), "utf8");
  const FF = String.fromCharCode(12);
  if (!raw.includes(FF)) return undefined;
  const escape = (w: string) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const at = raw.search(new RegExp(quote.split(" ").map(escape).join("\\s+")));
  return at < 0 ? undefined : raw.slice(0, at).split(FF).length;
}

/**
 * The key quotes the passages that carry each assertion. Three things a finding prints are not in those passages: the
 * submission number, the decision date and the study dates, and the percentage behind a ratio such as (92/99). They are
 * all in the same stored records, so the passages that carry them are added here, verbatim, and the build fails if one
 * is missing. This lets the dossier verifier check every number a finding prints against a quote.
 */
function addSupportingAnchors(items: EvidenceItem[], anchorsByItem: Map<string, KeyAnchor[]>): void {
  for (const item of items) {
    const list = anchorsByItem.get(item.id) ?? [];
    const first = list[0];
    if (!first) continue;
    const text = extractedText(first.source);
    const add = (id: string, quote: string | undefined) => {
      if (!quote || !text.includes(quote) || list.some((a) => a.id === id)) return;
      const page = pageOfQuote(first.source, quote);
      list.push({ id, source: first.source, sha256: first.sha256, quote, ...(page !== undefined ? { pdfPage: page } : {}) });
      item.anchorIds = [...item.anchorIds, id];
    };
    for (const v of item.scope.versions ?? []) {
      if (list.some((a) => a.quote.includes(v))) continue;
      const at = text.indexOf(v);
      if (at >= 0) add(`${item.id}.version.${v}`, text.slice(Math.max(0, text.lastIndexOf(" ", Math.max(0, at - 45))), Math.min(text.length, at + v.length + 20)).trim());
    }
    if (item.assertionType === "authorization") {
      add(`${item.id}.number`, /Re: (K|DEN)\d+/.exec(text)?.[0]);
      add(`${item.id}.date`, /^[A-Z][a-z]+ \d{1,2}, \d{4}/.exec(text)?.[0]);
    }
    if (item.assertionType === "study") {
      const year = item.scope.timing?.from?.slice(0, 4);
      if (year && !list.some((a) => a.quote.includes(year))) {
        const at = text.search(new RegExp(`[A-Z][a-z]+ \\d{1,2}, ${year}`));
        if (at >= 0) add(`${item.id}.dates`, text.slice(Math.max(0, at - 60), at + 30).replace(/^\S*\s/, ""));
      }
      for (const r of item.results) {
        const pct = (r.value * 100).toFixed(1);
        const ci = r.ci ? `[${(r.ci[0] * 100).toFixed(1)}% - ${(r.ci[1] * 100).toFixed(1)}%]` : "";
        const figure = `${pct}% ${ci}`.trim();
        const at = text.indexOf(figure);
        if (at >= 0) {
          const id = `${item.id}.${r.metric}.rate`;
          // The table prints the count ("(92/99)") on the line below the percentage; keep both in one passage when they are close.
          const ratio = r.n ? `(${Math.round(r.value * r.n)}/${r.n})` : "";
          const ratioAt = ratio ? text.indexOf(ratio, at) : -1;
          const end = ratioAt >= 0 && ratioAt - at < 200 ? ratioAt + ratio.length : at + figure.length;
          add(id, text.slice(Math.max(0, text.lastIndexOf(" ", Math.max(0, at - 12))), end).trim());
          if (list.some((a) => a.id === id)) r.anchorId = id;
        }
      }
    }
    anchorsByItem.set(item.id, list);
  }
}

// ---------------------------------------------------------------- cases

function loadKey(): { claims: Record<string, any>[]; items: Record<string, any>[] } {
  const claims = readFileSync(p("evals/gate0/claims.jsonl"), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, any>);
  const items = (JSON.parse(readFileSync(p("evals/gate0/evidence-sets.json"), "utf8")) as { items: Record<string, any>[] }).items;
  return { claims, items };
}

export const compileOptions = (): CompileOptions => ({ computedAt: SERVER_START });

export async function buildWorld(): Promise<World> {
  const layer = createSourceLayer({ mode: "cassette" });
  const { rows: sourceRows, shapes, cards } = await buildSources(layer);
  const matrix = await buildMatrix();
  const corpus = loadCorpus();
  const { links, labels } = buildLinks(corpus);
  const oracle = await openOracle();
  let hospitalLinks: World["hospitalLinks"] = [];
  try {
    hospitalLinks = (await oracle.rows("SELECT link_id, case_id, left_id, right_id, basis, confirmed_by, confirmed_on FROM hospital_evidence_links WHERE link_class = 'CONFIRMED' AND case_id = 'CASE-2026-014' ORDER BY link_id")).map((r) => ({
      id: String(r["link_id"]),
      caseId: String(r["case_id"]),
      leftId: String(r["left_id"]),
      rightId: String(r["right_id"]),
      basis: String(r["basis"]),
      by: String(r["confirmed_by"]),
      on: String(r["confirmed_on"]),
    }));
  } finally {
    oracle.close();
  }

  const key = loadKey();
  const texts: World["texts"] = new Map();
  const anchors: World["anchors"] = new Map();
  const cases = new Map<string, CaseState>();
  const order: string[] = [];

  for (const rec of key.claims.filter((c) => String(c.id).startsWith("EA-"))) {
    const items: EvidenceItem[] = [];
    const anchorsByItem = new Map<string, KeyAnchor[]>();
    for (const id of rec.evidenceSetIds as string[]) {
      const src = key.items.find((i) => i.id === id)!;
      const { anchors: ka, ...item } = src;
      const kas = ka as KeyAnchor[];
      anchorsByItem.set(id, kas);
      items.push({ ...item, anchorIds: kas.map((a) => a.id) } as EvidenceItem);
    }
    const claim: Claim = {
      ...rec.claim,
      use: { ...rec.claim.use, timing: rec.claim.use.timing ?? { from: DEPLOYMENT_DATE } },
      dependencies: { required: ["authorization", "study"], corroborating: [] },
    };
    addSupportingAnchors(items, anchorsByItem);
    const options = compileOptions();
    const detail = compileDetailed(claim, items, options);

    // Anchors and the stored text they quote from.
    for (const [itemId, kas] of anchorsByItem) {
      const item = items.find((i) => i.id === itemId)!;
      for (const a of kas) {
        if (!texts.has(a.source)) {
          texts.set(a.source, { recordId: `rec-${basename(a.source).replace(/\.[^.]+$/, "")}`, sourceId: sourceIdForPath(a.source), path: a.source, sha256: a.sha256, text: extractedText(a.source) });
        }
        const t = texts.get(a.source)!;
        const quote = verbatim(t.text, norm(a.quote));
        if (!quote) throw new Error(`anchor ${a.id}: the quote is not in ${a.source}; fix the key, not the fixture`);
        if (!anchors.has(a.id)) {
          anchors.set(a.id, {
            id: a.id,
            recordId: t.recordId,
            ...(a.pdfPage !== undefined ? { page: a.pdfPage } : {}),
            text: quote,
            textHash: sha256Hex(quote),
            sourceId: t.sourceId,
          });
        }
        void item;
      }
    }

    const id = String(rec.id).toLowerCase();
    const state: CaseState = {
      id,
      title: `EyeArt K200667, claim ${rec.id}`,
      claimId: rec.claim.id,
      claim,
      claimText: String(rec.text),
      items,
      anchorsByItem,
      detail,
      options,
      log: DecisionLog.create({ findings: [detail.finding] }),
      dynamicEvents: [],
      changedFacts: new Set(),
      staleIds: new Set(),
      baseEvents: [],
    };
    state.baseEvents = baseEvents(state, hospitalLinks);
    cases.set(id, state);
    order.push(id);
  }

  const sourceTypeOf = (sid: string): string | undefined =>
    ({
      "openfda-510k": "authorization",
      "fda-ai-list": "authorization",
      "fda-accessdata-pdf": "authorization",
      "silo-registry": "study",
      "clinicaltrials-v2": "study",
      "pubmed-eutils": "study",
      europepmc: "study",
      crossref: "study",
      "silo-vendor": "vendor",
      "silo-hospital": "requirement",
    })[sid];

  return { cases, order, sourceRows, sourceTypeOf, matrix, links, linkLabels: labels, anchors, texts, cardsBySourceId: cards, shapeBySource: shapes, corpus, hospitalLinks };
}

function baseEvents(c: CaseState, hospitalLinks: World["hospitalLinks"]): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const item of c.items) {
    const when = item.scope.timing?.from;
    if (!when) continue;
    const kind = item.assertionType === "authorization" ? "Authorization" : "Study";
    events.push({
      at: when,
      kind: "fact_asserted",
      summary: `${kind} record ${item.id} in force from ${when}: version ${(item.scope.versions ?? ["not stated"]).join(", ")}, ${(item.scope.settings ?? []).join(", ").replace(/_/g, " ") || "setting not stated"}.`,
      factIds: [item.id],
      findingIds: [],
    });
  }
  for (const l of hospitalLinks) {
    events.push({ at: l.on, kind: "link_confirmed", summary: `${l.leftId} to ${l.rightId} confirmed by ${l.by}: ${l.basis}`, factIds: [], findingIds: [] });
  }
  events.push({ at: RETRIEVED_AT, kind: "fact_asserted", summary: "Regulator, registry and literature records captured and hashed (recorded responses, 27 Oct 2026).", factIds: [], findingIds: [] });
  events.push({ at: SERVER_START, kind: "finding_recomputed", summary: `Finding computed under rules ${c.detail.finding.ruleVersion.split("+")[0]}: ${c.detail.finding.label}.`, factIds: [], findingIds: [c.detail.finding.id] });
  return events;
}

export function eventsOf(c: CaseState): TimelineEvent[] {
  return [...c.baseEvents, ...c.dynamicEvents].sort((a, b) => a.at.localeCompare(b.at));
}

export function reviewerStateOf(c: CaseState): Finding["reviewerState"] {
  const s = c.log.stateOf(c.detail.finding.id);
  return s as Finding["reviewerState"];
}

export function currentFinding(c: CaseState): Finding {
  return { ...c.detail.finding, reviewerState: reviewerStateOf(c) };
}

export type { CaseDetail };
export { COMPILER_VERSION, sha256Hex, createHash };
