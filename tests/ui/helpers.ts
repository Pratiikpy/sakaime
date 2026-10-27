import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SHOTS = join(here, "screenshots");

export const CASE = "ea-02";
/** Every screen, with a stable name for screenshots. */
export const SCREENS: { name: string; path: string }[] = [
  { name: "landing", path: "/" },
  { name: "sources", path: "/sources" },
  { name: "review-desk", path: "/cases" },
  { name: "case", path: `/cases/${CASE}` },
  { name: "matrix", path: `/cases/${CASE}/matrix` },
  { name: "xray", path: `/cases/${CASE}/claims` },
  { name: "lab", path: `/cases/${CASE}/lab` },
  { name: "timeline", path: `/cases/${CASE}/timeline` },
  { name: "investigation", path: `/cases/${CASE}/investigation` },
  { name: "drills", path: `/cases/${CASE}/drills` },
  { name: "dossier", path: `/cases/${CASE}/dossier` },
  { name: "guard", path: "/guard" },
  { name: "about", path: "/about" },
];

export interface Watch {
  errors: string[];
  /** Expected noise for one test, for example a deliberate 422. */
  allow(pattern: RegExp): void;
  assertClean(): void;
}

/** Console errors, uncaught exceptions and failed requests are part of every page's pass criteria. */
export function watch(page: Page): Watch {
  const errors: string[] = [];
  const allowed: RegExp[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") errors.push(`console.error: ${m.text()}`);
  });
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => {
    // A request we cancel ourselves (navigation away, aborted stale recompute) is not a failure.
    if (r.failure()?.errorText === "net::ERR_ABORTED") return;
    errors.push(`requestfailed: ${r.method()} ${r.url()} ${r.failure()?.errorText}`);
  });
  return {
    errors,
    allow: (re) => void allowed.push(re),
    assertClean() {
      const bad = errors.filter((e) => !allowed.some((re) => re.test(e)));
      expect(bad, `console, page and request errors:\n${bad.join("\n")}`).toEqual([]);
    },
  };
}

export async function setTheme(page: Page, theme: "light" | "dark") {
  await page.emulateMedia({ colorScheme: theme });
}

/** Waits until the screen has real content (not a skeleton) and fonts are in. */
export async function ready(page: Page) {
  await page.waitForSelector("#page-title", { timeout: 20_000 });
  await page.waitForFunction(() => !document.querySelector('.skeleton[aria-busy="true"]'), undefined, { timeout: 20_000 });
  await page.evaluate(() => document.fonts.ready);
}

export async function axe(page: Page) {
  const results = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"]).analyze();
  return results.violations;
}

export function shotPath(parts: string[]): string {
  const file = join(SHOTS, ...parts);
  mkdirSync(dirname(file), { recursive: true });
  return file;
}

export async function shot(page: Page, name: string, theme: string, width: number) {
  await page.screenshot({ path: shotPath([`${name}-${theme}-${width}.png`]), fullPage: true });
}

export function attach(info: TestInfo, name: string, body: string) {
  void info.attach(name, { body, contentType: "text/plain" });
}

export const widths = { desktop: { width: 1440, height: 900 }, mobile: { width: 390, height: 844 } };
