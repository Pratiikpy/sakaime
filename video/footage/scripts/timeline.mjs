// Scene "Timeline": read the case as it stood on a date, and see which findings depend on which facts.
import { CASE } from "../lib.mjs";

export async function run(s) {
  const { page } = s;
  await s.goto(`/cases/${CASE}/timeline`, { settle: 1200 });
  await s.mark("start", null, { hold: 800 });
  const asOf = page.locator("#asof");
  await s.scrollTo(asOf, { offset: 260, ms: 900 });
  await s.mark("controls", page.locator("#controls"), { hold: 700 });
  await s.click(asOf, { after: 200 });
  await page.keyboard.press("Control+A");
  await page.keyboard.type("01012018", { delay: 120 });
  await s.sleep(900);
  await s.mark("asof", page.getByTestId("timeline-status"), { hold: 1500 });
  const events = page.getByTestId("timeline");
  await s.scrollTo(events, { offset: 140, ms: 1100 });
  await s.mark("events", events, { hold: 1800 });
}
