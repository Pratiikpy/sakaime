import React from "react";
import { C, FONT } from "../theme";
import { Reveal, Rise, useScene } from "../components/motion";
import { Eyebrow, Mono, Pill } from "../components/ui";
import { num } from "../lib/data";

// The same question three ways (docs/zetaris-usl-reflection.md): medians of nine timed rounds on one laptop.
const ARMS = [
  { label: "Plain reads, one per table, joined in code", ms: num("usl.ms.reads"), lines: num("usl.lines.reads"), unit: "lines of TypeScript", tone: "ink" as const },
  { label: "One hand-written federated statement", ms: num("usl.ms.hand"), lines: num("usl.lines.hand"), unit: "lines of SQL", tone: "ink" as const },
  { label: "One read of the Unified Semantic Layer", ms: num("usl.ms.layer"), lines: num("usl.lines.layer"), unit: "lines of code", tone: "green" as const },
];

export function UslPlus() {
  const { at, p } = useScene();
  const admin = num("mask.admin");
  const unassigned = num("mask.unassigned");
  const maxMs = Math.max(...ARMS.map((a) => a.ms));
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 108, top: 70 }}>
        <Rise at={2}><Eyebrow>Zetaris: masking, and what the layer cost</Eyebrow></Rise>
      </div>

      {/* masking */}
      <div style={{ position: "absolute", left: 108, top: 170, width: 780 }}>
        <Reveal at={6} dur={20}>
          <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 56, letterSpacing: -1.2, lineHeight: 1.05 }}>Masked inside the engine</div>
        </Reveal>
        {[
          { who: "Reviewer assigned to the case", n: admin },
          { who: "Reviewer not assigned", n: unassigned },
        ].map((row, ri) => (
          <div key={row.who} style={{ marginTop: 44 }}>
            <div style={{ fontFamily: FONT.display, fontSize: 30, color: C.ink2 }}>{row.who}</div>
            <div style={{ display: "flex", gap: 14, marginTop: 14 }}>
              {Array.from({ length: admin }, (_, i) => {
                const masked = i >= row.n;
                const t = p(at(0) + 12 + ri * 18 + i * 3, 12);
                return <div key={i} style={{ width: 86, height: 104, borderRadius: 10, border: `3px solid ${masked ? C.ink : C.green}`, background: masked ? C.ink : C.greenSoft, opacity: t, transform: `scale(${0.8 + 0.2 * t})` }} />;
              })}
            </div>
            <div style={{ fontFamily: FONT.mono, fontSize: 30, marginTop: 14, color: row.n < admin ? C.ink : C.green, fontWeight: 500 }}>{row.n} of {admin} cases{row.n < admin ? ` · ${admin - row.n} hidden` : ""}</div>
          </div>
        ))}
        <Rise at={at(0) + 70} style={{ marginTop: 40 }}>
          <div style={{ fontFamily: FONT.display, fontSize: 27, color: C.ink2, lineHeight: 1.3, maxWidth: 740 }}>The row filter sits on the source table and carries through the layer. Sakaime adds no policy of its own.</div>
        </Rise>
      </div>

      {/* the honest comparison */}
      <div style={{ position: "absolute", left: 980, top: 170, width: 832 }}>
        <Rise at={at(1)}>
          <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 40 }}>The same question, asked in different ways</div>
          <Mono size={21} color={C.ink3} style={{ display: "block", marginTop: 6 }}>median of the timed rounds, one laptop</Mono>
        </Rise>
        <div style={{ marginTop: 28, display: "flex", flexDirection: "column", gap: 26 }}>
          {ARMS.map((a, i) => {
            const t = p(at(1) + 12 + i * 10, 28);
            const color = a.tone === "green" ? C.green : C.ink;
            return (
              <div key={a.label} style={{ opacity: Math.min(1, t * 3) }}>
                <div style={{ fontFamily: FONT.display, fontSize: 27, color: C.ink }}>{a.label}</div>
                <div style={{ display: "flex", alignItems: "center", gap: 18, marginTop: 8 }}>
                  <div style={{ position: "relative", width: 470, height: 40, background: C.paper2, borderRadius: 4 }}>
                    <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${(a.ms / maxMs) * t * 100}%`, background: color, borderRadius: 4 }} />
                  </div>
                  <Mono size={30} color={color} weight={500}>{Math.round(a.ms * t).toLocaleString("en-US")} ms</Mono>
                </div>
                <Mono size={23} color={C.ink3} style={{ display: "block", marginTop: 6 }}>{a.lines} {a.unit}</Mono>
              </div>
            );
          })}
        </div>
        <Rise at={at(1) + 56} style={{ marginTop: 34 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 18, border: `3px solid ${C.rust}`, background: C.rustSoft, borderRadius: 14, padding: "14px 24px" }}>
            <Pill tone="bad" size={24}>slowest arm</Pill>
            <div style={{ fontFamily: FONT.display, fontSize: 27, lineHeight: 1.25 }}>It saved lines of code, not run time. No time saving is claimed.</div>
          </div>
        </Rise>
      </div>
    </div>
  );
}
