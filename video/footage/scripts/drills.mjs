// Scene "Failure drills": all seven, then one in detail. A lost source never becomes supported.
import { CASE } from "../lib.mjs";

export async function run(s) {
  const { page } = s;
  await s.goto(`/cases/${CASE}/drills`, { settle: 1200 });
  await s.mark("start", null, { hold: 700 });
  await s.scrollTo(page.getByRole("heading", { name: "Drills" }), { offset: 130, ms: 900 });
  await s.mark("cards", page.locator(".drill-card").first().locator("xpath=ancestor::ul[1]"), { hold: 1500 });
  // one drill on its own first: a registry record changes and only the findings that depend on it go stale
  await s.click(page.locator('[data-run="registry_changed"]'), { after: 700 });
  const one = page.getByTestId("drill-result").first();
  await one.waitFor({ timeout: 30000 });
  await s.sleep(500);
  await s.scrollTo(one, { offset: 150, ms: 1100 });
  await s.mark("stale", one, { hold: 2600 });
  await s.scrollTo(page.getByRole("heading", { name: "Drills" }), { offset: 130, ms: 900 });
  await s.click(page.getByTestId("run-all"), { after: 500 });
  await page.getByTestId("drill-summary").waitFor({ timeout: 90000 }).catch(() => {});
  await s.sleep(2500);
  const summary = page.getByTestId("drill-summary");
  if (await summary.count()) {
    await s.scrollTo(summary, { offset: 150, ms: 1100 });
    await s.mark("summary", summary, { hold: 2200 });
  }
  const result = page.getByTestId("drill-result").first();
  if (await result.count()) {
    await s.scrollTo(result, { offset: 150, ms: 1000 });
    await s.mark("detail", result, { hold: 2200 });
  }
}
