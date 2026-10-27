// Scripted recording of the running product: one clip per scene, real browser, real service, deliberate pacing.
//
// Playwright records at the viewport size, so the page is zoomed with CSS to fill the 1920x1080 frame at native resolution
// (text stays sharp; no upscaling). A cursor is drawn into the page because the video does not capture the system pointer.
// Every `mark()` stores a named moment and the on-screen box of an element, so the composition can place a callout or a camera
// move exactly where the interface was at that time, and `sync` ties the clip's pace to the narration.
import { chromium } from "playwright-core";
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const CLIPS = join(here, "clips");
const RAW = join(here, "raw");

export let BASE = process.env.SAKAIME_BASE ?? "http://127.0.0.1:8796";
/** Points every session at another service address (record-all starts its own service for each clip). */
export function setBase(url) {
  BASE = url;
}
export const ZOOM = Number(process.env.FOOTAGE_ZOOM ?? 1.3);
export const CASE = "eyeart-k200667";

const cursorScript = (Z) => `
(() => {
  const mount = () => {
    if (document.getElementById("__cur")) return;
    const cur = document.createElement("div");
    cur.id = "__cur";
    cur.style.cssText = "zoom:" + (1 / ${Z}) + ";position:fixed;left:0;top:0;width:28px;height:28px;z-index:2147483647;pointer-events:none;transform:translate(-100px,-100px);transition:none;will-change:transform;";
    cur.innerHTML = '<svg width="28" height="28" viewBox="0 0 28 28" xmlns="http://www.w3.org/2000/svg"><path d="M5 3 L5 22 L10.2 17.6 L13.6 25 L17 23.5 L13.7 16.2 L20.5 16 Z" fill="#0e1116" stroke="#ffffff" stroke-width="2" stroke-linejoin="round"/></svg>';
    const ring = document.createElement("div");
    ring.id = "__ring";
    ring.style.cssText = "zoom:" + (1 / ${Z}) + ";position:fixed;left:0;top:0;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #0a6b3a;z-index:2147483646;pointer-events:none;opacity:0;transform:translate(-100px,-100px) scale(.4);";
    document.documentElement.appendChild(ring);
    document.documentElement.appendChild(cur);
    window.addEventListener("mousemove", (e) => { cur.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px)"; }, true);
    window.addEventListener("mousedown", (e) => {
      ring.style.transition = "none";
      ring.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px) scale(.4)";
      ring.style.opacity = "0.95";
      requestAnimationFrame(() => requestAnimationFrame(() => {
        ring.style.transition = "transform .45s cubic-bezier(.2,.7,.2,1), opacity .45s ease-out";
        ring.style.transform = "translate(" + e.clientX + "px," + e.clientY + "px) scale(1.5)";
        ring.style.opacity = "0";
      }));
    }, true);
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount); else mount();
})();
`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Opens a recording session. `name` becomes clips/<name>.mp4 and clips/<name>.cues.json. */
export async function session(name, { zoom = ZOOM, reviewer = `video-${name}` } = {}) {
  mkdirSync(CLIPS, { recursive: true });
  const dir = join(RAW, name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", headless: true });
  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    recordVideo: { dir, size: { width: 1920, height: 1080 } },
    extraHTTPHeaders: { "x-reviewer": reviewer },
    colorScheme: "light",
    reducedMotion: "no-preference",
  });
  await context.addInitScript(cursorScript(zoom));
  await context.addInitScript(`try { localStorage.setItem("sakaime-theme", "light"); } catch (e) {}`);
  const page = await context.newPage();
  const t0 = Date.now();
  const cues = [];
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console: ${m.text()}`);
  });
  page.on("requestfailed", (r) => errors.push(`requestfailed: ${r.url()}`));

  const now = () => (Date.now() - t0) / 1000;
  let cx = 960;
  let cy = 540;

  const s = {
    page,
    now,
    sleep,
    errors,
    async goto(path, { settle = 900 } = {}) {
      await page.goto(BASE + path, { waitUntil: "networkidle" });
      await page.addStyleTag({ content: `html { zoom: ${zoom}; } html { scroll-padding-top: 0; }` });
      await sleep(settle);
    },
    /** Moves the drawn cursor with a smooth eased path to the centre of a locator (or an {x,y}). */
    async moveTo(target, { steps = 34, dwell = 160 } = {}) {
      const box = target.x === undefined ? await target.boundingBox() : null;
      const tx = box ? box.x + Math.min(box.width * 0.5, 120) : target.x;
      const ty = box ? box.y + box.height / 2 : target.y;
      const sx = cx;
      const sy = cy;
      for (let i = 1; i <= steps; i++) {
        const u = i / steps;
        const e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2; // easeInOutQuad
        await page.mouse.move(sx + (tx - sx) * e, sy + (ty - sy) * e);
        await sleep(14);
      }
      cx = tx;
      cy = ty;
      await sleep(dwell);
    },
    async click(locator, opts = {}) {
      await locator.scrollIntoViewIfNeeded();
      await s.moveTo(locator, opts);
      await locator.click({ delay: 60 });
      await sleep(opts.after ?? 350);
    },
    /** Types at a human pace. */
    async type(locator, text, { perChar = 38 } = {}) {
      await s.click(locator, { after: 120 });
      for (const ch of text) {
        await page.keyboard.type(ch);
        await sleep(perChar + Math.round(Math.random() * 14));
      }
      await sleep(250);
    },
    /** Smooth scroll so the element's top sits `offset` px below the viewport top (in zoomed px). */
    async scrollTo(locator, { offset = 150, ms = 900 } = {}) {
      await locator.scrollIntoViewIfNeeded();
      const y = await locator.evaluate((el, o) => {
        const r = el.getBoundingClientRect();
        return window.scrollY + r.top - o;
      }, offset);
      await page.evaluate(([target, dur]) => new Promise((res) => {
        const start = window.scrollY;
        const t0 = performance.now();
        const step = (t) => {
          const u = Math.min(1, (t - t0) / dur);
          const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
          window.scrollTo(0, start + (target - start) * e);
          if (u < 1) requestAnimationFrame(step); else res();
        };
        requestAnimationFrame(step);
      }), [Math.max(0, y), ms]);
      await sleep(200);
    },
    async scrollTop(ms = 700) {
      await page.evaluate((dur) => new Promise((res) => {
        const start = window.scrollY;
        const t0 = performance.now();
        const step = (t) => {
          const u = Math.min(1, (t - t0) / dur);
          window.scrollTo(0, start * (1 - (u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2)));
          if (u < 1) requestAnimationFrame(step); else res();
        };
        requestAnimationFrame(step);
      }), ms);
    },
    /** Records a named moment and the box of `locator` (viewport px of the 1920x1080 frame). */
    async mark(markName, locator, { hold = 0, pad = 0 } = {}) {
      let box = null;
      if (locator) {
        const b = await locator.first().boundingBox();
        if (b) box = { x: Math.round(b.x - pad), y: Math.round(b.y - pad), w: Math.round(b.width + pad * 2), h: Math.round(b.height + pad * 2) };
      }
      cues.push({ name: markName, t: Math.round(now() * 1000) / 1000, hold: hold / 1000, box });
      if (process.env.FOOTAGE_SHOTS) await page.screenshot({ path: join(process.env.FOOTAGE_SHOTS, `${name}-${markName}.png`) });
      if (hold) await sleep(hold);
    },
    async finish() {
      const duration = now();
      await context.close();
      await browser.close();
      const file = readdirSync(dir).find((f) => f.endsWith(".webm"));
      const raw = join(dir, file);
      // Constant 30 fps H.264 with short GOPs so Remotion can seek to any frame exactly.
      execFileSync("ffmpeg", ["-v", "error", "-y", "-i", raw, "-r", "30", "-vsync", "cfr", "-c:v", "libx264", "-crf", "12", "-preset", "slow", "-g", "15", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(CLIPS, `${name}.mp4`)]);
      writeFileSync(join(CLIPS, `${name}.cues.json`), JSON.stringify({ clip: name, zoom, duration: Math.round(duration * 1000) / 1000, cues, errors }, null, 1));
      console.log(`${name}: ${duration.toFixed(1)} s, ${cues.length} cues, ${errors.length} browser errors`);
      return { duration, cues, errors };
    },
  };
  return s;
}
