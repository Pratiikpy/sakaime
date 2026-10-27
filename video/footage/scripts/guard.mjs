// Scene "Scout guard": an instruction inside a vendor document is set aside, not obeyed.
export async function run(s) {
  const { page } = s;
  await s.goto("/guard", { settle: 1100 });
  await s.mark("start", null, { hold: 700 });
  await s.click(page.getByRole("button", { name: "A document giving orders" }));
  await s.mark("text", page.locator("textarea").first(), { hold: 1500 });
  await s.click(page.getByRole("button", { name: "Check the text" }), { after: 900 });
  const result = page.getByTestId("guard-result");
  await result.waitFor({ timeout: 20000 });
  await s.scrollTo(result, { offset: 200, ms: 900 });
  await s.mark("result", result, { hold: 2200 });
  const findings = page.getByTestId("guard-findings");
  if (await findings.count()) await s.mark("findings", findings, { hold: 1400 });
}
