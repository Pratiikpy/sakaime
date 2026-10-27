// Scene "Investigation": the bounded loop, role by role, with the model that answered and its Nightshift receipt.
import { CASE } from "../lib.mjs";

export async function run(s) {
  const { page } = s;
  await s.goto(`/cases/${CASE}/investigation`, { settle: 1200 });
  await s.mark("start", null, { hold: 700 });
  await s.mark("roles", page.getByTestId("role-preview"), { hold: 1100 });
  await s.click(page.getByTestId("start-run"), { after: 400 });
  await s.mark("running", page.getByTestId("trace-status"));
  await page.getByTestId("trace").waitFor({ timeout: 30000 });
  await s.sleep(3500);
  await s.mark("trace", page.getByTestId("trace"), { hold: 1500 });
  const planner = page.locator('.trace-item[data-role="planner"]').first();
  if (await planner.count()) {
    await s.scrollTo(planner, { offset: 220, ms: 1200 });
    await s.mark("planner", planner, { hold: 2200 });
  }
  const critic = page.locator('.trace-item[data-role="critic"]').first();
  if (await critic.count()) {
    await s.scrollTo(critic, { offset: 220, ms: 1400 });
    await s.mark("critic", critic, { hold: 2400 });
  }
}
