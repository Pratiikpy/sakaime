/**
 * Unified Semantic Layer (USL) and data-quality statements, and the completeness rule.
 *
 * Recipe (docs/11-channel-intel.md s2; commands reference s13 and s14; open_data/usl in the Zetaris getting-started
 * repository): compile the whole USL DDL in ONE request, activate each table with its own ACTIVATE USL TABLE using
 * explicit casts, then RUN DQ TABLE. Compile, activate and register are administrator-only on the engine, so these
 * statements are for the `admin` statement policy and a privileged identity; the read-only agent identity only
 * ever runs RUN DQ and queries the activated tables.
 *
 * The completeness rule is the data-quality form of one product rule: a collection that was cut short feeds nothing
 * downstream. It is expressed twice, as a DQ rule over a manifest table (so the platform reports it) and as a code
 * check (so nothing depends on the platform being reachable). Both treat "cannot tell" as not complete.
 *
 * Not verified by us on the live engine: the output headers of RUN DQ. The Zetaris example scripts describe the
 * counts as total_records, valid_records and invalid_records; the parser accepts those and short forms, and fails as
 * DRIFTED when none is present.
 */
import { PortError, type FederationResult } from "../ports/index.ts";
import { sqlBoolean, sqlIdent, sqlQualified, sqlString } from "./sql.ts";

const NAMESPACE_ROOT = ["lightning", "metastore"] as const;
const TYPE_RE = /^(varchar\(\d{1,4}\)|char\(\d{1,4}\)|string|int|integer|bigint|smallint|tinyint|double|float|boolean|date|timestamp|decimal\(\d{1,2},\d{1,2}\))$/i;

function invalid(message: string, reason: string): PortError {
  return new PortError("INVALID", message, { reason });
}

function usableType(type: string): string {
  if (!TYPE_RE.test(type.trim())) throw invalid(`"${type.slice(0, 40)}" is not a scalar USL column type`, "BAD_TYPE");
  return type.trim().toLowerCase();
}

/** `lightning.metastore.<namespace>`. */
export function namespacePath(namespace: string): string {
  return sqlQualified(...NAMESPACE_ROOT, namespace);
}

export function buildCreateNamespaceSql(namespace: string): string[] {
  return [`CREATE NAMESPACE IF NOT EXISTS ${sqlQualified(...NAMESPACE_ROOT)}`, `CREATE NAMESPACE IF NOT EXISTS ${namespacePath(namespace)}`];
}

export interface UslColumn {
  name: string;
  type: string;
  notNull?: boolean;
  primaryKey?: boolean;
  references?: { table: string; column: string };
}

export interface UslTable {
  name: string;
  columns: UslColumn[];
}

export interface CompileUslSpec {
  usl: string;
  namespace: string;
  tables: UslTable[];
  /** Default true. Without DEPLOY the engine returns the model and stores nothing. */
  deploy?: boolean;
  ifNotExists?: boolean;
}

/** The whole `COMPILE USL ... DDL` statement, one CREATE TABLE per line, to be sent as a single request. */
export function buildCompileUslSql(spec: CompileUslSpec): string {
  if (spec.tables.length === 0) throw invalid("a USL needs at least one table", "EMPTY_USL");
  const ddl = spec.tables.map((table) => {
    if (table.columns.length === 0) throw invalid(`table ${table.name} has no columns`, "EMPTY_TABLE");
    const cols = table.columns.map((c) => {
      const parts = [sqlIdent(c.name), usableType(c.type)];
      if (c.notNull || c.primaryKey) parts.push("NOT NULL");
      if (c.primaryKey) parts.push("PRIMARY KEY");
      if (c.references) parts.push(`FOREIGN KEY REFERENCES ${sqlIdent(c.references.table)}(${sqlIdent(c.references.column)})`);
      return `  ${parts.join(" ")}`;
    });
    return `CREATE TABLE ${sqlIdent(table.name)} (\n${cols.join(",\n")}\n)`;
  });
  const head = `COMPILE USL ${spec.ifNotExists ? "IF NOT EXISTS " : ""}${sqlIdent(spec.usl)}${spec.deploy === false ? "" : " DEPLOY"} NAMESPACE ${namespacePath(spec.namespace)} DDL`;
  return `${head}\n${ddl.join(";\n")}`;
}

export interface ActivateColumn {
  name: string;
  type: string;
  /** Source column when it differs from the USL column name. */
  from?: string;
  /**
   * The engine requires a non-null expression for a NOT NULL column. A sentinel makes a missing value visible as
   * a value that a data-quality rule can reject, instead of dropping the row. Without one, nulls fail activation.
   */
  nullSentinel?: string | number;
}

export interface ActivateSpec {
  namespace: string;
  usl: string;
  table: string;
  /** The source table the USL table is bound to: [database, table]. */
  source: readonly [string, string];
  columns: ActivateColumn[];
}

/** ACTIVATE USL TABLE with explicit casts and no WHERE clause: activation never filters rows silently. */
export function buildActivateUslTableSql(spec: ActivateSpec): string {
  if (spec.columns.length === 0) throw invalid("activation needs at least one column", "EMPTY_TABLE");
  const select = spec.columns.map((c) => {
    const source = sqlIdent(c.from ?? c.name);
    const inner = c.nullSentinel === undefined ? source : `COALESCE(${source}, ${typeof c.nullSentinel === "number" ? String(c.nullSentinel) : sqlString(c.nullSentinel)})`;
    return `CAST(${inner} AS ${usableType(c.type)}) AS ${sqlIdent(c.name)}`;
  });
  return `ACTIVATE USL TABLE ${uslTablePath(spec)} AS SELECT ${select.join(", ")} FROM ${sqlQualified(...spec.source)}`;
}

export function uslTablePath(spec: { namespace: string; usl: string; table: string }): string {
  return sqlQualified(...NAMESPACE_ROOT, spec.namespace, spec.usl, spec.table);
}

// ---------------------------------------------------------------- rule expressions

/** A boolean expression built only from named columns and literals, so a rule cannot carry arbitrary SQL. */
export class DqExpression {
  private constructor(readonly sql: string) {}
  static of(sql: string): DqExpression {
    return new DqExpression(sql);
  }
}

export const dqNotNull = (column: string): DqExpression => DqExpression.of(`${sqlIdent(column)} IS NOT NULL`);
export const dqEqualsBoolean = (column: string, value: boolean): DqExpression => DqExpression.of(`${sqlIdent(column)} = ${sqlBoolean(value)}`);
export const dqAtLeast = (column: string, other: string): DqExpression => DqExpression.of(`${sqlIdent(column)} >= ${sqlIdent(other)}`);
export const dqAnd = (...parts: DqExpression[]): DqExpression => {
  if (parts.length === 0) throw invalid("dqAnd needs at least one condition", "EMPTY_RULE");
  return DqExpression.of(parts.map((p) => p.sql).join(" AND "));
};

export interface RegisterDqSpec {
  rule: string;
  namespace: string;
  usl: string;
  table: string;
  expression: DqExpression;
}

/** No row alias and no window function: both are rejected by the engine (companion s8.6). */
export function buildRegisterDqSql(spec: RegisterDqSpec): string {
  return `REGISTER DQ ${sqlIdent(spec.rule)} TABLE ${uslTablePath(spec)} AS ${spec.expression.sql}`;
}

export function buildRunDqSql(spec: { namespace: string; usl: string; table: string; rule?: string }): string {
  return `RUN DQ ${spec.rule === undefined ? "" : `${sqlIdent(spec.rule)} `}TABLE ${uslTablePath(spec)}`;
}

export function buildListDqSql(namespace: string, usl: string): string {
  return `LIST DQ USL ${sqlQualified(...NAMESPACE_ROOT, namespace, usl)}`;
}

export function buildLoadUslSql(namespace: string, usl: string): string {
  return `LOAD USL ${sqlIdent(usl)} NAMESPACE ${namespacePath(namespace)}`;
}

// ---------------------------------------------------------------- completeness

/** One row per collection a connector landed as a snapshot: what the source said exists and what arrived. */
export const COMPLETENESS_MANIFEST: UslTable = {
  name: "collection_manifest",
  columns: [
    { name: "collection_id", type: "varchar(200)", primaryKey: true },
    { name: "source_id", type: "varchar(100)" },
    { name: "expected_total", type: "bigint" },
    { name: "retrieved_total", type: "bigint" },
    { name: "truncated", type: "boolean" },
  ],
};

export const COMPLETENESS_RULE = "collection_complete";

/**
 * A manifest row is valid only when the source reported a total, the whole total arrived and the connector did not
 * flag truncation. A missing value makes the row invalid: a missing value cannot show completeness.
 */
export function completenessExpression(): DqExpression {
  return dqAnd(dqNotNull("expected_total"), dqNotNull("retrieved_total"), dqAtLeast("retrieved_total", "expected_total"), dqEqualsBoolean("truncated", false));
}

export function buildRegisterCompletenessRuleSql(namespace: string, usl: string): string {
  return buildRegisterDqSql({ rule: COMPLETENESS_RULE, namespace, usl, table: COMPLETENESS_MANIFEST.name, expression: completenessExpression() });
}

export function buildRunCompletenessSql(namespace: string, usl: string): string {
  return buildRunDqSql({ namespace, usl, table: COMPLETENESS_MANIFEST.name, rule: COMPLETENESS_RULE });
}

export interface DqRuleResult {
  rule?: string;
  total: number;
  valid: number;
  invalid: number;
}

const DQ_TOTAL = ["total_records", "total", "totalrecords", "total_count"];
const DQ_VALID = ["valid_records", "valid", "validrecords", "valid_count"];
const DQ_INVALID = ["invalid_records", "invalid", "invalidrecords", "invalid_count"];
const DQ_RULE = ["rule", "rule_name", "name", "constraint"];

function find(columns: readonly string[], candidates: readonly string[]): string | undefined {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  return candidates.map((c) => lower.get(c)).find((c) => c !== undefined);
}

function count(value: unknown, column: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : Number.NaN;
  if (!Number.isInteger(n) || n < 0) {
    throw new PortError("DRIFTED", `RUN DQ column ${column} holds ${JSON.stringify(value)}, not a count`, { reason: "DQ_SHAPE" });
  }
  return n;
}

/** Read the counts out of a RUN DQ result. Anything that does not look like counts is DRIFTED, never zero. */
export function parseRunDq(result: FederationResult): DqRuleResult[] {
  const names = result.columns.map((c) => c.name);
  const total = find(names, DQ_TOTAL);
  const valid = find(names, DQ_VALID);
  const invalid = find(names, DQ_INVALID);
  if (!total || !valid || !invalid) {
    throw new PortError("DRIFTED", `RUN DQ returned columns [${names.join(", ")}] without total, valid and invalid counts`, { reason: "DQ_SHAPE" });
  }
  const rule = find(names, DQ_RULE);
  return result.rows.map((row) => ({
    ...(rule && row[rule] !== null && row[rule] !== undefined ? { rule: String(row[rule]) } : {}),
    total: count(row[total], total),
    valid: count(row[valid], valid),
    invalid: count(row[invalid], invalid),
  }));
}

export type Completeness =
  | { status: "COMPLETE"; note?: string }
  | { status: "TRUNCATED"; reason: string }
  | { status: "UNVERIFIABLE"; reason: string };

export interface CollectionFacts {
  /** Records that arrived. */
  retrieved: number;
  /** What the source said exists. Null or absent when it said nothing. */
  expectedTotal?: number | null;
  /** The connector's own statement that it stopped early (page cap, rate limit) or reached the end. */
  truncated?: boolean | null;
}

/** The code form of the completeness rule. "Cannot tell" is UNVERIFIABLE, which callers must treat as not complete. */
export function checkCollectionCompleteness(facts: CollectionFacts): Completeness {
  const { retrieved, expectedTotal, truncated } = facts;
  if (!Number.isInteger(retrieved) || retrieved < 0) throw invalid("retrieved must be a non-negative integer", "BAD_INPUT");
  if (expectedTotal !== undefined && expectedTotal !== null && (!Number.isInteger(expectedTotal) || expectedTotal < 0)) {
    throw invalid("expectedTotal must be a non-negative integer when given", "BAD_INPUT");
  }
  if (truncated === true) return { status: "TRUNCATED", reason: "the connector flagged the collection as cut short" };
  if (expectedTotal === undefined || expectedTotal === null) {
    return truncated === false
      ? { status: "COMPLETE", note: "the source reported no total; completeness rests on the connector reaching the end" }
      : { status: "UNVERIFIABLE", reason: "the source reported no total and the connector did not say whether it reached the end" };
  }
  if (retrieved < expectedTotal) return { status: "TRUNCATED", reason: `${retrieved} of ${expectedTotal} records arrived` };
  return { status: "COMPLETE" };
}

/** Throws unless the collection is demonstrably complete. TRUNCATED for a known cut, REFUSED for "cannot tell". */
export function requireCompleteCollection(facts: CollectionFacts): void {
  const c = checkCollectionCompleteness(facts);
  if (c.status === "TRUNCATED") throw new PortError("TRUNCATED", `collection is incomplete: ${c.reason}`, { ...facts });
  if (c.status === "UNVERIFIABLE") throw new PortError("REFUSED", `collection completeness cannot be established: ${c.reason}`, { reason: "UNVERIFIABLE", ...facts });
}

/** The platform form: the manifest table's DQ result decides. No manifest rows, or any invalid row, is not complete. */
export function completenessFromDq(results: readonly DqRuleResult[]): Completeness {
  const rows = results.filter((r) => r.rule === undefined || r.rule === COMPLETENESS_RULE);
  if (rows.length === 0) return { status: "UNVERIFIABLE", reason: "RUN DQ returned no result for the completeness rule" };
  const total = rows.reduce((n, r) => n + r.total, 0);
  const invalid = rows.reduce((n, r) => n + r.invalid, 0);
  if (total === 0) return { status: "UNVERIFIABLE", reason: "the manifest table has no rows" };
  if (invalid > 0) return { status: "TRUNCATED", reason: `${invalid} of ${total} collections failed the completeness rule` };
  return { status: "COMPLETE" };
}
