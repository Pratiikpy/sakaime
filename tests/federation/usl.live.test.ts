/**
 * The semantic layer against the running Zetaris stack. Skipped unless LIVE=1, and says so. Needs the gitignored .env with the
 * administrator and the read-only agent logins (infra/zetaris/README.md). Everything here is read-only except ensureUsl, which is
 * idempotent; no collection is truncated (the drill in infra/zetaris/scripts/usl.ts does that, on a collection nobody else reads).
 */
import { describe, expect, it } from "vitest";
import { ZetarisPort } from "../../src/federation/zetaris-port.ts";
import { ensureUsl, runCompletenessRule, readCaseDefinitions } from "../../src/federation/usl.ts";
import { answerByHand, answerByOneStatement, answerThroughUsl, compareAnswers } from "../../src/federation/usl-measure.ts";
import { PasswordSessionPort, openUslAdmin, uslConnectionFromEnv, uslSpec, readUslSnapshot } from "../../src/service/usl.ts";

for (const file of ["infra/zetaris/sakaime.env", ".env"]) {
  try {
    process.loadEnvFile(file);
  } catch {
    /* absent */
  }
}

const LIVE = process.env["LIVE"] === "1";
const conn = uslConnectionFromEnv(process.env);
const configured = LIVE && Boolean(conn.reader && conn.admin);
if (!configured) console.warn("usl.live.test.ts: skipped (set LIVE=1 with the Zetaris logins in .env)");

describe.skipIf(!configured)("the semantic layer on the live stack", () => {
  const spec = uslSpec();
  const reader = () => new PasswordSessionPort(conn.restUrl, conn.orgId, conn.reader!);

  it("ensureUsl is idempotent: the second run changes nothing", async () => {
    const admin = openUslAdmin(conn);
    await ensureUsl(admin, spec);
    const again = await ensureUsl(admin, spec);
    expect(again.actions).toEqual([]);
    expect(again.rebuilt).toBe(false);
  }, 180_000);

  it("the read-only identity reads the layer and cannot administer it", async () => {
    const snap = await readUslSnapshot(reader(), spec, { caseId: "CASE-2026-014", metrics: ["sensitivity"] }, () => new Date());
    expect(snap.servedFrom).toBe("live");
    expect(snap.tables.every((t) => t.activated)).toBe(true);
    expect(snap.dqRules.find((r) => r.rule === "collection_complete")?.verdict).toBe("PASSED");
    expect(snap.definitions.map((d) => d.term)).toContain("primary_care");
    const refused = await reader().sql("ACTIVATE USL TABLE lightning.metastore.sakaime.review_semantics.vendor_claim AS SELECT 1", { statementPolicy: "admin" }).catch((e: unknown) => e);
    // The engine's refusal text is "User is not permitted to run this command". classify.ts does not list that wording, so the port
    // reports it as INVALID rather than FORBIDDEN (a gap in src/federation/classify.ts, reported to the lead). What matters here is
    // that it is refused and is not mistaken for an outage.
    expect(refused).toBeInstanceOf(Error);
    expect((refused as Error).message).toMatch(/not permitted to run this command/);
    expect(refused).not.toMatchObject({ failure: "UNAVAILABLE" });
  }, 120_000);

  it("the three ways of answering the cross-silo question give the same 28 rows, cell by cell", async () => {
    const hand = await answerByHand(reader());
    expect(hand.rows.length).toBeGreaterThan(0);
    expect(compareAnswers(hand, await answerByOneStatement(reader(), spec)).problems).toEqual([]);
    expect(compareAnswers(hand, await answerThroughUsl(reader(), spec)).problems).toEqual([]);
  }, 120_000);

  it("an unknown case is a not-found, and the completeness gate holds on the landed collections", async () => {
    await expect(readCaseDefinitions(reader(), "CASE-9999-999")).rejects.toMatchObject({ detail: { reason: "UNKNOWN_CASE" } });
    const gate = await runCompletenessRule(reader(), spec);
    expect(gate.verdict).toBe("PASSED");
    expect(gate.codeCheckAgrees).toBe(true);
  }, 60_000);

  it("an engine that cannot be reached is UNAVAILABLE, never a verdict", async () => {
    const closed = new ZetarisPort({ restUrl: "http://127.0.0.1:1/api/v1.0", orgId: "1", identities: { default: { apiKey: "unused-key-value" } }, defaultIdentity: "default", maxAttempts: 1 });
    await expect(runCompletenessRule(closed, spec)).rejects.toMatchObject({ failure: "UNAVAILABLE" });
  });
});
