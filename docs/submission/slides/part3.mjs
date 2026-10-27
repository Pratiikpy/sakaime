// Slides 10 to 20: architecture, stack, the Track 1 answer, what is new, the mechanisms, and the product.
import { grab, grabInt, json, text, stat, kn, pctOf, mdTable, ROOT } from "../lib/data.mjs";
import { esc, labelBadge, relBadge, chip, card, pts, tbl, shot, LABELS, icon, stat as statBlock } from "../lib/ui.mjs";
import { derive, ask } from "../lib/ctx.mjs";
import { hbars } from "../lib/charts.mjs";
import { labelsRun, traceEvents } from "../lib/case.mjs";
import { resolve } from "node:path";
import { readdirSync } from "node:fs";

const head = (kicker, title, lead = "") => `<div class="kicker">${kicker}</div><h2>${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}`;
const RESULTS = "evals/RESULTS.md";
const DISC = "data/discovery-shift/RESULTS.md";

export const part3 = [
  // ------------------------------------------------------------------ 10
  {
    id: "architecture",
    section: "Architecture",
    crit: "Technical 20",
    sources: ["README.md", "docs/02-architecture.md"],
    cls: "design contract; build matches except where the docs say",
    notes: `The architecture is nine layers and one rule. The rule: deterministic code owns calculations, labels and checks; Nemotron proposes, and a model proposal never becomes a fact until a deterministic check or a reviewer accepts it. Layer 0 is the guard, which reads the request and every document-derived instruction. Layer 1 discovers and onboards sources. Layer 2 is Zetaris federation. Layer 3 resolves identity as typed links. Layer 4 extracts with verified quotes; long documents go through the Markovian reader. Layer 5 is evidence memory: the bi-temporal World Model and H-MEM. Layer 6, the applicability compiler, uses no model at all. Layer 7 is the bounded investigation loop with its roles. Layer 8 is the signed dossier and the offline verifier. Sponsor technology sits where it changes outputs: Zetaris at layers 1 and 2, Meterless engines at layers 0, 4 and 5, Nemotron through Nightshift at the roles.`,
    html: () => {
      const L = [
        ["L0", "Scout guard", "intent, injection quarantine, signed export contracts", [["Meterless Scout Intent", "m"]]],
        ["L1", "Source discovery", "allowlist, SSRF-safe fetch, bounded probe, schema fingerprint, semantic validation, review, registration", [["Zetaris catalog", "z"], ["Nemotron mapping", "n"]]],
        ["L2", "Zetaris federation", "one SQL over Postgres, registry snapshots and vendor files; policies; Unified Semantic Layer", [["Zetaris", "z"]]],
        ["L3", "Identity resolution", "typed links; an uncertain link stays uncertain", [["Nemotron in the uncertain band", "n"]]],
        ["L4", "Extraction", "anchored PDF and API parsing; quote-exists is separate from semantic support", [["Meterless Markovian", "m"], ["Nemotron extractor", "n"]]],
        ["L5", "Evidence memory", "bi-temporal World Model; H-MEM for confirmed links and precedents", [["Meterless World Model", "m"], ["Meterless H-MEM", "m"]]],
        ["L6", "Applicability compiler", "per-dimension containment, label table, smallest mismatch, counterfactuals", [["code only: no model", "c"]]],
        ["L7", "Investigation loop", "planner, retriever, resolver, extractor, critic, reporter; bounded", [["Nemotron roles", "n"]]],
        ["L8", "Dossier", "signed bundle, offline verifier, lineage events, reviewer decisions", [["Nightshift receipts", "n"]]],
      ];
      const tone = { z: "green", m: "green", n: "", c: "ink" };
      return `
      ${head("Architecture", "Nine layers. Code decides; Nemotron proposes.")}
      ${ask("How well is the solution built, including its technical implementation, reliability and architecture?", "Technical, 20 points")}
      <div style="margin-top:18px; display:flex; flex-direction:column; gap:0; flex:1; min-height:0">
        ${L.map(
          ([k, n, d, tags], i) => `<div style="display:flex; align-items:center; gap:22px; border-top:${i ? 2 : 3}px solid ${i ? "var(--line)" : "var(--ink)"}; padding:7px 0; flex:1">
            <span class="mono b" style="width:64px; font-size:30px; color:${k === "L6" ? "var(--green)" : "var(--ink)"}">${k}</span>
            <span class="b" style="width:330px; font-size:30px">${n}</span>
            <span class="ink-2" style="flex:1; font-size:23px; line-height:1.22">${d}</span>
            <span style="display:flex; gap:8px; width:600px; justify-content:flex-end; flex-wrap:wrap">${tags.map(([t, c]) => chip(t, tone[c])).join("")}</span>
          </div>`,
        ).join("")}
      </div>
      <p class="sm b" style="margin-top:10px; border-left:10px solid var(--ink); padding-left:18px">A model proposal never becomes a fact until a deterministic check or a reviewer accepts it.</p>`;
    },
  },

  // ------------------------------------------------------------------ 11
  {
    id: "stack",
    section: "Technical stack",
    crit: "Technical 20",
    sources: ["package.json", "docs/05-requirements-matrix.md", "infra/zetaris/GATES.md", "README.md"],
    cls: "versions read from package.json",
    notes: `The stack, read from package.json and the Zetaris gate record. One language end to end: TypeScript on Node, with Zod schemas checked at every boundary, because the Meterless engines and harnesses are TypeScript. SQLite through the built-in node module for local state, Hono for the HTTP API, DuckDB only as an independent test oracle for the Zetaris join. The web app is React with Vite. Verification uses Vitest, fast-check property tests, Playwright and axe. The Zetaris engine is the 2.4.3.1 hackathon build in Docker with Postgres and file silos beside it; Nemotron is reached through Nightshift. Licence is Apache-2.0.`,
    html: () => {
      const pkg = json("package.json");
      const v = (n) => {
        const x = pkg.dependencies?.[n] ?? pkg.devDependencies?.[n];
        if (!x) throw new Error(`package ${n} missing`);
        return x.replace(/^[\^~]/, "").split(".").slice(0, 1).join(".");
      };
      const zver = grab("infra/zetaris/GATES.md", /Zetaris (2\.4\.3\.1) hackathon build/);
      const spark = grab("infra/zetaris/GATES.md", /Spark (3\.5\.3) in local mode/);
      const tests = grab("docs/05-requirements-matrix.md", /(3,140) tests passed/);
      const files = grab("docs/05-requirements-matrix.md", /(133) test files passed/);
      const col = (title, items, cls = "") => card(`<div class="tag ${cls}">${title}</div><div style="display:flex; flex-direction:column; gap:16px; margin-top:16px">${items.map(([a, b]) => `<div style="display:flex; justify-content:space-between; align-items:baseline; gap:12px; border-top:2px solid var(--line); padding-top:12px"><span class="b" style="font-size:29px; white-space:nowrap">${a}</span><span class="mono ink-2" style="font-size:21px; text-align:right">${b}</span></div>`).join("")}</div>`, "soft");
      return `
      ${head("Technical stack", "One language, typed at every boundary.")}
      <div class="g4 mt" style="flex:1; align-items:stretch; min-height:0">
        ${col("Runtime", [["TypeScript", "Node 22.19+"], ["Zod", "v" + v("zod")], ["Hono", "v" + v("hono")], ["node:sqlite", "local state"], ["DuckDB", "test oracle only"], ["pdfjs-dist", "v" + v("pdfjs-dist")], ["Signatures", "node:crypto"]])}
        ${col("Web app", [["React", "v" + v("react")], ["Vite", "v" + v("vite")], ["React Router", "v" + v("react-router-dom")], ["Outfit", "display and body"], ["JetBrains Mono", "ids and SQL"]])}
        ${col("Verification", [["Vitest", "v" + v("vitest")], ["fast-check", "v" + v("fast-check")], ["Playwright", "v" + v("@playwright/test")], ["axe", "accessibility"], [tests + " tests", files + " files"]])}
        ${col("Sponsor stack", [["Zetaris", zver], ["Spark", spark + " (local)"], ["Postgres", "v16 silo"], ["Meterless", "4 engines"], ["Nemotron", "via Nightshift"]], "green")}
      </div>
      <div class="row mt" style="gap:14px; flex-wrap:wrap; margin-bottom:4px">
        ${["openFDA 510(k) and UDI", "ClinicalTrials.gov v2", "PubMed", "Europe PMC", "FDA decision summaries (PDF)"].map((s) => chip(s, "dash")).join("")}
        <span class="ink-3 sm" style="margin-left:10px">public data, no keys; Apache-2.0</span>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 12
  {
    id: "track1",
    section: "The Track 1 challenge",
    crit: "Impact 30",
    sources: ["research/hackathon/organizer/01-welcome-guide.md", "research/hackathon/organizer/04-approach-guide-solutioning.md", DISC, "infra/zetaris/GATES.md", "evals/results/identityshift.json"],
    cls: "screens: sample mode, recorded replies",
    notes: `Track 1 asks for a clever ability to discover and work across fragmented data sources. The organizers' own good example is an agent that queries three disconnected systems, reconciles conflicting records and produces one sourced answer showing which system each fact came from. Sakaime does each of those three things and shows each on screen. Discover: a source nobody wrote an adapter for goes through eight stages, and an address inside a network or at cloud metadata is refused at stage one. Work across: one federated Zetaris statement joins a hospital database, registry and regulator snapshots and vendor files, and every column is tied to its source. Reconcile: identity is typed links with states, authority depends on the kind of assertion, and every finding names the exact passage, page and retrieval date it rests on.`,
    html: () => {
      const caught = grab(DISC, /\| full \(run1\) \| [^|]+\| [^|]+\| (\d+\/\d+) = 100\.0%/);
      const rows = grabInt("infra/zetaris/GATES.md", /returns (20) rows in 0\.8 s/);
      const fm = stat("evals/results/identityshift.json", "resolver.falseMergeRate");
      const col = (n, title, img, words, evid) => `<div class="col" style="flex:1; gap:14px; min-width:0">
        <div style="display:flex; align-items:center; gap:14px"><span style="width:46px; height:46px; border-radius:50%; background:var(--ink); color:var(--paper); display:grid; place-items:center; font-weight:600; font-size:27px">${n}</span><h3>${title}</h3></div>
        ${img}
        <p style="font-size:24px; line-height:1.3">${words}</p>
        <p class="mono green b" style="font-size:21px">${evid}</p></div>`;
      return `
      ${head("The Track 1 challenge", "Discover, work across, reconcile.")}
      ${ask("Demonstrate a clever ability to discover and work across fragmented data sources.", "Track 1, Solving Fragmented Intelligence")}
      <div class="row" style="gap:34px; margin-top:20px; flex:1; min-height:0">
        ${col(1, "Discover", shot("sources-onboard.png", "/sources", "", { h: 300, top: 90, left: 540, zoom: 230 }), "A source nobody wrote an adapter for goes through eight stages. Cloud-metadata and unlisted hosts are refused at stage one.", `${caught} must-not-register layouts caught`)}
        ${col(2, "Work across", shot("matrix.png", "/cases/eyeart-k200667/matrix", "", { h: 300, top: 108, left: 100, zoom: 190 }), "One Zetaris statement joins a hospital database, registry and regulator snapshots and vendor files. Each column names its source.", `one statement, ${rows} rows, equals DuckDB`)}
        ${col(3, "Reconcile", shot("xray-version-2.png", "/cases/eyeart-k200667/claims/CLM-EA-04", "", { h: 300, top: 235, left: 110, zoom: 190 }), "Typed identity links, authority by kind of assertion, and for each dimension the claimed value beside what the evidence establishes.", `${fm.k} of ${fm.n} false merges`)}
      </div>
      <p class="xs ink-3" style="margin-top:14px; line-height:1.3">The organizers' own good example: &ldquo;querying three disconnected systems, reconciling conflicting records, and producing a single sourced summary with the systems each fact came from.&rdquo;</p>`;
    },
  },

  // ------------------------------------------------------------------ 13
  {
    id: "innovation",
    section: "What is new",
    crit: "Innovation 15",
    sources: [RESULTS, "docs/02-architecture.md", "tests/engines/ABLATIONS.md", DISC],
    cls: "compared on the same inputs; see slides 30 and 31",
    notes: `Innovation, in the judges' words: how original or creative is the approach. Four ideas, none of them a wrapper around a prompt. One: a claim is checked dimension by dimension against what the evidence covers, with three values, so unknown is never read as covered. Two: the answer is the smallest mismatch plus the exact document that would settle it. Three: a counterfactual lab, where changing the version, the ages, the setting or the date recomputes the answer with no model call. Four: change-triggered re-evaluation, where only the findings that depended on a changed fact are marked stale. Five: source onboarding that checks meaning, not only types. The honest comparison is on slide 30: against generic Nemotron arms we are less often exactly right, and we are the only arm family that never labels an unsupported claim as supported.`,
    html: () => {
      const fs = stat("evals/results/scopeshift-b-dev.json", "dev.V.falseSupported");
      const fsh = stat("evals/results/scopeshift-b-held-out.json", "heldout.V.falseSupported");
      const a = grab("tests/engines/ABLATIONS.md", /\| World Model present \| 36 \| 7 \| (9) \|/);
      const tot = grab("tests/engines/ABLATIONS.md", /\| World Model present \| (36) \|/);
      const sem = grab("docs/05-requirements-matrix.md", /0 false accepts of a semantic mutation in (52)/);
      const card1 = (n, t, d, e) => card(`<div style="display:flex; gap:14px; align-items:baseline"><span class="mono green b" style="font-size:24px">${n}</span><h3 style="font-size:29px; line-height:1.12">${t}</h3></div><p style="font-size:22px; line-height:1.28; margin-top:8px" class="ink-2">${d}</p><p class="mono b" style="font-size:18px; margin-top:8px; line-height:1.3">${e}</p>`);
      return `
      ${head("What is new", "It answers no more broadly than the evidence allows.")}
      ${ask("How original or creative is the approach to solving the problem?", "Innovation, 15 points")}
      <div class="g3" style="margin-top:16px; gap:20px; flex:1; align-items:stretch; min-height:0">
        ${card1("01", "Three-valued applicability", "Seven dimensions, each contained, partial, disjoint or unknown. Unknown is never read as covered and never as false.", `${fs.k} of ${fs.n} dev and ${fsh.k} of ${fsh.n} held-out unsupported claims labelled supported`)}
        ${card1("02", "The smallest mismatch, and what settles it", "Not a score: the dimensions that stop the claim, both values side by side, and a request written to send to the vendor.", "every finding names the passage, page and date")}
        ${card1("03", "Counterfactual lab", "Change the version, ages, setting or date and the label recomputes. No model is called, so the same inputs always give the same answer.", "slide 19")}
        ${card1("04", "Change-triggered re-evaluation", "A World Model records which facts each finding used. When a source changes, only the dependent findings go stale.", `${a} findings recomputed instead of ${tot}, none missed (constructed session)`)}
        ${card1("05", "Onboarding that checks meaning", "A mapping is checked for units, scale, identifier family and joins against records already held, not only for types.", `0 false accepts of a semantic mutation in ${sem} that could produce one`)}
        ${card(`<div class="tag rust">The cost, stated</div><p style="font-size:22px; line-height:1.3; margin-top:8px">The same discipline makes the full pipeline conservative: its exact-label accuracy is below the generic Nemotron arms and it flags well-supported claims it cannot place. Slide 30 shows every row.</p>`, "rust")}
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 14
  {
    id: "discovery",
    section: "Source discovery and safe onboarding",
    sources: [DISC, "evals/results/discoveryshift.json", "evals/results/failureshift.json", "docs/02-architecture.md"],
    cls: "builder-labelled consistency; 4 base sources; one labeller",
    notes: `Discovery is the centrepiece of Track 1. A new source goes through eight stages and stops at the first one it fails, with the reason shown: authorization against an allowlist with an SSRF-safe fetch, capability discovery through the Zetaris catalog or the source card, a bounded probe that fingerprints the schema, a mapping proposal from Nemotron, a deterministic semantic check, human review for anything uncertain, registration, and monitoring for drift. We tested it on 102 mutated layouts built from four tables, using a sealed answer file whose hash the runner checks. The first run on the sealed suite mapped 39 of 48 mappable layouts and caught 44 of 44 layouts that must not register, with no false accepts. We then fixed what that run showed, and the second run, on the same cases, is 48 of 48 and 44 of 44; those cases are no longer held out, and the slide says so. A hardcoded loader maps 22 of 48 and catches 12 of 44. Turning the model off or the cross-source joins off each costs measurable outcomes. Not independent: the builder wrote the cases and the labels.`,
    html: () => {
      const md = text(DISC);
      const row = (name, run) => {
        const m = md.match(new RegExp(`\\| ${name} \\(${run}\\) \\| (\\d+)/(\\d+) = [^|]+\\|[^|]+\\| (\\d+)/(\\d+) = `));
        if (!m) throw new Error(`discovery row ${name} ${run} missing`);
        return { k1: +m[1], n1: +m[2], k2: +m[3], n2: +m[4] };
      };
      const hb = md.match(/\| hardcoded ETL baseline \| (\d+)\/(\d+) = [^|]+\|[^|]+\| (\d+)\/(\d+) = /);
      const hard = { k1: +hb[1], n1: +hb[2], k2: +hb[3], n2: +hb[4] };
      const arms = [
        { label: "Hardcoded loader", ...hard, tone: "rust" },
        { label: "Model off", ...row("lexical", "run1"), tone: "grey" },
        { label: "Cross-source checks off", ...row("nojoin", "run1"), tone: "grey" },
        { label: "Full, first run", ...row("full", "run1"), tone: "green", bold: true },
        { label: "Full, after fixes", ...row("full", "run2"), tone: "green" },
      ];
      const stages = ["Authorization", "Capability discovery", "Bounded probe", "Mapping proposal", "Semantic check", "Human review", "Registration", "Monitoring"];
      const ssrf = stat("evals/results/failureshift.json", "byCategory.SSRF");
      const mk = (key, n, w) => hbars({ rows: arms.map((a) => ({ label: a.label, value: a[`k${key}`], text: `${a[`k${key}`]}/${a[`n${key}`]}`, tone: a.tone, bold: a.bold })), max: arms[0][`n${key}`], width: w, labelW: 300, textW: 120, barH: 38, gap: 18, fontSize: 24 });
      const nMust = arms[0].n1, nNot = arms[0].n2;
      return `
      ${head("Source discovery and safe onboarding", "New sources are checked for meaning, then registered.")}
      <div style="display:flex; gap:0; margin-top:22px">
        ${stages.map((s, i) => `<div style="flex:1; border-top:6px solid ${i === 4 ? "var(--green)" : "var(--ink)"}; padding:10px 12px 0 0"><div class="mono ink-3" style="font-size:20px">${i + 1}</div><div class="b" style="font-size:23px; line-height:1.2">${s}</div></div>`).join("")}
      </div>
      <div class="g2" style="margin-top:26px; gap:50px; flex:1; min-height:0">
        <div><div class="b" style="font-size:27px; margin-bottom:10px">Layouts that must map, mapped correctly (of ${nMust})</div>${mk(1, nMust, 800)}</div>
        <div><div class="b" style="font-size:27px; margin-bottom:10px">Layouts that must not register, caught (of ${nNot})</div>${mk(2, nNot, 800)}</div>
      </div>
      <div class="row" style="gap:24px; margin-top:8px">
        <div class="grow">${card(`<p class="xs"><b>102</b> mutated layouts from four base tables, sealed answers, one labeller. The second run follows fixes made against the same cases, so it is no longer held out. Two known limits are reported, not scored.</p>`, "soft")}</div>
        <div class="grow">${card(`<p class="xs"><b>${ssrf.k} of ${ssrf.n}</b> SSRF drills correct: private, loopback, link-local, metadata, rebinding, redirects, non-https, oversize, unlisted hosts. Refused at stage one with a reason.</p>`, "soft")}</div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 15
  {
    id: "identity",
    section: "Identity resolution",
    sources: ["data/identity-corpus/RESULTS.md", "evals/results/identityshift.json", "output_examples/dossiers/transpara-k221347.dossier.json", "docs/02-architecture.md", "README.md"],
    cls: "builder-labelled development set; one reader; 14 families",
    notes: `Identity is a graph of typed links, not one merged record. A shared submission number establishes that two records describe one authorization and nothing more. Each link has a state: confirmed only by an exact identifier or a reviewer, candidate with a score, ambiguous, or rejected. The picture is a real ambiguous link from the Transpara case: a study that reports software version 1.7.0 against the cleared 1.7.2. The waterfall shows how the evidence adds to 1.7 bits, inside the uncertain band of 1 to 2 bits, so it is shown to the reviewer with the flag 'version differs' and is not merged. Results on 144 labelled pairs over 14 device families, each family held out in turn: no false merges in 60 non-matches, against 23 of 60 for a fuzzy-name baseline; precision 48 of 48. Recall is the weak number, 48 of 62: the 14 other true links are shown as ambiguous or not proposed. One reader wrote the labels; this is a development set.`,
    html: () => {
      const d = json("output_examples/dossiers/transpara-k221347.dossier.json").body;
      const l = d.links.find((x) => (x.flags ?? []).some((f) => f.startsWith("version-differs")));
      if (!l) throw new Error("no version-differs link in the Transpara dossier");
      const flag = l.flags.find((f) => f.startsWith("version-differs")).replace(/^version-differs: /, "").replace(/ \(.*/, "");
      const w = l.waterfall.filter((x) => x.weight !== 0);
      const maxW = Math.max(...w.map((x) => Math.abs(x.weight)));
      const total = l.score;
      const wf = `<svg viewBox="0 0 780 330" width="100%" role="img" aria-label="Match weight waterfall of an ambiguous link">
        <text x="0" y="30" font-size="25" font-weight="600">Study vs. cleared product, ${total} bits</text>
        ${w.map((x, i) => `<text x="0" y="${86 + i * 62}" font-size="24" font-weight="600">${x.field}</text><text x="0" y="${108 + i * 62}" font-size="17" class="m f3">${x.level}</text><rect x="330" y="${68 + i * 62}" width="${(Math.abs(x.weight) / maxW) * 300}" height="34" fill="var(--ink)"/><text x="${338 + (Math.abs(x.weight) / maxW) * 300}" y="${94 + i * 62}" font-size="22" class="m" font-weight="500">${x.weight > 0 ? "+" : ""}${x.weight}</text>`).join("")}
        <rect x="330" y="${68 + w.length * 62 + 4}" width="300" height="2" fill="var(--line-strong)"/>
        <text x="0" y="${100 + w.length * 62 + 18}" font-size="23" font-weight="600">Uncertain band</text><text x="330" y="${100 + w.length * 62 + 18}" font-size="22" class="m">1 to 2 bits: shown, never merged</text>
      </svg>`;
      const prec = stat("evals/results/identityshift.json", "resolver.precision");
      const rec = stat("evals/results/identityshift.json", "resolver.recall");
      const fm = stat("evals/results/identityshift.json", "resolver.falseMergeRate");
      const ffm = stat("evals/results/identityshift.json", "fuzzyNameBaseline.falseMergeRate");
      const ab = stat("evals/results/identityshift.json", "resolver.correctAbstention");
      const types = [["SAME_SUBMISSION", "one authorization"], ["SAME_PRODUCT", "one product line"], ["SAME_MARKETED_VERSION", "one software release"], ["STUDY_EVALUATES", "a study tested this product"], ["PUBLICATION_REPORTS", "a paper reports this study"]];
      return `
      ${head("Identity resolution", "Link what is exact. Keep the rest uncertain.")}
      <div class="row" style="gap:44px; margin-top:26px; flex:1; min-height:0">
        <div class="col" style="width:520px; gap:0">
          <div class="tag" style="margin-bottom:10px">Five link types, each its own claim</div>
          ${types.map(([t, d]) => `<div style="border-top:2px solid var(--line); padding:9px 0"><div class="mono b" style="font-size:21px">${t}</div><div class="ink-2" style="font-size:23px">${d}</div></div>`).join("")}
          <div class="mt-s" style="display:flex; gap:8px; flex-wrap:wrap">${chip("CONFIRMED", "green")}${chip("CANDIDATE", "dash")}${chip("AMBIGUOUS", "dash")}${chip("REJECTED")}</div>
          <p class="xs ink-2 mt-s">Only an exact identifier or a reviewer confirms. A score cannot.</p>
        </div>
        <div class="grow">${wf}
          <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap">${chip("version differs: " + esc(flag), "dash")}${chip("family name shared by 6 reference rows", "dash")}</div>
          <p class="xs ink-3 mt-s">A real ambiguous link from the Transpara case.</p>
        </div>
        <div class="col" style="width:470px; gap:14px">
          ${statBlock(`${fm.k} of ${fm.n}`, `false merges, against ${ffm.k} of ${ffm.n} for a fuzzy-name baseline`, { size: "md", tone: "green" })}
          ${statBlock(`${prec.k} of ${prec.n}`, "links called were true (precision)", { size: "sm" })}
          ${statBlock(`${rec.k} of ${rec.n}`, `true links found: recall ${rec.rate.toFixed(2)}, the weak number`, { size: "sm", tone: "rust" })}
          <p class="xs ink-2">${ab.k} of ${ab.n} ambiguous pairs left ambiguous. 144 pairs, 14 families held out in turn, one reader, a development set.</p>
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 16
  {
    id: "loop",
    section: "Agent workflow",
    crit: "Technical 20",
    sources: ["output_examples/traces/transpara-k221347.trace.jsonl", "output_examples/traces/eyeart-k200667.trace.jsonl", "output_examples/traces/lunit-k211733.trace.jsonl", "src/agents/investigation.ts", "docs/05-requirements-matrix.md"],
    derived: [],
    cls: "recorded traces; critic changed no label",
    notes: `This is not a linear pipeline, and the slide says where it is and is not an agent loop. A bounded state machine runs roles: guard, discoverer, planner, retriever, extractor, resolver, compiler, critic, reporter. The planner delegates, and when the compiler finds a required dimension still unknown, the planner replans and reads more candidate records; the Transpara trace shows two such replans. The critic combines code checks with an adversarial Nemotron pass. State is shared through the World Model, H-MEM and a per-case budget that keeps its last three model calls for the planner, critic and reporter. Against the organizers' nine-point checklist, seven behaviours are visible in the recorded traces. Two are not: revision after a critic objection, because in these runs the critic confirmed no objection and changed no label, and a model or source fallback, which the drills exercise but the recorded traces do not show. The labels come from the compiler, not from any model.`,
    html: () => {
      const roles = [
        ["Guard", "rules"], ["Discoverer", "model + code"], ["Planner", "model + rules"], ["Retriever", "code"], ["Extractor", "model + code"], ["Resolver", "model in band"], ["Compiler", "code only"], ["Critic", "code + model"], ["Reporter", "model + code"],
      ];
      const nw = 170, gap = 18;
      const nodes = roles.map(([n, t], i) => { const x = i * (nw + gap); const code = t.startsWith("code only"); return `<rect x="${x}" y="40" width="${nw}" height="90" fill="${code ? "var(--ink)" : "var(--paper)"}" stroke="var(--ink)" stroke-width="3"/><text x="${x + nw / 2}" y="82" text-anchor="middle" font-size="26" font-weight="600" ${code ? 'class="fp"' : ""}>${n}</text><text x="${x + nw / 2}" y="112" text-anchor="middle" font-size="19" class="m ${code ? "fp" : "f2"}">${t}</text>${i < 8 ? `<path d="M${x + nw + 2} 85 h${gap - 4}" class="arrow-line"/>` : ""}`; }).join("");
      const cx = (i) => i * (nw + gap) + nw / 2;
      const replan = `<path d="M${cx(6)} 134 v30 h-${cx(6) - cx(2)} v-30" fill="none" stroke="var(--green)" stroke-width="4" stroke-dasharray="10 7"/><path d="M${cx(2)} 134 l-8 12 h16z" fill="var(--green)"/><text x="${(cx(6) + cx(2)) / 2}" y="198" text-anchor="middle" font-size="22" class="m fg" font-weight="500">replan: a required dimension is still unknown</text>`;
      const revise = `<path d="M${cx(7)} 134 v62 h-${cx(7) - cx(6) - 46}" fill="none" stroke="var(--ink)" stroke-width="3" stroke-dasharray="4 6"/><text x="1670" y="198" font-size="21" class="m f2">objection: revise or downgrade</text>`;
      const tr = traceEvents("output_examples/traces/transpara-k221347.trace.jsonl");
      const pick = (role, re) => tr.find((e) => e.role === role && re.test(e.decision));
      const ex = [
        pick("guard", /request understood/),
        pick("planner", /^plan:/),
        pick("planner", /^replan:/),
        pick("critic", /adversarial model raised/),
      ];
      if (ex.some((e) => !e)) throw new Error("trace excerpt not found");
      const replans = ["transpara-k221347", "eyeart-k200667", "lunit-k211733"].flatMap((c) => traceEvents(`output_examples/traces/${c}.trace.jsonl`)).filter((e) => /^replan:/.test(e.decision)).length;
      derive(replans, "replan events across the three committed traces");
      const total = ["transpara-k221347", "eyeart-k200667", "lunit-k211733"].reduce((s, c) => s + traceEvents(`output_examples/traces/${c}.trace.jsonl`).length, 0);
      derive(total, "trace lines across the three committed traces");
      const checklist = [
        ["Planner delegates sub-tasks", 1], ["Specialist uses data or tools", 1], ["Evaluator critiques the output", 1], ["Agent revises after critique", 0],
        ["A safety role flags unsupported claims", 1], ["Structured messages in shared state", 1], ["Workflow branches on confidence", 1], ["Fallback if a source or model fails", 0], ["Final answer carries traceable evidence", 1],
      ];
      return `
      ${head("Agent workflow", "A bounded loop that replans and critiques.")}
      <svg viewBox="0 0 1680 215" width="100%" style="margin-top:18px" role="img" aria-label="Roles of the investigation loop with the replan and critique branches">${nodes}${replan}${revise}</svg>
      <div class="row" style="gap:40px; margin-top:12px; flex:1; min-height:0">
        <div style="flex:1.25; min-width:0">
          <div class="tag" style="margin-bottom:8px">Real trace lines, Transpara case (${total} lines across three cases, ${replans} replans)</div>
          <div style="border:2px solid var(--ink); background:var(--paper-2); padding:14px 18px; font-family:var(--mono); font-size:19px; line-height:1.36; color:var(--ink-2)">
            ${ex.map((e) => `<div style="margin-bottom:8px"><span class="green b">${e.role}</span> &nbsp;${esc(e.decision.length > 150 ? e.decision.slice(0, 148) + "..." : e.decision)}</div>`).join("")}
          </div>
        </div>
        <div style="flex:1; min-width:0">
          <div class="tag" style="margin-bottom:8px">The organizers' nine behaviours</div>
          <div style="display:grid; grid-template-columns:1fr; gap:3px">
            ${checklist.map(([t, ok]) => `<div style="display:flex; gap:12px; align-items:center; font-size:22px"><span style="width:26px; flex:none; font-weight:600; color:${ok ? "var(--green)" : "var(--rust)"}">${ok ? "&#10003;" : "&#10007;"}</span><span>${t}</span>${ok ? "" : '<span class="mono rust" style="font-size:18px">not in the recorded runs</span>'}</div>`).join("")}
          </div>
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 17
  {
    id: "compiler",
    section: "The Applicability Compiler",
    crit: "Innovation 15",
    sources: ["docs/02-architecture.md", "evals/results/scopeshift-a.json", "docs/DECISIONS.md", "docs/reports/applicability-rule-registry.md"],
    cls: "consistency: code against the rule table its authors wrote",
    notes: `The compiler is the distinguishing invention and it uses no model. It takes the intended use and the evidence scope, compares seven dimensions, each as contained, partial, disjoint or unknown, and a fixed table maps that to one of five labels. Authority depends on the kind of assertion: what use was authorized comes from the regulator's record and no study can widen it; what a study measured comes from the study report; what this hospital requires comes from its own policy; what the vendor says is only a claim to be checked. The controlled test changes exactly one dimension at a time on 18 real FDA summaries. 218 of 222 cases agree with the rule table, 24 of 24 positive controls come out supported, and none of the 198 cases whose key withholds support was labelled supported. That is a consistency result: it shows the code does what the table says, not that the table is clinically right. No standard prescribes deterministic applicability checks; the concepts are cited and the executable logic is our design inference. 17 of the 38 candidate registry rules are implemented, 17 more are ours, and 21 are not implemented, each with a reason.`,
    html: () => {
      const ex = stat("evals/results/scopeshift-a.json", "exactLabel");
      const pc = stat("evals/results/scopeshift-a.json", "positiveControlCorrectSupported");
      const fs = stat("evals/results/scopeshift-a.json", "falseSupported");
      const impl = grabInt("docs/DECISIONS.md", /(17) registry rules are implemented/, "implemented");
      const unimpl = grabInt("docs/DECISIONS.md", /(21) of the 38 candidate registry rules are not implemented/, "unimplemented");
      const dims = [
        ["Product", "same product"], ["Version", "exact, same release line, unknown"], ["Population", "age interval, conditions, exclusions"], ["Setting", "ED < hospital < any care setting"],
        ["Purpose", "triage < detection aid < diagnosis"], ["Timing", "use date inside the evidence period"], ["Metric", "claimed operating point"],
      ];
      const labels = [
        ["SUPPORTED_FOR_SCOPE", "every dimension contained, every required source adequate"],
        ["SUPPORTED_ONLY_FOR_NARROWER_SCOPE", "a narrower use is itself contained"],
        ["CONTRADICTED_BY_SPECIFIED_EVIDENCE", "relevant, adequate evidence disagrees"],
        ["INSUFFICIENT_EVIDENCE", "a required dimension or source is unknown or lost"],
        ["REQUIRES_DOMAIN_REVIEW", "the rule needs clinical judgement"],
      ];
      const auth = [["What use was authorized", "regulator record"], ["What a study measured", "the study report"], ["What this hospital requires", "its own policy"], ["What the vendor says", "a claim to check"]];
      return `
      ${head("The Applicability Compiler", "Seven dimensions in, one of five labels out. No model.")}
      <div class="row" style="gap:36px; margin-top:24px; flex:1; min-height:0">
        <div style="flex:1; min-width:0">
          <div class="tag" style="margin-bottom:8px">Compared one by one</div>
          ${dims.map(([a, b]) => `<div style="display:flex; justify-content:space-between; gap:12px; border-top:2px solid var(--line); padding:7px 0"><span class="b" style="font-size:26px">${a}</span><span class="ink-2" style="font-size:21px; text-align:right">${b}</span></div>`).join("")}
          <div style="margin-top:12px; display:flex; gap:8px; flex-wrap:wrap">${["CONTAINED", "PARTIAL", "DISJOINT", "UNKNOWN"].map(relBadge).join("")}</div>
        </div>
        <div style="flex:1.15; min-width:0">
          <div class="tag" style="margin-bottom:8px">A fixed table decides the label</div>
          ${labels.map(([l, d]) => `<div style="padding:7px 0; border-top:2px solid var(--line)">${labelBadge(l, "sm")}<div class="ink-2" style="font-size:21px; margin:4px 0 0 4px">${d}</div></div>`).join("")}
        </div>
        <div style="flex:0.9; min-width:0">
          <div class="tag" style="margin-bottom:8px">Authority depends on the question</div>
          ${auth.map(([a, b]) => `<div style="border-top:2px solid var(--line); padding:7px 0"><div style="font-size:23px; font-weight:600; line-height:1.2">${a}</div><div class="green" style="font-size:22px">${b}</div></div>`).join("")}
          <p class="xs ink-2 mt-s">A study cannot widen what was authorized. A later document is not a stronger one.</p>
        </div>
      </div>
      <div class="row" style="gap:30px; margin-top:10px; align-items:center; border-top:3px solid var(--ink); padding-top:14px">
        ${statBlock(`${ex.k} of ${ex.n}`, "single-change cases agree with the rule table", { size: "sm" })}
        ${statBlock(`${pc.k} of ${pc.n}`, "positive controls supported", { size: "sm" })}
        ${statBlock(`${fs.k} of ${fs.n}`, "withheld-support cases labelled supported", { size: "sm", tone: "green" })}
        <p class="xs ink-2" style="max-width:520px">Consistency, not clinical validity. Concepts are cited from PROBAST+AI, STARD-AI and others; the executable logic is our inference. ${impl} of 38 registry rules are implemented, ${unimpl} are not, each with a reason.</p>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 18
  {
    id: "labels",
    section: "What the product refuses to say",
    sources: ["README.md", "data/sample/run/labels.json", "tests/engines/scout/RESULTS.md", "docs/DECISIONS.md"],
    derived: [],
    cls: "labels describe evidence coverage, not a safety rating",
    notes: `Five labels, and they are not a scale from worse to better. They describe what the evidence covers. The product never outputs safe, cleared or compliant; the label type is closed, the reporter rejects banned wording in code, and a request to certify something safe is blocked by the guard. Unknown is never false and never safe. A source that was down is never reported as a source that had nothing to say: those are different states with different words. On the recorded EyeArt case the ten vendor claims come out one supported, three supported only for a narrower use, one contradicted, two not enough evidence and three that need domain review. The guard blocked 25 of 34 certify-this requests in its own corpus and the other 9 were routed to clarification; the held-out figure is weaker and is on the safety slide.`,
    html: () => {
      const claims = labelsRun().claims.filter((c) => c.claimId.startsWith("CLM-"));
      const n = (l) => derive(claims.filter((c) => c.label === l).length, `recorded ${l} claims of the ten`);
      const all = Object.keys(LABELS);
      const cert = grab("tests/engines/scout/RESULTS.md", /\| certify_safe: blocked \| (73\.5% \(25\/34)/);
      return `
      ${head("What the product refuses to say", "Five labels. None of them says safe.")}
      <div class="g5" style="margin-top:26px; align-items:stretch">
        ${all
          .map((l) => `<div class="card" style="display:flex; flex-direction:column; gap:14px; padding:20px 20px">${labelBadge(l, "sm wrap")}<p class="ink-2" style="font-size:23px; line-height:1.3; flex:1">${LABELS[l].gloss}</p><div style="border-top:2px solid var(--line); padding-top:10px"><span class="mono b" style="font-size:44px">${n(l)}</span><span class="ink-3" style="font-size:21px; margin-left:8px">of 10 EyeArt claims</span></div></div>`)
          .join("")}
      </div>
      <div class="g2" style="margin-top:26px; gap:36px; flex:1; min-height:0">
        ${card(`<div class="tag rust">The product never says</div><div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:12px">${["safe", "cleared", "compliant"].map((w) => `<span class="chip rust" style="font-size:25px; text-decoration:line-through">${w}</span>`).join("")}</div><p class="sm ink-2 mt-s">The label type is closed. The reporter drops any sentence with banned wording. A request to certify a product safe is blocked by the guard.</p>`, "rust")}
        ${card(`<div class="tag green">What it keeps apart</div>${pts(["Unknown is never false and never safe.", "A source that was down is never a source with nothing to say.", "Needs domain review is a refusal to decide, not a middle score.", "The Lunit and Transpara cases stay not enough evidence throughout."], "g")}`, "green")}
      </div>
      <p class="xs ink-3" style="margin-top:8px">Guard on its own corpus: certify-this requests blocked ${cert.replace(/^73\.5% \(/, "").replace("/", " of ")}; the rest are sent to clarification. Held-out wording is weaker (slide 28).</p>`;
    },
  },

  // ------------------------------------------------------------------ 19
  {
    id: "xray-lab",
    section: "Claim X-ray and Applicability lab",
    sources: ["output_examples/api/recompute-release-3-0.json", "evals/results/failureshift.json"],
    cls: "sample mode, recorded replies",
    notes: `Two screens of the product. On the left, the Claim X-ray for the claim that version 3.0 is covered: the answer, then each dimension with what the claim says beside what the evidence establishes and a button to open the exact passages, each with its page, source and retrieval date. On the right, the Applicability lab: the reviewer changes the software version to 3.0 and the answer recomputes in the browser from needs-domain-review to not-enough-evidence, with the one dimension that moved shown, and the badge says no model was called. The same lab changes ages, setting, purpose or the date of use. The banner at the top of every screen says that the run is a sample run replayed from recordings.`,
    html: () => `
      ${head("Claim X-ray and Applicability lab", "See the mismatch. Change the use.")}
      <div class="g2" style="margin-top:24px; gap:44px; flex:1; min-height:0; align-items:start">
        ${shot("xray-version-2.png", "Claim X-ray: vendor claim EA-04", "Claim X-ray: the claim says 3.0, the evidence establishes 2.1.0. Each dimension opens to the exact passages.", { h: 585, top: 90, left: 70, zoom: 124 })}
        ${shot("lab-after.png", "Applicability lab: software version 3.0", "Applicability lab: version changed to 3.0. Answer recomputed, one dimension moved, no model called.", { h: 585, top: 40, left: 40, zoom: 122 })}
      </div>`,
  },

  // ------------------------------------------------------------------ 20
  {
    id: "ux",
    section: "Product and UX",
    crit: "Product and UX 10",
    sources: ["docs/05-requirements-matrix.md", "ui/src/screens"],
    derived: [],
    cls: "automated checks; no moderated user session",
    notes: `Product and UX, in the judges' words: how intuitive, accessible and easy to use is the product for its intended users. The product is a review workstation, not a chat box: a review desk, a source console, and for each case an overview, the evidence matrix, the claim X-ray, the lab, a timeline, the investigation trace, the resilience drills and the dossier. Findings always use words and an icon, never colour alone. A banner on every screen states whether the run is a sample or live, and which parts are recorded. Automated checks cover axe in light, dark and phone layouts, keyboard-only flows, layouts from 360 to 1440 pixels and 200 percent zoom. What is missing is a moderated session with a real reviewer.`,
    html: () => {
      const screens = derive(readdirSync(resolve(ROOT, "ui/src/screens")).filter((f) => f.endsWith(".tsx")).length, "files in ui/src/screens");
      return `
      ${head("Product and UX", "A review workstation, not a chat box.")}
      ${ask("How intuitive, accessible, and easy to use is the product for its intended users?", "Product and UX, 10 points")}
      <div class="row" style="gap:40px; margin-top:22px; flex:1; min-height:0">
        <div style="width:780px; flex:none">${shot("desk.png", "/cases", "Review desk: open questions per case", { h: 470, top: 140, left: 110, zoom: 140 })}</div>
        <div class="col grow" style="gap:12px">
          ${pts([
            `${screens} screens, among them the desk, sources, guard, and per case an overview, matrix, X-ray, lab, timeline, investigation, drills and dossier`,
            "Words and an icon on every finding, never colour alone",
            "A run-mode banner on every screen: sample or live, recorded or fresh",
            "Light and dark themes; keyboard-only flows",
            "Constructed claims are marked constructed on screen",
          ])}
          <div class="card soft" style="padding:16px 22px"><div class="tag green">Checked by machine</div><p class="xs mt-s">axe in light, dark and phone layouts; keyboard-only flows; 360 to 1440 px; 200 percent zoom; copy lint</p></div>
          <div class="card rust" style="padding:16px 22px"><div class="tag rust">Not done</div><p class="xs mt-s">No moderated session with a real reviewer.</p></div>
        </div>
      </div>`;
    },
  },
];
