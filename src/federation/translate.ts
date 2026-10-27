/**
 * Spark SQL (the Zetaris dialect) to DuckDB translation, for the fallback engine and the oracle.
 *
 * This is deliberately a small allowlist, not a general translator. A construct that is not listed is refused with
 * reason UNTRANSLATABLE; it is never passed through on the hope that both engines agree. Where two engines agree on
 * a construct but differ on an edge, the edge is listed under "known divergences" and the oracle will surface it as
 * a disagreement.
 *
 * Translated
 *   - backquoted names                      `name`            -> "name"
 *   - double-quoted string literals         "text"            -> 'text'      (Spark reads them as strings)
 *   - collect_list(x)                       -> list(x)
 *   - array_join(l, sep)                    -> array_to_string(l, sep)
 *   - nvl(a, b)                             -> coalesce(a, b)
 *   - optimiser hints /*+ ... *\/           -> dropped
 *
 * Passed through unchanged (same meaning in both engines for the cases we use): SELECT, WITH, joins, UNION ALL,
 * GROUP BY, ORDER BY, LIMIT, CASE, CAST, window functions, DATE literals, ||, and the allowlisted functions below.
 *
 * Refused: adjacent string literals ('a' 'b', and the doubled quote in 'it''s', which Spark is understood to read
 * as two literals; not verified on the live engine, so refused rather than merged), concat (Spark returns NULL
 * when any argument is NULL; DuckDB skips it), <=>, ^ (XOR in Spark, power in DuckDB), !, ->, LATERAL VIEW, explode and posexplode, RLIKE and REGEXP, TABLESAMPLE, PIVOT, CLUSTER/DISTRIBUTE/SORT BY,
 * INTERVAL, the `USING <engine>` suffix, current_date and friends (a statement must carry its dates), numeric literal
 * suffixes (1L, 1.5D), a backslash inside a string literal, and any function not in the allowlist.
 *
 * Known divergences (not translated, because there is no faithful rewrite without parsing the expression):
 *   - division by zero: Spark gives NULL, DuckDB gives Infinity or NaN;
 *   - sum() of integers is HUGEINT in DuckDB, BIGINT in Spark: the same digits, a different engine type;
 *   - rounding of binary doubles at exact halves may differ in the last place.
 */
import { PortError } from "../ports/index.ts";
import { prepareStatement, tokenize, type Token } from "./sql.ts";

function refuse(construct: string, why: string): PortError {
  return new PortError("REFUSED", `the fallback engine cannot run this statement: ${construct} ${why}`, { reason: "UNTRANSLATABLE", construct });
}

const RENAMES: Readonly<Record<string, string>> = {
  collect_list: "list",
  array_join: "array_to_string",
  nvl: "coalesce",
};

const ALLOWED_FUNCTIONS: ReadonlySet<string> = new Set([
  "count", "sum", "min", "max", "avg", "coalesce", "nullif", "ifnull", "if", "greatest", "least",
  "lower", "upper", "trim", "ltrim", "rtrim", "length", "substr", "substring", "replace", "concat_ws", "chr",
  "abs", "round", "floor", "ceil", "ceiling", "year", "month", "day",
  "row_number", "rank", "dense_rank",
  "cast", "decimal", "numeric", "varchar", "char",
  ...Object.keys(RENAMES),
]);

/** Words that may legitimately be followed by "(" without being a function call. */
const PAREN_KEYWORDS: ReadonlySet<string> = new Set([
  "IN", "AND", "OR", "NOT", "ON", "AS", "SELECT", "FROM", "WHERE", "JOIN", "UNION", "ALL", "BY", "THEN", "WHEN", "ELSE", "CASE", "END",
  "OVER", "FILTER", "EXISTS", "USING", "VALUES", "WITH", "IS", "LIKE", "BETWEEN", "DISTINCT", "LIMIT", "OFFSET", "HAVING", "GROUP",
  "ORDER", "PARTITION", "ROWS", "RANGE", "INTERSECT", "EXCEPT", "ANY", "SOME", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "OUTER",
]);

const REFUSED_WORDS: Readonly<Record<string, string>> = {
  LATERAL: "(LATERAL VIEW) is Spark-specific",
  EXPLODE: "is Spark-specific",
  POSEXPLODE: "is Spark-specific",
  RLIKE: "has different regular-expression semantics",
  REGEXP: "has different regular-expression semantics",
  TABLESAMPLE: "samples differently on each engine",
  PIVOT: "is Spark-specific",
  UNPIVOT: "is Spark-specific",
  CLUSTER: "(CLUSTER BY) is Spark-specific",
  DISTRIBUTE: "(DISTRIBUTE BY) is Spark-specific",
  SORT: "(SORT BY) is Spark-specific",
  INTERVAL: "literals are written differently on each engine",
  CURRENT_DATE: "is not deterministic; pass the date in the statement",
  CURRENT_TIMESTAMP: "is not deterministic; pass the time in the statement",
  NOW: "is not deterministic; pass the time in the statement",
  CONCAT: "returns NULL on a NULL argument in Spark but skips it in DuckDB; use || with non-null operands",
};

const REFUSED_PUNCT: Readonly<Record<string, string>> = {
  "<=>": "(null-safe equality) has no faithful rewrite without parsing",
  "^": "is XOR in Spark and power in DuckDB",
  "!": "(bare negation) is Spark-specific; write NOT",
  "->": "(lambda) is Spark-specific",
};

const duckString = (content: string): string => `'${content.replace(/'/g, "''")}'`;

function literalContent(token: Token): string {
  const inner = token.text.slice(1, -1);
  if (inner.includes("\\")) throw refuse("a backslash inside a string literal", "has engine-specific escape rules");
  return inner;
}

export function translateSparkToDuckDb(sql: string): string {
  const prepared = prepareStatement(sql);
  const tokens = tokenize(prepared.text, "spark");
  const first = prepared.words[0];
  if (first !== "SELECT" && first !== "WITH") throw refuse(first ?? "(empty)", "statements other than SELECT and WITH are not supported");

  const nextSignificant = (index: number): Token | undefined => {
    for (let k = index + 1; k < tokens.length; k++) {
      const t = tokens[k]!;
      if (t.kind !== "ws" && t.kind !== "comment" && t.kind !== "hint") return t;
    }
    return undefined;
  };

  let out = "";
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    switch (t.kind) {
      case "ws":
        out += " ";
        break;
      case "comment":
      case "hint":
        out += " ";
        break;
      case "string": {
        const content = literalContent(t);
        let k = i + 1;
        while (k < tokens.length && (tokens[k]!.kind === "ws" || tokens[k]!.kind === "comment")) k++;
        if (tokens[k]?.kind === "string") throw refuse("adjacent string literals", "(including a doubled quote) are read differently by the two engines");
        out += duckString(content);
        break;
      }
      case "quoted-ident":
        out += `"${t.text.slice(1, -1).replace(/``/g, "`").replace(/"/g, '""')}"`;
        break;
      case "number":
        if (!/^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t.text)) throw refuse(`the numeric literal ${t.text}`, "uses a Spark type suffix");
        out += t.text;
        break;
      case "punct": {
        const why = REFUSED_PUNCT[t.text];
        if (why) throw refuse(t.text, why);
        out += t.text;
        break;
      }
      case "word": {
        const upper = t.text.toUpperCase();
        const lower = t.text.toLowerCase();
        const refusal = REFUSED_WORDS[upper];
        if (refusal) throw refuse(t.text, refusal);
        const next = nextSignificant(i);
        if (upper === "USING" && next && next.text !== "(") throw refuse("the USING <engine> suffix", "selects a Zetaris engine and has no equivalent");
        if (next?.text === "(" && !PAREN_KEYWORDS.has(upper)) {
          if (!ALLOWED_FUNCTIONS.has(lower)) throw refuse(`the function ${t.text}()`, "is not in the fallback allowlist");
          out += RENAMES[lower] ?? t.text;
        } else {
          out += t.text;
        }
        break;
      }
    }
    i++;
  }
  return out.replace(/ {2,}/g, " ").trim();
}
