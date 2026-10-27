// Scene "Claim X-ray": CLM-EA-01 (supported) and CLM-EA-08 (contradicted), dimension by dimension, with the passage and its page.
import { BASE, CASE } from "../lib.mjs";

async function findingId(s, claimId) {
  const res = await s.page.request.get(`${BASE}/api/cases/${CASE}`);
  const body = await res.json();
  return body.findings.find((f) => f.claimId === claimId).id;
}

export async function run(s) {
  const { page } = s;
  const supported = await findingId(s, "CLM-EA-01");
  const contradicted = await findingId(s, "CLM-EA-08");
  await s.goto(`/cases/${CASE}/claims`, { settle: 1000 });
  await s.mark("start", null, { hold: 900 });
  const switcher = page.getByText(/Switch to another of/).first();
  await s.click(switcher, { after: 700 });
  await s.mark("switcher", page.locator("details, .disclosure").first(), { hold: 700 });
  const link = page.locator(`a[href$="/claims/${supported}"]`).first();
  if (await link.count()) await s.click(link, { after: 1300 });
  else await s.goto(`/cases/${CASE}/claims/${supported}`, { settle: 900 });
  await page.getByTestId("dimensions").waitFor();
  await s.mark("answer", page.locator("#answer"), { hold: 1000 });
  await s.scrollTo(page.getByTestId("dimensions"), { offset: 130, ms: 1100 });
  await s.mark("dimensions", page.getByTestId("dimensions"), { hold: 1500 });
  const show = page.getByRole("button", { name: /Show the other/ }).first();
  if (await show.count()) await s.click(show, { after: 700 });
  await s.mark("passages", page.getByTestId("dimensions"), { hold: 1700 });
  // switch claim inside the app (no page reload) when the switcher is there, the way a reviewer would
  await s.scrollTop(900);
  const switcherAgain = page.getByText(/Switch to another of/).first();
  const other = page.locator(`a[href$="/claims/${contradicted}"]`).first();
  let switched = false;
  if (await switcherAgain.isVisible().catch(() => false)) {
    await switcherAgain.click({ timeout: 4000 }).catch(() => {});
    await s.sleep(500);
    if (await other.isVisible().catch(() => false)) {
      await s.click(other, { after: 1200 });
      switched = true;
    }
  }
  if (!switched) await s.goto(`/cases/${CASE}/claims/${contradicted}`, { settle: 900 });
  await page.getByTestId("dimensions").waitFor();
  await s.mark("contradicted", page.locator("#answer"), { hold: 1400 });
  await s.scrollTo(page.getByTestId("counterexample"), { offset: 150, ms: 1100 });
  await s.mark("counterexample", page.getByTestId("counterexample"), { hold: 2200 });
}
