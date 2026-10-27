// Scene "Zetaris federation": the case, then the Evidence Matrix with its source badges and the statement behind it.
import { CASE } from "../lib.mjs";

export async function run(s) {
  const { page } = s;
  await s.goto(`/cases/${CASE}`, { settle: 1200 });
  await s.mark("start", null, { hold: 900 });
  await s.click(page.getByRole("link", { name: "Evidence matrix" }), { after: 900 });
  await page.getByTestId("matrix-table").waitFor();
  await s.mark("meta", page.getByTestId("matrix-meta"), { hold: 1500 });
  await s.scrollTo(page.getByRole("heading", { name: "Result", exact: true }), { offset: 100, ms: 1000 });
  await s.mark("table", page.getByTestId("matrix-table"), { hold: 1500 });
  const heads = page.getByTestId("matrix-table").locator("thead tr").first();
  await s.mark("badges", heads, { hold: 800 });
  // sideways through the columns
  const wrap = page.locator(".table-wrap-scroll").first();
  if (await wrap.count()) {
    await wrap.evaluate((el) => new Promise((res) => {
      const to = el.scrollWidth - el.clientWidth;
      const t0 = performance.now();
      const dur = 2600;
      const step = (t) => {
        const u = Math.min(1, (t - t0) / dur);
        el.scrollLeft = to * (u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2);
        if (u < 1) requestAnimationFrame(step);
        else res();
      };
      requestAnimationFrame(step);
    }));
  }
  await s.mark("columns", heads, { hold: 700 });
  const sql = page.getByTestId("sql-text");
  if (await sql.count()) {
    await s.scrollTo(sql, { offset: 160, ms: 900 });
    await s.mark("sql", sql, { hold: 1800 });
  }
  await s.scrollTop(1100);
  await s.sleep(300);
  await s.mark("banner", page.getByTestId("run-mode"), { hold: 1400 });
  await s.mark("served", page.getByTestId("matrix-meta"), { hold: 400 });
}
