// Scene "Review desk": the desk, the missing-evidence list with the drafted vendor request, and a recorded decision.
import { CASE } from "../lib.mjs";

export async function run(s) {
  const { page } = s;
  await s.goto("/cases", { settle: 1200 });
  await s.mark("start", null, { hold: 700 });
  await s.mark("stats", page.getByTestId("desk-stats"), { hold: 1500 });
  await s.mark("table", page.getByTestId("cases-table"), { hold: 700 });
  await s.click(page.locator(`a[href$="/cases/${CASE}"]`).first(), { after: 1300 });
  const settle = page.getByTestId("settle").first();
  await settle.waitFor();
  await s.scrollTo(settle, { offset: 140, ms: 1200 });
  await s.mark("settle", settle, { hold: 1800 });
  const missing = page.getByTestId("missing-evidence");
  await s.scrollTo(missing, { offset: 130, ms: 1300 });
  await s.mark("missing", missing, { hold: 2200 });
  const form = page.getByTestId("decision-form").first();
  if (await form.count()) {
    await s.scrollTo(form, { offset: 200, ms: 1100 });
    await s.mark("decision", form, { hold: 900 });
    await s.click(form.locator("input[type=radio]").first(), { after: 300 });
    await s.mark("chosen", form, { hold: 700 });
    await s.click(form.getByRole("button", { name: /Record decision/ }).first(), { after: 1200 });
    const history = page.getByTestId("decision-history").first();
    if (await history.count()) await s.mark("recorded", history, { hold: 1600 });
  }
}
