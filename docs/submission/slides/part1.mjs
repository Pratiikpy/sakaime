// Slides 1 to 9: the problem, the user, what exists, what was built, and one real claim walked end to end.
import { grab, grabInt, json, text, mdTable, stat, kn, pctOf, num } from "../lib/data.mjs";
import { esc, labelBadge, relBadge, chip, card, pts, tbl, rd, rdlines, stat as statBlock, icon, LABELS } from "../lib/ui.mjs";
import { derive, ask } from "../lib/ctx.mjs";
import { body as dossier, labelOf, finding, coverage, claimText, traceEvents, caseInput, DOSSIER, LABELS_FILE, TRACE } from "../lib/case.mjs";
import { readdirSync } from "node:fs";
import { ROOT } from "../lib/data.mjs";
import { resolve } from "node:path";

const head = (kicker, title, lead = "") =>
  `<div class="kicker">${kicker}</div><h2>${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}`;

const FEAS = "docs/reports/feasibility-report.md";
const RESULTS = "evals/RESULTS.md";

export const part1 = [
  // ------------------------------------------------------------------ 1
  {
    id: "title",
    section: "Track 1: Solving Fragmented Intelligence",
    dark: true,
    sources: ["README.md", "metadata.json"],
    cls: "",
    notes: `Open on the sentence, then the bar. Sakaime checks whether the evidence behind a claim covers the exact use a buyer has in mind. The first use is a hospital team reviewing a medical-AI vendor's claim. Say once, up front, what is real and what is constructed: the regulator, registry and literature records are real and carry retrieval dates; every vendor claim and the hospital requirement are constructed and labelled so on screen; the product on these slides is running in sample mode, which replays recordings made against the real services on 2026-10-27 while the compiler, identity scorer, verifiers and guard run for real.`,
    html: () => `
      <div class="row grow" style="gap:60px; align-items:stretch; margin-top:30px">
        <div class="col" style="width:1200px; justify-content:center; gap:30px">
          <div class="kicker">Open Agent Hackathon 2026 &middot; Track 1</div>
          <div style="display:flex; align-items:baseline; gap:34px">
            <h1 style="font-size:210px; line-height:0.9; letter-spacing:-0.04em">Sakaime</h1>
            <span style="font-family:'Yu Gothic','Meiryo','Noto Sans JP',sans-serif; font-size:84px; color:var(--ink-3)">境目</span>
          </div>
          <div style="display:flex; align-items:center; gap:0; width:1200px">
            <span style="font-size:78px; line-height:1.05; font-weight:600; letter-spacing:-0.02em; white-space:nowrap">Know where the evidence stops.</span>
            <span style="flex:1; height:78px; background:var(--ink); margin-left:10px; min-width:40px"></span>
          </div>
          <p class="lead" style="max-width:1050px; font-size:36px">A hospital team asks whether the evidence behind a vendor's AI claim covers the exact version, patients, setting, purpose and date it has in mind. Sakaime finds the sources, joins them, and answers no more broadly than the evidence allows.</p>
          <div style="display:flex; gap:14px; flex-wrap:wrap; width:1100px">
            ${chip("Zetaris", "green")}${chip("Meterless", "green")}${chip("NVIDIA Nemotron via Nightshift", "green")}${chip("Solo build: Prateek")}${chip("Apache-2.0")}
          </div>
        </div>
        <div style="flex:1; display:flex; justify-content:flex-end; align-items:center">
          <svg viewBox="0 0 520 720" width="380" height="526" role="img" aria-label="A page of evidence with a boundary line; below it the text is hidden by bars">
            <rect x="6" y="6" width="508" height="708" fill="none" stroke="var(--ink)" stroke-width="3"/>
            ${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<rect x="44" y="${50 + i * 30}" width="${[400, 430, 360, 420, 300, 410, 380, 250][i]}" height="12" fill="var(--line-strong)" opacity="0.8"/>`).join("")}
            <rect x="44" y="132" width="150" height="12" fill="var(--ink)"/>
            <line x1="6" y1="326" x2="514" y2="326" stroke="var(--green)" stroke-width="6"/>
            <text x="44" y="372" class="m fg" font-size="21" letter-spacing="1.5" font-weight="500">THE EVIDENCE STOPS HERE</text>
            ${[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => `<rect x="44" y="${400 + i * 33}" width="${[420, 380, 440, 300, 410, 360, 430, 280, 340][i]}" height="22" fill="var(--ink)"/>`).join("")}
          </svg>
        </div>
      </div>
      <div class="xs ink-3" style="margin-bottom:6px">Vendor claims and the hospital requirement are constructed. Regulator, registry and literature records are real. The product screens in this deck run in sample mode on recordings made on 2026-10-27.</div>`,
  },

  // ------------------------------------------------------------------ 2
  {
    id: "problem",
    section: "The problem",
    sources: [DOSSIER, LABELS_FILE, "input_examples/cases/eyeart-k200667.json"],
    cls: "constructed claims; recorded run",
    notes: `The problem in one line: a claim can be true and still be wrong for you. These are three claims about the same cleared product, EyeArt 2.1.0, taken from the recorded run. Each is constructed by us in the style of a vendor claim. In each, one part of the use does not match what the evidence covers: version 3.0 against a study of 2.1.0; ages 18 to 21 against a regulator summary that analysed ages 22 and older; an emergency department against primary and eye care. A tool that only checks that the evidence exists says yes to all three. The hospital's question is different: does it cover my use. The same product also has a dimension that passes: the date of use sits inside the authorization period.`,
    html: () => {
      const cards = [
        { id: "CLM-EA-04", dim: "version", title: "Software version", claimed: "3.0", est: "study: 2.1.0" },
        { id: "CLM-EA-10", dim: "population", title: "Population", claimed: "ages 18 and above", est: "regulator summary: ages 22 and above" },
        { id: "CLM-EA-03", dim: "setting", title: "Care setting", claimed: "emergency department, inpatient ward", est: "eye care, primary care" },
      ];
      return `
      ${head("The problem", "A claim can be true and still be wrong for you.")}
      <p class="lead" style="margin-top:14px">Three constructed vendor claims about one cleared product. Each is checked against the same real evidence.</p>
      <div class="g3" style="flex:1; align-items:stretch; margin-top:18px; min-height:0">
        ${cards
          .map((c) => {
            const f = finding(c.id);
            const row = coverage(c.id, c.dim);
            const t = claimText(c.id);
            const short = t.length > 118 ? t.slice(0, 115).replace(/\s+\S*$/, "") + " ..." : t;
            return card(
              `<div class="tag">Constructed vendor claim ${c.id.replace("CLM-", "")}</div>
               <p style="font-size:30px; line-height:1.3; margin:8px 0 14px; min-height:112px">&ldquo;${esc(short)}&rdquo;</p>
               <div style="border-top:3px solid var(--ink); padding-top:16px">
                 <div class="tag">${c.title}</div>
                 <div class="mt-s" style="display:grid; grid-template-columns:150px 1fr; row-gap:8px; font-size:26px">
                   <span class="ink-3">Claimed</span><span class="b">${esc(c.claimed)}</span>
                   <span class="ink-3">Evidence</span><span class="b">${esc(c.est)}</span>
                 </div>
                 <div style="margin-top:16px">${relBadge(row.relation)}</div>
               </div>
               <div style="margin-top:22px">${labelBadge(f.label)}</div>`,
              "soft",
            );
          })
          .join("")}
      </div>
      <p class="ink-2 mt-s" style="font-size:24px">The same product passes elsewhere: the planned use date, 2027-01-15, lies inside an authorization in force since 2020-08-03. Sakaime reports each part of the use on its own.</p>`;
    },
  },

  // ------------------------------------------------------------------ 3
  {
    id: "user",
    section: "The user and the decision",
    crit: "Impact 30",
    sources: ["docs/01-prd.md", "README.md"],
    cls: "demand not measured",
    notes: `Impact is the criterion worth most, so be exact about the user. The user is a hospital AI-evaluation reviewer: a clinical informatics analyst, procurement analyst or quality lead on an AI intake committee. A vendor packet arrives; the committee needs a defensible, source-linked account of what the evidence does and does not establish before the technical and clinical review. These are the five jobs the product is built around. Be plain about what is not measured: no hospital reviewer or buyer has been interviewed, so demand and willingness to use are not verified, and nothing in this deck is evidence of demand.`,
    html: () => `
      ${head("The user and the decision", "A reviewer must decide what a vendor claim covers.")}
      ${ask("Consistency with the challenge statements: how effectively the solution addresses a meaningful real-world problem for its intended users", "Impact, 30 points")}
      <div class="row" style="gap:44px; flex:1; margin-top:16px; min-height:0">
        <div class="col" style="width:640px; gap:16px">
          ${card(`<div class="tag">The user</div><h3 style="margin:8px 0 10px">Hospital AI-evaluation reviewer</h3><p style="font-size:24px; line-height:1.3; color:var(--paper-3)">Clinical informatics analyst, procurement analyst or quality lead on an AI intake committee. Knows the hospital's own requirements.</p>`, "ink")}
          ${card(`<div class="tag">The decision</div><h3 style="margin:6px 0 0; font-size:31px">Take this claim into technical and clinical review for the use we plan, or send it back with a request.</h3>`, "soft")}
          ${card(`<div class="tag rust">Not measured</div><p style="font-size:24px; line-height:1.3; margin-top:6px">No hospital reviewer or buyer has been interviewed. Demand is not verified; nothing here is evidence of it.</p>`, "rust")}
        </div>
        <div class="col grow" style="gap:0">
          <div class="tag" style="margin-bottom:12px">Five jobs the product does for each claim</div>
          ${[
            ["Does the evidence cover the use we have in mind?", "Shown with the exact passage, page and source."],
            ["What is missing?", "Written as a request that can be sent to the vendor."],
            ["If we narrow or widen the use, what changes?", "Recomputed in the browser, no model called."],
            ["When something we relied on is updated, what does it touch?", "Only the dependent findings are marked stale."],
            ["Can I hand the committee a record and re-check it later?", "A signed bundle with an offline verifier."],
          ]
            .map(
              ([a, b], i) => `<div style="display:flex; gap:26px; padding:14px 0; border-top:3px solid var(--ink); align-items:baseline">
                <span class="mono b" style="font-size:34px; width:50px">${i + 1}</span>
                <div><div style="font-size:33px; font-weight:600; line-height:1.2">${a}</div><div class="ink-2" style="font-size:27px; margin-top:4px">${b}</div></div></div>`,
            )
            .join("")}
        </div>
      </div>`,
  },

  // ------------------------------------------------------------------ 4
  {
    id: "fragmented",
    section: "Why the evidence is fragmented",
    sources: [FEAS],
    derived: [],
    cls: "probe of 12 real devices, 2026-10-27, one reader",
    notes: `Why this is a Track 1 problem. The evidence for one product lives in five places that keep different identifiers: the regulator keys on a K or De Novo number, the registry on an NCT id, the literature on a PMID or DOI, the vendor on a product name and a version string, the hospital on its own case id. We probed twelve real AI-enabled devices with no keys. Only 3 of 12 had an identifier that crosses between the device record and a study. Only 1 of 12, EyeArt, had a study that states the software version the regulator reviewed. Six of twelve names collide with something unrelated, and eleven of twelve show a version or identity conflict between at least two sources. So linking has to be shown as ranked candidates with reasons, never as fact below an exact identifier. One reader classified these links; no second reader.`,
    html: () => {
      const exact = grabInt(FEAS, /only (\d+) of 12 devices had an exact-identifier link/, "exact");
      const ver = grabInt(FEAS, /only (\d+) of 12 had a link whose study text states the same software version/, "version");
      const coll = grabInt(FEAS, /Name collisions \(a string match to something unrelated\), (\d+) of 12 devices/, "collision");
      const conf = grabInt(FEAS, /Collision for \d+ of 12; version\/identity conflict for (\d+) of 12/, "conflict");
      const devs = ["IDx-DR", "EyeArt", "Caption", "ContaCT", "BriefCase", "Transpara", "MammoScreen", "Lunit", "Paige", "GI Genius", "HeartFlow", "Anumana"];
      const rows = [
        { label: "An identifier crosses|to a study", good: true, set: ["EyeArt", "ContaCT", "GI Genius"], n: exact },
        { label: "Study states the|version FDA reviewed", good: true, set: ["EyeArt"], n: ver },
        { label: "Name collides with|something unrelated", good: false, set: ["IDx-DR", "Caption", "ContaCT", "BriefCase", "MammoScreen", "HeartFlow"], n: coll },
        { label: "Version or identity|conflict between sources", good: false, set: devs.filter((d) => d !== "EyeArt"), n: conf },
      ];
      for (const r of rows) if (r.set.length !== r.n) throw new Error(`device grid disagrees with the report for "${r.label}": ${r.set.length} against ${r.n}`);
      const cell = 56, gx = 440, gy = 150;
      const grid = rows
        .map((r, ri) => {
          const y = gy + ri * (cell + 36);
          const cells = devs
            .map((d, ci) => {
              const x = gx + ci * (cell + 8);
              const on = r.set.includes(d);
              const col = r.good ? "var(--green)" : "var(--rust)";
              if (!on) return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="none" stroke="var(--line-strong)" stroke-width="2"/>`;
              const glyph = r.good
                ? `<path d="M${x + 12} ${y + 29} l11 11 l20 -22" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`
                : `<path d="M${x + 15} ${y + 15} l26 26 M${x + 41} ${y + 15} l-26 26" stroke="#fff" stroke-width="7" fill="none" stroke-linecap="round"/>`;
              return `<rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="${col}"/>${glyph}`;
            })
            .join("");
          return `${cells}<text x="0" y="${y + 42}" font-size="46" font-weight="600" fill="${r.good ? "var(--green)" : "var(--rust)"}">${r.n} of 12</text>
                  <text x="150" y="${y + 24}" font-size="22" font-weight="600">${r.label.split("|")[0]}</text><text x="150" y="${y + 48}" font-size="22" font-weight="600">${r.label.split("|")[1] ?? ""}</text>`;
        })
        .join("");
      const heads = devs.map((d, ci) => `<text transform="translate(${gx + ci * (cell + 8) + 34},${gy - 12}) rotate(-52)" font-size="21" class="m f2">${d}</text>`).join("");
      const silos = [
        ["Regulator", "FDA 510(k) / De Novo number", "K200667"],
        ["Registry", "ClinicalTrials.gov id", "NCT03112005"],
        ["Literature", "PubMed id or DOI", "PMID 34779843"],
        ["Vendor packet", "product name and a version string", "EyeArt 2.1.0"],
        ["Hospital", "its own case and policy ids", "CASE-2026-014"],
      ];
      return `
      ${head("Why the evidence is fragmented", "Five systems, five identifiers that rarely cross.")}
      <div class="row mt" style="gap:50px; flex:1">
        <div class="col" style="width:470px; gap:14px">
          ${silos.map(([a, b, c]) => `<div class="card" style="padding:14px 22px; display:flex; flex-direction:column; gap:2px"><div style="display:flex; justify-content:space-between; align-items:baseline"><span class="b" style="font-size:30px">${a}</span><span class="mono green b" style="font-size:22px">${c}</span></div><span class="ink-2 xs">${b}</span></div>`).join("")}
        </div>
        <div class="grow" style="display:flex; flex-direction:column">
          <svg viewBox="0 0 1220 520" width="100%" style="overflow:visible" role="img" aria-label="Twelve devices against four tests of whether the sources connect">
            ${heads}${grid}
          </svg>
          <p class="sm ink-2" style="margin-top:14px">Twelve real FDA-listed AI devices, probed keyless on 2026-10-27. A tick means the test holds; a cross means the sources collide or conflict. Links are therefore shown as ranked candidates with a reason, never as fact below an exact identifier.</p>
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 5
  {
    id: "exists",
    section: "What exists today",
    sources: ["evals/gate0/COMPETITOR-ARMS.md", "docs/reports/competition-report.md", RESULTS, "evals/results/scopeshift-b-dev.json", "evals/results/scopeshift-b-held-out.json"],
    derived: [],
    cls: "builder-labelled; same inputs; Gate 0",
    notes: `An honest competitor slide. We read eighteen products and frameworks; none of them checks a vendor claim against version, population, setting and use. The two closest are evidence lookup tools: Constat accepts one K or De Novo number and returns extracted fields with quotes, none of its fourteen tools takes claim text; HealthIT.com publishes a ledger with no claim input. Given the same 26 claims, a careful reviewer could re-derive our answer key from Constat's output for 7 of 26 and from HealthIT's for 0 of 26. Neither gives a verdict. The stronger alternative is a generic model given all the records. That arm labels more claims exactly right than we do, and it also labels 20 to 39 percent of unsupported claims as supported. The Gate 0 rule says the gap stands, but that is a weak statement: Sakaime's own exact accuracy does not reach 0.80, the claims and the key were written by one builder, and Constat and HealthIT were not run on the held-out claims.`,
    html: () => {
      const mx = mdTable("docs/reports/competition-report.md", /^## 1\. Matrix/);
      const rows = mx.slice(1);
      const total = derive(rows.length, "rows of the competition-report capability matrix");
      const c3 = rows.map((r) => (r[3].match(/^(YES|PARTIAL|NO|NOT VERIFIED)/) ?? [])[1]);
      const countOf = (k) => c3.filter((x) => x === k).length;
      const yes = derive(countOf("YES"), "C3 cells that read YES");
      const constatN = grabInt(RESULTS, /\[(\d+) of 26 \(Constat\) and \d+ of 26 \(HealthIT\)\]/, "constat");
      const healthN = grabInt(RESULTS, /\[\d+ of 26 \(Constat\) and (\d+) of 26 \(HealthIT\)\]/, "healthit");
      const dev = "evals/results/scopeshift-b-dev.json", ho = "evals/results/scopeshift-b-held-out.json";
      const mw = (f, k) => json(f).summaries[k];
      const r = (label, a, b, c, d, e, hl = "") => ({ cls: hl, cells: [label, a, b, c, d, e] });
      const fmt = (s) => (s.mean !== undefined ? `${(s.mean * 100).toFixed(1)}%` : pctOf(s));
      return `
      ${head("What exists today", "Lookup tools return evidence, not verdicts.")}
      <div style="margin-top:22px">${tbl(
        ["Same 26 claims and records", "Takes a claim", "Verdict", "Key re-derivable", ">Exact label, dev / held-out", ">Unsupported called supported, dev / held-out"],
        [
          r("Constat (free MCP lookup)", "No: one K or De Novo number", "None", `${constatN} of 26`, "n/a", "n/a"),
          r("HealthIT.com ledger", "No: a filter by product", "None", `${healthN} of 26`, "n/a", "n/a"),
          r("One Nemotron call, all records", "Yes", "Yes", "n/a", `${fmt(mw(dev, "dev.B3.exact.meanWorst"))} / ${fmt(mw(ho, "heldout.B3.exact.meanWorst"))}`, `${fmt(mw(dev, "dev.B3.falseSupported.meanWorst"))} / ${fmt(mw(ho, "heldout.B3.falseSupported.meanWorst"))}`),
          r("Tool-using Nemotron agent", "Yes", "Yes", "n/a", `${fmt(mw(dev, "dev.B4.exact.meanWorst"))} / ${fmt(mw(ho, "heldout.B4.exact.meanWorst"))}`, `${fmt(mw(dev, "dev.B4.falseSupported.meanWorst"))} / ${fmt(mw(ho, "heldout.B4.falseSupported.meanWorst"))}`),
          r("Sakaime", "Yes", "One of five labels", "n/a", `${pctOf(mw(dev, "dev.V.exact"))} / ${pctOf(mw(ho, "heldout.V.exact"))}`, `${pctOf(mw(dev, "dev.V.falseSupported"))} / ${pctOf(mw(ho, "heldout.V.falseSupported"))}`, "hl"),
        ],
        "tight",
      )}</div>
      <div class="row mt" style="gap:36px">
        <div class="grow">${card(`<div class="tag green">Eighteen products read</div><p style="font-size:24px; line-height:1.3; margin-top:6px">The competition report scores ${total} products and frameworks on five capabilities, these two included. None checks a claim against version, population, setting and intended use: ${yes} read YES.</p>`, "soft")}</div>
        <div class="grow">${card(`<div class="tag rust">Read this before quoting the gap</div><p style="font-size:24px; line-height:1.3; margin-top:6px">The Gate 0 rule says the gap stands, and that is weak: Sakaime's exact-label accuracy is below both generic Nemotron arms, one builder wrote the claims and the key, and Constat and HealthIT.com were not run on the held-out claims.</p>`, "rust")}</div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 6
  {
    id: "built",
    section: "What we built",
    sources: ["README.md", "docs/05-requirements-matrix.md", "ui/src/screens"],
    derived: [],
    cls: "",
    notes: `What we built, on one page. In: the hospital's intended use and the vendor's claims. Out: for every claim one of five labels, the smallest mismatch, the document that would settle each unknown, and a signed record. In between are five things the product does by itself: discover and onboard sources, join them with one federated query, resolve which records describe the same product, study and version, read the documents with verified quotes, and compile the answer dimension by dimension in deterministic code. A web workstation sits on top with thirteen screens, and the whole run is replayable offline.`,
    html: () => {
      const screens = derive(readdirSync(resolve(ROOT, "ui/src/screens")).filter((f) => f.endsWith(".tsx")).length, "files in ui/src/screens");
      const tests = grab("docs/05-requirements-matrix.md", /(3,140) tests passed/);
      const drills = stat("evals/results/failureshift.json", "correctState");
      const steps = [
        ["Discover", "Onboard a source nobody wrote an adapter for; refuse unsafe addresses", "src/discovery/"],
        ["Join", "One federated SQL over Postgres, registry snapshots and vendor files", "src/federation/"],
        ["Resolve", "Typed links; uncertain stays uncertain", "src/identity/"],
        ["Read", "Anchored quotes from PDFs and APIs; long documents in chunks", "src/extraction/"],
        ["Compile", "Seven dimensions, five labels, smallest mismatch", "src/compiler/"],
      ];
      return `
      ${head("What we built", "Claims in. Labelled, sourced, signed answers out.")}
      <div class="row center mt" style="gap:0; flex:1; min-height:0">
        <div class="card ink" style="width:330px; align-self:stretch; display:flex; flex-direction:column; justify-content:center; gap:14px">
          <div class="tag" style="color:var(--paper-3)">In</div>
          <div style="font-size:31px; font-weight:600; line-height:1.2">The hospital's intended use</div>
          <div style="font-size:31px; font-weight:600; line-height:1.2">The vendor's claims</div>
          <div class="xs" style="color:var(--paper-3)">constructed, labelled as such</div>
        </div>
        <div style="width:50px; text-align:center" class="b">&rarr;</div>
        <div class="grow col" style="gap:14px; align-self:stretch; justify-content:center">
          ${steps.map(([a, b, c], i) => `<div class="card" style="padding:14px 24px; display:flex; align-items:center; gap:24px"><span class="mono b green" style="font-size:30px; width:34px">${i + 1}</span><span class="b" style="font-size:33px; width:150px">${a}</span><span class="ink-2 grow" style="font-size:25px; line-height:1.25">${b}</span><span class="chip">${c}</span></div>`).join("")}
        </div>
        <div style="width:50px; text-align:center" class="b">&rarr;</div>
        <div class="card green" style="width:420px; align-self:stretch; display:flex; flex-direction:column; justify-content:center; gap:14px">
          <div class="tag green">Out, for every claim</div>
          <div style="font-size:30px; font-weight:600; line-height:1.2">One of five labels</div>
          <div style="font-size:30px; font-weight:600; line-height:1.2">The smallest mismatch</div>
          <div style="font-size:30px; font-weight:600; line-height:1.2">What would settle each unknown</div>
          <div style="font-size:30px; font-weight:600; line-height:1.2">A signed dossier</div>
        </div>
      </div>
      <div class="g4 mt" style="margin-bottom:0">
        ${statBlock(screens, "screens in the web workstation", { size: "sm" })}
        ${statBlock(tests, "automated tests, offline", { size: "sm" })}
        ${statBlock(drills.k, "fault drills, all in the correct state", { size: "sm" })}
        ${statBlock("0", "keys needed to replay the recorded run", { size: "sm" })}
      </div>`;
    },
  },
];
