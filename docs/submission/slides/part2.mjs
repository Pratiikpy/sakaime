// Slides 7 to 9: one real claim (EyeArt, K200667) walked through every step of the product.
import { json, text } from "../lib/data.mjs";
import { esc, labelBadge, relBadge, chip, card, icon } from "../lib/ui.mjs";
import { derive } from "../lib/ctx.mjs";
import { body as dossier, finding, coverage, claimText, traceEvents, DOSSIER, TRACE, labelsRun } from "../lib/case.mjs";

const head = (kicker, title) => `<div class="kicker">${kicker}</div><h2>${title}</h2>`;
const SRC = [DOSSIER, TRACE, "data/sample/run/labels.json", "output_examples/api/drill-source-off-study.json", "input_examples/cases/eyeart-k200667.json"];

/** One step card of the walk. */
const step = (n, name, does, art, where) => `
  <div class="card" style="flex:1; display:flex; flex-direction:column; gap:14px; padding:20px 24px; min-width:0">
    <div style="display:flex; align-items:center; gap:16px">
      <span style="width:52px; height:52px; border-radius:50%; background:var(--ink); color:var(--paper); display:grid; place-items:center; font-weight:600; font-size:30px; flex:none">${n}</span>
      <h3 style="font-size:40px">${name}</h3>
    </div>
    <p class="ink-2" style="font-size:24px; line-height:1.3">${does}</p>
    <div style="flex:1; min-height:0; display:flex; flex-direction:column">${art}</div>
    <div style="display:flex; gap:10px; flex-wrap:wrap">${where.map((w) => chip(w)).join("")}</div>
  </div>`;
const arrow = `<div style="width:44px; display:grid; place-items:center; font-size:44px; font-weight:600; flex:none">&rarr;</div>`;

const panel = (inner, cls = "") => `<div class="${cls}" style="border:2px solid var(--ink); background:var(--paper-2); padding:18px 20px; flex:1; min-height:0; overflow:hidden">${inner}</div>`;

export const part2 = [
  // ------------------------------------------------------------------ 7
  {
    id: "e2e-a",
    section: "How it works, end to end (1 of 3)",
    sources: SRC,
    cls: "EyeArt K200667, recorded run; claims constructed",
    notes: `Now one real claim through every step, so you can see what we do and how. The case is EyeArt 2.1.0, cleared as K200667. Step 1, the question: the hospital's intended use and ten constructed vendor claims; the reviewer asks whether the evidence behind a sensitivity of at least 85 percent applies to primary-care screening of adults. Step 2, discover: the guard first reads the request and lets it proceed; the discoverer finds nine registered source cards and the plan uses six: three regulator records, the registry, the literature and the hospital policy. Step 3, join: one federated statement joins the hospital database, the registry snapshots and the vendor packet files in Zetaris; three statements in this case returned 10, 10 and 3 rows from recorded answers of the real engine. Nothing is joined in application memory.`,
    html: () => {
      const b = dossier();
      const q = claimText("CASE-2026-014.intended");
      const tr = traceEvents();
      const disc = tr.find((e) => e.role === "discoverer");
      const registered = (disc.decision.match(/^(\d+) source cards are registered/) ?? [])[1];
      const nUsed = derive(b.sources.length, "sources the plan used (dossier sources)");
      const fam = (k) => b.sources.filter((s) => s.kind === k).length;
      const fed = b.federation;
      const stmt = fed[0].statement.split("\n").slice(0, 9).join("\n") + "\n  ...";
      const nClaims = derive(b.claims.length - 1, "vendor claims in the case (claims minus the intended use)");
      const srcRows = [
        ["Regulator", "openFDA 510(k), openFDA UDI, FDA decision summary (PDF)", "regulator"],
        ["Registry", "ClinicalTrials.gov v2", "registry"],
        ["Literature", "PubMed E-utilities", "literature"],
        ["Hospital", "hospital policy database (Postgres)", "hospital"],
      ];
      return `
      ${head("How it works, end to end &middot; EyeArt K200667", "One real claim: question, sources, join.")}
      <div class="row" style="margin-top:20px; gap:0; flex:1; min-height:0">
        ${step(
          1,
          "Question",
          "The hospital states its intended use. Ten vendor claims are checked against the same evidence.",
          panel(`<div class="tag">Intended use of the hospital, constructed</div><p style="font-size:25px; line-height:1.3; margin-top:8px">&ldquo;${esc(q)}&rdquo;</p><div style="margin-top:16px; display:flex; gap:10px; flex-wrap:wrap">${chip(nClaims + " constructed vendor claims", "dash")}${chip("sensitivity at least 85 percent")}</div>`),
          ["Review desk"],
        )}
        ${arrow}
        ${step(
          2,
          "Discover",
          "The guard reads the request, then the planner picks sources from the registered cards.",
          panel(`<div class="tag">${registered} source cards registered; ${nUsed} used</div>
            <div style="margin-top:12px; display:flex; flex-direction:column; gap:12px">
            ${srcRows.map(([a, c, k]) => `<div style="border-top:2px solid var(--line-strong); padding-top:8px"><div style="display:flex; justify-content:space-between"><span class="b" style="font-size:26px">${a}</span><span class="mono green b" style="font-size:20px">${fam(k)} used</span></div><div class="ink-2" style="font-size:22px; line-height:1.25">${c}</div></div>`).join("")}</div>
            <div class="xs ink-3" style="margin-top:12px">Fetches: https only, GET only, addresses checked before connecting.</div>`),
          ["src/discovery/", "src/sources/"],
        )}
        ${arrow}
        ${step(
          3,
          "Join",
          "One federated SQL statement over three kinds of silo. Zetaris runs the join, not our code.",
          panel(`<pre style="margin:0; font-family:var(--mono); font-size:18.5px; line-height:1.32; color:var(--ink-2); white-space:pre-wrap">${esc(stmt)}</pre><div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap">${chip(fed.length + " statements", "green")}${chip(fed.map((f) => f.rowCount).join(" + ") + " rows")}${chip("recorded answers")}</div>`),
          ["src/federation/", "Evidence matrix"],
        )}
      </div>
      <p class="xs ink-3" style="margin-top:14px">Query id of the first statement: <span class="mono">${esc(fed[0].queryId)}</span>. The join answer equals an independent DuckDB run cell by cell on the real engine (gate Z-HEAD).</p>`;
    },
  },

  // ------------------------------------------------------------------ 8
  {
    id: "e2e-b",
    section: "How it works, end to end (2 of 3)",
    sources: SRC,
    cls: "EyeArt K200667, recorded run",
    notes: `Step 4, resolve identity. The regulator number K200667 is the anchor. The dossier holds six typed links. Four are CONFIRMED because an exact identifier crosses or a reviewer decided: the same submission in the device database, the study in PubMed, the registry entry NCT03112005, and the paper reporting that registry entry. One registry entry, NCT04302012, is only a CANDIDATE with a score of 4.3 bits, because the version is stated on one side only. The marketed-version link is AMBIGUOUS. A score can never produce CONFIRMED. Step 5, extract: this is a real sentence from the FDA summary on page 7: the pivotal analysis covered persons aged 22 years and older. Every number and quote is anchored to a page, checked to exist in the stored record by code, and separately checked for whether it supports the assertion. Step 6, compile: seven dimensions each come out contained, partial, disjoint or unknown. For the claim about version 3.0, version is disjoint.`,
    html: () => {
      const b = dossier();
      const links = b.links;
      const states = (s) => links.filter((l) => l.state === s).length;
      const nLinks = derive(links.length, "typed links in the EyeArt dossier");
      const conf = derive(states("CONFIRMED"), "CONFIRMED links");
      const cand = derive(states("CANDIDATE"), "CANDIDATE links");
      const amb = derive(states("AMBIGUOUS"), "AMBIGUOUS links");
      const candLink = links.find((l) => l.state === "CANDIDATE");
      const anchor = b.anchors.find((a) => /aged\s+22 years and older/.test(a.text));
      const nAss = derive(b.assertions.length, "assertions in the dossier");
      const nAnc = derive(b.anchors.length, "anchors in the dossier");
      const dims = ["product", "version", "population", "setting", "purpose", "timing", "metric"];
      const names = { product: "Product", version: "Version", population: "Population", setting: "Setting", purpose: "Purpose", timing: "Timing", metric: "Metric" };
      const rows = dims.map((d) => ({ d, c: coverage("CLM-EA-04", d) }));
      // graph
      const node = (x, y, w, t1, t2, strong) =>
        `<rect x="${x}" y="${y}" width="${w}" height="74" fill="${strong ? "var(--ink)" : "var(--paper)"}" stroke="var(--ink)" stroke-width="3"/><text x="${x + w / 2}" y="${y + 33}" text-anchor="middle" font-size="25" font-weight="600" ${strong ? 'class="fp"' : ""}>${t1}</text><text x="${x + w / 2}" y="${y + 60}" text-anchor="middle" font-size="19" class="m ${strong ? "fp" : "f2"}">${t2}</text>`;
      const edge = (x1, y1, x2, y2, lab, tone, dash, lx, ly) =>
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${tone}" stroke-width="4" ${dash ? 'stroke-dasharray="10 8"' : ""}/><rect x="${lx - 82}" y="${ly - 17}" width="164" height="32" fill="var(--paper-2)"/><text x="${lx}" y="${ly + 6}" text-anchor="middle" font-size="19" class="m" fill="${tone}" font-weight="500">${lab}</text>`;
      const graph = `<svg viewBox="0 0 520 470" width="100%" role="img" aria-label="Typed identity links around the EyeArt authorization">
          ${edge(260, 214, 130, 90, "CONFIRMED", "var(--green)", false, 170, 140)}
          ${edge(260, 214, 395, 90, "CONFIRMED", "var(--green)", false, 350, 140)}
          ${edge(260, 256, 130, 380, "AMBIGUOUS", "var(--ink-2)", true, 170, 322)}
          ${edge(260, 256, 395, 380, "CANDIDATE", "var(--green)", true, 355, 322)}
          ${node(30, 30, 200, "PubMed", "34779843")}
          ${node(290, 30, 200, "Registry", "NCT03112005")}
          ${node(160, 196, 200, "510(k)", "K200667", true)}
          ${node(30, 366, 200, "Device DB", "marketed version")}
          ${node(290, 366, 200, "Registry", "NCT04302012")}
        </svg>`;
      return `
      ${head("How it works, end to end &middot; EyeArt K200667", "Identity, quote, compile.")}
      <div class="row" style="margin-top:20px; gap:0; flex:1; min-height:0">
        ${step(
          4,
          "Resolve identity",
          `${nLinks} typed links: ${conf} confirmed, ${cand} candidate, ${amb} ambiguous. A score alone never confirms.`,
          panel(graph + `<div class="xs ink-2" style="margin-top:2px">The candidate scores ${candLink.score} bits: the version is stated on one side only.</div>`),
          ["src/identity/", "Claim X-ray"],
        )}
        ${arrow}
        ${step(
          5,
          "Extract",
          `${nAss} assertions, each anchored to a page. Code checks the quote exists; a separate check asks whether it supports the claim.`,
          panel(`<div class="tag">FDA decision summary K200667, page ${anchor.page}</div><p style="font-size:27px; line-height:1.32; margin-top:12px; border-left:8px solid var(--green); padding-left:18px">${esc(anchor.text.replace(/\s+/g, " "))}</p><div style="margin-top:16px; display:flex; gap:10px; flex-wrap:wrap">${chip(nAnc + " anchors")}${chip("quote exists: code")}${chip("supports claim: separate")}</div>`),
          ["src/extraction/"],
        )}
        ${arrow}
        ${step(
          6,
          "Compile",
          "Seven dimensions, each contained, partial, disjoint or unknown. Shown for the claim about version 3.0.",
          panel(`<div style="display:flex; flex-direction:column; gap:7px">${rows
            .map(({ d, c }) => `<div style="display:flex; align-items:center; justify-content:space-between; gap:10px; border-top:2px solid var(--line-strong); padding-top:7px"><span class="b" style="font-size:25px">${names[d]}</span><span class="xs ink-2" style="flex:1; text-align:right; padding-right:6px">${c.claimed ? esc(d === "product" ? "K200667" : c.claimed.length > 18 ? c.claimed.slice(0, 16) + "..." : c.claimed) : ""}</span>${relBadge(c.relation)}</div>`)
            .join("")}</div>`),
          ["src/compiler/", "Applicability lab"],
        )}
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 9
  {
    id: "e2e-c",
    section: "How it works, end to end (3 of 3)",
    sources: SRC,
    cls: "EyeArt K200667, recorded run",
    notes: `Step 7, label. The compiler's table turns the dimensions into one of five labels. For the version-3.0 claim the answer is not enough evidence, the smallest mismatch is version 3.0 against 2.1.0, and the product writes the request that would settle it: study results for version 3.0, or a written change-control statement. Across the ten vendor claims the recorded run gives one supported, three supported only for a narrower use, one contradicted, two not enough evidence and three that need domain review. Step 8, drill: the study source is switched off through the real code. Every finding that relied on it drops to not enough evidence; the one supported claim stops being supported; nothing becomes supported because something was lost. Step 9, dossier: the whole run is exported as one signed bundle with a verifier that recomputes hashes and reruns the compiler. A signature shows integrity, not truth, and this key is a demo key.`,
    html: () => {
      const f = finding("CLM-EA-04");
      const req = f.requiredEvidence.find((r) => r.dimension === "version").request;
      const claims = labelsRun().claims.filter((c) => c.claimId.startsWith("CLM-"));
      const count = (l) => derive(claims.filter((c) => c.label === l).length, `recorded ${l} among the ten vendor claims`);
      const tally = [
        ["SUPPORTED_FOR_SCOPE", count("SUPPORTED_FOR_SCOPE")],
        ["SUPPORTED_ONLY_FOR_NARROWER_SCOPE", count("SUPPORTED_ONLY_FOR_NARROWER_SCOPE")],
        ["CONTRADICTED_BY_SPECIFIED_EVIDENCE", count("CONTRADICTED_BY_SPECIFIED_EVIDENCE")],
        ["INSUFFICIENT_EVIDENCE", count("INSUFFICIENT_EVIDENCE")],
        ["REQUIRES_DOMAIN_REVIEW", count("REQUIRES_DOMAIN_REVIEW")],
      ];
      const drill = json("output_examples/api/drill-source-off-study.json").body;
      const was = drill.before.find((x) => x.claimId === "CLM-EA-01");
      const now = drill.after.find((x) => x.claimId === "CLM-EA-01");
      const stale = (drill.narrative.match(/(\d+) findings relied on facts from the lost source/) ?? [])[1];
      const d = json(DOSSIER);
      const root = d.manifest.root.slice(0, 16);
      const sections = derive(Object.keys(d.body).length, "sections of the dossier body");
      return `
      ${head("How it works, end to end &middot; EyeArt K200667", "Label, break it on purpose, sign it.")}
      <div class="row" style="margin-top:20px; gap:0; flex:1; min-height:0">
        ${step(
          7,
          "Label",
          "A fixed table turns the dimensions into one of five labels, the smallest mismatch and a request.",
          panel(`<div>${labelBadge(f.label, "lg")}</div>
            <div class="tag mt">Smallest mismatch</div><p class="b" style="font-size:27px; margin-top:4px">Version: claimed 3.0, evidence 2.1.0</p>
            <div class="tag mt-s">To settle it</div><p class="sm ink-2" style="margin-top:4px; line-height:1.3">${esc(req.length > 105 ? req.slice(0, 103).replace(/\s+\S*$/, "") + " ..." : req)}</p>
            <div style="margin-top:14px; display:flex; gap:8px; flex-wrap:wrap">${tally.map(([l, n]) => `<span class="chip" title="${l}">${n} &times; ${LABELSHORT[l]}</span>`).join("")}</div>`),
          ["src/compiler/", "Claim X-ray"],
        )}
        ${arrow}
        ${step(
          8,
          "Drill",
          "Switch the study source off through the real code and run the case again.",
          panel(`<div class="tag">Claim EA-01, the one supported claim</div>
            <div style="display:flex; flex-direction:column; gap:10px; margin-top:10px">${labelBadge(was.label, "sm")}<span class="b" style="font-size:30px; padding-left:14px">&darr;</span>${labelBadge(now.label, "sm")}</div>
            <p class="sm ink-2" style="margin-top:14px; line-height:1.3">${stale} findings relied on the lost source and are marked stale. Nothing became supported because something was lost.</p>
            <div style="margin-top:12px">${chip(drill.invariantHeld ? "invariant held" : "invariant BROKEN", drill.invariantHeld ? "green" : "rust")}</div>`),
          ["src/service/drills.ts", "Resilience"],
        )}
        ${arrow}
        ${step(
          9,
          "Dossier",
          "The whole run, signed, with a verifier that recomputes every hash and reruns the compiler.",
          panel(`<div class="tag">Bundle root (SHA-256)</div><p class="mono b" style="font-size:25px; margin-top:6px; word-break:break-all">${root}...</p>
            <div class="mt-s" style="display:flex; gap:8px; flex-wrap:wrap">${chip("Ed25519")}${chip("demo key", "dash")}${chip(sections + " sections")}</div>
            <p class="sm ink-2 mt" style="line-height:1.3">Change one character and the verifier names the failing item. A signature shows the bundle is unchanged, not that any finding is right.</p>`),
          ["src/dossier/", "Dossier"],
        )}
      </div>`;
    },
  },
];

const LABELSHORT = {
  SUPPORTED_FOR_SCOPE: "supported",
  SUPPORTED_ONLY_FOR_NARROWER_SCOPE: "narrower",
  CONTRADICTED_BY_SPECIFIED_EVIDENCE: "contradicted",
  INSUFFICIENT_EVIDENCE: "not enough",
  REQUIRES_DOMAIN_REVIEW: "review",
};
