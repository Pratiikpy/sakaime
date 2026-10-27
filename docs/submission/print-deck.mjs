// Prints sakaime-deck.html to sakaime-deck.pdf with Google Chrome and renders every slide to renders/NN.png for review.
//   node docs/submission/print-deck.mjs [--no-png]
import { mkdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "@playwright/test";
import { SUB } from "./lib/data.mjs";

const png = !process.argv.includes("--no-png");
const html = resolve(SUB, "sakaime-deck.html");
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
const problems = [];
page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));
await page.goto(pathToFileURL(html).href);
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(800);
const count = await page.locator(".slide").count();
if (png) {
  mkdirSync(resolve(SUB, "renders"), { recursive: true });
  for (let i = 0; i < count; i++) {
    await page.locator(".slide").nth(i).screenshot({ path: resolve(SUB, "renders", `${String(i + 1).padStart(2, "0")}.png`) });
  }
}
// Overflow check: any slide whose content is taller or wider than the slide, or any text clipped by its box.
const overflow = await page.evaluate(() =>
  [...document.querySelectorAll(".slide")].flatMap((s) => {
    const out = [];
    const body = s.querySelector(".body");
    if (body && body.scrollHeight > body.clientHeight + 2) out.push(`body taller than its frame by ${body.scrollHeight - body.clientHeight}px`);
    if (body && body.scrollWidth > body.clientWidth + 2) out.push(`body wider than its frame by ${body.scrollWidth - body.clientWidth}px`);
    for (const el of s.querySelectorAll(".body *")) {
      if (el.tagName === "IMG" || el.closest("svg")) continue;
      const r = el.getBoundingClientRect();
      const sr = s.getBoundingClientRect();
      if (r.width && (r.right > sr.right - 100 || r.bottom > sr.bottom - 60)) { out.push(`"${(el.textContent || el.tagName).trim().slice(0, 40)}" reaches the slide edge`); break; }
    }
    return out.length ? [`slide ${s.dataset.n}: ${out.join("; ")}`] : [];
  }),
);
await page.emulateMedia({ media: "print" });
const pdf = resolve(SUB, "sakaime-deck.pdf");
await page.pdf({ path: pdf, width: "1920px", height: "1080px", printBackground: true, preferCSSPageSize: true });
await browser.close();
console.log(`slides: ${count}; pdf: ${(statSync(pdf).size / 1048576).toFixed(2)} MB`);
if (overflow.length) { console.log("LAYOUT WARNINGS"); overflow.forEach((o) => console.log("  " + o)); }
if (problems.length) { console.log("BROWSER PROBLEMS"); problems.forEach((p) => console.log("  " + p)); }
