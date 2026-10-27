import React from "react";
import { C, FONT, LABEL_WORDS } from "../theme";
import { Rise, useScene } from "../components/motion";
import { Eyebrow, Mono, Pill, RelationBadge } from "../components/ui";
import { caseEyeart } from "../lib/data";

const LAYERS = [
  { id: "L0", name: "Guard", does: "screens intent, quarantines injected text" },
  { id: "L1", name: "Discovery", does: "allowlist, bounded fetch, probe, mapping" },
  { id: "L2", name: "Federation", does: "Zetaris: one statement, policies, semantic layer" },
  { id: "L3", name: "Identity", does: "typed links; uncertain stays uncertain" },
  { id: "L4", name: "Extraction", does: "quotes pinned to page and region" },
  { id: "L5", name: "Memory", does: "World Model, H-MEM" },
  { id: "L6", name: "Compiler", does: "claimed against established, per dimension" },
  { id: "L7", name: "Investigation", does: "Nemotron roles, critic, retry" },
  { id: "L8", name: "Dossier", does: "signed bundle and offline verifier" },
] as const;

const ROW_H = 88;
const TOP = 150;
// beat that lights each layer (0: guard to federation, 1: identity to memory, 2: compiler, 3: investigation and dossier)
const LAYER_BEAT = [0, 0, 0, 1, 1, 1, 2, 3, 3];

const finding = caseEyeart.findings.find((f: { claimId: string }) => f.claimId === "CLM-EA-01");
const anchor = caseEyeart.anchors[0];
const link = caseEyeart.links[0];
const clip = (s: string | undefined, n: number) => (!s ? "not stated" : s.length > n ? s.slice(0, n - 1) + "…" : s);
const DIM_NAMES: Record<string, string> = { timing: "date" };

export function Pipeline() {
  const { at, p, frame } = useScene();
  const sub = (i: number) => {
    const first = LAYER_BEAT.indexOf(LAYER_BEAT[i] as number);
    return at(LAYER_BEAT[i] as number) + (i - first) * 11;
  };
  const lit = LAYERS.map((_, i) => p(sub(i), 14));
  const lastLit = Math.max(0, ...lit.map((v, i) => (v > 0.05 ? i : 0)));
  const tokenY = TOP + lastLit * ROW_H + 14;
  const showTable = frame >= at(2) - 4;
  const tableT = p(at(2), 20);
  const b3 = at(3);

  const chips: Record<string, string> = {
    L0: "no instruction found in the request",
    L1: "allowlist: pass",
    L2: `${caseEyeart.matrix.rows.length} rows · ${caseEyeart.matrix.servedFrom === "cassette" ? "recorded" : "live"} · one statement`,
    L3: `${link.type.toLowerCase().replace(/_/g, " ")} · ${link.state.toLowerCase()}`,
    L4: `page ${anchor.page} · ${clip(anchor.sourceLabel, 30)}`,
    L5: "history kept; dependencies recorded",
    L6: LABEL_WORDS[finding.label] ?? finding.label,
    L7: "planner · checker · critic · reporter",
    L8: "hashes and signature written",
  };

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      <div style={{ position: "absolute", left: 108, top: 64 }}>
        <Rise at={2}><Eyebrow>How one claim travels</Eyebrow></Rise>
      </div>

      {/* the nine layers */}
      {LAYERS.map((l, i) => {
        const t = lit[i] as number;
        return (
          <div key={l.id} style={{ position: "absolute", left: 108, top: TOP + i * ROW_H, width: 860, height: ROW_H - 12, border: `2px solid ${t > 0.5 ? C.ink : C.line}`, borderRadius: 12, background: t > 0.5 ? C.paper : C.paper2, display: "flex", alignItems: "center", gap: 20, padding: "0 22px", opacity: 0.35 + 0.65 * t }}>
            <Mono size={26} color={t > 0.5 ? C.green : C.ink3} weight={500}>{l.id}</Mono>
            <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 30, width: 190 }}>{l.name}</div>
            <div style={{ fontFamily: FONT.display, fontSize: 23, color: C.ink2, lineHeight: 1.15 }}>{l.does}</div>
          </div>
        );
      })}

      {/* the claim token riding down the stack */}
      <div style={{ position: "absolute", left: 82, top: tokenY, width: 22, height: 22, borderRadius: 11, background: C.green, boxShadow: `0 0 0 8px ${C.greenSoft}`, transition: "none" }} />

      {/* the right panel */}
      <div style={{ position: "absolute", left: 1010, top: 150, width: 802 }}>
        <Rise at={at(0) + 4}>
          <div style={{ borderLeft: `8px solid ${C.ink}`, background: C.paper2, borderRadius: 8, padding: "16px 26px" }}>
            <Mono size={22} color={C.ink3}>CLM-EA-01 · constructed claim</Mono>
            <div style={{ fontFamily: FONT.display, fontSize: 28, lineHeight: 1.25, marginTop: 6 }}>EyeArt 2.1.0 detects more than mild diabetic retinopathy in primary care and eye care.</div>
          </div>
        </Rise>

        {!showTable && (
          <div style={{ marginTop: 26, display: "flex", flexDirection: "column", gap: 12 }}>
            {LAYERS.slice(0, 6).map((l, i) => {
              const t = lit[i] as number;
              return (
                <div key={l.id} style={{ opacity: t, transform: `translateX(${(1 - t) * 40}px)`, display: "flex", alignItems: "center", gap: 14 }}>
                  <Mono size={22} color={C.green} weight={500}>{l.id}</Mono>
                  <Pill tone="neutral" size={24}>{chips[l.id]}</Pill>
                </div>
              );
            })}
          </div>
        )}

        {showTable && (
          <div style={{ marginTop: 22, opacity: tableT }}>
            <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 150px", gap: "0 14px", fontFamily: FONT.mono, fontSize: 20, color: C.ink3, padding: "0 6px 8px" }}>
              <span>DIMENSION</span><span>CLAIMED · ESTABLISHED</span><span>RELATION</span>
            </div>
            {finding.mechanicalCoverage.map((m: { dimension: string; relation: string; claimed?: string; established?: string }, i: number) => {
              const t = p(at(2) + 6 + i * 6, 14);
              return (
                <div key={m.dimension} style={{ display: "grid", gridTemplateColumns: "150px 1fr 150px", gap: "0 14px", alignItems: "center", padding: "9px 6px", borderTop: `1px solid ${C.line}`, opacity: t, transform: `translateY(${(1 - t) * 14}px)` }}>
                  <span style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 26 }}>{DIM_NAMES[m.dimension] ?? m.dimension}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 19, color: C.ink2, lineHeight: 1.25 }}>
                    {clip(m.claimed, 44)}
                    <br />
                    <span style={{ color: C.ink3 }}>{clip((m.established ?? "").replace(/^authorization record: /, ""), 44)}</span>
                  </span>
                  <RelationBadge relation={m.relation} size={22} />
                </div>
              );
            })}
            <div style={{ marginTop: 14, display: "flex", alignItems: "center", gap: 14, opacity: p(at(2) + 6 + 7 * 6, 14) }}>
              <Mono size={22} color={C.ink3}>L6 result</Mono>
              <Pill tone="good" size={28}>{LABEL_WORDS[finding.label]}</Pill>
            </div>
          </div>
        )}

        {frame >= b3 && (
          <Rise at={b3 + 4} style={{ position: "absolute", left: 0, top: 640, width: 802 }}>
            <div style={{ display: "flex", gap: 20 }}>
              <div style={{ flex: 1, border: `3px dashed ${C.ink}`, borderRadius: 14, padding: "18px 22px" }}>
                <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 32 }}>Models propose</div>
                <div style={{ fontFamily: FONT.display, fontSize: 24, color: C.ink2, marginTop: 4 }}>mappings, readings, objections</div>
              </div>
              <div style={{ flex: 1, border: `3px solid ${C.green}`, borderRadius: 14, padding: "18px 22px", background: C.greenSoft }}>
                <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 32, color: C.green }}>Code decides</div>
                <div style={{ fontFamily: FONT.display, fontSize: 24, color: C.ink2, marginTop: 4 }}>every check, every label</div>
              </div>
            </div>
          </Rise>
        )}
      </div>
    </div>
  );
}

