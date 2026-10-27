/**
 * Identifier families: what a K, DEN or P number, an NCT id, a PMID, a DOI and a UDI device identifier look like,
 * how to undo the harmless ways exports mangle them (case, spaces, hyphens, a URL around them), and which
 * families are "weak" because a bare number could be many things.
 *
 * Only lexical changes are undone. A value that lost its prefix ("200667" for K200667) is NOT restored: six digits
 * is also a PMID, a year-and-month, a count. That is a structural change and the mapping is refused.
 */

export interface IdFamily {
  id: string;
  /** Pattern a canonical value matches. */
  pattern: RegExp;
  /** A bare run of digits or similar: a pattern match alone is weak evidence. */
  weak: boolean;
  /** Return the canonical form of a value after only lexical clean-up, or null if it does not become one. */
  canon(raw: string): string | null;
  /** Optional extra test on the canonical form (a check digit). */
  check?(canonical: string): boolean;
}

const strip = (s: string): string => s.trim().replace(/^["'`([<]+|["'`)\]>]+$/g, "").trim();

function gs1Valid(digits: string): boolean {
  if (!/^\d{8}$|^\d{12,14}$/.test(digits)) return false;
  const body = digits.slice(0, -1);
  let sum = 0;
  for (let i = 0; i < body.length; i += 1) {
    const d = Number(body[body.length - 1 - i]);
    sum += d * (i % 2 === 0 ? 3 : 1);
  }
  return (10 - (sum % 10)) % 10 === Number(digits[digits.length - 1]);
}

export const ID_FAMILIES: readonly IdFamily[] = [
  {
    id: "submission_number",
    pattern: /^(K\d{6}|DEN\d{6}|P\d{6}(S\d{3})?)$/,
    weak: false,
    canon(raw) {
      const s = strip(raw)
        .replace(/^(510\(?k\)?|fda)[\s:#-]*/i, "")
        .replace(/[\s_-]+/g, "")
        .toUpperCase();
      return /^(K\d{6}|DEN\d{6}|P\d{6}(S\d{3})?)$/.test(s) ? s : null;
    },
  },
  {
    id: "nct_id",
    pattern: /^NCT\d{8}$/,
    weak: false,
    canon(raw) {
      let s = strip(raw);
      const url = /clinicaltrials\.gov\/(?:ct2\/show|study)\/(NCT\d{8})/i.exec(s);
      if (url) s = url[1]!;
      s = s.replace(/[\s_-]+/g, "").toUpperCase();
      return /^NCT\d{8}$/.test(s) ? s : null;
    },
  },
  {
    id: "pmid",
    pattern: /^[1-9]\d{0,8}$/,
    weak: true,
    canon(raw) {
      let s = strip(raw);
      const url = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d+)/i.exec(s) ?? /ncbi\.nlm\.nih\.gov\/pubmed\/(\d+)/i.exec(s);
      if (url) s = url[1]!;
      s = s.replace(/^pmid[\s:#-]*/i, "").trim();
      return /^[1-9]\d{0,8}$/.test(s) ? s : null;
    },
  },
  {
    id: "doi",
    pattern: /^10\.\d{4,9}\/\S+$/,
    weak: false,
    canon(raw) {
      let s = strip(raw);
      s = s.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, "").replace(/^doi[\s:]*/i, "").trim();
      return /^10\.\d{4,9}\/\S+$/.test(s) ? s.toLowerCase() : null;
    },
  },
  {
    id: "udi_di",
    pattern: /^(\d{8}|\d{12,14})$/,
    weak: false,
    canon(raw) {
      const s = strip(raw).replace(/^\(01\)/, "").replace(/[\s-]+/g, "");
      return /^(\d{8}|\d{12,14})$/.test(s) ? s : null;
    },
    check: gs1Valid,
  },
  {
    id: "product_code",
    pattern: /^[A-Z]{3}$/,
    weak: false,
    canon(raw) {
      const s = strip(raw).replace(/\s+/g, "").toUpperCase();
      return /^[A-Z]{3}$/.test(s) ? s : null;
    },
  },
];

export const idFamily = (id: string): IdFamily | undefined => ID_FAMILIES.find((f) => f.id === id);

/** Does a value, without any clean-up, already look like this family? */
export function matchesAsWritten(family: IdFamily, raw: string): boolean {
  const s = raw.trim();
  return family.pattern.test(s) && (family.check ? family.check(s) : true);
}

/** The canonical form of a value in this family after lexical clean-up, or null. */
export function canonicalise(family: IdFamily, raw: string): string | null {
  const c = family.canon(raw);
  if (c === null) return null;
  if (family.check && !family.check(c)) return null;
  return c;
}

/** Families a value is a valid member of after clean-up. Used to name what a mis-mapped column actually holds. */
export function familiesOf(raw: string): string[] {
  return ID_FAMILIES.filter((f) => !f.weak && canonicalise(f, raw) !== null).map((f) => f.id);
}
