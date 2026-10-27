/**
 * Shared result assembly for the three federation modes, so that live, cassette and fallback results are
 * hashed, cast and checked for completeness by the same code.
 */
import { PortError, type FederationMode, type FederationPort, type FederationQueryOptions, type FederationResult } from "../ports/index.ts";
import { hashOf } from "../util/canonical.ts";
import { castRows, castRowsWithTypes, type CastOptions, type ColumnType, type DeclaredSchema, type RawRow } from "./cast.ts";

export const DEFAULT_LIMIT = 5_000;
export const MAX_LIMIT = 100_000;

export interface FederationQueryOptionsEx extends FederationQueryOptions {
  /** Declared column types for this call, merged over the port's schema (the call wins). */
  schema?: DeclaredSchema;
  /** "read-only" (default) refuses anything that could change data; "admin" is for USL and data-quality setup. */
  statementPolicy?: "read-only" | "admin";
}

/** Result of the engine call before typed casting. This is what a cassette stores. */
export interface RawFederationResult {
  columns: string[];
  /** Values exactly as the engine sent them: strings and nulls. */
  rawRows: (string | null)[][];
  total: number;
  queryId: string;
  elapsedMs: number;
  /** The normalised statement that ran. */
  statement: string;
  identity: string;
}

export interface RawFederationPort extends FederationPort {
  sqlRaw(statement: string, options?: FederationQueryOptionsEx): Promise<RawFederationResult>;
  /** Cast a raw result exactly as `sql` would, so a wrapper that recorded the raw form returns the same typed rows. */
  toResult(raw: RawFederationResult, options?: FederationQueryOptionsEx): FederationResult;
}

/** sha256 over the canonical form of the columns and the raw wire values. Independent of any casting. */
export function rawResultHash(columns: readonly string[], rawRows: readonly RawRow[]): string {
  return hashOf({ columns, rows: rawRows });
}

export function resolveLimit(requested: number | undefined, fallback: number): number {
  const limit = requested ?? fallback;
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new PortError("INVALID", `limit must be an integer from 1 to ${MAX_LIMIT}`, { limit });
  }
  return limit;
}

/**
 * Refuse any result that may be partial. The engine is asked for limit+1 rows, so receiving more than `limit`
 * proves the answer was cut even if `total` is wrong; `total` above the rows received proves it directly.
 */
export function assertComplete(received: number, total: number, limit: number): void {
  if (received > limit || total > received) {
    throw new PortError(
      "TRUNCATED",
      `the result is incomplete (${received} rows received, engine reports ${Math.max(total, received)}, limit ${limit}); narrow the statement instead of using a partial answer`,
      { received, total, limit },
    );
  }
}

export function buildResult(args: {
  raw: Pick<RawFederationResult, "columns" | "rawRows" | "total" | "queryId" | "elapsedMs">;
  servedFrom: FederationMode;
  schema: ReadonlyMap<string, ColumnType>;
  cast: CastOptions | undefined;
  /** Positional types that take precedence over the schema, used by the fallback engine's native types. */
  nativeTypes?: readonly ColumnType[];
}): FederationResult {
  const { raw } = args;
  const typed = args.nativeTypes
    ? castRowsWithTypes(raw.columns, raw.rawRows, raw.columns.map((name, i) => args.schema.get(name.toLowerCase()) ?? args.nativeTypes![i] ?? "string"), args.cast)
    : castRows(raw.columns, raw.rawRows, args.schema, args.cast);
  return {
    columns: typed.columns,
    rows: typed.rows,
    total: Math.max(raw.total, raw.rawRows.length),
    queryId: raw.queryId,
    servedFrom: args.servedFrom,
    respHash: rawResultHash(raw.columns, raw.rawRows),
    elapsedMs: raw.elapsedMs,
  };
}

export function mergeSchema(base: DeclaredSchema | undefined, over: DeclaredSchema | undefined): DeclaredSchema | undefined {
  if (!base) return over;
  if (!over) return base;
  const lowered = new Map<string, string>();
  for (const [k, v] of Object.entries(base)) lowered.set(k.toLowerCase(), v);
  for (const [k, v] of Object.entries(over)) lowered.set(k.toLowerCase(), v);
  return Object.fromEntries(lowered);
}
