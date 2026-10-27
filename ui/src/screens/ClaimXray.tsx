import { useState } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import type { AnchorView, CaseDetail, DimensionView, Finding } from "../api/types";
import { LabelBadge, LinkStateBadge, ProvenanceBadge, RelationBadge } from "../components/badges";
import { CaseGate, CaseHeader } from "../components/CaseGate";
import { Counterexample, FindingTypeTags } from "../components/FindingBits";
import { EmptyState, Notice } from "../components/feedback";
import { Icon } from "../components/Icon";
import { Clamp, Disclosure, Mono, Section, useDocTitle } from "../components/ui";
import { Why } from "../components/Why";
import { ASSERTION_NAME, CANDIDATE_CLASS_NAME, DIMENSION_NAME, DIMENSION_QUESTION, LABEL_META, LINK_TYPE_NAME, RELATION_META } from "../lib/vocab";
import { claimName, claimSentence, dimensionsOf, headlineFinding, rankAnchors, snippet } from "../lib/explain";
import { formatDate, formatDateTime, plural, sentence, shortHash, sideText } from "../lib/format";

function Anchor({ a }: { a: AnchorView }) {
  const where = a.page !== undefined ? `page ${a.page}` : a.jsonPath ? `field ${a.jsonPath}` : "location not stated";
  return (
    <figure className="anchor" data-anchor={a.id}>
      <figcaption className="anchor__meta">
        <span className="anchor__source">{a.sourceLabel}</span>
        <span className="anchor__chip">{ASSERTION_NAME[a.assertionType] ?? a.assertionType}</span>
        <span className="anchor__chip">{where}</span>
        <span className="anchor__chip">Retrieved {formatDate(a.retrievedAt)}</span>
        {a.sourcePublishedAt && <span className="anchor__chip">Published {formatDate(a.sourcePublishedAt)}</span>}
      </figcaption>
      <blockquote className="anchor__quote">
        <Clamp text={a.text} lines={8} tag="mark" />
      </blockquote>
      <p className="anchor__rules">
        {a.ruleIds.length > 0 ? (
          <>
            Used by rule{a.ruleIds.length > 1 ? "s" : ""}: {a.ruleIds.map((r) => (
              <Mono key={r}>{r}</Mono>
            ))}
          </>
        ) : (
          "Not used by a rule on this dimension."
        )}{" "}
        <span className="muted">
          Record <code className="mono">{a.recordId}</code>, text hash <code className="mono" title={a.textHash}>{shortHash(a.textHash, 10)}</code>
        </span>
      </p>
    </figure>
  );
}

const ANCHORS_FIRST = 4;

/** The passages a rule used come first. A long list shows its first few and opens on request, so 40 passages never bury the page. */
function AnchorList({ anchors }: { anchors: AnchorView[] }) {
  const [all, setAll] = useState(false);
  const ranked = rankAnchors(anchors);
  const shown = all ? ranked : ranked.slice(0, ANCHORS_FIRST);
  return (
    <>
      <div className="anchor-list">
        {shown.map((a) => (
          <Anchor key={a.id} a={a} />
        ))}
      </div>
      {ranked.length > ANCHORS_FIRST && (
        <button type="button" className="btn btn-secondary btn-sm anchor-more" aria-expanded={all} onClick={() => setAll((v) => !v)}>
          {all ? `Show only the first ${ANCHORS_FIRST}` : `Show the other ${ranked.length - ANCHORS_FIRST} passages`}
        </button>
      )}
    </>
  );
}

function DimensionRow({ d, anchors }: { d: DimensionView; anchors: AnchorView[] }) {
  const rel = RELATION_META[d.relation];
  return (
    <li className={`dim-row dim-${rel.tone}`} data-dimension={d.dimension} data-relation={d.relation}>
      <div className="dim-row__head">
        <div>
          <h3 className="dim-row__name">{DIMENSION_NAME[d.dimension]}</h3>
          <p className="dim-row__q">{DIMENSION_QUESTION[d.dimension]}</p>
        </div>
        <div className="dim-row__rel">
          <RelationBadge relation={d.relation} />
          <p className="dim-row__gloss">{rel.gloss}</p>
        </div>
      </div>
      <dl className="sidebyside">
        <div>
          <dt>The claim says</dt>
          <dd data-side="claimed">
            <Clamp text={sideText(d.claimed)} />
          </dd>
        </div>
        <div>
          <dt>The evidence establishes</dt>
          <dd data-side="established">
            <Clamp text={sideText(d.established)} />
          </dd>
        </div>
      </dl>
      <p className="dim-row__reason">
        <Icon name="info" size={14} />
        <span>
          <Clamp text={sentence(d.reason)} lines={3} />
        </span>
      </p>
      {anchors.length > 0 ? (
        <Disclosure summary={`Show the exact evidence (${plural(anchors.length, "passage")})`} className="dim-anchors">
          <AnchorList anchors={anchors} />
        </Disclosure>
      ) : (
        <p className="muted dim-row__noanchor">No passage bears on this dimension. That is why it cannot be settled.</p>
      )}
    </li>
  );
}

function Waterfall({ link }: { link: CaseDetail["links"][number] }) {
  const steps = link.waterfall ?? [];
  if (steps.length === 0) return null;
  const max = Math.max(1, ...steps.map((s) => Math.abs(s.weight)));
  let running = 0;
  return (
    <Disclosure summary="Show how the match weight adds up" className="disclosure-small">
      <table className="data-table waterfall" data-testid="waterfall">
        <caption className="sr-only">Contribution of each field to the match weight</caption>
        <thead>
          <tr>
            <th scope="col">Field</th>
            <th scope="col">How well it agrees</th>
            <th scope="col">Weight</th>
            <th scope="col">Running total</th>
          </tr>
        </thead>
        <tbody>
          {steps.map((s, i) => {
            running += s.weight;
            const pct = (Math.abs(s.weight) / max) * 50;
            return (
              <tr key={`${s.field}-${i}`}>
                <th scope="row">
                  <code className="mono">{s.field}</code>
                </th>
                <td>{s.level}</td>
                <td className="wf-cell">
                  <span className="wf-track" aria-hidden="true">
                    <span className={`wf-bar ${s.weight >= 0 ? "wf-pos" : "wf-neg"}`} style={s.weight >= 0 ? { left: "50%", width: `${pct}%` } : { right: "50%", width: `${pct}%` }} />
                  </span>
                  <span className="mono">{s.weight > 0 ? "+" : ""}{s.weight.toFixed(2)}</span>
                  <span className="sr-only">{s.weight >= 0 ? " toward a match" : " against a match"}</span>
                </td>
                <td className="mono">{running.toFixed(2)}</td>
              </tr>
            );
          })}
        </tbody>
        {link.score !== undefined && (
          <tfoot>
            <tr>
              <th scope="row" colSpan={3}>
                Total weight used for the decision
              </th>
              <td className="mono">{link.score.toFixed(2)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </Disclosure>
  );
}

function Links({ c }: { c: CaseDetail }) {
  if (c.links.length === 0) {
    return (
      <EmptyState title="No links between records" icon="link">
        No record in one source has been tied to a record in another. Evidence is not borrowed across sources without a link.
      </EmptyState>
    );
  }
  const types = [...new Set(c.links.map((l) => l.type))];
  return (
    <div className="link-groups" data-testid="links">
      <p className="muted">
        Links are kept apart by what they establish. Sharing a submission number does not mean two records describe the same software release, so each kind is shown on its own.
      </p>
      {types.map((t) => {
        const ls = c.links.filter((l) => l.type === t);
        const meta = LINK_TYPE_NAME[t];
        return (
          <section key={t} className="link-group" aria-labelledby={`lt-${t}`} data-link-type={t}>
            <h3 id={`lt-${t}`} className="link-group__title">
              {meta.words}
            </h3>
            <p className="link-group__gloss">{meta.gloss}</p>
            <ul className="link-list">
              {ls.map((l) => (
                <li key={l.id} className={`link-item link-${l.state.toLowerCase()}`} data-link-state={l.state}>
                  <div className="link-item__ends">
                    <span className="link-end">{l.fromLabel}</span>
                    <Icon name="arrow" size={14} />
                    <span className="link-end">{l.toLabel}</span>
                  </div>
                  <div className="badge-row">
                    <LinkStateBadge state={l.state} />
                    {l.candidateClass && <span className="chip chip-neutral">{CANDIDATE_CLASS_NAME[l.candidateClass] ?? l.candidateClass}</span>}
                    {l.score !== undefined && <span className="mono muted">weight {l.score.toFixed(2)}</span>}
                  </div>
                  {l.basis.length > 0 && (
                    <p className="link-item__basis">
                      <strong>Why:</strong> {l.basis.join("; ")}
                    </p>
                  )}
                  {l.flags.length > 0 && (
                    <ul className="flag-list">
                      {l.flags.map((fl) => (
                        <li key={fl}>
                          <Icon name="warn" size={13} /> {fl}
                        </li>
                      ))}
                    </ul>
                  )}
                  {l.decidedBy && (
                    <p className="muted">
                      Decided by {l.decidedBy}
                      {l.decidedAt ? ` on ${formatDateTime(l.decidedAt)}` : ""}
                    </p>
                  )}
                  <Waterfall link={l} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

function Contrary({ f }: { f: Finding }) {
  const lost = f.degraded.length > 0;
  return (
    <>
      {f.contraryDispositions.length === 0 && f.expertReviewFlags.length === 0 && (
        lost ? (
          <Notice tone="warn" title="Cannot say that no contrary evidence exists">
            Some sources were lost while computing this finding, so an empty list here would not mean there is nothing against the claim. See "Sources lost" below.
          </Notice>
        ) : (
          <EmptyState title="No contrary evidence in the sources read" icon="check">
            Every source this claim depends on answered, and none holds material that limits or disagrees with it.
          </EmptyState>
        )
      )}
      {f.contraryDispositions.length > 0 && (
        <ul className="plain-list contrary" data-testid="contrary">
          {f.contraryDispositions.map((d) => (
            <li key={d.evidenceId} className="contrary__item">
              <strong className="mono">{d.evidenceId}</strong>
              <span className={`chip chip-${d.relevance === "relevant" ? "bad" : "neutral"}`}>
                {d.relevance === "relevant" ? "Relevant to this use" : d.relevance === "weak" ? "Weak evidence" : "About a different use"}
              </span>
              <span className="chip chip-neutral">{d.adequate === undefined ? "Adequacy not decided" : d.adequate ? "Adequate to contradict" : "Not adequate to contradict"}</span>
              {d.note && <p>{d.note}</p>}
            </li>
          ))}
        </ul>
      )}
      {f.expertReviewFlags.length > 0 && (
        <>
          <h3 className="subhead">Left for a reviewer</h3>
          <ul className="plain-list" data-testid="expert-flags">
            {f.expertReviewFlags.map((x, i) => (
              <li key={i}>
                <Mono>{x.ruleId}</Mono> {x.dimension ? <strong>{DIMENSION_NAME[x.dimension]}: </strong> : null}
                {x.reason}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** A case holds the reviewer's own question and each vendor claim; this moves between them without going back to the case. */
function FindingSwitch({ c, current }: { c: CaseDetail; current: string }) {
  const head = headlineFinding(c);
  const ordered = [...c.findings].sort((x, y) => (x === head ? -1 : y === head ? 1 : 0));
  const now = c.findings.find((x) => x.id === current);
  return (
    <nav className="finding-switch" aria-label="Which claim to read">
      <details>
        <summary>
          <Icon name="chevron" size={14} className="disclosure__chev" />
          <span className="finding-switch__label">Claim</span>
          <strong>{now ? claimName(c, now) : "Choose a claim"}</strong>
          <span className="muted">Switch to another of {c.findings.length}</span>
        </summary>
        <ul>
          {ordered.map((x) => {
            const says = claimSentence(c, x);
            return (
              <li key={x.id}>
                <Link
                  to={`/cases/${encodeURIComponent(c.summary.id)}/claims/${encodeURIComponent(x.id)}`}
                  aria-current={x.id === current ? "page" : undefined}
                  className={x.id === current ? "is-active" : undefined}
                >
                  <span className="finding-switch__name">{claimName(c, x)}</span>
                  <span className="finding-switch__word">{LABEL_META[x.label].words}</span>
                  {says && <span className="finding-switch__says">{snippet(says, 120)}</span>}
                </Link>
              </li>
            );
          })}
        </ul>
      </details>
    </nav>
  );
}

function Body({ c, findingId }: { c: CaseDetail; findingId: string }) {
  const f = c.findings.find((x) => x.id === findingId);
  if (!f) {
    return (
      <>
        <CaseHeader c={c} screen="Investigate: claim X-ray" />
        <EmptyState title="That finding is not in this case" icon="file" action={<Link className="btn btn-secondary" to={`/cases/${encodeURIComponent(c.summary.id)}`}>Back to the case</Link>}>
          The finding id may be from an earlier run. Findings are never rewritten: a newer finding replaces an older one and points back to it.
        </EmptyState>
      </>
    );
  }
  const dims = dimensionsOf(c, f);
  const short = dims.filter((d) => d.relation !== "CONTAINED");
  const covered = dims.filter((d) => d.relation === "CONTAINED");
  const byId = new Map(c.anchors.map((a) => [a.id, a]));
  const meta = LABEL_META[f.label];
  return (
    <>
      <CaseHeader
        c={c}
        screen="Investigate: claim X-ray"
        lead={
          <blockquote className="claim-quote" data-testid="claim-text">
            <p>{claimSentence(c, f) ?? c.claimText}</p>
          </blockquote>
        }
      />

      {c.findings.length > 1 && <FindingSwitch c={c} current={f.id} />}

      <Section id="answer" title="The answer">
        <div className="answer-card" data-label={f.label}>
          <LabelBadge label={f.label} size="lg" />
          <p className="answer-card__gloss">{meta.gloss}</p>
          <FindingTypeTags c={c} finding={f} />
          <Why c={c} f={f} maxDims={0} maxAsks={0} />
          <p className="answer-card__tech mono">
            {f.label} · rules {f.ruleVersion.split("+")[0]} · finding {shortHash(f.id, 12)}
            {f.computedAt ? ` · computed ${formatDateTime(f.computedAt)}` : ""}
          </p>
        </div>
        {f.supportedScope && Object.keys(f.supportedScope).length > 0 && (
          <div className="narrower" data-testid="supported-scope">
            <h3 className="subhead">The narrower use that is supported</h3>
            <dl className="kv">
              {Object.entries(f.supportedScope).map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{typeof v === "string" ? v : JSON.stringify(v)}</dd>
                </div>
              ))}
            </dl>
          </div>
        )}
        {f.supersedes && (
          <Notice tone="info" title="This finding replaces an earlier one">
            Earlier finding <Mono>{shortHash(f.supersedes, 12)}</Mono> is kept unchanged. Reason: {f.supersedesReason ?? "not stated"}.
          </Notice>
        )}
      </Section>

      <Section id="dimensions" title="Dimension by dimension" aside={<span className="muted">{plural(dims.length, "dimension")}</span>}>
        <details className="legend-details">
          <summary>What the four words mean</summary>
          <dl className="legend">
            {(Object.keys(RELATION_META) as (keyof typeof RELATION_META)[]).map((r) => (
              <div key={r}>
                <dt>
                  <RelationBadge relation={r} />
                </dt>
                <dd>{RELATION_META[r].gloss}</dd>
              </div>
            ))}
          </dl>
        </details>
        <div data-testid="dimensions">
          {short.length > 0 && (
            <>
              <h3 className="subhead">Where the evidence does not cover the use ({short.length})</h3>
              <ol className="dim-list">
                {short.map((d) => (
                  <DimensionRow key={d.dimension} d={d} anchors={d.anchorIds.map((id) => byId.get(id)).filter((a): a is AnchorView => !!a)} />
                ))}
              </ol>
            </>
          )}
          {covered.length > 0 && (
            <>
              <h3 className="subhead">Where it does ({covered.length})</h3>
              <ol className="dim-list">
                {covered.map((d) => (
                  <DimensionRow key={d.dimension} d={d} anchors={d.anchorIds.map((id) => byId.get(id)).filter((a): a is AnchorView => !!a)} />
                ))}
              </ol>
            </>
          )}
        </div>
      </Section>

      <Section id="counterexample" title="The smallest mismatch">
        <p className="muted">The fewest dimensions that, taken together, stop the claim from being covered.</p>
        <Counterexample finding={f} />
      </Section>

      <Section id="contrary" title="Contrary evidence">
        <Contrary f={f} />
      </Section>

      {f.degraded.length > 0 && (
        <Section id="degraded" title="Sources lost">
          <Notice tone="warn" title="These sources did not answer, so they were not read">
            <ul className="plain-list" data-testid="degraded">
              {f.degraded.map((d, i) => (
                <li key={i}>
                  <strong>{ASSERTION_NAME[d.sourceType] ?? d.sourceType}</strong> ({d.dependency === "required" ? "required" : d.dependency}): {d.reason}
                </li>
              ))}
            </ul>
          </Notice>
        </Section>
      )}

      <Section id="links" title="How the records are linked">
        <Links c={c} />
      </Section>

      {f.requiredEvidence.length > 0 && (
        <Section id="required" title="What would settle it">
          <ul className="plain-list" data-testid="required-evidence">
            {f.requiredEvidence.map((r, i) => (
              <li key={i}>
                <strong>{DIMENSION_NAME[r.dimension]}:</strong> {r.request}
              </li>
            ))}
          </ul>
          <p>
            <Link to={`/cases/${encodeURIComponent(c.summary.id)}`}>Copy a ready-to-send request on the review desk</Link>
          </p>
        </Section>
      )}

      <p className="constructed-note">
        {c.summary.claimConstructed && <ProvenanceBadge kind="constructed" text="Constructed claim" />} The claim is written for this test. The authorization and study records are real and were retrieved on the dates shown with each passage.
      </p>
    </>
  );
}

export function ClaimXray() {
  const { id = "", findingId = "" } = useParams();
  useDocTitle(`Claim X-ray, ${id}`);
  return (
    <CaseGate id={id} screen="Investigate">
      {(c) => <Body c={c} findingId={findingId} />}
    </CaseGate>
  );
}

/** /cases/:id/claims goes to the first finding. */
export function ClaimXrayIndex() {
  const { id = "" } = useParams();
  return (
    <CaseGate id={id} screen="Investigate">
      {(c) => {
        const first = headlineFinding(c);
        if (!first) {
          return (
            <>
              <CaseHeader c={c} screen="Investigate: claim X-ray" />
              <EmptyState title="No finding yet" icon="file">The compiler has not produced a finding for this claim.</EmptyState>
            </>
          );
        }
        return <Navigate to={`/cases/${encodeURIComponent(id)}/claims/${encodeURIComponent(first.id)}`} replace />;
      }}
    </CaseGate>
  );
}
