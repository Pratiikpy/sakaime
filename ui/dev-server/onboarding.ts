/**
 * Source onboarding for the fixture server. The stages are real checks over real recorded data:
 * the address goes through the product's own SSRF-safe URL validation, the probe reads the recorded response from the
 * cassette, the mapping is read from the response's actual fields, and the semantic check looks at their actual values.
 * It does not call a model, so the mapping is rule-based and `recorded` is false.
 */
import { createHash } from "node:crypto";
import type { z } from "zod";
import type { OnboardingResultSchema } from "../../src/api/contract.ts";
import { PortError } from "../../src/ports/index.ts";
import { createSourceLayer, shapeFingerprint, validateUrl, type SourceLayer } from "../../src/sources/index.ts";
import { RETRIEVED_AT, type World } from "./world.ts";

type Result = z.infer<typeof OnboardingResultSchema>;
type Stage = Result["stages"][number];
type Mapping = Result["mapping"][number];

const CANON: [RegExp, string, string | undefined][] = [
  [/(^|\.)(brand_name|device_name|product_name)$/i, "product.name", undefined],
  [/(^|\.)(version_or_model_number|software_version|device_version)$/i, "product.version", undefined],
  [/(^|\.)(submission_number|k_number|den_number)$/i, "authorization.submission_id", undefined],
  [/(^|\.)(decision_date|date_received)$/i, "authorization.decision_date", "date"],
  [/(^|\.)(company_name|applicant)$/i, "product.manufacturer", undefined],
  [/(^|\.)product_code$/i, "product.product_code", undefined],
  [/(^|\.)(minimum_age|min_age)(_years)?$/i, "population.age_min", "years"],
  [/(^|\.)(enrollment|enrollmentinfo\.count|enrollment_count)$/i, "study.enrollment", "participants"],
  [/(^|\.)(sensitivity|specificity|auc)$/i, "result.value", "fraction"],
];
const SUSPECT = /(age|date|rate|percent|count|size|value)/i;

function flatten(value: unknown, prefix = "", depth = 0, out: Record<string, unknown> = {}): Record<string, unknown> {
  if (depth > 3 || value === null || value === undefined) return out;
  if (Array.isArray(value)) {
    if (value.length > 0) flatten(value[0], prefix, depth + 1, out);
    return out;
  }
  if (typeof value === "object") {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) flatten(v, prefix ? `${prefix}.${k}` : k, depth + 1, out);
    return out;
  }
  out[prefix] = value;
  return out;
}

function firstRecord(json: unknown): unknown {
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    if (Array.isArray(o["results"]) && o["results"].length > 0) return o["results"][0];
    if (o["protocolSection"]) return o["protocolSection"];
  }
  return json;
}

const stage = (s: Stage["stage"], status: Stage["status"], summary: string, detail?: Record<string, unknown>): Stage => ({ stage: s, status, summary, ...(detail ? { detail } : {}) });
const SKIPPED = (names: Stage["stage"][], why: string): Stage[] => names.map((n) => stage(n, "skipped", why));
const ORDER: Stage["stage"][] = ["authorization", "capability_discovery", "bounded_probe", "mapping_proposal", "semantic_validation", "human_review", "registration", "monitoring"];

export class Onboarder {
  private readonly done = new Map<string, Result>();
  private readonly layer: SourceLayer = createSourceLayer({ mode: "cassette" });

  async run(w: World, req: { description: string; url: string }): Promise<Result> {
    const id = `onb_${createHash("sha256").update(`${req.description.trim()}|${req.url.trim()}`).digest("hex").slice(0, 16)}`;
    const prior = this.done.get(id);
    if (prior) return prior;
    const r = await this.execute(w, id, req);
    this.done.set(id, r);
    return r;
  }

  private async execute(w: World, id: string, req: { description: string; url: string }): Promise<Result> {
    const stages: Stage[] = [];
    const finish = (outcome: Result["outcome"], reason: string | undefined, extra: Partial<Result> = {}): Result => {
      const have = new Set(stages.map((s) => s.stage));
      for (const n of ORDER) if (!have.has(n)) stages.push(stage(n, "skipped", outcome === "declined" ? "Not reached: the source was declined." : "Not reached: the source is on hold."));
      stages.sort((a, b) => ORDER.indexOf(a.stage) - ORDER.indexOf(b.stage));
      return { id, outcome, ...(reason ? { reason } : {}), stages, mapping: [], recorded: false, ...extra };
    };

    // 1. authorization: the product's own URL validation.
    let host = "";
    try {
      const v = validateUrl(req.url, this.layer.allowlist);
      host = v.host;
      stages.push(stage("authorization", "passed", `${v.host} is on the source allowlist (granted by ${v.grantedBy ?? "its source card"}). Only https is read, and addresses inside a network are refused.`, { host: v.host, port: v.port, grantedBy: v.grantedBy, dnsChecked: false }));
    } catch (e) {
      const reason = e instanceof PortError ? e.message : "The address could not be checked.";
      stages.push(stage("authorization", "failed", `Refused before anything was read: ${reason}.`, e instanceof PortError ? { failure: e.failure, ...(e.detail ?? {}) } : undefined));
      return finish("declined", `Refused: ${reason}`);
    }

    // 2. capability discovery: which source card describes this host.
    const card = this.layer.cards.find((c) => c.file.hosts.some((h) => h.host === host));
    if (!card) {
      stages.push(stage("capability_discovery", "failed", "The host is allowed but no source card describes it, so how to read it is unknown."));
      return finish("held_for_review", "No source card describes this host. A person must write one before it can be read.");
    }
    stages.push(stage("capability_discovery", "passed", `Described by the card "${card.file.title}". Identifiers it exposes: ${card.file.identifierFields.join(", ")}.`, { card: card.file.id, supportedPredicates: card.file.supportedPredicates, licence: card.file.license }));

    // 3. bounded probe: one capped read, from the recording in a sample run.
    let json: unknown;
    let bytes = 0;
    let sha = "";
    try {
      const res = await this.layer.fetcher.get(req.url, { maxBytes: 2_000_000 });
      bytes = res.body.byteLength;
      sha = createHash("sha256").update(res.body).digest("hex");
      json = JSON.parse(new TextDecoder().decode(res.body));
      stages.push(stage("bounded_probe", "passed", `Read ${bytes.toLocaleString("en-GB")} bytes (HTTP ${res.status}) from a recording captured ${res.recordedAt?.slice(0, 10) ?? "earlier"}. Nothing was fetched live.`, { status: res.status, bytes, sha256: sha, servedFrom: res.servedFrom }));
    } catch (e) {
      const noRecording = e instanceof PortError && e.detail?.["noRecording"] === true;
      const notJson = e instanceof SyntaxError;
      stages.push(
        stage("bounded_probe", "failed", noRecording ? "No recorded response exists for this exact address, and a sample run makes no live request, so nothing could be read." : notJson ? "The response is not JSON, which this onboarding path cannot map." : `The probe failed: ${e instanceof Error ? e.message : "unknown error"}.`, e instanceof PortError ? { failure: e.failure } : undefined),
      );
      return finish("held_for_review", noRecording ? "The address is allowed but cannot be probed in a sample run. Run live to read it." : "The source could not be read, so it was not mapped.");
    }

    // 4. mapping proposal from the response's real fields.
    const sample = flatten(firstRecord(json));
    const mapping: Mapping[] = [];
    for (const [path, value] of Object.entries(sample)) {
      const hit = CANON.find(([re]) => re.test(path));
      if (hit) {
        const last = path.split(".").pop() ?? path;
        mapping.push({ sourceField: path, canonicalField: hit[1], ...(hit[2] ? { unit: hit[2] } : {}), check: hit[1].endsWith(last) ? "ok" : "renamed" });
      } else if (SUSPECT.test(path) && typeof value !== "object" && typeof value !== "boolean" && !/(^|\.)(has|is)_/.test(path)) {
        mapping.push({ sourceField: path, canonicalField: "unmapped", check: "needs_review", reason: "A field that may matter, but nothing in the vocabulary places it." });
      }
    }
    if (mapping.length === 0) {
      stages.push(stage("mapping_proposal", "failed", "No field in the response could be placed in the vocabulary."));
      return finish("declined", "Nothing in this source maps to a field Sakaime reads.");
    }
    stages.push(stage("mapping_proposal", "passed", `Proposed ${mapping.length} field mapping${mapping.length === 1 ? "" : "s"} from the first record.`, { fields: mapping.length }));

    // 5. semantic validation on the actual values.
    let rejected = 0;
    let review = 0;
    const notes: string[] = [];
    for (const m of mapping) {
      const v = sample[m.sourceField];
      if (m.canonicalField === "population.age_min") {
        const n = typeof v === "number" ? v : Number.parseFloat(String(v));
        if (typeof v === "string" && /month|day|week/i.test(v)) {
          m.check = "rejected";
          m.reason = `The value "${v}" is not in years.`;
        } else if (Number.isFinite(n) && n > 120) {
          m.check = "rejected";
          m.reason = `The value ${n} is not a plausible age in years; it may be months or days.`;
        } else if (typeof v === "string" && /year/i.test(v)) {
          m.check = "renamed";
          m.reason = `The unit is written inside the text ("${v}"); it must be split from the number.`;
        }
      }
      if (m.canonicalField === "result.value" && typeof v === "number" && v > 1) {
        m.check = "needs_review";
        m.reason = `The value ${v} is above 1: a percentage or a fraction? A wrong guess changes a result by a factor of 100.`;
      }
      if (m.check === "rejected") {
        rejected++;
        notes.push(`${m.sourceField}: ${m.reason}`);
      }
      if (m.check === "needs_review") review++;
    }
    stages.push(stage("semantic_validation", rejected > 0 ? "failed" : review > 0 ? "held" : "passed", rejected > 0 ? `${rejected} mapping(s) are type-valid but wrong in meaning and were rejected.` : review > 0 ? `${review} field(s) cannot be settled by a rule and need a person.` : `Checked the values of ${mapping.length} mapped field(s) for unit and range; nothing looked wrong.`, { rejected: notes }));
    if (rejected > 0) return finish("declined", `A mapping was wrong in meaning: ${notes[0]}`, { mapping, schemaHash: shapeFingerprint(json) });
    if (review > 0) {
      stages.push(stage("human_review", "held", `${review} field(s) wait for a reviewer. The source stays unregistered until they decide.`));
      return finish("held_for_review", "Some fields cannot be placed by a rule. A reviewer must confirm them.", { mapping, schemaHash: shapeFingerprint(json) });
    }
    stages.push(stage("human_review", "skipped", "No field needed a person."));

    // 7. registration (idempotent through the onboarding id) and 8. monitoring.
    const schemaHash = shapeFingerprint(json);
    const sourceId = `added-${id.slice(4, 12)}`;
    if (!w.sourceRows.some((s) => s.source.id === sourceId)) {
      w.sourceRows.push({
        source: { id: sourceId, kind: card.file.kind, access: "connector", descriptor: req.description.trim(), license: card.file.license, schemaHash, health: "OK", lastSuccessAt: RETRIEVED_AT, dataClass: card.file.dataClass },
        healthDetail: "Added through the Add-a-source flow. Served from a recorded response; not queried live.",
        authorityNotes: "Authority follows the kind of statement each record makes.",
      });
    }
    stages.push(stage("registration", "passed", `Registered as ${sourceId}. It is not exposed through Zetaris in this sample run.`, { sourceId }));
    stages.push(stage("monitoring", "passed", `Watching the response shape (fingerprint ${schemaHash.slice(0, 12)}). A change will raise DRIFTED and stop the source being read.`, { schemaHash }));
    return finish("registered", undefined, { mapping, sourceId, schemaHash });
  }
}
