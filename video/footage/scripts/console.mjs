// Scene "Source console": the refusal of a cloud metadata address, then the table of every source.
export async function run(s) {
  const { page } = s;
  await s.goto("/sources", { settle: 1000 });
  await s.mark("start", null, { hold: 700 });
  await s.scrollTo(page.getByRole("heading", { name: "Add a source" }), { offset: 120 });
  await s.click(page.getByRole("button", { name: "A cloud metadata address" }));
  await s.mark("filled", page.locator("form.form"), { hold: 500 });
  await s.click(page.getByRole("button", { name: "Onboard this source" }), { after: 300 });
  const outcome = page.locator("[data-testid=onboarding-result], [data-testid=onboarding-error]").first();
  await outcome.waitFor({ timeout: 20000 });
  await s.sleep(1200);
  const refusal = outcome;
  await s.mark("refused", refusal, { hold: 2200 });
  await s.scrollTo(page.getByTestId("sources-table"), { offset: 90, ms: 1200 });
  await s.mark("table", page.getByTestId("sources-table"), { hold: 1200 });
  const row = page.getByTestId("sources-table").locator("tbody tr").nth(3);
  await s.scrollTo(row, { offset: 300, ms: 1200 });
  await s.mark("health", row, { hold: 1600 });
}
