/**
 * Statement handling for the federation layer: tokenising, normalisation, the one-statement rule, the read-only
 * policy, and the only sanctioned ways to put a value or a name into SQL text.
 *
 * Why the string escaping looks unusual. Spark SQL (the Zetaris dialect) treats a backslash inside a quoted
 * string as an escape and, as we understand it, reads a doubled quote as two adjacent literals that concatenate
 * (`'it''s'` would be `its`; not verified on the live engine). DuckDB (the oracle) does the opposite. Any
 * escaping scheme that is right for one engine is wrong for the other, so values containing a quote or a
 * backslash are never escaped at all: they are assembled from pieces with chr(39) and chr(92), and every quoted
 * piece is free of both characters. The same text then means the same thing on both engines whichever way Spark
 * reads a doubled quote, and no input can end a literal early.
 */
import { PortError } from "../ports/index.ts";
import { sha256Hex } from "../util/canonical.ts";
import { isRealDate } from "./cast.ts";

export const MAX_STATEMENT_CHARS = 200_000;

export type TokenKind = "ws" | "comment" | "hint" | "string" | "quoted-ident" | "word" | "number" | "punct";

export interface Token {
  kind: TokenKind;
  text: string;
  /** Character offset in the source text. */
  start: number;
}

type EscapeMode = "spark" | "standard";

function invalid(message: string, detail?: Record<string, unknown>): PortError {
  return new PortError("INVALID", message, detail);
}

const MULTI_PUNCT = ["<=>", "<=", ">=", "<>", "!=", "==", "||", "::", "->"];

/**
 * Split SQL text into tokens without interpreting it. In "spark" mode a backslash escapes the next character in
 * a quoted string and double quotes delimit strings; in "standard" mode a doubled quote is the escape and double
 * quotes delimit identifiers. Used twice so that an input the two readings disagree about can be refused.
 */
export function tokenize(sql: string, mode: EscapeMode = "spark"): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i]!;
    const start = i;
    const next = sql[i + 1];
    if (/\s/.test(c)) {
      while (i < n && /\s/.test(sql[i]!)) i++;
      out.push({ kind: "ws", text: sql.slice(start, i), start });
    } else if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") i++;
      out.push({ kind: "comment", text: sql.slice(start, i), start });
    } else if (c === "/" && next === "*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) throw invalid("unterminated block comment", { offset: start });
      i = end + 2;
      out.push({ kind: sql[start + 2] === "+" ? "hint" : "comment", text: sql.slice(start, i), start });
    } else if (c === "'" || c === '"') {
      i++;
      let closed = false;
      while (i < n) {
        const ch = sql[i]!;
        if (mode === "spark" && ch === "\\") {
          i += 2;
          continue;
        }
        if (ch === c) {
          if (mode === "standard" && sql[i + 1] === c) {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw invalid("unterminated quoted text", { offset: start });
      out.push({ kind: c === '"' && mode === "standard" ? "quoted-ident" : "string", text: sql.slice(start, i), start });
    } else if (c === "`") {
      i++;
      let closed = false;
      while (i < n) {
        if (sql[i] === "`") {
          if (sql[i + 1] === "`") {
            i += 2;
            continue;
          }
          i++;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) throw invalid("unterminated quoted identifier", { offset: start });
      out.push({ kind: "quoted-ident", text: sql.slice(start, i), start });
    } else if (/[\p{L}_]/u.test(c)) {
      while (i < n && /[\p{L}\p{N}_$]/u.test(sql[i]!)) i++;
      out.push({ kind: "word", text: sql.slice(start, i), start });
    } else if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(next ?? ""))) {
      while (i < n && /[0-9.]/.test(sql[i]!)) i++;
      if (/[eE]/.test(sql[i] ?? "") && /[0-9+-]/.test(sql[i + 1] ?? "")) {
        i += 2;
        while (i < n && /[0-9]/.test(sql[i]!)) i++;
      }
      while (i < n && /[A-Za-z_]/.test(sql[i]!)) i++;
      out.push({ kind: "number", text: sql.slice(start, i), start });
    } else {
      const three = sql.slice(i, i + 3);
      const two = sql.slice(i, i + 2);
      const op = MULTI_PUNCT.find((m) => m === three) ?? MULTI_PUNCT.find((m) => m === two) ?? c;
      i += op.length;
      out.push({ kind: "punct", text: op, start });
    }
  }
  return out;
}

const isTrivia = (t: Token): boolean => t.kind === "ws" || t.kind === "comment";

export interface PreparedStatement {
  /** Normalised text sent to the engine: trivia collapsed, trailing semicolons removed. */
  text: string;
  /** Upper-cased word tokens that sit outside quotes, in order. */
  words: string[];
  /** True for the documented `COMPILE USL ... DDL` form, the one statement that legitimately holds semicolons. */
  multiDdl: boolean;
  /** Upper-cased names written as a function call (a name, backquoted or not, followed by an opening bracket), outside quotes. */
  calls: string[];
  /** Upper-cased file formats used as a table qualifier in front of a backquoted path, which reads a file by path. */
  fileScans: string[];
}

/**
 * Validate and normalise one statement.
 *  - empty text is refused;
 *  - trailing semicolons are removed (the engine refuses them);
 *  - any other semicolon outside quotes is a second statement and is refused, except in `COMPILE USL ... DDL`
 *    where every later segment must itself begin `CREATE TABLE`;
 *  - text the Spark and standard-SQL readings tokenise differently around a semicolon is refused as ambiguous.
 */
export function prepareStatement(sql: string): PreparedStatement {
  if (typeof sql !== "string") throw invalid("statement must be a string");
  if (sql.length > MAX_STATEMENT_CHARS) throw invalid(`statement is longer than ${MAX_STATEMENT_CHARS} characters`);
  if (sql.includes("\u0000")) throw invalid("statement contains a NUL character");

  const spark = tokenize(sql, "spark");
  const standard = tokenize(sql, "standard");
  const semis = (tokens: Token[]): number[] => tokens.filter((t) => t.kind === "punct" && t.text === ";").map((t) => t.start);
  const a = semis(spark);
  const b = semis(standard);
  if (a.length !== b.length || a.some((v, k) => v !== b[k])) {
    throw invalid("statement has quoting that is read differently by Spark SQL and standard SQL around a semicolon; refused as ambiguous", {
      reason: "AMBIGUOUS_QUOTING",
    });
  }

  const significant = spark.filter((t) => !isTrivia(t));
  let lastIdx = significant.length - 1;
  while (lastIdx >= 0 && significant[lastIdx]!.kind === "punct" && significant[lastIdx]!.text === ";") lastIdx--;
  if (lastIdx < 0) throw invalid("empty statement");
  const body = significant.slice(0, lastIdx + 1);
  const words = body.filter((t) => t.kind === "word").map((t) => t.text.toUpperCase());
  const internal = body.filter((t) => t.kind === "punct" && t.text === ";");
  const multiDdl = words[0] === "COMPILE" && words[1] === "USL";
  const { calls, fileScans } = scanReach(body);

  if (internal.length > 0) {
    if (!multiDdl) throw invalid("more than one statement in a request; send one statement per call", { reason: "MULTI_STATEMENT" });
    assertDdlSegments(body);
  }

  const lastTokenEnd = body[body.length - 1]!;
  const cutoff = lastTokenEnd.start + lastTokenEnd.text.length;
  // Whitespace and comments between tokens collapse to one space (or one newline in COMPILE USL, where each
  // CREATE TABLE must start a line). This happens per token, never by a text-wide replace, which would also
  // rewrite the inside of string literals.
  let text = "";
  let gap = "";
  for (const t of spark) {
    if (t.start >= cutoff) break;
    if (t.kind === "ws" || t.kind === "comment") {
      gap = gap === "\n" || (multiDdl && t.kind === "ws" && t.text.includes("\n")) ? "\n" : " ";
    } else {
      if (text !== "") text += gap;
      gap = "";
      text += t.text;
    }
  }
  return { text, words, multiDdl, calls, fileScans };
}

/** The name a token spells as an identifier: a word, or a backquoted identifier with the backquotes removed. */
function identName(t: Token | undefined): string | undefined {
  if (!t) return undefined;
  if (t.kind === "word") return t.text.toUpperCase();
  if (t.kind === "quoted-ident" && t.text.startsWith("`")) return t.text.slice(1, -1).replaceAll("``", "`").toUpperCase();
  return undefined;
}

/**
 * Function calls and file-path table references among the significant tokens. Comments and whitespace between the
 * name and the bracket do not hide a call, and a name inside a quoted string is not one.
 */
function scanReach(body: readonly Token[]): { calls: string[]; fileScans: string[] } {
  const calls: string[] = [];
  const fileScans: string[] = [];
  body.forEach((t, i) => {
    const name = identName(t);
    if (name === undefined) return;
    const next = body[i + 1];
    if (next?.kind === "punct" && next.text === "(") calls.push(name);
    const after = body[i + 2];
    if (next?.kind === "punct" && next.text === "." && after?.kind === "quoted-ident" && after.text.startsWith("`") && FILE_FORMATS.has(name)) fileScans.push(name);
  });
  return { calls, fileScans };
}

function assertDdlSegments(body: Token[]): void {
  const segments: string[][] = [[]];
  for (const t of body) {
    if (t.kind === "punct" && t.text === ";") segments.push([]);
    else if (t.kind === "word") segments[segments.length - 1]!.push(t.text.toUpperCase());
  }
  segments.slice(1).forEach((seg, k) => {
    if (seg.length === 0) return;
    if (seg[0] !== "CREATE" || seg[1] !== "TABLE") {
      throw invalid(`COMPILE USL segment ${k + 2} is not a CREATE TABLE statement; refused`, { reason: "MULTI_STATEMENT" });
    }
  });
}

/** The key a cassette is stored under: the normalised statement and the identity that ran it. */
export function statementKey(normalised: string, identity: string): string {
  return sha256Hex(`${normalised}\u0000${identity}`);
}

// ---------------------------------------------------------------- read-only policy

const READ_ONLY_FIRST: ReadonlySet<string> = new Set(["SELECT", "WITH", "SHOW", "DESCRIBE", "DESC", "EXPLAIN", "VALUES"]);
const READ_ONLY_PAIRS: ReadonlySet<string> = new Set(["LOAD USL", "RUN DQ", "LIST DQ"]);
const MUTATING_WORDS: ReadonlySet<string> = new Set([
  "INSERT", "UPDATE", "DELETE", "DROP", "ALTER", "CREATE", "MERGE", "TRUNCATE", "GRANT", "REVOKE", "COPY", "ATTACH", "REGISTER",
  // SELECT ... INTO creates a table in some dialects.
  "INTO",
]);

/**
 * Words that may follow EXPLAIN before the statement it explains. What is explained must itself be a read: an engine that
 * runs the statement under EXPLAIN ANALYZE would otherwise run a setup or maintenance command for the agent identity.
 */
const EXPLAIN_MODIFIERS: ReadonlySet<string> = new Set(["EXTENDED", "FORMATTED", "COST", "CODEGEN", "LOGICAL", "VERBOSE", "ANALYZE"]);

/**
 * Functions the agent identity may not call, even inside a SELECT. Two kinds, both reaching beyond the tables it was
 * granted. Dynamic execution: the Spark reflection functions call any static method on the engine's JVM, and
 * call_function and call_udf name a function by a string that a word list cannot see. File and network reach: the table
 * functions of the Spark-compatible and DuckDB dialects that read a path or URL, and the PostgreSQL ones that read a
 * server file or open a connection to another host. A function is refused by name wherever it is called; a column or table
 * that merely has the same name is not a call and is not refused.
 */
const DENIED_FUNCTIONS: ReadonlySet<string> = new Set([
  // dynamic execution
  "REFLECT", "JAVA_METHOD", "TRY_REFLECT", "CALL_FUNCTION", "CALL_UDF", "QUERY", "QUERY_TABLE",
  // files and URLs
  "READ_CSV", "READ_CSV_AUTO", "READ_JSON", "READ_JSON_AUTO", "READ_NDJSON", "READ_NDJSON_AUTO", "READ_PARQUET", "PARQUET_SCAN",
  "PARQUET_METADATA", "PARQUET_SCHEMA", "READ_TEXT", "READ_BLOB", "READ_XLSX", "READ_FILES", "GLOB", "SNIFF_CSV", "ST_READ",
  "ICEBERG_SCAN", "DELTA_SCAN", "OPENROWSET", "OPENQUERY", "OPENDATASOURCE",
  // other databases and servers
  "SQLITE_SCAN", "POSTGRES_SCAN", "MYSQL_SCAN", "DBLINK", "DBLINK_EXEC", "PG_READ_FILE", "PG_READ_BINARY_FILE", "PG_LS_DIR", "LO_IMPORT", "LO_EXPORT",
]);

/** File formats that Spark SQL accepts as a qualifier in front of a backquoted path, as in SELECT * FROM csv.`/path`. */
const FILE_FORMATS: ReadonlySet<string> = new Set(["CSV", "JSON", "PARQUET", "ORC", "TEXT", "AVRO", "DELTA", "ICEBERG", "BINARYFILE", "XML"]);

/**
 * The agent identity must never mutate. A statement passes only when it starts with a read verb and holds no
 * mutating keyword anywhere outside quotes (a CTE can precede an INSERT, so the first word alone is not enough).
 * Administrative setup (COMPILE USL, ACTIVATE USL TABLE, REGISTER DQ) needs an explicit `statementPolicy: "admin"`.
 */
export function assertReadOnly(prepared: PreparedStatement): void {
  const first = prepared.words[0] ?? "";
  const pair = `${first} ${prepared.words[1] ?? ""}`;
  if (!READ_ONLY_FIRST.has(first) && !READ_ONLY_PAIRS.has(pair)) {
    throw new PortError("REFUSED", `statement beginning ${first || "(none)"} is not read-only; use the admin policy for setup statements`, {
      reason: "NOT_READ_ONLY",
      verb: first,
    });
  }
  const bad = prepared.words.find((w) => MUTATING_WORDS.has(w));
  if (bad) {
    throw new PortError("REFUSED", `statement contains ${bad}, which the read-only policy does not allow`, { reason: "NOT_READ_ONLY", verb: bad });
  }
  if (first === "EXPLAIN") {
    const inner = prepared.words.slice(1).find((w) => !EXPLAIN_MODIFIERS.has(w));
    if (inner === undefined || !READ_ONLY_FIRST.has(inner) || inner === "EXPLAIN") {
      throw new PortError("REFUSED", `EXPLAIN is allowed only in front of a read; it was followed by ${inner ?? "nothing"}`, { reason: "NOT_READ_ONLY", verb: inner ?? "EXPLAIN" });
    }
  }
  const denied = prepared.calls.find((c) => DENIED_FUNCTIONS.has(c));
  if (denied) {
    throw new PortError("REFUSED", `the function ${denied} is not allowed under the read-only policy: it runs code on the engine or reaches files or other hosts`, {
      reason: "DENIED_FUNCTION",
      function: denied,
    });
  }
  const scan = prepared.fileScans[0];
  if (scan) {
    throw new PortError("REFUSED", `a table reference that is a file path (${scan.toLowerCase()}.\`...\`) is not allowed under the read-only policy`, { reason: "FILE_SCAN", format: scan });
  }
}

// ---------------------------------------------------------------- the only way to put names and values into SQL

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Words that need backquotes when used as a name. Conservative: quoting a non-reserved word is harmless. */
const RESERVED = new Set(
  (
    "all and any array as asc between by case cast check column constraint create cross current_date current_time current_timestamp " +
    "current_user default desc distinct else end except exists false fetch filter for foreign from full grant group having in inner " +
    "intersect into is join leading left like limit minus natural not null offset on only or order outer over partition primary " +
    "range references right rows select some table then to trailing true union unique user using values when where window with"
  ).split(" "),
);

export function isSafeIdent(name: string): boolean {
  return IDENT_RE.test(name);
}

/** A table, column or database name. Anything outside letters, digits and underscore is refused, never escaped. */
export function sqlIdent(name: string): string {
  if (!IDENT_RE.test(name)) throw invalid(`"${name.slice(0, 40)}" is not a valid SQL name (letters, digits and underscore only)`, { reason: "BAD_IDENTIFIER" });
  return RESERVED.has(name.toLowerCase()) ? `\`${name}\`` : name;
}

export function sqlQualified(...parts: string[]): string {
  if (parts.length === 0) throw invalid("a qualified name needs at least one part");
  return parts.map(sqlIdent).join(".");
}

/**
 * A string value as portable SQL. Plain text becomes 'text'. Text containing a single quote or a backslash is
 * built as ('a' || chr(39) || 'b' || chr(92) || 'c'): see the file comment for why nothing is escaped.
 */
export function sqlString(value: string): string {
  if (typeof value !== "string") throw invalid("expected a string value");
  if (value.includes("\u0000")) throw invalid("a NUL character cannot appear in a SQL value");
  if (value.length > 10_000) throw invalid("a SQL string value is limited to 10000 characters");
  if (!/['\\]/.test(value)) return `'${value}'`;
  const pieces: string[] = [];
  let run = "";
  const flush = (): void => {
    if (run !== "") pieces.push(`'${run}'`);
    run = "";
  };
  for (const ch of value) {
    if (ch === "'") {
      flush();
      pieces.push("chr(39)");
    } else if (ch === "\\") {
      flush();
      pieces.push("chr(92)");
    } else {
      run += ch;
    }
  }
  flush();
  return pieces.length === 1 ? pieces[0]! : `(${pieces.join(" || ")})`;
}

export function sqlNumber(value: number): string {
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalid("a SQL number must be finite");
  if (Number.isInteger(value) && !Number.isSafeInteger(value)) throw invalid("integer is outside the exactly representable range");
  const text = String(value);
  return value < 0 ? `(${text})` : text;
}

export function sqlBoolean(value: boolean): string {
  return value ? "TRUE" : "FALSE";
}

/** `DATE 'YYYY-MM-DD'` for a real calendar date; nothing else is accepted. */
export function sqlDate(value: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m || !isRealDate(Number(m[1]), Number(m[2]), Number(m[3]))) throw invalid(`"${String(value).slice(0, 20)}" is not a YYYY-MM-DD date`, { reason: "BAD_DATE" });
  return `DATE '${value}'`;
}

export type SqlValue = string | number | boolean | null;

export function sqlValue(value: SqlValue): string {
  if (value === null) return "NULL";
  if (typeof value === "string") return sqlString(value);
  if (typeof value === "number") return sqlNumber(value);
  return sqlBoolean(value);
}

/** `(a, b, c)` for an IN list. An empty list is refused rather than turned into an always-false guess. */
export function sqlList(values: readonly SqlValue[]): string {
  if (values.length === 0) throw invalid("an IN list cannot be empty");
  if (values.length > 5_000) throw invalid("an IN list is limited to 5000 values");
  return `(${values.map(sqlValue).join(", ")})`;
}
