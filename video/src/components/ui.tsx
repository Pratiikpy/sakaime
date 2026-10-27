import React from "react";
import { C, FONT, RELATION } from "../theme";

export function Mono({ children, size = 26, color = C.ink2, weight = 400, style }: { children: React.ReactNode; size?: number; color?: string; weight?: number; style?: React.CSSProperties }) {
  return <span style={{ fontFamily: FONT.mono, fontSize: size, color, fontWeight: weight, letterSpacing: 0, ...style }}>{children}</span>;
}

export function Eyebrow({ children, color = C.green }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14, fontFamily: FONT.display, fontWeight: 600, fontSize: 26, letterSpacing: 3.2, textTransform: "uppercase", color }}>
      <span style={{ width: 34, height: 8, background: C.ink, borderRadius: 1 }} />
      {children}
    </div>
  );
}

export function Pill({ children, tone = "neutral", size = 26 }: { children: React.ReactNode; tone?: "neutral" | "good" | "bad" | "ink" | "dashed"; size?: number }) {
  const t = {
    neutral: { fg: C.ink2, bg: C.paper2, bd: C.lineStrong, st: "solid" },
    good: { fg: C.green, bg: C.greenSoft, bd: C.greenLine, st: "solid" },
    bad: { fg: C.rust, bg: C.rustSoft, bd: C.rustLine, st: "solid" },
    ink: { fg: C.paper, bg: C.ink, bd: C.ink, st: "solid" },
    dashed: { fg: C.ink, bg: C.paper, bd: C.ink, st: "dashed" },
  }[tone];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10, padding: `${size * 0.2}px ${size * 0.55}px`, borderRadius: 999, border: `2px ${t.st} ${t.bd}`, background: t.bg, color: t.fg, fontFamily: FONT.display, fontWeight: 600, fontSize: size, lineHeight: 1.1, whiteSpace: "nowrap" }}>
      {children}
    </span>
  );
}

export function RelationBadge({ relation, size = 24 }: { relation: string; size?: number }) {
  const r = RELATION[relation] ?? RELATION["UNKNOWN"]!;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, padding: `${size * 0.18}px ${size * 0.6}px`, borderRadius: 999, border: `2px ${relation === "PARTIAL" ? "dashed" : relation === "UNKNOWN" ? "dotted" : "solid"} ${r.line}`, background: r.bg, color: r.fg, fontFamily: FONT.display, fontWeight: 600, fontSize: size, whiteSpace: "nowrap" }}>
      {r.word}
    </span>
  );
}

export function Card({ children, style, tone = "plain" }: { children: React.ReactNode; style?: React.CSSProperties; tone?: "plain" | "ink" | "bad" | "good" }) {
  const t = { plain: [C.paper, C.line], ink: [C.paper, C.ink], bad: [C.rustSoft, C.rustLine], good: [C.greenSoft, C.greenLine] }[tone];
  return <div style={{ background: t[0], border: `2px solid ${t[1]}`, borderRadius: 14, boxShadow: "0 1px 0 rgba(14,17,22,.04), 0 18px 40px -26px rgba(14,17,22,.35)", ...style }}>{children}</div>;
}

/** A short horizontal bar and its words, used by the results charts. */
export function Wordmark({ size = 44 }: { size?: number }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: size * 0.24, fontFamily: FONT.display, fontWeight: 600, fontSize: size, color: C.ink, letterSpacing: -0.02 * size }}>
      <span style={{ display: "inline-flex", gap: size * 0.1, alignItems: "center" }}>
        <span style={{ width: size * 0.5, height: size * 0.16, background: C.ink, borderRadius: 1 }} />
        <span style={{ width: size * 0.23, height: size * 0.16, background: C.green, borderRadius: 1 }} />
      </span>
      Sakaime
      <span style={{ fontSize: size * 0.5, color: C.ink3, letterSpacing: size * 0.04, fontWeight: 400 }}>境目</span>
    </div>
  );
}
