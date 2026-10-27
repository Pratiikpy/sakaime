// Time and camera maths for recorded footage. A clip has its own pace (typing, page loads); the narration has its own.
// `sync` pins named moments of the clip to beats of the narration and the clip is played faster or slower between pins.
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Cue {
  name: string;
  t: number;
  /** How long the recording stayed on this moment, in seconds (the interface is static for that long). */
  hold?: number;
  box: Box | null;
}
export interface ClipMeta {
  clip: string;
  zoom: number;
  duration: number;
  cues: Cue[];
  errors: string[];
}

export const CLIP_W = 1920;
export const CLIP_H = 1080;

export function cueOf(meta: ClipMeta, name: string): Cue {
  const found = meta.cues.find((c) => c.name === name);
  if (!found) throw new Error(`clip ${meta.clip} has no cue "${name}" (has: ${meta.cues.map((c) => c.name).join(", ")})`);
  return found;
}

export interface Anchor {
  frame: number;
  clipT: number;
}
/**
 * The opening anchor of a scene: frame 0 is placed so that the clip plays at normal speed up to the first pin, but never before
 * the clip's own "start" mark (the page has loaded) and never later than the first pin.
 */
export function openingAnchor(startT: number, pins: Anchor[], fps: number): Anchor {
  const first = [...pins].sort((a, b) => a.frame - b.frame)[0];
  if (!first) return { frame: 0, clipT: startT };
  return { frame: 0, clipT: Math.min(first.clipT - 0.01, Math.max(startT, first.clipT - first.frame / fps)) };
}

export interface Segment {
  from: number; // scene frame
  to: number;
  clipStart: number; // seconds into the clip
  rate: number;
}

export const MIN_RATE = 0.45;
export const MAX_RATE = 3.0;

/** Builds playback segments from anchors (scene frame, clip time). The last segment runs at rate 1 to the end of the scene. */
export function segmentsFrom(anchors: Anchor[], sceneFrames: number, fps: number): Segment[] {
  const sorted = [...anchors].sort((a, b) => a.frame - b.frame);
  const clean: Anchor[] = [];
  for (const a of sorted) {
    const prev = clean[clean.length - 1];
    if (!prev || (a.frame > prev.frame && a.clipT > prev.clipT)) clean.push(a);
  }
  const segs: Segment[] = [];
  for (let i = 0; i < clean.length; i++) {
    const a = clean[i] as Anchor;
    const next = clean[i + 1];
    if (next) {
      const rate = Math.min(MAX_RATE, Math.max(MIN_RATE, (next.clipT - a.clipT) / ((next.frame - a.frame) / fps)));
      segs.push({ from: a.frame, to: next.frame, clipStart: a.clipT, rate });
    } else {
      segs.push({ from: a.frame, to: sceneFrames, clipStart: a.clipT, rate: 1 });
    }
  }
  return segs;
}

/** The scene frame at which clip time `t` is on screen. */
export function frameOfClipTime(segs: Segment[], t: number, fps: number): number {
  for (const s of segs) {
    const len = ((s.to - s.from) / fps) * s.rate;
    if (t >= s.clipStart && t <= s.clipStart + len + 1e-6) return Math.round(s.from + ((t - s.clipStart) / s.rate) * fps);
  }
  const first = segs[0];
  if (first && t < first.clipStart) return first.from;
  const last = segs[segs.length - 1];
  return last ? last.to : 0;
}

export interface CamKey {
  frame: number;
  scale: number;
  fx: number; // focus point in clip pixels
  fy: number;
}

/** Eases between camera keys. Before the first key the camera already sits on it, so a clip never opens on an unframed page. */
export function cameraAt(keys: CamKey[], frame: number, ease: (x: number) => number, rest: { scale: number; fx: number; fy: number } = { scale: 1, fx: CLIP_W / 2, fy: CLIP_H / 2 }): { scale: number; fx: number; fy: number } {
  const first = keys[0];
  if (!first) return rest;
  if (frame <= first.frame) return first;
  let prev: CamKey = first;
  let next: CamKey = first;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i] as CamKey;
    if (k.frame <= frame) {
      prev = k;
      next = keys[i + 1] ?? k;
    }
  }
  if (next === prev) return prev;
  const span = Math.max(1, next.frame - prev.frame);
  const u = ease(Math.min(1, Math.max(0, (frame - prev.frame) / Math.min(span, 36))));
  return { scale: prev.scale + (next.scale - prev.scale) * u, fx: prev.fx + (next.fx - prev.fx) * u, fy: prev.fy + (next.fy - prev.fy) * u };
}
