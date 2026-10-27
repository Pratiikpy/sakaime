import { expect, test } from "@playwright/test";
import { SCREENS, ready } from "./helpers";

for (const width of [360, 390, 768, 1024, 1440]) {
  test(`no sideways page scroll at ${width}px on any screen`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    for (const s of SCREENS) {
      await page.goto(s.path);
      await ready(page);
      await page.waitForTimeout(150);
      const o = await page.evaluate(() => {
        const de = document.documentElement;
        const wide = [...document.querySelectorAll<HTMLElement>("body *")].filter(
          (e) => e.getBoundingClientRect().right > de.clientWidth + 1 && !e.closest(".table-wrap-scroll, .case-nav__inner, .code-block, .sr-only") && getComputedStyle(e).position !== "fixed",
        );
        return { over: de.scrollWidth - de.clientWidth, wide: wide.slice(0, 3).map((e) => `${e.tagName}.${e.className}`) };
      });
      expect(o.over, `${s.name} at ${width}px: overflow ${o.over}, wide: ${o.wide.join(", ")}`).toBeLessThanOrEqual(0);
    }
  });
}

test("on a phone, buttons and disclosure summaries are at least 44px tall", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const small: string[] = [];
  for (const s of SCREENS) {
    await page.goto(s.path);
    await ready(page);
    const found = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button, summary, .btn")]
        .filter((e) => e.offsetParent !== null && !e.closest(".sr-only"))
        .map((e) => ({ t: (e.innerText || e.getAttribute("aria-label") || e.className).trim().slice(0, 30), h: e.getBoundingClientRect().height }))
        .filter((x) => x.h < 43.5),
    );
    for (const f of found) small.push(`${s.name}: "${f.t}" is ${Math.round(f.h)}px`);
  }
  expect(small).toEqual([]);
});
