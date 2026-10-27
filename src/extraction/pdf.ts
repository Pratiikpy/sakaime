import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { PortError } from "../ports/index.ts";
import { documentFromPages, repairGlyphs, type PageInput } from "./document.ts";
import { orderPageItems, type PositionedItem } from "./layout.ts";
import type { DocumentText, TextLine } from "./types.ts";

/** pdf.js is loaded once, from its Node-compatible "legacy" build. */
type PdfJs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjsPromise: Promise<PdfJs> | undefined;
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import("pdfjs-dist/legacy/build/pdf.mjs");
  return pdfjsPromise;
}

function assetUrl(sub: string): string {
  const require = createRequire(import.meta.url);
  const pkg = require.resolve("pdfjs-dist/package.json");
  return pathToFileURL(join(dirname(pkg), sub)).href + "/";
}

export interface PdfOptions {
  /** Refuse files larger than this many bytes before parsing. Default 60 MB. */
  maxBytes?: number;
  /** Refuse documents with more pages than this. Default 600. */
  maxPages?: number;
}

export interface PdfExtraction {
  doc: DocumentText;
  /** Pages for which column mode was used, for diagnostics. */
  columnPages: number[];
}

/**
 * Read a PDF into the document model: reading-order text per page, stable physical page numbers, a character-offset
 * map and per-line boxes. Scanned pages come back with no text and are flagged; there is no OCR here, so nothing is
 * invented for them.
 *
 * Failure is typed: an unreadable or encrypted file raises PortError("INVALID") with the cause, never an empty
 * document, so "the file could not be read" cannot be mistaken for "the file says nothing".
 */
export async function readPdf(recordId: string, bytes: Uint8Array, options: PdfOptions = {}): Promise<PdfExtraction> {
  const maxBytes = options.maxBytes ?? 60 * 1024 * 1024;
  if (bytes.byteLength === 0) throw new PortError("INVALID", "empty PDF");
  if (bytes.byteLength > maxBytes) throw new PortError("REFUSED", `PDF is ${bytes.byteLength} bytes, over the ${maxBytes} byte limit`);
  const head = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  if (!head.includes("%PDF-")) throw new PortError("INVALID", "not a PDF: no %PDF- header in the first 1 KB");

  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({
    // pdf.js transfers the buffer to its worker; pass a copy so the caller's bytes stay usable.
    data: new Uint8Array(bytes),
    useSystemFonts: false,
    disableFontFace: true,
    standardFontDataUrl: assetUrl("standard_fonts"),
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    verbosity: 0,
  });

  let pdf: Awaited<typeof task.promise>;
  try {
    pdf = await task.promise;
  } catch (error) {
    const name = (error as { name?: string }).name ?? "Error";
    const msg = error instanceof Error ? error.message : String(error);
    throw new PortError("INVALID", `PDF could not be opened (${name}): ${msg}`, { cause: name });
  }

  try {
    const maxPages = options.maxPages ?? 600;
    if (pdf.numPages > maxPages) throw new PortError("REFUSED", `PDF has ${pdf.numPages} pages, over the ${maxPages} page limit`);

    const pages: PageInput[] = [];
    let repaired = 0;
    const columnPages: number[] = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const view = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items: PositionedItem[] = [];
      for (const it of content.items) {
        if (!("str" in it)) continue;
        const t = it.transform as number[];
        items.push({ str: it.str, x: t[4] as number, y: t[5] as number, width: it.width, height: it.height });
      }
      const ordered = orderPageItems(items, view.width);
      if (ordered.columns) columnPages.push(n);

      let text = "";
      const lines: TextLine[] = [];
      ordered.lines.forEach((line, i) => {
        if (i > 0) text += line.paragraphBreak ? "\n\n" : "\n";
        const fixed = repairGlyphs(line.text);
        repaired += fixed.replaced;
        lines.push({ start: text.length, end: text.length + fixed.text.length, bbox: line.bbox });
        text += fixed.text;
      });
      pages.push({ text, lines, textLayer: text.trim().length > 0 ? "present" : "absent" });
      page.cleanup();
    }
    const doc = documentFromPages(recordId, pages, "pdf");
    if (repaired > 0) {
      doc.warnings.push(`${repaired} ligature glyphs that the font maps to the wrong letters were repaired (U+019F to "ti", U+014C to "ft"); the stored text is the repaired text`);
    }
    return { doc, columnPages };
  } finally {
    await task.destroy();
  }
}
