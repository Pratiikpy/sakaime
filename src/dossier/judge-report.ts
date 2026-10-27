/**
 * Plain-text rendering of a verification result, for `npm run judge` and for logs.
 * Output is deterministic: no timestamps, no paths, fixed ordering, so a transcript can be compared byte for byte.
 */
import type { Check, VerifyResult } from "./verify.ts";

const rule = (n = 78): string => "-".repeat(n);

function statusMark(s: Check["status"]): string {
  return s === "PASS" ? "PASS   " : s === "FAIL" ? "FAIL   " : "SKIPPED";
}

/** Every check and every failure. */
export function renderVerifyResult(result: VerifyResult): string {
  const lines: string[] = [];
  const failed = result.checks.filter((c) => c.status === "FAIL").length;
  const skipped = result.checks.filter((c) => c.status === "SKIPPED").length;
  lines.push(`Dossier verification (${result.mode}): ${result.ok ? "PASS" : "FAIL"}`);
  if (result.dossierId) lines.push(`Dossier: ${result.dossierId}`);
  if (result.signer) lines.push(`Signer: ${result.signer.keyStatus} key ${result.signer.keyId.slice(0, 16)}; ${result.signer.trust}`);
  lines.push(`Checks: ${result.checks.length - failed - skipped} passed, ${failed} failed, ${skipped} not run`, rule());
  for (const c of result.checks) lines.push(`${statusMark(c.status)} ${c.id.padEnd(28)} ${c.detail}`);
  if (result.failures.length > 0) {
    lines.push(rule(), "Failures");
    for (const f of result.failures) lines.push(`  ${f.item}`, `    ${f.reason}`);
  }
  lines.push(rule(), "A signature shows the bundle is unchanged since signing. It does not show that any finding is clinically correct.");
  return lines.join("\n");
}

interface ClaimView {
  id: string;
  recorded: string;
  findingId?: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** The claim list and each claim's current recorded label, read defensively from a bundle that may be damaged. */
function claimViews(bundle: unknown): ClaimView[] {
  const body = isObj(bundle) && isObj(bundle.body) ? bundle.body : {};
  const claims = Array.isArray(body.claims) ? body.claims : [];
  const findings = (Array.isArray(body.findings) ? body.findings : []).filter(isObj);
  const superseded = new Set(findings.map((f) => f.supersedes).filter((x): x is string => typeof x === "string"));
  return claims.filter(isObj).flatMap((c) => {
    if (typeof c.id !== "string") return [];
    const current = findings.filter((f) => f.claimId === c.id && typeof f.id === "string" && !superseded.has(f.id as string));
    const last = current[current.length - 1];
    return [
      {
        id: c.id,
        recorded: last && typeof last.label === "string" ? last.label : "no finding recorded",
        ...(last && typeof last.id === "string" ? { findingId: last.id } : {}),
      },
    ];
  });
}

/**
 * PASS or FAIL per claim, then the dossier-level picture. A claim fails when any failure is attributed to it or to the
 * whole dossier. PASS means the recorded finding for that claim re-verifies from the stored inputs; it is not a judgement
 * that the claim is true, and the label shown is the recorded one.
 */
export function renderJudgeReport(bundle: unknown, result: VerifyResult): string {
  const views = claimViews(bundle);
  const wide = result.failures.filter((f) => f.claimIds.length === 0);
  const lines: string[] = [];
  lines.push("Sakaime dossier check", rule());
  lines.push(`Dossier  ${result.dossierId ?? "(unreadable)"}`);
  lines.push(`Signer   ${result.signer ? `${result.signer.keyStatus} key ${result.signer.keyId.slice(0, 16)}: ${result.signer.trust}` : "not established"}`);
  lines.push(`Mode     ${result.mode === "full" ? "full: hashes, signature, quotes, numbers, compiler re-run" : "integrity only: hashes, signature and schema; the compiler was not re-run"}`);
  lines.push(`Result   ${result.ok ? "PASS" : "FAIL"}`, "", "Claims");

  let passed = 0;
  if (views.length === 0) lines.push("  (no readable claims in this bundle)");
  for (const v of views) {
    const own = result.failures.filter((f) => f.claimIds.includes(v.id));
    const ok = own.length === 0 && wide.length === 0;
    if (ok) passed += 1;
    lines.push(`  ${ok ? "PASS" : "FAIL"}  ${v.id}   recorded: ${v.recorded}${v.findingId ? ` (${v.findingId})` : ""}`);
    for (const f of own) lines.push(`        ${f.item}: ${f.reason}`);
    if (!ok && own.length === 0) lines.push("        the dossier as a whole failed verification; see below");
  }
  lines.push(`  ${passed} of ${views.length} claims pass`);

  if (wide.length > 0) {
    lines.push("", "Dossier-level problems");
    for (const f of wide) lines.push(`  ${f.item}: ${f.reason}`);
  }
  const unattributed = result.failures.filter((f) => f.claimIds.length > 0 && !views.some((v) => f.claimIds.includes(v.id)));
  for (const f of unattributed) lines.push(`  ${f.item}: ${f.reason}`);

  if (result.skipped.length > 0) {
    lines.push("", "Not run");
    for (const s of result.skipped) lines.push(`  ${s}`);
  }
  lines.push(
    "",
    "PASS means the recorded finding for that claim can be reproduced from the stored inputs and nothing in the bundle changed.",
    "It is not a judgement that the claim is true. A signature shows integrity, never clinical truth.",
  );
  return lines.join("\n");
}
