import React from "react";
import { C, FONT } from "../theme";
import { Rise, useScene } from "../components/motion";
import { Eyebrow, Mono, Pill } from "../components/ui";
import { $, kn, mean, runs } from "../lib/data";

const runWord = (key: string) => `${runs(key)} ${runs(key) === 1 ? "run" : "runs"}`;

interface Bar {
  label: string;
  rate: number;
  value: string;
  tone: "green" | "ink" | "rust";
  note?: string;
}

const pct = (r: number) => `${Math.round(r * 100)}%`;
const rate = (k: string) => {
  const v = kn(k);
  return v.k / v.n;
};

// Chart A: unsupported development claims labelled supported (lower is better). Every value is read from a results file.
const FALSE_SUPPORTED: Bar[] = [
  { label: "Sakaime", rate: rate("dev.V.falseSupported"), value: $("{dev.V.falseSupported}"), tone: "green" },
  { label: "Keyword rules", rate: rate("dev.B1.falseSupported"), value: $("{dev.B1.falseSupported}"), tone: "ink" },
  { label: "Source by source", rate: rate("dev.B2.falseSupported"), value: $("{dev.B2.falseSupported}"), tone: "ink" },
  { label: "One Nemotron call", rate: mean("dev.B3.falseSupported"), value: `${pct(mean("dev.B3.falseSupported"))}, mean of ${runWord("dev.B3.falseSupported")}`, tone: "ink" },
  { label: "Tool-using Nemotron", rate: mean("dev.B4.falseSupported"), value: `${pct(mean("dev.B4.falseSupported"))}, ${runWord("dev.B4.falseSupported")}`, tone: "ink" },
];

// Chart B: exactly the right label (higher is better). Sakaime is lower than both generic arms: shown as such.
const EXACT: Bar[] = [
  { label: "Sakaime", rate: rate("dev.V.exact"), value: $("{dev.V.exact}"), tone: "rust" },
  { label: "One Nemotron call", rate: mean("dev.B3.exact"), value: `${pct(mean("dev.B3.exact"))}, mean of ${runWord("dev.B3.exact")}`, tone: "ink" },
  { label: "Tool-using Nemotron", rate: mean("dev.B4.exact"), value: `${pct(mean("dev.B4.exact"))}, ${runWord("dev.B4.exact")}`, tone: "ink" },
];

function Bars({ title, sub, bars, at, width }: { title: string; sub: string; bars: Bar[]; at: number; width: number }) {
  const { p } = useScene();
  return (
    <div style={{ width }}>
      <Rise at={at}>
        <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 32, lineHeight: 1.15 }}>{title}</div>
        <div style={{ display: "flex", gap: 10, marginTop: 8, alignItems: "center" }}>
          <Mono size={20} color={C.ink3}>{sub}</Mono>
          <Pill tone="dashed" size={18}>builder-labelled</Pill>
        </div>
      </Rise>
      <div style={{ marginTop: 16, display: "flex", flexDirection: "column", gap: 9 }}>
        {bars.map((b, i) => {
          const t = p(at + 10 + i * 6, 26);
          const color = b.tone === "green" ? C.green : b.tone === "rust" ? C.rust : C.ink;
          return (
            <div key={b.label} style={{ opacity: Math.min(1, t * 3) }}>
              <div style={{ fontFamily: FONT.display, fontSize: 23, color: C.ink2, marginBottom: 2 }}>{b.label}</div>
              <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
                <div style={{ position: "relative", height: 27, width: width - 330, background: C.paper2, borderRadius: 4 }}>
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${Math.max(b.rate * t, b.rate > 0 ? 0.004 : 0) * 100}%`, background: color, borderRadius: 4, minWidth: b.rate === 0 ? 5 : 0 }} />
                </div>
                <div style={{ fontFamily: FONT.mono, fontSize: 21, color, fontWeight: 500, width: 300, lineHeight: 1.15 }}>{b.value}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Tile({ title, big, line, tag, at, tone = "plain" }: { title: string; big: string; line: string; tag: string; at: number; tone?: "plain" | "warn" }) {
  return (
    <Rise at={at} dy={22}>
      <div style={{ border: `2px solid ${tone === "warn" ? C.rustLine : C.line}`, background: tone === "warn" ? C.rustSoft : C.paper, borderRadius: 14, padding: "18px 22px", height: 232, width: 408, boxSizing: "border-box" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 25, color: C.ink2 }}>{title}</div>
          <Pill tone="dashed" size={17}>{tag}</Pill>
        </div>
        <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 54, letterSpacing: -1, marginTop: 6, color: tone === "warn" ? C.rust : C.ink }}>{big}</div>
        <div style={{ fontFamily: FONT.display, fontSize: 22, color: C.ink2, lineHeight: 1.22, marginTop: 4 }}>{line}</div>
      </div>
    </Rise>
  );
}

export function Results() {
  const { at } = useScene();
  const held = kn("ho.V.exact");
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 108, top: 64 }}>
        <Rise at={2}><Eyebrow>Measured, including the rows that do not flatter us</Eyebrow></Rise>
      </div>
      <div style={{ position: "absolute", left: 108, top: 130, display: "flex", gap: 70 }}>
        <Bars at={at(1)} width={850} title={$("Unsupported claims labelled supported, of {dev.V.falseSupported:n}")} sub="development set, lower is better" bars={FALSE_SUPPORTED} />
        <Bars at={at(2)} width={780} title={$("Exactly the right label, of {dev.V.exact:n}")} sub="development set, higher is better" bars={EXACT} />
      </div>
      <Rise at={at(2) + 34} style={{ position: "absolute", left: 1010, top: 500 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 18, border: `3px solid ${C.rust}`, background: C.rustSoft, borderRadius: 14, padding: "12px 24px" }}>
          <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 46, color: C.rust }}>{$("{dev.V.falseAlarm}")}</div>
          <div style={{ fontFamily: FONT.display, fontSize: 26, lineHeight: 1.2, color: C.ink }}>well-supported claims flagged.<br />Conservative, and it costs exact matches.</div>
        </div>
      </Rise>

      <div style={{ position: "absolute", left: 108, top: 668, display: "flex", gap: 24 }}>
        <Tile at={at(3)} title="Held-out, second look" big={$("{ho.V.exact}")} line={$("exact; none of {ho.V.falseSupported:n} unsupported labelled supported. Not a blind test.")} tag="builder-labelled" />
        <Tile at={at(3) + 8} title="Identity links" big={$("{id.falseMerge}")} line={$("false merges; a fuzzy-name match made {id.fuzzyFalseMerge}.")} tag="builder-labelled" />
        <Tile at={at(3) + 16} title="Failure drills" big={$("{fail.all}")} line="ended in the correct state." tag="consistency" />
        <Tile at={at(3) + 24} title="Change impact" big={$("{time.stale}")} line={$("stale set equals dependent set; {time.staleFindings} flagged, {time.affected} changed.")} tag="consistency" tone="warn" />
      </div>
      <Rise at={at(3) + 34} style={{ position: "absolute", left: 108, top: 912 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 24, color: C.ink2, maxWidth: 1640, lineHeight: 1.3 }}>
          Consistency means the code matches the rule table its authors wrote. Builder-labelled means one person wrote the answers. No clinician or independent reviewer has read either.
        </div>
      </Rise>
    </div>
  );
}
