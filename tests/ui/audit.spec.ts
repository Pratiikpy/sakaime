import { expect } from "@playwright/test";
import { test, primaryCase, ready, shot, watch } from "./helpers";

/**
 * What a first-time reader must be able to see without being told: where an answer came from, how the records behind it were
 * joined, and which sponsor technology does what. Every figure on the page is compared with the service's own case response.
 */

const enc = encodeURIComponent;

test.describe("where an answer came from", () => {
  test("the case page counts the source documents and the link states from the case the service sent", async ({ page, request }) => {
    const w = watch(page);
    const d = await primaryCase(request);
    await page.goto(`/cases/${enc(d.summary.id)}`);
    await ready(page);
    const trail = page.getByTestId("source-trail").first();
    await expect(trail).toBeVisible();
    const docs = new Set(d.anchors.map((a) => `${(a as unknown as { sourceId: string }).sourceId}|${a.sourceLabel}`)).size;
    await expect(trail).toContainText(`Read from ${docs} source document${docs === 1 ? "" : "s"}`);
    for (const state of ["CONFIRMED", "CANDIDATE", "AMBIGUOUS"] as const) {
      const n = d.links.filter((l) => l.state === state).length;
      if (n > 0) await expect(trail.locator(".trail__states")).toContainText(`${n} ${state.toLowerCase()}`);
    }
    await expect(trail.getByRole("link", { name: /next to its source on the claim X-ray/ })).toBeVisible();
    await shot(page, "audit-source-trail", "light", 1440);
    w.assertClean();
  });

  test("the landing page shows the same trail for the worked case, and the hero names the fragmentation", async ({ page }) => {
    const w = watch(page);
    await page.goto("/");
    await ready(page);
    await expect(page.locator(".hero")).toContainText("places that share no identifier");
    await expect(page.getByRole("heading", { name: "A worked case" })).toBeVisible();
    await expect(page.getByTestId("live-strip").getByTestId("source-trail")).toBeVisible();
    w.assertClean();
  });
});

test.describe("copy a reviewer reads", () => {
  test("a reason from the compiler starts with a capital, and a list of open parts reads as a phrase", async ({ page, request }) => {
    const w = watch(page);
    const d = await primaryCase(request);
    await page.goto(`/cases/${enc(d.summary.id)}/claims`);
    await ready(page);
    for (const t of await page.locator(".dim-row__reason").allInnerTexts()) expect(t.trim()[0], t).toBe(t.trim()[0]!.toUpperCase());
    // "population, performance" with no "and" is the list shape that read as broken.
    await expect(page.locator("main")).not.toContainText(/cannot settle \w+, \w+;/);
    w.assertClean();
  });

  test("the investigation screen lists the roles before a run, so it is not an empty page", async ({ page, request }) => {
    const w = watch(page);
    const d = await primaryCase(request);
    await page.goto(`/cases/${enc(d.summary.id)}/investigation`);
    await ready(page);
    const roles = page.getByTestId("role-preview").locator("li");
    expect(await roles.count()).toBeGreaterThanOrEqual(6);
    await expect(page.getByTestId("role-preview")).toContainText("Compiler");
    w.assertClean();
  });
});

test.describe("about", () => {
  test("names each sponsor technology and what it changes, and the figures carry their own counts", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/about");
    await ready(page);
    const tech = page.getByTestId("sponsor-tech");
    for (const name of ["Zetaris", "Meterless", "NVIDIA Nemotron"]) await expect(tech).toContainText(name);
    // The scope of the rule-table check is the file's own n, not a typed-in count.
    const res = await request.get("/results.json");
    if (res.ok()) {
      const rows = ((await res.json()) as { rows: { id: string; denominator?: string; limits?: string }[] }).rows;
      const row = rows.find((r) => r.id === "scopeshift-a-exact");
      if (row?.denominator) {
        const n = row.denominator.split("/")[1]!;
        await expect(page.locator('[data-row="scopeshift-a-exact"]')).toContainText(`${n} cases`);
      }
      const fs = rows.find((r) => r.id === "scopeshift-a-false-supported");
      if (fs) await expect(page.locator('[data-row="scopeshift-a-false-supported"]')).not.toContainText("it is not zero");
    }
    w.assertClean();
  });
});
