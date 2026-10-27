import { expect, test, type Page } from "@playwright/test";
import { ready, shot, watch } from "./helpers";

/**
 * Real flows, driven the way a reviewer would, with the outcome asserted from what is on the screen and, where the
 * service holds the truth, from the service as well.
 */

const label = (p: Page, text: string) => p.getByText(text, { exact: false }).first();

test.describe("landing and claim X-ray", () => {
  test("the live strip opens the claim X-ray of a real case", async ({ page }) => {
    const w = watch(page);
    await page.goto("/");
    await ready(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A claim can be true and still be wrong for you.");
    const strip = page.getByTestId("live-strip");
    await expect(strip).toContainText("Constructed claim");
    await expect(strip).toContainText("EyeArt");
    await strip.getByRole("link", { name: /Open the claim X-ray/ }).click();
    await expect(page).toHaveURL(/\/cases\/ea-0\d\/claims\/fnd_/);
    await ready(page);
    await expect(page.getByTestId("claim-text")).not.toBeEmpty();
    await expect(page.getByTestId("dimensions").locator("[data-dimension]")).toHaveCount(7);
    w.assertClean();
  });

  test("X-ray: claimed against established, exact anchors, counterexample and separate link types", async ({ page, request }) => {
    const w = watch(page);
    const detail = await (await request.get("/api/cases/ea-02")).json();
    await page.goto("/cases/ea-02/claims");
    await ready(page);
    await shot(page, "flow-xray-top", "light", 1440);

    // The answer comes from the service, unchanged.
    await expect(page.locator(".answer-card")).toHaveAttribute("data-label", detail.findings[0].label);
    await expect(page.locator(".answer-card")).toContainText(detail.findings[0].label); // the token is on screen for the reader

    // Population is PARTIAL for this claim (age 12 claimed, 18 established): both sides are shown.
    const pop = page.locator('[data-dimension="population"]');
    await expect(pop).toHaveAttribute("data-relation", "PARTIAL");
    await expect(pop.locator('[data-side="claimed"]')).toContainText("ages 12 and above");
    await expect(pop.locator('[data-side="established"]')).toContainText("ages 18 and above");

    // Anchors: closed until asked, then the verbatim passage, its page, source and date and the rule.
    await expect(pop.locator(".anchor").first()).toBeHidden();
    await pop.getByText(/Show the exact evidence/).click();
    const first = pop.locator(".anchor").first();
    await expect(first).toBeVisible();
    await expect(first.locator("mark")).not.toBeEmpty();
    await expect(first).toContainText("Retrieved 27 Oct 2026");
    await expect(first).toContainText(/page \d+/);
    await expect(first.locator(".anchor__rules")).toContainText(/R\d+/);
    // The quote on screen is the quote in the service's record.
    const quote = await first.locator("mark").innerText();
    expect(detail.anchors.some((a: { text: string }) => a.text === quote.trim())).toBe(true);
    await shot(page, "flow-xray-anchor", "light", 1440);

    // The smallest mismatch names only what stops the claim.
    const ce = page.getByTestId("counterexample");
    await expect(ce).toContainText("Population");
    await expect(ce.locator("li")).toHaveCount(detail.findings[0].mismatches.length);

    // Link types are shown apart, with state; the ambiguous one has its waterfall.
    const links = page.getByTestId("links");
    for (const t of ["SAME_SUBMISSION", "SAME_MARKETED_VERSION", "SAME_PRODUCT", "STUDY_EVALUATES", "PUBLICATION_REPORTS"]) {
      await expect(links.locator(`[data-link-type="${t}"]`)).toHaveCount(1);
    }
    const amb = links.locator('li[data-link-state="AMBIGUOUS"]');
    await expect(amb).toHaveCount(1);
    await amb.getByText(/how the match weight adds up/).click();
    const wf = amb.getByTestId("waterfall");
    await expect(wf.locator("tbody tr")).toHaveCount(8);
    await expect(wf).toContainText("Total weight used for the decision");
    await expect(links.locator('li[data-link-state="CONFIRMED"]').first()).toContainText("Confirmed");
    await expect(links.locator('li[data-link-state="REJECTED"]').first()).toContainText("Rejected");
    // A shared submission number does not read as the same release.
    await expect(links).toContainText("Sharing a submission number does not mean two records describe the same software release");

    // Finding-type tag, in words.
    await expect(page.locator(".answer-card .type-tag").first()).toBeVisible();
    w.assertClean();
  });

  test("X-ray: an unknown finding id is a designed state, not a blank page", async ({ page }) => {
    const w = watch(page);
    await page.goto("/cases/ea-02/claims/fnd_doesnotexist");
    await ready(page);
    await expect(page.getByText("That finding is not in this case")).toBeVisible();
    w.assertClean();
  });

  test("an unknown case is NOT_FOUND, said differently from an outage", async ({ page }) => {
    const w = watch(page);
    w.allow(/404/);
    await page.goto("/cases/nope");
    await expect(page.locator('[data-failure="NOT_FOUND"]')).toBeVisible();
    await expect(page.locator('[data-failure="NOT_FOUND"]')).not.toContainText("on our side");
    w.assertClean();
  });
});

test.describe("source console", () => {
  test("sources show health in words and icons, schema hash, last success and the Zetaris name", async ({ page, request }) => {
    const w = watch(page);
    const sources = await (await request.get("/api/sources")).json();
    await page.goto("/sources");
    await ready(page);
    const table = page.getByTestId("sources-table");
    await expect(table.locator("tbody tr")).toHaveCount(sources.length);
    // A pinned snapshot reads as out of date, not as answering.
    await expect(table.locator('[data-source="fda-ai-list"] [data-health="STALE"]')).toContainText("Out of date");
    await expect(table.locator('[data-source="silo-hospital"]')).toContainText("hospital");
    await expect(table.locator('[data-source="silo-vendor"]')).toContainText("sk_vendor");
    await expect(table.locator('[data-source="openfda-510k"] .cell-hash code')).toBeVisible();
    await page.getByText("What the health words mean").click();
    await expect(page.locator(".legend").first()).toContainText("never read as");
    await shot(page, "flow-sources", "light", 1440);
    w.assertClean();
  });

  test("add a source: an allowed address streams eight stages, maps fields and holds what a rule cannot place", async ({ page }) => {
    const w = watch(page);
    await page.goto("/sources");
    await ready(page);
    await page.locator('[data-example="allowed"]').click();
    await expect(page.locator("#src-url")).toHaveValue(/api\.fda\.gov/);
    await page.getByRole("button", { name: "Onboard this source" }).click();
    const result = page.getByTestId("onboarding-result");
    await expect(result).toBeVisible();
    await expect(result.locator("li.stage")).toHaveCount(8);
    await expect(result.locator('[data-outcome]')).toBeVisible({ timeout: 10_000 });
    await expect(result.locator('[data-stage="authorization"]')).toHaveAttribute("data-status", "passed");
    await expect(result.locator('[data-stage="bounded_probe"]')).toContainText("recording");
    const mapping = page.getByTestId("mapping-table");
    await expect(mapping).toBeVisible();
    await expect(mapping.locator('[data-check="renamed"]').first()).toBeVisible();
    await expect(mapping.locator('[data-check="needs_review"]').first()).toBeVisible();
    await expect(result.locator("[data-outcome]")).toHaveAttribute("data-outcome", "held_for_review");
    await shot(page, "flow-onboard-held", "light", 1440);
    w.assertClean();
  });

  test("add a source: SSRF attempts are refused at stage one with the reason, and nothing else runs", async ({ page }) => {
    const w = watch(page);
    await page.goto("/sources");
    await ready(page);
    for (const [ex, reason] of [
      ["metadata", /IP-literal hosts are refused/],
      ["unlisted", /not on the source allowlist/],
    ] as const) {
      await page.locator(`[data-example="${ex}"]`).click();
      await page.getByRole("button", { name: "Onboard this source" }).click();
      const out = page.locator('[data-outcome="declined"]');
      await expect(out).toBeVisible({ timeout: 10_000 });
      await expect(out).toContainText(reason);
      await expect(page.locator('[data-stage="authorization"]')).toHaveAttribute("data-status", "failed");
      await expect(page.locator('[data-stage="bounded_probe"]')).toHaveAttribute("data-status", "skipped");
    }
    await shot(page, "flow-onboard-refused", "light", 1440);
    w.assertClean();
  });

  test("add a source: junk input is blocked in the form, and the same request twice never registers twice", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/sources");
    await ready(page);
    const submit = page.getByRole("button", { name: "Onboard this source" });
    await expect(submit).toBeDisabled();
    await page.locator("#src-desc").fill("ab");
    await page.locator("#src-url").fill("https://api.fda.gov/");
    await expect(submit).toBeDisabled();
    // The service enforces it too.
    const bad = await request.post("/api/sources/propose", { data: { description: "x", url: "not a url" } });
    expect(bad.status()).toBe(400);
    const body = await bad.json();
    expect(body.error.failure).toBe("INVALID");
    const url = "https://api.fda.gov/device/510k.json?search=k_number:DEN170073";
    const first = await (await request.post("/api/sources/propose", { data: { description: "FDA clearance record for a triage device", url } })).json();
    const second = await (await request.post("/api/sources/propose", { data: { description: "FDA clearance record for a triage device", url } })).json();
    expect(second).toEqual(first);
    const sources = await (await request.get("/api/sources")).json();
    expect(sources.filter((s: { source: { id: string } }) => s.source.id === first.sourceId).length).toBe(first.sourceId ? 1 : 0);
    w.assertClean();
  });

  test("reduced motion shows all stages at once", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/sources");
    await ready(page);
    await page.locator('[data-example="metadata"]').click();
    await page.getByRole("button", { name: "Onboard this source" }).click();
    await expect(page.locator('[data-outcome="declined"]')).toBeVisible({ timeout: 2_000 });
  });
});

test.describe("evidence matrix", () => {
  test("columns carry source badges, the SQL is one click away, counts and query id are shown", async ({ page, request }) => {
    const w = watch(page);
    const m = (await (await request.get("/api/cases/ea-02")).json()).matrix;
    await page.goto("/cases/ea-02/matrix");
    await ready(page);
    await expect(page.getByTestId("matrix-meta")).toContainText("Local fallback");
    await expect(page.getByTestId("query-id")).toHaveText(m.queryId);
    const counts = page.getByTestId("source-counts");
    for (const [id, n] of Object.entries(m.perSourceRowCounts)) {
      const label = m.columns.find((c: { sourceId: string }) => c.sourceId === id)?.sourceLabel;
      await expect(counts).toContainText(label);
      await expect(counts).toContainText(String(n));
    }
    const table = page.getByTestId("matrix-table");
    await expect(table.locator("tbody tr")).toHaveCount(m.rows.length);
    await expect(table.locator("thead tr").first().locator("th")).toHaveCount(6); // six source groups
    await expect(page.getByTestId("sql-text")).toBeHidden();
    await page.getByText("Show the SQL that produced this result").click();
    await expect(page.getByTestId("sql-text")).toContainText("SELECT");
    await expect(page.getByTestId("sql-text")).toContainText("hospital_cases");
    await shot(page, "flow-matrix", "light", 1440);
    w.assertClean();
  });
});

test.describe("applicability lab", () => {
  test("changing the use recomputes with no model call and says what moved", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/cases/ea-02/lab");
    await ready(page);
    await expect(page.getByTestId("lab-baseline")).toContainText("Needs domain review");
    // The claim asks from age 12; the study enrolled from 22. Asking from 22, the evidence covers the use.
    const calls: string[] = [];
    page.on("request", (r) => r.url().includes("/recompute") && calls.push(r.postData() ?? ""));
    await page.locator("#lab-age-min").fill("22");
    const result = page.getByTestId("lab-result");
    await expect(result).toBeVisible();
    await expect(page.getByTestId("lab-summary")).toContainText(/changed from .Needs domain review. to .Supported for this use./);
    await expect(page.getByTestId("no-model")).toHaveText(/No model was called/);
    await expect(page.getByTestId("lab-meta")).toContainText(/Recomputed in/);
    await expect(page.getByTestId("changed-dims")).toContainText("Population");
    // Only the changed field is sent.
    const sent = JSON.parse(calls[calls.length - 1]!);
    expect(Object.keys(sent.patch)).toEqual(["population"]);
    // The answer on screen is the service's answer for that patch.
    const api = await (await request.post("/api/cases/ea-02/recompute", { data: sent })).json();
    expect(api.modelCalled).toBe(false);
    await expect(result.locator(".label-badge").nth(1)).toHaveAttribute("data-label", api.after.label);
    await shot(page, "flow-lab-age", "light", 1440);

    // A different use: an emergency department. It is outside what the evidence covers.
    await page.getByRole("checkbox", { name: "primary care" }).uncheck();
    await page.getByRole("checkbox", { name: "emergency department" }).check();
    await expect(page.getByTestId("lab-summary")).toBeVisible();
    await expect.poll(async () => (await page.getByTestId("lab-result").locator(".label-badge").nth(1).getAttribute("data-label")) !== "SUPPORTED_FOR_SCOPE").toBe(true);
    await expect(page.getByTestId("lab-missing")).toBeVisible();
    await shot(page, "flow-lab-setting", "light", 1440);

    // Reset goes back to the claim as written.
    await page.getByRole("button", { name: "Reset to the claim" }).click();
    await expect(page.getByTestId("lab-baseline")).toBeVisible();
    w.assertClean();
  });

  test("the result is announced to screen readers, and a bad age is stopped before it is sent", async ({ page }) => {
    const w = watch(page);
    await page.goto("/cases/ea-02/lab");
    await ready(page);
    await page.locator("#lab-age-min").fill("30");
    await page.locator("#lab-age-max").fill("20");
    await expect(page.getByRole("alert")).toContainText("youngest age cannot be above the oldest");
    await page.locator("#lab-age-max").fill("");
    await page.locator("#lab-age-min").fill("18");
    await expect(page.getByTestId("announcer")).toContainText(/Recomputed with no model call/);
    w.assertClean();
  });

  test("an as-of date reads the evidence as it stood: before the clearance, nothing covers the use", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/cases/ea-02/lab");
    await ready(page);
    await page.locator("#lab-asof").fill("2019-01-01");
    await expect(page.getByTestId("lab-result")).toBeVisible();
    const api = await (await request.post("/api/cases/ea-02/recompute", { data: { patch: {}, asOf: "2019-01-01" } })).json();
    await expect(page.getByTestId("lab-result").locator(".label-badge").nth(1)).toHaveAttribute("data-label", api.after.label);
    expect(api.after.label).not.toBe("SUPPORTED_FOR_SCOPE");
    w.assertClean();
  });
});

test.describe("timeline", () => {
  test("the as-of selector hides what was not yet known", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/cases/ea-02/timeline");
    await ready(page);
    const all = await page.getByTestId("timeline").locator("li").count();
    expect(all).toBeGreaterThanOrEqual(5);
    await page.locator("#asof").fill("2019-01-01");
    await expect(page.getByTestId("timeline-status")).toContainText("as of 1 Jan 2019");
    await expect(page.getByTestId("timeline").locator("li")).toHaveCount(1);
    const api = await (await request.get("/api/cases/ea-02/timeline?asOf=2019-01-01")).json();
    expect(api.length).toBe(1);
    await page.getByRole("button", { name: "Show today" }).click();
    await expect(page.getByTestId("timeline").locator("li")).toHaveCount(all);
    await page.locator("#asof").fill("1999-01-01");
    await expect(page.getByText("Nothing was known on this date")).toBeVisible();
    w.assertClean();
  });

  test("a changed fact flags exactly the dependent finding out of date, on the timeline, the desk and the case", async ({ page, request }) => {
    const w = watch(page);
    const changed = await (await request.post("/api/dev/change-fact/ea-05", { data: {} })).json();
    expect(changed.stale.length).toBe(1);
    await page.goto("/cases/ea-05/timeline");
    await ready(page);
    await expect(page.getByTestId("stale-list")).toContainText("depended on a fact that changed");
    await expect(page.locator('[data-kind="finding_stale"]')).toHaveCount(1);
    await expect(page.locator('[data-kind="source_changed"]')).toHaveCount(1);
    await shot(page, "flow-timeline-stale", "light", 1440);
    await page.goto("/cases");
    await ready(page);
    await expect(page.locator('[data-case="ea-05"] .stale-flag')).toBeVisible();
    await expect(page.locator('[data-case="ea-01"] .stale-flag')).toHaveCount(0);
    await page.goto("/cases/ea-05");
    await ready(page);
    await expect(page.getByTestId("changed-since")).toContainText("changed");
    // Nothing else moved.
    const other = await (await request.get("/api/cases/ea-01")).json();
    expect(other.summary.staleFindings).toBe(0);
    w.assertClean();
  });
});

test.describe("review desk", () => {
  test("lists cases with headline answers, open questions and review state", async ({ page, request }) => {
    const w = watch(page);
    const cases = await (await request.get("/api/cases")).json();
    await page.goto("/cases");
    await ready(page);
    await expect(page.getByTestId("cases-table").locator("tbody tr")).toHaveCount(cases.length);
    await expect(page.getByTestId("desk-stats")).toContainText("open questions");
    await shot(page, "flow-desk", "light", 1440);
    await page.getByRole("link", { name: "EyeArt K200667, claim EA-04" }).click();
    await expect(page).toHaveURL(/\/cases\/ea-04$/);
    w.assertClean();
  });

  test("a decision is recorded once, shows in the history, and a double click cannot record it twice", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/cases/ea-04");
    await ready(page);
    await expect(page.getByTestId("decision-history")).toHaveCount(0);
    const form = page.getByTestId("decision-form");
    await form.getByLabel(/Escalate/).check();
    await form.getByLabel("Note (optional)").fill("Needs a retinal specialist to judge the purpose.");
    const posts: string[] = [];
    page.on("request", (r) => r.url().endsWith("/decision") && posts.push(r.postData() ?? ""));
    await form.getByRole("button", { name: "Record decision" }).dblclick();
    await expect(page.getByTestId("decision-history")).toContainText("escalate");
    await expect(page.getByTestId("decision-history").locator("li")).toHaveCount(1);
    await expect(page.getByTestId("reviewer-state")).toContainText("Escalated");
    await expect(page.getByTestId("announcer")).toContainText("Decision recorded");
    // The service agrees: one entry, in the dossier's hash-chained log.
    const dossier = await (await request.get("/api/cases/ea-04/dossier")).json();
    expect(dossier.body.decisionHistory.length).toBe(1);
    expect(dossier.body.decisionHistory[0].note).toBe("Needs a retinal specialist to judge the purpose.");
    // Re-sending the same key does not add another.
    const key = JSON.parse(posts[0]!).idempotencyKey;
    const detail = await (await request.get("/api/cases/ea-04")).json();
    const again = await request.post("/api/cases/ea-04/decision", { data: { findingId: detail.findings[0].id, action: "escalate", note: "Needs a retinal specialist to judge the purpose.", idempotencyKey: key } });
    expect((await again.json()).replayed).toBe(true);
    expect((await (await request.get("/api/cases/ea-04/dossier")).json()).body.decisionHistory.length).toBe(1);
    await shot(page, "flow-decision", "light", 1440);
    w.assertClean();
  });

  test("a decision the service refuses says why and keeps the form", async ({ page }) => {
    const w = watch(page);
    w.allow(/422/);
    await page.goto("/cases/ea-03");
    await ready(page);
    const form = page.getByTestId("decision-form");
    await form.getByLabel(/Narrow the use/).check();
    await form.getByRole("button", { name: "Record decision" }).click();
    await expect(form.getByRole("alert")).toContainText("nothing to narrow to");
    await expect(page.getByTestId("reviewer-state")).toContainText("Not reviewed yet");
    w.assertClean();
  });

  test("missing-evidence drafts are specific, copyable and never sent", async ({ page, context }) => {
    const w = watch(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/cases/ea-02");
    await ready(page);
    const list = page.getByTestId("missing-evidence");
    await expect(list.locator("li")).toHaveCount(1);
    const draft = (await (await page.request.get("/api/cases/ea-02")).json()).missingEvidence[0].draft as string;
    await expect(list.locator(".draft")).toContainText("Subject: Evidence request");
    await expect(list.locator(".draft")).toContainText("ages 12");
    await list.getByRole("button", { name: /Copy draft/ }).click();
    await expect(page.getByTestId("announcer")).toContainText("copied to the clipboard");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.split(String.fromCharCode(13)).join("").trim()).toBe(draft.trim());
    await expect(page.getByText("Sakaime never sends anything")).toBeVisible();
    w.assertClean();
  });
});

test.describe("resilience drills", () => {
  test("every drill runs, the invariants hold, and a lost source never reads as supported or as none exist", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/cases/ea-01/drills");
    await ready(page);
    await expect(page.getByText("No drill run yet")).toBeVisible();
    await page.getByTestId("run-all").click();
    const summary = page.getByTestId("drill-summary");
    await expect(summary.locator("tbody tr")).toHaveCount(7, { timeout: 30_000 });
    await expect(summary.locator('tbody tr[data-held="true"]')).toHaveCount(7);

    // Source off: a supported claim falls to "not enough evidence" and says what was lost.
    await page.locator('[data-run="source_off"]').click();
    const res = page.getByTestId("drill-result");
    await expect(res).toHaveAttribute("data-drill", "source_off");
    await expect(res.getByTestId("drill-narrative")).toContainText("stopped answering");
    await expect(res.locator(".label-badge").nth(1)).toContainText("Not enough evidence");
    await expect(res.getByTestId("drill-degraded")).toContainText("study");
    await expect(res.locator('[data-check="no-rise"]')).toHaveAttribute("data-ok", "true");
    // An outage and an empty answer read differently.
    const off = (await (await request.post("/api/cases/ea-01/drill", { data: { drill: "source_off", target: "study" } })).json()).after[0];
    const empty = (await (await request.post("/api/cases/ea-01/drill", { data: { drill: "source_empty", target: "study" } })).json()).after[0];
    expect(off.degraded[0].reason).not.toBe(empty.degraded[0].reason);
    await shot(page, "flow-drill-source-off", "light", 1440);

    // A registry change marks only the dependent finding out of date.
    await page.locator('[data-run="registry_changed"]').click();
    await expect(page.getByTestId("stale-ids").locator("li")).toHaveCount(1);
    // The model off does not move a label.
    await page.locator('[data-run="model_off"]').click();
    await expect(page.getByTestId("drill-result").locator('[data-check="same"]')).toHaveAttribute("data-ok", "true");
    // A document that gives orders does not work.
    await page.locator('[data-run="injection_in_document"]').click();
    await expect(page.getByTestId("drill-narrative")).toContainText("set that sentence aside");
    w.assertClean();
  });

  test("a drill with a bad target is refused by the service with a plain reason", async ({ request }) => {
    const r = await request.post("/api/cases/ea-01/drill", { data: { drill: "source_off", target: "nonsense" } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error.message).toContain("neither a kind of evidence nor a known source id");
    const r2 = await request.post("/api/cases/ea-01/drill", { data: { drill: "source_off" } });
    expect(r2.status()).toBe(400);
    const r3 = await request.post("/api/cases/ea-01/drill", { data: { drill: "bogus" } });
    expect(r3.status()).toBe(400);
  });
});

test.describe("investigation", () => {
  test("the stream is a readable timeline of role decisions with query ids, and the trace downloads", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/cases/ea-02/investigation");
    await ready(page);
    await expect(page.getByText("No run yet")).toBeVisible();
    await page.getByTestId("start-run").click();
    await expect(page.getByTestId("trace-status")).toContainText("Streaming");
    await expect(page.getByTestId("trace-status")).toContainText("Finished", { timeout: 30_000 });
    const trace = page.getByTestId("trace");
    for (const role of ["system", "guard", "planner", "retriever", "resolver", "extractor", "critic", "compiler", "reporter"]) {
      await expect(trace.locator(`[data-role="${role}"]`).first()).toBeVisible();
    }
    await expect(trace.locator('[data-role="retriever"]')).toContainText("Query");
    await expect(trace.locator('[data-role="extractor"]').first()).toContainText("exists verbatim");
    const n = await trace.locator(".trace-item").count();
    const href = await page.getByTestId("trace-download").getAttribute("href");
    const body = await (await request.get(href!)).text();
    expect(body.trim().split("\n").length).toBe(n);
    await shot(page, "flow-investigation", "light", 1440);
    w.assertClean();
  });
});

test.describe("dossier", () => {
  test("export, verify, and a one-character change is caught with the failing item named", async ({ page }) => {
    const w = watch(page);
    await page.goto("/cases/ea-02/dossier");
    await ready(page);
    await expect(page.getByTestId("verify-dossier")).toBeDisabled();
    await expect(page.getByTestId("tamper")).toBeDisabled();
    await page.getByTestId("export-dossier").click();
    const summary = page.getByTestId("dossier-summary");
    await expect(summary).toContainText("Demo key");
    await expect(page.getByTestId("download-dossier")).toBeVisible();
    await page.getByTestId("verify-dossier").click();
    await expect(page.getByTestId("verify-line").first()).toContainText(/All \d+ checks passed/);
    await expect(page.getByTestId("signature-note")).toContainText("does not show that any finding is clinically correct");
    await page.getByTestId("tamper").click();
    const out = page.getByTestId("tamper-out");
    await expect(out.getByTestId("tamper-change")).toContainText("body.anchors[0].text");
    await expect(out.getByTestId("verify-failures")).toContainText("anchors/");
    await expect(out.getByTestId("verify-failures")).toContainText("hash mismatch");
    await expect(out.locator(".verify-bad")).toBeVisible();
    // The original still verifies: the tamper ran on a copy.
    await page.getByTestId("verify-dossier").click();
    await expect(page.getByTestId("verify-result").first()).toHaveAttribute("data-ok", "true");
    await shot(page, "flow-dossier", "light", 1440);
    w.assertClean();
  });

  test("the service verifier refuses non-dossiers instead of passing them", async ({ request }) => {
    for (const data of [{}, { format: "other" }, []]) {
      const r = await request.post("/api/dossier/verify", { data });
      expect(r.status()).toBe(200);
      expect((await r.json()).ok).toBe(false);
    }
  });
});

test.describe("guard", () => {
  test("a document that gives orders is held back, the exact words are set aside, and can be revealed", async ({ page }) => {
    const w = watch(page);
    await page.goto("/guard");
    await ready(page);
    await expect(page.getByText("Nothing checked yet")).toBeVisible();
    await page.locator('[data-example="injection"]').click();
    await expect(page.getByRole("radio", { name: /A document/ })).toBeChecked();
    await page.getByRole("button", { name: "Check the text" }).click();
    const out = page.getByTestId("guard-result");
    await expect(out).toHaveAttribute("data-allowed", "false");
    await expect(out).toContainText("Held back");
    await expect(page.getByTestId("guard-findings")).toContainText("injection");
    await expect(page.getByTestId("redaction").first()).toBeVisible();
    await expect(page.getByTestId("guard-text")).not.toContainText("Ignore all previous instructions");
    await shot(page, "flow-guard", "light", 1440);
    await page.getByRole("button", { name: "Show the hidden words" }).click();
    await expect(page.getByTestId("guard-text")).toContainText("Ignore all previous instructions");
    w.assertClean();
  });

  test("an ordinary question passes, a patient identifier is set aside, a request to send data out is refused", async ({ page }) => {
    const w = watch(page);
    await page.goto("/guard");
    await ready(page);
    await page.locator('[data-example="question"]').click();
    await page.getByRole("button", { name: "Check the text" }).click();
    await expect(page.getByTestId("guard-result")).toHaveAttribute("data-allowed", "true");
    await page.locator('[data-example="phi"]').click();
    await page.getByRole("button", { name: "Check the text" }).click();
    await expect(page.getByTestId("guard-result")).toHaveAttribute("data-allowed", "false");
    await expect(page.getByTestId("guard-findings")).toContainText("patient identifiers do not enter Sakaime");
    await page.locator('[data-example="export"]').click();
    await page.getByRole("button", { name: "Check the text" }).click();
    await expect(page.getByTestId("guard-result")).toHaveAttribute("data-allowed", "false");
    await expect(page.getByTestId("guard-message")).toContainText("does not");
    w.assertClean();
  });

  test("junk: empty text cannot be sent; the service refuses an empty body and an unknown origin", async ({ page, request }) => {
    await page.goto("/guard");
    await ready(page);
    await expect(page.getByRole("button", { name: "Check the text" })).toBeDisabled();
    expect((await request.post("/api/guard", { data: { text: "", origin: "document" } })).status()).toBe(400);
    expect((await request.post("/api/guard", { data: { text: "hi", origin: "robot" } })).status()).toBe(400);
  });
});

test.describe("about and limits", () => {
  test("figures come from result files; unmeasured rows say so and show no number", async ({ page, request }) => {
    const w = watch(page);
    const file = await (await request.get("/results.json")).json();
    await page.goto("/about");
    await ready(page);
    const results = page.getByTestId("results");
    const measured = file.rows.filter((r: { status: string }) => r.status === "measured");
    const planned = file.rows.filter((r: { status: string }) => r.status === "to_be_measured");
    expect(measured.length).toBeGreaterThan(5);
    expect(planned.length).toBeGreaterThan(3);
    for (const r of measured) await expect(results.locator(`[data-row="${r.id}"]`)).toContainText(r.value);
    for (const r of planned) {
      const row = results.locator(`[data-row="${r.id}"]`);
      await expect(row).toContainText("To be measured");
      await expect(row.locator("td").first()).not.toContainText(/\d/);
    }
    await expect(page.getByText("builder, not by independent reviewers").first()).toBeVisible();
    await expect(page.getByTestId("licences").locator("li").first()).toBeVisible();
    w.assertClean();
  });
});

test.describe("theme", () => {
  test("the visible toggle switches theme, persists it, and the page keeps its contrast", async ({ page }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.goto("/");
    await ready(page);
    const bg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await bg()).toBe("rgb(255, 255, 255)");
    await page.getByTestId("theme-toggle").click();
    expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
    expect(await bg()).not.toBe("rgb(255, 255, 255)");
    await page.reload();
    await ready(page);
    expect(await page.locator("html").getAttribute("data-theme")).toBe("dark");
    await expect(page.getByTestId("theme-toggle")).toHaveAttribute("aria-pressed", "true");
  });
});

test.describe("copy lint", () => {
  test("no screen says safe, cleared, compliant, approved, guaranteed, proof, accurate, best or production-ready", async ({ page }) => {
    const banned = /\b(safe|safely|cleared|compliant|approved|guaranteed?|proofs?|accurate|accuracy|best|production-ready|state-of-the-art)\b/i;
    const paths = ["/", "/sources", "/cases", "/cases/ea-01", "/cases/ea-02/matrix", "/cases/ea-02/claims", "/cases/ea-02/lab", "/cases/ea-02/timeline", "/cases/ea-02/investigation", "/cases/ea-02/drills", "/cases/ea-02/dossier", "/guard", "/about"];
    for (const p of paths) {
      await page.goto(p);
      await ready(page);
      // Quoted passages from regulator documents, the constructed claim and the machine's SQL are data, not our copy.
      const text = await page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(".anchor__quote, .claim-quote, .strip__quote, .code-block, .matrix td, .draft, .guard-text, .guard-span, script, style").forEach((n) => n.remove());
        return clone.innerText;
      });
      const hit = banned.exec(text);
      expect(hit, `${p} contains the banned word "${hit?.[0]}" near: ${hit ? text.slice(Math.max(0, hit.index - 60), hit.index + 60) : ""}`).toBeNull();
    }
  });

  test("the five labels read as plain words and the exact token is available to screen readers and on hover", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const list = page.locator(".label-list");
    for (const [token, words] of [
      ["SUPPORTED_FOR_SCOPE", "Supported for this use"],
      ["SUPPORTED_ONLY_FOR_NARROWER_SCOPE", "Supported only for a narrower use"],
      ["CONTRADICTED_BY_SPECIFIED_EVIDENCE", "Contradicted by specified evidence"],
      ["INSUFFICIENT_EVIDENCE", "Not enough evidence"],
      ["REQUIRES_DOMAIN_REVIEW", "Needs domain review"],
    ]) {
      const badge = list.locator(`[data-label="${token}"]`);
      await expect(badge).toContainText(words);
      await expect(badge).toHaveAttribute("title", new RegExp(`^${token}:`));
      await expect(badge.locator(".sr-only")).toHaveText(new RegExp(token));
    }
  });
});
