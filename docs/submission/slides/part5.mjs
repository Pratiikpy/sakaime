// Slides 29 to 36: how it was evaluated, every result row, ablations, reproduction, limits, provenance, what is next.
import { grab, grabInt, json, text, stat, mdTable } from "../lib/data.mjs";
import { esc, labelBadge, chip, card, pts, tbl, shot, icon, stat as statBlock } from "../lib/ui.mjs";
import { derive, ask } from "../lib/ctx.mjs";

const head = (kicker, title, lead = "") => `<div class="kicker">${kicker}</div><h2>${title}</h2>${lead ? `<p class="lead">${lead}</p>` : ""}`;
const RESULTS = "evals/RESULTS.md";
const DEV = "evals/results/scopeshift-b-dev.json";
const HO = "evals/results/scopeshift-b-held-out.json";
const DISC = "data/discovery-shift/RESULTS.md";
const ABL = "tests/engines/ABLATIONS.md";
const MA3 = "tests/engines/markovian/MA3-RESULTS.md";
const SCOUT = "tests/engines/scout/RESULTS.md";
const pc = (x, d = 1) => `${(x * 100).toFixed(d)}%`;

export const part5 = [
  // ------------------------------------------------------------------ 29
  {
    id: "eval-design",
    section: "How it was evaluated",
    sources: ["evals/RESULTS.md", "evals/ERRATA.md", "evals/SEALED.md", "evals/results/scopeshift-a.json", "evals/results/identityshift.json", "evals/results/timeshift.json", "evals/results/failureshift.json", "data/discovery-shift/RESULTS.md"],
    derived: [],
    cls: "every number links to a row of a results file",
    notes: `Six result sets in five suites, each with its class stated next to the number. Consistency means the code is compared with a rule table or specification the same builders wrote: it shows the code does what the table says and nothing about whether the table is clinically right. Builder-labelled means scored against labels one builder wrote from the source documents. Domain-validity would need qualified, blind reviewers; there are none, so this deck contains none. No sentence claims clinical or independent validation. The held-out set of 20 claims over five devices was sealed by file hash before any system ran, but the extraction layer was not blind to those five documents and later changes were made after the first held-out score, so the held-out numbers are a second look and the slides say so. The erratum log has seven entries; the first records that the Gate 0 answer key was edited after the builder saw a dry run of the compiler. Cases of one device are correlated, so intervals come from a bootstrap over devices, and the effective sample size is the number of devices.`,
    html: () => {
      const a = stat("evals/results/scopeshift-a.json", "exactLabel");
      const fm = stat("evals/results/identityshift.json", "resolver.falseMergeRate");
      const ts = stat("evals/results/timeshift.json", "staleSetEqualsDependentSet");
      const fs = stat("evals/results/failureshift.json", "correctState");
      const first = grab(DISC, /\| full \(run1\) \| (\d+\/\d+) = /);
      const firstNot = grab(DISC, /\| full \(run1\) \| [^|]+\| [^|]+\| (\d+\/\d+) = 100\.0%/);
      const nErr = derive(new Set([...text("evals/ERRATA.md").matchAll(/\b(E-00\d)\b/g)].map((m) => m[1])).size, "distinct erratum ids in evals/ERRATA.md");
      const sealed = grab("evals/SEALED.md", /(a7e06def)/);
      const sealedKey = grab("evals/SEALED.md", /(fcd1327e)/);
      const rows = [
        ["DiscoveryShift", "unknown schemas and meaning changes", "102 layouts, 4 base tables", "consistency, one labeller", `first run ${first} mapped, ${firstNot} caught`],
        ["IdentityShift", "similar devices, one true match", "144 pairs, 14 families", "builder-labelled, dev set", `${fm.k} of ${fm.n} false merges`],
        ["ScopeShift (A)", "one dimension changed at a time", "222 cases, 17 families", "consistency", `${a.k} of ${a.n} agree`],
        ["ScopeShift (B)", "authentic claims, same inputs for all arms", "26 dev + 20 sealed, 12 + 5 devices", "builder-labelled", "next slide"],
        ["TimeShift", "a source changes after a finding", "27 cases, 5 devices", "consistency", `stale set equals dependent set, ${ts.k} of ${ts.n}`],
        ["FailureShift", "faults through the real ports", "157 drills", "consistency", `${fs.k} of ${fs.n} correct state`],
      ];
      return `
      ${head("How it was evaluated", "Five suites. The class of every result is printed beside it.")}
      <div style="margin-top:18px">${tbl(["Suite", "Tests", "Size", "Class", "Result"], rows.map((r) => [`<b>${r[0]}</b>`, r[1], r[2], `<span class="chip ${/builder/.test(r[3]) ? "dash" : ""}" style="font-size:19px">${r[3]}</span>`, r[4]]), "tight")}</div>
      <div class="g3" style="margin-top:20px; gap:24px; flex:1; align-items:stretch; min-height:0">
        ${card(`<div class="tag green">Three classes</div>${pts(["Consistency: code against a rule table its authors wrote", "Builder-labelled: one builder's answer key", "Domain-validity: needs blind clinicians. None exists, so this deck has none"], "g")}`, "soft")}
        ${card(`<div class="tag green">Sealed held-out set</div><p style="font-size:23px; line-height:1.3; margin-top:6px">20 claims, 5 devices, sealed by file hash before any system ran: claims <span class="mono">${sealed}</span>, key <span class="mono">${sealedKey}</span>. The extraction layer was not blind to those documents, so this is a second look, not a blind test.</p>`, "soft")}
        ${card(`<div class="tag rust">Erratum log: ${nErr} entries</div><p style="font-size:23px; line-height:1.3; margin-top:6px">E-001: the Gate 0 key was edited after the builder saw a dry run of the compiler, so all 26 Gate 0 claims count as development. E-005: changes followed the first held-out score.</p>`, "rust")}
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 30
  {
    id: "results",
    section: "Results, every row",
    sources: [RESULTS, DEV, HO],
    derived: [],
    cls: "builder-labelled; ScopeShift (B); constructed claims; held-out is a second look",
    notes: `Every row of the same-input comparison, including the unfavourable ones. Three panels, two bars per arm: development and held-out. Left: how often the exact label is right. Sakaime is 9 of 26 on development and 9 of 20 held-out, which is below both generic Nemotron arms. Middle: how often an unsupported claim is labelled supported. Sakaime: none of 17 and none of 15. The generic arms do it for 20 to 39 percent, and keyword and source-by-source baselines for 53 to 77 percent. Right: the cost. On well-supported claims Sakaime raises a false alarm on 9 of 9 development claims and 4 of 5 held-out, because the source documents leave a dimension unplaced. So the advantage is that it does not over-claim, not exact-label accuracy. The comparisons are underpowered, 26 claims in 12 device families, and a p-value above 0.05 here is a tie, not equivalence. The generic arms ran three times for one call and once for the agent; means are shown.`,
    html: () => {
      const g = (f, pre, arm, metric) => {
        const s = json(f).summaries;
        const mw = s[`${pre}.${arm}.${metric}.meanWorst`];
        return mw ? mw.mean : s[`${pre}.${arm}.${metric}`].rate;
      };
      const arms = [
        ["Sakaime", "V", true], ["Keyword rules", "B1"], ["Source by source", "B2"], ["One Nemotron call", "B3"], ["Tool-using agent", "B4"],
      ];
      const panels = [
        { title: "Exact label right", metric: "exact", good: "ink", note: "higher is better" },
        { title: "Unsupported called supported", metric: "falseSupported", good: "green", bad: "rust", note: "lower is better" },
        { title: "Well-supported claims flagged", metric: "falseAlarm", good: "ink", sak: "rust", note: "lower is better" },
      ];
      const rowH = 108, top = 62, W = 560, lab = 0;
      const svgPanel = (p, withLabels) => {
        const bars = arms.map(([name, key, me], i) => {
          const y = top + i * rowH;
          const dv = g(DEV, "dev", key, p.metric), hv = g(HO, "heldout", key, p.metric);
          const col = p.metric === "falseSupported" ? (me ? "var(--green)" : "var(--rust)") : p.metric === "falseAlarm" ? (me ? "var(--rust)" : "var(--ink)") : me ? "var(--green)" : "var(--ink)";
          const tw = 360;
          return `${withLabels ? `<text x="0" y="${y + 46}" font-size="24" ${me ? 'font-weight="600"' : ""}>${name}</text>` : ""}
            <rect x="${lab}" y="${y + 6}" width="${tw}" height="30" fill="var(--paper-3)"/><rect x="${lab}" y="${y + 6}" width="${Math.max(2, dv * tw)}" height="30" fill="${col}" opacity="0.45"/>
            <text x="${lab + tw + 10}" y="${y + 30}" font-size="22" class="m">${pc(dv)}</text>
            <rect x="${lab}" y="${y + 44}" width="${tw}" height="30" fill="var(--paper-3)"/><rect x="${lab}" y="${y + 44}" width="${Math.max(2, hv * tw)}" height="30" fill="${col}"/>
            <text x="${lab + tw + 10}" y="${y + 68}" font-size="22" class="m" font-weight="500">${pc(hv)}</text>`;
        }).join("");
        return `<svg viewBox="0 0 ${withLabels ? 700 : 520} ${top + arms.length * rowH}" width="100%" role="img" aria-label="${p.title}"><text x="${withLabels ? 0 : 0}" y="26" font-size="27" font-weight="600">${p.title}</text><text x="0" y="52" font-size="20" class="m f3">${p.note}</text>${bars}</svg>`;
      };
      // panel 1 carries the row labels via a separate column
      const labels = `<svg viewBox="0 0 250 ${top + arms.length * rowH}" width="100%">${arms.map(([n, , me], i) => `<text x="0" y="${top + i * rowH + 54}" font-size="25" ${me ? 'font-weight="600"' : ""}>${n}</text>`).join("")}</svg>`;
      const svgNoLab = (p) => svgPanel(p, false).replace(/<svg viewBox="0 0 520/, '<svg viewBox="0 0 520');
      const fsv = [g(DEV, "dev", "B3", "falseSupported"), g(DEV, "dev", "B4", "falseSupported"), g(HO, "heldout", "B3", "falseSupported"), g(HO, "heldout", "B4", "falseSupported")];
      const lo = derive((Math.min(...fsv) * 100).toFixed(1), "lowest generic-arm false-supported rate, percent");
      const hi = derive((Math.max(...fsv) * 100).toFixed(1), "highest generic-arm false-supported rate, percent");
      const fsd = stat(DEV, "dev.V.falseSupported"), fsh = stat(HO, "heldout.V.falseSupported");
      const bs = [g(DEV, "dev", "B1", "falseSupported"), g(DEV, "dev", "B2", "falseSupported"), g(HO, "heldout", "B1", "falseSupported"), g(HO, "heldout", "B2", "falseSupported")];
      const blo = derive((Math.min(...bs) * 100).toFixed(1), "lowest keyword-baseline false-supported rate, percent");
      const bhi = derive((Math.max(...bs) * 100).toFixed(1), "highest keyword-baseline false-supported rate, percent");
      const vdev = stat(DEV, "dev.V.exact"), vho = stat(HO, "heldout.V.exact");
      const fa = stat(DEV, "dev.V.falseAlarm"), fah = stat(HO, "heldout.V.falseAlarm");
      return `
      ${head("Results, every row", "It never over-claims. It is less often exactly right.")}
      <div class="row" style="gap:30px; margin-top:16px; align-items:flex-start; flex:1; min-height:0">
        <div style="width:210px; flex:none; padding-top:0">${labels}</div>
        <div style="flex:1; min-width:0">${svgNoLab(panels[0])}</div>
        <div style="flex:1; min-width:0">${svgNoLab(panels[1])}</div>
        <div style="flex:1; min-width:0">${svgNoLab(panels[2])}</div>
      </div>
      <div class="row" style="gap:14px; margin-bottom:6px; align-items:center"><span class="chip" style="font-size:19px"><i style="display:inline-block; width:28px; height:12px; background:var(--ink); opacity:0.45"></i> development, 26 claims</span><span class="chip" style="font-size:19px"><i style="display:inline-block; width:28px; height:12px; background:var(--ink)"></i> held-out, 20 claims</span><span class="xs ink-3">Generic Nemotron arms: means over 3 runs (one call) and 1 run (agent).</span></div>
      <div class="g3" style="gap:20px; margin-bottom:0">
        ${card(`<p style="font-size:22px; line-height:1.28"><b>Exact label:</b> ${vdev.k} of ${vdev.n} dev, ${vho.k} of ${vho.n} held-out. Below both generic arms.</p>`, "soft")}
        ${card(`<p style="font-size:22px; line-height:1.28"><b>Unsupported called supported:</b> ${fsd.k} of ${fsd.n} and ${fsh.k} of ${fsh.n}. Generic arms ${lo}% to ${hi}%; keyword and source-by-source baselines ${blo}% to ${bhi}%.</p>`, "green")}
        ${card(`<p style="font-size:22px; line-height:1.28"><b>The cost:</b> well-supported claims flagged ${fa.k} of ${fa.n} dev and ${fah.k} of ${fah.n} held-out. It does not over-claim; it also under-confirms.</p>`, "rust")}
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 31
  {
    id: "ablations",
    section: "Ablations",
    sources: [RESULTS, DISC, ABL, MA3, SCOUT, "data/identity-corpus/RESULTS.md"],
    derived: [],
    cls: "pre-registered components; null and by-construction results marked",
    notes: `Every component has an ablation, and the status column says which are measured, which are by construction, which are null and which were not measured. Compiler off: the generic arms are more often exactly right and over-claim; that is the central trade. Compiler on complete hand-written evidence reaches 61.5 percent exact, but those items encode the key's own vocabulary, so it is an upper bound and not a result. Identity layer off: the same 9 of 26 exact labels, a null result on this metric; its effect shows in IdentityShift and in what reaches the compiler: of 53 candidate studies and papers, none of the 21 non-matches and none of the 11 ambiguous ones reach it. Cross-source checks off and model off both cost discovery outcomes. World Model off is by construction. H-MEM, Markovian and Scout are on constructed or small sets. Not measured: the critic role, in whose traces no label changed, the Nightshift receipts ablation, federation off as an accuracy ablation, and Zetaris natural language, which is blocked.`,
    html: () => {
      const v = stat(DEV, "dev.V.exact"), b3 = json(DEV).summaries["dev.B3.exact.meanWorst"], b4 = json(DEV).summaries["dev.B4.exact.meanWorst"];
      const vm1 = stat(DEV, "dev.V-M1.exact"), vni = stat(DEV, "dev.V-noident.exact");
      const fm = stat("evals/results/identityshift.json", "resolver.falseMergeRate"), ffm = stat("evals/results/identityshift.json", "fuzzyNameBaseline.falseMergeRate");
      const nj = text(DISC).match(/\| nojoin \(run2\) \| \d+\/\d+ = [^|]+\| (\d+) \/ \d+ \/ \d+ \| \d+\/\d+ = [^|]+\| (\d+) \(/);
      const lx = text(DISC).match(/\| lexical \(run2\) \| (\d+)\/48 = [^|]+\| \d+ \/ \d+ \/ (\d+) \|/);
      const wmAbs = grab(ABL, /\| World Model absent \| \d+ \| \d+ \| 0 \| \*\*(\d+)\*\*/);
      const wmP = grab(ABL, /\| World Model present \| \d+ \| \d+ \| (\d+) \|/), wmT = grab(ABL, /\| World Model present \| (\d+) \|/);
      const nomem = grab(ABL, /\| No memory \| 34 \| \*\*(22)\*\*/), scoped = grab(ABL, /\| H-MEM, scoped to the hospital \| \d+ \| \*\*(\d+)\*\*/);
      const ma = (a) => grab(MA3, new RegExp(`\\| ${a} \\| (\\d/4)`));
      const th = grab(SCOUT, /\| no-injection-layer \| 83\.3% \((\d+\/126)/), tf = grab(SCOUT, /\| full \| 14\.3% \((\d+\/126)/);
      const ret = text(RESULTS).match(/0 of the 21 non-matches and 0 of the 11 ambiguous records reach the compiler/);
      if (!ret) throw new Error("identity retrieval sentence not found");
      const st = { m: chip("measured", "green"), c: chip("by construction", "dash"), n: chip("null result", "dash"), u: chip("upper bound", "dash"), x: chip("not measured", "rust") };
      const rows = [
        ["Compiler off (generic Nemotron arms)", `exact ${pc(b3.mean)} and ${pc(b4.mean)} against ${pc(v.rate)}; they call ${pc(json(DEV).summaries["dev.B3.falseSupported.meanWorst"].mean)} and ${pc(json(DEV).summaries["dev.B4.falseSupported.meanWorst"].mean)} of unsupported claims supported, Sakaime none`, st.m],
        ["Compiler on complete hand-written evidence", `exact ${pc(vm1.rate)} (${vm1.k} of ${vm1.n}); the items encode the key's vocabulary`, st.u],
        ["Identity layer off", `exact ${vni.k} of ${vni.n} against ${v.k} of ${v.n}; effect shown in IdentityShift: false merges ${fm.k} of ${fm.n} against ${ffm.k} of ${ffm.n}`, st.n],
        ["Cross-source checks off", `${nj[1]} of 48 mappable layouts held for lack of corroboration; ${nj[2]} that must not register registered`, st.m],
        ["Model off, in discovery", `${lx[1]} of 48 mapped; ${lx[2]} wrong mappings`, st.m],
        ["World Model off", `${wmAbs} stale findings unflagged by definition; ${wmP} recomputed instead of ${wmT} with it`, st.c],
        ["H-MEM off", `${nomem} repeated questions asked; ${scoped} with scoped memory (constructed session)`, st.m],
        ["Markovian: one full prompt, or truncated", `restriction found ${ma("markovian_ids")} against ${ma("single_full")} and ${ma("single_truncated")}; four documents`, st.m],
        ["Scout injection layer off", `${th} attacks through against ${tf}`, st.m],
        ["Critic role; Nightshift receipts; federation off as an accuracy test", "no label changed by the critic in the traces; the other two were not run", st.x],
      ];
      return `
      ${head("Ablations", "Remove each part. Report what moved.")}
      <div style="margin-top:16px">${tbl(["Component removed", "Result", "Status"], rows.map((r) => [`<b style="font-size:23px">${r[0]}</b>`, `<span style="font-size:22px; line-height:1.25">${r[1]}</span>`, r[2]]), "tight")}</div>`;
    },
  },

  // ------------------------------------------------------------------ 32
  {
    id: "repro",
    section: "Run it yourself",
    crit: "Demo 15",
    sources: ["README.md", ".env.example", "docs/05-requirements-matrix.md", "docs/02-architecture.md"],
    derived: [],
    cls: "judge run in the working tree; clean clone not run",
    notes: `Demo, in the judges' words: how clearly does it show the solution, its functionality, and the value to its intended users. A judge needs no key and no Docker. Clone, install, and run one command that re-verifies the signed dossier hashes, runs the compiler again on the recorded evidence, replays the source-failure drills and prints PASS or FAIL for each claim; in the working tree it printed 67 PASS and no FAIL in about four seconds. Then build the UI and serve it. In sample mode every external read is replayed from recordings made against the real services on 2026-10-27; the compiler, identity scorer, verifiers and guard run for real on those recordings. A question with no recording abstains visibly and never invents an answer, and a banner on every screen says which mode is on. What we did not do: a literal clean-clone run on Windows and Ubuntu. The video follows the same screens.`,
    html: () => {
      const pass = grabInt("docs/05-requirements-matrix.md", /`npm run judge`: (67) lines PASS/, "judge");
      const secs = grab("docs/05-requirements-matrix.md", /(5\.5) s, no key, no network/);
      return `
      ${head("Run it yourself", "One command re-checks the claims offline, with no key.")}
      ${ask("How clearly does the demo show the solution, its functionality, and the value it provides to its intended users?", "Demo, 15 points")}
      <div class="row" style="gap:40px; margin-top:20px; flex:1; min-height:0">
        <div style="flex:1.05; min-width:0">
          <div style="background:var(--ink); color:var(--paper); padding:18px 26px; font-family:var(--mono); font-size:24px; line-height:1.5"><div class="ink-3" style="color:var(--paper-3)"># Node 22.19 or newer</div>git clone https://github.com/Pratiikpy/sakaime.git<br>cd sakaime<br>npm ci<br><span style="color:#46c987">npm run judge</span><br>npm run ui:build<br>npm run serve</div>
          <div class="g2 mt-s" style="gap:16px">
            ${statBlock(`${pass}`, "lines PASS, 0 FAIL, working tree", { size: "sm", tone: "green" })}
            ${statBlock(`${secs}`, "seconds, no key, no network", { size: "sm", unit: "s" })}
          </div>
        </div>
        <div class="col" style="flex:1; gap:14px; min-width:0">
          ${card(`<div class="tag green">What judge does</div>${pts(["Verifies every dossier: hashes, signature, quotes in the stored records", "Changes one byte and requires the verifier to fail", "Re-runs the compiler on the recorded inputs and compares every label", "Replays the source-off drills: never a supported label"], "g")}`, "green")}
          ${card(`<div class="tag">SAMPLE_MODE=true</div><p style="font-size:22px; line-height:1.28; margin-top:4px">Every external read is replayed from recordings of 2026-10-27. The compiler, identity scorer, verifiers and guard run for real. A question with no recording abstains visibly. A banner on every screen says which mode is on.</p>`, "soft")}
          ${card(`<div class="tag rust">Not done</div><p style="font-size:22px; line-height:1.28; margin-top:2px">A clean-clone run on Windows and Ubuntu. Live mode needs Docker for Zetaris and a model route.</p>`, "rust")}
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 33
  {
    id: "checklist",
    section: "Submission components",
    sources: ["research/hackathon/organizer/01-welcome-guide.md", "research/hackathon/organizer/04-approach-guide-solutioning.md", "README.md", ".env.example", ".gitignore", "metadata.json", "docs/07-demo-and-submission.md"],
    derived: [],
    cls: "what the organizers ask, and where it is",
    notes: `The organizers' submission components and their checklist, with where each one is. The deck, the README, the sample inputs and outputs, the traces, the sample mode and the secrets rules are all in the repository and can be checked. The demo video is a separate file of one to four minutes and is not embedded here. The sponsor technology explanation is not a separate document: slides 23 to 27 carry its content and can be pasted into the form. Pre-existing components are declared in the README, the provenance file and metadata.json. Colab links are not applicable. Cursor was not used.`,
    html: () => {
      const ok = (t) => `<span class="lab sm good wrap">${icon("check")}<span>${t}</span></span>`;
      const part = (t) => `<span class="lab sm partial wrap">${icon("check-partial")}<span>${t}</span></span>`;
      const no = (t) => `<span class="lab sm bad wrap">${icon("cross")}<span>${t}</span></span>`;
      const rows = [
        ["Demo video, 1 to 4 minutes", "Main workflow, how the agent solves the challenge, key features, Zetaris and Meterless", "separate file; follows the screens in this deck", part("Separate artefact")],
        ["Slide deck", "Problem and users, solution, workflow, stack, sponsor use, what was unique, visuals, future work", "this document", ok("Here")],
        ["GitHub repository and README", "All source, setup, usage, dependencies; Colab links if used", "README.md; Apache-2.0; no Colab", ok("Present")],
        ["Sponsor technology explanation", "Zetaris, Meterless, Cursor, NVIDIA, what was unique", "slides 23 to 27", part("Here; no separate text")],
        ["Sample inputs, outputs and traces", "What goes in, what comes out, how the agents worked", "input_examples/, output_examples/ (traces/*.jsonl)", ok("Present")],
                ["SAMPLE_MODE fallback", "Runs if an external service is down", ".env.example, recorded cassettes", ok("Present")],
        ["No secrets", ".env ignored; .env.example holds placeholders", ".gitignore, .env.example", ok("Present")],
        ["Project description (HackOS form)", "150 to 2000 characters: problem, mechanism, results with limits", "written for the form, not part of this deck", part("Outside the deck")],
        ["Pre-existing components declared", "Product code and prepared data", "README, docs/provenance.md, metadata.json", ok("Declared")],
        ["Cursor as the development environment", "Required in the organizers' text; optional per moderators", "not used", no("Not done")],
        ["A test of a clean setup", "Run it from scratch before submitting", "judge passes in the working tree", no("Not done")],
      ];
      return `
      ${head("Submission components", "What the organizers ask for, and where each one is.")}
      <div style="margin-top:16px">${tbl(["Component", "What is asked", "Where", "State"], rows.map((r) => [`<b style="font-size:22px">${r[0]}</b>`, `<span style="font-size:21px; line-height:1.25">${r[1]}</span>`, `<span class="mono" style="font-size:18px">${r[2]}</span>`, r[3]]), "tiny")}</div>`;
    },
  },

  // ------------------------------------------------------------------ 34
  {
    id: "limits",
    section: "Limits and what is not verified",
    sources: ["README.md", RESULTS, "docs/DECISIONS.md", "infra/zetaris/GATES.md", "docs/reports/feasibility-report.md"],
    derived: [],
    cls: "NOT VERIFIED means no evidence either way",
    notes: `Limits, stated before a judge has to find them. No clinical validation: the rules cite published concepts, but the executable logic and thresholds are our inference, and 21 of 38 candidate rules are not implemented. No buyer evidence and no reviewer study. One reader wrote every key, and the Gate 0 key was edited after a dry run; the erratum says so. In the public data only 1 of 12 devices has a study that states the version the regulator reviewed, so authentic mismatches are few. Extraction gaps are the main reason the full pipeline is conservative: population is unknown in 22 of the 26 development claims, results in stacked tables are not read, and a numeric performance claim is not supported by any case today. Every vendor claim is constructed. Sample mode replays recordings. The guard is weak on new wording. Receipts show routing, not truth. The Zetaris natural-language route is blocked and the layer saved no run time. Not run: a clean clone, Constat and HealthIT on held-out claims, cost and latency.`,
    html: () => {
      const unk = grab(RESULTS, /population:UNKNOWN (\d+)/);
      const one = grab("docs/reports/feasibility-report.md", /only (\d+) of 12 had a link whose study text states the same software version/);
      const held = grab(SCOUT, /Injection recall \| 37\.5% \((\d+\/24)/);
      const items = [
        ["No clinical validation", "Rules cite published concepts; the logic and thresholds are our inference. 21 of 38 candidate rules are not implemented."],
        ["No buyer evidence", "Nobody who runs such a review was interviewed; no clinician or independent reviewer read any key."],
        ["One reader", "One builder wrote every answer key. The Gate 0 key was edited after a compiler dry run (E-001)."],
        ["Few authentic mismatches", `In the public data only ${one} of 12 devices has a study stating the version the regulator reviewed.`],
        ["Extraction gaps", `Population is unknown in ${unk} of 26 development claims; stacked-table results are not read, so no numeric performance claim is supported today.`],
        ["Constructed claims", "Every vendor claim and hospital requirement is constructed and labelled so. No patient data."],
        ["Recorded replay", "Sample mode replays recorded replies. Live mode was exercised once end to end."],
        ["Weak guard on new wording", `Injection recall ${held} on wording written after the rules froze; the classifier is off.`],
        ["Receipts", "They show routing, not truth, and carry no hash of the reply."],
        ["Zetaris", "Natural-language route blocked; the layer saved no run time; a masked value reaching a prompt is not verified end to end."],
        ["Not run", "Clean clone on Windows and Ubuntu; Constat and HealthIT on held-out claims; cost and latency; the critic ablation."],
        ["Not used", "Cursor. Bright Data and Colab are not applicable."],
      ];
      return `
      ${head("Limits and what is not verified", "What this deck does not show.")}
      <div class="g2" style="margin-top:20px; gap:10px 44px; flex:1; align-content:start; min-height:0">
        ${items.map(([a, b]) => `<div style="border-top:3px solid var(--rust); padding:8px 0 6px"><div class="b rust" style="font-size:25px">${a}</div><div style="font-size:21px; line-height:1.27; color:var(--ink-2)">${b}</div></div>`).join("")}
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 35
  {
    id: "provenance",
    section: "Pre-existing components and provenance",
    sources: ["docs/provenance.md", "metadata.json", "NOTICE"],
    derived: [],
    cls: "declared per the organizers' rules",
    notes: `What existed before the build and under which licence. All Sakaime source code was written for this project from 2026-10-27. Vendored unmodified: the Meterless reference engines and conformance runners, Apache-2.0, pinned to one commit with file hashes that a test checks. Ideas studied and rebuilt in new code, no code copied: Splink, Docling, OpenLineage, the Airbyte protocol, the Trino connector SPI and Graphiti, plus the published appraisal standards. From an earlier submission, only design experience: request shapes for two sponsor tools, rebuilt and tested here, and the font files under the SIL Open Font Licence. Public data is from openFDA, ClinicalTrials.gov, PubMed, Europe PMC and FDA summaries; every vendor claim and the hospital database are constructed. Competitor material is not republished. The code, tests and documents were written with Claude Code under the owner's direction; Cursor was not used.`,
    html: () => {
      const ideas = mdTable("docs/provenance.md", /^## Ideas studied and rebuilt/).slice(1, 7);
      const sha = grab("docs/provenance.md", /commit `(0aa7417)`/);
      return `
      ${head("Pre-existing components and provenance", "What existed before, what was studied, what was reused.")}
      <div class="row" style="gap:36px; margin-top:20px; flex:1; min-height:0">
        <div style="flex:1.1; min-width:0">
          <div class="tag green" style="margin-bottom:8px">Ideas studied and rebuilt in new code</div>
          ${tbl(["Source", "Licence"], ideas.map((r) => [`<span style="font-size:23px">${r[0]}</span>`, `<span class="mono" style="font-size:20px">${r[1]}</span>`]), "tight")}
          <p class="xs ink-2 mt-s">Plus PROBAST+AI, STARD-AI, TRIPOD+AI, IMDRF N41 and FDA PCCP guidance, as concepts. The executable rules are our inference.</p>
        </div>
        <div class="col" style="flex:1; gap:14px; min-width:0">
          ${card(`<div class="tag green">Vendored, unmodified</div><p style="font-size:23px; line-height:1.3; margin-top:4px">Meterless reference engines and conformance runners, Apache-2.0, commit <span class="mono">${sha}</span>, file hashes checked by a test.</p>`, "soft")}
          ${card(`<div class="tag">From an earlier submission</div><p style="font-size:23px; line-height:1.3; margin-top:4px">Design experience only: two sponsor request shapes, rebuilt and tested here. Font files (SIL OFL) copied. No code, copy or screenshots.</p>`, "soft")}
          ${card(`<div class="tag">Data</div><p style="font-size:23px; line-height:1.3; margin-top:4px">openFDA (CC0), ClinicalTrials.gov, PubMed, Europe PMC, FDA summaries: small hashed recordings. Vendor claims, requirements and the hospital database are constructed. No patient data.</p>`, "soft")}
          ${card(`<div class="tag">AI assistance</div><p style="font-size:23px; line-height:1.3; margin-top:4px">Code, tests and documents were written with Claude Code under the owner's direction. Cursor was not used.</p>`, "soft")}
        </div>
      </div>`;
    },
  },

  // ------------------------------------------------------------------ 36
  {
    id: "next",
    section: "Roadmap, team and links",
    dark: true,
    sources: ["docs/DECISIONS.md", "README.md", "metadata.json", "docs/provenance.md"],
    derived: [],
    cls: "domain packs are a thesis, not a claim",
    notes: `What comes next, in order of what would most change what we can honestly say. First, independent clinical or informatics reviewers labelling a held-out set blind: that is what turns a builder-labelled result into a domain-validity result. Second, buyer interviews with hospital AI intake committees, because demand is not measured. Third, extraction of stacked tables and of study populations and settings, which is the main reason the full pipeline is conservative. Fourth, more compiler rules as the evidence schema grows. Fifth, the Zetaris natural-language route when a build offers it. Sixth, domain packs: the same engine on a different kind of document, for example construction addenda or tariff revisions. That is a thesis, not a claim: only a pack that runs end to end with its own tests may be called working, and none does. The team is one builder, Prateek, working with Claude Code; Cursor was not used. The code is Apache-2.0 at the repository shown.`,
    html: () => {
      const next = [
        ["Independent reviewers label a held-out set blind", "turns builder-labelled into domain validity"],
        ["Interview hospital AI intake committees", "demand is not measured"],
        ["Read stacked tables; carry study population and setting", "the main reason the pipeline is conservative"],
        ["Implement more compiler rules as the schema grows", "21 of 38 are not implemented"],
        ["Zetaris natural-language route, when a build has one", "blocked in the local build"],
        ["Domain packs: the same engine on addenda or tariff revisions", "a thesis, not a claim"],
      ];
      return `
      ${head("Roadmap, team and links", "What would change what we can honestly say.")}
      <div class="row" style="gap:56px; margin-top:26px; flex:1; min-height:0">
        <div style="flex:1.3; min-width:0">
          ${next.map(([a, b], i) => `<div style="display:flex; gap:20px; border-top:2px solid var(--line-strong); padding:10px 0; align-items:baseline"><span class="mono green b" style="font-size:28px; width:40px">${i + 1}</span><div><div class="b" style="font-size:27px; line-height:1.2">${a}</div><div class="ink-2" style="font-size:22px">${b}</div></div></div>`).join("")}
        </div>
        <div class="col" style="flex:1; gap:16px; min-width:0">
          <div class="card" style="background:var(--paper-2)"><div class="tag green">Team and tools</div><p style="font-size:25px; line-height:1.3; margin-top:6px">Solo build: <b>Prateek</b> (Pratiikpy). Code, tests and documents written with Claude Code under the owner's direction. Cursor not used.</p></div>
          <div class="card" style="background:var(--paper-2)"><div class="tag green">Links</div>
            <p class="mono b" style="font-size:25px; margin-top:8px; word-break:break-all">github.com/Pratiikpy/sakaime</p>
            <p class="ink-2" style="font-size:22px; line-height:1.4; margin-top:8px"><span class="mono">README.md</span> start here<br><span class="mono">evals/RESULTS.md</span> every result<br><span class="mono">docs/00-INDEX.md</span> design and decisions<br><span class="mono">docs/provenance.md</span> what was reused<br><span class="mono">npm run judge</span> re-check offline</p></div>
          <div style="display:flex; align-items:center; gap:0; margin-top:auto"><span style="font-size:42px; font-weight:600; white-space:nowrap">Know where the evidence stops.</span><span style="flex:1; height:36px; background:var(--ink); margin-left:10px"></span></div>
        </div>
      </div>`;
    },
  },
];
