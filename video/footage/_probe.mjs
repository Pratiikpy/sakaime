import { chromium } from "playwright-core";
const b = await chromium.launch({ channel: "chrome", headless: true });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, extraHTTPHeaders: { "x-reviewer": "video-probe" } });
const p = await ctx.newPage();
const base = "http://127.0.0.1:8796";
for (const path of process.argv.slice(2)) {
  await p.goto(base + path, { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  const info = await p.evaluate(() => ({
    h: [...document.querySelectorAll("h1,h2,h3")].map((e) => e.tagName + ":" + e.textContent.trim().slice(0, 60)),
    btn: [...document.querySelectorAll("button,a.btn,[role=tab],select")].map((e) => (e.tagName + ":" + (e.textContent.trim() || e.getAttribute("aria-label") || "")).slice(0, 60)),
    ids: [...document.querySelectorAll("[data-testid]")].map((e) => e.getAttribute("data-testid")),
    height: document.documentElement.scrollHeight,
  }));
  console.log("==", path, info.height);
  console.log(info.h.join(" | "));
  console.log("BTN", info.btn.join(" | "));
  console.log("IDS", info.ids.join(","));
}
await b.close();
