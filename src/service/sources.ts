/**
 * The service's view of the source layer.
 *
 *   live      every request goes through the SSRF-safe fetcher and spends the card's request budget
 *   record    the same, and each final response is also written into the sample source cassette
 *   sample    every request is answered from recordings: this service's own cassette first, then the earlier
 *             public-evidence cassette from the feasibility probe
 *
 * The connectors, response classification and contract checks are identical in all three, so a replay exercises the
 * code a live read does. A request with no recording is an error that says so; nothing is invented.
 *
 * FDA decision summaries are read through a DocumentProvider. Live, that is the fda-pdf connector and the pdfjs reader.
 * In a replay it is the committed document manifest: the EyeArt summary is the real PDF read by pdfjs; the other two
 * are the text layer extracted from the real PDF with pdftotext, because the PDFs themselves are not kept in the repository.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { PortError, type Connector } from "../ports/index.ts";
import { documentFromPages, readPdf } from "../extraction/index.ts";
import type { DocumentText } from "../extraction/types.ts";
import {
  CassetteFetcher,
  CassetteStore,
  RecordingFetcher,
  SafeFetcher,
  allowlistFromCards,
  createSourceLayer,
  loadSourceCards,
  type ConnectorReadResult,
  type Fetcher,
  type FetchInit,
  type FetchResult,
  type SourceLayer,
} from "../sources/index.ts";
import { defaultCardsDir } from "../sources/cards.ts";
import { sha256Hex } from "../util/canonical.ts";
import { replaysSources, type ServiceConfig } from "./config.ts";

/** Tries each fetcher in turn; a "no recording" miss moves on, anything else is the answer. */
export class ChainFetcher implements Fetcher {
  readonly servedFrom = "recorded" as const;
  constructor(private readonly fetchers: readonly Fetcher[]) {}

  async get(url: string, init?: FetchInit): Promise<FetchResult> {
    let miss: PortError | undefined;
    for (const f of this.fetchers) {
      try {
        return await f.get(url, init);
      } catch (error) {
        if (error instanceof PortError && error.failure === "UNAVAILABLE" && error.detail?.["noRecording"] === true) {
          miss ??= error;
          continue;
        }
        throw error;
      }
    }
    throw miss ?? new PortError("UNAVAILABLE", `no recording for ${url}`, { noRecording: true, retryable: false });
  }
}

export interface SourceSetup {
  layer: SourceLayer;
  /** The store being written, in record mode. Call save() when the run is done. */
  recording?: CassetteStore;
}

export function createSources(config: ServiceConfig, overrides: { fetcher?: Fetcher } = {}): SourceSetup {
  const cardsDir = defaultCardsDir();
  if (overrides.fetcher) return { layer: createSourceLayer({ mode: config.sample ? "cassette" : "live", fetcher: overrides.fetcher, cardsDir, stateDir: config.dirs.state, clock: config.clock }) };

  const cards = loadSourceCards(cardsDir);
  const allowlist = allowlistFromCards(cards);

  if (replaysSources(config)) {
    const stores: Fetcher[] = [];
    if (existsSync(join(config.dirs.sourceCassette, "index.json"))) stores.push(new CassetteFetcher(CassetteStore.load(config.dirs.sourceCassette), allowlist));
    stores.push(new CassetteFetcher(CassetteStore.load(config.dirs.publicCassette), allowlist));
    if (!config.record) return { layer: createSourceLayer({ mode: "cassette", fetcher: new ChainFetcher(stores), cardsDir, stateDir: config.dirs.state, clock: config.clock }) };
    // Recording against the committed recordings: a request they answer is replayed, so the evidence does not move. A request they
    // do not answer (a search the planning model proposed this time) is made live once and recorded, so the sample run can replay it.
    const store = existsSync(join(config.dirs.sourceCassette, "index.json"))
      ? CassetteStore.load(config.dirs.sourceCassette)
      : CassetteStore.create(config.dirs.sourceCassette, "sakaime-case-run-2026-10-27", "Responses made while the Sakaime case pipeline ran against the live public sources. Public records only.");
    stores.push(new RecordingFetcher(new SafeFetcher({ allowlist }), store, { overwrite: false, ref: "sakaime-service", now: () => config.clock.now() }));
    return { layer: createSourceLayer({ mode: "cassette", fetcher: new ChainFetcher(stores), cardsDir, stateDir: config.dirs.state, clock: config.clock }), recording: store };
  }

  const live = new SafeFetcher({ allowlist });
  if (config.record) {
    const store = existsSync(join(config.dirs.sourceCassette, "index.json"))
      ? CassetteStore.load(config.dirs.sourceCassette)
      : CassetteStore.create(config.dirs.sourceCassette, "sakaime-case-run-2026-10-27", "Responses made while the Sakaime case pipeline ran against the live public sources. Public records only.");
    const recorder = new RecordingFetcher(live, store, { overwrite: true, ref: "sakaime-service", now: () => config.clock.now() });
    // Decision-summary PDFs are large and are kept as documents (see RecordedDocuments), not as cassette bodies.
    const fetcher: Fetcher = { servedFrom: "live", get: (url, init) => (new URL(url).hostname === "www.accessdata.fda.gov" ? live.get(url, init) : recorder.get(url, init)) };
    return { layer: createSourceLayer({ mode: "live", fetcher, cardsDir, stateDir: config.dirs.state, clock: config.clock }), recording: store };
  }
  return { layer: createSourceLayer({ mode: "live", fetcher: live, cardsDir, stateDir: config.dirs.state, clock: config.clock }) };
}

// ---------------------------------------------------------------- FDA decision summaries

export interface SummaryDocument {
  submission: string;
  /** Identity of the stored record: a stable id the anchors name. */
  recordId: string;
  doc: DocumentText;
  /** sha256 of the stored bytes (the PDF, or the recorded text layer). */
  contentHash: string;
  /** sha256 of the extracted text, which the dossier snapshot stores. */
  textHash: string;
  retrievedAt: string;
  servedFrom: "live" | "recorded";
  sourceUrl: string;
  /** Plain statement of how the text was obtained, for the source row and the dossier. */
  provenance: string;
}

export interface DocumentProvider {
  readonly servedFrom: "live" | "recorded";
  /** Throws PortError: UNAVAILABLE, DRIFTED, BLOCKED, INVALID. A missing summary is not an empty one. */
  summary(submission: string): Promise<SummaryDocument>;
}

const ManifestSchema = z.object({
  version: z.literal(1),
  description: z.string(),
  entries: z.array(
    z.object({
      submission: z.string(),
      kind: z.enum(["pdf", "text"]),
      /** Relative to the repository root. */
      path: z.string(),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.number().int().positive(),
      sourceUrl: z.string().url(),
      recordedAt: z.string().datetime({ offset: true }),
      note: z.string(),
    }),
  ),
});
export type DocumentManifest = z.infer<typeof ManifestSchema>;

export function documentRecordId(submission: string): string {
  return `fda-summary:${submission}`;
}

/** Splits pdftotext output into pages on form feeds, as the extraction tests do. */
function pagesOfText(text: string): { page: number; text: string }[] {
  const pages = text.split("\f");
  if (pages.length > 1 && pages[pages.length - 1]!.trim() === "") pages.pop();
  return pages.map((t, i) => ({ page: i + 1, text: t }));
}

export class RecordedDocuments implements DocumentProvider {
  readonly servedFrom = "recorded" as const;
  private readonly manifest: DocumentManifest;

  constructor(
    private readonly root: string,
    manifestPath: string,
  ) {
    if (!existsSync(manifestPath)) throw new PortError("UNAVAILABLE", `document manifest not found: ${manifestPath}`, { noRecording: true, retryable: false });
    const parsed = ManifestSchema.safeParse(JSON.parse(readFileSync(manifestPath, "utf8")));
    if (!parsed.success) throw new PortError("DRIFTED", `document manifest is malformed: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    this.manifest = parsed.data;
  }

  has(submission: string): boolean {
    return this.manifest.entries.some((e) => e.submission === submission);
  }

  async summary(submission: string): Promise<SummaryDocument> {
    const entry = this.manifest.entries.find((e) => e.submission === submission);
    if (!entry) throw new PortError("UNAVAILABLE", `no recorded decision summary for ${submission}`, { noRecording: true, retryable: false });
    const path = join(this.root, entry.path);
    if (!existsSync(path)) throw new PortError("UNAVAILABLE", `recorded document ${entry.path} is missing`, { noRecording: true, retryable: false });
    const bytes = new Uint8Array(readFileSync(path));
    const actual = sha256Hex(bytes);
    if (actual !== entry.sha256 || bytes.length !== entry.bytes) {
      throw new PortError("DRIFTED", `recorded document ${entry.path} no longer matches its manifest hash`, { expected: entry.sha256, actual });
    }
    const recordId = documentRecordId(submission);
    const doc =
      entry.kind === "pdf"
        ? (await readPdf(recordId, bytes)).doc
        : documentFromPages(recordId, pagesOfText(new TextDecoder("utf-8", { fatal: false }).decode(bytes)), "text");
    return {
      submission,
      recordId,
      doc,
      contentHash: actual,
      textHash: sha256Hex(doc.text),
      retrievedAt: entry.recordedAt,
      servedFrom: "recorded",
      sourceUrl: entry.sourceUrl,
      provenance: entry.kind === "pdf" ? `recorded PDF read with pdfjs (${entry.note})` : `recorded text layer of the PDF (${entry.note})`,
    };
  }
}

export class LiveDocuments implements DocumentProvider {
  readonly servedFrom = "live" as const;
  constructor(private readonly connector: Connector) {}

  async summary(submission: string): Promise<SummaryDocument> {
    const read = (await this.connector.read({ query: { submission_number: submission } })) as ConnectorReadResult;
    const record = read.records[0];
    if (read.health === "EMPTY" || !record) {
      throw new PortError("UNAVAILABLE", `no decision summary PDF was found at the FDA for ${submission}; an absent file is not an empty search`, { submission, notFound: true });
    }
    const content = read.contents.get(record.id);
    if (!content) throw new PortError("DRIFTED", `the connector returned no document bytes for ${submission}`);
    const recordId = documentRecordId(submission);
    const doc = (await readPdf(recordId, content.bytes)).doc;
    const url = (record.payload as { provenance?: { finalUrl?: string; url?: string } } | undefined)?.provenance;
    return {
      submission,
      recordId,
      doc,
      contentHash: record.contentHash,
      textHash: sha256Hex(doc.text),
      retrievedAt: record.retrievedAt,
      servedFrom: read.servedFrom === "recorded" ? "recorded" : "live",
      sourceUrl: url?.finalUrl ?? url?.url ?? "https://www.accessdata.fda.gov/cdrh_docs/",
      provenance: `${read.servedFrom === "recorded" ? "recorded" : "live"} PDF read with pdfjs`,
    };
  }
}
