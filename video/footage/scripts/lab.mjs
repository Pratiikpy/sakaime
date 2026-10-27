// Scene "Applicability lab": version 2.1.0 becomes 3.0 and the answer recomputes with no model call.
import { CASE } from "../lib.mjs";

export async function run(s) {
  const { page } = s;
  await s.goto(`/cases/${CASE}/lab`, { settle: 1200 });
  await s.mark("start", null, { hold: 800 });
  const version = page.locator("#lab-versions");
  await s.scrollTo(version, { offset: 260, ms: 900 });
  await s.mark("form", page.locator("form.lab-form"), { hold: 900 });
  await s.mark("baseline", page.getByTestId("lab-baseline"), { hold: 1100 });
  await s.click(version, { after: 200 });
  await page.keyboard.press("Control+A");
  await s.sleep(250);
  for (const ch of "3.0") {
    await page.keyboard.type(ch);
    await s.sleep(260);
  }
  await s.mark("typed", version, { hold: 500 });
  await page.getByTestId("lab-result").waitFor({ timeout: 20000 });
  await s.sleep(500);
  await s.mark("result", page.getByTestId("lab-result"), { hold: 2000 });
  const nomodel = page.getByTestId("no-model");
  if (await nomodel.count()) await s.mark("nomodel", nomodel, { hold: 1500 });
  const missing = page.getByTestId("lab-missing");
  if (await missing.count()) {
    await s.scrollTo(missing, { offset: 280, ms: 900 });
    await s.mark("missing", missing, { hold: 1600 });
  }
}
