import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { invalidate } from "../api/hooks";
import type { CaseDetail, Finding, MissingEvidenceItem, TimelineEvent } from "../api/types";
import { LabelBadge, ProvenanceBadge } from "../components/badges";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { FindingTypeTags, XrayLink } from "../components/FindingBits";
import { EmptyState, ErrorState, Notice, useAnnounce } from "../components/feedback";
import { Icon } from "../components/Icon";
import { Clamp, CopyButton, Disclosure, Section, useDocTitle } from "../components/ui";
import { Why, whyLead } from "../components/Why";
import { claimName, claimSummary, headlineFinding, otherFindings } from "../lib/explain";
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

function MissingEvidence({ items, c }: { items: MissingEvidenceItem[]; c: CaseDetail }) {
  if (items.length === 0) {
    return (
      <EmptyState title="Nothing is missing" icon="check">
        Every part of the use that the claim needs is covered by the evidence read so far.
      </EmptyState>
    );
  }
  const byFinding = new Map<string, MissingEvidenceItem[]>();
  for (const m of items) byFinding.set(m.findingId, [...(byFinding.get(m.findingId) ?? []), m]);
  return (
    <>
      <p className="muted">
        This is the useful part when the answer is "not enough evidence": exactly what to ask for, written so it can be sent. Sakaime never sends anything: copy a draft and send it
        yourself.
      </p>
      <ul className="missing-list" data-testid="missing-evidence">
        {[...byFinding.entries()].map(([fid, list]) => {
          const f = c.findings.find((x) => x.id === fid);
          return (
            <li key={fid} className="missing-group">
              <h3 className="subhead">{f ? claimName(c, f) : "Finding"}</h3>
              <ul className="plain-list">
                {list.map((m, i) => (
                  <li key={`${m.findingId}-${m.dimension}-${i}`} className="missing-item">
                    <div className="missing-item__head">
                      <strong>{DIMENSION_NAME[m.dimension]}</strong>
                      <CopyButton text={m.draft} what={`vendor request draft, ${DIMENSION_NAME[m.dimension].toLowerCase()}`} label="Copy draft" />
                    </div>
                    <p className="missing-item__req">
                      <Clamp text={m.request} lines={2} />
                    </p>
                    <Disclosure summary="Show the full draft" className="disclosure-small">
                      <blockquote className="draft">{m.draft}</blockquote>
                    </Disclosure>
                  </li>
                ))}
              </ul>
            </li>
          );
        })}
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

function ReviewState({ f, testId }: { f: Finding; testId: string }) {
  return (
    <span className="muted" data-testid={testId}>
      Review state: {REVIEWER_STATE_WORDS[f.reviewerState] ?? f.reviewerState}
    </span>
  );
}

/** One vendor claim: what it says where it differs, the answer, and the decision form only when the reviewer asks for it. */
function VendorClaim({ c, f, onRecorded }: { c: CaseDetail; f: Finding; onRecorded: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="finding-card finding-card-compact" data-finding={f.id} data-claim={f.claimId}>
      <div className="finding-card__head">
        <div>
          <h3 className="finding-card__name">{claimName(c, f)}</h3>
          <p className="finding-card__says">{claimSummary(c, f)}</p>
        </div>
        <LabelBadge label={f.label} />
      </div>
      <p className="finding-card__why">{whyLead(c, f)}</p>
      <Disclosure summary="Which parts are open, and what would settle it" className="disclosure-small">
        <Why c={c} f={f} maxDims={3} maxAsks={2} heading={false} showLead={false} />
      </Disclosure>
      <div className="finding-card__actions">
        <XrayLink caseId={c.summary.id} findingId={f.id}>
          Open the claim X-ray
        </XrayLink>
        <ReviewState f={f} testId="claim-reviewer-state" />
      </div>
      <Disclosure summary="Record a decision on this claim" onToggle={setOpen}>
        {open && <DecisionForm caseId={c.summary.id} finding={f} onRecorded={onRecorded} />}
      </Disclosure>
    </li>
  );
}

function Body({ c, reload }: { c: CaseDetail; reload: () => void }) {
  const caseId = c.summary.id;
  const timeline = [...c.timeline];
  const head = headlineFinding(c);
  const others = otherFindings(c);
  return (
    <>
      <CaseHeader
        c={c}
        screen="Decide"
        lead={
          <blockquote className="claim-quote" data-testid="claim-text">
            <p>{c.claimText}</p>
          </blockquote>
        }
      />
      {!head ? (
        <Section id="findings" title="The answer">
          <EmptyState title="No finding yet" icon="file">
            The compiler has not produced a finding for this claim.
          </EmptyState>
        </Section>
      ) : (
        <Section id="answer" title="The answer for this use">
          <div className="finding-card finding-card-head" data-finding={head.id} data-claim={head.claimId}>
            <div className="finding-card__head">
              <LabelBadge label={head.label} size="lg" showGloss />
              <ReviewState f={head} testId="reviewer-state" />
            </div>
            <FindingTypeTags c={c} finding={head} />
            <Why c={c} f={head} />
            {head.degraded.length > 0 && (
              <Notice tone="warn" title="Sources lost while computing">
                <ul className="plain-list">
                  {head.degraded.map((d, i) => (
                    <li key={i}>
                      <strong>{d.sourceType}</strong> ({d.dependency}): {d.reason}
                    </li>
                  ))}
                </ul>
              </Notice>
            )}
            <div className="finding-card__actions">
              <XrayLink caseId={caseId} findingId={head.id}>
                Open the claim X-ray
              </XrayLink>
              <Link className="btn btn-secondary" to={`/cases/${encodeURIComponent(caseId)}/lab`}>
                Change the use in the lab <Icon name="arrow" size={16} />
              </Link>
            </div>
            <DecisionForm caseId={caseId} finding={head} onRecorded={reload} />
          </div>
        </Section>
      )}

      {others.length > 0 && (
        <Section id="claims" title="The vendor's claims, checked against the same evidence" aside={<span className="muted">{plural(others.length, "claim")}</span>}>
          <p className="muted">Each claim in the vendor packet is compared with the same regulator and study records. Open any one to see the exact passages.</p>
          <ul className="finding-list" data-testid="vendor-claims">
            {others.map((f) => (
              <VendorClaim key={f.id} c={c} f={f} onRecorded={reload} />
            ))}
          </ul>
        </Section>
      )}

      <Section id="missing" title="Missing-evidence list" aside={<span className="muted">{plural(c.missingEvidence.length, "request")}</span>}>
        <MissingEvidence items={c.missingEvidence} c={c} />
      </Section>

      <div className="two-col two-col-wide">
        <Section id="changed" title="Evidence changed since the last review">
          <ChangedSince events={timeline} />
        </Section>
        <Section id="history" title="Decision history">
          <History events={timeline} />
        </Section>
      </div>

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
  return (
    <CaseGate id={id} screen="Decide">
      {(c, reload) => <Body c={c} reload={reload} />}
    </CaseGate>
  );
}
