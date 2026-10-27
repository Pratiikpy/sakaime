// Placeholder expansion shared by the composition and the Node scripts (voice, timeline, number check).
// A template may hold {key}, {key:k}, {key:n}, {key:kw}, {key:nw}, {key:pct}, {key:w}. Nothing else is expanded.

export type Figure =
  | { kind: "kn"; k: number; n: number; source: string; path: string }
  | { kind: "meanWorst"; mean: number; worst: number; runs: number; source: string; path: string }
  | { kind: "value"; value: unknown; source: string; path: string };

export type Figures = Record<string, Figure>;

const WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve",
  "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen", "twenty",
];

export function numberWord(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n >= WORDS.length) return String(n);
  return WORDS[n] as string;
}

export function expand(template: string, figures: Figures, extra: Record<string, number> = {}): string {
  return template.replace(/\{([a-zA-Z0-9_.-]+)(?::([a-z]+))?\}/g, (whole, key: string, mod?: string) => {
    if (key in extra) {
      const v = extra[key] as number;
      return mod === "w" ? numberWord(v) : String(v);
    }
    const f = figures[key];
    if (!f) throw new Error(`no figure "${key}" for placeholder ${whole}`);
    if (f.kind === "kn") {
      switch (mod) {
        case undefined: return `${f.k} of ${f.n}`;
        case "k": return String(f.k);
        case "n": return String(f.n);
        case "kw": return numberWord(f.k);
        case "nw": return numberWord(f.n);
        case "pct": return String(Math.round((f.k / f.n) * 100));
        default: throw new Error(`modifier ${mod} not valid for ${key}`);
      }
    }
    if (f.kind === "meanWorst") {
      if (mod === "pct" || mod === undefined) return String(Math.round(f.mean * 100));
      if (mod === "worst") return String(Math.round(f.worst * 100));
      throw new Error(`modifier ${mod} not valid for ${key}`);
    }
    const v = f.value;
    if (typeof v !== "number") return String(v);
    return mod === "w" ? numberWord(v) : String(v);
  });
}

/** The placeholders a template uses, so the checker can name the figures a sentence depends on. */
export function placeholdersOf(template: string): string[] {
  return [...template.matchAll(/\{([a-zA-Z0-9_.-]+)(?::[a-z]+)?\}/g)].map((m) => m[1] as string);
}
