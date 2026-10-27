import React from "react";
import { C, FONT } from "../theme";
import { Reveal, Rise, useScene } from "../components/motion";
import { Eyebrow, Mono, Pill } from "../components/ui";
import { SILOS } from "../content";
import { $ } from "../lib/data";

// What each silo calls its key. These are the real field names the connectors read (k_number in openFDA, nct_id in
// ClinicalTrials.gov, pmid in PubMed); the vendor packet and the hospital database are constructed and say so.
const SILO_META: Record<(typeof SILOS)[number], { key: string; real: boolean; note: string }> = {
  Regulator: { key: "k_number", real: true, note: "FDA decision summaries" },
  "Trial registry": { key: "nct_id", real: true, note: "ClinicalTrials.gov" },
  Literature: { key: "pmid · doi", real: true, note: "PubMed, Europe PMC, Crossref" },
  "Vendor packet": { key: "claim_id", real: false, note: "claims and versions" },
  "Hospital requirements": { key: "case_id", real: false, note: "the intended use" },
};

const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const CARD_W = 316;
const GAP = 30;
const X0 = 108;

export function Problem() {
  const { at, p } = useScene();
  const b1 = at(1);
  const join = p(b1 + 4, 30);
  const bar = p(b1 + 26, 22);
  const you = p(b1 + 46, 22);
  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: X0, top: 120 }}>
        <Rise at={4}>
          <Eyebrow>Fragmented evidence</Eyebrow>
        </Rise>
        <div style={{ marginTop: 30 }}>
          <Reveal at={8} dur={22}>
            <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 84, letterSpacing: -2, lineHeight: 1.04 }}>{cap($("{local.silos:w} systems. No shared identifier."))}</div>
          </Reveal>
        </div>
      </div>

      {SILOS.map((name, i) => {
        const m = SILO_META[name];
        const t = p(at(0) + 16 + i * 7, 20);
        const left = X0 + i * (CARD_W + GAP);
        return (
          <div key={name} style={{ position: "absolute", left, top: 400, width: CARD_W, opacity: t, transform: `translateY(${(1 - t) * 30}px)` }}>
            <div style={{ border: `2px solid ${m.real ? C.ink : C.lineStrong}`, borderStyle: m.real ? "solid" : "dashed", borderRadius: 14, padding: "26px 24px", background: C.paper, height: 250 }}>
              <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 34, lineHeight: 1.1 }}>{name}</div>
              <div style={{ marginTop: 10, fontFamily: FONT.display, fontSize: 24, color: C.ink2 }}>{m.note}</div>
              <div style={{ marginTop: 22 }}>
                <Mono size={24} color={C.ink} weight={500}>{m.key}</Mono>
              </div>
              <div style={{ marginTop: 18 }}>
                <Pill tone={m.real ? "neutral" : "dashed"} size={20}>{m.real ? "real records" : "constructed"}</Pill>
              </div>
            </div>
            {i < SILOS.length - 1 && (
              <div style={{ position: "absolute", left: CARD_W + 1, top: 110, width: GAP - 2, height: 4, borderTop: `4px dotted ${C.rust}`, opacity: 1 - join }} />
            )}
          </div>
        );
      })}

      {/* the join */}
      <div style={{ position: "absolute", left: X0, top: 690, width: 5 * CARD_W + 4 * GAP }}>
        <div style={{ position: "relative", height: 120 }}>
          {SILOS.map((_, i) => (
            <div key={i} style={{ position: "absolute", left: i * (CARD_W + GAP) + CARD_W / 2 - 2, top: 0, width: 4, height: 62 * join, background: C.green }} />
          ))}
          <div style={{ position: "absolute", left: 0, top: 58, height: 60, width: `${bar * 100}%`, background: C.green, borderRadius: 8, overflow: "hidden", display: "flex", alignItems: "center", paddingLeft: 28 }}>
            <span style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 32, color: C.paper, whiteSpace: "nowrap", opacity: bar > 0.7 ? 1 : 0 }}>One federated statement through Zetaris</span>
          </div>
        </div>
        <div style={{ marginTop: 28, display: "flex", alignItems: "center", gap: 28, opacity: you, transform: `translateY(${(1 - you) * 18}px)` }}>
          <div style={{ border: `3px solid ${C.ink}`, borderRadius: 12, padding: "16px 28px", fontFamily: FONT.display, fontWeight: 600, fontSize: 34 }}>Sakaime</div>
          <div style={{ fontFamily: FONT.display, fontSize: 38, color: C.ink3 }}>compares with</div>
          <div style={{ border: `3px dashed ${C.rust}`, borderRadius: 12, padding: "16px 28px", fontFamily: FONT.display, fontWeight: 600, fontSize: 34, color: C.rust }}>your use</div>
        </div>
      </div>
    </div>
  );
}
