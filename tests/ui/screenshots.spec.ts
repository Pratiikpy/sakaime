import { test, primaryCase, ready, screensFor, setTheme, shot, watch, widths } from "./helpers";

// Full-page screenshots of every screen, light and dark, at 1440 and 390 wide. They are read by a person afterwards.
for (const theme of ["light", "dark"] as const) {
  for (const [label, size] of Object.entries(widths)) {
    test(`screenshots ${theme} ${label}`, async ({ page, request }) => {
      const detail = await primaryCase(request);
      const w = watch(page);
      await setTheme(page, theme);
      await page.setViewportSize(size);
      for (const s of screensFor(detail.summary.id)) {
        await page.goto(s.path);
        await ready(page);
        await page.waitForTimeout(250);
        await shot(page, s.name, theme, size.width);
      }
      w.assertClean();
    });
  }
}
