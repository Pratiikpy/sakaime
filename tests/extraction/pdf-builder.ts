/**
 * A tiny PDF writer for tests: pages of positioned text in a standard font, so the reading-order and failure paths
 * of the pdfjs reader can be exercised on documents whose content is known exactly.
 */
export interface PdfItem {
  x: number;
  y: number;
  text: string;
  size?: number;
}

export function buildPdf(pages: PdfItem[][]): Uint8Array {
  const objects: string[] = [];
  // 1 catalog, 2 pages, 3 font, then (page, content) pairs
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  objects.push("<< /Type /Catalog /Pages 2 0 R >>");
  objects.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");
  pages.forEach((items, i) => {
    const pageId = 4 + i * 2;
    const contentId = pageId + 1;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`);
    const stream = items
      .map((it) => `BT /F1 ${it.size ?? 11} Tf ${it.x} ${it.y} Td (${it.text.replace(/([\\()])/g, "\\$1")}) Tj ET`)
      .join("\n");
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

/** Lines of one column, top to bottom. */
export function column(x: number, top: number, lines: string[], step = 14): PdfItem[] {
  return lines.map((text, i) => ({ x, y: top - i * step, text }));
}
