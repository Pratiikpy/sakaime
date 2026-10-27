import React from "react";
import { Freeze, OffthreadVideo, Sequence, getInputProps, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { C, FONT, ease, easeInOut } from "../theme";
import { useScene } from "./motion";
import { Mono } from "./ui";
import { $, mode } from "../lib/data";
import type { FootageConfig } from "../footageConfigs";
import { CLIP_H, CLIP_W, cameraAt, cueOf, frameOfClipTime, openingAnchor, segmentsFrom, type Anchor, type Box, type CamKey, type Segment } from "../lib/footage";
import { clips } from "../lib/clipData";

const MIN_ZOOM = 1.2;
const MAX_COLUMN_ZOOM = 1.3;
/** The part of an element that is on the screen at the moment it was marked. */
const visible = (b: Box): Box => {
  const x0 = Math.max(0, b.x);
  const y0 = Math.max(0, b.y);
  const x1 = Math.min(CLIP_W, b.x + b.w);
  const y1 = Math.min(CLIP_H, b.y + b.h);
  return { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) };
};
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

// Stage: the product is shown at 0.9 of the frame so there is room for a caption strip and the run mode above it.
// With subtitles the stage leaves room for the caption bar below it; without them it uses the room.
const STAGE = { x: 96, y: 88, w: 1728, h: getInputProps().captions === true ? 880 : 950 };
const BASE = STAGE.w / CLIP_W; // 0.9
const STAGE_BOX_H = STAGE.h;

const MODE_WORDS = {
  run: (sample: boolean) => (sample ? "Sample run" : "Live run"),
  federation: { live: "Federation: live Zetaris", cassette: "Federation: recorded replies", fallback: "Federation: local fallback", off: "Federation: off" } as Record<string, string>,
  model: { nightshift: "Model: Nemotron via Nightshift", nvidia: "Model: Nemotron via NVIDIA", recorded: "Model: recorded replies", off: "Model: off" } as Record<string, string>,
  sources: (s: string) => (s === "live" ? "Sources: live" : "Sources: recorded"),
};

/** The product's own run-mode banner, restated from the service's health response so it stays visible while the page scrolls. */
export function ModeStrip() {
  const chips = [MODE_WORDS.run(mode.sample), MODE_WORDS.federation[mode.federation] ?? mode.federation, MODE_WORDS.model[mode.model] ?? mode.model, MODE_WORDS.sources(mode.sources)];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Mono size={19} color={C.ink3} weight={500} style={{ letterSpacing: 2 }}>RUN MODE</Mono>
      {chips.map((c) => (
        <span key={c} style={{ fontFamily: FONT.display, fontSize: 21, fontWeight: 600, color: C.ink2, border: `2px solid ${C.lineStrong}`, borderRadius: 999, padding: "3px 14px", background: C.paper2, whiteSpace: "nowrap" }}>{c}</span>
      ))}
    </div>
  );
}

function ClipSegments({ clip, segs, duration, fps }: { clip: string; segs: Segment[]; duration: number; fps: number }) {
  const src = staticFile(`footage/${clip}.mp4`);
  const lastFrame = Math.floor(duration * fps) - 2;
  return (
    <>
      {segs.map((s, i) => {
        const startFrame = Math.round(s.clipStart * fps);
        const avail = Math.max(1, Math.floor((lastFrame - startFrame) / s.rate));
        const len = s.to - s.from;
        const play = Math.min(len, avail);
        return (
          <React.Fragment key={i}>
            <Sequence from={s.from} durationInFrames={play} layout="none">
              <OffthreadVideo src={src} startFrom={startFrame} playbackRate={s.rate} muted style={{ position: "absolute", left: 0, top: 0, width: CLIP_W, height: CLIP_H }} />
            </Sequence>
            {play < len && (
              <Sequence from={s.from + play} durationInFrames={len - play} layout="none">
                <Freeze frame={0}>
                  <OffthreadVideo src={src} startFrom={lastFrame} muted style={{ position: "absolute", left: 0, top: 0, width: CLIP_W, height: CLIP_H }} />
                </Freeze>
              </Sequence>
            )}
          </React.Fragment>
        );
      })}
    </>
  );
}

export function FootageScene({ config }: { config: FootageConfig }) {
  const { at, frame, scene } = useScene();
  const { fps } = useVideoConfig();
  const meta = clips[config.clip];
  if (!meta) {
    return (
      <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: FONT.mono, fontSize: 30, color: C.rust }}>
        footage not recorded: {config.clip}
      </div>
    );
  }

  const has = (n: string) => meta.cues.some((c) => c.name === n);
  const startT = config.startCue ? cueOf(meta, config.startCue).t : (meta.cues.find((c) => c.name === "start")?.t ?? 0.2);
  const pins: Anchor[] = config.sync.filter((x) => has(x.cue)).map((s) => ({ frame: at(s.beat) + (s.offset ?? 0), clipT: cueOf(meta, s.cue).t }));
  const anchors: Anchor[] = [openingAnchor(startT, pins, fps), ...pins];
  const segs = segmentsFrom(anchors, scene.frames, fps);

  // Camera keys: the camera arrives a little before the moment it is about.
  const keys: CamKey[] = (config.camera ?? []).filter((k) => has(k.cue)).map((k) => {
    const cue = cueOf(meta, k.cue);
    const box = cue.box ? visible(cue.box) : null;
    let scale = MIN_ZOOM;
    let fx = CLIP_W / 2;
    let fy = STAGE.h / 2 / (MIN_ZOOM * BASE);
    if (box && k.focus !== "center") {
      // Zoom no further than lets the whole element sit in the frame with a margin, and never out beyond the page column.
      const fit = Math.min(STAGE.w / (BASE * (box.w + 160)), STAGE.h / (BASE * (box.h + 120)));
      // The page column is about 1460 px wide and fits the stage up to 1.3x: up to there the camera stays centred so no paragraph is cut
      // at the edge. Only a narrow element (a field, a chip, a badge row) is zoomed further and centred on itself.
      const cap = box.w < 700 ? 1.7 : MAX_COLUMN_ZOOM;
      scale = Math.max(MIN_ZOOM, Math.min(k.scale, fit, cap));
      fx = scale <= MAX_COLUMN_ZOOM ? CLIP_W / 2 : box.x + box.w / 2 + (k.shiftX ?? 0);
      const visibleH = STAGE.h / (scale * BASE);
      fy = box.h > visibleH * 0.9 ? box.y + visibleH / 2 - 60 : box.y + box.h / 2 + (k.shiftY ?? 0);
    }
    return { frame: frameOfClipTime(segs, cue.t, fps) - Math.round((k.lead ?? 0.6) * fps), scale, fx, fy };
  });
  keys.sort((a, b) => a.frame - b.frame);
  const cam = cameraAt(keys, frame, easeInOut, { scale: MIN_ZOOM, fx: CLIP_W / 2, fy: STAGE.h / 2 / (MIN_ZOOM * BASE) });
  const S = cam.scale * BASE;
  const tx = Math.min(0, Math.max(STAGE.w - S * CLIP_W, STAGE.w / 2 - S * cam.fx));
  const ty = Math.min(0, Math.max(STAGE_BOX_H - S * CLIP_H, STAGE_BOX_H / 2 - S * cam.fy));
  const toStage = (b: Box): Box => ({ x: S * b.x + tx, y: S * b.y + ty, w: S * b.w, h: S * b.h });

  const enter = interpolate(frame, [0, 14], [0, 1], { extrapolateRight: "clamp", easing: ease });

  return (
    <div style={{ position: "absolute", inset: 0 }}>
      {/* caption strip */}
      <div style={{ position: "absolute", left: STAGE.x, right: STAGE.x, top: 22, height: 56, display: "flex", alignItems: "center", justifyContent: "space-between", opacity: enter }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ width: 30, height: 8, background: C.ink, borderRadius: 1 }} />
          <span style={{ fontFamily: FONT.display, fontWeight: 600, fontSize: 30, color: C.ink }}>{cap($(config.caption))}</span>
        </div>
        <ModeStrip />
      </div>

      {/* the product */}
      <div style={{ position: "absolute", left: STAGE.x, top: STAGE.y, width: STAGE.w, height: STAGE.h, overflow: "hidden", borderRadius: 14, border: `2px solid ${C.ink}`, boxShadow: "0 30px 60px -34px rgba(14,17,22,.45)", background: C.paper, opacity: enter }}>
        <div style={{ position: "absolute", left: 0, top: 0, width: CLIP_W, height: CLIP_H, transformOrigin: "0 0", transform: `translate(${tx}px, ${ty}px) scale(${S})` }}>
          <ClipSegments clip={config.clip} segs={segs} duration={meta.duration} fps={fps} />
        </div>

        {(config.callouts ?? []).filter((c) => has(c.cue)).map((c, i) => {
          const cue = cueOf(meta, c.cue);
          if (!cue.box) return null;
          // The outline belongs to the moment the recording was static on this element, so its window is measured in clip time and
          // follows the clip's speed: when the clip moves on, the outline goes.
          const staticFor = Math.min(c.hold ?? 2.4, cue.hold && cue.hold > 0 ? cue.hold + 0.3 : 1.4);
          const f0 = frameOfClipTime(segs, cue.t + (c.from ?? -0.15), fps);
          const f1 = Math.max(f0 + 20, frameOfClipTime(segs, cue.t + staticFor, fps));
          if (frame < f0 || frame > f1 + 10) return null;
          const t = interpolate(frame, [f0, f0 + 10, f1, f1 + 10], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: ease });
          const vb = visible(cue.box);
          const b = toStage({ x: vb.x - 10, y: vb.y - 8, w: vb.w + 20, h: vb.h + 16 });
          const color = c.tone === "bad" ? C.rust : c.tone === "ink" ? C.ink : C.green;
          const above = (c.side ?? "above") === "above" ? b.y > 90 : b.y + b.h + 90 > STAGE_BOX_H;
          // A box that is most of the screen gets no outline: a frame that large says nothing. Its label sits in the corner.
          const huge = b.h > STAGE_BOX_H * 0.72;
          if (huge) {
            return (
              <div key={i} style={{ position: "absolute", left: 28, top: 24, opacity: t, transform: `translateY(${(1 - t) * -10}px)`, background: C.ink, color: C.paper, borderRadius: 8, padding: "9px 20px 11px", fontFamily: FONT.display, fontWeight: 600, fontSize: 30, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 12px 24px -12px rgba(14,17,22,.5)" }}>
                <span style={{ width: 12, height: 12, background: "#46c987", borderRadius: 2 }} />
                {cap($(c.text))}
              </div>
            );
          }
          return (
            <div key={i} style={{ position: "absolute", left: b.x, top: b.y, width: b.w, height: b.h, opacity: t, transform: `scale(${0.97 + 0.03 * t})`, transformOrigin: "50% 50%" }}>
              <div style={{ position: "absolute", inset: 0, border: `5px solid ${color}`, borderRadius: 10, background: c.tone === "bad" ? "rgba(168,50,26,.06)" : "rgba(10,107,58,.06)" }} />
              <div style={{ position: "absolute", left: Math.min(Math.max(0, 14 - b.x), Math.max(0, b.w - 40)), [above ? "bottom" : "top"]: "calc(100% + 12px)", background: C.ink, color: C.paper, borderRadius: 8, padding: "9px 20px 11px", fontFamily: FONT.display, fontWeight: 600, fontSize: 30, whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 12, boxShadow: "0 12px 24px -12px rgba(14,17,22,.5)" }}>
                <span style={{ width: 12, height: 12, background: color === C.ink ? C.greenLine : color === C.green ? "#46c987" : "#ff8f73", borderRadius: 2 }} />
                {cap($(c.text))}
              </div>
            </div>
          );
        })}
      </div>

    </div>
  );
}
