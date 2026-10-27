/**
 * The HTTP skin over the service: every route of ROUTES in contract.ts, each request parsed with its contract schema and each
 * response parsed again before it leaves, so the web app is never handed a shape the contract does not name.
 *
 * Safety. The server binds to loopback unless told otherwise, rejects requests addressed to any other host name (a rebinding
 * page cannot reach it), allows cross-origin calls only from the configured dev UI origin, caps request bodies, never puts a
 * configured secret in a response, and reports the real run mode on /api/health: it never claims live when it is replaying.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { serve, type ServerType } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import {
  CaseDetailSchema,
  CaseSummarySchema,
  DecisionRequestSchema,
  DrillRequestSchema,
  DrillResponseSchema,
  GuardRequestSchema,
  GuardResponseSchema,
  HealthResponseSchema,
  OnboardingResultSchema,
  ProposeSourceRequestSchema,
  RecomputeRequestSchema,
  RecomputeResponseSchema,
  SourceRowSchema,
  TimelineEventSchema,
  TraceEventSchema,
  VerifyResponseSchema,
  type TraceEvent,
} from "./contract.ts";
import { mapError } from "./errors.ts";
import { PortError } from "../ports/index.ts";
import type { SakaimeService } from "../service/service.ts";

export interface AppOptions {
  /** Directory of the built web app, served when it exists. */
  uiDir?: string;
  /** Largest ordinary request body in bytes. */
  maxBodyBytes?: number;
  /** Largest dossier body accepted by /api/dossier/verify. */
  maxDossierBytes?: number;
  /** Host names accepted in the Host header. */
  allowedHosts?: string[];
}

const LinkDecisionSchema = z.object({
  decision: z.enum(["CONFIRM", "REJECT"]),
  idempotencyKey: z.string().min(8).max(200),
  note: z.string().max(2000).optional(),
});

const hostOf = (header: string | undefined): string => (header ?? "").replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();

export function createApp(svc: SakaimeService, options: AppOptions = {}): Hono {
  const app = new Hono();
  const env = svc.config.env;
  const maxBody = options.maxBodyBytes ?? 64 * 1024;
  const maxDossier = options.maxDossierBytes ?? 12 * 1024 * 1024;
  const allowedHosts = new Set((options.allowedHosts ?? ["localhost", "127.0.0.1", "::1"]).map((h) => h.toLowerCase()));
  const reviewerOf = (c: Context): string => {
    const raw = c.req.header("x-reviewer")?.trim();
    return raw && /^[A-Za-z0-9 ._@-]{1,64}$/.test(raw) ? raw : "reviewer";
  };

  const fail = (c: Context, error: unknown): Response => {
    const m = mapError(error, env);
    return c.json(m.body, m.status as 400);
  };
  /** Validates the response against its contract schema before sending it. A mismatch is a bug in the service and is reported as one. */
  const ok = <S extends z.ZodTypeAny>(c: Context, schema: S, data: unknown, status = 200): Response => {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      return c.json({ error: { failure: "UNAVAILABLE", message: `the service produced a response that does not match its contract: ${parsed.error.issues[0]?.path.join(".") || "(root)"}: ${parsed.error.issues[0]?.message}`, detail: { reason: "RESPONSE_CONTRACT" } } }, 500);
    }
    return c.json(parsed.data as never, status as 200);
  };
  const json = async (c: Context): Promise<unknown> => {
    const type = c.req.header("content-type") ?? "";
    if (!/^application\/json/i.test(type)) throw new PortError("INVALID", "send the body as application/json", { reason: "CONTENT_TYPE" });
    try {
      return await c.req.json();
    } catch {
      throw new PortError("INVALID", "the body is not valid JSON", { reason: "BAD_JSON" });
    }
  };

  app.onError((error, c) => fail(c, error));
  app.notFound((c) => c.json({ error: { failure: "INVALID", message: `no such route: ${c.req.method} ${new URL(c.req.url).pathname}`, detail: { reason: "UNKNOWN_ROUTE" } } }, 404));

  // The Host header must name this machine. A page on another origin that resolves a name to 127.0.0.1 cannot read answers.
  app.use("*", async (c, next) => {
    if (!allowedHosts.has(hostOf(c.req.header("host")))) {
      return c.json({ error: { failure: "FORBIDDEN", message: "this service answers only requests addressed to localhost", detail: { reason: "HOST" } } }, 403);
    }
    return next();
  });
  app.use("/api/*", cors({ origin: svc.config.corsOrigin, allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["content-type", "x-reviewer"], maxAge: 600 }));
  // The dossier route carries a whole bundle and has its own, larger limit; every other route keeps the small one.
  const smallLimit = bodyLimit({
    maxSize: maxBody,
    onError: (c) => c.json({ error: { failure: "INVALID", message: `the request body is larger than ${maxBody} bytes`, detail: { reason: "TOO_LARGE", limit: maxBody } } }, 413),
  });
  app.use("/api/*", async (c, next) => (new URL(c.req.url).pathname === "/api/dossier/verify" ? next() : smallLimit(c, next)));
  app.use(
    "/api/dossier/verify",
    bodyLimit({
      maxSize: maxDossier,
      onError: (c) => c.json({ error: { failure: "INVALID", message: `the dossier is larger than ${maxDossier} bytes`, detail: { reason: "TOO_LARGE", limit: maxDossier } } }, 413),
    }),
  );

  // ------------------------------------------------------------ health and sources

  app.get("/api/health", async (c) => ok(c, HealthResponseSchema, await svc.health()));
  app.get("/api/sources", async (c) => ok(c, z.array(SourceRowSchema), await svc.sourceRows()));
  app.post("/api/sources/propose", async (c) => {
    const body = ProposeSourceRequestSchema.parse(await json(c));
    return ok(c, OnboardingResultSchema, await svc.proposeSource(body, reviewerOf(c)));
  });

  // ------------------------------------------------------------ cases

  app.get("/api/cases", async (c) => ok(c, z.array(CaseSummarySchema), await svc.listCases()));
  app.get("/api/cases/:id", async (c) => ok(c, CaseDetailSchema, await svc.caseDetail(c.req.param("id"))));
  app.post("/api/cases/:id/recompute", async (c) => {
    const body = RecomputeRequestSchema.parse(await json(c));
    return ok(c, RecomputeResponseSchema, await svc.recompute(c.req.param("id"), body, c.req.query("claimId")));
  });
  app.post("/api/cases/:id/drill", async (c) => {
    const body = DrillRequestSchema.parse(await json(c));
    return ok(c, DrillResponseSchema, await svc.drill(c.req.param("id"), body));
  });
  app.get("/api/cases/:id/timeline", async (c) => ok(c, z.array(TimelineEventSchema), await svc.timeline(c.req.param("id"), c.req.query("asOf"))));
  app.post("/api/cases/:id/decision", async (c) => {
    const body = DecisionRequestSchema.parse(await json(c));
    const out = await svc.decide(c.req.param("id"), body, reviewerOf(c));
    return c.json({ entry: out.entry, replayed: out.replayed, reviewerState: out.reviewerState }, out.replayed ? 200 : 201);
  });
  app.post("/api/cases/:id/links/:linkId/decision", async (c) => {
    const body = LinkDecisionSchema.parse(await json(c));
    const out = await svc.decideLink(c.req.param("id"), c.req.param("linkId"), body.decision, reviewerOf(c), body.idempotencyKey, body.note);
    return c.json({ replayed: out.replayed, link: out.link, headlineLabel: out.result.results[0]?.finding.label }, out.replayed ? 200 : 201);
  });
  app.get("/api/cases/:id/dossier", async (c) => {
    const out = await svc.dossier(c.req.param("id"), reviewerOf(c));
    return new Response(out.contents, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "x-export-id": out.exportId, "x-export-replayed": String(out.replayed), "content-disposition": `attachment; filename="${c.req.param("id")}.dossier.json"` } });
  });
  app.post("/api/dossier/verify", async (c) => ok(c, VerifyResponseSchema, await svc.verify(await json(c))));
  app.post("/api/guard", async (c) => {
    const body = GuardRequestSchema.parse(await json(c));
    return ok(c, GuardResponseSchema, await svc.screen(body, reviewerOf(c)));
  });
  app.get("/api/runs/:runId/trace", (c) => {
    const emitter = svc.traceOf(c.req.param("runId"));
    if (!emitter) throw new PortError("INVALID", `no run named ${c.req.param("runId").slice(0, 80)}`, { reason: "UNKNOWN_RUN" });
    return new Response(emitter.jsonl(), { status: 200, headers: { "content-type": "application/jsonl; charset=utf-8" } });
  });

  // ------------------------------------------------------------ investigation, streamed

  app.get("/api/cases/:id/investigate", (c) => {
    const id = c.req.param("id");
    svc.caseSpec(id); // an unknown case is an ordinary 404, not a stream
    return streamSSE(c, async (stream) => {
      const controller = new AbortController();
      stream.onAbort(() => controller.abort());
      const send = (e: TraceEvent): void => {
        void stream.writeSSE({ id: String(e.seq), event: "trace", data: JSON.stringify(TraceEventSchema.parse(e)) });
      };
      try {
        await svc.investigate(id, { signal: controller.signal, onEvent: send, reviewer: { id: reviewerOf(c), role: "reviewer" } });
      } catch (error) {
        const m = mapError(error, env);
        await stream.writeSSE({ event: "error", data: JSON.stringify(m.body) });
      }
    });
  });

  // ------------------------------------------------------------ the built web app

  const ui = options.uiDir ?? join(svc.config.dirs.root, "ui", "dist");
  if (existsSync(join(ui, "index.html"))) {
    const rel = relative(process.cwd(), ui) || ".";
    app.use("/*", serveStatic({ root: rel }));
    const index = readFileSync(join(ui, "index.html"), "utf8");
    app.get("*", (c) => (new URL(c.req.url).pathname.startsWith("/api/") ? c.notFound() : c.html(index)));
  }
  return app;
}

export interface Listening {
  server: ServerType;
  url: string;
  close(): Promise<void>;
}

/** Starts the app on the configured host and port. The host defaults to loopback. */
export function listen(app: Hono, host: string, port: number): Promise<Listening> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: host, port }, (info) => {
      resolve({
        server,
        url: `http://${info.address === "::" ? "localhost" : info.address}:${info.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
    server.on("error", reject);
  });
}
