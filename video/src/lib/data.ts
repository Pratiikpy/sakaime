// Typed access to everything generated from files: figures, the beat timeline, the product's own JSON snapshots.
import figuresJson from "../generated/figures.json";
import timelineJson from "../generated/timeline.json";
import { LOCAL_COUNTS } from "../content";
import { expand, type Figures } from "./fmt";
import eyeart from "../../data/snapshots/case-eyeart.json";
import transpara from "../../data/snapshots/case-transpara.json";
import health from "../../data/snapshots/health.json";
import usl from "../../data/snapshots/usl.json";
import sources from "../../data/snapshots/sources.json";

export const figures = figuresJson as unknown as Figures;
export const $ = (template: string): string => expand(template, figures, LOCAL_COUNTS);

export function fig(key: string) {
  const f = figures[key];
  if (!f) throw new Error(`no figure ${key}`);
  return f;
}
export function kn(key: string): { k: number; n: number } {
  const f = fig(key);
  if (f.kind !== "kn") throw new Error(`${key} is not k/n`);
  return { k: f.k, n: f.n };
}
export function mean(key: string): number {
  const f = fig(key);
  if (f.kind !== "meanWorst") throw new Error(`${key} is not mean/worst`);
  return f.mean;
}
export function runs(key: string): number {
  const f = fig(key);
  if (f.kind !== "meanWorst") throw new Error(`${key} is not mean/worst`);
  return f.runs;
}
export function num(key: string): number {
  const f = fig(key);
  if (f.kind !== "value" || typeof f.value !== "number") throw new Error(`${key} is not a number`);
  return f.value;
}

export interface BeatTime {
  file: string;
  text: string;
  start: number;
  dur: number;
  startFrame: number;
  frames: number;
}
export interface SceneTime {
  id: string;
  start: number;
  frames: number;
  beats: BeatTime[];
}
export const timeline = timelineJson as unknown as { fps: number; totalFrames: number; totalSeconds: number; scenes: SceneTime[] };

// ---- the product's own data, as the running service served it in sample mode
type Json = any; // eslint-disable-line @typescript-eslint/no-explicit-any
export const caseEyeart = eyeart as Json;
export const caseTranspara = transpara as Json;
export const mode = (health as Json).mode as { sample: boolean; federation: string; model: string; sources: string };
export const uslSnapshot = usl as Json;
export const sourceRows = sources as Json[];
