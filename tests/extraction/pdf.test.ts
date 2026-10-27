import { describe, expect, it } from "vitest";
import { checkQuoteExists } from "../../src/extraction/document.ts";
import { orderPageItems, type PositionedItem } from "../../src/extraction/layout.ts";
import { readPdf } from "../../src/extraction/pdf.ts";
import { PortError } from "../../src/ports/index.ts";
import { buildPdf, column } from "./pdf-builder.ts";
import { fixtureBytes } from "./helpers.ts";

const item = (str: string, x: number, y: number, width = str.length * 5.5, height = 11): PositionedItem => ({ str, x, y, width, height });

describe("reading order from positioned items", () => {
  it("orders a single column top to bottom and keeps a paragraph gap", () => {
    const r = orderPageItems([item("second", 72, 700), item("first", 72, 720), item("later paragraph", 72, 650)], 612);
    expect(r.lines.map((l) => l.text)).toEqual(["first", "second", "later paragraph"]);
    expect(r.lines[2]?.paragraphBreak).toBe(true);
    expect(r.columns).toBe(false);
  });

  it("keeps a table row as one row with a visible column gap, not as two columns", () => {
    const rows: PositionedItem[] = [];
    for (let i = 0; i < 14; i++) {
      rows.push(item("Sensitivity", 72, 700 - i * 14), item("94.2%", 330, 700 - i * 14), item("(89.6-97.2)", 420, 700 - i * 14));
    }
    const r = orderPageItems(rows, 612);
    expect(r.columns).toBe(false);
    expect(r.lines[0]?.text).toMatch(/^Sensitivity {3}94\.2% {3}\(89\.6-97\.2\)$/);
    expect(r.lines[0]?.hasColumnGap).toBe(true);
  });

  it("reads two real text columns one after the other", () => {
    const items: PositionedItem[] = [];
    for (let i = 0; i < 12; i++) {
      items.push(item(`left column line ${i} with a long run of words that fills most of the column width ok`, 60, 700 - i * 14, 230));
      items.push(item(`right column line ${i} with a long run of words that fills most of the column width`, 330, 700 - i * 14, 230));
    }
    const r = orderPageItems(items, 612);
    expect(r.columns).toBe(true);
    const texts = r.lines.map((l) => l.text);
    expect(texts.slice(0, 12).every((t) => t.startsWith("left"))).toBe(true);
    expect(texts.slice(12).every((t) => t.startsWith("right"))).toBe(true);
  });

  it("does not invent text for an empty page", () => {
    expect(orderPageItems([], 612)).toEqual({ lines: [], columns: false });
    expect(orderPageItems([item("", 72, 700), item("   ", 100, 700, 0)], 612).lines).toEqual([]);
  });
});

describe("pdfjs reader on a constructed PDF", () => {
  it("reads text per page in order with stable page numbers, and flags a page with no text", async () => {
    const pdf = buildPdf([
      [...column(72, 720, ["Indications for Use", "The device detects findings in adults."])],
      [],
      [...column(72, 720, ["Sensitivity was 87.8% (95% CI: 81.2% - 92.5%)."])],
    ]);
    const { doc } = await readPdf("built", pdf);
    expect(doc.pages.map((p) => p.page)).toEqual([1, 2, 3]);
    expect(doc.pages[0]?.text).toBe("Indications for Use\nThe device detects findings in adults.");
    expect(doc.pages[1]?.textLayer).toBe("absent");
    expect(doc.warnings.some((w) => w.includes("page 2 has no text layer"))).toBe(true);
    expect(checkQuoteExists(doc, { quote: "Sensitivity was 87.8%", page: 3 }).exists).toBe(true);
    // line boxes are kept, so an anchor can carry a region
    expect(doc.pages[0]?.lines[0]?.bbox?.[0]).toBeCloseTo(72, 0);
  });

  it("reads two columns in column order", async () => {
    const left = column(60, 720, Array.from({ length: 12 }, (_, i) => `Left column text line ${i} goes on`));
    const right = column(330, 720, Array.from({ length: 12 }, (_, i) => `Right column text line ${i} goes on`));
    const { doc, columnPages } = await readPdf("cols", buildPdf([[...left, ...right]]));
    expect(columnPages).toEqual([1]);
    const text = doc.pages[0]?.text ?? "";
    expect(text.indexOf("Left column text line 11")).toBeLessThan(text.indexOf("Right column text line 0"));
  });
});

describe("pdfjs reader failures are typed, never an empty document", () => {
  const failure = async (bytes: Uint8Array, opts = {}) => {
    try {
      await readPdf("bad", bytes, opts);
    } catch (e) {
      return e;
    }
    return undefined;
  };

  it("rejects empty input, text that is not a PDF, and a truncated PDF as INVALID", async () => {
    for (const bytes of [new Uint8Array(0), new Uint8Array(Buffer.from("this is not a pdf")), buildPdf([column(72, 700, ["x"])]).slice(0, 120)]) {
      const e = await failure(bytes);
      expect(e).toBeInstanceOf(PortError);
      expect((e as PortError).failure).toBe("INVALID");
    }
  });

  it("refuses an oversized file or page count with REFUSED before parsing", async () => {
    const pdf = buildPdf([column(72, 700, ["a"]), column(72, 700, ["b"])]);
    expect(((await failure(pdf, { maxBytes: 100 })) as PortError).failure).toBe("REFUSED");
    expect(((await failure(pdf, { maxPages: 1 })) as PortError).failure).toBe("REFUSED");
  });

  it("does not consume the caller's buffer", async () => {
    const pdf = buildPdf([column(72, 700, ["still here"])]);
    await readPdf("a", pdf);
    expect(pdf.byteLength).toBeGreaterThan(0);
    await readPdf("b", pdf);
  });
});

describe("pdfjs reader on the committed De Novo summary (DEN180001)", () => {
  it("returns 13 pages and finds the indication and the sensitivity sentence on their pages", async () => {
    const { doc } = await readPdf("DEN180001", fixtureBytes("fda", "DEN180001_denovo_summary.pdf"));
    expect(doc.pages).toHaveLength(13);
    expect(doc.pages[0]?.text).toContain("INDICATIONS FOR USE");
    const ifu = checkQuoteExists(doc, { quote: "IDx-DR is indicated for use with the Topcon NW400." });
    expect(ifu).toMatchObject({ exists: true, page: 1 });
    const sens = checkQuoteExists(doc, { quote: "thus observed sensitivity was at 87.4% (95%CI, 81.9% - 92.9%)" });
    expect(sens.exists).toBe(true);
    if (sens.exists) expect(sens.page).toBeGreaterThan(5);
    // the printed label is kept apart from the physical page number
    expect(doc.pages.filter((p) => p.printedLabel).length).toBeGreaterThan(5);
  });
});
