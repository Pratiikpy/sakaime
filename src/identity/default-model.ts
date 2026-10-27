/**
 * The scorer trained on the whole labelled corpus (data/identity-corpus), written by run-eval.ts. It is the
 * default for callers that do not train their own. Its hash is checked against a fresh training run in
 * tests/identity/model.test.ts, so a stale file is caught.
 */
import raw from "./model.default.json" with { type: "json" };
import type { ScorerModel } from "./scorer.ts";

export const DEFAULT_MODEL: ScorerModel = raw as unknown as ScorerModel;
