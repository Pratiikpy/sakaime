import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createModelStack, auditCassettes } from "../../src/models/index.ts";
import { NEMOTRON_LIGHTNING, NEMOTRON_ULTRA } from "../../src/models/roles.ts";
import { ConsentingModelPort } from "../../src/service/consent.ts";
import type { SakaimeService } from "../../src/service/service.ts";
import { completion, TestChatServer } from "../models/helpers/chat-server.ts";
import { NightshiftSim } from "../models/helpers/nightshift-sim.ts";
import { instantTransport, newScope } from "../models/helpers/build.ts";
import { CASE_IDS, ScriptedModel, sampleService } from "./helpers.ts";

/*
 * The model route as the service presents and uses it: the run mode says where answers come from, the committed recordings are
 * Nightshift's and their receipts re-verify, the dossier carries those receipts and verifies them, and a prompt that carries a
 * vendor packet is classed vendor-confidential and reaches a remote model only under a recorded consent.
 */

const root = join(import.meta.dirname, "..", "..");
let svc: SakaimeService;
beforeAll(async () => {
  svc = await sampleService();
  for (const id of CASE_IDS) await svc.ensureRun(id);
}, 240_000);

describe("sample mode tells the truth about the model route", () => {
  it("says the answers are replayed from recordings made through Nightshift, and that the receipts were re-verified", async () => {
    const mode = await svc.runMode();
    expect(mode).toMatchObject({ sample: true, model: "recorded", nightshiftReachable: false });
    const n = readdirSync(join(root, "data", "model-cassettes")).filter((f) => f.endsWith(".json")).length;
    expect(mode.degradedNotes).toContain(`model answers are replayed from ${n} recordings made through Nightshift (signed receipts)`);
    expect(mode.degradedNotes.join(" ")).toMatch(new RegExp(`${n} of ${n} recorded receipts were re-verified`));
    expect(mode.degradedNotes.join(" ")).toContain("a question with no recording abstains");
  });

  it("every committed recording was made through Nightshift and its receipt verifies under the pinned key", () => {
    const pin = JSON.parse(readFileSync(join(root, "data", "sample", "receipt-key.json"), "utf8")) as { keyId: string };
    const audit = auditCassettes(join(root, "data", "model-cassettes"), { trustedKeyIds: [pin.keyId] });
    expect(audit.total).toBeGreaterThanOrEqual(50);
    expect(audit).toMatchObject({ unreadable: [], byProvider: { nvidia: 0 }, receiptRejected: [], withoutReceipt: 0 });
    expect(audit.byProvider.nightshift).toBe(audit.total);
    expect(audit.receiptVerified).toBe(audit.total);
    expect(audit.signingKeyIds).toEqual([pin.keyId]);
  });

  it("with the pin removed the notes stop saying the receipts verified", async () => {
    const lonely = mkdtempSync(join(tmpdir(), "sakaime-nopin-"));
    try {
      const s = await sampleService(undefined, {});
      // a service whose stack has no pinned key audits the same recordings with no trusted key
      (s as unknown as { stack: { keyIds: string[] } }).stack.keyIds = [];
      const notes = (await s.runMode()).degradedNotes.join(" ");
      expect(notes).not.toContain("(signed receipts)");
      expect(notes).toMatch(/0 of \d+ carry a receipt that re-verified/);
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });

  it("the replayed run covers every model reply with a receipt, and says so in the dossier", async () => {
    for (const id of CASE_IDS) {
      const r = svc.recordOf(id)!.result;
      const replies = (r.wb.env.model?.calls ?? []).filter((c) => c.response);
      expect(replies.length).toBeGreaterThan(0);
      expect(replies.every((c) => c.response!.recorded && c.response!.receipt !== undefined)).toBe(true);
      const d = await svc.dossier(id);
      const cov = (d.bundle.body as { receiptCoverage: { replies: { total: number; receipted: number; unreceipted: number } } }).receiptCoverage;
      expect(cov.replies).toMatchObject({ total: replies.length, receipted: replies.length, unreceipted: 0 });
    }
  });

  it("the planner, critic and reporter each answered in every case, so the trace shows real model roles", () => {
    for (const id of CASE_IDS) {
      const roles = new Set((svc.recordOf(id)!.result.wb.env.model?.calls ?? []).filter((c) => c.response).map((c) => c.role));
      for (const role of ["planner", "critic", "reporter"]) expect(roles.has(role), `${id} has a ${role} reply`).toBe(true);
    }
  });
});

describe("a dossier carrying receipts is verified against the pinned key", () => {
  it("exports and verifies, with the receipt check run and passing", async () => {
    const d = await svc.dossier("eyeart-k200667");
    const v = await svc.verify(JSON.parse(d.contents));
    expect(v.ok, JSON.stringify(v.failures)).toBe(true);
    expect(v.checks.find((c) => c.name === "receipts.verify")?.detail).toMatch(/^PASS/);
  });

  it("rejects a dossier whose receipt was altered, whether or not the dossier is re-signed", async () => {
    const d = await svc.dossier("eyeart-k200667");
    const bundle = JSON.parse(d.contents) as { body: { models: { receipt?: { raw: { envelope: { body: { receipt: { usage: { output_tokens: number } } } } } } }[] } };
    bundle.body.models[0]!.receipt!.raw.envelope.body.receipt.usage.output_tokens += 1;
    const v = await svc.verify(bundle);
    expect(v.ok).toBe(false);
  });

  it("rejects a receipt signed by a key that is not pinned on this machine", async () => {
    const d = await svc.dossier("eyeart-k200667");
    const s = await sampleService();
    (s as unknown as { stack: { keyIds: string[] } }).stack.keyIds = ["0000000000000000"];
    const v = await s.verify(JSON.parse(d.contents));
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.reason).join(" ")).toMatch(/not pinned|not the installed|signed by key/);
  });

  it("rejects every receipt when no key is pinned at all, instead of waving them through", async () => {
    const d = await svc.dossier("eyeart-k200667");
    const s = await sampleService();
    (s as unknown as { stack: { keyIds: string[] } }).stack.keyIds = [];
    const v = await s.verify(JSON.parse(d.contents));
    expect(v.ok).toBe(false);
    expect(v.failures.map((f) => f.reason).join(" ")).toMatch(/no receipt signing key is pinned/);
  });

  it("the egress records of the dossier class the planner, critic and reporter prompts as vendor-confidential", async () => {
    const d = await svc.dossier("eyeart-k200667");
    const body = d.bundle.body as { models: { id: string; role: string; dataClass: string }[]; egress: { subjectId: string; dataClass: string; reason: string }[] };
    for (const m of body.models) {
      const want = ["planner", "critic", "reporter"].includes(m.role) ? "vendor-confidential" : "public";
      expect(m.dataClass, `${m.role} reply`).toBe(want);
      expect(body.egress.find((e) => e.subjectId === m.id)?.dataClass).toBe(want);
    }
    expect(body.egress.find((e) => e.dataClass === "vendor-confidential")?.reason).toMatch(/recorded consent/);
  });
});

describe("Add a source in sample mode replays the real onboarding run", () => {
  const ALLOWED = { description: "FDA device identifier records for the Transpara breast-screening software, to read its software version labels.", url: "https://api.fda.gov/device/udi.json?search=premarket_submissions.submission_number%3A%22K221347%22&limit=100" };

  it("the allowed example runs every stage up to the reviewer, with the model's proposal replayed and labelled recorded", async () => {
    const r = await svc.proposeSource(ALLOWED);
    expect(r.outcome).toBe("held_for_review");
    expect(r.recorded).toBe(true);
    expect(r.stages.map((s) => `${s.stage}:${s.status}`)).toEqual(["authorization:passed", "capability_discovery:passed", "bounded_probe:passed", "mapping_proposal:passed", "semantic_validation:held", "human_review:held", "registration:pending", "monitoring:pending"]);
    expect(r.stages.find((s) => s.stage === "mapping_proposal")?.summary).toMatch(/proposed \d+ mappings \(replayed from a recording\)/);
    expect(r.stages.find((s) => s.stage === "capability_discovery")?.summary).toMatch(/Zetaris lists \d+ databases/);
    expect(r.mapping.some((m) => m.check === "needs_review")).toBe(true);
    expect(r.reason ?? "").not.toMatch(/no object store|no recorded response|UNAVAILABLE/);
  });

  it("the metadata address and the unlisted host still end at stage 1, declined with their own reasons", async () => {
    const meta = await svc.proposeSource({ description: "Instance metadata for the host machine.", url: "https://169.254.169.254/latest/meta-data/" });
    expect(meta.outcome).toBe("declined");
    expect(meta.stages[0]).toMatchObject({ stage: "authorization", status: "failed" });
    const unlisted = await svc.proposeSource({ description: "A vendor-hosted results file that is not on the allowlist.", url: "https://results.unlisted-vendor.example/trial-export.json" });
    expect(unlisted.outcome).toBe("declined");
    expect(unlisted.reason).toMatch(/not on the source allowlist/);
  });
});

describe("a model asked by the investigation: what class each prompt is", () => {
  it("planner, critic and reporter prompts are vendor-confidential; the support checker's passages are public", async () => {
    const model = new ScriptedModel(() => ({}));
    const s = await sampleService({ model });
    await s.investigate("eyeart-k200667", { store: false });
    const classes = new Map<string, Set<string>>();
    for (const q of model.asked) classes.set(q.role, (classes.get(q.role) ?? new Set()).add(q.dataClass));
    for (const role of ["planner", "critic", "reporter"]) expect([...(classes.get(role) ?? [])], role).toEqual(["vendor-confidential"]);
    for (const role of ["support_checker", "resolver"]) if (classes.has(role)) expect([...(classes.get(role) as Set<string>)], role).toEqual(["public"]);
  }, 120_000);
});

describe("vendor-confidential prompts and the egress policy, through a real stack", () => {
  const nightshift = new TestChatServer();
  const sim = new NightshiftSim();
  const dirs: string[] = [];
  beforeAll(async () => {
    await nightshift.start();
  });
  afterAll(async () => {
    await nightshift.stop();
  });
  beforeEach(() => {
    nightshift.reset();
    nightshift.models = [NEMOTRON_LIGHTNING, NEMOTRON_ULTRA];
    nightshift.chat = (r) => ({ body: sim.reply(r, { content: "{}" }) });
  });
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
  });
  const env = () => ({ NIGHTSHIFT_API_KEY: "nightshift-token-0123456789", NIGHTSHIFT_BASE_URL: nightshift.baseUrl, NIGHTSHIFT_RECEIPT_KEY_ID: sim.key.keyId, NIGHTSHIFT_VERSION: "1.2.3" });
  const ask = (dataClass: "public" | "vendor-confidential") => ({ role: "planner", system: "S", user: `claims ${Math.random()}`, dataClass, memoryScope: newScope() });
  const wrap = async (notice: string | undefined, mode: "live" | "record" = "live", dir?: string) => {
    const stack = await createModelStack({ env: env(), mode, ...(dir ? { cassetteDir: dir } : {}), transport: instantTransport().transport });
    const port = new ConsentingModelPort(stack.port, { ledger: stack.consents, caseId: "demo-1", constructedNotice: notice, remoteDestinations: () => stack.policy.mode().lanes.filter((l) => l.location === "remote").map((l) => l.destination) });
    return { stack, port };
  };

  it("a constructed case records a synthetic consent, the policy evaluates the request under it, and the use is logged", async () => {
    const { stack, port } = await wrap("every packet in this case is synthetic");
    const r = await port.complete(ask("vendor-confidential"));
    expect(r.provider).toBe("nightshift");
    const grant = port.consent()!;
    expect(grant).toMatchObject({ subject: "case:demo-1", synthetic: true, dataClass: "vendor-confidential" });
    expect(grant.destinations).toEqual(["nightshift-cloud"]);
    expect(stack.trace.of("egress.decision").at(-1)).toMatchObject({ allowed: true, basis: "consent", dataClass: "vendor-confidential", consentId: grant.id });
    expect(stack.consents.uses(grant.id)).toHaveLength(1);
  });

  it("a public request needs no consent and creates none", async () => {
    const { stack, port } = await wrap("synthetic");
    await port.complete(ask("public"));
    expect(port.consent()).toBeUndefined();
    expect(stack.consents.activeCount()).toBe(0);
    expect(stack.trace.of("egress.decision").at(-1)).toMatchObject({ allowed: true, basis: "public-class" });
  });

  it("a case that does not declare its data constructed gets no consent, and the policy refuses the request", async () => {
    const { stack, port } = await wrap(undefined);
    await expect(port.complete(ask("vendor-confidential"))).rejects.toMatchObject({ failure: "REFUSED", detail: { basis: "no-consent" } });
    expect(stack.consents.activeCount()).toBe(0);
    expect(nightshift.chatRequests).toHaveLength(0);
  });

  it("the same request without the wrapper is refused: the label is evaluated, not bypassed", async () => {
    const stack = await createModelStack({ env: env(), mode: "live", transport: instantTransport().transport });
    await expect(stack.port.complete(ask("vendor-confidential"))).rejects.toMatchObject({ failure: "REFUSED" });
  });

  it("a recording of such a prompt says it is constructed demo data; one under any other consent is not recorded", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "sakaime-consent-")), "cassettes");
    dirs.push(dir);
    const { stack, port } = await wrap("synthetic", "record", dir);
    await port.complete(ask("vendor-confidential"));
    const file = readdirSync(dir).find((f) => f.endsWith(".json"))!;
    expect(JSON.parse(readFileSync(join(dir, file), "utf8")).request).toMatchObject({ dataClass: "vendor-confidential", constructedDemoData: true });

    const real = stack.consents.grant({ subject: "case:demo-1", grantedBy: "a person", reason: "real packet, not synthetic", ttlMs: 60_000 });
    const before = readdirSync(dir).length;
    await stack.port.complete({ ...ask("vendor-confidential"), consentToken: real.id, consentSubject: "case:demo-1" } as Parameters<typeof stack.port.complete>[0]);
    expect(readdirSync(dir)).toHaveLength(before);
    expect((stack.recorder?.stats.skipped.at(-1)?.reason ?? "")).toMatch(/not sent under a consent that declares the data constructed/);
  });
});

void completion;
