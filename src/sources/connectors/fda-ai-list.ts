/**
 * The FDA list of AI-enabled medical devices.
 *
 * The live list sits behind bot protection: on 2026-10-27 curl and urllib were redirected to an abuse-detection
 * page, and a Node request made later the same day was served. Because that is not dependable, reads come from a
 * hashed snapshot pinned in the repository, and every answer says so: the snapshot's own "current as of" date,
 * the day it was captured, its age, and that it is stale by construction. A row that is not in it means "not in
 * the snapshot dated D"; it never means the device is absent from the FDA list, and FDA itself calls the list
 * not comprehensive.
 *
 * `check()` makes the one live request and reports what happened (BLOCKED, UNAVAILABLE, or reachable and
 * identical to or different from the pin). With `preferLive`, `read()` tries that request first and falls back to
 * the snapshot on any failure, saying which.
 */
import { parse as parseCsv } from "csv-parse/sync";
import { PortError, systemClock, type CheckResult, type Clock, type Connector, type ReadRequest, type SourceCard } from "../../ports/index.ts";
import type { EvidenceRecord } from "../../schemas/evidence.ts";
import { hashOf, sha256Hex } from "../../util/canonical.ts";
import type { LoadedCard } from "../cards.ts";
import { requestHashOf } from "../cassette.ts";
import type { Fetcher, FetchResult } from "../fetcher.ts";
import { classifyError, classifyResponse } from "../health.ts";
import type { RateLimiter } from "../limiter.ts";
import type { LoadedSnapshot } from "../snapshot.ts";
import { expectKeys, invalid, lastModifiedIso, limitOf, textValue, type ConnectorReadResult, type RecordPayload, type ServedFromMode } from "./common.ts";

export interface AiListRow {
  decisionDate: string;
  decisionDateIso?: string;
  submissionNumber: string;
  submissionType: "510k" | "denovo" | "pma" | "unknown";
  device: string;
  /** Present when the Device cell packs several devices separated by semicolons. */
  devicesInCell?: string[];
  company: string;
  panel: string;
  productCode: string;
}

export interface SnapshotInfo {
  id: string;
  sha256: string;
  /** The date FDA's page says the list is current as of. */
  contentCurrentAsOf: string;
  capturedOn: string;
  sourceLastModified: string;
  ageDays: number;
  stale: true;
  reason: string;
}

export interface AiListContext {
  /** Used by check(), and by read() when preferLive is set. Omit for a snapshot-only connector. */
  fetcher?: Fetcher;
  limiter?: RateLimiter;
  clock?: Clock;
  preferLive?: boolean;
}

const HEADER = ["Date of Final Decision", "Submission Number", "Device", "Company", "Panel (Lead)", "Primary Product Code"];
const normalise = (s: string): string => s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "");

function typeOf(number: string): AiListRow["submissionType"] {
  if (/^K\d/.test(number)) return "510k";
  if (/^DEN\d/.test(number)) return "denovo";
  if (/^P\d/.test(number)) return "pma";
  return "unknown";
}

export function parseAiListCsv(bytes: Uint8Array): AiListRow[] {
  const records = parseCsv(Buffer.from(bytes), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
  const first = records[0];
  if (!first || HEADER.some((h) => !(h in first))) {
    throw new PortError("DRIFTED", `the FDA AI-list CSV no longer has the expected columns (${HEADER.join(", ")})`, { health: "DRIFTED" });
  }
  return records.map((r) => {
    const date = r["Date of Final Decision"]!;
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date);
    const device = r["Device"]!;
    const submission = r["Submission Number"]!.trim();
    return {
      decisionDate: date,
      ...(m ? { decisionDateIso: `${m[3]}-${m[1]}-${m[2]}` } : {}),
      submissionNumber: submission,
      submissionType: typeOf(submission),
      device,
      ...(device.includes(";") ? { devicesInCell: device.split(";").map((d) => d.trim()).filter(Boolean) } : {}),
      company: r["Company"]!,
      panel: r["Panel (Lead)"]!,
      productCode: r["Primary Product Code"]!,
    };
  });
}

export class FdaAiListConnector implements Connector {
  readonly card: SourceCard;
  private readonly clock: Clock;
  private parsedSnapshot: AiListRow[] | undefined;

  constructor(
    private readonly loaded: LoadedCard,
    private readonly snapshot: LoadedSnapshot,
    private readonly ctx: AiListContext = {},
  ) {
    this.card = loaded.card;
    this.clock = ctx.clock ?? systemClock;
  }

  describe(): SourceCard {
    return this.card;
  }

  private snapshotRows(): AiListRow[] {
    return (this.parsedSnapshot ??= parseAiListCsv(this.snapshot.bytes));
  }

  private snapshotInfo(reason: string): SnapshotInfo {
    const m = this.snapshot.manifest;
    const ageDays = Math.max(0, Math.floor((this.clock.now().getTime() - Date.parse(`${m.contentCurrentAsOf}T00:00:00Z`)) / 86_400_000));
    return { id: m.id, sha256: m.sha256, contentCurrentAsOf: m.contentCurrentAsOf, capturedOn: m.capturedOn, sourceLastModified: m.sourceLastModified, ageDays, stale: true, reason };
  }

  /** The one live request, redirects not followed so a bot-protection redirect is seen as what it is. */
  private async liveFetch(): Promise<FetchResult> {
    const fetcher = this.ctx.fetcher;
    if (!fetcher) throw new PortError("UNAVAILABLE", "no live fetcher is configured for the FDA AI list", { retryable: false });
    const limiter = fetcher.servedFrom === "live" ? this.ctx.limiter : undefined;
    if (limiter) await limiter.acquire();
    try {
      return await fetcher.get(this.card.baseUrl, { redirect: "manual", maxBytes: 4 * 1024 * 1024, headers: { accept: "text/csv,*/*" } });
    } finally {
      limiter?.release();
    }
  }

  async check(): Promise<CheckResult> {
    const started = performance.now();
    const checkedAt = this.clock.now().toISOString();
    const done = (health: CheckResult["health"], detail: string): CheckResult => ({ health, detail, latencyMs: Math.round(performance.now() - started), checkedAt });
    const pin = this.snapshotInfo("pinned snapshot");
    const pinned = `pinned snapshot (current as of ${pin.contentCurrentAsOf}, captured ${pin.capturedOn}, sha256 ${pin.sha256.slice(0, 12)})`;
    try {
      const res = await this.liveFetch();
      const c = classifyResponse({ family: "fda-list", status: res.status, headers: res.headers, body: res.body });
      if (c.health === "OK") {
        if (sha256Hex(res.body) === pin.sha256) return done("OK", `live list reachable (${res.servedFrom}) and byte-identical to the ${pinned}`);
        const liveModified = lastModifiedIso(res.headers["last-modified"]) ?? "unknown";
        return done("STALE", `live list reachable (${res.servedFrom}) but differs from the pin: live last-modified ${liveModified}, ${pinned}; refresh the snapshot`);
      }
      if (c.health === "BLOCKED") return done("BLOCKED", `${c.reason}. Serving the ${pinned}, treated as a stale snapshot and never as absence`);
      return done(c.health === "INVALID" ? "DRIFTED" : (c.health as CheckResult["health"]), `${c.reason}. The ${pinned}`);
    } catch (err) {
      const c = classifyError(err);
      return done((c.health === "INVALID" ? "DRIFTED" : c.health) as CheckResult["health"], `${c.reason}. The ${pinned}`);
    }
  }

  async discover(): Promise<{ sample: unknown[]; schemaHash: string }> {
    const rows = this.snapshotRows();
    return { sample: rows.slice(0, 3), schemaHash: hashOf({ source: this.card.id, columns: this.snapshot.manifest.columns }) };
  }

  async read(request: ReadRequest): Promise<ConnectorReadResult> {
    expectKeys(request.query, ["submission_number", "product_code", "company", "device", "panel"], "fda-ai-list");
    const numbers = textValue(request.query, "submission_number", 2000)?.split(",").map((s) => s.trim().toUpperCase());
    const code = textValue(request.query, "product_code", 3)?.toUpperCase();
    const company = textValue(request.query, "company");
    const device = textValue(request.query, "device");
    const panel = textValue(request.query, "panel");
    if (code !== undefined && !/^[A-Z]{3}$/.test(code)) throw invalid(`"product_code" must be three letters such as QAS; got "${code}"`);
    const limit = limitOf(request.limit, 2000, 2000);
    const filters = { ...(numbers ? { submission_number: numbers } : {}), ...(code ? { product_code: code } : {}), ...(company ? { company } : {}), ...(device ? { device } : {}), ...(panel ? { panel } : {}) };

    let source: ServedFromMode = "snapshot";
    let rows = this.snapshotRows();
    let bytes: Uint8Array = this.snapshot.bytes;
    let fellBack: string | undefined;
    let live: FetchResult | undefined;
    if (this.ctx.preferLive && this.ctx.fetcher) {
      try {
        const res = await this.liveFetch();
        const c = classifyResponse({ family: "fda-list", status: res.status, headers: res.headers, body: res.body });
        if (c.health === "OK") {
          live = res;
          rows = parseAiListCsv(res.body);
          bytes = res.body;
          source = res.servedFrom;
        } else fellBack = `${c.health}: ${c.reason}`;
      } catch (err) {
        fellBack = classifyError(err).reason;
      }
    }

    const matches = rows.filter(
      (r) =>
        (!numbers || numbers.includes(r.submissionNumber.toUpperCase())) &&
        (!code || r.productCode === code) &&
        (!company || normalise(r.company).includes(normalise(company))) &&
        (!device || normalise(r.device).includes(normalise(device))) &&
        (!panel || normalise(r.panel).includes(normalise(panel))),
    );
    const returned = matches.slice(0, limit);
    const health = returned.length === 0 ? "EMPTY" : "OK";
    const fromSnapshot = source === "snapshot";

    const m = this.snapshot.manifest;
    const info = fromSnapshot ? this.snapshotInfo(fellBack ? `live fetch failed (${fellBack})` : "pinned snapshot; the live list is not fetched by default because scripted access is unreliable") : undefined;
    const retrievedAt = fromSnapshot ? `${m.capturedOn}T00:00:00.000Z` : (live!.recordedAt ?? this.clock.now().toISOString());
    const requestHash = fromSnapshot ? hashOf({ method: "GET", url: this.card.baseUrl, snapshot: m.sha256, filters }) : hashOf({ request: requestHashOf(this.card.baseUrl), filters });
    const contentHash = sha256Hex(bytes);
    const emptyMeaning =
      health === "EMPTY"
        ? fromSnapshot
          ? `none found in the pinned FDA AI-list snapshot current as of ${m.contentCurrentAsOf}; the snapshot is not the live list and FDA calls the list not comprehensive, so this does not show the device is absent from the FDA list`
          : `none found in the FDA AI list as fetched (${source}); FDA calls the list not comprehensive`
        : undefined;

    const payload: RecordPayload & { body: { columns: string[]; totalRows: number; matched: number; filters: typeof filters; filteredBy: string; rows: AiListRow[] }; provenance: RecordPayload["provenance"] & { snapshot?: SnapshotInfo } } = {
      provenance: {
        sourceId: this.card.id,
        operation: "read",
        url: this.card.baseUrl,
        finalUrl: this.card.baseUrl,
        status: fromSnapshot ? 200 : live!.status,
        contentType: "text/csv",
        servedFrom: source,
        health,
        queryForm: "structured",
        ...(emptyMeaning ? { emptyMeaning } : {}),
        ...(info ? { snapshot: info } : {}),
        ...(live?.recordedAt ? { recordedAt: live.recordedAt } : {}),
      },
      body: {
        columns: m.columns,
        totalRows: rows.length,
        matched: matches.length,
        filters,
        filteredBy: "connector (the source cannot filter; the predicates were applied here to the full list)",
        rows: returned,
      },
    };
    const record: EvidenceRecord = {
      id: `${this.card.id}:${requestHash.slice(0, 12)}:${contentHash.slice(0, 12)}`,
      sourceId: this.card.id,
      retrievedAt,
      sourcePublishedAt: lastModifiedIso(live?.headers["last-modified"]) ?? m.sourceLastModified,
      requestHash,
      contentHash,
      schemaVersion: `${this.card.id}/v${this.loaded.file.schemaVersion}`,
      license: this.card.license,
      payload,
    };

    const notes: string[] = [];
    if (info) {
      notes.push(`served from the pinned snapshot current as of ${info.contentCurrentAsOf} (captured ${info.capturedOn}, ${info.ageDays} days old); handled as a stale snapshot`);
      notes.push("the FDA list is not a comprehensive resource, so a missing row is never evidence of absence");
    }
    if (fellBack) notes.push(`the live list was tried first and failed: ${fellBack}`);
    if (matches.length > returned.length) notes.push(`partial read: ${returned.length} of ${matches.length} matching rows returned`);
    if (emptyMeaning) notes.push(emptyMeaning);
    if (returned.some((r) => r.devicesInCell)) notes.push("some rows pack several devices into one Device cell separated by semicolons; see devicesInCell");

    return {
      health,
      records: [record],
      servedFrom: source,
      complete: matches.length === returned.length,
      total: matches.length,
      returned: returned.length,
      notes,
      contents: new Map(),
    };
  }
}
