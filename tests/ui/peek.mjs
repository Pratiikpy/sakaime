// Developer tool: node tests/ui/peek.mjs <path> <out.png> [theme] [width] [height] [scrollY] [interactions...]
import { chromium } from "@playwright/test";
const [path, out, theme = "light", w = "1440", h = "1000", y = "0"] = process.argv.slice(2);
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({ viewport: { width: +w, height: +h }, colorScheme: theme });
await page.goto(`http://127.0.0.1:${process.env.PORT ?? 8788}/${path.replace(/^\/+/, "")}`);
await page.waitForSelector("#page-title");
await page.waitForTimeout(700);
if (process.env.CLICK) for (const sel of process.env.CLICK.split("||")) { await page.click(sel); await page.waitForTimeout(500); }
await page.evaluate((yy) => window.scrollTo(0, yy), +y);
await page.waitForTimeout(200);
await page.screenshot({ path: out });
await browser.close();
