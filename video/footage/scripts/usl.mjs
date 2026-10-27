// Scene "Semantic layer": the Unified Semantic Layer panel of the Sources screen: its tables, the completeness gate, the rules.
export async function run(s) {
  const { page } = s;
  await s.goto("/sources", { settle: 1200 });
  await s.mark("start", null, { hold: 600 });
  const panel = page.getByTestId("usl-panel");
  await s.scrollTo(page.getByRole("heading", { name: "Unified Semantic Layer" }), { offset: 110, ms: 1400 });
  await s.mark("panel", panel, { hold: 1200 });
  const prov = page.getByTestId("usl-provenance");
  if (await prov.count()) await s.mark("provenance", prov, { hold: 900 });
  const completeness = page.getByTestId("usl-completeness");
  if (await completeness.count()) {
    await s.scrollTo(completeness, { offset: 200, ms: 1000 });
    await s.mark("completeness", completeness, { hold: 1300 });
  }
  const tables = page.getByTestId("usl-tables");
  await s.scrollTo(tables, { offset: 150, ms: 1000 });
  await s.mark("tables", tables, { hold: 1800 });
  const rules = page.getByTestId("usl-rules");
  await s.scrollTo(rules, { offset: 150, ms: 1200 });
  await s.mark("rules", rules, { hold: 1200 });
  const row = rules.locator("tbody tr", { hasText: "study_has_eligibility" }).first();
  await s.scrollTo(row, { offset: 380, ms: 900 });
  await s.mark("rule", row, { hold: 2600 });
}
