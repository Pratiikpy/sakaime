// Scene "Identity": the Transpara case, where a study of version 1.7.0 is linked against the regulator's 1.7.2 and left ambiguous.
export async function run(s) {
  const { page } = s;
  await s.goto("/cases/transpara-k221347/claims", { settle: 1200 });
  await s.mark("start", null, { hold: 900 });
  const links = page.getByTestId("links");
  await s.scrollTo(links, { offset: 130, ms: 1300 });
  await s.mark("links", links, { hold: 1700 });
  // the link whose flags say the two versions differ
  const target = page.locator("li.link-item", { hasText: "version-differs" }).first();
  await s.scrollTo(target, { offset: 230, ms: 1200 });
  await s.mark("link", target, { hold: 1500 });
  const flag = target.locator(".flag-list li", { hasText: "version-differs" }).first();
  await s.mark("flag", flag, { hold: 1400 });
  const weights = target.getByText("Show how the match weight adds up");
  if (await weights.count()) {
    await s.click(weights, { after: 700 });
    await s.scrollTo(target, { offset: 150, ms: 800 });
    await s.mark("weights", target, { hold: 2600 });
  }
}
