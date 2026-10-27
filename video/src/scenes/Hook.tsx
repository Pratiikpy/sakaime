import React from "react";
import { C, FONT, H, W, ease } from "../theme";
import { Reveal, Rise, useScene } from "../components/motion";
import { Eyebrow, Mono, Pill } from "../components/ui";
import { caseEyeart } from "../lib/data";

/** The constructed claim, as written in the case file: the sentence after the study population. */
function claimSentence(): string {
  const text: string = caseEyeart.claims.find((c: { id: string }) => c.id === "CLM-EA-01").text;
  const tail = text.split("), ")[1] ?? text;
  return tail.charAt(0).toUpperCase() + tail.slice(1);
}

const MISMATCHES = [
  { what: "Version", evidence: "2.1.0", yours: "3.0" },
  { what: "Age", evidence: "22 and older", yours: "18" },
  { what: "Setting", evidence: "primary care", yours: "emergency department" },
];

export function Hook() {
  const { at, p } = useScene();
  const b1 = at(1);
  const b2 = at(2);
  const boundary = p(b2, 26);
  return (
    <div style={{ position: "absolute", inset: 0, padding: "112px 160px 0" }}>
      <Rise at={4}>
        <Eyebrow>A constructed vendor claim</Eyebrow>
      </Rise>
      <div style={{ marginTop: 26 }}>
        <Reveal at={8} dur={24}>
          <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 96, lineHeight: 1.04, letterSpacing: -2.2, color: C.ink, whiteSpace: "nowrap" }}>
            A vendor says its medical AI works.
          </div>
        </Reveal>
      </div>
      <Rise at={at(0) + 26} style={{ marginTop: 30, maxWidth: 1500 }}>
        <div style={{ borderLeft: `8px solid ${C.ink}`, background: C.paper2, borderRadius: 8, padding: "20px 30px" }}>
          <Mono size={22} color={C.ink3}>CLM-EA-01 · constructed, not a statement by any vendor</Mono>
          <div style={{ marginTop: 10, fontFamily: FONT.display, fontSize: 31, lineHeight: 1.28, color: C.ink }}>{claimSentence()}</div>
        </div>
      </Rise>

      <div style={{ marginTop: 36, display: "flex", gap: 26 }}>
        {MISMATCHES.map((m, i) => (
          <Rise key={m.what} at={b1 + 10 + i * 14} dy={34}>
            <div style={{ border: `2px solid ${C.line}`, borderRadius: 14, padding: "22px 30px", background: C.paper, minWidth: 520 }}>
              <Mono size={22} color={C.ink3}>{m.what.toUpperCase()}</Mono>
              <div style={{ display: "flex", alignItems: "baseline", gap: 18, marginTop: 8, fontFamily: FONT.display, fontSize: 38, fontWeight: 600 }}>
                <span style={{ color: C.green }}>{m.evidence}</span>
                <span style={{ color: C.ink3, fontSize: 30 }}>→</span>
                <span style={{ color: C.rust }}>{m.yours}</span>
              </div>
              <div style={{ marginTop: 8, display: "flex", gap: 10 }}>
                <Pill tone="good" size={20}>evidence covers</Pill>
                <Pill tone="bad" size={20}>your use</Pill>
              </div>
            </div>
          </Rise>
        ))}
      </div>

      {/* the boundary: where the evidence stops */}
      <div style={{ position: "absolute", left: 160, right: 160, bottom: 124, height: 96, opacity: boundary }}>
        <div style={{ position: "absolute", left: 0, top: 36, height: 22, width: `${boundary * 56}%`, background: C.green, borderRadius: 3 }} />
        <div style={{ position: "absolute", left: "56%", top: 36, height: 22, width: `${boundary * 38}%`, borderTop: `4px dashed ${C.rust}`, borderBottom: `4px dashed ${C.rust}` }} />
        <div style={{ position: "absolute", left: "56%", top: 0, width: 4, height: 96, background: C.ink, transform: `scaleY(${boundary})` }} />
        <div style={{ position: "absolute", left: "calc(56% + 22px)", top: -10, fontFamily: FONT.display, fontWeight: 600, fontSize: 40, color: C.ink }}>
          境目 <span style={{ fontSize: 28, color: C.ink3, fontWeight: 400 }}>sakaime, the boundary line</span>
        </div>
        <div style={{ position: "absolute", left: 0, top: 70, fontFamily: FONT.mono, fontSize: 22, color: C.green }}>what the evidence covers</div>
        <div style={{ position: "absolute", left: "calc(56% + 22px)", top: 70, fontFamily: FONT.mono, fontSize: 22, color: C.rust }}>your use</div>
      </div>
    </div>
  );
}

