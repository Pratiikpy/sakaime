import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api } from "../api/client";
import { useResource } from "../api/hooks";
import type { TimelineEvent } from "../api/types";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { EmptyState, ErrorState, Loading, Notice } from "../components/feedback";
import { Icon } from "../components/Icon";
import { Section, useDocTitle } from "../components/ui";
import type { IconName } from "../lib/vocab";
import { formatDate, plural, shortHash } from "../lib/format";

const KIND: Record<TimelineEvent["kind"], { words: string; icon: IconName; tone: string; change: boolean }> = {
  fact_asserted: { words: "Fact recorded", icon: "file", tone: "neutral", change: false },
  fact_superseded: { words: "Fact replaced", icon: "drift", tone: "warn", change: true },
  source_changed: { words: "Source changed", icon: "drift", tone: "warn", change: true },
  link_confirmed: { words: "Link confirmed", icon: "link", tone: "good", change: false },
  decision: { words: "Decision recorded", icon: "person", tone: "neutral", change: false },
  finding_stale: { words: "Finding out of date", icon: "clock", tone: "bad", change: true },
  finding_recomputed: { words: "Finding recomputed", icon: "bolt", tone: "good", change: false },
};

function currentlyStale(events: TimelineEvent[]): string[] {
  const state = new Map<string, boolean>();
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    if (e.kind === "finding_stale") for (const id of e.findingIds) state.set(id, true);
    if (e.kind === "finding_recomputed") for (const id of e.findingIds) state.set(id, false);
  }
  return [...state.entries()].filter(([, v]) => v).map(([k]) => k);
}

function Body({ caseId }: { caseId: string }) {
  const [asOf, setAsOf] = useState("");
  const [changesOnly, setChangesOnly] = useState(false);
  const res = useResource<TimelineEvent[]>(`timeline:${caseId}:${asOf}`, (s) => api.timeline(caseId, asOf || undefined, s));
  const events = useMemo(() => [...(res.data ?? [])].sort((a, b) => a.at.localeCompare(b.at)), [res.data]);
  const shown = changesOnly ? events.filter((e) => KIND[e.kind].change) : events;
  const stale = useMemo(() => currentlyStale(events), [events]);

  return (
    <CaseGate id={caseId} screen="Investigate">
      {(c) => (
        <>
          <CaseHeader
            c={c}
            screen="Investigate: evidence timeline"
            lead="What the system knew, and when it learned it. Pick a date to read the case as it stood then. Findings that depended on something that later changed are flagged out of date, and only those."
          />
          <Section id="controls" title="Read the case as of a date">
            <div className="timeline-controls">
              <div className="field">
                <label htmlFor="asof">As of</label>
                <input id="asof" type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} max="2100-12-31" />
              </div>
              <button type="button" className="btn btn-secondary" onClick={() => setAsOf("")} disabled={!asOf}>
                Show today
              </button>
              <label className="check">
                <input type="checkbox" checked={changesOnly} onChange={(e) => setChangesOnly(e.target.checked)} />
                <span>Show only changes</span>
              </label>
            </div>
            <p className="muted" aria-live="polite" data-testid="timeline-status">
              {asOf ? `Reading the case as of ${formatDate(asOf)}. Events after that day are not shown.` : "Reading the case as it stands now."}
            </p>
          </Section>

          {stale.length > 0 && (
            <Notice tone="bad" title={`${plural(stale.length, "finding")} out of date`}>
              <ul className="plain-list" data-testid="stale-list">
                {stale.map((id) => (
                  <li key={id}>
                    <Link to={`/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(id)}`}>Finding {shortHash(id, 12)}</Link> depended on a fact that changed after it was made. Recompute before relying on it.
                  </li>
                ))}
              </ul>
            </Notice>
          )}

          <Section id="events" title="Events" aside={<span className="muted">{plural(shown.length, "event")}</span>}>
            {res.status === "loading" && !res.data && <Loading label="Loading the timeline" rows={5} />}
            {res.status === "error" && <ErrorState error={res.error} onRetry={res.reload} />}
            {res.data && shown.length === 0 && (
              <EmptyState title={changesOnly ? "No changes in this period" : "Nothing was known on this date"} icon="clock">
                {asOf ? "Nothing had been recorded yet on that date." : "No events are recorded for this case."}
              </EmptyState>
            )}
            {shown.length > 0 && (
              <ol className="timeline" data-testid="timeline">
                {shown.map((e, i) => {
                  const k = KIND[e.kind];
                  return (
                    <li key={`${e.at}-${i}`} className={`tl-item tl-${k.tone}`} data-kind={e.kind}>
                      <time className="tl-item__when mono" dateTime={e.at}>
                        {formatDate(e.at)}
                      </time>
                      <div className="tl-item__dot" aria-hidden="true">
                        <Icon name={k.icon} size={14} />
                      </div>
                      <div className="tl-item__body">
                        <p className="tl-item__kind">{k.words}</p>
                        <p>{e.summary}</p>
                        {e.findingIds.length > 0 && (
                          <p className="tl-item__refs">
                            {e.findingIds.map((id) => (
                              <Link key={id} className="mono" to={`/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(id)}`}>
                                finding {shortHash(id, 10)}
                              </Link>
                            ))}
                          </p>
                        )}
                        {e.factIds.length > 0 && (
                          <p className="tl-item__refs muted">
                            {e.factIds.map((f) => (
                              <code key={f} className="mono">
                                fact {shortHash(f, 12)}
                              </code>
                            ))}
                          </p>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            )}
          </Section>
        </>
      )}
    </CaseGate>
  );
}

export function Timeline() {
  const { id = "" } = useParams();
  useDocTitle(`Timeline, ${id}`);
  return <Body caseId={id} />;
}
