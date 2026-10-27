/**
 * Dev fixture server for the web app. It implements the HTTP contract in src/api/contract.ts with real modules over
 * recorded real data (see world.ts) so the UI can be built and tested before, and independently of, the real service.
 *
 *   npx tsx ui/dev-server/server.ts                 API on :8787
 *   npx tsx ui/dev-server/server.ts --static        also serves the built app from ui/dist
 *
 * Routes outside the contract are under /api/dev and exist only to put the fixture into states a test needs.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  DecisionRequestSchema,
  DrillRequestSchema,
  GuardRequestSchema,
  ProposeSourceRequestSchema,
  RecomputeRequestSchema,
  SourceRowSchema,
  CaseSummarySchema,
  OnboardingResultSchema,
} from "../../src/api/contract.ts";
import { z } from "zod";
import { Onboarder } from "./onboarding.ts";
import { buildResults } from "./results.ts";
import { decide, detailOf, devChangeFact, dossierOf, drillView, guardView, health, HttpFailure, investigation, recomputeView, runs, summaryOf, timelineOf, verifyView } from "./views.ts";
import { buildWorld, REPO, type CaseState } from "./world.ts";

const PORT = Number(process.env["PORT"] ?? 8787);
const STATIC = process.argv.includes("--static");

const world = await buildWorld();
const onboarder = new Onboarder();
const app = new Hono();

app.onError((err, c) => {
  if (err instanceof HttpFailure) return c.json({ error: { failure: err.failure, message: err.message, ...(err.detail ? { detail: err.detail } : {}) } }, err.status);
  if (err instanceof z.ZodError) return c.json({ error: { failure: "INVALID", message: "The request body was not in the expected shape.", detail: { issues: err.issues.slice(0, 5).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`) } } }, 400);
  console.error(err);
  return c.json({ error: { failure: "UNAVAILABLE", message: "The service hit an unexpected error." } }, 500);
});

async function body<S extends z.ZodTypeAny>(c: { req: { json: () => Promise<unknown> } }, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpFailure(400, "INVALID", "The request body was not valid JSON.");
  }
  return schema.parse(raw);
}

function caseOr404(id: string): CaseState {
  const c = world.cases.get(decodeURIComponent(id));
  if (!c) throw new HttpFailure(404, "NOT_FOUND", `There is no case "${id}".`);
  return c;
}

app.get("/api/health", (c) => c.json(health()));
app.get("/api/sources", (c) => c.json(z.array(SourceRowSchema).parse(world.sourceRows)));
app.post("/api/sources/propose", async (c) => {
  const req = await body(c, ProposeSourceRequestSchema);
  return c.json(OnboardingResultSchema.parse(await onboarder.run(world, req)));
});
app.get("/api/cases", (c) => c.json(z.array(CaseSummarySchema).parse(world.order.map((id) => summaryOf(world.cases.get(id)!)))));
app.get("/api/cases/:id", (c) => c.json(detailOf(world, caseOr404(c.req.param("id")))));
app.post("/api/cases/:id/recompute", async (c) => c.json(recomputeView(caseOr404(c.req.param("id")), await body(c, RecomputeRequestSchema))));
app.post("/api/cases/:id/drill", async (c) => c.json(await drillView(world, caseOr404(c.req.param("id")), await body(c, DrillRequestSchema))));
app.get("/api/cases/:id/timeline", (c) => c.json(timelineOf(caseOr404(c.req.param("id")), c.req.query("asOf"))));
app.post("/api/cases/:id/decision", async (c) => c.json(decide(caseOr404(c.req.param("id")), await body(c, DecisionRequestSchema))));
app.get("/api/cases/:id/dossier", (c) => c.json(dossierOf(world, caseOr404(c.req.param("id")))));
app.post("/api/dossier/verify", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new HttpFailure(400, "INVALID", "The dossier was not valid JSON.");
  }
  return c.json(await verifyView(raw));
});
app.post("/api/guard", async (c) => c.json(await guardView(await body(c, GuardRequestSchema))));

app.get("/api/cases/:id/investigate", (c) => {
  const run = investigation(world, caseOr404(c.req.param("id")));
  return streamSSE(c, async (stream) => {
    for (const e of run.events) {
      await stream.writeSSE({ data: JSON.stringify(e), id: String(e.seq) });
      await stream.sleep(e.role === "extractor" ? 60 : 180);
    }
  });
});
app.get("/api/runs/:runId/trace", (c) => {
  const run = runs.get(c.req.param("runId"));
  if (!run) throw new HttpFailure(404, "NOT_FOUND", "That run is not known to this server.");
  return c.body(run.events.map((e) => JSON.stringify(e)).join("\n") + "\n", 200, { "Content-Type": "application/jsonl" });
});

// The published result files, as static JSON.
app.get("/results.json", (c) => c.json(buildResults()));

// ---- dev-only: put the fixture into states a test needs. Not part of the contract.
app.post("/api/dev/change-fact/:id", async (c) => {
  const raw = (await c.req.json().catch(() => ({}))) as { fact?: string };
  return c.json(devChangeFact(caseOr404(c.req.param("id")), raw.fact));
});

app.all("/api/*", (c) => c.json({ error: { failure: "NOT_FOUND", message: "No such route." } }, 404));

if (STATIC) {
  const dist = join(REPO, "ui", "dist");
  if (!existsSync(join(dist, "index.html"))) throw new Error("ui/dist is missing: run `npx vite build --config ui/vite.config.ts` first");
  app.use("/*", serveStatic({ root: "./ui/dist" }));
  // Single-page app: any other path serves the shell, so deep links and reloads work.
  app.get("*", (c) => c.html(readFileSync(join(dist, "index.html"), "utf8")));
}

serve({ fetch: app.fetch, port: PORT, hostname: "127.0.0.1" }, (info) => {
  console.log(`Sakaime fixture server on http://127.0.0.1:${info.port}${STATIC ? " (serving ui/dist)" : ""}`);
  console.log(`cases: ${world.order.join(", ")}`);
});
