/**
 * Marker protocol. The canonical markers are [STATE_CHECKPOINT] (everything after it is the next carryover)
 * and [TASK_COMPLETE]. The legacy forms are accepted when reading and never emitted. Cleaning removes every
 * form from text meant for display, so a marker can never leak into a dossier.
 */

export interface ParsedMarkers {
  /** Text after a state marker, or inside a <CARRYOVER> block. */
  state?: string;
  done: boolean;
  progress?: string;
  needsTool?: { tool: string; input: string };
  needsClarification?: string;
  /** Display-safe text with every marker form removed. */
  cleaned: string;
}

const STATE_BLOCK = /<CARRYOVER>([\s\S]*?)<\/CARRYOVER>/g;
const STATE_TAILS: RegExp[] = [
  /\[STATE_CHECKPOINT\]\s*([\s\S]*)$/,
  /@@@STATE@@@\s*([\s\S]*)$/,
  /(?<![A-Z_])\[STATE\]\s*([\s\S]*)$/,
  /---STATE---\s*([\s\S]*)$/,
];
const FINAL_MARKERS: RegExp[] = [/\[TASK_COMPLETE\]/, /@@@FINAL@@@/, /(?<![A-Z_])\[FINAL\]/, /---FINAL---/, /<DONE\s*\/?>/];
const PROGRESS_BLOCK = /<PROGRESS>([\s\S]*?)<\/PROGRESS>/;
const NEEDS_TOOL = /[<[]NEEDS_TOOL\s+tool="([^"]+)"\s+input=(?:"([^"]*)"|'([^']*)')\s*\/?[\]>]/;
const NEEDS_CLARIFICATION = /[<[]NEEDS_CLARIFICATION[\]>]\s*([^\n]*)/;

export function parseMarkers(raw: string): ParsedMarkers {
  let state: string | undefined;
  const blocks = [...raw.matchAll(STATE_BLOCK)];
  const lastBlock = blocks[blocks.length - 1];
  if (lastBlock?.[1] !== undefined) state = lastBlock[1].trim();
  if (state === undefined) {
    for (const re of STATE_TAILS) {
      const m = raw.match(re);
      if (m?.[1] !== undefined) {
        state = m[1].trim();
        break;
      }
    }
  }
  if (state !== undefined) state = stripMarkerTokens(state);

  const tool = raw.match(NEEDS_TOOL);
  const clar = raw.match(NEEDS_CLARIFICATION);
  const prog = raw.match(PROGRESS_BLOCK);
  return {
    state,
    done: FINAL_MARKERS.some((re) => re.test(raw)),
    progress: prog?.[1]?.trim(),
    needsTool: tool?.[1] !== undefined ? { tool: tool[1], input: tool[2] ?? tool[3] ?? "" } : undefined,
    needsClarification: clar?.[1]?.trim(),
    cleaned: cleanMarkers(raw),
  };
}

/** Remove completion and checkpoint tokens from a captured state, so the state never carries a control token. */
function stripMarkerTokens(text: string): string {
  return text
    .replace(/\[TASK_COMPLETE\]|@@@FINAL@@@|---FINAL---|<DONE\s*\/?>|\[STATE_CHECKPOINT\]|@@@STATE@@@|---STATE---/g, "")
    .replace(/(?<![A-Z_])\[(?:STATE|FINAL)\]/g, "")
    .trim();
}

export function cleanMarkers(raw: string): string {
  let out = raw;
  out = out.replace(STATE_BLOCK, "");
  out = out.replace(/<PROGRESS>[\s\S]*?<\/PROGRESS>/g, "");
  out = out.replace(/[<[]NEEDS_TOOL[^\]>]*[\]>]/g, "");
  out = out.replace(/[<[]NEEDS_CLARIFICATION[\]>][^\n]*/g, "");
  out = out.replace(/\[STATE_CHECKPOINT\][\s\S]*$/, "");
  out = out.replace(/@@@STATE@@@[\s\S]*$/, "");
  out = out.replace(/---STATE---[\s\S]*$/, "");
  // A bare [STATE] only starts a marker when it begins a line; elsewhere it is prose.
  out = out.replace(/\n\[STATE\][\s\S]*$/, "");
  for (const re of [/\[TASK_COMPLETE\]/g, /@@@FINAL@@@/g, /---FINAL---/g, /<DONE\s*\/?>/g]) out = out.replace(re, "");
  out = out.replace(/\n\[FINAL\][\s\S]*$/, "");
  return out.replace(/[ \t]+$/gm, "").replace(/\n{3,}/g, "\n\n").trim();
}
