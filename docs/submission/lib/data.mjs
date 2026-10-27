// Reads the repository's own result files. Nothing on a slide is typed in when a file holds it:
// numbers come from JSON through `stat()`, or from Markdown through `grab()`, which throws if the sentence it reads from has changed.
import { readFileSync, existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
export const SUB = resolve(ROOT, "docs", "submission");

const cache = new Map();
export function text(rel) {
  if (!cache.has(rel)) {
    const p = resolve(ROOT, rel);
    if (!existsSync(p)) throw new Error(`deck source missing: ${rel}`);
    cache.set(rel, readFileSync(p, "utf8"));
  }
  return cache.get(rel);
}
export function json(rel) {
  const key = `json:${rel}`;
  if (!cache.has(key)) cache.set(key, JSON.parse(text(rel)));
  return cache.get(key);
}

/** The first capture group of `re` in the file, as a string. Throws when the sentence is not there. */
export function grab(rel, re, label = "") {
  const m = text(rel).match(re);
  if (!m) throw new Error(`deck fact not found${label ? ` (${label})` : ""}: ${re} in ${rel}`);
  return m[1];
}
export const grabInt = (rel, re, label) => Number(grab(rel, re, label).replace(/,/g, ""));

/** A `{k, n, rate}` summary from a results file; `path` is the flat key in `summaries`. */
export function stat(rel, key) {
  const sums = json(rel).summaries ?? {};
  let s = sums[key];
  if (!s) s = key.split(".").reduce((o, k) => (o == null ? o : o[k]), sums);
  if (!s) throw new Error(`summary not found: ${key} in ${rel}`);
  return s;
}

export const kn = (s) => `${s.k} of ${s.n}`;
export const pct = (v, d = 1) => `${(v * 100).toFixed(d)}%`;
export const pctOf = (s, d = 1) => pct(s.rate, d);
export const num = (n) => Number(n).toLocaleString("en-US");

/** Rows of the first markdown table under a heading match, as arrays of trimmed cells. */
export function mdTable(rel, headingRe) {
  const lines = text(rel).split(/\r?\n/);
  const at = lines.findIndex((l) => headingRe.test(l));
  if (at < 0) throw new Error(`heading not found: ${headingRe} in ${rel}`);
  const rows = [];
  let started = false;
  for (let i = at + 1; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith("|")) {
      started = true;
      rows.push(l.split("|").slice(1, -1).map((c) => c.trim()));
    } else if (started) break;
  }
  return rows.filter((r) => !/^:?-{2,}/.test(r[0] ?? ""));
}
