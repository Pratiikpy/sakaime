import { useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { invalidate } from "../api/hooks";
import type { CaseDetail, Finding, MissingEvidenceItem, TimelineEvent } from "../api/types";
import { LabelBadge, ProvenanceBadge } from "../components/badges";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { Counterexample, FindingTypeTags, XrayLink } from "../components/FindingBits";
import { EmptyState, ErrorState, Notice, useAnnounce } from "../components/feedback";
import { Icon } from "../components/Icon";
import { CopyButton, Section, useDocTitle } from "../components/ui";
import { DECISION_ACTIONS, DIMENSION_NAME } from "../lib/vocab";
import { formatDateTime, newKey, plural } from "../lib/format";
import { REVIEWER_STATE_WORDS } from "./ReviewDesk";

const ACTION_WORDS: Record<string, string> = Object.fromEntries(DECISION_ACTIONS.map((a) => [a.action, a.words]));

function DecisionForm({ caseId, finding, onRecorded }: { caseId: string; finding: Finding; onRecorded: () => void }) {
  const [action, setAction] = useState<string>("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  // One key per attempt. A retry after a failure reuses it, so a decision can never be recorded twice by a double click or a retry.
  const [key, setKey] = useState(newKey);
  const announce = useAnnounce();
  const legendId = `decision-${finding.id}`;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!action || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.decision(caseId, { findingId: finding.id, action, ...(note.trim() ? { note: note.trim() } : {}), idempotencyKey: key });
      announce(`Decision recorded: ${ACTION_WORDS[action]}`);
      setKey(newKey());
      setAction("");
      setNote("");
      invalidate("case:");
      onRecorded();
    } catch (err) {
      const apiErr = err instanceof ApiError ? err : new ApiError("UNAVAILABLE", "The decision could not be sent.", 0);
      setError(apiErr);
      announce(`Decision not recorded. ${apiErr.message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="decision-form" onSubmit={submit} aria-labelledby={legendId} data-testid="decision-form">
      <fieldset>
        <legend id={legendId}>Record a decision</legend>
        <div className="decision-options">
          {DECISION_ACTIONS.map((a) => (
            <label key={a.action} className={`decision-option${action === a.action ? " is-selected" : ""}`}>
              <input type="radio" name={`action-${finding.id}`} value={a.action} checked={action === a.action} onChange={() => setAction(a.action)} />
              <span className="decision-option__words">{a.words}</span>
              <span className="decision-option__gloss">{a.gloss}</span>
            </label>
          ))}
        </div>
      </fieldset>
      <div className="field">
        <label htmlFor={`note-${finding.id}`}>Note (optional)</label>
        <textarea id={`note-${finding.id}`} rows={2} maxLength={2000} value={note} onChange={(e) => setNote(e.target.value)} aria-describedby={`note-h-${finding.id}`} />
        <p className="field__hint" id={`note-h-${finding.id}`}>
          {note.length}/2000. Recorded with your decision and kept in the history.
        </p>
      </div>
      <div className="form__actions">
        <button type="submit" className="btn btn-primary" disabled={!action || busy}>
          {busy ? "Recording…" : "Record decision"}
        </button>
        {!action && <span className="muted">Choose one of the four actions.</span>}
      </div>
      {error && <ErrorState error={error} title="Decision not recorded" />}
    </form>
  );
}

function MissingEvidence({ items }: { items: MissingEvidenceItem[] }) {
  if (items.length === 0) {
    return (
      <EmptyState title="Nothing is missing" icon="check">
        Every part of the use that the claim needs is covered by the evidence read so far.
      </EmptyState>
    );
  }
  return (
    <>
      <p className="muted">Each draft is specific enough to send. Sakaime never sends anything: copy a draft and send it yourself.</p>
      <ul className="missing-list" data-testid="missing-evidence">
        {items.map((m, i) => (
          <li key={`${m.findingId}-${m.dimension}-${i}`} className="missing-item">
            <div className="missing-item__head">
              <strong>{DIMENSION_NAME[m.dimension]}</strong>
              <CopyButton text={m.draft} what="vendor request draft" label="Copy draft" />
            </div>
            <p className="missing-item__req">{m.request}</p>
            <blockquote className="draft">{m.draft}</blockquote>
          </li>
        ))}
      </ul>
    </>
  );
}

function History({ events }: { events: TimelineEvent[] }) {
  const decisions = events.filter((e) => e.kind === "decision");
  if (decisions.length === 0) return <EmptyState title="No decisions recorded" icon="clock">When someone records a decision it is kept here and cannot be edited.</EmptyState>;
  return (
    <ol className="history" data-testid="decision-history">
      {[...decisions].reverse().map((e, i) => (
        <li key={`${e.at}-${i}`}>
          <time className="mono" dateTime={e.at}>
            {formatDateTime(e.at)}
          </time>
          <span>{e.summary}</span>
        </li>
      ))}
    </ol>
  );
}

function ChangedSince({ events }: { events: TimelineEvent[] }) {
  const lastDecisionAt = events.filter((e) => e.kind === "decision").map((e) => e.at).sort().pop();
  const changed = events.filter((e) => (e.kind === "source_changed" || e.kind === "finding_stale" || e.kind === "fact_superseded") && (!lastDecisionAt || e.at > lastDecisionAt));
  if (changed.length === 0) {
    return (
      <EmptyState title="Nothing has changed" icon="check">
        {lastDecisionAt ? `No evidence has changed since the last decision on ${formatDateTime(lastDecisionAt)}.` : "No evidence has changed since this case was opened."}
      </EmptyState>
    );
  }
  return (
    <ul className="changed-list" data-testid="changed-since">
      {changed.map((e, i) => (
        <li key={`${e.at}-${i}`}>
          <Icon name="clock" size={16} />
          <div>
            <p>{e.summary}</p>
            <time className="mono muted" dateTime={e.at}>
              {formatDateTime(e.at)}
            </time>
          </div>
        </li>
      ))}
    </ul>
  );
}

function Body({ c, reload }: { c: CaseDetail; reload: () => void }) {
  const caseId = c.summary.id;
  const timeline = [...c.timeline];
  return (
    <>
      <CaseHeader
        c={c}
        screen="Decide"
        lead={
          <blockquote className="claim-quote">
            <p>{c.claimText}</p>
          </blockquote>
        }
      />
      <Section id="findings" title="Findings" aside={<span className="muted">{plural(c.findings.length, "finding")}</span>}>
        {c.findings.length === 0 ? (
          <EmptyState title="No finding yet" icon="file">The compiler has not produced a finding for this claim.</EmptyState>
        ) : (
          <ul className="finding-list">
            {c.findings.map((f) => (
              <li key={f.id} className="finding-card" data-finding={f.id}>
                <div className="finding-card__head">
                  <LabelBadge label={f.label} size="lg" showGloss />
                  <span className="muted" data-testid="reviewer-state">
                    Review state: {REVIEWER_STATE_WORDS[f.reviewerState] ?? f.reviewerState}
                  </span>
                </div>
                <FindingTypeTags c={c} finding={f} />
                <Counterexample finding={f} />
                {f.degraded.length > 0 && (
                  <Notice tone="warn" title="Sources lost while computing">
                    <ul className="plain-list">
                      {f.degraded.map((d, i) => (
                        <li key={i}>
                          <strong>{d.sourceType}</strong> ({d.dependency}): {d.reason}
                        </li>
                      ))}
                    </ul>
                  </Notice>
                )}
                <div className="finding-card__actions">
                  <XrayLink caseId={caseId} findingId={f.id}>
                    Open the claim X-ray
                  </XrayLink>
                </div>
                <DecisionForm caseId={caseId} finding={f} onRecorded={reload} />
              </li>
            ))}
          </ul>
        )}
      </Section>

      <div className="two-col two-col-wide">
        <Section id="changed" title="Evidence changed since the last review">
          <ChangedSince events={timeline} />
        </Section>
        <Section id="history" title="Decision history">
          <History events={timeline} />
        </Section>
      </div>

      <Section id="missing" title="Missing-evidence list" aside={<span className="muted">{plural(c.missingEvidence.length, "request")}</span>}>
        <MissingEvidence items={c.missingEvidence} />
      </Section>

      {c.summary.claimConstructed && (
        <Notice tone="info" title="About this claim">
          <ProvenanceBadge kind="constructed" text="Constructed" /> The claim above was written for this test in the style of a vendor claim. It is not a statement by any vendor. The regulator and study records it is compared with are real.
        </Notice>
      )}
    </>
  );
}

export function CaseOverview() {
  const { id = "" } = useParams();
  useDocTitle(`Case ${id}`);
  return <CaseGate id={id} screen="Decide">{(c, reload) => <Body c={c} reload={reload} />}</CaseGate>;
}
