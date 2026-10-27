// Slides 21 to 28: failure behaviour, the dossier, the sponsors, and safety.
import { grab, grabInt, json, text, stat, mdTable } from "../lib/data.mjs";
import { esc, labelBadge, relBadge, chip, card, pts, tbl, shot, icon, stat as statBlock } from "../lib/ui.mjs";
import { derive, ask } from "../lib/ctx.mjs";
import { hbars } from "../lib/charts.mjs";

const head = (kicker, title, lead = "") => `<div class="kicker">${kicker}</div><h2>${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}`;
const GATES = "infra/zetaris/GATES.md";
const REFL = "docs/zetaris-usl-reflection.md";
const ABL = "tests/engines/ABLATIONS.md";
const MA3 = "tests/engines/markovian/MA3-RESULTS.md";
const SCOUT = "tests/engines/scout/RESULTS.md";
const DISC = "data/discovery-shift/RESULTS.md";
const fail = "evals/results/failureshift.json";

const verdict = (v) => {
  if (/^PASS/.test(v)) return `<span class="lab sm ${/with|limits/.test(v) ? "partial" : "good"} wrap">${icon("check")}<span>${v.toLowerCase().replace("pass", "Pass")}</span></span>`;
  if (/BLOCKED/.test(v)) return `<span class="lab sm bad wrap">${icon("cross")}<span>Blocked</span></span>`;
  return `<span class="lab sm wrap">${v}</span>`;
};

export const part4 = [
  // ------------------------------------------------------------------ 21
  {
    id: "drills",
    section: "Failure behaviour",
    crit: "Technical 20",
    sources: [fail, "output_examples/api/drill-source-off-study.json", GATES, "src/api/contract.ts"],
    cls: "consistency: faults injected through the real ports",
    notes: `Reliability is shown by breaking things on purpose. There are seven drills, each run through the real code on the recorded evidence: a named source goes off, a named source answers with nothing, the federation engine stops, a federated result comes back truncated, the model route fails, a registry record changes after a finding, and a vendor document tells the system to mark the claim supported. The invariant is the same every time: a lost required source never produces a supported label, only the findings that relied on a changed fact go stale, a model that is off changes no label, and an instruction inside a document changes no label. 157 of 157 scripted drills end in the correct state, including stopping the real Zetaris API container, which the port reports as unavailable within milliseconds and which is answering again about 15 seconds after restart. This is a consistency result: the expected states come from the same builder. Not covered: the Nightshift route and the local lane were not faulted, and concurrent users were not tried.`,
    html: () => {
      const cat = (k) => stat(fail, `byCategory.${k}`);
      const tot = stat(fail, "correctState");
      const z = json(fail).summaries.zetarisStopped.timeline;
      const drills = [
        ["source_off", "A named source becomes UNAVAILABLE"],
        ["source_empty", "A named source answers with no rows"],
        ["zetaris_off", "The federation engine is stopped"],
        ["truncated_result", "A federated result comes back cut short"],
        ["model_off", "The model route fails"],
        ["registry_changed", "A registry record changes after a finding"],
        ["injection_in_document", "A vendor document orders the system to mark a claim supported"],
      ];
      const bars = hbars({
        rows: [["Source states", "source states"], ["Federation port", "federation port"], ["Model faults", "model faults"], ["SSRF", "SSRF"], ["Document injection", "injection"]].map(([l, k]) => ({ label: l, value: cat(k).k / cat(k).n, text: `${cat(k).k}/${cat(k).n}`, tone: "green" })),
        max: 1, width: 760, labelW: 270, textW: 120, barH: 28, gap: 12, fontSize: 22,
      });
      return `
      ${head("Failure behaviour", "Seven drills. None turns a loss into support.")}
      <div class="row" style="gap:44px; margin-top:22px; flex:1; min-height:0">
        <div style="width:780px; flex:none">
          ${drills.map(([a, b]) => `<div style="border-top:2px solid var(--line); padding:8px 0; display:flex; gap:16px; align-items:baseline"><span class="mono b green" style="font-size:20px; width:250px; flex:none">${a}</span><span style="font-size:24px; line-height:1.25">${b}</span></div>`).join("")}
          <div class="card ink" style="margin-top:14px; padding:14px 22px"><div class="tag" style="color:var(--paper-3)">The invariant that must hold</div><p style="font-size:24px; line-height:1.3; margin-top:4px">A lost required source never yields a supported label. Only findings that relied on a changed fact go stale. A model that is off, or an order hidden in a document, changes no label.</p></div>
        </div>
        <div class="grow col" style="gap:12px">
          <div class="b" style="font-size:27px">${tot.k} of ${tot.n} drills ended in the correct state</div>
          ${bars}
          <div class="card soft" style="padding:14px 22px"><p style="font-size:23px; line-height:1.3">Real Zetaris API container stopped: the port reported <b>UNAVAILABLE after ${z.msToFailure} ms</b> and, with the API up, the same port reports FORBIDDEN, so the two are never confused. The stack answered again <b>${z.restoredAfterMs.toLocaleString("en-US")} ms</b> after restart.</p></div>
          <p class="xs ink-3">Not covered: the Nightshift route and the local lane were not faulted; concurrent users were not tried.</p>
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 22
  {
    id: "dossier",
    section: "The signed dossier",
    sources: ["docs/02-architecture.md", "output_examples/dossiers/eyeart-k200667.dossier.json", "docs/05-requirements-matrix.md"],
    derived: [],
    cls: "integrity, not truth; demo key",
    notes: `The output is a dossier: one signed bundle holding the claim, the intended use, every finding with its smallest mismatch and requirements, the source snapshots with their hashes, the Zetaris query ids and result hashes, the model receipts, the rule version and the reviewer decisions. An offline verifier recomputes every hash and runs the compiler again on the recorded inputs, and any mismatch fails with a named reason. The tamper test on the right: export, verify, change one character, and the verifier names the failing item. Be exact about what the signature means: it shows the bundle has not changed since the holder of the key signed it. It does not show that any finding is clinically correct, and this is a demo key that does not identify a signer.`,
    html: () => {
      const d = json("output_examples/dossiers/eyeart-k200667.dossier.json");
      const items = [
        ["Findings", d.body.findings.length, "with smallest mismatch and requests"],
        ["Anchors", d.body.anchors.length, "quoted passages, page and region"],
        ["Source snapshots", d.body.snapshots.length, "content and request hashes"],
        ["Federation statements", d.body.federation.length, "query id and result hash"],
        ["Model replies", d.body.models.length, "each with its receipt"],
        ["Lineage events", d.body.lineage.length, "run, job and dataset facets"],
      ];
      items.forEach(([n, v]) => derive(v, `${n} in the EyeArt dossier`));
      return `
      ${head("The signed dossier", "Sign the run. One changed character fails it.")}
      <div class="row" style="gap:44px; margin-top:24px; flex:1; min-height:0">
        <div style="width:640px; flex:none; display:flex; flex-direction:column; gap:12px">
          <div class="tag">The EyeArt dossier holds</div>
          <div style="display:grid; grid-template-columns:1fr 1fr; gap:10px 18px">
          ${items.map(([n, v, w]) => `<div style="border-top:3px solid var(--ink); padding:6px 0"><span class="mono b" style="font-size:42px">${v}</span><div class="b" style="font-size:23px">${n}</div><div class="ink-2" style="font-size:19px; line-height:1.2">${w}</div></div>`).join("")}
          </div>
          <div class="card ink" style="padding:14px 20px"><div class="tag" style="color:var(--paper-3)">What the signature means</div><p style="font-size:22px; line-height:1.3; margin-top:4px">The bundle has not changed since the key holder signed it. It does not show that any finding is clinically correct. A demo key does not identify a signer.</p></div>
        </div>
        <div class="grow">${shot("dossier-tamper.png", "/cases/eyeart-k200667/dossier", "Export, verify, then change one character: the verifier names the failing item.", { h: 590, top: 330, left: 380, zoom: 175 })}</div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 23
  {
    id: "sponsors",
    section: "Sponsor requirements",
    crit: "Sponsor Tech 10",
    sources: ["research/hackathon/organizer/01-welcome-guide.md", "docs/11-channel-intel.md", "docs/05-requirements-matrix.md", "output_examples/model-route.json", "metadata.json"],
    cls: "each row: code path and evidence",
    notes: `Sponsor technology, row by row, in the organizers' own requirements, with the code path and the evidence for each. Zetaris is the data layer: one federated statement, policies, a Unified Semantic Layer and data-quality rules, on a real 2.4.3.1 stack; the natural-language route does not exist in the local build and is marked not done. Meterless: four engines in working features, conformance passing against the sponsor's runners; Scout's held-out result is weak and the slide says so. Nightshift is the primary provider for the recorded run: 61 of 61 recorded model replies carry a signed receipt that re-verifies; the live fallback path was exercised against test doubles only. NVIDIA Nemotron fills seven roles. Cursor: the organizers' text says required while moderators said optional; we did not use it, and the slide says that rather than leaving it out. Bright Data is for the bounty only and is not applicable.`,
    html: () => {
      const route = json("output_examples/model-route.json");
      const conf = grab("metadata.json", /H-MEM (13)\/13/);
      const wm = grab("metadata.json", /World Model (8)\/8/);
      const mk = grab("metadata.json", /Markovian (8)\/8/);
      const z = (cls, t) => `<span class="lab sm ${cls} wrap">${icon(cls === "bad" ? "cross" : cls === "partial" ? "check-partial" : "check")}<span>${t}</span></span>`;
      const rows = [
        ["Zetaris", "The data layer", "One federated SQL over three silo types; four access identities; a Unified Semantic Layer with 7 data-quality rules", "src/federation/ src/discovery/ infra/zetaris/", `${derive(mdTable(GATES, /^## Summary/).slice(1).filter((r) => /^PASS/.test(r[1])).length, "gates marked PASS in GATES.md")} gates pass; natural-language route blocked`, z("partial", "Working; one route not done")],
        ["Meterless", "One engine in a working feature", "World Model marks dependent findings stale; H-MEM keeps confirmed links; Markovian reads long documents; Scout guards requests", "src/engines/ third_party/meterless/", `Sponsor runners: H-MEM ${conf}/${conf}, World Model ${wm}/${wm}, Markovian ${mk}/${mk}`, z("partial", "Working; Scout weak on new wording")],
        ["Nightshift", "The primary AI provider", "Every recorded model reply came through Nightshift with a signed receipt", "src/models/nightshift.ts src/models/stack.ts", `${route.recordings.receiptReverified} of ${route.recordings.total} receipts re-verified`, z("partial", "Working; live fallback tested on doubles")],
        ["NVIDIA Nemotron", "The model the product runs on", "Seven roles: Lightning 30B for volume, Ultra 550B for resolver and critic", "src/models/roles.ts", "output_examples/model-route.json", z("good", "Working")],
        ["Cursor", "Dev environment (optional per moderators)", "Not used. Claude Code was the coding assistant", "none", "README.md, docs/provenance.md", z("bad", "Not used")],
        ["Bright Data", "Only for the bounty track", "Not applicable: primary track is Track 1", "none", "none", z("partial", "Not applicable")],
      ];
      return `
      ${head("Sponsor requirements", "Each requirement, its code path, its evidence.")}
      ${ask("How effectively does the solution use the sponsors' technology to address the problem and enhance the overall product?", "Sponsor Tech, 10 points")}
      <div style="margin-top:14px">${tbl(["Sponsor", "Organizers ask", "What it does here", "Code", "Evidence", "State"], rows.map((r) => [`<b>${r[0]}</b>`, r[1], r[2], `<span class="mono" style="font-size:18px">${r[3]}</span>`, r[4], r[5]]), "tiny")}</div>`;
    },
  },

  // ------------------------------------------------------------------ 24
  {
    id: "zetaris-1",
    section: "Zetaris (1 of 2): federation, policies, gates",
    crit: "Sponsor Tech 10",
    sources: [GATES, DISC, "output_examples/api/drill-zetaris-off.json"],
    cls: "real 2.4.3.1 stack, Docker, 2026-10-27; sample mode replays recordings",
    notes: `Zetaris is the data layer and it does real work. One statement over a Postgres hospital database, registry snapshot files and vendor files returned 20 rows in under a second on the real engine, identical cell by cell to an independent DuckDB run, and the comparison itself was checked: a changed cell and a missing row are both detected. Four identities see different columns for the same statement, and no confidential value reached the agent identity in 23 responses. It changes outputs: with the federation engine stopped every required finding becomes not enough evidence; and with the catalog-driven cross-source checks switched off, 16 of 48 mappable layouts are held for lack of corroboration and 4 layouts that must not register are registered. We also found defects and report them: Hide on a file-store table leaks the hidden value under the neighbouring column name; a datasource refresh deletes every policy on that source. Natural-language-to-SQL does not exist in this build: three routes were tried and are written down.`,
    html: () => {
      const rows = mdTable(GATES, /^## Summary/).slice(1);
      const g = Object.fromEntries(rows.map((r) => [r[0].replace(/ \(.*/, ""), r]));
      const need = ["Z-HEAD", "Z-REST", "Z-POL", "Z-CAT", "Z-AUD", "Z-TT", "Z-USL", "Z-PDF", "Z-NL", "Kill drill"];
      const short = {
        "Z-HEAD": "One statement over three silos: 20 rows, equal to DuckDB cell by cell",
        "Z-REST": "REST table over openFDA and ClinicalTrials.gov equals a direct call",
        "Z-POL": "Four identities, four views; no confidential value reached the agent",
        "Z-CAT": "Tags, schema drift visible through the catalog",
        "Z-AUD": "Audit log lists 9 of 9 request ids; no SQL text",
        "Z-TT": "VERSION AS OF returns the earlier registry state (Iceberg only)",
        "Z-USL": "Six-table layer compiled and queried as a read-only identity",
        "Z-PDF": "FORMAT PDF text for three FDA summaries",
        "Z-NL": "No natural-language-to-SQL service in the local build; three routes tried",
        "Kill drill": "API stopped: UNAVAILABLE in milliseconds; engine restarts alone",
      };
      const body = need.map((k) => {
        const r = g[k];
        if (!r) throw new Error(`gate ${k} missing from GATES.md`);
        return [`<span class="mono b" style="font-size:21px">${k}</span>`, verdict(r[1]), `<span style="font-size:22px">${short[k]}</span>`];
      });
      const nj = DISC && text(DISC).match(/\| nojoin \(run2\) \| \d+\/\d+ = [^|]+\| (\d+) \/ \d+ \/ \d+ \| \d+\/\d+ = [^|]+\| (\d+) \(/);
      const held = nj[1], reg = nj[2];
      const leak = grab(GATES, /none of (12) confidential values/);
      const resp = grab(GATES, /in the (23) responses the agent identity received/);
      const stmts = grab(GATES, /made (115) SQL statements/);
      return `
      ${head("Zetaris (1 of 2)", "The data layer: federation, policies, and what broke.")}
      <div class="row" style="gap:40px; margin-top:20px; flex:1; min-height:0">
        <div style="flex:1.35; min-width:0">${tbl(["Gate", "Result", "What the evidence shows"], body, "tiny")}<p class="xs ink-3 mt-s">${stmts} SQL statements in the full run. Not run: Linux, macOS, concurrent users, Zetaris Cloud.</p></div>
        <div class="col" style="flex:1; gap:14px; min-width:0">
          ${card(`<div class="tag green">Where it changes an output</div>${pts([`Engine stopped: every required finding becomes not enough evidence`, `Cross-source checks off: ${held} of 48 mappable layouts held, ${reg} that must not register registered`, `Four identities see different columns; ${leak} confidential values never reached the agent in ${resp} responses`], "g")}`, "green")}
          ${card(`<div class="tag rust">Defects we found and report</div>${pts(["Hide on a file-store table leaks the value under the next column's name", "A datasource refresh deletes every policy on that source", "A non-admin needs a REST call with no SQL form to read a USL"], "r")}`, "rust")}
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 25
  {
    id: "zetaris-2",
    section: "Zetaris (2 of 2): Unified Semantic Layer",
    crit: "Sponsor Tech 10",
    sources: [REFL, "docs/05-requirements-matrix.md"],
    cls: "one machine, one question; ratios are not a benchmark",
    notes: `The Zetaris judging core: onboard and query sources, build a Unified Semantic Layer and query it, add a data-quality rule, and reflect on how it saved time, how it helps and what could be better. The layer unifies ten tables and 89 columns across the three silos under the reviewer's own words, and is queried by the product as a read-only identity. We measured the same question three ways, nine timed rounds. Seven plain reads joined in code: 294 milliseconds. One hand-written federated statement: 861. One read of the layer: 1,189. The layer turned seven statements and 48 lines of join code into one statement and four lines, and it did not save run time: it is the slowest arm. Engineering time was not measured and no hours-saved figure is claimed. The data-quality rules caught a true problem: 143 of 157 registry records are search summaries with no eligibility block, so unknown is never read as covered. A deliberate truncation, 110 records cut to 39, failed the completeness rule and blocked that collection from feeding anything.`,
    html: () => {
      const arms = mdTable(REFL, /^## What it saved/).slice(1);
      const ms = (c) => Number(c.match(/([\d,]+) ms/)[1].replace(/,/g, ""));
      const rows = arms.map((r) => ({ name: r[0], stm: r[1], ms: ms(r[2]), code: r[4] }));
      const dq = mdTable(REFL, /^## Data-quality rules/).slice(1);
      const tables = grabInt(REFL, /ten tables, (\d+) columns/, "columns");
      const trunc = grab(REFL, /cut from (110) records to 39/);
      const bars = hbars({
        rows: [
          { label: "Seven reads, joined in code", value: rows[0].ms, text: `${rows[0].ms.toLocaleString("en-US")} ms`, tone: "grey" },
          { label: "One hand-written statement", value: rows[1].ms, text: `${rows[1].ms.toLocaleString("en-US")} ms`, tone: "grey" },
          { label: "One read of the layer", value: rows[2].ms, text: `${rows[2].ms.toLocaleString("en-US")} ms`, tone: "rust", bold: true },
        ],
        max: 1300, width: 820, labelW: 340, textW: 150, barH: 36, gap: 16, fontSize: 23,
      });
      return `
      ${head("Zetaris (2 of 2)", "The layer saved no run time. It saved code.")}
      <div class="row" style="gap:44px; margin-top:20px; flex:1; min-height:0">
        <div style="flex:1; min-width:0">
          <div class="b" style="font-size:26px; margin-bottom:8px">Same question, same 28 rows, median of nine rounds</div>
          ${bars}
          <div class="g3 mt-s" style="gap:14px">
            ${rows.map((r) => `<div class="card soft" style="padding:12px 16px"><div class="b" style="font-size:22px; line-height:1.15">${esc(r.name)}</div><div class="mono b" style="font-size:30px; margin-top:4px">${r.stm}</div><div class="xs ink-2">statements sent</div><div class="xs" style="margin-top:4px">${esc(r.code.replace(/, plus seven statements/, ""))}</div></div>`).join("")}
          </div>
          <p class="sm ink-2 mt-s">Ten tables, ${tables} columns, queried as a read-only identity. Engineering hours were not measured and no hours-saved figure is claimed.</p>
        </div>
        <div style="flex:1; min-width:0">
          <div class="b" style="font-size:26px; margin-bottom:6px">Seven data-quality rules, run with RUN DQ</div>
          ${tbl(["Rule", ">Fails on the recorded stack"], dq.map((r) => [`<span class="mono" style="font-size:19px">${r[0].replace(/`/g, "")}</span>`, `<span style="font-size:21px">${r[2].replace(/\*\*/g, "")}</span>`]), "tight")}
          <p class="xs ink-2 mt-s">The 143 failures are real: search summaries with no eligibility block. A deliberate truncation, ${trunc} records cut to 39, failed the completeness rule and blocked that collection.</p>
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 26
  {
    id: "meterless",
    section: "Meterless: four engines",
    crit: "Sponsor Tech 10",
    sources: [ABL, MA3, SCOUT, "metadata.json", "evals/results/timeshift.json"],
    cls: "ablations on constructed inputs; null and by-construction results marked",
    notes: `Four Meterless engines, each with a role in a working feature and a pre-registered ablation. Read the tags, because several results are by construction or weak, and the slide says which. H-MEM keeps reviewer-confirmed links, accepted mappings and precedents. On a constructed ten-case session, memory removed about half the repeated questions, from 22 to 10, but answered 4 questions with the answer to a different question, all identity links between similar-looking products; an identifier guard removes that hazard at the cost of one avoided question. Scoping by hospital means no hospital got the other's records; without it, 9 questions were answered from another hospital's records. The World Model marks only dependent findings stale: 9 recomputed instead of 36, none missed; the no-engine arm is zero flags by construction. Markovian reads a 40-page document in chunks: with the ids carryover it found the planted restriction in 3 of 4 documents against 2 of 4 for one full-length prompt, but only 4 documents were used, so one document is not evidence. Scout guards requests: 18 of 126 attacks got through against 105 of 126 without the injection layer, but on injection wording written after the rules were frozen, recall is 9 of 24 with rules alone, and the model classifier that raises it is off in the product.`,
    html: () => {
      const conf = (n) => grab("metadata.json", new RegExp(`${n} (\\d+)/`));
      const nomem = grab(ABL, /\| No memory \| 34 \| \*\*(22)\*\*/);
      const scoped = grab(ABL, /\| H-MEM, scoped to the hospital \| \d+ \| \*\*(\d+)\*\* \| \d+ \| \d+ \| \*\*(\d+)\*\*/);
      const wrong = grab(ABL, /\| H-MEM, scoped to the hospital \| \d+ \| \*\*\d+\*\* \| \d+ \| \d+ \| \*\*(\d+)\*\*/);
      const leak = grab(ABL, /\| H-MEM, not scoped \(control, not a product configuration\) \| \d+ \| \d+ \| \d+ \| \d+ \| \*\*\d+\*\* \| \*\*(\d+)\*\*/);
      const wmN = grab(ABL, /\| World Model present \| (\d+) \|/);
      const wmF = grab(ABL, /\| World Model present \| \d+ \| \d+ \| (\d+) \|/);
      const wmAbs = grab(ABL, /\| World Model absent \| \d+ \| \d+ \| 0 \| \*\*(\d+)\*\*/);
      const ma = (arm) => grab(MA3, new RegExp(`\\| ${arm} \\| (\\d/4)`));
      const through = grab(SCOUT, /\| full \| 14\.3% \((\d+\/126)/);
      const throughOff = grab(SCOUT, /\| no-injection-layer \| 83\.3% \((\d+\/126)/);
      const held = grab(SCOUT, /Injection recall \| 37\.5% \((\d+\/24)/);
      const tag = (t, k = "") => `<span class="chip ${k}" style="font-size:19px">${t}</span>`;
      const eng = (name, role, lines, tags) => card(`<div style="display:flex; justify-content:space-between; align-items:baseline"><h3 style="font-size:34px">${name}</h3><span class="mono green b" style="font-size:20px">${tags[0]}</span></div><p class="ink-2" style="font-size:22px; margin:4px 0 10px; line-height:1.28">${role}</p>${pts(lines.map((l) => `<span style="font-size:22px; line-height:1.28">${l}</span>`))}<div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap">${tags.slice(1).join("")}</div>`);
      return `
      ${head("Meterless: four engines", "Each engine has a role, a result, and a caveat.")}
      <div class="g2" style="margin-top:20px; gap:26px; flex:1; align-items:stretch; min-height:0">
        ${eng("H-MEM", "Keeps reviewer-confirmed links, accepted mappings and precedents.", [`Repeated questions asked: ${nomem} with no memory, ${scoped} with scoped memory`, `Wrong record reused: ${wrong} without an identifier guard, 0 with it`, `Unscoped control: ${leak} answers from the other hospital's records`], [`conformance ${conf("H-MEM")}/${conf("H-MEM")}`, tag("constructed session, 34 questions", "dash"), tag("no interval", "dash")])}
        ${eng("World Model", "Bi-temporal facts; marks exactly the dependent findings stale.", [`${wmF} findings recomputed instead of ${wmN}, none missed`, `No-engine arm: ${wmAbs} stale unflagged, by construction`, `TimeShift: stale set equals dependent set in 27 of 27`], [`conformance ${conf("World Model")}/${conf("World Model")}`, tag("by construction in part", "dash"), tag("constructed session", "dash")])}
        ${eng("Markovian", "Reads long documents in bounded chunks with a carried-over ledger.", [`Planted restriction found: ${ma("markovian_ids")} (ids carryover), ${ma("single_full")} (one full-length prompt), ${ma("single_truncated")} (truncated prompt)`, `Values carryover: ${grab(MA3, /\| markovian \| (\d\/4)/)}`, "40-page constructed documents; four of them"], [`conformance ${conf("Markovian")}/${conf("Markovian")}`, tag("one document is not evidence", "dash")])}
        ${eng("Scout Intent", "Guards every request and document-derived instruction; signs export contracts.", [`Attacks through: ${through} against ${throughOff} with no injection layer`, `Wording written after the rules froze: recall ${held} with rules alone`, "Model classifier measured; off in the product"], ["32-example harness exits 0", tag("held-out gates not met", "rust")])}
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 27
  {
    id: "nemotron",
    section: "NVIDIA Nemotron, through Nightshift",
    crit: "Sponsor Tech 10",
    sources: ["src/models/roles.ts", "output_examples/model-route.json", "README.md", "docs/05-requirements-matrix.md"],
    derived: [],
    cls: "recorded replies; receipts show routing, not truth",
    notes: `Nemotron proposes; it does not decide. Seven roles, two models: Lightning 30B for the high-volume roles, Ultra 550B for identity adjudication and for the critic, which is deliberately a stronger and different model than the one that drafted. Nightshift is the primary route. All 61 recorded model replies of the committed run were answered through Nightshift and carry a signed compute receipt, and all 61 re-verify at start-up against a pinned key id. 29 were answered by Ultra and 32 by Lightning. The replayed run has every reply receipted: 14 of 14 for EyeArt, 23 of 23 each for Lunit and Transpara. Be exact about what a receipt shows: where a reply was routed and which model answered, not that it is true, and it carries no hash of the reply text. NVIDIA's own API answers only if Nightshift is unreachable or a receipt fails, and then the reply is labelled and unreceipted. The generic comparison arms called Lightning through NVIDIA's API directly, not through Nightshift.`,
    html: () => {
      const rs = text("src/models/roles.ts");
      const re = /\{ role: "(\w+)", model: (NEMOTRON_\w+), fallbacks: \[(NEMOTRON_\w+)\][^}]*?rationale: "([^"]+)" \}/g;
      const roles = [...rs.matchAll(re)].map((m) => ({ role: m[1], model: m[2], fb: m[3], why: m[4] }));
      if (roles.length !== 7) throw new Error(`expected 7 roles, found ${roles.length}`);
      const name = (k) => (k === "NEMOTRON_ULTRA" ? "Ultra 550B" : "Lightning 30B");
      const route = json("output_examples/model-route.json");
      const R = route.recordings;
      const ult = route.modelsThatAnswered["nvidia/nemotron-3-ultra-550b-a55b"], lig = route.modelsThatAnswered["nvidia/nemotron-3.5-lightning-30b-a3b"];
      return `
      ${head("NVIDIA Nemotron, through Nightshift", "Seven roles propose. Every reply is receipted.")}
      <div class="row" style="gap:40px; margin-top:20px; flex:1; min-height:0">
        <div style="flex:1.45; min-width:0">${tbl(["Role", "Model", "Why"], roles.map((r) => [`<span class="b">${r.role.replace("_", " ")}</span>`, `<span class="chip ${r.model === "NEMOTRON_ULTRA" ? "green" : ""}" style="font-size:20px">${name(r.model)}</span>`, `<span style="font-size:21px; line-height:1.25">${r.why}</span>`]), "tight")}</div>
        <div class="col" style="flex:1; gap:14px; min-width:0">
          <div class="row" style="gap:30px">
            ${statBlock(`${R.receiptReverified} of ${R.total}`, "recorded replies with a signed Nightshift receipt, re-verified", { size: "md", tone: "green" })}
          </div>
          <div class="card soft" style="padding:14px 20px"><div class="tag">Answered by</div><p style="font-size:24px; margin-top:4px">Ultra 550B: <b>${ult}</b> &nbsp; Lightning 30B: <b>${lig}</b></p><div class="tag mt-s">Replayed run, replies receipted</div>
          <p style="font-size:23px; margin-top:4px">${route.replayedRun.map((c) => `${c.caseId.split("-")[0]} <b>${c.receiptedAndReverified} of ${c.modelReplies}</b>`).join(" &middot; ")}</p></div>
          ${card(`<div class="tag rust">What a receipt does not show</div><p style="font-size:22px; line-height:1.3; margin-top:4px">Where a reply was routed and which model answered, not that it is true. It carries no hash of the reply. NVIDIA's own API answers only if Nightshift is unreachable, and then the reply is labelled unreceipted. The comparison arms called Lightning through NVIDIA directly.</p>`, "rust")}
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 28
  {
    id: "safety",
    section: "Safety and security",
    sources: [SCOUT, "evals/results/failureshift.json", "docs/02-architecture.md", "infra/zetaris/GATES.md", "docs/DECISIONS.md"],
    cls: "guard figures are for rules alone, as the product runs it",
    notes: `Safety and security, with the weak number shown. Source fetching is allowlist-first and SSRF-safe: https and GET only, resolved addresses checked against private, loopback, link-local and cloud-metadata ranges, DNS pinned, every redirect re-checked, size and time capped; 21 of 21 SSRF drills end correctly. All fetched text is data and never enters the instruction channel; a vendor document that gives orders is held back and the exact words are set aside. The guard's honest numbers: on the dev wording the rules were tuned on, injection recall is 59 of 59; on three held-out files, 43 of 67; on wording written after the rules were frozen, 9 of 24. A model classifier raises that to 16 of 24 but also raises false blocks of legitimate requests above the gate, so the product runs the rules only. Data classes decide what may reach a model: public records yes; vendor-confidential content only with a local lane or recorded consent; patient data never, and none exists in the repository. Zetaris policies mask the vendor's commercial columns for identities not assigned to a case.`,
    html: () => {
      const ssrf = stat(fail, "byCategory.SSRF");
      const dev = grab(SCOUT, /### Dev[\s\S]*?\| Injection recall \| 100\.0% \((\d+\/\d+)/);
      const h3 = grab(SCOUT, /### Held-out \(3 files\)[\s\S]*?\| Injection recall \| 64\.2% \((\d+\/\d+)/);
      const h31 = grab(SCOUT, /### Held-out 3\n[\s\S]*?\| Injection recall \| 37\.5% \((\d+\/\d+)/);
      const f = (s) => { const [k, n] = s.split("/").map(Number); return { k, n }; };
      const rows = [
        { label: "Wording it was tuned on", ...f(dev), tone: "grey" },
        { label: "Three held-out files", ...f(h3), tone: "ink" },
        { label: "Written after rules froze", ...f(h31), tone: "rust", bold: true },
      ].map((r) => ({ label: r.label, value: r.k / r.n, text: `${r.k}/${r.n}`, tone: r.tone, bold: r.bold }));
      const bars = hbars({ rows, max: 1, width: 760, labelW: 300, textW: 110, barH: 30, gap: 14, fontSize: 22 });
      const egress = json("output_examples/dossiers/eyeart-k200667.dossier.json").body.egress.length;
      derive(egress, "egress decisions recorded in the EyeArt dossier");
      return `
      ${head("Safety and security", "Fetched text is data. The guard's weak number is on the slide.")}
      <div class="g2" style="margin-top:22px; gap:26px; flex:1; align-items:stretch; min-height:0">
        ${card(`<h4>SSRF-safe fetch</h4>${pts(["https only, GET only, no credentials forwarded", "Resolved addresses checked against private, loopback, link-local and cloud-metadata ranges", "DNS pinned; every redirect re-checked; size and time capped"])}<p class="mono green b mt-s" style="font-size:22px">${ssrf.k} of ${ssrf.n} SSRF drills correct</p>`, "soft")}
        ${card(`<h4>Untrusted text and the guard</h4><div class="xs ink-2" style="margin:2px 0 6px">Injection recall, rules only, as the product runs it</div>${bars}<p class="xs ink-2" style="margin-top:6px">A model classifier raises the last row but pushes false blocks over the gate, so it is off (D-030).</p>`, "soft")}
        ${card(`<h4>Data classes and egress</h4>${pts(["Public records may reach a model", "Vendor-confidential content: a local lane, or recorded consent", "Patient data never enters; none exists in the repository"])}<p class="xs ink-2 mt-s">${egress} egress decisions recorded in the EyeArt dossier; in the recorded run nothing left the machine.</p>`, "soft")}
        ${card(`<h4>Masking and receipts</h4>${pts(["Zetaris policies mask commercial vendor columns for identities not assigned to a case", "Dossier signature: integrity, not truth", "Receipts: routing, not truth"])}<p class="xs ink-2 mt-s">Not verified: that a masked value cannot reach a model prompt end to end.</p>`, "soft")}
      </div>`;
    },
  },
];
