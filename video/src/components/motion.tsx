import React, { createContext, useContext } from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, ease, easeInOut } from "../theme";
import type { SceneTime } from "../lib/data";

/** The scene a component is rendered in: its beats in scene-local frames. */
const SceneContext = createContext<SceneTime | null>(null);
export const SceneProvider = SceneContext.Provider;

export function useScene() {
  const scene = useContext(SceneContext);
  if (!scene) throw new Error("useScene outside a scene");
  const frame = useCurrentFrame();
  return {
    scene,
    frame,
    /** Local frame at which beat i starts (its first word). */
    at: (i: number) => scene.beats[Math.min(i, scene.beats.length - 1)]?.startFrame ?? 0,
    /** Frame at which beat i has finished. */
    end: (i: number) => {
      const b = scene.beats[Math.min(i, scene.beats.length - 1)];
      return b ? b.startFrame + b.frames : 0;
    },
    /** 0..1 progress of a move that starts at `from` (local frame) and takes `dur` frames. */
    p: (from: number, dur = 18) => interpolate(frame, [from, from + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease }),
    pio: (from: number, dur = 18) => interpolate(frame, [from, from + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut }),
  };
}

/** Fade and rise, the default entrance. */
export function Rise({ at, dur = 16, dy = 26, children, style }: { at: number; dur?: number; dy?: number; children: React.ReactNode; style?: React.CSSProperties }) {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [at, at + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  return <div style={{ opacity: t, transform: `translateY(${(1 - t) * dy}px)`, ...style }}>{children}</div>;
}

/**
 * The redaction bar: an ink bar sweeps across the text, then wipes off to the right and the text appears under its trailing edge.
 * It is the one decorative motion in the video and it always means "this is being revealed".
 */
export function Reveal({ at, dur = 22, bar = C.ink, children, style, inline = false }: { at: number; dur?: number; bar?: string; children: React.ReactNode; style?: React.CSSProperties; inline?: boolean }) {
  const frame = useCurrentFrame();
  const half = dur / 2;
  const cover = interpolate(frame, [at, at + half], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const leave = interpolate(frame, [at + half, at + dur], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
  const visible = frame >= at + half;
  return (
    <span style={{ position: "relative", display: inline ? "inline-block" : "block", ...style }}>
      <span style={{ display: "block", clipPath: visible ? `inset(0 ${(1 - leave) * 100}% 0 0)` : "inset(0 100% 0 0)" }}>{children}</span>
      {frame < at + dur && frame >= at && (
        <span style={{ position: "absolute", top: "4%", bottom: "4%", left: `${leave * 100}%`, right: `${(1 - cover) * 100}%`, background: bar, borderRadius: 2 }} />
      )}
    </span>
  );
}

/** Words rise in one after another. */
export function Kinetic({ text, at, stagger = 3, size, weight = 600, color = C.ink, style, dy = 30 }: { text: string; at: number; stagger?: number; size: number; weight?: number; color?: string; style?: React.CSSProperties; dy?: number }) {
  const frame = useCurrentFrame();
  const words = text.split(" ");
  return (
    <div style={{ fontFamily: FONT.display, fontSize: size, fontWeight: weight, color, lineHeight: 1.08, letterSpacing: -0.02 * size, ...style }}>
      {words.map((w, i) => {
        const t = interpolate(frame, [at + i * stagger, at + i * stagger + 16], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
        return (
          <span key={i} style={{ display: "inline-block", opacity: t, transform: `translateY(${(1 - t) * dy}px)`, marginRight: size * 0.26 }}>
            {w}
          </span>
        );
      })}
    </div>
  );
}

export function useFps() {
  return useVideoConfig().fps;
}
