import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { test, LABEL_WORDS, REAL, getCase, headlineOf, listCases, primaryCase, quietCase, ready, shot, watch, type Detail } from "./helpers";

/**
 * Real flows, driven the way a reviewer would, with the outcome asserted from what is on the screen and from the service, which
 * holds the truth. Expectations are read from the live API response, never typed in, so the same flows pass against the fixture
 * server and the real service.
 */

const norm = (s: string): string => s.replace(/\s+/g, " ").trim();
const enc = encodeURIComponent;

/** Posts the same recompute the Lab sends, so the screen can be compared with the service's own answer. */
async function recompute(request: APIRequestContext, id: string, body: unknown) {
  const res = await request.post(`/api/cases/${enc(id)}/recompute`, { data: body });
  expect(res.status(), "POST recompute").toBe(200);
  return (await res.json()) as { after: { label: string; requiredEvidence: unknown[] }; modelCalled: boolean };
}

test.describe("landing and claim X-ray", () => {
  test("the live strip opens the claim X-ray of a real case, and says why the answer is what it is", async ({ page, request }) => {
    const w = watch(page);
    const cases = await listCases(request);
    const pick = cases.find((c) => c.headlineLabel && c.headlineLabel !== "SUPPORTED_FOR_SCOPE") ?? cases[0]!;
    const detail = await getCase(request, pick.id);
    const head = headlineOf(detail);
    await page.goto("/");
    await ready(page);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("A claim can be true and still be wrong for you.");
    const strip = page.getByTestId("live-strip");
    await expect(strip).toContainText("Constructed claim");
    await expect(strip).toContainText(pick.title);
    await expect(strip).toContainText(LABEL_WORDS[pick.headlineLabel!]!);
    // The strip carries the reason, not just the label: which parts of the use are open, and what would settle it.
    const open = detail.dimensions[head.id]!.filter((d) => d.relation !== "CONTAINED");
    if (open.length > 0) await expect(strip.getByTestId("why").locator("[data-why-dimension]").first()).toBeVisible();
    if (head.requiredEvidence.length > 0) await expect(strip.getByTestId("settle")).toBeVisible();
    await strip.getByRole("link", { name: /Open the claim X-ray/ }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${pick.id}/claims/fnd_`));
    await ready(page);
    await expect(page.getByTestId("claim-text")).not.toBeEmpty();
    await expect(page.getByTestId("dimensions").locator("[data-dimension]")).toHaveCount(detail.dimensions[head.id]!.length);
    w.assertClean();
  });

  test("X-ray: claimed against established, exact anchors, counterexample and separate link types", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    const head = headlineOf(detail);
    const dims = detail.dimensions[head.id]!;
    await page.goto(`/cases/${enc(detail.summary.id)}/claims`);
    await ready(page);
    await expect(page).toHaveURL(new RegExp(`/claims/${head.id}$`));
    await shot(page, "flow-xray-top", "light", 1440);

    // The answer comes from the service, unchanged.
    await expect(page.locator(".answer-card")).toHaveAttribute("data-label", head.label);
    await expect(page.locator(".answer-card")).toContainText(head.label);

    // Every dimension is shown with the relation the service computed, and both sides start with the service's words.
    for (const d of dims) {
      const row = page.locator(`[data-dimension="${d.dimension}"]`);
      await expect(row).toHaveAttribute("data-relation", d.relation);
      if (d.claimed) await expect(row.locator('[data-side="claimed"]')).toContainText(norm(d.claimed).slice(0, 40));
      if (d.established) await expect(row.locator('[data-side="established"]')).toContainText(norm(d.established).slice(0, 40));
    }
    // What falls short is listed before what is covered.
    const shortOnes = dims.filter((d) => d.relation !== "CONTAINED").length;
    await expect(page.getByTestId("dimensions").locator(".dim-list").first().locator("[data-dimension]")).toHaveCount(shortOnes > 0 ? shortOnes : dims.length);

    // Anchors: closed until asked, then the verbatim passage, its page, source and date and the rule.
    const withAnchors = dims.find((d) => d.relation !== "CONTAINED" && d.anchorIds.length > 0) ?? dims.find((d) => d.anchorIds.length > 0);
    expect(withAnchors, "some dimension rests on a passage").toBeDefined();
    const row = page.locator(`[data-dimension="${withAnchors!.dimension}"]`);
    await expect(row.locator(".anchor").first()).toBeHidden();
    await row.getByText(/Show the exact evidence/).click();
    const first = row.locator(".anchor").first();
    await expect(first).toBeVisible();
    await expect(first.locator("mark")).not.toBeEmpty();
    await expect(first).toContainText(/Retrieved \d{1,2} \w{3} \d{4}/);
    await expect(first).toContainText(/page \d+|field \S+|location not stated/);
    await expect(first.locator(".anchor__rules")).toContainText(/R\d+|Not used by a rule/);
    // The quote on screen is a quote in the service's record, character for character.
    const quote = norm(await first.locator("mark").innerText());
    expect(detail.anchors.some((a) => norm(a.text) === quote)).toBe(true);
    // A long list opens on request and then shows every passage.
    if (withAnchors!.anchorIds.length > 4) {
      await expect(row.locator(".anchor")).toHaveCount(4);
      await row.getByRole("button", { name: /Show the other \d+ passages/ }).click();
      await expect(row.locator(".anchor")).toHaveCount(withAnchors!.anchorIds.length);
    }
    await shot(page, "flow-xray-anchor", "light", 1440);

    // The smallest mismatch names only what stops the claim.
    if (head.mismatches.length > 0) {
      await expect(page.getByTestId("counterexample").locator("li.counterexample__row")).toHaveCount(head.mismatches.length);
    } else {
      await expect(page.getByText("No mismatch: every dimension")).toBeVisible();
    }

    // Link types are shown apart, with state; an ambiguous one has its waterfall.
    const links = page.getByTestId("links");
    if (detail.links.length > 0) {
      for (const t of new Set(detail.links.map((l) => l.type))) await expect(links.locator(`[data-link-type="${t}"]`)).toHaveCount(1);
      for (const state of new Set(detail.links.map((l) => l.state))) await expect(links.locator(`li[data-link-state="${state}"]`)).toHaveCount(detail.links.filter((l) => l.state === state).length);
      await expect(links).toContainText("Sharing a submission number does not mean two records describe the same software release");
      const withWaterfall = detail.links.find((l) => (l.waterfall?.length ?? 0) > 0);
      if (withWaterfall) {
        const li = links.locator(`li[data-link-state="${withWaterfall.state}"]`).filter({ has: page.getByText(/how the match weight adds up/) }).first();
        await li.getByText(/how the match weight adds up/).click();
        await expect(li.getByTestId("waterfall").locator("tbody tr")).toHaveCount(withWaterfall.waterfall!.length);
      }
    }
    await expect(page.locator(".answer-card .type-tag").first()).toBeVisible();
    w.assertClean();
  });

  test("X-ray: a case with several claims lets the reviewer move between them", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    test.skip(detail.findings.length < 2, "this case holds a single claim");
    const other = detail.findings.find((f) => f.id !== headlineOf(detail).id)!;
    await page.goto(`/cases/${enc(detail.summary.id)}/claims`);
    await ready(page);
    const nav = page.getByRole("navigation", { name: "Which claim to read" });
    await expect(nav.locator("li")).toHaveCount(detail.findings.length);
    await expect(nav.locator('[aria-current="page"]')).toHaveCount(1);
    await nav.locator(`a[href$="/claims/${other.id}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/claims/${other.id}$`));
    await ready(page);
    await expect(page.locator(".answer-card")).toHaveAttribute("data-label", other.label);
    w.assertClean();
  });

  test("X-ray: an unknown finding id is a designed state, not a blank page", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    await page.goto(`/cases/${enc(detail.summary.id)}/claims/fnd_doesnotexist`);
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
    const sources = (await (await request.get("/api/sources")).json()) as { source: { id: string; health: string; schemaHash?: string; descriptor: string }; zetarisName?: string; healthDetail: string }[];
    await page.goto("/sources");
    await ready(page);
    const table = page.getByTestId("sources-table");
    await expect(table.locator("tbody tr")).toHaveCount(sources.length);
    for (const s of sources) {
      const row = table.locator(`[data-source="${s.source.id}"]`);
      await expect(row.locator(`[data-health="${s.source.health}"]`)).toBeVisible();
      await expect(row).toContainText(s.healthDetail);
      if (s.zetarisName) await expect(row).toContainText(s.zetarisName.split(",")[0]!.trim());
      if (s.source.schemaHash) await expect(row.locator(".cell-hash code")).toBeVisible();
    }
    // A pinned or old snapshot reads as out of date, not as answering.
    const stale = sources.find((s) => s.source.health === "STALE");
    if (stale) await expect(table.locator(`[data-source="${stale.source.id}"] [data-health="STALE"]`)).toContainText("Out of date");
    await page.getByText("What the health words mean").click();
    await expect(page.locator(".legend").first()).toContainText("never read as");
    await shot(page, "flow-sources", "light", 1440);
    w.assertClean();
  });

  /** What the Source console submitted for an example, read back from the form so the service can be asked the same thing. */
  async function submitted(page: Page) {
    return { description: await page.locator("#src-desc").inputValue(), url: await page.locator("#src-url").inputValue() };
  }

  test("add a source: an allowed address streams eight stages, and the screen shows the service's outcome and mapping", async ({ page, request }) => {
    const w = watch(page);
    await page.goto("/sources");
    await ready(page);
    await page.locator('[data-example="allowed"]').click();
    await expect(page.locator("#src-url")).toHaveValue(/api\.fda\.gov/);
    const body = await submitted(page);
    await page.getByRole("button", { name: "Onboard this source" }).click();
    const result = page.getByTestId("onboarding-result");
    await expect(result).toBeVisible();
    await expect(result.locator("li.stage")).toHaveCount(8);
    await expect(result.locator("[data-outcome]")).toBeVisible({ timeout: 15_000 });
    // The same request is idempotent, so asking again returns the very result the screen was drawn from.
    const api = (await (await request.post("/api/sources/propose", { data: body })).json()) as { outcome: string; stages: { stage: string; status: string; summary: string }[]; mapping: { check: string }[] };
    await expect(result.locator("[data-outcome]")).toHaveAttribute("data-outcome", api.outcome);
    for (const s of api.stages) await expect(result.locator(`[data-stage="${s.stage}"]`)).toHaveAttribute("data-status", s.status);
    await expect(result.locator('[data-stage="authorization"]')).toHaveAttribute("data-status", "passed");
    if (api.mapping.length > 0) {
      const mapping = page.getByTestId("mapping-table");
      await expect(mapping).toBeVisible();
      for (const check of new Set(api.mapping.map((m) => m.check))) await expect(mapping.locator(`[data-check="${check}"]`).first()).toBeVisible();
    }
    await shot(page, "flow-onboard-held", "light", 1440);
    w.assertClean();
  });

  test("add a source: SSRF attempts are refused before anything is read, with the service's own reason", async ({ page, request }) => {
    const w = watch(page);
    w.allow(/status of (400|403|422)/);
    await page.goto("/sources");
    await ready(page);
    for (const ex of ["metadata", "unlisted"]) {
      await page.locator(`[data-example="${ex}"]`).click();
      const body = await submitted(page);
      await page.getByRole("button", { name: "Onboard this source" }).click();
      // The service may refuse with an error (an address that points inside a network) or with a declined onboarding result whose
      // first stage failed (a host nobody approved). Either way nothing after the refusal ran, and the screen carries the reason.
      const res = await request.post("/api/sources/propose", { data: body });
      if (res.ok()) {
        const api = (await res.json()) as { outcome: string; reason?: string; stages: { stage: string; status: string }[] };
        expect(api.outcome).toBe("declined");
        expect(api.reason ?? "", "the service says why").not.toBe("");
        const out = page.locator('[data-outcome="declined"]');
        await expect(out).toBeVisible({ timeout: 15_000 });
        await expect(out).toContainText(norm(api.reason!).slice(0, 50));
        await expect(page.locator('[data-stage="authorization"]')).toHaveAttribute("data-status", "failed");
        for (const s of api.stages.filter((x) => x.stage !== "authorization")) expect(["skipped", "pending"]).toContain(s.status);
        await expect(page.locator('[data-stage="bounded_probe"]')).toHaveAttribute("data-status", /skipped|pending/);
      } else {
        const api = (await res.json()) as { error: { failure: string; message: string } };
        expect(["REFUSED", "FORBIDDEN", "INVALID"]).toContain(api.error.failure);
        const box = page.getByTestId("onboarding-error");
        await expect(box).toBeVisible({ timeout: 15_000 });
        await expect(box).toContainText(norm(api.error.message).slice(0, 50));
        await expect(page.getByTestId("onboarding-result")).toHaveCount(0);
      }
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
    // The same request is the same decision: same id, same outcome, and never a second registration.
    expect(second.id).toBe(first.id);
    expect(second.outcome).toBe(first.outcome);
    expect(second.sourceId).toBe(first.sourceId);
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
    // A declined result (all stages at once) or a refusal before anything was read: either one appears without the staged delay.
    await expect(page.locator('[data-outcome="declined"], [data-testid="onboarding-error"]').first()).toBeVisible({ timeout: 2_000 });
  });
});

test.describe("evidence matrix", () => {
  test("columns carry source badges, the SQL is one click away, counts and query id are shown", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    const m = detail.matrix;
    expect(m, "the primary case has a federated result").toBeDefined();
    await page.goto(`/cases/${enc(detail.summary.id)}/matrix`);
    await ready(page);
    const served = { live: "Live", cassette: "Recorded query", fallback: "Local fallback" }[m!.servedFrom]!;
    await expect(page.getByTestId("matrix-meta")).toContainText(served);
    await expect(page.getByTestId("query-id")).toHaveText(m!.queryId);
    const counts = page.getByTestId("source-counts");
    for (const [id, n] of Object.entries(m!.perSourceRowCounts)) {
      const label = m!.columns.find((c) => c.sourceId === id)?.sourceLabel;
      if (label) await expect(counts).toContainText(label);
      await expect(counts).toContainText(String(n));
    }
    const table = page.getByTestId("matrix-table");
    await expect(table.locator("tbody tr")).toHaveCount(m!.rows.length);
    // One header group per run of columns that share a source.
    const groups = m!.columns.filter((c, i) => i === 0 || m!.columns[i - 1]!.sourceId !== c.sourceId).length;
    await expect(table.locator("thead tr").first().locator("th")).toHaveCount(groups);
    await expect(page.getByTestId("sql-text")).toBeHidden();
    await page.getByText("Show the SQL that produced this result").click();
    await expect(page.getByTestId("sql-text")).toContainText("SELECT");
    await shot(page, "flow-matrix", "light", 1440);
    w.assertClean();
  });
});

test.describe("applicability lab", () => {
  const ageOf = (d: Detail): number => d.claim.use?.population?.age?.min ?? 18;

  test("changing the use recomputes with no model call and says what moved", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    const id = detail.summary.id;
    const head = headlineOf(detail);
    await page.goto(`/cases/${enc(id)}/lab`);
    await ready(page);
    await expect(page.getByTestId("lab-baseline")).toContainText(LABEL_WORDS[head.label]!);
    // The baseline says why, like every other screen that shows the answer.
    await expect(page.getByTestId("lab-baseline").getByTestId("why")).toBeVisible();
    const calls: string[] = [];
    page.on("request", (r) => r.url().includes("/recompute") && calls.push(r.postData() ?? ""));
    await page.locator("#lab-age-min").fill(String(ageOf(detail) + 4));
    const result = page.getByTestId("lab-result");
    await expect(result).toBeVisible();
    await expect(page.getByTestId("lab-summary")).toContainText(/The answer (changed from|is unchanged)/);
    await expect(page.getByTestId("no-model")).toHaveText(/No model was called/);
    await expect(page.getByTestId("lab-meta")).toContainText(/Recomputed in/);
    // Only the changed field is sent.
    const sent = JSON.parse(calls[calls.length - 1]!);
    expect(Object.keys(sent.patch)).toEqual(["population"]);
    // The answer on screen is the service's answer for that patch.
    const api = await recompute(request, id, sent);
    expect(api.modelCalled).toBe(false);
    await expect(result.locator(".label-badge").nth(1)).toHaveAttribute("data-label", api.after.label);
    await shot(page, "flow-lab-age", "light", 1440);

    // A different care setting: an emergency department. Whatever the service answers is what the screen shows.
    for (const s of detail.claim.use?.settings ?? []) await page.getByRole("checkbox", { name: s.replace(/_/g, " "), exact: true }).uncheck();
    await page.getByRole("checkbox", { name: "emergency department" }).check();
    await expect(page.getByTestId("lab-summary")).toBeVisible();
    await expect.poll(async () => JSON.parse(calls[calls.length - 1]!).patch.settings?.join(",")).toBe("emergency_department");
    const second = await recompute(request, id, JSON.parse(calls[calls.length - 1]!));
    await expect(page.getByTestId("lab-result").locator(".label-badge").nth(1)).toHaveAttribute("data-label", second.after.label);
    if (second.after.requiredEvidence.length > 0) await expect(page.getByTestId("lab-missing")).toBeVisible();
    await shot(page, "flow-lab-setting", "light", 1440);

    // Reset goes back to the claim as written.
    await page.getByRole("button", { name: "Reset to the claim" }).click();
    await expect(page.getByTestId("lab-baseline")).toBeVisible();
    w.assertClean();
  });

  test("the result is announced to screen readers, and a bad age is stopped before it is sent", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    await page.goto(`/cases/${enc(detail.summary.id)}/lab`);
    await ready(page);
    await page.locator("#lab-age-min").fill("30");
    await page.locator("#lab-age-max").fill("20");
    await expect(page.getByRole("alert")).toContainText("youngest age cannot be above the oldest");
    await page.locator("#lab-age-max").fill("");
    await page.locator("#lab-age-min").fill(String(ageOf(detail) + 1));
    await expect(page.getByTestId("announcer")).toContainText(/Recomputed with no model call/);
    w.assertClean();
  });

  test("an as-of date reads the evidence as it stood: before any of it existed, nothing covers the use", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    await page.goto(`/cases/${enc(detail.summary.id)}/lab`);
    await ready(page);
    await page.locator("#lab-asof").fill("2019-01-01");
    await expect(page.getByTestId("lab-result")).toBeVisible();
    const api = await recompute(request, detail.summary.id, { patch: {}, asOf: "2019-01-01" });
    await expect(page.getByTestId("lab-result").locator(".label-badge").nth(1)).toHaveAttribute("data-label", api.after.label);
    expect(api.after.label).not.toBe("SUPPORTED_FOR_SCOPE");
    w.assertClean();
  });
});

test.describe("timeline", () => {
  test("the as-of selector hides what was not yet known", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    const id = detail.summary.id;
    await page.goto(`/cases/${enc(id)}/timeline`);
    await ready(page);
    const all = await page.getByTestId("timeline").locator("li.tl-item").count();
    expect(all).toBe(detail.timeline.length);
    await page.locator("#asof").fill("2019-01-01");
    await expect(page.getByTestId("timeline-status")).toContainText("as of 1 Jan 2019");
    const api = (await (await request.get(`/api/cases/${enc(id)}/timeline?asOf=2019-01-01`)).json()) as unknown[];
    expect(api.length).toBeLessThan(all);
    await expect(page.getByTestId("timeline").locator("li.tl-item")).toHaveCount(api.length);
    await page.getByRole("button", { name: "Show today" }).click();
    await expect(page.getByTestId("timeline").locator("li.tl-item")).toHaveCount(all);
    await page.locator("#asof").fill("1999-01-01");
    const early = (await (await request.get(`/api/cases/${enc(id)}/timeline?asOf=1999-01-01`)).json()) as unknown[];
    if (early.length === 0) await expect(page.getByText("Nothing was known on this date")).toBeVisible();
    else await expect(page.getByTestId("timeline").locator("li.tl-item")).toHaveCount(early.length);
    w.assertClean();
  });

  test("a fact every finding rests on is said once, not as a link per finding", async ({ page, request }) => {
    const detail = await primaryCase(request);
    test.skip(detail.findings.length < 3, "needs a case with several findings");
    await page.goto(`/cases/${enc(detail.summary.id)}/timeline`);
    await ready(page);
    const total = detail.findings.length;
    const shared = detail.timeline.filter((e) => (e as unknown as { findingIds: string[] }).findingIds.length === total);
    test.skip(shared.length === 0, "no event is shared by every finding");
    // Each such event says it once, and none of those rows lists the findings as separate links.
    const rows = page.locator("li.tl-item").filter({ hasText: `Used by all ${total} findings in this case.` });
    await expect(rows).toHaveCount(shared.length);
    await expect(rows.locator("a")).toHaveCount(0);
  });

  // The fixture server has a route that changes a fact after a finding was made. The real service has none (its registry-change
  // drill reports the stale set in its response and does not persist it), so this flow cannot be driven there. The stale
  // rendering is covered against both servers by the changed-shape timeline test in states.spec.ts.
  test("a changed fact flags exactly the dependent finding out of date, on the timeline, the desk and the case", async ({ page, request }) => {
    test.skip(REAL, "needs the fixture server's /api/dev/change-fact route; the real service has no persisted change event");
    const w = watch(page);
    const cases = await listCases(request);
    const victim = cases[cases.length - 1]!;
    const bystander = cases[0]!;
    const changed = await (await request.post(`/api/dev/change-fact/${victim.id}`, { data: {} })).json();
    expect(changed.stale.length).toBe(1);
    await page.goto(`/cases/${victim.id}/timeline`);
    await ready(page);
    await expect(page.getByTestId("stale-list")).toContainText("depended on a fact that changed");
    await expect(page.locator('[data-kind="finding_stale"]')).toHaveCount(1);
    await expect(page.locator('[data-kind="source_changed"]')).toHaveCount(1);
    await shot(page, "flow-timeline-stale", "light", 1440);
    await page.goto("/cases");
    await ready(page);
    await expect(page.locator(`[data-case="${victim.id}"] .stale-flag`)).toBeVisible();
    await expect(page.locator(`[data-case="${bystander.id}"] .stale-flag`)).toHaveCount(0);
    await page.goto(`/cases/${victim.id}`);
    await ready(page);
    await expect(page.getByTestId("changed-since")).toContainText("changed");
    const other = await getCase(request, bystander.id);
    expect(other.summary.staleFindings).toBe(0);
    w.assertClean();
  });
});

test.describe("review desk", () => {
  test("lists cases with headline answers, open questions and review state", async ({ page, request }) => {
    const w = watch(page);
    const cases = await listCases(request);
    await page.goto("/cases");
    await ready(page);
    const rows = page.getByTestId("cases-table").locator("tbody tr");
    await expect(rows).toHaveCount(cases.length);
    for (const c of cases) {
      const row = page.locator(`[data-case="${c.id}"]`);
      await expect(row).toContainText(c.title);
      if (c.headlineLabel) await expect(row.locator(".label-badge")).toHaveAttribute("data-label", c.headlineLabel);
      await expect(row.locator('[data-label="Open questions"]')).toHaveText(String(c.openQuestions));
    }
    await expect(page.getByTestId("desk-stats")).toContainText("open questions");
    await shot(page, "flow-desk", "light", 1440);
    const target = cases[cases.length - 1]!;
    await page.getByRole("link", { name: target.title }).click();
    await expect(page).toHaveURL(new RegExp(`/cases/${target.id}$`));
    w.assertClean();
  });

  test("the case says the answer, why, and what would settle it before it asks for a decision", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    const head = headlineOf(detail);
    await page.goto(`/cases/${enc(detail.summary.id)}`);
    await ready(page);
    const card = page.locator(`.finding-card-head[data-finding="${head.id}"]`);
    await expect(card.locator(".label-badge").first()).toHaveAttribute("data-label", head.label);
    await expect(card.getByTestId("why")).toBeVisible();
    if (head.requiredEvidence.length > 0) await expect(card.getByTestId("settle")).toBeVisible();
    // One decision form for the reviewer's own question; each vendor claim offers its own on request.
    await expect(page.getByTestId("decision-form")).toHaveCount(1);
    const others = detail.findings.filter((f) => f.id !== head.id);
    if (others.length > 0) {
      await expect(page.getByTestId("vendor-claims").locator("li.finding-card")).toHaveCount(others.length);
      await page.getByTestId("vendor-claims").locator("li.finding-card").first().getByText("Record a decision on this claim").click();
      await expect(page.getByTestId("decision-form")).toHaveCount(2);
    }
    w.assertClean();
  });

  test("a decision is recorded once, shows in the history, and a double click cannot record it twice", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    const id = detail.summary.id;
    const head = headlineOf(detail);
    const decisionsBefore = detail.timeline.filter((e) => e.kind === "decision").length;
    await page.goto(`/cases/${enc(id)}`);
    await ready(page);
    const history = page.getByTestId("decision-history");
    if (decisionsBefore === 0) await expect(history).toHaveCount(0);
    const form = page.getByTestId("decision-form");
    await form.getByLabel(/Escalate/).check();
    await form.getByLabel("Note (optional)").fill("Needs a specialist to judge the purpose.");
    const posts: string[] = [];
    page.on("request", (r) => r.url().endsWith("/decision") && posts.push(r.postData() ?? ""));
    await form.getByRole("button", { name: "Record decision" }).dblclick();
    await expect(history).toContainText("escalate");
    await expect(history.locator("li")).toHaveCount(decisionsBefore + 1);
    await expect(page.getByTestId("reviewer-state")).toContainText("Escalated");
    await expect(page.getByTestId("announcer")).toContainText("Decision recorded");
    // The service agrees: one more entry, in the dossier's hash-chained log.
    const dossier = await (await request.get(`/api/cases/${enc(id)}/dossier`)).json();
    expect(dossier.body.decisionHistory.length).toBe(decisionsBefore + 1);
    expect(dossier.body.decisionHistory.at(-1).note).toBe("Needs a specialist to judge the purpose.");
    // Re-sending the same key does not add another.
    const key = JSON.parse(posts[0]!).idempotencyKey;
    const again = await request.post(`/api/cases/${enc(id)}/decision`, { data: { findingId: head.id, action: "escalate", note: "Needs a specialist to judge the purpose.", idempotencyKey: key } });
    expect((await again.json()).replayed).toBe(true);
    expect((await (await request.get(`/api/cases/${enc(id)}/dossier`)).json()).body.decisionHistory.length).toBe(decisionsBefore + 1);
    await shot(page, "flow-decision", "light", 1440);
    w.assertClean();
  });

  test("a decision the service refuses says why and keeps the form", async ({ page, request }) => {
    const w = watch(page);
    w.allow(/status of (400|422)/);
    // "Narrow the use" is refused for a finding with no narrower supported scope; find one and ask the service for its own words.
    const cases = await listCases(request);
    let target: { caseId: string; findingId: string; reviewerState: string } | undefined;
    for (const c of cases) {
      const d = await getCase(request, c.id);
      const f = headlineOf(d);
      if (f.label !== "SUPPORTED_ONLY_FOR_NARROWER_SCOPE") {
        target = { caseId: c.id, findingId: f.id, reviewerState: (f as unknown as { reviewerState: string }).reviewerState };
        break;
      }
    }
    expect(target, "a finding with nothing to narrow to").toBeDefined();
    const refused = await request.post(`/api/cases/${enc(target!.caseId)}/decision`, { data: { findingId: target!.findingId, action: "narrow", idempotencyKey: `probe-${Date.now()}` } });
    expect([400, 422]).toContain(refused.status());
    const apiMessage = (await refused.json()).error.message as string;
    await page.goto(`/cases/${enc(target!.caseId)}`);
    await ready(page);
    const stateBefore = await page.getByTestId("reviewer-state").innerText();
    const form = page.getByTestId("decision-form");
    await form.getByLabel(/Narrow the use/).check();
    await form.getByRole("button", { name: "Record decision" }).click();
    await expect(form.getByRole("alert")).toContainText(norm(apiMessage).slice(0, 50));
    await expect(page.getByTestId("reviewer-state")).toHaveText(stateBefore);
    await expect(form.getByLabel(/Narrow the use/)).toBeChecked();
    w.assertClean();
  });

  test("missing-evidence drafts are specific, copyable and never sent", async ({ page, context, request }) => {
    const w = watch(page);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    const detail = await primaryCase(request);
    test.skip(detail.missingEvidence.length === 0, "the case has nothing missing");
    await page.goto(`/cases/${enc(detail.summary.id)}`);
    await ready(page);
    const list = page.getByTestId("missing-evidence");
    await expect(list.locator(".missing-item")).toHaveCount(detail.missingEvidence.length);
    // Items are grouped under the claim they belong to.
    await expect(list.locator("h3.subhead").first()).toBeVisible();
    const first = detail.missingEvidence[0]!;
    const draft = first.draft;
    // The draft is specific to the use: it carries the case's own product and setting words.
    const firstLine = norm(draft.split("\n").find((l) => l.trim().length > 20) ?? "").slice(0, 40);
    await expect(list.locator(".draft").first()).toContainText(firstLine);
    await list.locator(".missing-item").first().getByRole("button", { name: /Copy draft/ }).click();
    await expect(page.getByTestId("announcer")).toContainText("copied to the clipboard");
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied.split(String.fromCharCode(13)).join("").trim()).toBe(draft.trim());
    await expect(page.getByText("Sakaime never sends anything").first()).toBeVisible();
    w.assertClean();
  });
});

test.describe("resilience drills", () => {
  test("every drill runs, the invariants hold, and a lost source never reads as supported or as none exist", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    const id = detail.summary.id;
    const drill = async (body: object) => {
      const r = await request.post(`/api/cases/${enc(id)}/drill`, { data: body });
      expect(r.status(), JSON.stringify(body)).toBe(200);
      return (await r.json()) as { narrative: string; staleFindingIds: string[]; before: { label: string }[]; after: { label: string; degraded: { reason: string }[] }[] };
    };
    await page.goto(`/cases/${enc(id)}/drills`);
    await ready(page);
    await expect(page.getByText("No drill run yet")).toBeVisible();
    await page.getByTestId("run-all").click();
    const summary = page.getByTestId("drill-summary");
    await expect(summary.locator("tbody tr")).toHaveCount(7, { timeout: 60_000 });
    await expect(summary.locator('tbody tr[data-held="true"]')).toHaveCount(7);

    // Source off: the screen shows the service's own narrative and the answer it computed.
    const off = await drill({ drill: "source_off", target: "study" });
    await page.locator('[data-run="source_off"]').click();
    const res = page.getByTestId("drill-result");
    await expect(res).toHaveAttribute("data-drill", "source_off");
    await expect(res.getByTestId("drill-narrative")).toContainText(norm(off.narrative).slice(0, 60));
    await expect(res.locator(".label-badge").nth(1)).toHaveAttribute("data-label", off.after[0]!.label);
    await expect(res.getByTestId("drill-degraded").first()).toBeVisible();
    await expect(res.locator('[data-check="no-rise"]')).toHaveAttribute("data-ok", "true");
    // An outage and an empty answer read differently.
    const empty = await drill({ drill: "source_empty", target: "study" });
    expect(off.after[0]!.degraded[0]!.reason).not.toBe(empty.after[0]!.degraded[0]!.reason);
    await shot(page, "flow-drill-source-off", "light", 1440);

    // A registry change marks only the dependent findings out of date.
    const reg = await drill({ drill: "registry_changed" });
    await page.locator('[data-run="registry_changed"]').click();
    if (reg.staleFindingIds.length > 0) await expect(page.getByTestId("stale-ids").locator("li")).toHaveCount(reg.staleFindingIds.length);
    else await expect(page.getByTestId("stale-none")).toBeVisible();
    // The model off does not move a label.
    await page.locator('[data-run="model_off"]').click();
    await expect(page.getByTestId("drill-result").locator('[data-check="same"]')).toHaveAttribute("data-ok", "true");
    // A document that gives orders does not work.
    const inj = await drill({ drill: "injection_in_document" });
    await page.locator('[data-run="injection_in_document"]').click();
    await expect(page.getByTestId("drill-narrative")).toContainText(norm(inj.narrative).slice(0, 60));
    w.assertClean();
  });

  test("a drill with a bad target is refused by the service with a plain reason", async ({ request }) => {
    const detail = await primaryCase(request);
    const url = `/api/cases/${enc(detail.summary.id)}/drill`;
    const r = await request.post(url, { data: { drill: "source_off", target: "nonsense" } });
    expect(r.status()).toBe(400);
    expect((await r.json()).error.message).toMatch(/nonsense/);
    // No target: the service either refuses or says which default it used; it never answers silently with nothing.
    const r2 = await request.post(url, { data: { drill: "source_off" } });
    if (r2.status() === 200) expect(((await r2.json()) as { narrative: string }).narrative.length).toBeGreaterThan(20);
    else expect(r2.status()).toBe(400);
    const r3 = await request.post(url, { data: { drill: "bogus" } });
    expect(r3.status()).toBe(400);
  });
});

test.describe("investigation", () => {
  test("the stream is a readable timeline of role decisions with query ids, and the trace downloads", async ({ page, request }) => {
    const w = watch(page);
    const detail = await primaryCase(request);
    await page.goto(`/cases/${enc(detail.summary.id)}/investigation`);
    await ready(page);
    await expect(page.getByText("No run yet")).toBeVisible();
    await page.getByTestId("start-run").click();
    await expect(page.getByTestId("trace-status")).toContainText("Streaming");
    await expect(page.getByTestId("trace-status")).toContainText("Finished", { timeout: 60_000 });
    const trace = page.getByTestId("trace");
    const n = await trace.locator(".trace-item").count();
    const href = await page.getByTestId("trace-download").getAttribute("href");
    const body = await (await request.get(href!)).text();
    const events = body.trim().split("\n").map((l) => JSON.parse(l) as { role: string; decision: string; federation?: unknown });
    // The screen shows exactly the recorded events, and every role that spoke appears.
    expect(events.length).toBe(n);
    for (const role of new Set(events.map((e) => e.role))) await expect(trace.locator(`[data-role="${role}"]`).first()).toBeVisible();
    for (const e of events.filter((x) => x.federation)) await expect(trace.getByText(norm(e.decision).slice(0, 40), { exact: false }).first()).toBeVisible();
    if (events.some((e) => e.federation)) await expect(trace.locator("[data-role]").filter({ hasText: "Query" }).first()).toBeVisible();
    await shot(page, "flow-investigation", "light", 1440);
    w.assertClean();
  });
});

test.describe("dossier", () => {
  test("export, verify, and a one-character change is caught with the failing item named", async ({ page, request }) => {
    const w = watch(page);
    const detail = await quietCase(request);
    await page.goto(`/cases/${enc(detail.summary.id)}/dossier`);
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
    await expect(out.getByTestId("tamper-change")).toContainText(/body\.(anchors|snapshots|claims)\[\d+\]\.text/);
    await expect(out.getByTestId("verify-failures")).toContainText("anchors/");
    await expect(out.getByTestId("verify-failures")).toContainText(/hash mismatch|hash/);
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
      // Either a verdict of "not ok" or a plain refusal of the shape; never a pass.
      if (r.status() === 200) expect((await r.json()).ok).toBe(false);
      else expect(r.status()).toBe(400);
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
    // The question example names the first case, which the Guard page reads from the service; let that read finish first.
    await page.waitForLoadState("networkidle");
    await page.locator('[data-example="question"]').click();
    await expect(page.locator("#guard-text")).toHaveValue(/^For K\d{6}, is the claim/);
    await page.getByRole("button", { name: "Check the text" }).click();
    await expect(page.getByTestId("guard-result")).toHaveAttribute("data-allowed", "true");
    await page.locator('[data-example="phi"]').click();
    await page.getByRole("button", { name: "Check the text" }).click();
    await expect(page.getByTestId("guard-result")).toHaveAttribute("data-allowed", "false");
    await expect(page.getByTestId("guard-findings")).toContainText("patient identifiers do not enter Sakaime");
    await page.locator('[data-example="export"]').click();
    await page.getByRole("button", { name: "Check the text" }).click();
    await expect(page.getByTestId("guard-result")).toHaveAttribute("data-allowed", "false");
    // The service words the refusal itself; the screen must carry it, whatever it says.
    await expect(page.getByTestId("guard-message")).not.toBeEmpty();
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
    const res = await request.get("/results.json");
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toContain("application/json");
    const file = await res.json();
    await page.goto("/about");
    await ready(page);
    const results = page.getByTestId("results");
    const measured = file.rows.filter((r: { status: string }) => r.status === "measured");
    const planned = file.rows.filter((r: { status: string }) => r.status === "to_be_measured");
    expect(measured.length).toBeGreaterThan(5);
    expect(planned.length).toBeGreaterThan(0);
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
  test("no screen says safe, cleared, compliant, approved, guaranteed, proof, accurate, best or production-ready", async ({ page, request }) => {
    const detail = await primaryCase(request);
    const c = enc(detail.summary.id);
    const banned = /\b(safe|safely|cleared|compliant|approved|guaranteed?|proofs?|accurate|accuracy|best|production-ready|state-of-the-art)\b/i;
    const paths = ["/", "/sources", "/cases", `/cases/${c}`, `/cases/${c}/matrix`, `/cases/${c}/claims`, `/cases/${c}/lab`, `/cases/${c}/timeline`, `/cases/${c}/investigation`, `/cases/${c}/drills`, `/cases/${c}/dossier`, "/guard", "/about"];
    // Every screen is read before the verdict, so one hit does not hide the others.
    const hits: string[] = [];
    for (const p of paths) {
      await page.goto(p);
      await ready(page);
      // Quoted passages from regulator documents, the constructed claim, the machine's SQL, and the compared values (they quote the
      // records) are data, not our copy.
      const text = await page.evaluate(() => {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone.querySelectorAll(".anchor__quote, .claim-quote, .strip__quote, .code-block, .matrix td, .draft, .guard-text, .guard-span, .sidebyside, script, style").forEach((n) => n.remove());
        return clone.innerText;
      });
      const all = new RegExp(banned.source, "gi");
      for (const m of text.matchAll(all)) hits.push(`${p}: "${m[0]}" near: ${text.slice(Math.max(0, m.index - 70), m.index + 50).replace(/s+/g, " ")}`);
    }
    expect(hits, "banned words in copy").toEqual([]);
  });

  test("the five labels read as plain words and the exact token is available to screen readers and on hover", async ({ page }) => {
    await page.goto("/");
    await ready(page);
    const list = page.locator(".label-list");
    for (const [token, words] of Object.entries(LABEL_WORDS)) {
      const badge = list.locator(`[data-label="${token}"]`);
      await expect(badge).toContainText(words);
      await expect(badge).toHaveAttribute("title", new RegExp(`^${token}:`));
      await expect(badge.locator(".sr-only")).toHaveText(new RegExp(token));
    }
  });
});
