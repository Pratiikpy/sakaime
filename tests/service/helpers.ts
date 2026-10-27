import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PortError, type ModelPort, type ModelRequest, type ModelResponse } from "../../src/ports/index.ts";
import { SakaimeService, type ServiceOverrides } from "../../src/service/service.ts";

/** Sample mode needs no key and reads nothing from .env. */
export const SAMPLE_ENV = { SAMPLE_MODE: "true", SAKAIME_NO_ENV: "1" } as const;

export async function sampleService(service?: ServiceOverrides, extra: { env?: Record<string, string | undefined>; limits?: Record<string, number> } = {}): Promise<SakaimeService> {
  return SakaimeService.create({
    sample: true,
    env: { ...SAMPLE_ENV, ...(extra.env ?? {}) },
    dirs: { state: mkdtempSync(join(tmpdir(), "sakaime-test-")) },
    ...(extra.limits ? { limits: extra.limits } : {}),
    ...(service ? { service } : {}),
  });
}

/**
 * The labels the pipeline produces on the recorded public records, derived by running it (data/sample/run/labels.json holds the
 * same). The headline is the hospital reviewer's own question; the rest are the vendor claim sentences, which are constructed.
 */
export const EXPECTED_LABELS: Record<string, Record<string, string>> = {
  "eyeart-k200667": {
    // The readers now carry the authorization's condition and exclusion. The claims that name diabetic retinopathy as the population meet the
    // exclusion of patients previously diagnosed with more than mild diabetic retinopathy, and the compiler cannot place those two wordings
    // (SAK-UNPLACED-CONDITION), so a reviewer must; before, the exclusion was not read and these were narrower scopes. The headline question
    // (use from 2027) also meets the service's staleness window (R20).
    "CASE-2026-014.intended": "REQUIRES_DOMAIN_REVIEW",
    "CLM-EA-01": "REQUIRES_DOMAIN_REVIEW",
    "CLM-EA-02": "REQUIRES_DOMAIN_REVIEW",
    "CLM-EA-03": "INSUFFICIENT_EVIDENCE",
    "CLM-EA-04": "INSUFFICIENT_EVIDENCE",
    "CLM-EA-05": "REQUIRES_DOMAIN_REVIEW",
    "CLM-EA-06": "REQUIRES_DOMAIN_REVIEW",
  },
  "lunit-k211733": {
    "CASE-2026-016.intended": "INSUFFICIENT_EVIDENCE",
    "CLM-LU-01": "INSUFFICIENT_EVIDENCE",
    "CLM-LU-02": "INSUFFICIENT_EVIDENCE",
  },
  "transpara-k221347": {
    "CASE-2026-019.intended": "INSUFFICIENT_EVIDENCE",
    "CLM-TR-01": "INSUFFICIENT_EVIDENCE",
  },
};

export const CASE_IDS = Object.keys(EXPECTED_LABELS);

export type Script = (request: ModelRequest) => unknown | Error;

/**
 * A scripted model, a TEST DOUBLE and nothing else: it answers each role with whatever the script returns and records what it
 * was asked. It is never used in sample or live mode, only to exercise the code that checks a model's answer.
 */
export class ScriptedModel implements ModelPort {
  readonly asked: ModelRequest[] = [];
  constructor(private readonly script: Script) {}
  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.asked.push(request);
    const out = this.script(request);
    if (out instanceof Error) throw out instanceof PortError ? out : new PortError("UNAVAILABLE", out.message);
    return {
      text: JSON.stringify(out),
      json: out,
      requestedModel: "test/scripted",
      routedModel: "test/scripted",
      provider: "nvidia",
      usage: { measured: false },
      recorded: false,
    };
  }
}
