import AxeBuilder from "@axe-core/playwright";
import { expect, test as base, type APIRequestContext, type Page, type TestInfo } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const SHOTS = join(here, "screenshots");

/**
 * Every test acts as its own reviewer (the service reads the X-Reviewer header). The page and the API client of one test share the
 * name, and no other test does, so a decision, an export or a guard strike made by one test cannot change what another one sees.
 * The fixture server ignores the header.
 */
export const test = base.extend({
  extraHTTPHeaders: async ({}, use, info) => {
    await use({ "x-reviewer": `ui-test-${info.testId}` });
  },
});

/**
 * True when the suite runs against the real service (SAKAIME_UI_BASE_URL) rather than the fixture server in ui/dev-server.
 * Expectations are derived from the live API response in both cases; this flag is only for the few behaviours that exist in
 * one server alone (the fixture's /api/dev routes), and each use says so.
 */
export const REAL = Boolean(process.env["SAKAIME_UI_BASE_URL"]);

export interface Finding {
  id: string;
  claimId: string;
  label: string;
  mismatches: { dimension: string; relation: string; claimed?: string; established?: string }[];
  requiredEvidence: { dimension: string; request: string }[];
  degraded: { sourceType: string; reason: string }[];
  mechanicalCoverage: { dimension: string; relation: string }[];
}
export interface CaseSummary {
  id: string;
  title: string;
  headlineLabel?: string;
  openQuestions: number;
  staleFindings: number;
  reviewerState: string;
}
// The detail is read as plain JSON in tests; only the parts the assertions use are typed.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Detail = {
  summary: CaseSummary;
  claim: { id: string; use: any };
  claimText: string;
  findings: Finding[];
  dimensions: Record<string, { dimension: string; relation: string; claimed?: string; established?: string; reason: string; anchorIds: string[] }[]>;
  anchors: { id: string; text: string; page?: number; sourceLabel: string; ruleIds: string[] }[];
  links: { id: string; type: string; state: string; waterfall?: unknown[] }[];
  matrix?: { queryId: string; servedFrom: string; perSourceRowCounts: Record<string, number>; columns: { name: string; sourceId: string; sourceLabel: string }[]; rows: unknown[] };
  timeline: { at: string; kind: string; summary: string }[];
  missingEvidence: { findingId: string; dimension: string; request: string; draft: string }[];
  sources: { source: { id: string; health: string } }[];
  mode: Record<string, unknown>;
};

export const LABEL_WORDS: Record<string, string> = {
  SUPPORTED_FOR_SCOPE: "Supported for this use",
  SUPPORTED_ONLY_FOR_NARROWER_SCOPE: "Supported only for a narrower use",
  CONTRADICTED_BY_SPECIFIED_EVIDENCE: "Contradicted by specified evidence",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
  REQUIRES_DOMAIN_REVIEW: "Needs domain review",
};

export async function listCases(request: APIRequestContext): Promise<CaseSummary[]> {
  const res = await request.get("/api/cases");
  expect(res.status(), "GET /api/cases").toBe(200);
  return (await res.json()) as CaseSummary[];
}
export async function getCase(request: APIRequestContext, id: string): Promise<Detail> {
  const res = await request.get(`/api/cases/${encodeURIComponent(id)}`);
  expect(res.status(), `GET /api/cases/${id}`).toBe(200);
  return (await res.json()) as Detail;
}

/** The finding that answers the reviewer's own question: the one for the claim the case is about, else the first. */
export const headlineOf = (d: Detail): Finding => d.findings.find((f) => f.claimId === d.claim.id) ?? d.findings[0]!;

/**
 * The case most screens are driven against: the first whose headline answer is not "supported" (it shows the idea better
 * than a clean one), else the first case. On the fixture server that is ea-02; on the real service it is the EyeArt case.
 */
export async function primaryCase(request: APIRequestContext): Promise<Detail> {
  const cases = await listCases(request);
  expect(cases.length, "the service lists at least one case").toBeGreaterThan(0);
  const pick = cases.find((c) => c.headlineLabel && c.headlineLabel !== "SUPPORTED_FOR_SCOPE") ?? cases[0]!;
  return getCase(request, pick.id);
}

/**
 * A case no other test records a decision on or re-investigates, for the dossier: an export is refused when a decision points at a
 * finding that a later investigation replaced. The last case in the list, unless it is the primary one.
 */
export async function quietCase(request: APIRequestContext): Promise<Detail> {
  const cases = await listCases(request);
  const primary = await primaryCase(request);
  const pick = [...cases].reverse().find((c) => c.id !== primary.summary.id) ?? cases[0]!;
  return getCase(request, pick.id);
}

/** Every screen, with a stable name for screenshots, for one case. */
export function screensFor(id: string): { name: string; path: string }[] {
  const c = encodeURIComponent(id);
  return [
    { name: "landing", path: "/" },
    { name: "sources", path: "/sources" },
    { name: "review-desk", path: "/cases" },
    { name: "case", path: `/cases/${c}` },
    { name: "matrix", path: `/cases/${c}/matrix` },
    { name: "xray", path: `/cases/${c}/claims` },
    { name: "lab", path: `/cases/${c}/lab` },
    { name: "timeline", path: `/cases/${c}/timeline` },
    { name: "investigation", path: `/cases/${c}/investigation` },
    { name: "drills", path: `/cases/${c}/drills` },
    { name: "dossier", path: `/cases/${c}/dossier` },
    { name: "guard", path: "/guard" },
    { name: "about", path: "/about" },
  ];
}

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
