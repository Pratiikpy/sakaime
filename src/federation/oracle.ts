/**
 * The independent oracle: run a statement on the federation port and on the DuckDB fallback, then compare.
 *
 * Agreement is never assumed. An outcome is AGREE only when both engines returned a result and the result sets
 * match as multisets of rows (order is ignored, because SQL promises none without a total ORDER BY) with a typed
 * numeric tolerance. Every other situation is reported as such: a failure on either side, an untranslatable
 * statement, and any difference, with a structured diff that names the rows and columns.
 *
 * DuckDB is the oracle, not a second implementation of federation. The harness refuses to be built with a primary
 * port that is itself the fallback, because that would compare an engine with itself.
 */
import { PortError, type FederationPort, type FederationResult } from "../ports/index.ts";
import type { FederationQueryOptionsEx } from "./result.ts";

export interface OracleTolerance {
  /** Allowed difference relative to the larger magnitude. */
  relative: number;
  /** Allowed absolute difference, for values near zero. */
  absolute: number;
}

export const DEFAULT_TOLERANCE: OracleTolerance = { relative: 1e-9, absolute: 1e-9 };

type Row = Record<string, unknown>;

export interface ColumnDifference {
  column: string;
  primary: unknown;
  oracle: unknown;
  absoluteDifference?: number;
}

export interface MismatchedPair {
  primary: Row;
  oracle: Row;
  differences: ColumnDifference[];
}

export interface OracleDiff {
  agree: boolean;
  primaryRows: number;
  oracleRows: number;
  /** Columns present on one side only (matched by lower-cased name). */
  columnsOnlyInPrimary: string[];
  columnsOnlyInOracle: string[];
  onlyInPrimary: Row[];
  onlyInOracle: Row[];
  /** Rows that nearly match: the same row on both sides differing in some columns. */
  mismatched: MismatchedPair[];
  /** Columns whose values had to be coerced to be comparable (text "3" against number 3). Informational. */
  coercedColumns: string[];
  /** True when a list above was cut at maxListed. */
  listsTruncated: boolean;
}

export interface CompareOptions {
  tolerance?: OracleTolerance;
  /** Cap on rows listed per category. Default 50. */
  maxListed?: number;
}

const NUMERIC_TYPES: ReadonlySet<string> = new Set(["integer", "bigint", "double", "decimal"]);
const INTEGER_TEXT = /^[+-]?\d+$/;
const NUM_TEXT = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;

type Cell = { kind: "null" } | { kind: "nan" } | { kind: "num"; value: number; exact: string } | { kind: "other"; value: string };

function toCell(value: unknown, numericColumn: boolean): Cell {
  if (value === null || value === undefined) return { kind: "null" };
  if (numericColumn) {
    if (typeof value === "number") return Number.isNaN(value) ? { kind: "nan" } : { kind: "num", value, exact: String(value) };
    if (typeof value === "bigint") return { kind: "num", value: Number(value), exact: value.toString() };
    if (typeof value === "string" && NUM_TEXT.test(value)) return { kind: "num", value: Number(value), exact: value };
    if (typeof value === "string" && /^nan$/i.test(value)) return { kind: "nan" };
  }
  if (typeof value === "string") return { kind: "other", value };
  if (typeof value === "boolean" || typeof value === "number" || typeof value === "bigint") return { kind: "other", value: String(value) };
  return { kind: "other", value: JSON.stringify(value) };
}

function numbersClose(a: number, b: number, tol: OracleTolerance): boolean {
  if (a === b) return true;
  const diff = Math.abs(a - b);
  return diff <= tol.absolute || diff <= tol.relative * Math.max(Math.abs(a), Math.abs(b));
}

function cellsAgree(a: Cell, b: Cell, tol: OracleTolerance): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "null" || a.kind === "nan") return true;
  if (a.kind === "num" && b.kind === "num") {
    if (a.exact === b.exact) return true;
    // Integers are compared as integers: a double cannot tell 2^53 from 2^53+1, and a count is either right or wrong.
    if (INTEGER_TEXT.test(a.exact) && INTEGER_TEXT.test(b.exact)) return BigInt(a.exact) === BigInt(b.exact);
    return numbersClose(a.value, b.value, tol);
  }
  return a.kind === "other" && b.kind === "other" && a.value === b.value;
}

interface PreparedRow {
  original: Row;
  cells: Cell[];
}

export function compareResults(primary: FederationResult, oracle: FederationResult, options: CompareOptions = {}): OracleDiff {
  const tol = options.tolerance ?? DEFAULT_TOLERANCE;
  const cap = options.maxListed ?? 50;
  const pCols = new Map(primary.columns.map((c) => [c.name.toLowerCase(), c]));
  const oCols = new Map(oracle.columns.map((c) => [c.name.toLowerCase(), c]));
  const common = [...pCols.keys()].filter((k) => oCols.has(k));
  const columnsOnlyInPrimary = [...pCols.keys()].filter((k) => !oCols.has(k));
  const columnsOnlyInOracle = [...oCols.keys()].filter((k) => !pCols.has(k));

  const numeric = common.map((k) => NUMERIC_TYPES.has(pCols.get(k)!.type) || NUMERIC_TYPES.has(oCols.get(k)!.type));
  const coerced = new Set<string>();
  for (const k of common) if (pCols.get(k)!.type !== oCols.get(k)!.type) coerced.add(k);

  const prepare = (result: FederationResult, cols: Map<string, { name: string }>): PreparedRow[] =>
    result.rows.map((row) => ({ original: row, cells: common.map((k, i) => toCell(row[cols.get(k)!.name], numeric[i]!)) }));
  const left = prepare(primary, pCols);
  const right = prepare(oracle, oCols);

  const keyOf = (r: PreparedRow): string =>
    JSON.stringify(r.cells.map((c, i) => (numeric[i] ? (c.kind === "num" ? "n" : c.kind) : c.kind === "other" ? ["o", c.value] : c.kind)));
  const numericIdx = common.map((_, i) => i).filter((i) => numeric[i]);

  const buckets = new Map<string, { l: PreparedRow[]; r: PreparedRow[] }>();
  const bucket = (k: string): { l: PreparedRow[]; r: PreparedRow[] } => {
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { l: [], r: [] }));
    return b;
  };
  left.forEach((r) => bucket(keyOf(r)).l.push(r));
  right.forEach((r) => bucket(keyOf(r)).r.push(r));

  const leftover = { l: [] as PreparedRow[], r: [] as PreparedRow[] };
  for (const { l, r } of buckets.values()) {
    const matchedL = new Set<number>();
    const matchedR = new Set<number>();
    if (numericIdx.length === 0) {
      // No tolerance in play: equal keys are equal rows; pair them off by count.
      const n = Math.min(l.length, r.length);
      for (let i = 0; i < n; i++) {
        matchedL.add(i);
        matchedR.add(i);
      }
    } else {
      const close = (a: PreparedRow, b: PreparedRow): boolean => numericIdx.every((i) => cellsAgree(a.cells[i]!, b.cells[i]!, tol));
      // Kuhn's augmenting-path matching: a greedy pairing can strand a row that a different pairing would match.
      const owner = new Map<number, number>();
      const tryAssign = (li: number, seen: Set<number>): boolean => {
        for (let ri = 0; ri < r.length; ri++) {
          if (seen.has(ri) || !close(l[li]!, r[ri]!)) continue;
          seen.add(ri);
          const current = owner.get(ri);
          if (current === undefined || tryAssign(current, seen)) {
            owner.set(ri, li);
            return true;
          }
        }
        return false;
      };
      // Very large buckets of near-equal rows fall back to first-fit; augmenting paths are cubic in the worst case.
      if (l.length * r.length > 250_000) {
        l.forEach((lr, li) => {
          const ri = r.findIndex((rr, idx) => !owner.has(idx) && close(lr, rr));
          if (ri >= 0) owner.set(ri, li);
        });
      } else {
        for (let li = 0; li < l.length; li++) tryAssign(li, new Set());
      }
      for (const [ri, li] of owner) {
        matchedR.add(ri);
        matchedL.add(li);
      }
    }
    l.forEach((row, i) => !matchedL.has(i) && leftover.l.push(row));
    r.forEach((row, i) => !matchedR.has(i) && leftover.r.push(row));
  }

  // Pair the unmatched rows that differ in only some columns, so a diff reads "row X: column c was a, is b".
  const mismatched: MismatchedPair[] = [];
  const unpairedR = [...leftover.r];
  const onlyInPrimary: PreparedRow[] = [];
  for (const lrow of leftover.l) {
    let closest = -1;
    let fewestDiffs = common.length;
    unpairedR.forEach((rrow, idx) => {
      const diffs = common.reduce((n, _, i) => n + (cellsAgree(lrow.cells[i]!, rrow.cells[i]!, tol) ? 0 : 1), 0);
      if (diffs < fewestDiffs) {
        closest = idx;
        fewestDiffs = diffs;
      }
    });
    if (closest >= 0 && fewestDiffs < common.length) {
      const rrow = unpairedR.splice(closest, 1)[0]!;
      const differences: ColumnDifference[] = [];
      common.forEach((k, i) => {
        if (cellsAgree(lrow.cells[i]!, rrow.cells[i]!, tol)) return;
        const a = lrow.original[pCols.get(k)!.name];
        const b = rrow.original[oCols.get(k)!.name];
        const ca = lrow.cells[i]!;
        const cb = rrow.cells[i]!;
        differences.push({ column: k, primary: a, oracle: b, ...(ca.kind === "num" && cb.kind === "num" ? { absoluteDifference: Math.abs(ca.value - cb.value) } : {}) });
      });
      mismatched.push({ primary: lrow.original, oracle: rrow.original, differences });
    } else {
      onlyInPrimary.push(lrow);
    }
  }
  const onlyInOracle = unpairedR;

  const listsTruncated = mismatched.length > cap || onlyInPrimary.length > cap || onlyInOracle.length > cap;
  const agree =
    columnsOnlyInPrimary.length === 0 &&
    columnsOnlyInOracle.length === 0 &&
    mismatched.length === 0 &&
    onlyInPrimary.length === 0 &&
    onlyInOracle.length === 0;
  return {
    agree,
    primaryRows: primary.rows.length,
    oracleRows: oracle.rows.length,
    columnsOnlyInPrimary,
    columnsOnlyInOracle,
    onlyInPrimary: onlyInPrimary.slice(0, cap).map((r) => r.original),
    onlyInOracle: onlyInOracle.slice(0, cap).map((r) => r.original),
    mismatched: mismatched.slice(0, cap),
    coercedColumns: [...coerced],
    listsTruncated,
  };
}

export type OracleStatus = "AGREE" | "DISAGREE" | "PRIMARY_FAILED" | "ORACLE_FAILED" | "BOTH_FAILED";

export interface OracleOutcome {
  statement: string;
  status: OracleStatus;
  primary?: FederationResult;
  oracle?: FederationResult;
  primaryError?: PortError;
  oracleError?: PortError;
  diff?: OracleDiff;
}

export class OracleDisagreement extends Error {
  constructor(readonly outcome: OracleOutcome) {
    super(`oracle check did not agree (${outcome.status}) for: ${outcome.statement.slice(0, 120)}`);
    this.name = "OracleDisagreement";
  }
}

export class OracleHarness {
  constructor(
    private readonly primary: FederationPort,
    private readonly oracle: FederationPort,
    private readonly options: CompareOptions = {},
  ) {
    if (oracle.mode !== "fallback") throw new PortError("INVALID", "the oracle port must be the DuckDB fallback", { reason: "BAD_ORACLE" });
    if (primary.mode === "fallback") {
      throw new PortError("INVALID", "the primary port must be live or cassette; comparing the fallback with itself proves nothing", { reason: "BAD_ORACLE" });
    }
  }

  async run(statement: string, queryOptions: FederationQueryOptionsEx = {}): Promise<OracleOutcome> {
    const [p, o] = await Promise.allSettled([this.primary.sql(statement, queryOptions), this.oracle.sql(statement, queryOptions)]);
    const asPortError = (r: PromiseRejectedResult): PortError => {
      if (r.reason instanceof PortError) return r.reason;
      throw r.reason;
    };
    if (p.status === "rejected" && o.status === "rejected") {
      return { statement, status: "BOTH_FAILED", primaryError: asPortError(p), oracleError: asPortError(o) };
    }
    if (p.status === "rejected") {
      return { statement, status: "PRIMARY_FAILED", primaryError: asPortError(p), ...(o.status === "fulfilled" ? { oracle: o.value } : {}) };
    }
    if (o.status === "rejected") {
      return { statement, status: "ORACLE_FAILED", primary: p.value, oracleError: asPortError(o) };
    }
    const diff = compareResults(p.value, o.value, this.options);
    return { statement, status: diff.agree ? "AGREE" : "DISAGREE", primary: p.value, oracle: o.value, diff };
  }

  /** Run and throw OracleDisagreement unless the two engines agree. */
  async assertAgree(statement: string, queryOptions: FederationQueryOptionsEx = {}): Promise<OracleOutcome> {
    const outcome = await this.run(statement, queryOptions);
    if (outcome.status !== "AGREE") throw new OracleDisagreement(outcome);
    return outcome;
  }
}
