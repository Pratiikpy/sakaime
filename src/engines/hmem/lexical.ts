/**
 * The deterministic lexical path. It is what the synchronous API (and therefore the conformance
 * runner) uses: the same text always gives the same vector on every machine, with no network and no
 * model. It is a hashed bag of words. Its cosine measures shared vocabulary, not meaning, so the
 * "semantic" term of the retrieval score is only as semantic as the words overlap. Real semantics
 * come from an injected `Embedder` through the asynchronous path (`queryAsync`).
 */

const DIM = 128;

const STOPWORDS = new Set(
  "a an the is are was were be been being to of in on at for with and or but what which who whom whose does do did how when where why this that these those it its as by from we you they our your their can could would will shall there here than then so if".split(" "),
);

/** Plural folding so that "tool" and "tools", "study" and "studies" meet. Deliberately crude: it must be predictable, not clever. */
function fold(t: string): string {
  if (t.length > 4 && t.endsWith("ies")) return `${t.slice(0, -3)}y`;
  if (t.length > 3 && t.endsWith("s") && !t.endsWith("ss") && !t.endsWith("us") && !t.endsWith("is")) return t.slice(0, -1);
  return t;
}

/**
 * Lower-cased words of two or more characters, without function words, with plurals folded. The
 * same function tokenizes records and queries, so both sides of every comparison agree.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    .map(fold);
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function embed(text: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  for (const token of tokenize(text)) {
    const h = fnv1a(token);
    v[h % DIM]! += (h >>> 16) & 1 ? 1 : -1;
  }
  return normalize(v);
}

export function normalize(v: number[]): number[] {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return n === 0 ? v : v.map((x) => x / n);
}

/** Cosine of two vectors; both are expected to be unit length, and a length mismatch is an error, not a zero. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new RangeError(`cosine: vectors of different length (${a.length} and ${b.length}) come from different embedders`);
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!;
  return dot;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter++;
  return inter / (sa.size + sb.size - inter);
}
