// Scene "Add a source": the allowed example through the eight stages; the semantic check holds four findings for a person.
export async function run(s) {
  const { page } = s;
  await s.goto("/sources", { settle: 1200 });
  await s.mark("start", null, { hold: 1300 });
  await s.scrollTo(page.getByRole("heading", { name: "Add a source" }), { offset: 120 });
  await s.mark("form", page.locator("form.form"), { hold: 600 });
  await s.click(page.getByRole("button", { name: "An allowed source" }));
  await s.mark("filled", page.locator("form.form"), { hold: 800 });
  await s.click(page.getByRole("button", { name: "Onboard this source" }), { after: 300 });
  await s.mark("running", page.getByTestId("onboarding-result"));
  await page.getByTestId("onboarding-result").waitFor();
  await s.sleep(4200); // the stages reveal one after another
  await s.mark("stages", page.getByTestId("onboarding-result"), { hold: 1400 });
  const semantic = page.locator(".stage__name", { hasText: "Semantic check" });
  await s.scrollTo(semantic, { offset: 150, ms: 1100 });
  await s.mark("semantic", semantic.locator("xpath=ancestor::li[1]"), { hold: 1800 });
  const mapping = page.getByTestId("mapping-table");
  if (await mapping.count()) {
    await s.scrollTo(mapping, { offset: 200, ms: 1100 });
    await s.mark("mapping", mapping, { hold: 2200 });
  }
  await s.scrollTo(page.locator(".outcome"), { offset: 400, ms: 1000 });
  await s.mark("outcome", page.locator(".outcome"), { hold: 1500 });
}
