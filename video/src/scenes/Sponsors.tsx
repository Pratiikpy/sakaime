import React from "react";
import { C, FONT } from "../theme";
import { Reveal, Rise, useScene } from "../components/motion";
import { Eyebrow, Mono, Pill } from "../components/ui";
import { $ } from "../lib/data";

interface Sponsor {
  name: string;
  role: string;
  does: string[];
  off: string;
  where: string;
  tone: "ink" | "dashed";
}

const SPONSORS: Sponsor[] = [
  {
    name: "Zetaris",
    role: "Federation and semantic layer",
    does: [
      "One statement: Postgres, snapshots, files",
      $("Unified Semantic Layer, {usl.tables:w} tables"),
      $("Quality rule: {usl.failures} of {usl.studies} records flagged"),
      $("Row filter: {mask.unassigned:w} of {mask.admin:w} cases unassigned"),
    ],
    off: "Off: findings that depend on it fall to not enough evidence, with the reason.",
    where: "src/federation · infra/zetaris/GATES.md",
    tone: "ink",
  },
  {
    name: "Meterless",
    role: "Engines, vendored unmodified",
    does: [
      "H-MEM: confirmed links and precedents, per hospital",
      "World Model: history, and what each finding used",
      "Markovian: reads long documents",
      "Scout Intent: guards requests, signs exports",
    ],
    off: $("Off: no change impact. On: {time.staleFindings} flagged stale, {time.affected} changed."),
    where: "src/engines · tests/engines/ABLATIONS.md",
    tone: "ink",
  },
  {
    name: "NVIDIA Nemotron",
    role: "Through Nightshift, with receipts",
    does: [
      "Planner, checker, resolver, critic, reporter",
      "Lightning 30B for volume, Ultra 550B critic",
      $("{route.receipted} of {route.total} replies carry a verified receipt"),
      "A proposal is no fact until code checks it",
    ],
    off: "Off: labels do not move. They come from rules.",
    where: "src/models · output_examples/model-route.json",
    tone: "ink",
  },
  {
    name: "Cursor",
    role: "Not used",
    does: ["The organizers call it optional.", "Nothing here claims Cursor use."],
    off: "Recorded as a decision, not hidden.",
    where: "docs/DECISIONS.md D-012",
    tone: "dashed",
  },
];

// beat that spotlights each sponsor
const SPOT = [0, 1, 2, 3];
const CARD_W = 408;
const GAP = 24;

export function Sponsors() {
  const { at, frame, p } = useScene();
  const b4 = at(4);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 108, top: 70 }}>
        <Rise at={2}><Eyebrow>Sponsor technology, and what each one changes</Eyebrow></Rise>
      </div>
      {SPONSORS.map((s, i) => {
        const spot = SPOT[i] as number;
        const enter = p(at(0) + 6 + i * 6, 18);
        const active = frame >= at(spot) && (frame < at(spot + 1) || spot === 3 && frame < b4);
        const seen = frame >= at(spot);
        const left = 108 + i * (CARD_W + GAP);
        return (
          <div key={s.name} style={{ position: "absolute", left, top: 150, width: CARD_W, opacity: enter * (seen ? 1 : 0.5), transform: `translateY(${(1 - enter) * 30}px)` }}>
            <div style={{ border: `${active ? 4 : 2}px ${s.tone === "dashed" ? "dashed" : "solid"} ${active ? C.green : s.tone === "dashed" ? C.lineStrong : C.ink}`, borderRadius: 16, padding: "26px 26px 24px", height: 650, background: active ? C.greenSoft : C.paper, boxShadow: active ? "0 28px 50px -30px rgba(10,107,58,.55)" : "none", position: "relative" }}>
              <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 44, letterSpacing: -1 }}>{s.name}</div>
              <div style={{ fontFamily: FONT.display, fontSize: 25, color: C.ink2, marginTop: 4 }}>{s.role}</div>
              <div style={{ marginTop: 22, display: "flex", flexDirection: "column", gap: 14 }}>
                {s.does.map((d, j) => (
                  <div key={j} style={{ display: "flex", gap: 12, fontFamily: FONT.display, fontSize: 25, lineHeight: 1.2, color: C.ink }}>
                    <span style={{ width: 10, height: 10, background: s.tone === "dashed" ? C.lineStrong : C.green, borderRadius: 2, marginTop: 10, flex: "none" }} />
                    <span>{d}</span>
                  </div>
                ))}
              </div>
              <div style={{ position: "absolute", left: 26, right: 26, bottom: 24 }}>
                <div style={{ borderTop: `2px solid ${C.line}`, paddingTop: 14, fontFamily: FONT.display, fontSize: 24, lineHeight: 1.22, color: C.rust, fontWeight: 600 }}>{s.off}</div>
                <Mono size={18} color={C.ink3} style={{ display: "block", marginTop: 10 }}>{s.where}</Mono>
              </div>
            </div>
          </div>
        );
      })}

      {/* the sample-mode statement */}
      {frame >= b4 - 4 && (
        <Rise at={b4} dy={20} style={{ position: "absolute", left: 108, right: 108, top: 836 }}>
          <div style={{ border: `3px solid ${C.ink}`, borderRadius: 14, padding: "20px 30px", display: "flex", gap: 34, alignItems: "center", background: C.paper }}>
            <Pill tone="ink" size={26}>Sample mode</Pill>
            <div style={{ display: "flex", gap: 30, flex: 1 }}>
              <div style={{ flex: 1 }}>
                <Reveal at={b4 + 4} dur={18}>
                  <div style={{ fontFamily: FONT.display, fontSize: 27, lineHeight: 1.22 }}><b style={{ color: C.ink3, fontWeight: 600 }}>Replayed:</b> recordings of the real services, labelled recorded</div>
                </Reveal>
              </div>
              <div style={{ flex: 1 }}>
                <Reveal at={b4 + 14} dur={18}>
                  <div style={{ fontFamily: FONT.display, fontSize: 27, lineHeight: 1.22 }}><b style={{ color: C.green, fontWeight: 600 }}>Run for real:</b> compiler, identity scorer, verifiers, guard</div>
                </Reveal>
              </div>
            </div>
          </div>
        </Rise>
      )}
    </div>
  );
}
