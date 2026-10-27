import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SakaimeService } from "../../src/service/service.ts";
import { EXPECTED_LABELS } from "./helpers.ts";

/**
 * Runs EyeArt once against the real public sources, the real Zetaris stack and the real model route. Skipped unless LIVE=1,
 * because it needs the network, a running Zetaris stack and credentials in the gitignored .env.
 *
 * What it records is written to output_examples/live-smoke-eyeart.json: modes, labels, which legs worked and which did not.
 * It holds no key, no token and no personal path. A model leg that is unavailable is written down as unavailable.
 */
const LIVE = process.env["LIVE"] === "1";

describe.skipIf(!LIVE)("live smoke: EyeArt K200667 against real sources, real Zetaris and the real model route", () => {
  it(
    "runs once, keeps every invariant, and records what each leg did",
    async () => {
      const svc = await SakaimeService.create({ sample: false });
      const health = await svc.health();
      const result = await svc.investigate("eyeart-k200667", { store: false });

      const labels = Object.fromEntries(result.results.map((r) => [r.claim.id, r.finding.label]));
      const modelEvents = result.trace.events.filter((e) => e.model);
      const modelFailures = result.trace.events.filter((e) => /model call failed/.test(e.decision));
      const record = {
        ranAt: new Date().toISOString(),
        mode: health.mode,
        status: result.status,
        labels,
        sameLabelsAsRecordedSample: JSON.stringify(labels) === JSON.stringify(EXPECTED_LABELS["eyeart-k200667"]),
        federation: { status: result.wb.federation.status, servedFrom: result.wb.federation.reads[0]?.result.servedFrom ?? null, rows: result.wb.federation.reads[0]?.result.rows.length ?? null },
        sources: result.plan.map((p) => ({ step: p.step.id, source: p.step.source, status: p.outcome?.status ?? "NOT_RUN", detail: p.outcome?.detail?.slice(0, 160) ?? null })),
        modelLeg: modelEvents.length > 0 ? { status: "answered", events: modelEvents.length, routedModels: [...new Set(modelEvents.map((e) => e.model!.routedModel))] } : { status: modelFailures.length > 0 ? "unavailable" : "not_called", reasons: modelFailures.map((e) => e.decision.slice(0, 200)) },
        prose: { sentences: result.prose.lines.length, fromModel: result.prose.lines.filter((l) => l.source === "model").length, rejected: result.prose.rejected.length },
        traceEvents: result.trace.events.length,
      };
      const dir = svc.config.dirs.outputs;
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "live-smoke-eyeart.json"), `${JSON.stringify(record, null, 2)}\n`, "utf8");

      expect(result.status).toBe("complete");
      expect(health.mode.sample).toBe(false);
      expect(result.wb.federation.status).toBe("ok");
      expect(result.wb.federation.reads[0]!.result.servedFrom).toBe("live");
      // A lost leg may change a label toward INSUFFICIENT_EVIDENCE; it may never produce a supported one from nothing.
      for (const r of result.results) {
        if (r.finding.degraded.some((d) => d.dependency === "required")) expect(r.finding.label).not.toBe("SUPPORTED_FOR_SCOPE");
      }
      for (const l of result.prose.lines) expect(result.results.some((r) => r.finding.id === l.findingId)).toBe(true);
      expect(JSON.stringify(record)).not.toMatch(/nvapi-|Bearer |password|C:\\Users/i);
    },
    600_000,
  );
});

describe.skipIf(LIVE)("live smoke (skipped)", () => {
  it("is skipped unless LIVE=1; it needs the network, the Zetaris stack on loopback and credentials in .env", () => {
    expect(process.env["LIVE"]).not.toBe("1");
  });
});
