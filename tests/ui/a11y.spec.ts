import { expect, test, type Page } from "@playwright/test";
import { SCREENS, axe, ready, setTheme, watch, widths } from "./helpers";

/** WCAG 2.2 AA through axe-core, on every screen and on the interactive states that add content. Zero violations. */

async function assertNoViolations(page: Page, where: string) {
  const violations = await axe(page);
  const summary = violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n   ${v.nodes.slice(0, 4).map((n) => n.target.join(" ")).join("\n   ")}`).join("\n");
  expect(violations, `${where}\n${summary}`).toEqual([]);
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`axe, ${theme}`, () => {
    test(`every screen has no violations (${theme}, desktop)`, async ({ page }) => {
      const w = watch(page);
      await setTheme(page, theme);
      for (const s of SCREENS) {
        await page.goto(s.path);
        await ready(page);
        await assertNoViolations(page, `${s.name} ${theme}`);
      }
      w.assertClean();
    });

    test(`interactive states have no violations (${theme})`, async ({ page }) => {
      const w = watch(page);
      await setTheme(page, theme);

      await page.goto("/cases/ea-02/claims");
      await ready(page);
      for (const s of await page.locator(".dim-anchors > summary").all()) await s.click();
      await page.locator(".link-item .disclosure summary").first().click();
      await assertNoViolations(page, `xray expanded ${theme}`);

      await page.goto("/cases/ea-02/lab");
      await ready(page);
      await page.locator("#lab-age-min").fill("22");
      await expect(page.getByTestId("lab-result")).toBeVisible();
      await assertNoViolations(page, `lab result ${theme}`);

      await page.goto("/sources");
      await ready(page);
      await page.locator('[data-example="allowed"]').click();
      await page.getByRole("button", { name: "Onboard this source" }).click();
      await expect(page.locator("[data-outcome]")).toBeVisible({ timeout: 10_000 });
      await assertNoViolations(page, `onboarding held ${theme}`);
      await page.locator('[data-example="metadata"]').click();
      await page.getByRole("button", { name: "Onboard this source" }).click();
      await expect(page.locator('[data-outcome="declined"]')).toBeVisible({ timeout: 10_000 });
      await assertNoViolations(page, `onboarding refused ${theme}`);

      await page.goto("/cases/ea-01/drills");
      await ready(page);
      await page.getByTestId("run-all").click();
      await expect(page.getByTestId("drill-summary").locator("tbody tr")).toHaveCount(7, { timeout: 30_000 });
      await assertNoViolations(page, `drills ${theme}`);

      await page.goto("/cases/ea-03/investigation");
      await ready(page);
      await page.getByTestId("start-run").click();
      await expect(page.getByTestId("trace-status")).toContainText("Finished", { timeout: 30_000 });
      await assertNoViolations(page, `investigation ${theme}`);

      await page.goto("/cases/ea-03/dossier");
      await ready(page);
      await page.getByTestId("export-dossier").click();
      await page.getByTestId("verify-dossier").click();
      await expect(page.getByTestId("verify-result")).toBeVisible();
      await page.getByTestId("tamper").click();
      await expect(page.getByTestId("tamper-out")).toBeVisible();
      await assertNoViolations(page, `dossier ${theme}`);

      await page.goto("/guard");
      await ready(page);
      await page.locator('[data-example="injection"]').click();
      await page.getByRole("button", { name: "Check the text" }).click();
      await expect(page.getByTestId("guard-result")).toBeVisible();
      await assertNoViolations(page, `guard hidden ${theme}`);
      await page.getByRole("button", { name: "Show the hidden words" }).click();
      await assertNoViolations(page, `guard revealed ${theme}`);

      await page.goto("/cases/ea-01");
      await ready(page);
      await page.getByTestId("decision-form").getByLabel(/Accept/).check();
      await assertNoViolations(page, `decision form ${theme}`);
      w.assertClean();
    });
  });
}

test("every screen has no violations on a phone (light and dark)", async ({ page }) => {
  await page.setViewportSize(widths.mobile);
  for (const theme of ["light", "dark"] as const) {
    await setTheme(page, theme);
    for (const s of SCREENS) {
      await page.goto(s.path);
      await ready(page);
      await assertNoViolations(page, `${s.name} ${theme} mobile`);
    }
  }
});

test("the menu button opens and closes the phone navigation and exposes its state", async ({ page }) => {
  await page.setViewportSize(widths.mobile);
  await page.goto("/");
  await ready(page);
  const button = page.getByRole("button", { name: "Menu" });
  await expect(button).toHaveAttribute("aria-expanded", "false");
  const nav = page.getByRole("navigation", { name: "Main" });
  await expect(nav.getByRole("link", { name: "Review desk" })).toBeHidden();
  await button.click();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(nav.getByRole("link", { name: "Review desk" })).toBeVisible();
  await nav.getByRole("link", { name: "Review desk" }).click();
  await expect(page).toHaveURL(/\/cases$/);
  await expect(button).toHaveAttribute("aria-expanded", "false");
});
