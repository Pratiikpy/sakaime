import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useResource } from "../api/hooks";
import { LabelBadge, ProvenanceBadge } from "../components/badges";
import { EmptyState, ErrorState, Loading } from "../components/feedback";
import { Icon } from "../components/Icon";
import { PageHeader, Section, Stat, useDocTitle } from "../components/ui";
import { formatDate, plural } from "../lib/format";

export const REVIEWER_STATE_WORDS: Record<string, string> = {
  unreviewed: "Not reviewed yet",
  accepted: "Accepted",
  narrowed: "Use narrowed",
  evidence_requested: "Evidence requested",
  escalated: "Escalated",
};

export function ReviewDesk() {
  useDocTitle("Review desk");
  const cases = useResource("cases", (s) => api.cases(s));
  const list = cases.data ?? [];
  const open = list.reduce((n, c) => n + c.openQuestions, 0);
  const stale = list.reduce((n, c) => n + c.staleFindings, 0);
  const waiting = list.filter((c) => c.reviewerState === "unreviewed").length;

  return (
    <>
      <PageHeader
        eyebrow="Decide"
        title="Review desk"
        lead="Cases waiting for a decision, the questions that are still open, and anything that changed in the evidence since someone last looked."
      />
      {cases.status === "loading" && !cases.data && <Loading label="Loading cases" rows={5} />}
      {cases.status === "error" && !cases.data && <ErrorState error={cases.error} onRetry={cases.reload} />}
      {cases.data && (
        <>
          <div className="stat-row" data-testid="desk-stats">
            <Stat value={list.length} label={list.length === 1 ? "case on the desk" : "cases on the desk"} />
            <Stat value={waiting} label="not reviewed yet" />
            <Stat value={open} label="open questions" hint="Missing or uncovered parts of a use" />
            <Stat value={stale} label={stale === 1 ? "finding out of date" : "findings out of date"} hint="Evidence changed after the finding was made" />
          </div>
          <Section id="cases" title="Cases">
            {list.length === 0 ? (
              <EmptyState title="No cases yet" icon="file">
                A case is one claim set against the evidence for one intended use. When the service has one, it is listed here.
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="data-table responsive" data-testid="cases-table">
                  <caption className="sr-only">Cases with their headline answer, open questions and review state</caption>
                  <thead>
                    <tr>
                      <th scope="col">Case</th>
                      <th scope="col">Headline answer</th>
                      <th scope="col">Open questions</th>
                      <th scope="col">Out of date</th>
                      <th scope="col">Review state</th>
                      <th scope="col">Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {list.map((c) => (
                      <tr key={c.id} data-case={c.id}>
                        <th scope="row" data-label="Case">
                          <Link className="cell-link" to={`/cases/${encodeURIComponent(c.id)}`}>
                            {c.title}
                          </Link>
                          <div className="cell-sub">{c.productLabel}</div>
                          <div className="cell-sub mono">{c.id}</div>
                          {c.claimConstructed && (
                            <div className="cell-badges">
                              <ProvenanceBadge kind="constructed" text="Constructed claim" />
                            </div>
                          )}
                        </th>
                        <td data-label="Headline answer">{c.headlineLabel ? <LabelBadge label={c.headlineLabel} size="sm" /> : <span className="muted">No answer yet</span>}</td>
                        <td data-label="Open questions" className="num">
                          {c.openQuestions}
                        </td>
                        <td data-label="Out of date" className="num">
                          {c.staleFindings > 0 ? (
                            <span className="stale-flag">
                              <Icon name="clock" size={14} /> {c.staleFindings}
                            </span>
                          ) : (
                            0
                          )}
                        </td>
                        <td data-label="Review state">{REVIEWER_STATE_WORDS[c.reviewerState] ?? c.reviewerState}</td>
                        <td data-label="Updated">{formatDate(c.updatedAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Section>
        </>
      )}
    </>
  );
}
