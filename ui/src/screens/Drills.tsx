import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import { DRILLS } from "@contract";
import type { CaseDetail, DrillResponse, Finding } from "../api/types";
import { LabelBadge } from "../components/badges";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { EmptyState, ErrorState, Notice, useAnnounce } from "../components/feedback";
import { Icon } from "../components/Icon";
import { Section, useDocTitle } from "../components/ui";
import { ASSERTION_NAME, DRILL_META, LABEL_META } from "../lib/vocab";
import { shortHash } from "../lib/format";
import { claimName } from "../lib/explain";

type Drill = (typeof DRILLS)[number];
type Outcome = { ok: true; res: DrillResponse } | { ok: false; error: ApiError };

const LOSSES: Drill[] = ["source_off", "source_empty", "zetaris_off", "truncated_result"];

/** Checks the invariants on what the service sent back, so a wrong answer is shown as wrong instead of being taken on trust. */
function checks(drill: Drill, r: DrillResponse) {
  const out: { id: string; ok: boolean; text: string }[] = [];
  const pairs = r.after.map((a) => [r.before.find((b) => b.id === a.id) ?? r.before.find((b) => b.claimId === a.claimId), a] as const);
  if (LOSSES.includes(drill)) {
    const rose = pairs.some(([b, a]) => b && b.label !== "SUPPORTED_FOR_SCOPE" && a.label === "SUPPORTED_FOR_SCOPE");
    out.push({ id: "no-rise", ok: !rose, text: "Losing a source did not make any answer more supportive." });
    // An answer that moved because of a loss must say what was lost.
    const unexplained = pairs.some(([b, a]) => b && b.label !== a.label && a.degraded.length === 0);
    out.push({ id: "reported", ok: !unexplained, text: "Where an answer moved because of a loss, the finding names what was lost." });
  }
  if (drill === "model_off") {
    out.push({ id: "same", ok: pairs.every(([b, a]) => !b || b.label === a.label), text: "Labels come from rules, so switching the model off did not move any of them." });
  }
  if (drill === "injection_in_document") {
    out.push({ id: "no-obey", ok: pairs.every(([b, a]) => !b || b.label === a.label), text: "The instruction inside the document did not change any answer." });
  }
  if (drill === "registry_changed") {
    const staleKnown = new Set(r.before.map((f) => f.id));
    out.push({ id: "only-dependent", ok: r.staleFindingIds.every((id) => staleKnown.has(id)), text: "Only findings that existed before the change are marked out of date." });
  }
  out.push({ id: "server", ok: r.invariantHeld, text: "The service reports that its own invariant held." });
  return out;
}

function Delta({ before, after }: { before?: Finding; after: Finding }) {
  const changed = before && before.label !== after.label;
  return (
    <div className="drill-delta" data-changed={!!changed}>
      <div>
        <p className="lab-compare__cap">Before</p>
        {before ? <LabelBadge label={before.label} size="sm" /> : <span className="muted">no earlier finding</span>}
      </div>
      <Icon name="arrow" size={18} />
      <div>
        <p className="lab-compare__cap">After</p>
        <LabelBadge label={after.label} size="sm" />
      </div>
    </div>
  );
}

function ResultPanel({ drill, r, c }: { drill: Drill; r: DrillResponse; c: CaseDetail }) {
  const cs = checks(drill, r);
  const allOk = cs.every((c) => c.ok);
  return (
    <div className="drill-result" data-testid="drill-result" data-drill={drill} data-held={allOk}>
      <p className="drill-result__narr" data-testid="drill-narrative">
        {r.narrative}
      </p>
      <ul className="drill-findings">
        {r.after.map((a) => {
          const b = r.before.find((x) => x.id === a.id) ?? r.before.find((x) => x.claimId === a.claimId);
          return (
            <li key={a.id} data-claim={a.claimId}>
              {r.after.length > 1 && <p className="drill-findings__name">{claimName(c, a)}</p>}
              <Delta before={b} after={a} />
              <p className="muted">
                {LABEL_META[a.label].words}
                {a.degraded.length > 0 ? "" : "."}
              </p>
              {a.degraded.length > 0 && (
                <ul className="plain-list" data-testid="drill-degraded">
                  {a.degraded.map((d, i) => (
                    <li key={i}>
                      <strong>{ASSERTION_NAME[d.sourceType] ?? d.sourceType}</strong> ({d.dependency}): {d.reason}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>

      <h4 className="subhead">Out of date after this</h4>
      {r.staleFindingIds.length === 0 ? (
        <p className="muted" data-testid="stale-none">
          No finding was marked out of date.
        </p>
      ) : (
        <ul className="plain-list" data-testid="stale-ids">
          {r.staleFindingIds.map((id) => (
            <li key={id}>
              <code className="mono">{shortHash(id, 14)}</code>
            </li>
          ))}
        </ul>
      )}

      <h4 className="subhead">Checks on the result</h4>
      <ul className="check-list" data-testid="drill-checks">
        {cs.map((c) => (
          <li key={c.id} className={c.ok ? "is-pass" : "is-fail"} data-check={c.id} data-ok={c.ok}>
            <Icon name={c.ok ? "check" : "cross"} size={15} />
            <span>
              <strong>{c.ok ? "Held" : "Broken"}:</strong> {c.text}
            </span>
          </li>
        ))}
      </ul>
      {!allOk && (
        <Notice tone="bad" title="An invariant did not hold">
          This is a defect in the service, not a result about the evidence. Do not rely on the after-state shown here.
        </Notice>
      )}
    </div>
  );
}

function targetsFor(c: CaseDetail): { label: string; options: { value: string; text: string }[] }[] {
  const types = [...new Set([...(c.claim.dependencies?.required ?? []), ...(c.claim.dependencies?.corroborating ?? []), "authorization", "study"])];
  return [
    { label: "Kind of evidence", options: types.map((t) => ({ value: t, text: ASSERTION_NAME[t] ?? t })) },
    { label: "A named source", options: c.sources.map((s) => ({ value: s.source.id, text: s.source.descriptor })) },
  ];
}

function Body({ c }: { c: CaseDetail }) {
  const caseId = c.summary.id;
  const [targets, setTargets] = useState<Record<string, string>>({ source_off: "study", source_empty: "study" });
  const [results, setResults] = useState<Partial<Record<Drill, Outcome>>>({});
  const [running, setRunning] = useState<Drill | "all" | null>(null);
  const [selected, setSelected] = useState<Drill | null>(null);
  const announce = useAnnounce();
  const groups = targetsFor(c);

  const run = async (drill: Drill, quiet = false): Promise<void> => {
    const meta = DRILL_META[drill]!;
    if (!quiet) setRunning(drill);
    try {
      const res = await api.drill(caseId, { drill, ...(meta.needsTarget ? { target: targets[drill] } : {}) });
      setResults((r) => ({ ...r, [drill]: { ok: true, res } }));
      if (!quiet) {
        setSelected(drill);
        announce(`${meta.name}: ${res.narrative}`);
      }
    } catch (e) {
      const error = e instanceof ApiError ? e : new ApiError("UNAVAILABLE", "The drill could not run.", 0);
      setResults((r) => ({ ...r, [drill]: { ok: false, error } }));
      if (!quiet) {
        setSelected(drill);
        announce(`${meta.name} could not run. ${error.message}`);
      }
    } finally {
      if (!quiet) setRunning(null);
    }
  };

  const runAll = async () => {
    setRunning("all");
    for (const d of DRILLS) await run(d, true);
    setRunning(null);
    setSelected(DRILLS[0]);
    announce("All seven drills have run. Results are listed below.");
  };

  const sel = selected ? results[selected] : undefined;

  return (
    <>
      <CaseHeader
        c={c}
        screen="Decide: resilience"
        lead="Break something on purpose and see what the system does. The rule being tested: when a source is lost, an answer may become less sure but never more sure, and a source that could not be reached is never reported as a source with nothing in it."
      />
      <Section
        id="drills"
        title="Drills"
        aside={
          <button type="button" className="btn btn-secondary" onClick={runAll} disabled={running !== null} data-testid="run-all">
            {running === "all" ? "Running all…" : "Run all seven"}
          </button>
        }
      >
        <ul className="drill-grid">
          {DRILLS.map((d) => {
            const m = DRILL_META[d]!;
            const out = results[d];
            return (
              <li key={d} className={`drill-card${selected === d ? " is-selected" : ""}`} data-drill={d}>
                <h3 className="drill-card__name">{m.name}</h3>
                <p>{m.does}</p>
                {m.needsTarget && (
                  <div className="field">
                    <label htmlFor={`t-${d}`}>Which one</label>
                    <select id={`t-${d}`} value={targets[d] ?? ""} onChange={(e) => setTargets((t) => ({ ...t, [d]: e.target.value }))}>
                      {groups.map((g) => (
                        <optgroup key={g.label} label={g.label}>
                          {g.options.map((o) => (
                            <option key={`${g.label}-${o.value}`} value={o.value}>
                              {o.text}
                            </option>
                          ))}
                        </optgroup>
                      ))}
                    </select>
                  </div>
                )}
                <div className="drill-card__foot">
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => run(d)} disabled={running !== null} data-run={d}>
                    <Icon name="play" size={13} /> {running === d ? "Running…" : "Run drill"}
                  </button>
                  {out && (
                    <button type="button" className="btn btn-ghost btn-sm" onClick={() => setSelected(d)} aria-pressed={selected === d}>
                      {out.ok ? "Show result" : "Show error"}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      {Object.keys(results).length > 0 && (
        <Section id="summary" title="Results so far">
          <div className="table-wrap">
            <table className="data-table responsive" data-testid="drill-summary">
              <caption className="sr-only">Each drill that has run, the answer before and after, and whether the checks held</caption>
              <thead>
                <tr>
                  <th scope="col">Drill</th>
                  <th scope="col">Answer before</th>
                  <th scope="col">Answer after</th>
                  <th scope="col">Out of date</th>
                  <th scope="col">Checks</th>
                </tr>
              </thead>
              <tbody>
                {DRILLS.filter((d) => results[d]).map((d) => {
                  const o = results[d]!;
                  if (!o.ok) {
                    return (
                      <tr key={d} data-drill={d}>
                        <th scope="row" data-label="Drill">{DRILL_META[d]!.name}</th>
                        <td colSpan={4} data-label="Result">Could not run: {o.error.message}</td>
                      </tr>
                    );
                  }
                  const a = o.res.after.find((x) => x.claimId === c.claim.id) ?? o.res.after[0];
                  const b = a ? (o.res.before.find((x) => x.id === a.id) ?? o.res.before.find((x) => x.claimId === a.claimId)) : undefined;
                  const moved = o.res.after.filter((x) => {
                    const was = o.res.before.find((y) => y.id === x.id) ?? o.res.before.find((y) => y.claimId === x.claimId);
                    return was && was.label !== x.label;
                  }).length;
                  const ok = checks(d, o.res).every((x) => x.ok);
                  return (
                    <tr key={d} data-drill={d} data-held={ok}>
                      <th scope="row" data-label="Drill">
                        <button type="button" className="link-button" onClick={() => setSelected(d)}>
                          {DRILL_META[d]!.name}
                        </button>
                      </th>
                      <td data-label="Answer before">{b ? <LabelBadge label={b.label} size="sm" /> : "none"}</td>
                      <td data-label="Answer after">
                        {a ? <LabelBadge label={a.label} size="sm" /> : "none"}
                        {o.res.after.length > 1 && <p className="cell-sub">{moved === 0 ? `None of the ${o.res.after.length} claims moved` : `${moved} of ${o.res.after.length} claims moved`}</p>}
                      </td>
                      <td data-label="Out of date" className="num">{o.res.staleFindingIds.length}</td>
                      <td data-label="Checks">
                        <span className={`status-pill tone-${ok ? "good" : "bad"}`}>
                          <Icon name={ok ? "check" : "cross"} size={13} /> {ok ? "All held" : "Broken"}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      <Section id="detail" title={selected ? DRILL_META[selected]!.name : "Result"}>
        {!selected && (
          <EmptyState title="No drill run yet" icon="play">
            Pick a drill and press Run. You will see the answer before and after, what the system says happened, which findings went out of date, and whether each invariant held.
          </EmptyState>
        )}
        {selected && !sel && <EmptyState title="This drill has not run" icon="play">Press its Run button.</EmptyState>}
        {sel && !sel.ok && <ErrorState error={sel.error} />}
        {sel && sel.ok && selected && (
          <ResultPanel drill={selected} r={sel.res} c={c} />
        )}
        {sel && sel.ok && (
          <p className="muted drill-mode" data-testid="drill-mode">
            Run mode at the time: {sel.res.mode.sample ? "sample run" : "live run"}, federation {sel.res.mode.federation}, model {sel.res.mode.model}, sources {sel.res.mode.sources}.
          </p>
        )}
      </Section>
      <p className="muted">
        Back to <Link to={`/cases/${encodeURIComponent(caseId)}`}>the case</Link>.
      </p>
    </>
  );
}

export function Drills() {
  const { id = "" } = useParams();
  useDocTitle(`Resilience drills, ${id}`);
  return <CaseGate id={id} screen="Decide">{(c) => <Body c={c} key={c.summary.id} />}</CaseGate>;
}
