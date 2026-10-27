import React from "react";
import { C, FONT } from "../theme";
import { Reveal, Rise, useScene } from "../components/motion";
import { Eyebrow, Mono } from "../components/ui";
import { $ } from "../lib/data";

const LIMITS: { head: string; line: string; beat: number }[] = [
  { head: "Constructed claims", line: "Every vendor claim and the hospital requirement are constructed, and labelled so on screen.", beat: 0 },
  { head: "One reader", line: "One builder wrote the answer keys. No clinician or independent reviewer has read them.", beat: 0 },
  { head: "No buyer evidence", line: "Nobody who runs a hospital review was interviewed. Demand is not measured.", beat: 1 },
  { head: "Weak on unseen wording", line: $("The guard caught {scout.heldout} injections worded after its rules were frozen."), beat: 1 },
  { head: "Replay", line: "Sample mode replays recordings of the real services. The default is live when configured.", beat: 1 },
  { head: "Demo signing key", line: "The signature shows the file is intact, not who signed it.", beat: 1 },
];

const NOT_DONE = ["A blind second reviewer", "A trial with a hospital", "A live federation call in this video", "Any clinical sign-off"];

export function Limits() {
  const { at, p } = useScene();
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 108, top: 96 }}>
        <Rise at={2}><Eyebrow color={C.rust}>The honest limits</Eyebrow></Rise>
        <div style={{ marginTop: 26 }}>
          <Reveal at={6} dur={22}>
            <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 88, letterSpacing: -2, lineHeight: 1.04 }}>What this does not show.</div>
          </Reveal>
        </div>
      </div>

      <div style={{ position: "absolute", left: 108, top: 330, width: 1010, display: "flex", flexDirection: "column", gap: 20 }}>
        {LIMITS.map((l, i) => {
          const t = p(at(l.beat) + 4 + (i - (l.beat === 0 ? 0 : 2)) * 12, 18);
          return (
            <div key={l.head} style={{ display: "flex", gap: 22, opacity: t, transform: `translateX(${(1 - t) * -34}px)` }}>
              <div style={{ width: 12, borderRadius: 2, background: C.rust, flex: "none" }} />
              <div>
                <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 32 }}>{l.head}</div>
                <div style={{ fontFamily: FONT.display, fontSize: 26, color: C.ink2, lineHeight: 1.25, marginTop: 2 }}>{l.line}</div>
              </div>
            </div>
          );
        })}
      </div>

      <Rise at={at(2)} dy={30} style={{ position: "absolute", left: 1220, top: 330, width: 590 }}>
        <div style={{ border: `4px dashed ${C.rust}`, borderRadius: 18, padding: "30px 34px", background: C.rustSoft }}>
          <Mono size={28} color={C.rust} weight={500} style={{ letterSpacing: 3 }}>NOT DONE</Mono>
          <div style={{ marginTop: 20, display: "flex", flexDirection: "column", gap: 18 }}>
            {NOT_DONE.map((n, i) => (
              <Rise key={n} at={at(2) + 10 + i * 10} dy={16}>
                <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 34, lineHeight: 1.15, color: C.ink }}>{n}</div>
              </Rise>
            ))}
          </div>
        </div>
      </Rise>
    </div>
  );
}
