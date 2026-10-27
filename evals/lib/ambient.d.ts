/** The infrastructure scripts are plain .mjs files without declarations; only the call used by the FailureShift drill is typed. */
declare module "*/zt.mjs" {
  export function sql(who: string, statement: string, options?: { limit?: number; timeoutMs?: number }): Promise<{ outcome?: string; status?: number; message?: string; rows?: unknown[]; ms?: number }>;
}
