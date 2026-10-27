// Shared helpers for the Gate 0 evidence tools: hashing, source loading, quote anchoring.
// A quote is "anchored" when its whitespace-collapsed ASCII form occurs in the whitespace-collapsed ASCII
// form of the cited source. Non-ASCII characters are dropped from both sides because pdftotext renders
// registered marks, dashes and bullets as replacement characters.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const gate0Root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repoRoot = resolve(gate0Root, "..", "..");

export const sha256File = (rel) => createHash("sha256").update(readFileSync(join(repoRoot, rel))).digest("hex");

const xmlDecode = (s) =>
  s
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)));

export const squash = (s) => s.replace(/[^\x00-\x7f]/g, "").replace(/\s+/g, " ").trim();

/** Returns the source as an array of pages (form-feed separated) of squashed text. */
export function loadPages(rel) {
  let text = readFileSync(join(repoRoot, rel), "utf8");
  if (rel.endsWith(".xml")) text = xmlDecode(text);
  // JSON sources are matched in canonical minified form: quote them as "key":"value".
  if (rel.endsWith(".json")) text = JSON.stringify(JSON.parse(text)).replace(/\\n/g, " ").replace(/\\"/g, '"');
  return text.split("\f").map(squash);
}

/** Pages (1-based) on which the quote occurs; empty array when it does not occur. */
export function locate(rel, quote) {
  // "[...]" inside a quote means "text omitted"; every part must occur, in order, on the same page.
  const parts = quote.split("[...]").map(squash).filter(Boolean);
  const hits = [];
  loadPages(rel).forEach((p, i) => {
    let from = 0;
    const ok = parts.every((part) => {
      const at = p.indexOf(part, from);
      if (at < 0) return false;
      from = at + part.length;
      return true;
    });
    if (ok) hits.push(i + 1);
  });
  return hits;
}

/** The printed "Page N of M" label of a pdftotext page, when present. */
export function pageLabel(rel, pdfPage) {
  const m = loadPages(rel)[pdfPage - 1]?.match(/Page (\d+) of (\d+)/);
  return m ? `${m[1]} of ${m[2]}` : null;
}

export const wilson = (k, n, z = 1.959964) => {
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = p + (z * z) / (2 * n);
  const m = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return [(c - m) / d, (c + m) / d];
};

export const pct = (k, n) => Math.round((1000 * k) / n) / 10;
export const manifestHashes = () => {
  const md = readFileSync(join(repoRoot, "research", "feasibility", "fixtures", "MANIFEST.md"), "utf8");
  const map = new Map();
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    const m = line.match(/^\| ((?:fda|ctgov|openfda|pubmed|europepmc)\/[^ |]+) \|.*\| ([0-9a-f]{64}) \|$/);
    if (m) map.set(m[1], m[2]);
  }
  return map;
};
