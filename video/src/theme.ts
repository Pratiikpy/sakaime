import { Easing } from "remotion";

// The brand kit of the product (ui/src/styles/tokens.css, D-022): ink on white, one green, rust for failure.
export const C = {
  paper: "#ffffff",
  paper2: "#f4f5f2",
  paper3: "#eaece7",
  ink: "#0e1116",
  ink2: "#384150",
  ink3: "#566070",
  line: "#d6d9d3",
  lineStrong: "#8a918a",
  green: "#0a6b3a",
  greenSoft: "#e6f4ec",
  greenLine: "#9cd0b3",
  rust: "#a8321a",
  rustSoft: "#fbebe6",
  rustLine: "#e2a898",
} as const;

export const FONT = {
  display: '"Outfit", system-ui, sans-serif',
  mono: '"JetBrains Mono", ui-monospace, Consolas, monospace',
} as const;

export const W = 1920;
export const H = 1080;
export const MARGIN = 120;

/** One easing for almost everything: fast out of the gate, long settle. Purposeful, never bouncy. */
export const ease = Easing.bezier(0.22, 0.61, 0.21, 1);
export const easeInOut = Easing.bezier(0.65, 0, 0.35, 1);

/** Relation and label colours, always paired with words in the scenes (never colour alone). */
export const RELATION: Record<string, { word: string; fg: string; bg: string; line: string }> = {
  CONTAINED: { word: "Contained", fg: C.green, bg: C.greenSoft, line: C.greenLine },
  PARTIAL: { word: "Partial", fg: C.green, bg: C.paper, line: C.green },
  DISJOINT: { word: "Disjoint", fg: C.rust, bg: C.rustSoft, line: C.rustLine },
  UNKNOWN: { word: "Unknown", fg: C.ink, bg: C.paper2, line: C.lineStrong },
};

export const LABEL_WORDS: Record<string, string> = {
  SUPPORTED_FOR_SCOPE: "Supported for this use",
  SUPPORTED_ONLY_FOR_NARROWER_SCOPE: "Supported only for a narrower use",
  CONTRADICTED_BY_SPECIFIED_EVIDENCE: "Contradicted by the evidence",
  INSUFFICIENT_EVIDENCE: "Not enough evidence",
  REQUIRES_DOMAIN_REVIEW: "Needs domain review",
};
