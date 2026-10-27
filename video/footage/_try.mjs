import { session, CASE } from "./lib.mjs";
const s = await session("_try");
await s.goto("/cases/" + CASE);
await s.sleep(800);
await s.moveTo(s.page.getByRole("link", { name: "Evidence matrix" }));
await s.click(s.page.getByRole("link", { name: "Evidence matrix" }));
await s.sleep(1500);
await s.mark("title", s.page.locator("h1"), { hold: 400 });
await s.finish();
