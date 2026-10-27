import { expect, type Page } from "@playwright/test";
import { test, primaryCase, ready, watch } from "./helpers";

/** The main flow with the keyboard alone: no mouse, visible focus at every step. */

async function focusRing(page: Page): Promise<string> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return "none";
    const s = getComputedStyle(el);
    return s.outlineStyle !== "none" && parseFloat(s.outlineWidth) >= 2 ? "ring" : `no ring on ${el.tagName}.${el.className}`;
  });
}

async function tabTo(page: Page, matcher: (text: string) => boolean, max = 80) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const t = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.innerText?.trim() ?? "");
    if (matcher(t)) return;
  }
  throw new Error("focus never reached the target");
}

test("keyboard only: skip link, open a case, read the X-ray, recompute in the lab, record a decision", async ({ page, request }) => {
  const detail = await primaryCase(request);
  const id = encodeURIComponent(detail.summary.id);
  const w = watch(page);
  await page.goto("/");
  await ready(page);

  // The first Tab stop is the skip link and it is visible; Enter jumps to the content.
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
  expect(await focusRing(page)).toBe("ring");
  await page.keyboard.press("Enter");
  await expect(page.locator("#main")).toBeFocused();

  // The live strip link opens the X-ray.
  await tabTo(page, (t) => t.startsWith("Open the claim X-ray"));
  expect(await focusRing(page)).toBe("ring");
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/claims\/fnd_/);
  // Focus lands on the heading of the new screen so a screen reader starts reading there.
  await expect(page.locator("#page-title")).toBeFocused();

  // An anchor opens with Enter, and the passage is reachable.
  await tabTo(page, (t) => t.startsWith("Show the exact evidence"));
  await page.keyboard.press("Enter");
  await expect(page.locator(".dim-anchors[open] .anchor").first()).toBeVisible();

  // The lab, through the case navigation.
  await page.getByRole("navigation", { name: /^Case / }).getByRole("link", { name: "Applicability lab" }).focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/lab$/);
  await page.locator("#lab-age-min").focus();
  await page.keyboard.type("40");
  await expect(page.getByTestId("lab-summary")).toBeVisible();
  await expect(page.getByTestId("announcer")).toContainText("Recomputed with no model call");

  // A decision, with the arrow keys on the radio group.
  await page.goto(`/cases/${id}`);
  await ready(page);
  await page.getByRole("radio", { name: /Accept/ }).focus();
  expect(await focusRing(page)).toBe("ring");
  await page.keyboard.press("Space");
  await expect(page.getByRole("radio", { name: /Accept/ })).toBeChecked();
  await page.keyboard.press("ArrowDown");
  await expect(page.getByRole("radio", { name: /Narrow/ })).toBeChecked();
  await page.keyboard.press("ArrowUp");
  await expect(page.getByRole("radio", { name: /Accept/ })).toBeChecked();
  await page.getByLabel("Note (optional)").focus();
  await page.keyboard.type("Reviewed by keyboard.");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Record decision" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("decision-history")).toContainText("accept");
  w.assertClean();
});

test("keyboard only: add a source and read the refusal", async ({ page }) => {
  const w = watch(page);
  w.allow(/status of 422/); // a refusal is an HTTP 4xx on the real service, and the browser logs it
  await page.goto("/sources");
  await ready(page);
  await page.locator("#src-desc").focus();
  await page.keyboard.type("Device identifier records for a screening product");
  await page.keyboard.press("Tab");
  await page.keyboard.type("https://169.254.169.254/latest/meta-data/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Onboard this source" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator('[data-outcome="declined"], [data-testid="onboarding-error"]').first()).toBeVisible({ timeout: 10_000 });
  w.assertClean();
});

test("focus order follows the visual order on the lab", async ({ page, request }) => {
  await page.goto(`/cases/${encodeURIComponent((await primaryCase(request)).summary.id)}/lab`);
  await ready(page);
  const order: string[] = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const id = await page.evaluate(() => (document.activeElement as HTMLElement | null)?.id ?? "");
    if (id.startsWith("lab-") && order[order.length - 1] !== id) order.push(id); // a date field has several tab stops inside it
  }
  expect(order.slice(0, 7)).toEqual(["lab-versions", "lab-age-min", "lab-age-max", "lab-purpose", "lab-date", "lab-threshold", "lab-asof"]);
});

test("zoomed to 200% the main screens stay usable with no sideways scroll", async ({ page, request }) => {
  const id = encodeURIComponent((await primaryCase(request)).summary.id);
  await page.setViewportSize({ width: 720, height: 450 }); // 1440 x 900 at 200%
  for (const p of ["/", `/cases/${id}`, `/cases/${id}/claims`, `/cases/${id}/lab`, "/sources"]) {
    await page.goto(p);
    await ready(page);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, `${p} scrolls sideways at 200%`).toBeLessThanOrEqual(0);
  }
});
