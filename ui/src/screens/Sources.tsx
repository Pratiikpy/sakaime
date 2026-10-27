import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { api, ApiError } from "../api/client";
import { invalidate, useResource } from "../api/hooks";
import type { OnboardingResult, SourceRow } from "../api/types";
import { HealthBadge, ProvenanceBadge } from "../components/badges";
import { EmptyState, ErrorState, Loading, Notice, useAnnounce } from "../components/feedback";
import { Icon } from "../components/Icon";
import { CopyButton, Disclosure, PageHeader, Section, useDocTitle } from "../components/ui";
import { ACCESS_NAME, HEALTH_META, KIND_NAME } from "../lib/vocab";
import { formatDateTime, plural, shortHash } from "../lib/format";
import type { SourceHealth } from "../api/types";

const STAGE_NAME: Record<string, { name: string; does: string }> = {
  authorization: { name: "Authorization", does: "Is this address allowed to be read at all?" },
  capability_discovery: { name: "Capability discovery", does: "What does this source offer, and how is it read?" },
  bounded_probe: { name: "Bounded probe", does: "A small, capped read to see what really comes back." },
  mapping_proposal: { name: "Mapping proposal", does: "Which source field means which canonical field." },
  semantic_validation: { name: "Semantic check", does: "Do the values mean what the field names say?" },
  human_review: { name: "Human review", does: "Anything uncertain waits for a person." },
  registration: { name: "Registration", does: "Make the source queryable." },
  monitoring: { name: "Monitoring", does: "Watch for the source changing shape." },
};

const STATUS_WORD: Record<string, { words: string; icon: "check" | "cross" | "clock" | "gap" | "person"; tone: string }> = {
  passed: { words: "Passed", icon: "check", tone: "good" },
  failed: { words: "Failed", icon: "cross", tone: "bad" },
  held: { words: "Held for review", icon: "person", tone: "warn" },
  skipped: { words: "Skipped", icon: "gap", tone: "neutral" },
  pending: { words: "Waiting", icon: "clock", tone: "neutral" },
};

const MAP_CHECK: Record<string, { words: string; icon: "check" | "cross" | "gap" | "person"; tone: string }> = {
  ok: { words: "Matches", icon: "check", tone: "good" },
  renamed: { words: "Renamed", icon: "check", tone: "good" },
  rejected: { words: "Rejected", icon: "cross", tone: "bad" },
  needs_review: { words: "Needs review", icon: "person", tone: "warn" },
};

const EXAMPLES = [
  {
    id: "allowed",
    title: "An allowed source",
    description: "FDA device identifier records for the Transpara breast-screening software, to read its software version labels.",
    url: "https://api.fda.gov/device/udi.json?search=premarket_submissions.submission_number%3A%22K221347%22&limit=100",
  },
  {
    id: "metadata",
    title: "A cloud metadata address",
    description: "Instance metadata for the host machine.",
    url: "https://169.254.169.254/latest/meta-data/",
  },
  {
    id: "unlisted",
    title: "A host nobody approved",
    description: "A vendor-hosted results file that is not on the allowlist.",
    url: "https://results.unlisted-vendor.example/trial-export.json",
  },
];

function SourcesTable({ rows }: { rows: SourceRow[] }) {
  return (
    <div className="table-wrap">
      <table className="data-table responsive" data-testid="sources-table">
        <caption className="sr-only">Sources, their kind, health and freshness</caption>
        <thead>
          <tr>
            <th scope="col">Source</th>
            <th scope="col">Kind and access</th>
            <th scope="col">Health</th>
            <th scope="col">Schema and freshness</th>
            <th scope="col">In the federation</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.source.id} data-source={r.source.id}>
              <th scope="row" data-label="Source">
                <div className="cell-title">{r.source.descriptor}</div>
                <div className="cell-sub mono">{r.source.id}</div>
                <div className="cell-sub">Licence: {r.source.license}</div>
              </th>
              <td data-label="Kind and access">
                <div>{KIND_NAME[r.source.kind] ?? r.source.kind}</div>
                <div className="cell-sub">{ACCESS_NAME[r.source.access] ?? r.source.access}</div>
                {r.authorityNotes && <div className="cell-sub">{r.authorityNotes}</div>}
              </td>
              <td data-label="Health">
                <HealthBadge health={r.source.health} />
                <div className="cell-sub">{r.healthDetail}</div>
              </td>
              <td data-label="Schema and freshness">
                {r.source.schemaHash ? (
                  <div className="cell-hash">
                    <code className="mono" title={r.source.schemaHash}>
                      {shortHash(r.source.schemaHash, 12)}
                    </code>
                    <CopyButton text={r.source.schemaHash} what="schema hash" label="Copy" />
                  </div>
                ) : (
                  <div className="cell-sub">No schema fingerprint yet</div>
                )}
                <div className="cell-sub">Last success: {formatDateTime(r.source.lastSuccessAt)}</div>
              </td>
              <td data-label="In the federation">
                {r.zetarisName ? <code className="mono">{r.zetarisName}</code> : <span className="cell-sub">Not registered in Zetaris</span>}
                {r.rowCount !== undefined && <div className="cell-sub">{plural(r.rowCount, "row")}</div>}
                <div className="cell-sub">Data class: {r.source.dataClass}</div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Legend() {
  return (
    <Disclosure summary="What the health words mean">
      <dl className="legend">
        {(Object.keys(HEALTH_META) as SourceHealth[]).map((h) => (
          <div key={h}>
            <dt>
              <HealthBadge health={h} />
            </dt>
            <dd>{HEALTH_META[h].gloss}</dd>
          </div>
        ))}
      </dl>
    </Disclosure>
  );
}

function OnboardingView({ result, revealed, animating, onRetry, busy }: { result: OnboardingResult; revealed: number; animating: boolean; onRetry: () => void; busy: boolean }) {
  const shown = result.stages.slice(0, revealed);
  const done = revealed >= result.stages.length;
  const stopped = result.outcome === "declined" && result.stages.find((s) => s.stage === "authorization")?.status === "passed" && /UNAVAILABLE/.test(result.reason ?? "");
  // A source whose address was fine but whose later step could not run is not refused as a source. It is said differently from a decline
  // of the address, so a reviewer does not read a missing capability as a verdict on the source.
  const outcome: { tone: "good" | "warn" | "bad"; title: string; icon: "check" | "person" | "cross" | "warn" } = stopped
    ? { tone: "warn", title: "Stopped before registration", icon: "warn" }
    : {
        registered: { tone: "good" as const, title: "Registered", icon: "check" as const },
        held_for_review: { tone: "warn" as const, title: "Held for review", icon: "person" as const },
        declined: { tone: "bad" as const, title: "Declined", icon: "cross" as const },
      }[result.outcome];
  return (
    <div className="onboarding" data-testid="onboarding-result" aria-busy={animating}>
      <ol className="stages">
        {result.stages.map((s, i) => {
          const visible = i < shown.length;
          const meta = STAGE_NAME[s.stage] ?? { name: s.stage, does: "" };
          const st = STATUS_WORD[visible ? s.status : "pending"] ?? STATUS_WORD["pending"]!;
          return (
            <li key={s.stage} className={`stage stage-${visible ? s.status : "pending"}`} data-stage={s.stage} data-status={visible ? s.status : "pending"}>
              <div className="stage__head">
                <span className="stage__n mono">{i + 1}</span>
                <h4 className="stage__name">{meta.name}</h4>
                <span className={`status-pill tone-${st.tone}`}>
                  <Icon name={st.icon} size={13} />
                  <span>{st.words}</span>
                </span>
              </div>
              {visible ? (
                <>
                  <p className="stage__summary">{s.summary}</p>
                  {s.detail && Object.keys(s.detail).length > 0 && (
                    <Disclosure summary="Machine detail" className="disclosure-small">
                      <pre className="code-block">{JSON.stringify(s.detail, null, 2)}</pre>
                    </Disclosure>
                  )}
                </>
              ) : (
                <p className="stage__summary stage__summary-wait">{meta.does}</p>
              )}
            </li>
          );
        })}
      </ol>

      {done && (
        <>
          {result.mapping.length > 0 && (
            <Section level={3} title="Field mapping" aside={<span className="muted">{plural(result.mapping.length, "field")}</span>}>
              <div className="table-wrap table-wrap-scroll" role="region" aria-label="Field mapping, scrolls sideways" tabIndex={0}>
                <table className="data-table responsive" data-testid="mapping-table">
                  <caption className="sr-only">Proposed mapping from source fields to canonical fields, with the validator verdict for each</caption>
                  <thead>
                    <tr>
                      <th scope="col">Source field</th>
                      <th scope="col">Canonical field</th>
                      <th scope="col">Unit</th>
                      <th scope="col">Confidence</th>
                      <th scope="col">Check</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.mapping.map((m) => {
                      const c = MAP_CHECK[m.check]!;
                      return (
                        <tr key={m.sourceField} data-check={m.check}>
                          <th scope="row" data-label="Source field">
                            <code className="mono">{m.sourceField}</code>
                          </th>
                          <td data-label="Canonical field">
                            <code className="mono">{m.canonicalField}</code>
                          </td>
                          <td data-label="Unit">{m.unit ?? "none"}</td>
                          <td data-label="Confidence">{m.confidence === undefined ? "not stated" : `${Math.round(m.confidence * 100)}%`}</td>
                          <td data-label="Check">
                            <span className={`status-pill tone-${c.tone}`}>
                              <Icon name={c.icon} size={13} />
                              <span>{c.words}</span>
                            </span>
                            {m.reason && <div className="cell-sub">{m.reason}</div>}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </Section>
          )}
          <div className={`outcome outcome-${outcome.tone}`} role="status" data-outcome={result.outcome}>
            <Icon name={outcome.icon} size={22} />
            <div>
              <h3 className="outcome__title">{outcome.title}</h3>
              {result.reason && <p>{result.reason}</p>}
              {/* A repeated request returns the stored answer. A decline that came from reading the source (it was down, say) can be run again; one
                  that came from the address itself cannot, so the button is offered only once the address had passed. */}
              {result.outcome === "declined" && result.stages.find((s) => s.stage === "authorization")?.status === "passed" && (
                <p>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry} disabled={busy} data-testid="onboard-retry">
                    Ask again as a fresh run
                  </button>
                </p>
              )}
              <div className="badge-row">
                {result.recorded && <ProvenanceBadge kind="recorded" text="Mapping from a recorded model reply" />}
                {result.schemaHash && <span className="mono muted">schema {shortHash(result.schemaHash, 12)}</span>}
                {result.zetarisName && <span className="mono muted">{result.zetarisName}</span>}
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

function AddSource({ onRegistered }: { onRegistered: () => void }) {
  const [description, setDescription] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<OnboardingResult | null>(null);
  const [revealed, setRevealed] = useState(0);
  const announce = useAnnounce();
  const timer = useRef<number>(0);
  const abort = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      window.clearTimeout(timer.current);
      abort.current?.abort();
    },
    [],
  );

  const reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const valid = description.trim().length >= 3 && url.trim().length > 0;

  const reveal = (r: OnboardingResult) => {
    const total = r.stages.length;
    if (reduced) {
      setRevealed(total);
      return;
    }
    let n = 0;
    const step = () => {
      n += 1;
      setRevealed(n);
      if (n < total) timer.current = window.setTimeout(step, 320);
    };
    timer.current = window.setTimeout(step, 200);
  };

  const submit = async (e: FormEvent | null, retry = false) => {
    e?.preventDefault();
    if (!valid || busy) return;
    window.clearTimeout(timer.current);
    abort.current?.abort();
    const ctl = new AbortController();
    abort.current = ctl;
    setBusy(true);
    setError(null);
    setResult(null);
    setRevealed(0);
    try {
      const r = await api.proposeSource({ description: description.trim(), url: url.trim(), ...(retry ? { retry: true } : {}) }, ctl.signal);
      setResult(r);
      reveal(r);
      announce(`Onboarding finished: ${r.outcome.replace(/_/g, " ")}${r.reason ? `. ${r.reason}` : ""}`);
      if (r.outcome === "registered") {
        invalidate("sources");
        onRegistered();
      }
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      const apiErr = err instanceof ApiError ? err : new ApiError("UNAVAILABLE", "The request failed.", 0);
      setError(apiErr);
      announce(`Not onboarded. ${apiErr.message}`);
    } finally {
      setBusy(false);
    }
  };

  const total = result?.stages.length ?? 0;
  const animating = !!result && revealed < total;

  return (
    <div className="add-source">
      <form className="form" onSubmit={submit} noValidate>
        <div className="field">
          <label htmlFor="src-desc">What does the source hold?</label>
          <input id="src-desc" name="description" type="text" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line, for example: device software version labels" maxLength={500} autoComplete="off" aria-describedby="src-desc-h" />
          <p className="field__hint" id="src-desc-h">
            At least 3 characters. This helps the mapping step choose which fields to expect.
          </p>
        </div>
        <div className="field">
          <label htmlFor="src-url">Address (https only)</label>
          <input id="src-url" name="url" type="url" inputMode="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" maxLength={2000} autoComplete="off" aria-describedby="src-url-h" />
          <p className="field__hint" id="src-url-h">
            Only hosts on the allowlist are read. Addresses that point inside a network, or at cloud metadata, are always refused.
          </p>
        </div>
        <div className="form__actions">
          <button type="submit" className="btn btn-primary" disabled={!valid || busy} aria-disabled={!valid || busy}>
            {busy ? "Onboarding…" : "Onboard this source"}
          </button>
          {busy && <span className="muted">Running eight stages…</span>}
        </div>
        <fieldset className="examples">
          <legend>Or try one</legend>
          <div className="chip-row">
            {EXAMPLES.map((ex) => (
              <button
                key={ex.id}
                type="button"
                className="btn btn-secondary btn-sm"
                data-example={ex.id}
                onClick={() => {
                  setDescription(ex.description);
                  setUrl(ex.url);
                  announce(`Filled in the example: ${ex.title}`);
                }}
              >
                {ex.title}
              </button>
            ))}
          </div>
        </fieldset>
      </form>

      <div className="add-source__out" aria-live="polite">
        {error && (
          <div className="refusal" data-testid="onboarding-error">
            <ErrorState error={error} title={error.failure === "REFUSED" ? "Refused before anything was read" : undefined} />
          </div>
        )}
        {result && <OnboardingView result={result} revealed={revealed} animating={animating} onRetry={() => void submit(null, true)} busy={busy} />}
        {!result && !error && !busy && (
          <EmptyState title="Nothing onboarded yet" icon="database">
            Add an address above. You will see each of the eight stages, the field mapping with its checks, and either a registration, a hold for review or a refusal with the reason.
          </EmptyState>
        )}
        {busy && !result && <Loading label="Onboarding the source" rows={4} />}
      </div>
    </div>
  );
}

export function Sources() {
  useDocTitle("Source console");
  const sources = useResource("sources", (s) => api.sources(s));
  const counts = useMemo(() => {
    const c: Partial<Record<SourceHealth, number>> = {};
    for (const r of sources.data ?? []) c[r.source.health] = (c[r.source.health] ?? 0) + 1;
    return c;
  }, [sources.data]);

  return (
    <>
      <PageHeader
        eyebrow="Discover"
        title="Source console"
        lead="Every place Sakaime reads from, whether it is answering, what shape its data has, and how it is reached. A source that cannot be reached is never read as a source with nothing in it."
      />
      <Section
        id="sources"
        title="Sources"
        aside={
          sources.data ? (
            <ul className="health-counts" aria-label="Sources by health">
              {(Object.keys(counts) as SourceHealth[]).map((h) => (
                <li key={h}>
                  <HealthBadge health={h} /> <span className="mono">{counts[h]}</span>
                </li>
              ))}
            </ul>
          ) : undefined
        }
      >
        {sources.status === "loading" && !sources.data && <Loading label="Loading sources" rows={5} />}
        {sources.status === "error" && !sources.data && <ErrorState error={sources.error} onRetry={sources.reload} />}
        {sources.status === "error" && sources.data && <Notice tone="warn" title="Showing the last list we had">{sources.error.message}</Notice>}
        {sources.data && sources.data.length === 0 && (
          <EmptyState title="No sources are registered" icon="database">
            Add one below. Until a source is registered, no case can read from it.
          </EmptyState>
        )}
        {sources.data && sources.data.length > 0 && <SourcesTable rows={sources.data} />}
        <Legend />
      </Section>

      <Section id="add" title="Add a source" aside={<span className="muted">Eight stages, one decision</span>}>
        <AddSource onRegistered={sources.reload} />
      </Section>
    </>
  );
}
