import { useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError, streamInvestigation } from "../api/client";
import type { TraceEvent } from "../api/types";
import { ProvenanceBadge, ServedBadge } from "../components/badges";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { EmptyState, ErrorState, Notice, useAnnounce } from "../components/feedback";
import { Icon } from "../components/Icon";
import { CopyButton, Disclosure, Section, useDocTitle } from "../components/ui";
import { ROLE_META } from "../lib/vocab";
import { formatDateTime, shortHash } from "../lib/format";

type Phase = "idle" | "running" | "done" | "interrupted";

function EventRow({ e }: { e: TraceEvent }) {
  const role = ROLE_META[e.role] ?? { name: e.role, does: "" };
  const detail = e.detail && Object.keys(e.detail).length > 0 ? e.detail : null;
  return (
    <li className={`trace-item role-${e.role}`} data-role={e.role} data-seq={e.seq}>
      <div className="trace-item__rail" aria-hidden="true">
        <span className="trace-item__n mono">{e.seq + 1}</span>
      </div>
      <div className="trace-item__body">
        <div className="trace-item__head">
          <span className="role-chip" title={role.does}>
            {role.name}
          </span>
          <time className="mono muted" dateTime={e.at}>
            {formatDateTime(e.at)}
          </time>
        </div>
        <p className="trace-item__decision">{e.decision}</p>
        {(e.model || e.federation) && (
          <ul className="trace-item__badges">
            {e.model && (
              <>
                <li>
                  <span className="chip chip-neutral" title="The model that actually answered">
                    <Icon name="bolt" size={13} /> {e.model.routedModel}
                  </span>
                </li>
                <li>{e.model.recorded ? <ProvenanceBadge kind="recorded" text="Recorded reply" /> : <ProvenanceBadge kind="live" text="Live reply" />}</li>
                <li>
                  {e.model.receiptId ? (
                    <span className="receipt">
                      <span className="muted">Receipt</span> <code className="mono">{shortHash(e.model.receiptId, 24)}</code>
                      <CopyButton text={e.model.receiptId} what="receipt id" label="Copy" />
                    </span>
                  ) : (
                    <span className="chip chip-warn" title="No signed compute receipt came with this reply">
                      <Icon name="warn" size={13} /> Unreceipted
                    </span>
                  )}
                </li>
              </>
            )}
            {e.federation && (
              <>
                <li>
                  <span className="receipt">
                    <span className="muted">Query</span> <code className="mono">{e.federation.queryId}</code>
                    <CopyButton text={e.federation.queryId} what="query id" label="Copy" />
                  </span>
                </li>
                <li>
                  {e.federation.servedFrom === "live" || e.federation.servedFrom === "cassette" || e.federation.servedFrom === "fallback" ? (
                    <ServedBadge servedFrom={e.federation.servedFrom} />
                  ) : (
                    <span className="chip chip-neutral">{e.federation.servedFrom}</span>
                  )}
                </li>
              </>
            )}
          </ul>
        )}
        {detail && (
          <Disclosure summary="Detail" className="disclosure-small">
            <pre className="code-block">{JSON.stringify(detail, null, 2)}</pre>
          </Disclosure>
        )}
      </div>
    </li>
  );
}

function Body({ caseId }: { caseId: string }) {
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<ApiError | null>(null);
  const ctl = useRef<AbortController | null>(null);
  const announce = useAnnounce();
  const endRef = useRef<HTMLDivElement>(null);
  const runId = events[0]?.runId;

  useEffect(() => () => ctl.current?.abort(), []);

  const start = async () => {
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    setEvents([]);
    setError(null);
    setPhase("running");
    announce("Investigation started");
    try {
      const { complete } = await streamInvestigation(caseId, (e) => setEvents((xs) => [...xs, e]), c.signal);
      setPhase(complete ? "done" : "interrupted");
      announce(complete ? "Investigation finished" : "The investigation stream ended before the run finished");
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      const err = e instanceof ApiError ? e : new ApiError("UNAVAILABLE", "The stream failed.", 0);
      setError(err);
      setPhase("interrupted");
      announce(`The investigation did not finish. ${err.message}`);
    }
  };

  useEffect(() => {
    if (phase === "running") endRef.current?.scrollIntoView({ block: "nearest", behavior: "auto" });
  }, [events.length, phase]);

  const roles = new Set(events.map((e) => e.role));
  return (
    <CaseGate id={caseId} screen="Investigate">
      {(c) => (
        <>
          <CaseHeader
            c={c}
            screen="Investigate: investigation"
            lead="Each role decides one thing and says why. Model replies carry the model that answered, whether the reply was recorded, and its receipt. Federated queries carry their query id."
            actions={
              <button type="button" className="btn btn-primary" onClick={start} disabled={phase === "running"} data-testid="start-run">
                <Icon name="play" size={14} /> {phase === "running" ? "Running…" : events.length > 0 ? "Run again" : "Run the investigation"}
              </button>
            }
          />
          <Section
            id="trace"
            title="What each role decided"
            aside={
              <span className="muted" data-testid="trace-status">
                {phase === "running" ? "Streaming…" : phase === "done" ? `Finished: ${events.length} decisions, ${roles.size} roles` : phase === "interrupted" ? "Did not finish" : "Not started"}
              </span>
            }
          >
            {phase === "idle" && (
              <EmptyState title="No run yet" icon="play">
                Press Run to watch the investigation. Nothing is called until you do. Each step appears as the service makes it.
              </EmptyState>
            )}
            {error && <ErrorState error={error} onRetry={start} title="The run did not finish" />}
            {phase === "interrupted" && !error && (
              <Notice tone="warn" title="The stream ended before the run reported completion">
                What is shown is what arrived. It is not a full record of the run.
              </Notice>
            )}
            {events.length > 0 && (
              <ol className="trace" data-testid="trace" aria-label="Investigation trace">
                {events.map((e) => (
                  <EventRow key={`${e.runId}-${e.seq}`} e={e} />
                ))}
              </ol>
            )}
            <div ref={endRef} />
            {phase === "done" && runId && (
              <p className="trace-download">
                <a className="btn btn-secondary" href={api.traceUrl(runId)} download data-testid="trace-download">
                  <Icon name="file" size={15} /> Download the trace (JSONL)
                </a>{" "}
                <span className="muted mono">run {shortHash(runId, 14)}</span>
              </p>
            )}
          </Section>
        </>
      )}
    </CaseGate>
  );
}

export function Investigation() {
  const { id = "" } = useParams();
  useDocTitle(`Investigation, ${id}`);
  return <Body caseId={id} />;
}
