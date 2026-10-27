import { useMemo } from "react";
import { useParams } from "react-router-dom";
import type { EvidenceMatrix } from "../api/types";
import { ServedBadge } from "../components/badges";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { EmptyState, Notice } from "../components/feedback";
import { CopyButton, Disclosure, Section, useDocTitle } from "../components/ui";
import { formatMs, plural, shortHash } from "../lib/format";

function show(v: unknown): string {
  if (v === null || v === undefined || v === "") return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function MatrixTable({ m }: { m: EvidenceMatrix }) {
  // Consecutive columns from one source share a group header, so provenance stays visible instead of collapsing.
  const groups = useMemo(() => {
    const out: { sourceId: string; label: string; span: number }[] = [];
    for (const c of m.columns) {
      const last = out[out.length - 1];
      if (last && last.sourceId === c.sourceId) last.span += 1;
      else out.push({ sourceId: c.sourceId, label: c.sourceLabel, span: 1 });
    }
    return out;
  }, [m.columns]);

  return (
    <>
      <p className="muted matrix__hint">
        The table is wider than the screen. Scroll sideways to read all {m.columns.length} columns; the dark headers name the {groups.length === 1 ? "source" : `${groups.length} sources`} they come from.
      </p>
      <div className="table-wrap table-wrap-scroll" role="region" aria-label="Evidence matrix, scrolls sideways" tabIndex={0}>
        <table className="data-table matrix responsive" data-testid="matrix-table">
          <caption className="sr-only">Federated result. Each column names the source it came from.</caption>
          <thead>
            <tr className="matrix__groups">
              {groups.map((g, i) => (
                <th key={`${g.sourceId}-${i}`} colSpan={g.span} scope="colgroup" className="matrix__group" data-source={g.sourceId}>
                  <span className="source-tag">{g.label}</span>
                </th>
              ))}
            </tr>
            <tr>
              {m.columns.map((c) => (
                <th key={c.name} scope="col" data-source={c.sourceId}>
                  <span className="mono">{c.name}</span>
                  <span className="sr-only"> from {c.sourceLabel}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {m.rows.map((r, i) => (
              <tr key={i}>
                {m.columns.map((c) => {
                  const cell = r.cells[c.name];
                  const text = show(cell?.value);
                  return (
                    <td key={c.name} data-label={c.name.replace(/_/g, "_​") /* a break point after each underscore, so the phone layout wraps between words */} data-source={cell?.sourceId ?? c.sourceId}>
                      {text === "" ? (
                        <span className="null-cell">
                          <span aria-hidden="true">no value</span>
                          <span className="sr-only">no value in this source</span>
                        </span>
                      ) : (
                        <span className="cell-val">{text}</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Body({ caseId }: { caseId: string }) {
  return (
    <CaseGate id={caseId} screen="Discover">
      {(c) => {
        const m = c.matrix;
        const sourceName = (id: string) => m?.columns.find((x) => x.sourceId === id)?.sourceLabel ?? c.sources.find((s) => s.source.id === id)?.source.descriptor ?? id;
        return (
          <>
            <CaseHeader
              c={c}
              screen="Discover: evidence matrix"
              lead="One federated result across the separate systems, with each column tied to the source it came from. Nothing is merged without saying where it came from."
            />
            {!m ? (
              <EmptyState title="No federated result for this case" icon="database">
                The federation layer did not return a matrix. That is different from a matrix with no rows: nothing was asked, or the engine could not be reached. See the run mode above.
              </EmptyState>
            ) : (
              <>
                <Section id="provenance" title="How this result was produced">
                  <dl className="meta-grid" data-testid="matrix-meta">
                    <div>
                      <dt>Served from</dt>
                      <dd>
                        <ServedBadge servedFrom={m.servedFrom} />
                      </dd>
                    </div>
                    <div>
                      <dt>Query id</dt>
                      <dd className="with-copy">
                        <code className="mono" data-testid="query-id">
                          {m.queryId}
                        </code>
                        <CopyButton text={m.queryId} what="query id" />
                      </dd>
                    </div>
                    <div>
                      <dt>Result hash</dt>
                      <dd className="with-copy">
                        <code className="mono" title={m.respHash}>
                          {shortHash(m.respHash, 14)}
                        </code>
                        <CopyButton text={m.respHash} what="result hash" />
                      </dd>
                    </div>
                    <div>
                      <dt>Time taken</dt>
                      <dd>{formatMs(m.elapsedMs)}</dd>
                    </div>
                    <div>
                      <dt>Rows</dt>
                      <dd>{plural(m.rows.length, "row")}</dd>
                    </div>
                  </dl>
                  {m.servedFrom !== "live" && (
                    <Notice tone="warn" title={m.servedFrom === "cassette" ? "This is a recorded query" : "This ran on a local fallback"}>
                      {m.servedFrom === "cassette"
                        ? "The result was replayed from a recorded Zetaris response. It is the real response, not a live call in this run."
                        : "The same statement ran on a local DuckDB copy of the files. Zetaris did not run it. The answer is the same logic over the same files, shown honestly as a degraded path."}
                    </Notice>
                  )}
                  <h3 className="subhead">Rows read from each source</h3>
                  <ul className="count-chips" data-testid="source-counts">
                    {Object.entries(m.perSourceRowCounts).map(([id, n]) => (
                      <li key={id}>
                        <span className="source-tag">{sourceName(id)}</span>
                        <span className="mono">{n}</span>
                      </li>
                    ))}
                  </ul>
                </Section>

                <Section id="matrix" title="Result">
                  {m.rows.length === 0 ? (
                    <EmptyState title="The query ran and returned no rows" icon="empty">
                      The sources answered and nothing matched. That is a finding about these sources on this date, not an outage.
                    </EmptyState>
                  ) : (
                    <MatrixTable m={m} />
                  )}
                </Section>

                <Section id="sql" title="The statement">
                  <Disclosure summary="Show the SQL that produced this result">
                    <div className="code-head">
                      <span className="muted">One statement, sent as written.</span>
                      <CopyButton text={m.statement} what="SQL" />
                    </div>
                    <pre className="code-block" data-testid="sql-text">
                      {m.statement}
                    </pre>
                  </Disclosure>
                </Section>
              </>
            )}
          </>
        );
      }}
    </CaseGate>
  );
}

export function Matrix() {
  const { id = "" } = useParams();
  useDocTitle(`Evidence matrix, ${id}`);
  return <Body caseId={id} />;
}
