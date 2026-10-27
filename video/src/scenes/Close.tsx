import React from "react";
import { C, FONT } from "../theme";
import { Reveal, Rise, useScene } from "../components/motion";
import { Mono, Wordmark } from "../components/ui";

export function Close() {
  const { p } = useScene();
  const line = p(26, 30);
  return (
    <div style={{ position: "absolute", inset: 0, padding: "190px 160px 0" }}>
      <Rise at={2}><Wordmark size={64} /></Rise>
      <div style={{ marginTop: 56 }}>
        <Reveal at={8} dur={26}>
          <div style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 128, lineHeight: 1.02, letterSpacing: -3.4 }}>Know where the evidence stops.</div>
        </Reveal>
      </div>
      <div style={{ marginTop: 64, height: 6, width: `${line * 62}%`, background: C.green, borderRadius: 3 }} />
      <div style={{ marginTop: 50, display: "flex", gap: 36, alignItems: "stretch" }}>
        <Rise at={30}>
          <div style={{ border: `3px solid ${C.ink}`, borderRadius: 14, padding: "20px 32px", background: C.paper2 }}>
            <Mono size={20} color={C.ink3}>REPOSITORY</Mono>
            <div style={{ fontFamily: FONT.mono, fontSize: 38, color: C.ink, marginTop: 6, fontWeight: 500 }}>github.com/Pratiikpy/sakaime</div>
          </div>
        </Rise>
        <Rise at={38}>
          <div style={{ border: `3px solid ${C.ink}`, borderRadius: 14, padding: "20px 32px", background: C.ink }}>
            <Mono size={20} color="#9ba39a">NO KEYS, NO NETWORK</Mono>
            <div style={{ fontFamily: FONT.mono, fontSize: 38, color: "#46c987", marginTop: 6, fontWeight: 500 }}>$ npm run judge</div>
          </div>
        </Rise>
      </div>
      <Rise at={50} style={{ marginTop: 64 }}>
        <div style={{ fontFamily: FONT.display, fontSize: 28, color: C.ink2, lineHeight: 1.35, maxWidth: 1500 }}>
          Constructed claims, labelled. Recorded replies, labelled. A demo signing key. Apache-2.0. Built for Track 1, Solving Fragmented Intelligence, Open Agent Hackathon 2026.
        </div>
      </Rise>
    </div>
  );
}
