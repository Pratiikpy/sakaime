import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { api, ApiError } from "../api/client";
import type { CaseDetail, Dimension, RecomputeResponse, Relation, Scope } from "../api/types";
import { LabelBadge, RelationBadge } from "../components/badges";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { EmptyState, ErrorState, Loading, useAnnounce } from "../components/feedback";
import { Icon } from "../components/Icon";
import { Clamp, CopyButton, Section, useDocTitle } from "../components/ui";
import { Why } from "../components/Why";
import { headlineFinding } from "../lib/explain";
import { DIMENSION_NAME, LABEL_META, PURPOSE_SUGGESTIONS, RELATION_META, SETTING_SUGGESTIONS } from "../lib/vocab";
import { formatMs } from "../lib/format";

interface Form {
  versions: string;
  ageMin: string;
  ageMax: string;
  settings: string[];
  purpose: string;
  from: string;
  operatingPoint: string;
  asOf: string;
}

function initial(use: Scope): Form {
  return {
    versions: (use.versions ?? []).join(", "),
    ageMin: use.population?.age?.min?.toString() ?? "",
    ageMax: use.population?.age?.max?.toString() ?? "",
    settings: use.settings ?? [],
    purpose: use.purpose ?? "",
    from: use.timing?.from ?? "",
    operatingPoint: use.operatingPoint ?? "",
    asOf: "",
  };
}

const splitList = (s: string): string[] => s.split(",").map((x) => x.trim()).filter(Boolean);
const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);

/** Only the keys that differ from the case's own claim are sent. An emptied field means "leave as it is". */
function buildPatch(orig: Scope, f: Form): Partial<Scope> | { error: string } {
  const patch: Partial<Scope> = {};
  const versions = splitList(f.versions);
  if (versions.length > 0 && !sameList(versions, orig.versions ?? [])) patch.versions = versions;

  const min = f.ageMin.trim() === "" ? undefined : Number(f.ageMin);
  const max = f.ageMax.trim() === "" ? undefined : Number(f.ageMax);
  if ((min !== undefined && (!Number.isFinite(min) || min < 0)) || (max !== undefined && (!Number.isFinite(max) || max < 0))) return { error: "Ages must be numbers of 0 or more." };
  if (min !== undefined && max !== undefined && min > max) return { error: "The youngest age cannot be above the oldest age." };
  const o = orig.population?.age;
  if ((min !== undefined || max !== undefined) && (min !== o?.min || max !== o?.max)) {
    patch.population = { ...(orig.population ?? {}), age: { ...(min !== undefined ? { min } : {}), ...(max !== undefined ? { max } : {}) } };
  }
  if (f.settings.length > 0 && !sameList(f.settings, orig.settings ?? [])) patch.settings = f.settings;
  if (f.purpose.trim() && f.purpose.trim() !== (orig.purpose ?? "")) patch.purpose = f.purpose.trim();
  if (f.from.trim() && f.from !== (orig.timing?.from ?? "")) patch.timing = { ...(orig.timing ?? {}), from: f.from };
  if (f.operatingPoint.trim() && f.operatingPoint.trim() !== (orig.operatingPoint ?? "")) patch.operatingPoint = f.operatingPoint.trim();
  return patch;
}

function Result({ r, c }: { r: RecomputeResponse; c: CaseDetail }) {
  const before = LABEL_META[r.before.label];
  const after = LABEL_META[r.after.label];
  const requests = r.after.requiredEvidence;
  const drafts = new Map(c.missingEvidence.map((m) => [`${m.dimension}`, m.draft]));
  return (
    <div className="lab-result" data-testid="lab-result" data-label-changed={r.labelChanged}>
      <div className="lab-compare">
        <div className="lab-compare__side">
          <p className="lab-compare__cap">Before</p>
          <LabelBadge label={r.before.label} size="md" />
        </div>
        <Icon name="arrow" size={22} className="lab-compare__arrow" />
        <div className="lab-compare__side">
          <p className="lab-compare__cap">After</p>
          <LabelBadge label={r.after.label} size="md" />
        </div>
      </div>
      <p className="lab-summary" data-testid="lab-summary">
        {r.labelChanged
          ? `The answer changed from “${before.words}” to “${after.words}”.`
          : `The answer is unchanged: “${after.words}”.`}{" "}
        {r.changed.length > 0
          ? r.changed.length === 1 ? "One dimension changed." : `${r.changed.length} dimensions changed.`
          : "No dimension changed."}
      </p>

      <div className="lab-meta" data-testid="lab-meta">
        <span className="pill pill-good" data-testid="no-model">
          <Icon name="check" size={14} /> No model was called
        </span>
        <span className="pill">
          <Icon name="bolt" size={14} /> Recomputed in <span className="mono">{formatMs(r.elapsedMs)}</span>
        </span>
      </div>

      {r.changed.length > 0 && (
        <>
          <h3 className="subhead">What moved</h3>
          <ul className="changed-dims" data-testid="changed-dims">
            {r.changed.map((x) => (
              <li key={x.dimension}>
                <strong>{DIMENSION_NAME[x.dimension]}</strong>
                <span className="chip chip-neutral">{RELATION_META[x.before as Relation]?.words ?? x.before}</span>
                <Icon name="arrow" size={13} />
                <span className="chip chip-neutral">{RELATION_META[x.after as Relation]?.words ?? x.after}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <h3 className="subhead">Why, dimension by dimension</h3>
      <ul className="lab-reasons">
        {r.reasons.map((d) => (
          <li key={d.dimension} data-dimension={d.dimension} data-relation={d.relation}>
            <div className="lab-reasons__head">
              <strong>{DIMENSION_NAME[d.dimension]}</strong>
              <RelationBadge relation={d.relation} />
            </div>
            <p className="muted">
              <Clamp text={d.reason} lines={3} />
            </p>
          </li>
        ))}
      </ul>

      <h3 className="subhead">Missing-evidence list for this use</h3>
      {requests.length === 0 ? (
        <EmptyState title="Nothing is missing for this use" icon="check">
          The evidence read covers every dimension the claim needs.
        </EmptyState>
      ) : (
        <ul className="missing-list" data-testid="lab-missing">
          {requests.map((q, i) => {
            const text = drafts.get(q.dimension) ?? q.request;
            return (
              <li key={`${q.dimension}-${i}`} className="missing-item">
                <div className="missing-item__head">
                  <strong>{DIMENSION_NAME[q.dimension as Dimension]}</strong>
                  <CopyButton text={text} what="request" label="Copy request" />
                </div>
                <p className="missing-item__req">
                  <Clamp text={q.request} lines={3} />
                </p>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function LabBody({ c }: { c: CaseDetail }) {
  const caseId = c.summary.id;
  const base = c.claim.use;
  const [form, setForm] = useState<Form>(() => initial(base));
  const [result, setResult] = useState<RecomputeResponse | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const announce = useAnnounce();
  const seq = useRef(0);
  const settingOptions = useMemo(() => [...new Set([...(base.settings ?? []), ...SETTING_SUGGESTIONS])], [base.settings]);

  const patch = useMemo(() => buildPatch(base, form), [base, form]);
  const patchKey = JSON.stringify([patch, form.asOf]);

  useEffect(() => {
    if ("error" in patch) {
      setFormError(patch.error);
      return;
    }
    setFormError(null);
    if (Object.keys(patch).length === 0 && !form.asOf) {
      seq.current += 1;
      setResult(null);
      setError(null);
      setBusy(false);
      return;
    }
    const mine = ++seq.current;
    const ctl = new AbortController();
    const t = window.setTimeout(() => {
      setBusy(true);
      api
        .recompute(caseId, { patch, ...(form.asOf ? { asOf: form.asOf } : {}) }, ctl.signal)
        .then((r) => {
          if (mine !== seq.current) return;
          setResult(r);
          setError(null);
          const a = LABEL_META[r.after.label].words;
          announce(r.labelChanged ? `Recomputed with no model call. The answer changed to ${a}.` : `Recomputed with no model call. The answer is unchanged: ${a}.`);
        })
        .catch((e: unknown) => {
          if ((e as Error).name === "AbortError" || mine !== seq.current) return;
          const err = e instanceof ApiError ? e : new ApiError("UNAVAILABLE", "The recompute failed.", 0);
          setError(err);
          announce(`Recompute failed. ${err.message}`);
        })
        .finally(() => {
          if (mine === seq.current) setBusy(false);
        });
    }, 280);
    return () => {
      window.clearTimeout(t);
      ctl.abort();
    };
    // patchKey captures patch and asOf; announce and caseId are stable.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patchKey, caseId]);

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const finding = headlineFinding(c);
  const changedAny = !("error" in patch) && (Object.keys(patch).length > 0 || !!form.asOf);

  return (
    <>
      <CaseHeader
        c={c}
        screen="Investigate: applicability lab"
        lead="Change the use you have in mind and watch the answer recompute. The rules run on the service with no model, so the same inputs always give the same answer."
      />
      <a className="jump-link" href="#lab-out">
        Jump to the result
      </a>
      <div className="lab-grid">
        <form className="lab-form" onSubmit={(e) => e.preventDefault()} aria-label="Intended use" noValidate>
          <h2 className="section__title">Your intended use</h2>
          <p className="muted">Pre-filled from the claim. Change any field; only what you change is recomputed.</p>

          <div className="field">
            <label htmlFor="lab-versions">Software version</label>
            <input id="lab-versions" type="text" value={form.versions} onChange={(e) => set("versions", e.target.value)} placeholder="for example 2.1.0" autoComplete="off" aria-describedby="lab-versions-h" />
            <p className="field__hint" id="lab-versions-h">
              Separate several with commas.
            </p>
          </div>

          <fieldset className="field field-group">
            <legend>Patient age (years)</legend>
            <div className="field-row">
              <div className="field">
                <label htmlFor="lab-age-min">Youngest</label>
                <input id="lab-age-min" type="number" inputMode="numeric" min={0} step={1} value={form.ageMin} onChange={(e) => set("ageMin", e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="lab-age-max">Oldest</label>
                <input id="lab-age-max" type="number" inputMode="numeric" min={0} step={1} value={form.ageMax} onChange={(e) => set("ageMax", e.target.value)} placeholder="no limit" />
              </div>
            </div>
          </fieldset>

          <fieldset className="field field-group">
            <legend>Care setting</legend>
            <div className="check-grid">
              {settingOptions.map((s) => (
                <label key={s} className="check">
                  <input
                    type="checkbox"
                    checked={form.settings.includes(s)}
                    onChange={(e) => set("settings", e.target.checked ? [...form.settings, s] : form.settings.filter((x) => x !== s))}
                  />
                  <span>{s.replace(/_/g, " ")}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <div className="field">
            <label htmlFor="lab-purpose">Purpose</label>
            <input id="lab-purpose" type="text" list="lab-purpose-list" value={form.purpose} onChange={(e) => set("purpose", e.target.value)} autoComplete="off" />
            <datalist id="lab-purpose-list">
              {PURPOSE_SUGGESTIONS.map((p) => (
                <option key={p} value={p} />
              ))}
            </datalist>
          </div>

          <div className="field">
            <label htmlFor="lab-date">Date the use begins</label>
            <input id="lab-date" type="date" value={form.from} onChange={(e) => set("from", e.target.value)} />
          </div>

          <div className="field">
            <label htmlFor="lab-threshold">Threshold or operating point</label>
            <input id="lab-threshold" type="text" value={form.operatingPoint} onChange={(e) => set("operatingPoint", e.target.value)} autoComplete="off" placeholder="as written in the study" />
          </div>

          <div className="field">
            <label htmlFor="lab-asof">Read the evidence as it stood on</label>
            <input id="lab-asof" type="date" value={form.asOf} onChange={(e) => set("asOf", e.target.value)} aria-describedby="lab-asof-h" />
            <p className="field__hint" id="lab-asof-h">
              Optional. Leave empty to use everything read so far.
            </p>
          </div>

          {formError && (
            <p className="form-error" role="alert">
              <Icon name="warn" size={14} /> {formError}
            </p>
          )}
          <div className="form__actions">
            <button type="button" className="btn btn-secondary" onClick={() => setForm(initial(base))} disabled={!changedAny && form.versions === initial(base).versions}>
              Reset to the claim
            </button>
          </div>
        </form>

        <section className="lab-out" id="lab-out" aria-labelledby="lab-out-h" tabIndex={-1}>
          <h2 className="section__title" id="lab-out-h">
            The answer for this use
          </h2>
          <div aria-live="polite" aria-atomic="false" className="lab-live">
            {error && <ErrorState error={error} />}
            {!error && !changedAny && finding && (
              <div className="lab-baseline" data-testid="lab-baseline">
                <LabelBadge label={finding.label} size="lg" showGloss />
                <p className="muted">This is the answer for the claim as written. Change a field on the left and it recomputes.</p>
                <Why c={c} f={finding} />
              </div>
            )}
            {!error && changedAny && !result && busy && <Loading label="Recomputing" rows={3} />}
            {!error && result && changedAny && (
              <div className={busy ? "is-busy" : undefined}>
                <Result r={result} c={c} />
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}

export function Lab() {
  const { id = "" } = useParams();
  useDocTitle(`Applicability lab, ${id}`);
  return <CaseGate id={id} screen="Investigate">{(c) => (c.findings.length === 0 ? (
    <>
      <CaseHeader c={c} screen="Investigate: applicability lab" />
      <Section title="No finding to recompute" id="lab-none">
        <EmptyState title="No finding yet" icon="file">The lab recomputes a finding. The compiler has not produced one for this claim.</EmptyState>
      </Section>
    </>
  ) : <LabBody c={c} key={c.summary.id} />)}</CaseGate>;
}
