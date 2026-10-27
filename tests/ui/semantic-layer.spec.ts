import { expect, type Page, type Route } from "@playwright/test";
import { test, axe, ready, setTheme, shot, watch, widths } from "./helpers";

/**
 * The Unified Semantic Layer panel on the Source console. Expectations come from GET /api/usl on the server under test, so the same
 * file runs against the fixture server and the real service. States the server cannot be put into on request (an outage, a failed
 * rule, an empty layer, a reply in the wrong shape) are produced by answering /api/usl in the browser with a changed copy of the
 * real reply or with a real error body, and each says so.
 */

interface Usl {
  layer: { namespace: string; name: string; path: string; structureHash: string };
  tables: { name: string; description: string; rows: number | null; columns: { name: string }[]; sources: string[]; activated: boolean }[];
  definitions: { kind: string; term: string; label: string; canonical: string; ancestry: string[] }[];
  dqRules: { rule: string; table: string; verdict: "PASSED" | "FAILED" | "UNVERIFIABLE"; rowsChecked: number; failures: number; queryId: string; consequence: string }[];
  completeness: { verdict: "PASSED" | "FAILED" | "UNVERIFIABLE"; collections: { collectionId: string; status: string; expectedTotal: number | null; retrievedTotal: number | null }[]; complete: string[]; blocked: string[]; codeCheckAgrees: boolean };
  unresolved: unknown[];
  servedFrom: "live" | "cassette";
  recordedAt: string;
  readerIdentity: string;
  statements: { statement: string; queryId: string }[];
}

const USL = "**/api/usl*";

/** Answers /api/usl with a changed copy of what the server really said. */
async function alter(page: Page, change: (real: Usl) => unknown) {
  await page.route(USL, async (route: Route) => {
    const res = await route.fetch();
    const real = (await res.json()) as Usl;
    await route.fulfill({ response: res, json: change(structuredClone(real)) });
  });
}

const panel = (page: Page) => page.getByTestId("usl-panel");

test.describe("semantic layer panel", () => {
  test("shows the layer, its tables, definitions, rules with query ids, completeness, the reader and the served-from badge, all as the API said", async ({ page, request }) => {
    const res = await request.get("/api/usl");
    expect(res.status(), "GET /api/usl").toBe(200);
    const usl = (await res.json()) as Usl;
    const w = watch(page);
    await page.goto("/sources");
    await ready(page);
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByRole("heading", { name: "Unified Semantic Layer", level: 2 })).toBeVisible();

    // identity and provenance
    await expect(page.getByTestId("usl-layer-name")).toHaveText(usl.layer.name);
    await expect(page.getByTestId("usl-provenance")).toContainText(usl.layer.path);
    await expect(page.getByTestId("usl-reader")).toContainText(usl.readerIdentity);
    await expect(page.getByTestId("usl-reader")).toContainText("read-only");
    await expect(page.getByTestId("usl-served").locator("[data-provenance]")).toHaveAttribute("data-provenance", usl.servedFrom === "live" ? "live" : "cassette");
    await expect(page.getByTestId("usl-served")).toContainText(usl.servedFrom === "live" ? "Live" : "Recorded query");
    await expect(page.getByTestId("usl-recorded-at")).toContainText(String(new Date(usl.recordedAt).getUTCFullYear()));

    // tables, with rows and the silo tables they read
    const tables = page.getByTestId("usl-tables");
    await expect(tables.locator("tbody tr")).toHaveCount(usl.tables.length);
    for (const t of usl.tables) {
      const row = tables.locator(`[data-table="${t.name}"]`);
      await expect(row).toContainText(t.description.slice(0, 40));
      await expect(row).toContainText(t.rows === null ? "not counted" : t.rows.toLocaleString("en-GB"));
      await expect(row).toContainText(`${t.columns.length} column`);
      for (const s of t.sources) await expect(row).toContainText(s);
    }

    // definitions
    const defs = page.getByTestId("usl-definitions");
    await expect(defs.locator("tbody tr")).toHaveCount(usl.definitions.length);
    for (const d of usl.definitions.slice(0, 6)) await expect(defs.locator(`[data-kind="${d.kind}"][data-term="${d.term}"]`)).toContainText(d.label);

    // rules: verdict, rows checked, failures, query id
    const rules = page.getByTestId("usl-rules");
    await expect(rules.locator("tbody tr")).toHaveCount(usl.dqRules.length);
    for (const r of usl.dqRules) {
      const row = rules.locator(`[data-rule="${r.rule}"]`);
      await expect(row).toHaveAttribute("data-verdict", r.verdict);
      await expect(row.locator("[data-verdict]").first()).toBeVisible();
      await expect(row.locator(".status-pill")).toContainText(r.verdict === "PASSED" ? "Passed" : r.verdict === "FAILED" ? "Failed" : "Could not be judged");
      await expect(row).toContainText(r.rowsChecked.toLocaleString("en-GB"));
      await expect(row.locator("td[data-failures]")).toHaveAttribute("data-failures", String(r.failures));
      await expect(row.locator(`[title="${r.queryId}"]`)).toBeVisible();
      if (r.verdict === "FAILED") await expect(row).toContainText(`${r.failures.toLocaleString("en-GB")} of ${r.rowsChecked.toLocaleString("en-GB")} rows failed`);
    }
    await expect(page.getByTestId("usl-rules-summary")).toContainText(`${usl.dqRules.filter((r) => r.verdict === "PASSED").length} passed`);

    // completeness
    const comp = page.getByTestId("usl-completeness");
    await expect(comp).toHaveAttribute("data-verdict", usl.completeness.verdict);
    await expect(page.getByTestId("usl-collections").locator("tbody tr")).toHaveCount(usl.completeness.collections.length);

    // the statements it took
    await page.getByText(/How this was read: \d+ statements?/).click();
    await expect(page.getByTestId("usl-statements").locator("li")).toHaveCount(usl.statements.length);
    await shot(page, "flow-semantic-layer", "light", 1440);
    w.assertClean();
  });

  test("a failed rule reads as a result about the data, and a rule that could not be judged reads as neither a pass nor a failure", async ({ page, request }) => {
    const real = (await (await request.get("/api/usl")).json()) as Usl;
    expect(real.dqRules.length).toBeGreaterThan(2);
    // Changed in the browser: the real reply with two rules set to the other verdicts. A real FAILED rule is also in the recording; this makes both kinds present at once.
    await alter(page, (u) => {
      u.dqRules[0] = { ...u.dqRules[0]!, verdict: "FAILED", failures: 3, rowsChecked: 7 };
      u.dqRules[1] = { ...u.dqRules[1]!, verdict: "UNVERIFIABLE", failures: 0, rowsChecked: 0 };
      return u;
    });
    const w = watch(page);
    await page.goto("/sources");
    await ready(page);
    const rules = page.getByTestId("usl-rules");
    const failed = rules.locator(`[data-rule="${real.dqRules[0]!.rule}"]`);
    await expect(failed.locator(".status-pill")).toContainText("Failed");
    await expect(failed).toContainText("3 of 7 rows failed");
    const unjudged = rules.locator(`[data-rule="${real.dqRules[1]!.rule}"]`);
    await expect(unjudged.locator(".status-pill")).toContainText("Could not be judged");
    await expect(unjudged).toContainText("No rows to judge");
    await expect(unjudged.locator(".status-pill")).not.toContainText("Passed");
    // A failed rule does not turn the panel into an outage message.
    await expect(page.getByTestId("usl-unavailable")).toHaveCount(0);
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("usl-rules-summary")).toContainText("1 failed");
    await expect(page.getByTestId("usl-rules-summary")).toContainText("1 could not be judged");
    w.assertClean();
  });

  test("a failed completeness gate names the blocked collections and why, and the verdict is not shown as a pass", async ({ page }) => {
    await alter(page, (u) => {
      const c = u.completeness.collections[0]!;
      u.completeness.collections[0] = { ...c, status: "TRUNCATED", retrievedTotal: 39, expectedTotal: 110, reason: "39 of 110 records arrived" } as never;
      u.completeness = { ...u.completeness, verdict: "FAILED", blocked: [c.collectionId], complete: u.completeness.complete.filter((x) => x !== c.collectionId) };
      return u;
    });
    await page.goto("/sources");
    await ready(page);
    const comp = page.getByTestId("usl-completeness");
    await expect(comp).toHaveAttribute("data-verdict", "FAILED");
    await expect(comp).toContainText("landed collections are not complete");
    await expect(comp).toContainText("feeds nothing downstream");
    await expect(comp).toContainText("Cut short");
    await expect(comp).toContainText("39 of 110 records arrived");
    await expect(comp).not.toContainText("are complete");
  });

  test("an engine that cannot be asked is an outage with no table and no verdict, not an empty layer and not a pass; Try again recovers", async ({ page }) => {
    let calls = 0;
    await page.route(USL, async (route: Route) => {
      calls += 1;
      if (calls === 1) {
        // The body the service gives for a 503 UNAVAILABLE on this route.
        await route.fulfill({ status: 503, json: { error: { failure: "UNAVAILABLE", message: "the semantic layer cannot be read: Zetaris is not configured", detail: { reason: "USL_OFF", retryable: false } } } });
        return;
      }
      await route.continue();
    });
    const w = watch(page);
    w.allow(/503/);
    await page.goto("/sources");
    await ready(page);
    const out = page.getByTestId("usl-unavailable");
    await expect(out).toBeVisible();
    await expect(panel(page)).toHaveAttribute("data-state", "unavailable");
    await expect(out.getByRole("alert")).toContainText("The semantic layer could not be read");
    await expect(out).toContainText("Zetaris is not configured");
    await expect(out).toContainText("Nothing here is a verdict");
    await expect(out).toContainText("not a layer with no tables, and not a rule that passed");
    // no table, no rule, no passed pill anywhere in the panel
    for (const id of ["usl-tables", "usl-rules", "usl-definitions", "usl-completeness"]) await expect(page.getByTestId(id)).toHaveCount(0);
    await expect(panel(page)).not.toContainText("Passed");
    await expect(panel(page)).not.toContainText("The layer has no tables");
    await shot(page, "state-semantic-layer-unavailable", "light", 1440);
    await out.getByTestId("retry-button").click();
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await expect(page.getByTestId("usl-rules").locator("tbody tr").first()).toBeVisible();
    expect(calls).toBeGreaterThanOrEqual(2);
    w.assertClean();
  });

  test("an empty layer, no rules and no landed collections each have a designed empty state that claims nothing", async ({ page }) => {
    await alter(page, (u) => {
      u.tables = [];
      u.definitions = [];
      u.dqRules = [];
      u.completeness = { verdict: "UNVERIFIABLE", collections: [], complete: [], blocked: [], codeCheckAgrees: true };
      return u;
    });
    const w = watch(page);
    await page.goto("/sources");
    await ready(page);
    await expect(page.getByText("The layer has no tables")).toBeVisible();
    await expect(page.getByText("This is an empty layer, not an outage.")).toBeVisible();
    await expect(page.getByText("The layer defines no terms")).toBeVisible();
    await expect(page.getByText("No data-quality rules are registered")).toBeVisible();
    await expect(page.getByText("so the panel shows no verdict rather than a pass")).toBeVisible();
    await expect(page.getByText("No landed collections are listed")).toBeVisible();
    await expect(page.getByTestId("usl-completeness")).toHaveAttribute("data-verdict", "UNVERIFIABLE");
    await expect(page.getByTestId("usl-completeness")).toContainText("Completeness could not be judged");
    await expect(panel(page)).not.toContainText("Passed");
    await shot(page, "state-semantic-layer-empty", "light", 1440);
    w.assertClean();
  });

  test("a reply in the wrong shape is shown as an unexpected reply, not rendered as blanks", async ({ page }) => {
    await page.route(USL, (route) => route.fulfill({ json: { layer: { name: "x" }, tables: "none" } }));
    await page.goto("/sources");
    await ready(page);
    const out = page.getByTestId("usl-unavailable");
    await expect(out).toContainText("Unexpected reply");
    await expect(out).toContainText("Nothing is shown rather than something wrong");
    await expect(page.getByTestId("usl-tables")).toHaveCount(0);
  });

  test("keeps the last reading on screen and says so when a later read fails", async ({ page }) => {
    await page.goto("/sources");
    await ready(page);
    await expect(panel(page)).toHaveAttribute("data-state", "ready");
    await page.route(USL, (route) => route.fulfill({ status: 503, json: { error: { failure: "UNAVAILABLE", message: "the engine stopped answering", detail: {} } } }));
    await page.getByRole("link", { name: /about/i }).first().click();
    await page.getByRole("link", { name: /source console|sources/i }).first().click();
    await ready(page);
    await expect(page.getByTestId("usl-tables")).toBeVisible();
    await expect(page.getByText("Showing the last reading we had")).toBeVisible();
  });

  test("copying a query id works from the keyboard and is announced", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]).catch(() => undefined);
    await page.goto("/sources");
    await ready(page);
    const first = page.getByTestId("usl-rules").locator("tbody tr").first();
    const id = await first.locator("code[title]").getAttribute("title");
    await first.getByRole("button", { name: /Copy query id/ }).focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("announcer")).toContainText("query id copied", { timeout: 5000 });
    expect(id).toMatch(/[0-9a-f-]{8,}/);
  });

  for (const theme of ["light", "dark"] as const) {
    test(`has no axe violations with every disclosure open (${theme})`, async ({ page }) => {
      await setTheme(page, theme);
      await page.goto("/sources");
      await ready(page);
      await page.getByText(/How this was read/).click();
      for (const d of await page.locator("[data-testid=usl-panel] details").all()) await d.evaluate((el) => ((el as HTMLDetailsElement).open = true));
      const violations = await axe(page);
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(" | ")}`)).toEqual([]);
      await shot(page, "flow-semantic-layer-open", theme, 1440);
    });
  }

  test("on a phone the panel stays inside the page and its tables scroll on their own", async ({ page }) => {
    await page.setViewportSize(widths.mobile);
    await page.goto("/sources");
    await ready(page);
    await panel(page).scrollIntoViewIfNeeded();
    const o = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(o).toBeLessThanOrEqual(0);
    await shot(page, "flow-semantic-layer", "light", 390);
  });
});
