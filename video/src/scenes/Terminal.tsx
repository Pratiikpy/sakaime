import React from "react";
import { interpolate } from "remotion";
import { C, FONT, ease } from "../theme";
import { Rise, useScene } from "../components/motion";
import { Eyebrow, Mono } from "../components/ui";
import judge from "../generated/judge.json";

const LINES: string[] = (judge as { lines: string[] }).lines;
const VISIBLE = 17;
const LINE_H = 40;

// What each family of checks verifies. The counts are read from the real output, not typed.
const GROUPS: { name: string; test: RegExp }[] = [
  { name: "Dossier hashes and signature", test: /hashes, signature and/ },
  { name: "A changed label is detected", test: /a changed label is detected/ },
  { name: "Compiler gives the recorded label", test: /compiler gives the recorded label/ },
  { name: "Label and relations equal the recording", test: /label and relations equal the recording/ },
  { name: "Federation statements equal the recording", test: /federation statements and result hashes/ },
  { name: "A lost source never yields supported", test: /never yields a supported label/ },
  { name: "No banned wording in the trace", test: /no banned wording/ },
];

function colour(line: string): React.ReactNode {
  const m = /^(PASS|FAIL)(\s+)(.*)$/.exec(line);
  if (!m) return <span style={{ color: line.startsWith("All checks") ? "#46c987" : "#c3c9c2" }}>{line}</span>;
  return (
    <>
      <span style={{ color: m[1] === "PASS" ? "#46c987" : "#ff8f73", fontWeight: 500 }}>{m[1]}</span>
      <span>{m[2]}</span>
      <span style={{ color: "#eef1ec" }}>{m[3]}</span>
    </>
  );
}

export function Terminal() {
  const { at, frame, p, scene } = useScene();
  const typed = "npm run judge";
  const typeStart = at(0) + 4;
  const nTyped = Math.max(0, Math.min(typed.length, Math.floor((frame - typeStart) / 2.2)));
  const runStart = at(0) + typed.length * 2.2 + 18;
  const streamEnd = at(1) + Math.round(scene.beats[1]!.frames * 0.8);
  const shown = Math.max(0, Math.min(LINES.length, Math.round(interpolate(frame, [runStart, streamEnd], [0, LINES.length], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }))));
  const first = Math.max(0, shown - VISIBLE);
  const passCount = LINES.slice(0, shown).filter((l) => l.startsWith("PASS")).length;
  const failCount = LINES.slice(0, shown).filter((l) => l.startsWith("FAIL")).length;
  const done = shown >= LINES.length;

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 108, top: 70 }}>
        <Rise at={2}><Eyebrow>One command, no keys</Eyebrow></Rise>
      </div>
      <Rise at={6} style={{ position: "absolute", left: 108, top: 150, width: 1130 }}>
        <div style={{ background: "#0b0e0c", borderRadius: 16, border: `2px solid ${C.ink}`, overflow: "hidden", boxShadow: "0 34px 60px -34px rgba(14,17,22,.6)" }}>
          <div style={{ height: 46, background: "#1c211d", display: "flex", alignItems: "center", gap: 10, padding: "0 20px" }}>
            {["#ff8f73", "#c3c9c2", "#46c987"].map((c) => <span key={c} style={{ width: 14, height: 14, borderRadius: 7, background: c, opacity: 0.8 }} />)}
            <Mono size={18} color="#9ba39a" style={{ marginLeft: 14 }}>sakaime — sample mode, no key, no network</Mono>
          </div>
          <div style={{ padding: "22px 28px", height: VISIBLE * LINE_H + 70, fontFamily: FONT.mono, fontSize: 22.5, lineHeight: `${LINE_H}px`, color: "#c3c9c2", overflow: "hidden", whiteSpace: "nowrap" }}>
            <div style={{ color: "#eef1ec" }}>
              <span style={{ color: "#46c987" }}>$ </span>
              {typed.slice(0, nTyped)}
              {nTyped < typed.length || Math.floor(frame / 15) % 2 === 0 ? <span style={{ background: "#eef1ec", color: "#0b0e0c" }}>{" "}</span> : null}
            </div>
            {LINES.slice(first, shown).map((l, i) => (
              <div key={first + i} style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{colour(l)}</div>
            ))}
          </div>
        </div>
      </Rise>

      <div style={{ position: "absolute", left: 1290, top: 150, width: 530 }}>
        <Rise at={at(1) - 6}>
          <div style={{ display: "flex", gap: 18 }}>
            <div style={{ flex: 1, border: `2px solid ${C.greenLine}`, background: C.greenSoft, borderRadius: 14, padding: "14px 22px" }}>
              <Mono size={20} color={C.ink3}>PASS</Mono>
              <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 70, color: C.green, lineHeight: 1 }}>{passCount}</div>
            </div>
            <div style={{ flex: 1, border: `2px solid ${C.line}`, background: C.paper2, borderRadius: 14, padding: "14px 22px" }}>
              <Mono size={20} color={C.ink3}>FAIL</Mono>
              <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 70, color: failCount ? C.rust : C.ink, lineHeight: 1 }}>{failCount}</div>
            </div>
          </div>
        </Rise>
        <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 10 }}>
          {GROUPS.map((g, i) => {
            const total = LINES.filter((l) => g.test.test(l)).length;
            const seen = LINES.slice(0, shown).filter((l) => g.test.test(l)).length;
            const t = p(at(1) + 6 + i * 5, 14);
            return (
              <div key={g.name} style={{ opacity: t, transform: `translateX(${(1 - t) * 30}px)`, display: "flex", alignItems: "center", gap: 14, fontFamily: FONT.display, fontSize: 25, color: C.ink }}>
                <span style={{ width: 34, height: 34, borderRadius: 8, border: `2px solid ${seen === total && total > 0 ? C.green : C.line}`, background: seen === total && total > 0 ? C.green : C.paper, color: C.paper, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 22, flex: "none" }}>{seen === total && total > 0 ? "✓" : ""}</span>
                <span style={{ flex: 1, lineHeight: 1.15 }}>{g.name}</span>
                <Mono size={22} color={C.ink3}>{seen}/{total}</Mono>
              </div>
            );
          })}
        </div>
        {done && (
          <Rise at={streamEnd} style={{ marginTop: 26 }}>
            <div style={{ fontFamily: FONT.display, fontSize: 26, color: C.ink2, lineHeight: 1.3 }}>It re-verifies the signed dossiers, re-runs the compiler on the recorded evidence, and replays the source-loss drills.</div>
          </Rise>
        )}
      </div>
    </div>
  );
}
