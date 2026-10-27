import { identifiersAgree } from "./enrich.ts";
import { HMEM } from "./index.ts";

/**
 * MA-2: what H-MEM changes about questions asked twice.
 *
 * The pre-registered question (docs/04-meterless-plan.md, section 4): across a multi-case session,
 * how many times is a reviewer asked about an ambiguity they already resolved, with and without
 * H-MEM? This module only measures. The synthetic session it runs on is built in the tests and is
 * labelled constructed there.
 *
 * Arms:
 *  - `no-memory`: nothing is retained, so every question is asked. The repeat count is the number of
 *    repeatable questions, by construction.
 *  - `scoped-memory`: each reviewer answer is stored as a record of that organization and the case
 *    asks memory before it asks the reviewer. Real retrieval decides, so a paraphrase that shares
 *    little vocabulary with the stored question is missed, and that miss is measured.
 *  - `scoped-memory-id-guard`: as `scoped-memory`, but a retrieved record answers the question only if
 *    both name the same registry identifiers. Word overlap between "is X the same product as
 *    submission Y" questions about different products is high, so the score alone cannot separate
 *    them; this guard is the rule the pipeline applies to identity links.
 *  - `unscoped-memory` (control): the same, but records carry no organization. It shows what the
 *    organization scoping prevents; it is not a configuration the product uses.
 *
 * A question is answered from memory when the top retrieved record scores at or above the retrieval
 * threshold (the engine's default, 0.35) and is a reviewer-confirmed link. The system cannot know
 * whether that record answers the same question, so the measure also counts reuse of a record that
 * answered a different one.
 */

export interface AmbiguityQuestion {
  organizationId: string;
  caseId: string;
  /** Ground truth identity of the underlying ambiguity; two questions with the same key have the same answer. */
  key: string;
  /** How this case words the question. */
  text: string;
  /** What the reviewer says when asked. */
  answer: string;
}

export interface Ma2Arm {
  arm: "no-memory" | "scoped-memory" | "scoped-memory-id-guard" | "unscoped-memory";
  questions: number;
  /** Questions whose underlying ambiguity was already resolved earlier in the same organization. */
  repeatable: number;
  /** Times the reviewer was asked. */
  asked: number;
  /** Times the reviewer was asked something they had already answered for that organization. */
  repeatQuestions: number;
  answeredFromMemory: number;
  /** Answered from memory with the record that answered the same ambiguity. */
  correctReuse: number;
  /** Answered from memory with a record that answered a different ambiguity. */
  falseReuse: number;
  /** Answered from memory with another organization's record. */
  crossOrganizationLeaks: number;
}

export interface Ma2Report {
  arms: Ma2Arm[];
  /** Per-question outcome in the scoped arm, for reading what was missed. */
  scopedTrace: Ma2Trace[];
  guardedTrace: Ma2Trace[];
}

export interface Ma2Trace {
  index: number;
  key: string;
  outcome: "asked" | "memory-correct" | "memory-wrong";
  score?: number;
}

type Mode = Ma2Arm["arm"];

function runArm(mode: Mode, questions: AmbiguityQuestion[], make: () => HMEM): { arm: Ma2Arm; trace: Ma2Trace[] } {
  const hmem = make();
  const answeredBefore = new Set<string>();
  const arm: Ma2Arm = { arm: mode, questions: questions.length, repeatable: 0, asked: 0, repeatQuestions: 0, answeredFromMemory: 0, correctReuse: 0, falseReuse: 0, crossOrganizationLeaks: 0 };
  const trace: Ma2Trace[] = [];
  const keyOfRecord = new Map<string, { key: string; org: string }>();
  try {
    questions.forEach((q, index) => {
      const repeatable = answeredBefore.has(`${q.organizationId}|${q.key}`);
      if (repeatable) arm.repeatable++;
      let reused: "none" | "correct" | "wrong" = "none";
      let score: number | undefined;
      if (mode !== "no-memory") {
        const scoped = mode === "scoped-memory" || mode === "scoped-memory-id-guard";
        const result = hmem.query(q.text, scoped ? { organizationId: q.organizationId } : {});
        // The guard looks at the top candidate only: if it names other identifiers the question is asked, not re-ranked.
        const leader = result.memories.find((m) => m.memory.kind === "reviewer_confirmed_link");
        const top = leader && (mode !== "scoped-memory-id-guard" || identifiersAgree(q.text, leader.memory.content)) ? leader : undefined;
        if (top) {
          score = top.relevance;
          const origin = keyOfRecord.get(top.memory.id)!;
          arm.answeredFromMemory++;
          if (origin.org !== q.organizationId) arm.crossOrganizationLeaks++;
          if (origin.key === q.key && origin.org === q.organizationId) {
            arm.correctReuse++;
            reused = "correct";
          } else {
            arm.falseReuse++;
            reused = "wrong";
          }
        }
      }
      if (reused === "none") {
        arm.asked++;
        if (repeatable) arm.repeatQuestions++;
        if (mode !== "no-memory") {
          const rec = hmem.add({
            content: `${q.text} Reviewer answer: ${q.answer}`,
            source: `reviewer:${q.caseId}`,
            sourceTier: "reviewer",
            kind: "reviewer_confirmed_link",
            layer: "long_term",
            ...(mode === "scoped-memory" || mode === "scoped-memory-id-guard" ? { organizationId: q.organizationId } : {}),
          });
          keyOfRecord.set(rec.id, { key: q.key, org: q.organizationId });
        }
      }
      answeredBefore.add(`${q.organizationId}|${q.key}`);
      if (mode === "scoped-memory" || mode === "scoped-memory-id-guard") trace.push({ index, key: q.key, outcome: reused === "none" ? "asked" : reused === "correct" ? "memory-correct" : "memory-wrong", ...(score !== undefined ? { score: Number(score.toFixed(3)) } : {}) });
    });
  } finally {
    hmem.close();
  }
  return { arm, trace };
}

export function measureRepeatQuestions(questions: AmbiguityQuestion[], make: () => HMEM): Ma2Report {
  const none = runArm("no-memory", questions, make);
  const scoped = runArm("scoped-memory", questions, make);
  const guarded = runArm("scoped-memory-id-guard", questions, make);
  const unscoped = runArm("unscoped-memory", questions, make);
  return { arms: [none.arm, scoped.arm, guarded.arm, unscoped.arm], scopedTrace: scoped.trace, guardedTrace: guarded.trace };
}
