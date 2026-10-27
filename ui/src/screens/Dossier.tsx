import { useEffect, useMemo, useState } from "react";
import { useParams } from "react-router-dom";
import { z } from "zod";
import { api, ApiError } from "../api/client";
import type { VerifyResponse } from "../api/types";
import { ProvenanceBadge } from "../components/badges";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { ErrorState, Notice, useAnnounce } from "../components/feedback";
import { Icon } from "../components/Icon";
import { CopyButton, Section, useDocTitle } from "../components/ui";
import { formatDateTime, plural, shortHash } from "../lib/format";

type Json = Record<string, unknown>;

/** Only what the screen shows is read from the bundle; the verifier on the service reads the rest. */
const SummarySchema = z.object({
  formatVersion: z.string().optional(),
  manifest: z
    .object({
      dossierId: z.string(),
      createdAt: z.string().optional(),
      root: z.string().optional(),
      signing: z.object({ keyId: z.string(), keyStatus: z.enum(["demo", "pinned"]), statement: z.string().optional() }).optional(),
    })
    .passthrough(),
  body: z.record(z.string(), z.unknown()),
});

interface Replaced {
  id: string;
  supersedes: string;
  claimId?: string;
  reason?: string;
}

/**
 * Findings in the bundle that replace an earlier one: a reviewer's decision names the earlier finding, so it is kept and listed with
 * the reason it was replaced. Read from body.findings; a bundle without any such finding yields an empty list.
 */
function replacedFindings(bundle: Json | null): Replaced[] {
  const list = (bundle?.["body"] as Json | undefined)?.["findings"];
  if (!Array.isArray(list)) return [];
  const out: Replaced[] = [];
  for (const f of list) {
    const x = f as Json;
    if (typeof x["id"] === "string" && typeof x["supersedes"] === "string") {
      out.push({ id: x["id"], supersedes: x["supersedes"], ...(typeof x["claimId"] === "string" ? { claimId: x["claimId"] } : {}), ...(typeof x["supersedesReason"] === "string" ? { reason: x["supersedesReason"] } : {}) });
    }
  }
  return out;
}

interface Tamper {
  path: string;
  index: number;
  from: string;
  to: string;
}

/** Flips one character of the first anchor's quoted text in a deep copy. The original is never touched. */
function tamperCopy(original: Json): { copy: Json; change: Tamper } | null {
  const copy = JSON.parse(JSON.stringify(original)) as Json;
  const body = copy["body"] as Json | undefined;
  const lists = ["anchors", "snapshots", "claims"];
  for (const name of lists) {
    const list = body?.[name];
    if (!Array.isArray(list)) continue;
    for (let i = 0; i < list.length; i++) {
      const item = list[i] as Json;
      const field = "text";
      const s = item[field];
      if (typeof s !== "string" || s.length < 8) continue;
      // Prefer a digit, because a changed number is the failure that matters most; otherwise a letter.
      let at = s.search(/\d/);
      if (at < 0) at = s.search(/[a-z]/i);
      if (at < 0) continue;
      const ch = s.charAt(at);
      const swap = /\d/.test(ch) ? String((Number(ch) + 1) % 10) : ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase();
      item[field] = s.slice(0, at) + swap + s.slice(at + 1);
      return { copy, change: { path: `body.${name}[${i}].${field}`, index: at, from: ch, to: swap } };
    }
  }
  return null;
}

function VerifyResult({ r, title }: { r: VerifyResponse; title: string }) {
  const failed = r.checks.filter((c) => !c.ok);
  return (
    <div className={`verify verify-${r.ok ? "ok" : "bad"}`} data-testid="verify-result" data-ok={r.ok}>
      <div className="verify__head">
        <Icon name={r.ok ? "check" : "cross"} size={22} />
        <div>
          <h3 className="verify__title">{title}</h3>
          <p className="verify__line" data-testid="verify-line">
            {r.ok ? `All ${plural(r.checks.length, "check")} passed.` : `${plural(failed.length, "check")} failed out of ${r.checks.length}.`}
          </p>
        </div>
        <ProvenanceBadge kind={r.keyKind} />
      </div>
      {r.failures.length > 0 && (
        <div className="verify__failures">
          <h4 className="subhead">What failed</h4>
          <ul className="plain-list" data-testid="verify-failures">
            {r.failures.map((f, i) => (
              <li key={i}>
                <code className="mono">{f.item}</code>
                <span>{f.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="verify__checks">
        <summary>All checks ({r.checks.length})</summary>
        <ul className="check-list" data-testid="verify-checks">
          {r.checks.map((c, i) => (
            <li key={`${c.name}-${i}`} className={c.ok ? "is-pass" : "is-fail"} data-ok={c.ok}>
              <Icon name={c.ok ? "check" : "cross"} size={15} />
              <span>
                <strong>{c.name}</strong>
                {c.detail ? <span className="muted"> {c.detail}</span> : null}
              </span>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Body({ caseId }: { caseId: string }) {
  const [dossier, setDossier] = useState<Json | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [verified, setVerified] = useState<VerifyResponse | null>(null);
  const [tampered, setTampered] = useState<{ change: Tamper; result: VerifyResponse } | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  const [retry, setRetry] = useState<(() => void) | null>(null);
  const announce = useAnnounce();
  const replaced = useMemo(() => replacedFindings(dossier), [dossier]);

  const summary = useMemo(() => {
    if (!dossier) return null;
    const p = SummarySchema.safeParse(dossier);
    return p.success ? p.data : null;
  }, [dossier]);

  useEffect(() => {
    if (!text) return;
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    setDownloadUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [text]);

  const wrap = async (what: string, fn: () => Promise<void>) => {
    setBusy(what);
    setError(null);
    setRetry(null);
    try {
      await fn();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError("UNAVAILABLE", "The request failed.", 0);
      setError(err);
      setRetry(() => () => void wrap(what, fn));
      announce(`${what} failed. ${err.message}`);
    } finally {
      setBusy(null);
    }
  };

  const exportIt = () =>
    wrap("Export", async () => {
      const d = await api.dossier(caseId);
      setDossier(d);
      setText(JSON.stringify(d, null, 2));
      setVerified(null);
      setTampered(null);
      announce("Dossier exported");
    });

  const verify = () =>
    wrap("Verification", async () => {
      if (!dossier) return;
      const r = await api.verify(dossier);
      setVerified(r);
      announce(r.ok ? "Verification passed" : `Verification failed. ${r.failures[0]?.item ?? ""}`);
    });

  const tamper = () =>
    wrap("Tamper test", async () => {
      if (!dossier) return;
      const t = tamperCopy(dossier);
      if (!t) throw new ApiError("INVALID", "This dossier has no quoted text to alter.", 0);
      const result = await api.verify(t.copy);
      setTampered({ change: t.change, result });
      announce(result.ok ? "The altered copy passed. That should not happen." : `The altered copy failed verification at ${result.failures[0]?.item ?? "an item"}`);
    });

  return (
    <CaseGate id={caseId} screen="Decide">
      {(c) => (
        <>
          <CaseHeader
            c={c}
            screen="Decide: dossier"
            lead="A dossier is the whole case in one file: the sources, the quotes, the rule versions, the queries, the model replies and every decision. Anyone can run the verifier on it. It tells you whether the file is intact, not whether a finding is clinically right."
          />

          <Section id="export" title="1. Export">
            <div className="step">
              <button type="button" className="btn btn-primary" onClick={exportIt} disabled={busy !== null} data-testid="export-dossier">
                <Icon name="file" size={15} /> {busy === "Export" ? "Exporting…" : dossier ? "Export again" : "Export the dossier"}
              </button>
              {summary && (
                <dl className="meta-grid" data-testid="dossier-summary">
                  <div>
                    <dt>Dossier id</dt>
                    <dd className="with-copy">
                      <code className="mono">{shortHash(summary.manifest.dossierId, 18)}</code>
                      <CopyButton text={summary.manifest.dossierId} what="dossier id" />
                    </dd>
                  </div>
                  <div>
                    <dt>Created</dt>
                    <dd>{formatDateTime(summary.manifest.createdAt)}</dd>
                  </div>
                  <div>
                    <dt>Manifest root</dt>
                    <dd>
                      <code className="mono" title={summary.manifest.root}>{shortHash(summary.manifest.root, 14)}</code>
                    </dd>
                  </div>
                  <div>
                    <dt>Signed with</dt>
                    <dd>{summary.manifest.signing ? <ProvenanceBadge kind={summary.manifest.signing.keyStatus} /> : "Not stated"}</dd>
                  </div>
                  <div>
                    <dt>Size</dt>
                    <dd>{(new Blob([text]).size / 1024).toFixed(0)} KB</dd>
                  </div>
                </dl>
              )}
              {downloadUrl && summary && (
                <a className="btn btn-secondary" href={downloadUrl} download={`sakaime-dossier-${shortHash(summary.manifest.dossierId, 12).replace("…", "")}.json`} data-testid="download-dossier">
                  Download the file (JSON)
                </a>
              )}
              {replaced.length > 0 && (
                <Notice tone="info" title={`${replaced.length === 1 ? "A finding was" : `${replaced.length} findings were`} replaced after a decision`}>
                  <ul className="plain-list" data-testid="replaced-findings">
                    {replaced.map((r) => (
                      <li key={r.id}>
                        <code className="mono">{shortHash(r.supersedes, 14)}</code> was replaced by <code className="mono">{shortHash(r.id, 14)}</code>
                        {r.claimId ? ` (claim ${r.claimId})` : ""}. Both are in the file, and the decision log still points at the earlier one. {r.reason}
                      </li>
                    ))}
                  </ul>
                </Notice>
              )}
              {summary?.manifest.signing?.statement && (
                <Notice tone="info" title="What the signature means">
                  <span data-testid="signature-note-export">{summary.manifest.signing.statement}</span>
                </Notice>
              )}
            </div>
          </Section>

          <Section id="verify" title="2. Verify">
            <div className="step">
              <button type="button" className="btn btn-primary" onClick={verify} disabled={!dossier || busy !== null} data-testid="verify-dossier">
                <Icon name="shield" size={15} /> {busy === "Verification" ? "Verifying…" : "Run the verifier"}
              </button>
              {!dossier && <p className="muted">Export the dossier first.</p>}
              {verified && (
                <>
                  <VerifyResult r={verified} title={verified.ok ? "The dossier is intact" : "The dossier did not verify"} />
                  <Notice tone="info" title="What the signature means">
                    <span data-testid="signature-note">{verified.signatureNote}</span>
                  </Notice>
                </>
              )}
            </div>
          </Section>

          <Section id="tamper" title="3. Try to cheat">
            <div className="step">
              <p>
                This changes one character in a copy of the file, in your browser, and sends the copy to the same verifier. Your original is not touched. A verifier that cannot catch this is worth nothing.
              </p>
              <button type="button" className="btn btn-secondary" onClick={tamper} disabled={!dossier || busy !== null} data-testid="tamper">
                <Icon name="warn" size={15} /> {busy === "Tamper test" ? "Testing…" : "Change one character and verify the copy"}
              </button>
              {tampered && (
                <div className="tamper-out" data-testid="tamper-out">
                  <p data-testid="tamper-change">
                    Changed <code className="mono">{tampered.change.path}</code>, character {tampered.change.index + 1}: <code className="mono">{tampered.change.from}</code> became <code className="mono">{tampered.change.to}</code>.
                  </p>
                  <VerifyResult r={tampered.result} title={tampered.result.ok ? "The altered copy passed (this is a defect)" : "The altered copy was caught"} />
                </div>
              )}
            </div>
          </Section>

          {error && <ErrorState error={error} onRetry={retry ?? undefined} />}
        </>
      )}
    </CaseGate>
  );
}

export function Dossier() {
  const { id = "" } = useParams();
  useDocTitle(`Dossier, ${id}`);
  return <Body caseId={id} />;
}
