import { expect, type Page, type Route } from "@playwright/test";
import { test, primaryCase, quietCase, ready, shot, watch } from "./helpers";

/**
 * Empty, loading, error and degraded states. The service is wrapped with route handlers that are named test doubles:
 * they change what the browser is told, so the app's reaction can be checked. They never run in the app.
 */

const json = (route: Route, body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
const errorBody = (failure: string, message: string) => ({ error: { failure, message } });

async function modifyCase(page: Page, id: string, edit: (c: any) => void) {
  await page.route(`**/api/cases/${id}`, async (route) => {
    const res = await route.fetch();
    const body = await res.json();
    edit(body);
    await json(route, body);
  });
}

test.describe("the error taxonomy reads differently", () => {
  test("UNAVAILABLE (500) says it is on our side and offers a retry that works", async ({ page }) => {
    const w = watch(page);
    w.allow(/500/);
    let fail = true;
    await page.route("**/api/cases", (route) => (fail ? route.fulfill({ status: 500, body: "<html>bad gateway</html>", contentType: "text/html" }) : route.continue()));
    await page.goto("/cases");
    const err = page.locator('[data-failure="UNAVAILABLE"]');
    await expect(err).toBeVisible();
    await expect(err).toContainText("on our side");
    await expect(err).not.toContainText("<html>");
    await shot(page, "state-unavailable", "light", 1440);
    fail = false;
    await err.getByRole("button", { name: "Try again" }).click();
    await expect(page.getByTestId("cases-table")).toBeVisible();
    w.assertClean();
  });

  test("a dropped connection is UNAVAILABLE too, never a blank page", async ({ page }) => {
    const w = watch(page);
    w.allow(/ERR_FAILED|Failed to load resource/);
    await page.route("**/api/sources", (route) => route.abort("failed"));
    await page.goto("/sources");
    await expect(page.locator('[data-failure="UNAVAILABLE"]')).toBeVisible();
    // The page around it still works.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Source console");
    w.assertClean();
  });

  test("FORBIDDEN is not an outage: retrying will not help, and it says so", async ({ page }) => {
    const w = watch(page);
    w.allow(/403/);
    await page.route("**/api/cases", (route) => json(route, errorBody("FORBIDDEN", "Your identity may not list cases."), 403));
    await page.goto("/cases");
    const err = page.locator('[data-failure="FORBIDDEN"]');
    await expect(err).toContainText("Refused by policy");
    await expect(err).toContainText("not an outage");
    await expect(err).toContainText("Your identity may not list cases.");
    await expect(err).not.toContainText("on our side");
    await shot(page, "state-forbidden", "light", 1440);
    w.assertClean();
  });

  test("a reply that does not match the contract is shown as unexpected, not rendered as blanks", async ({ page }) => {
    const w = watch(page);
    await page.route("**/api/cases", (route) => json(route, [{ id: "x", title: 5 }]));
    await page.goto("/cases");
    const err = page.locator('[data-failure="CONTRACT"]');
    await expect(err).toContainText("Unexpected reply");
    await expect(err.locator(".state__issues")).not.toBeEmpty();
    w.assertClean();
  });

  test("EMPTY: a service with no cases and no sources shows designed empty states", async ({ page }) => {
    const w = watch(page);
    await page.route("**/api/cases", (route) => json(route, []));
    await page.route("**/api/sources", (route) => json(route, []));
    await page.goto("/cases");
    await expect(page.getByText("No cases yet")).toBeVisible();
    await page.goto("/sources");
    await expect(page.getByText("No sources are registered")).toBeVisible();
    await page.goto("/");
    await expect(page.getByText(/No case is loaded yet/)).toBeVisible();
    w.assertClean();
  });

  test("a federated result with no rows is not the same as no federated result", async ({ page, request }) => {
    const w = watch(page);
    const id = (await primaryCase(request)).summary.id;
    await modifyCase(page, id, (c) => {
      c.matrix.rows = [];
    });
    await page.goto(`/cases/${id}/matrix`);
    await ready(page);
    await expect(page.getByText("The query ran and returned no rows")).toBeVisible();
    await page.unroute(`**/api/cases/${id}`);
    await modifyCase(page, id, (c) => {
      delete c.matrix;
    });
    await page.goto(`/cases/${id}/matrix`);
    await ready(page);
    await expect(page.getByText("No federated result for this case")).toBeVisible();
    w.assertClean();
  });

  test("loading is a designed skeleton, and nothing jumps when content lands", async ({ page, request }) => {
    const w = watch(page);
    const id = (await primaryCase(request)).summary.id;
    await page.route(`**/api/cases/${id}`, async (route) => {
      await new Promise((r) => setTimeout(r, 1200));
      await route.continue();
    });
    await page.goto(`/cases/${id}`);
    await expect(page.locator('.skeleton[aria-busy="true"]')).toBeVisible();
    await shot(page, "state-loading", "light", 1440);
    await expect(page.getByTestId("decision-form")).toBeVisible();
    w.assertClean();
  });
});

test.describe("degraded run modes are always visible", () => {
  test("federation off, model unreachable and an unreachable service each read plainly", async ({ page }) => {
    const w = watch(page);
    await page.route("**/api/health", async (route) => {
      const res = await route.fetch();
      const b = await res.json();
      b.mode = { sample: false, federation: "off", model: "nightshift", sources: "live", zetarisReachable: false, nightshiftReachable: false, degradedNotes: ["Nightshift answered slowly on the last probe."] };
      await json(route, b);
    });
    await page.goto("/");
    const bar = page.getByTestId("run-mode");
    await expect(bar).toContainText("Live run");
    await expect(bar).toContainText("Federation: off");
    await expect(bar).toContainText("Nightshift unreachable");
    await expect(bar).toContainText("Degraded: Nightshift answered slowly");
    await shot(page, "state-degraded-banner", "light", 1440);
    w.assertClean();
  });

  test("the banner shows on every screen, and says when the service itself is down", async ({ page }) => {
    const w = watch(page);
    w.allow(/503/);
    await page.route("**/api/health", (route) => json(route, errorBody("UNAVAILABLE", "down"), 503));
    for (const p of ["/", "/sources", "/guard", "/about"]) {
      await page.goto(p);
      await expect(page.getByTestId("run-mode")).toContainText("Service not reachable");
    }
    w.assertClean();
  });
});

test.describe("investigation stream states (test double for the stream)", () => {
  const ev = (seq: number, extra: Record<string, unknown>) => `data: ${JSON.stringify({ runId: "run_test", seq, at: "2026-10-27T10:00:00.000Z", role: "extractor", decision: "x", done: false, ...extra })}\n\n`;

  test("model replies show the routed model, recorded or live, and the receipt or its absence", async ({ page, request }) => {
    const w = watch(page);
    const id = (await primaryCase(request)).summary.id;
    const body =
      ev(0, { role: "system", decision: "Run started." }) +
      ev(1, { role: "extractor", decision: "Read the age floor from the summary.", model: { routedModel: "nemotron-lightning-30b", recorded: true, receiptId: "rcpt_0123456789abcdef" } }) +
      ev(2, { role: "critic", decision: "No contrary material.", model: { routedModel: "nemotron-ultra-550b", recorded: false } }) +
      ev(3, { role: "system", decision: "Run finished.", done: true });
    await page.route(`**/api/cases/${id}/investigate`, (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body }));
    await page.goto(`/cases/${id}/investigation`);
    await ready(page);
    await page.getByTestId("start-run").click();
    await expect(page.getByTestId("trace-status")).toContainText("Finished: 4 decisions");
    const rec = page.locator('[data-seq="1"]');
    await expect(rec).toContainText("nemotron-lightning-30b");
    await expect(rec).toContainText("Recorded reply");
    await expect(rec).toContainText("rcpt_0123456789");
    const live = page.locator('[data-seq="2"]');
    await expect(live).toContainText("Live reply");
    await expect(live).toContainText("Unreceipted");
    await shot(page, "state-investigation-models", "light", 1440);
    w.assertClean();
  });

  test("a stream that ends before the run reports completion is not presented as a full record", async ({ page, request }) => {
    const w = watch(page);
    const id = (await primaryCase(request)).summary.id;
    const body = ev(0, { role: "system", decision: "Run started." }) + ev(1, { role: "retriever", decision: "Ran one statement." });
    await page.route(`**/api/cases/${id}/investigate`, (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body }));
    await page.goto(`/cases/${id}/investigation`);
    await ready(page);
    await page.getByTestId("start-run").click();
    await expect(page.getByTestId("trace-status")).toContainText("Did not finish");
    await expect(page.getByText("It is not a full record of the run")).toBeVisible();
    await expect(page.getByTestId("trace-download")).toHaveCount(0);
    w.assertClean();
  });

  test("a malformed event is a contract error, and a refused stream shows the service's reason", async ({ page, request }) => {
    const w = watch(page);
    w.allow(/403/);
    const id = (await primaryCase(request)).summary.id;
    await page.route(`**/api/cases/${id}/investigate`, (route) => route.fulfill({ status: 200, contentType: "text/event-stream", body: 'data: {"seq":"one"}\n\n' }));
    await page.goto(`/cases/${id}/investigation`);
    await ready(page);
    await page.getByTestId("start-run").click();
    await expect(page.locator('[data-failure="CONTRACT"]')).toBeVisible();
    await page.unroute(`**/api/cases/${id}/investigate`);
    await page.route(`**/api/cases/${id}/investigate`, (route) => json(route, errorBody("FORBIDDEN", "Investigations are off for this identity."), 403));
    await page.getByTestId("start-run").click();
    await expect(page.locator('[data-failure="FORBIDDEN"]')).toContainText("Investigations are off for this identity.");
    w.assertClean();
  });
});

test.describe("drills and the dossier when the service misbehaves", () => {
  test("a drill whose invariant did not hold is shown as broken, loudly", async ({ page, request }) => {
    const w = watch(page);
    const id = (await primaryCase(request)).summary.id;
    await page.route(`**/api/cases/${id}/drill`, async (route) => {
      const res = await route.fetch();
      const b = await res.json();
      b.after[0].label = "SUPPORTED_FOR_SCOPE";
      b.before[0].label = "INSUFFICIENT_EVIDENCE";
      b.invariantHeld = false;
      await json(route, b);
    });
    await page.goto(`/cases/${id}/drills`);
    await ready(page);
    await page.locator('[data-run="source_off"]').click();
    await expect(page.getByText("An invariant did not hold")).toBeVisible();
    await expect(page.locator('[data-check="no-rise"]')).toHaveAttribute("data-ok", "false");
    await expect(page.getByTestId("drill-result")).toHaveAttribute("data-held", "false");
    await shot(page, "state-drill-broken", "light", 1440);
    w.assertClean();
  });

  test("a verifier that passes a tampered copy is reported as a defect, not as success", async ({ page, request }) => {
    const w = watch(page);
    const id = (await quietCase(request)).summary.id;
    await page.route("**/api/dossier/verify", async (route) => json(route, { ok: true, checks: [{ name: "x", ok: true }], failures: [], signatureNote: "integrity only", keyKind: "demo" }));
    await page.goto(`/cases/${id}/dossier`);
    await ready(page);
    await page.getByTestId("export-dossier").click();
    await expect(page.getByTestId("dossier-summary")).toBeVisible();
    await page.getByTestId("tamper").click();
    await expect(page.getByText("The altered copy passed (this is a defect)")).toBeVisible();
    w.assertClean();
  });

  test("a changed-shape timeline event and an out-of-date finding are flagged", async ({ page, request }) => {
    const w = watch(page);
    const id = (await primaryCase(request)).summary.id;
    await page.route(`**/api/cases/${id}/timeline*`, (route) =>
      json(route, [
        { at: "2026-10-01T00:00:00.000Z", kind: "source_changed", summary: "The registry record changed.", factIds: ["ev.x"], findingIds: [] },
        { at: "2026-10-01T00:00:01.000Z", kind: "finding_stale", summary: "Depends on a changed fact.", factIds: ["ev.x"], findingIds: ["fnd_abc123456789"] },
      ]),
    );
    await page.goto(`/cases/${id}/timeline`);
    await ready(page);
    await expect(page.getByText("1 finding out of date")).toBeVisible();
    await page.getByRole("checkbox", { name: "Show only changes" }).check();
    await expect(page.getByTestId("timeline").locator("li")).toHaveCount(2);
    w.assertClean();
  });
});
