import React from "react";
import { interpolate, useCurrentFrame } from "remotion";
import { C, FONT, ease } from "../theme";
import { timeline } from "../lib/data";

interface Chunk {
  text: string;
  from: number;
  to: number;
}

/** Splits each narration beat into on-screen lines of at most about 105 characters, timed by character share of the beat. */
function buildChunks(): Chunk[] {
  const out: Chunk[] = [];
  for (const scene of timeline.scenes) {
    for (const beat of scene.beats) {
      const sentences = beat.text.split(/(?<=[.:;?!])\s+/);
      const groups: string[] = [];
      for (const s of sentences) {
        const last = groups[groups.length - 1];
        if (last !== undefined && last.length + s.length + 1 <= 105) groups[groups.length - 1] = `${last} ${s}`;
        else groups.push(s);
      }
      const total = groups.reduce((n, g) => n + g.length, 0);
      let cursor = scene.start + beat.startFrame;
      for (const g of groups) {
        const frames = Math.max(12, Math.round((g.length / total) * beat.frames));
        out.push({ text: g, from: cursor, to: cursor + frames });
        cursor += frames;
      }
    }
  }
  return out;
}
const CHUNKS = buildChunks();

/** Burned-in subtitles: exactly the words of the voiceover, in the strip below the product. */
export const Captions: React.FC = () => {
  const frame = useCurrentFrame();
  const chunk = CHUNKS.find((c) => frame >= c.from && frame < c.to + 6);
  if (!chunk) return null;
  const t = interpolate(frame, [chunk.from, chunk.from + 6, chunk.to, chunk.to + 6], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  return (
    <div style={{ position: "absolute", left: 96, right: 96, bottom: 24, height: 68, display: "flex", alignItems: "center", justifyContent: "center", opacity: t }}>
      <div style={{ background: C.ink, color: C.paper, borderRadius: 10, padding: "10px 30px 12px", fontFamily: FONT.display, fontWeight: 400, fontSize: 33, lineHeight: 1.18, textAlign: "center", maxWidth: 1728, boxShadow: "0 14px 30px -16px rgba(14,17,22,.55)" }}>
        {chunk.text}
      </div>
    </div>
  );
};
