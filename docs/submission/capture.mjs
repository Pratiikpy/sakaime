// Regenerates every product screenshot used in the deck from the running product (sample mode, recorded replies).
//   node docs/submission/capture.mjs            uses http://127.0.0.1:$PORT (default 8795), starting the service if nothing answers
// The service is started with SAMPLE_MODE=true so every frame is the committed recorded run; the banner at the top of each
// screen says so and is left in the picture on purpose. Run `npm run ui:build` first if ui/dist is missing or out of date.
import { spawn } from "node:child_process";
import { mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium } from "@playwright/test";
import { ROOT, SUB } from "./lib/data.mjs";

const PORT = process.env.PORT ?? "8795";
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = resolve(SUB, "images");
mkdirSync(OUT, { recursive: true });
const CASE = "eyeart-k200667";
const SCALE = Number(process.env.SCALE ?? 1.5);

async function healthy() {
  try {
    const r = await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(2500) });
    return r.ok;
  } catch {
    return false;
  }
}

let child = null;
async function ensureService() {
  if (await healthy()) return;
  if (!existsSync(resolve(ROOT, "ui", "dist", "index.html"))) throw new Error("ui/dist is missing: run `npm run ui:build` first");
  child = spawn(process.platform === "win32" ? "npx.cmd" : "npx", ["tsx", "scripts/serve.ts"], {
    cwd: ROOT,
    env: { ...process.env, SAMPLE_MODE: "true", PORT },
    stdio: "ignore",
    shell: process.platform === "win32",
  });
  for (let i = 0; i < 90; i++) {
    if (await healthy()) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("the service did not become healthy");
}

const api = async (path) => (await fetch(`${BASE}${path}`)).json();

async function main() {
  await ensureService();
  const detail = await api(`/api/cases/${CASE}`);
  const finding = (claimId) => {
    const f = detail.findings.find((x) => x.claimId === claimId);
    if (!f) throw new Error(`no finding for ${claimId}`);
    return f.id;
  };
  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: SCALE, colorScheme: "light", extraHTTPHeaders: { "x-reviewer": "deck-capture" } });
  const page = await ctx.newPage();
  const problems = [];
  page.on("console", (m) => m.type() === "error" && problems.push(`console: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  page.on("requestfailed", (r) => problems.push(`requestfailed: ${r.url()}`));

  const ready = async () => {
    await page.waitForSelector("#page-title", { timeout: 20000 });
    await page.waitForTimeout(900);
  };
  const go = async (path) => {
    await page.goto(`${BASE}${path}`);
    await ready();
  };
  const snap = async (name, { y = 0, full = false, height } = {}) => {
    await page.evaluate((yy) => window.scrollTo(0, yy), y);
    await page.waitForTimeout(250);
    if (full) await page.screenshot({ path: resolve(OUT, `${name}.png`), fullPage: true });
    else await page.screenshot({ path: resolve(OUT, `${name}.png`), ...(height ? { clip: { x: 0, y: 0, width: 1440, height } } : {}) });
    console.log("captured", name);
  };

  // Landing and the review desk
  await go("/");
  await snap("landing");
  await go("/cases");
  await snap("desk");

  // Case overview, the evidence matrix with its SQL open
  await go(`/cases/${CASE}`);
  await snap("overview");
  await go(`/cases/${CASE}/matrix`);
  await page.getByText("Show the SQL that produced this result").click();
  await page.waitForTimeout(400);
  await snap("matrix-top");
  await snap("matrix", { y: await page.evaluate(() => Math.max(0, document.querySelector('[data-testid="matrix-table"]').getBoundingClientRect().top + window.scrollY - 150)) });

  // Claim X-ray: a version mismatch (CLM-EA-04) and the one supported claim (CLM-EA-01)
  await go(`/cases/${CASE}/claims/${finding("CLM-EA-04")}`);
  await snap("xray-version");
  await snap("xray-version-2", { y: 760 });
  await go(`/cases/${CASE}/claims/${finding("CLM-EA-01")}`);
  const showEvidence = page.getByText(/Show the exact evidence/).first();
  if (await showEvidence.count()) await showEvidence.click();
  await page.waitForTimeout(400);
  await snap("xray-supported");

  // Applicability lab: change the software version and read the recomputed answer
  await go(`/cases/${CASE}/lab`);
  await snap("lab-before");
  await page.locator("#lab-versions").fill("3.0");
  await page.waitForSelector('[data-testid="lab-result"]', { timeout: 20000 });
  await page.waitForTimeout(700);
  await page.locator('[data-testid="lab-summary"]').scrollIntoViewIfNeeded();
  await snap("lab-after", { y: 380 });

  // Timeline as of an earlier date
  await go(`/cases/${CASE}/timeline`);
  await snap("timeline");

  // Investigation trace
  await go(`/cases/${CASE}/investigation`);
  await page.getByTestId("start-run").click();
  await page.getByTestId("trace-status").filter({ hasText: "Finished" }).waitFor({ timeout: 60000 });
  await page.waitForTimeout(500);
  await snap("investigation");
  await snap("investigation-2", { y: 700 });

  // Resilience drills: run all seven, then the source-off drill on the study source
  await go(`/cases/${CASE}/drills`);
  await page.getByTestId("run-all").click();
  await page.locator('[data-testid="drill-summary"] tbody tr').nth(6).waitFor({ timeout: 90000 });
  await page.waitForTimeout(500);
  await snap("drills-summary", { y: 0 });
  await page.locator('[data-run="source_off"]').click();
  await page.waitForSelector('[data-testid="drill-result"][data-drill="source_off"]', { timeout: 60000 });
  await page.waitForTimeout(600);
  await page.getByTestId("drill-result").scrollIntoViewIfNeeded();
  await snap("drill-source-off", { y: await page.evaluate(() => Math.max(0, document.querySelector('[data-testid="drill-result"]').getBoundingClientRect().top + window.scrollY - 140)) });

  // Dossier: export, verify, then change one character
  await go(`/cases/${CASE}/dossier`);
  await page.getByTestId("export-dossier").click();
  await page.getByTestId("dossier-summary").waitFor({ timeout: 60000 });
  await page.getByTestId("verify-dossier").click();
  await page.getByTestId("verify-line").first().waitFor({ timeout: 60000 });
  await snap("dossier-verified");
  await page.getByTestId("tamper").click();
  await page.getByTestId("tamper-out").waitFor({ timeout: 60000 });
  await page.waitForTimeout(500);
  await snap("dossier-tamper", { y: await page.evaluate(() => Math.max(0, document.querySelector('[data-testid="tamper-out"]').getBoundingClientRect().top + window.scrollY - 180)) });

  // Sources: the allowed example, then the cloud-metadata address that stage one refuses
  await go("/sources");
  await snap("sources");
  await page.locator('[data-example="allowed"]').click();
  await page.getByRole("button", { name: "Onboard this source" }).click();
  await page.locator("[data-outcome]").waitFor({ timeout: 30000 });
  await page.waitForTimeout(800);
  await page.getByTestId("onboarding-result").scrollIntoViewIfNeeded();
  await snap("sources-onboard", { y: await page.evaluate(() => Math.max(0, document.querySelector('[data-testid="onboarding-result"]').getBoundingClientRect().top + window.scrollY - 140)) });
  await go("/sources");
  await page.locator('[data-example="metadata"]').click();
  await page.getByRole("button", { name: "Onboard this source" }).click();
  await page.locator('[data-outcome="declined"]').waitFor({ timeout: 30000 });
  await page.waitForTimeout(600);
  await snap("sources-refused", { y: await page.evaluate(() => Math.max(0, document.querySelector('[data-testid="onboarding-result"]').getBoundingClientRect().top + window.scrollY - 140)) });

  // Guard: a document that gives orders is held back
  await go("/guard");
  await page.locator('[data-example="injection"]').click();
  await page.getByRole("button", { name: "Check the text" }).click();
  await page.getByTestId("guard-result").waitFor({ timeout: 20000 });
  await page.waitForTimeout(500);
  await snap("guard");

  // About and limits, and the dark theme of one screen
  await go("/about");
  await snap("about");
  await page.emulateMedia({ colorScheme: "dark" });
  await go(`/cases/${CASE}/claims/${finding("CLM-EA-04")}`);
  await snap("xray-dark");

  await browser.close();
  if (child) child.kill();
  if (problems.length) {
    console.log(`\n${problems.length} browser problems seen while capturing:`);
    for (const p of problems) console.log("  ", p);
  } else console.log("\nno console errors, page errors or failed requests while capturing");
}

main().catch((e) => {
  console.error(e);
  if (child) child.kill();
  process.exit(1);
});
