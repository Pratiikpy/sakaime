/**
 * Registration against the real local Zetaris stack. Skipped, and says so, when the stack is not configured or not
 * running. The fixture source is a renamed clearance export under a test-host card; everything after the fetch is the
 * production path: the real federation port, the real object store, real DDL, a real read-back as the read-only identity.
 *
 * Repeatable: the request is fixed, so a second run finds the table it created and verifies it (kept: true).
 */
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ObjectStoreLander, onboardSource } from "../../src/discovery/index.ts";
import { openZetaris, zetarisAuthFromEnv } from "../../src/discovery/zetaris-auth.ts";
import { readEnvFile } from "../../src/models/index.ts";
import type { ZetarisPort } from "../../src/federation/zetaris-port.ts";
import { clearances, csv, harness, ROOT, urlOf, type Harness } from "./helpers/fixtures.ts";
import { modelMapping } from "./helpers/doubles.ts";

const env = { ...process.env, ...readEnvFile(join(ROOT, "infra", "zetaris", "sakaime.env")), ...readEnvFile(join(ROOT, ".env")) } as Record<string, string>;
const auth = zetarisAuthFromEnv(env);

let port: ZetarisPort | undefined;
let why = "";
if ("missing" in auth) why = `not configured (missing ${auth.missing.join(", ")})`;
else {
  try {
    port = await openZetaris(auth.config);
    const c = await port.check();
    if (c.health !== "OK") {
      why = `Zetaris is ${c.health}`;
      port = undefined;
    }
  } catch (e) {
    why = (e as Error).message.slice(0, 100);
    port = undefined;
  }
}
if (!port) console.warn(`discovery/live.test.ts: skipped, ${why}`);

let h: Harness | undefined;
afterAll(() => h?.close());

describe.skipIf(!port)("live Zetaris registration", () => {
  it("registers a renamed export, reads it back as the read-only identity and joins it with a hospital silo", async () => {
    h = await harness({ model: modelMapping({ fda_ref: "submission_number", item_label: "device_name", firm_name: "applicant", procode: "product_code", cleared_on: "decision_date" }) });
    h.deps.federation = port!;
    h.deps.landing = new ObjectStoreLander({ endpoint: `http://127.0.0.1:${env["SAKAIME_S3_PORT"] ?? "19190"}` });
    h.fetcher.set(urlOf("live-fixture.csv"), csv(["fda_ref", "item_label", "firm_name", "procode", "cleared_on"], clearances().map((r) => [r[0]!, r[2]!, r[1]!, r[3]!, r[4]!])));
    const result = await onboardSource(await h.request("live-fixture.csv", { description: "Live-run fixture: renamed clearance export", expectedJoinRate: 0.8 }), h.deps);
    expect(result.outcome, result.reason).toBe("registered");
    const reg = result.stages.find((s) => s.stage === "registration")!.detail as { table: string; rows: number; join?: { rows: number; queryId: string; servedFrom: string } };
    expect(reg.rows).toBe(12);
    expect(reg.join?.servedFrom).toBe("live");
    expect(reg.join?.rows).toBeGreaterThan(0);

    // The registered table is visible to the read-only identity and holds exactly the snapshot.
    const count = await port!.sql(`SELECT COUNT(*) AS n FROM ${reg.table}`);
    expect(Number(Object.values(count.rows[0]!)[0])).toBe(12);
    // The admin-only statements were refused for the default identity: it cannot create anything.
    await expect(port!.sql("CREATE LIGHTNING DATABASE sk_should_not_exist DESCRIBE BY \"x\"")).rejects.toMatchObject({ failure: "REFUSED" });
  }, 120_000);
});
