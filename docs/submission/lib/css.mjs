// Deck styles. Brand kit D-022: ink on white, one green accent, rust for failure, Outfit and JetBrains Mono,
// the redaction bar. Fonts are the files the product ships (ui/public/fonts), referenced by relative path.
export const CSS = String.raw`
@font-face { font-family: "Outfit"; src: url("../../ui/public/fonts/Outfit-Regular.ttf") format("truetype"); font-weight: 400; font-style: normal; }
@font-face { font-family: "Outfit"; src: url("../../ui/public/fonts/Outfit-SemiBold.ttf") format("truetype"); font-weight: 600; font-style: normal; }
@font-face { font-family: "JetBrains Mono"; src: url("../../ui/public/fonts/JetBrainsMono-Regular.ttf") format("truetype"); font-weight: 400; font-style: normal; }
@font-face { font-family: "JetBrains Mono"; src: url("../../ui/public/fonts/JetBrainsMono-Medium.ttf") format("truetype"); font-weight: 500; font-style: normal; }

:root {
  --paper: #ffffff; --paper-2: #f4f5f2; --paper-3: #eaece7;
  --ink: #0e1116; --ink-2: #384150; --ink-3: #566070;
  --line: #d6d9d3; --line-strong: #8a918a;
  --green: #0a6b3a; --green-soft: #e6f4ec; --green-line: #9cd0b3;
  --rust: #a8321a; --rust-soft: #fbebe6; --rust-line: #e2a898;
  --display: "Outfit", system-ui, "Segoe UI", sans-serif;
  --mono: "JetBrains Mono", ui-monospace, Consolas, monospace;
}
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: #c9ccc6; }
body { font-family: var(--display); color: var(--ink); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }

.slide {
  width: 1920px; height: 1080px; position: relative; overflow: hidden; background: var(--paper); color: var(--ink);
  margin: 0 auto 24px; padding: 0 120px; font-size: 30px; line-height: 1.38; break-after: page; page-break-after: always;
}
.slide.dark {
  --paper: #0b0e0c; --paper-2: #141815; --paper-3: #1c211d; --ink: #eef1ec; --ink-2: #c3c9c2; --ink-3: #9ba39a;
  --line: #2a2f2b; --line-strong: #6d756d; --green: #46c987; --green-soft: #10261a; --green-line: #1f5a3a;
  --rust: #ff8f73; --rust-soft: #2c1510; --rust-line: #6e3324;
}
.slide.tint { background: var(--paper-2); }

/* ---- chrome ---- */
.top { position: absolute; left: 120px; right: 120px; top: 44px; height: 40px; display: flex; align-items: center; gap: 28px; font-family: var(--mono); font-size: 21px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--ink-3); }
.top .brand { color: var(--ink); font-weight: 500; display: flex; align-items: center; gap: 14px; }
.top .brand i { display: inline-block; width: 34px; height: 12px; background: var(--ink); }
.top .sect { flex: 1; }
.top .crit { border: 2px solid var(--green); color: var(--green); padding: 3px 14px; letter-spacing: 0.06em; font-weight: 500; }
.top .pg { color: var(--ink-3); }
.foot { position: absolute; left: 120px; right: 120px; bottom: 26px; font-family: var(--mono); font-size: 18px; color: var(--ink-3); display: flex; justify-content: space-between; gap: 40px; line-height: 1.3; white-space: nowrap; }
.foot > span:first-child { overflow: hidden; text-overflow: ellipsis; min-width: 0; }
.foot .cls { white-space: nowrap; }
.body { position: absolute; left: 120px; right: 120px; top: 108px; bottom: 70px; display: flex; flex-direction: column; }

/* ---- type ---- */
.kicker { font-family: var(--mono); font-size: 23px; letter-spacing: 0.12em; text-transform: uppercase; color: var(--green); font-weight: 500; display: flex; align-items: center; gap: 16px; margin: 0 0 12px; }
.kicker::before { content: ""; width: 56px; height: 12px; background: var(--ink); display: inline-block; }
h1, h2, h3, h4 { font-family: var(--display); font-weight: 600; margin: 0; letter-spacing: -0.012em; }
h2 { font-size: 64px; line-height: 1.06; max-width: 1560px; text-wrap: balance; }
h3 { font-size: 38px; line-height: 1.15; }
h4 { font-size: 30px; line-height: 1.2; }
p { margin: 0; }
.lead { font-size: 36px; line-height: 1.3; color: var(--ink-2); max-width: 1680px; margin-top: 16px; }
.sm { font-size: 25px; line-height: 1.38; }
.xs { font-size: 22px; line-height: 1.35; }
.mono { font-family: var(--mono); font-size: 0.82em; }
.ink-2 { color: var(--ink-2); } .ink-3 { color: var(--ink-3); } .green { color: var(--green); } .rust { color: var(--rust); }
.b { font-weight: 600; }
.mt { margin-top: 28px; } .mt-s { margin-top: 14px; } .mt-l { margin-top: 44px; }

/* ---- layout ---- */
.row { display: flex; gap: 40px; } .col { display: flex; flex-direction: column; gap: 22px; }
.grow { flex: 1; min-width: 0; } .center { align-items: center; } .end { align-items: flex-end; } .between { justify-content: space-between; }
.g2 { display: grid; grid-template-columns: 1fr 1fr; gap: 36px; } .g3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 32px; }
.g4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 28px; } .g5 { display: grid; grid-template-columns: repeat(5, 1fr); gap: 22px; }
.fill { flex: 1; min-height: 0; }

/* ---- surfaces ---- */
.card { border: 2px solid var(--line); background: var(--paper); padding: 26px 30px; border-radius: 4px; }
.card.soft { background: var(--paper-2); border-color: var(--paper-3); }
.card.ink { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.card.ink .ink-2, .card.ink .ink-3 { color: var(--paper-3); }
.card.green { background: var(--green-soft); border-color: var(--green-line); }
.card.rust { background: var(--rust-soft); border-color: var(--rust-line); }
.card h4 { margin-bottom: 8px; }
.tag { font-family: var(--mono); font-size: 20px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); font-weight: 500; }
.tag.green { color: var(--green); } .tag.rust { color: var(--rust); }
.chip { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 21px; padding: 3px 12px; border: 2px solid var(--line-strong); border-radius: 999px; color: var(--ink-2); background: var(--paper); white-space: nowrap; }
.chip.green { color: var(--green); border-color: var(--green); background: var(--green-soft); }
.chip.rust { color: var(--rust); border-color: var(--rust); background: var(--rust-soft); }
.chip.ink { background: var(--ink); color: var(--paper); border-color: var(--ink); }
.chip.dash { border-style: dashed; }

/* ---- redaction bar ---- */
.rd { display: inline-block; background: var(--ink); color: transparent; border-radius: 2px; user-select: none; line-height: 0.95; padding: 0 2px; }
.rdline { display: block; height: 22px; background: var(--ink); border-radius: 2px; }
.rdline.g { background: var(--green); } .rdline.l { background: var(--line); } .rdline.r { background: var(--rust); }

/* ---- stats ---- */
.stat { display: flex; flex-direction: column; gap: 4px; }
.stat .n { font-size: 112px; line-height: 0.95; font-weight: 600; letter-spacing: -0.03em; }
.stat .n.md { font-size: 78px; } .stat .n.sm { font-size: 64px; }
.stat .l { font-size: 25px; color: var(--ink-2); line-height: 1.3; max-width: 520px; }
.stat .n small { font-size: 0.4em; font-weight: 400; color: var(--ink-3); letter-spacing: 0; margin-left: 6px; }

/* ---- tables ---- */
table { border-collapse: collapse; width: 100%; }
th, td { text-align: left; vertical-align: top; padding: 11px 16px; border-bottom: 2px solid var(--line); font-size: 25px; line-height: 1.3; }
th { font-family: var(--mono); font-weight: 500; font-size: 20px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--ink-3); border-bottom: 3px solid var(--ink); padding-top: 4px; }
td.n, th.n { text-align: right; font-variant-numeric: tabular-nums; }
td .mono, td code { font-family: var(--mono); font-size: 0.86em; }
tr.hl td { background: var(--green-soft); }
tr.bad td { background: var(--rust-soft); }
table.tight td, table.tight th { padding: 7px 14px; font-size: 23px; }
table.tiny td, table.tiny th { padding: 6px 12px; font-size: 20px; }
.card ul.pts li { font-size: 24px; line-height: 1.28; }
.card ul.pts { gap: 8px; }
table.big td { font-size: 28px; padding: 14px 18px; }

/* ---- finding labels (words + icon) ---- */
.lab { display: inline-flex; align-items: center; gap: 12px; font-weight: 600; padding: 6px 16px 6px 12px; border: 3px solid var(--ink); border-radius: 4px; background: var(--paper); line-height: 1.15; white-space: nowrap; }
.lab svg { width: 30px; height: 30px; flex: none; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.lab.wrap { white-space: normal; }
.lab.sm { font-size: 22px; padding: 3px 12px 3px 9px; border-width: 2px; } .lab.sm svg { width: 22px; height: 22px; }
.lab.lg { font-size: 32px; padding: 10px 20px 10px 14px; } .lab.lg svg { width: 38px; height: 38px; }
.lab.good { color: var(--green); border-color: var(--green); background: var(--green-soft); }
.lab.partial { color: var(--green); border-color: var(--green); border-style: dashed; }
.lab.bad { color: var(--rust); border-color: var(--rust); background: var(--rust-soft); }
.lab.unk { color: var(--ink); border-style: dotted; background: var(--paper-2); }
.lab.rev { color: var(--ink); }
.rel { display: inline-flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 21px; font-weight: 500; padding: 2px 11px; border-radius: 999px; border: 2px solid var(--ink); white-space: nowrap; }
.rel svg { width: 20px; height: 20px; fill: none; stroke: currentColor; stroke-width: 2.6; stroke-linecap: round; stroke-linejoin: round; }
.rel.good { color: var(--green); border-color: var(--green); background: var(--green-soft); }
.rel.partial { color: var(--green); border-color: var(--green); border-style: dashed; }
.rel.bad { color: var(--rust); border-color: var(--rust); background: var(--rust-soft); }
.rel.unk { color: var(--ink-2); border-style: dotted; background: var(--paper-2); }

/* ---- screenshots ---- */
.shot { border: 2px solid var(--ink); border-radius: 6px; overflow: hidden; background: var(--paper); box-shadow: 14px 14px 0 var(--paper-3); }
.shot .bar { height: 34px; background: var(--paper-3); display: flex; align-items: center; gap: 8px; padding: 0 14px; font-family: var(--mono); font-size: 16px; color: var(--ink-3); border-bottom: 2px solid var(--ink); }
.shot .bar i { width: 11px; height: 11px; border-radius: 50%; background: var(--line-strong); display: inline-block; }
.shot img { display: block; width: 100%; height: auto; }
.cap { font-family: var(--mono); font-size: 20px; color: var(--ink-3); margin-top: 16px; line-height: 1.3; }

/* ---- diagram text ---- */
svg text { font-family: var(--display); fill: var(--ink); }
svg .m { font-family: var(--mono); }
svg .f2 { fill: var(--ink-2); } svg .f3 { fill: var(--ink-3); } svg .fp { fill: var(--paper); } svg .fg { fill: var(--green); } svg .fr { fill: var(--rust); }
.arrow-line { stroke: var(--ink); stroke-width: 3; fill: none; }

ul.pts { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 14px; }
ul.pts li { padding-left: 34px; position: relative; }
ul.pts li::before { content: ""; position: absolute; left: 0; top: 0.58em; width: 20px; height: 8px; background: var(--ink); }
ul.pts.g li::before { background: var(--green); } ul.pts.r li::before { background: var(--rust); }

.ask { display: flex; flex-direction: column; gap: 4px; border-left: 10px solid var(--green); background: var(--paper-2); padding: 14px 26px; margin-top: 22px; font-size: 27px; line-height: 1.32; max-width: 1560px; }
.ask .tag { font-size: 19px; }
@media screen { .slide { box-shadow: 0 6px 30px rgba(0,0,0,.18); } }
@page { size: 1920px 1080px; margin: 0; }
@media print { html, body { background: #fff; } .slide { margin: 0; box-shadow: none; } }
`;
