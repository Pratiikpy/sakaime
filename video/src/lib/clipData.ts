import cuesJson from "../generated/cues.json";
import type { ClipMeta } from "./footage";

/** Cue marks of every recorded clip, written by scripts/build-data.mjs from footage/clips/*.cues.json. */
export const clips = cuesJson as unknown as Record<string, ClipMeta>;
