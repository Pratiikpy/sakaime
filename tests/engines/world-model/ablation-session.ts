import type { Ma1Session, SessionChange, SessionFact, SessionFinding } from "../../../src/engines/world-model/ablation.ts";

/**
 * CONSTRUCTED session for MA-1. Twelve fictional devices, three findings each, and eleven source
 * changes of the kinds a review meets: a registry update, a retracted study, a late-arriving older
 * observation, a second source restating a value, a change nobody used. Nothing here is real data;
 * the point is the mix of changes that should and should not disturb a finding.
 */
export function buildMa1Session(): Ma1Session {
  const devices = Array.from({ length: 12 }, (_, i) => `device:ma1:D${String(i + 1).padStart(2, "0")}`);
  const entities = devices.map((id) => ({ id: id.replace("device:ma1:", ""), type: "device" }));
  const facts: SessionFact[] = [];
  const findings: SessionFinding[] = [];
  const fact = (device: string, predicate: string, value: unknown, at: string, kind: string): SessionFact => ({ key: `${device}.${predicate}@${at}.${kind}`, about: device, predicate, value, at, kind });

  for (const [i, device] of devices.entries()) {
    const version = fact(device, "software-version", `1.${i}`, "2026-01-10T00:00:00.000Z", "registry");
    const population = fact(device, "population", "adults 18 and over", "2026-01-10T00:00:00.000Z", "fda-summary");
    const setting = fact(device, "setting", "emergency department", "2026-01-10T00:00:00.000Z", "fda-summary");
    facts.push(version, population, setting);
    const tag = device.replace("device:ma1:", "");
    findings.push(
      { id: `${tag}:version`, uses: [version.key] },
      { id: `${tag}:population`, uses: [population.key] },
      { id: `${tag}:scope`, uses: [version.key, population.key, setting.key] },
    );
  }
  // An unused fact to be retracted, and one to be superseded, belong to devices 6 and 8.
  const studyN6 = fact(devices[5]!, "study-n", 400, "2026-01-12T00:00:00.000Z", "paper");
  const studyN8 = fact(devices[7]!, "study-n", 250, "2026-01-12T00:00:00.000Z", "paper");
  facts.push(studyN6, studyN8);

  const D = (n: number) => devices[n - 1]!;
  const changes: SessionChange[] = [
    // Should disturb: a newer software version in the registry (devices 1 and 2).
    { op: "assert", fact: fact(D(1), "software-version", "2.0", "2026-03-01T00:00:00.000Z", "registry") },
    { op: "assert", fact: fact(D(2), "software-version", "2.1", "2026-03-05T00:00:00.000Z", "registry") },
    // Should disturb: the population fact of device 3 is withdrawn.
    { op: "retract", factKey: facts.find((f) => f.about === D(3) && f.predicate === "population")!.key, at: "2026-03-10T00:00:00.000Z" },
    // Should not disturb: an older observation arrives late and loses to what is already there.
    { op: "assert", fact: fact(D(4), "software-version", "0.9", "2025-11-01T00:00:00.000Z", "registry") },
    // Disturbs the engine, not the value: a second source restates the same version later.
    { op: "assert", fact: fact(D(5), "software-version", "1.4", "2026-03-12T00:00:00.000Z", "vendor") },
    // Should not disturb: a new predicate nobody used, and a retracted fact nobody used.
    { op: "assert", fact: fact(D(6), "reader-count", 5, "2026-03-15T00:00:00.000Z", "paper") },
    { op: "retract", factKey: studyN8.key, at: "2026-03-16T00:00:00.000Z" },
    // Should disturb: the setting of device 7 changes, which only the combined scope finding used.
    { op: "assert", fact: fact(D(7), "setting", "outpatient clinic", "2026-03-18T00:00:00.000Z", "fda-summary") },
    // Should not disturb: facts about devices no finding of ours is about, and a change to a study-n nobody used.
    { op: "assert", fact: fact(D(9), "study-n", 90, "2026-03-20T00:00:00.000Z", "paper") },
    { op: "assert", fact: fact(D(6), "study-n", 410, "2026-03-21T00:00:00.000Z", "paper") },
    { op: "assert", fact: fact(D(10), "intended-use", "triage", "2026-03-22T00:00:00.000Z", "fda-summary") },
  ];
  return { entities, facts, findings, changes };
}
