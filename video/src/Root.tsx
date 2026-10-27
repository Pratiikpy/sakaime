import React, { useEffect, useState } from "react";
import { AbsoluteFill, Audio, Composition, Sequence, continueRender, delayRender, getInputProps, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Captions } from "./components/Captions";
import { C, FONT, H, W, ease } from "./theme";
import { timeline } from "./lib/data";
import { SceneProvider } from "./components/motion";
import audioInfo from "./generated/audio.json";
import { SCENE_COMPONENTS } from "./scenes";

const FONT_FILES: [string, string, number][] = [
  ["Outfit", "fonts/Outfit-Regular.ttf", 400],
  ["Outfit", "fonts/Outfit-SemiBold.ttf", 600],
  ["JetBrains Mono", "fonts/JetBrainsMono-Regular.ttf", 400],
  ["JetBrains Mono", "fonts/JetBrainsMono-Medium.ttf", 500],
];

function useFonts() {
  const [handle] = useState(() => delayRender("fonts"));
  useEffect(() => {
    Promise.all(
      FONT_FILES.map(async ([family, file, weight]) => {
        const face = new FontFace(family, `url(${staticFile(file)})`, { weight: String(weight) });
        await face.load();
        (document.fonts as unknown as { add(f: FontFace): void }).add(face);
      }),
    )
      .then(() => continueRender(handle))
      .catch((e) => {
        console.error(e);
        continueRender(handle);
      });
  }, [handle]);
}

/** Ink bar that sweeps off to the right at every scene start, the only transition in the video. */
function Wipes() {
  const frame = useCurrentFrame();
  const WIPE = 13;
  return (
    <>
      {timeline.scenes.slice(1).map((s) => {
        if (frame < s.start || frame > s.start + WIPE) return null;
        const t = interpolate(frame, [s.start, s.start + WIPE], [0, 1], { extrapolateRight: "clamp", easing: ease });
        return <div key={s.id} style={{ position: "absolute", top: 0, bottom: 0, left: `${t * 100}%`, right: 0, background: C.ink }} />;
      })}
    </>
  );
}

/** Progress hairline with chapter ticks. */
function Progress() {
  const frame = useCurrentFrame();
  const total = timeline.totalFrames;
  const x = (f: number) => (f / total) * W;
  return (
    <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 8 }}>
      <div style={{ position: "absolute", inset: 0, background: C.paper2 }} />
      <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: x(frame), background: C.ink }} />
      <div style={{ position: "absolute", left: Math.max(0, x(frame) - 16), top: 0, bottom: 0, width: 16, background: C.green }} />
      {timeline.scenes.slice(1).map((s) => (
        <div key={s.id} style={{ position: "absolute", left: x(s.start), top: 0, bottom: 0, width: 2, background: C.paper }} />
      ))}
    </div>
  );
}

export const Main: React.FC = () => {
  useFonts();
  return (
    <AbsoluteFill style={{ background: C.paper, fontFamily: FONT.display, color: C.ink }}>
      {audioInfo.mix ? <Audio src={staticFile(audioInfo.mix)} /> : null}
      {timeline.scenes.map((s, i) => {
        const Scene = SCENE_COMPONENTS[s.id];
        if (!Scene) throw new Error(`no scene component for ${s.id}`);
        return (
          <Sequence key={s.id} from={s.start} durationInFrames={s.frames} name={s.id}>
            <SceneProvider value={s}>
              <AbsoluteFill>
                <Scene index={i} />
              </AbsoluteFill>
            </SceneProvider>
          </Sequence>
        );
      })}
      <Wipes />
      {getInputProps().captions === true ? <Captions /> : null}
      <Progress />
    </AbsoluteFill>
  );
};

export const Root: React.FC = () => (
  <Composition id="Sakaime" component={Main} durationInFrames={timeline.totalFrames} fps={timeline.fps} width={W} height={H} />
);
