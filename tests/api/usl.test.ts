import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ErrorBodySchema, ROUTES, UslResponseSchema } from "../../src/api/contract.ts";
import { createApp } from "../../src/api/server.ts";
import { PortError } from "../../src/ports/index.ts";
import { defaultDirs, deterministicClock } from "../../src/service/config.ts";
import type { SakaimeService } from "../../src/service/service.ts";
import { UslService } from "../../src/service/usl.ts";
import { sampleService } from "../service/helpers.ts";

let svc: SakaimeService;
const HOST = { host: "localhost:8787" };
const get = (app: ReturnType<typeof createApp>, path: string) => Promise.resolve(app.request(`http://localhost${path}`, { headers: HOST }));

beforeAll(async () => {
  svc = await sampleService();
}, 120_000);

describe("GET /api/usl", () => {
  it("is in the route table", () => {
    expect(ROUTES.usl).toMatch(/^GET \/api\/usl/);
  });

  it("serves the recorded layer in sample mode, labelled as a recording, and the body matches its contract", async () => {
    const res = await get(createApp(svc), "/api/usl");
    expect(res.status).toBe(200);
    const body = UslResponseSchema.parse(await res.json());
    expect(body.servedFrom).toBe("cassette");
    expect(body.readerIdentity).toBe("agent-reader");
    expect(body.dqRules.length).toBeGreaterThanOrEqual(7);
    expect(body.dqRules.find((r) => r.rule === "collection_complete")).toMatchObject({ verdict: "PASSED" });
    expect(body.definitions.some((d) => d.kind === "setting" && d.term === "emergency_department")).toBe(true);
  });

  it("takes the product case id or the hospital case id and returns that case's definitions", async () => {
    const app = createApp(svc);
    for (const id of ["eyeart-k200667", "CASE-2026-014"]) {
      const body = UslResponseSchema.parse(await (await get(app, `/api/usl?caseId=${id}`)).json());
      expect(body.case).toMatchObject({ caseId: "CASE-2026-014", setting: "primary_care" });
      expect(body.definitions.map((d) => `${d.kind}:${d.term}`)).toContain("metric:sensitivity");
    }
    const ed = UslResponseSchema.parse(await (await get(app, "/api/usl?caseId=CASE-2026-021")).json());
    expect(ed.definitions.filter((d) => d.kind === "setting").map((d) => d.term)).toEqual(["any_care_setting", "hospital", "emergency_department"]);
  });

  it("rejects a malformed case id as INVALID before anything is read", async () => {
    const res = await get(createApp(svc), "/api/usl?caseId=..%2F..%2Fetc");
    expect(res.status).toBe(400);
    expect(ErrorBodySchema.parse(await res.json()).error.failure).toBe("INVALID");
  });

  it("answers an unrecorded case with 503 and the reason, never an empty 200", async () => {
    const res = await get(createApp(svc), "/api/usl?caseId=CASE-9999-999");
    expect(res.status).toBe(503);
    expect(ErrorBodySchema.parse(await res.json()).error).toMatchObject({ failure: "UNAVAILABLE", detail: { reason: "CASSETTE_MISS" } });
  });

  it("answers 503 UNAVAILABLE when the engine cannot be asked", async () => {
    const down = new UslService(svc.config, {
      port: {
        async sql() {
          throw new PortError("UNAVAILABLE", "Zetaris is not reachable: ECONNREFUSED");
        },
      },
    });
    const res = await get(createApp(svc, { usl: down }), "/api/usl");
    expect(res.status).toBe(503);
    expect(ErrorBodySchema.parse(await res.json()).error.failure).toBe("UNAVAILABLE");
  });

  it("answers 503 and names the missing configuration when nothing is recorded or configured", async () => {
    const empty = new UslService({ sample: false, env: {}, dirs: { ...defaultDirs(), federationCassettes: mkdtempSync(join(tmpdir(), "usl-api-")) }, clock: deterministicClock(), record: false });
    const res = await get(createApp(svc, { usl: empty }), "/api/usl");
    expect(res.status).toBe(503);
    const body = ErrorBodySchema.parse(await res.json());
    expect(body.error.detail?.["reason"]).toBe("USL_OFF");
    expect(body.error.message).toMatch(/not configured/);
  });
});
