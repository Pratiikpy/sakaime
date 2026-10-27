import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useResource } from "../api/hooks";
import { LabelBadge, RelationBadge, HealthBadge, LinkStateBadge } from "../components/badges";
import { EmptyState, ErrorState, Loading, Notice } from "../components/feedback";
import { PageHeader, Section, useDocTitle } from "../components/ui";
import { LABEL_META, LINK_STATE_META, LINK_TYPE_NAME, HEALTH_META, RELATION_META } from "../lib/vocab";
import type { Label, LinkState, Relation, SourceHealth } from "../api/types";
import type { ResultsFile } from "../api/client";

function Results({ file }: { file: ResultsFile }) {
  const groups = [...new Set(file.rows.map((r) => r.group ?? "Results"))];
  return (
    <div data-testid="results">
      {file.note && <p className="muted">{file.note}</p>}
      {groups.map((g) => (
        <div key={g} className="results-group">
          <h3 className="subhead">{g}</h3>
          <div className="table-wrap">
            <table className="data-table responsive">
              <caption className="sr-only">{g}</caption>
              <thead>
                <tr>
                  <th scope="col">Measure</th>
                  <th scope="col">Result</th>
                  <th scope="col">Out of</th>
                  <th scope="col">Interval</th>
                  <th scope="col">Limits and source</th>
                </tr>
              </thead>
              <tbody>
                {file.rows
                  .filter((r) => (r.group ?? "Results") === g)
                  .map((r) => (
                    <tr key={r.id} data-status={r.status} data-row={r.id}>
                      <th scope="row" data-label="Measure">
                        {r.measure}
                      </th>
                      <td data-label="Result" className={r.status === "measured" ? "num" : "tbm"}>
                        {r.status === "measured" ? r.value : "To be measured"}
                      </td>
                      <td data-label="Out of">{r.denominator ?? ""}</td>
                      <td data-label="Interval">{r.interval ?? ""}</td>
                      <td data-label="Limits and source">
                        {r.limits}
                        {r.source && <div className="cell-sub mono">{r.source}</div>}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </div>
  );
}

export function About() {
  useDocTitle("About and limits");
  const results = useResource("results", (s) => api.results(s));
  const sources = useResource("sources", (s) => api.sources(s));

  return (
    <>
      <PageHeader
        eyebrow="Methods"
        title="About and limits"
        lead="How a finding is made, what has been measured, and where the evidence for this product stops."
      />

      <Section id="method" title="How a finding is made">
        <ol className="method-steps">
          <li>
            <h3>Read the sources</h3>
            <p>
              Regulator records, trial registries, papers, the vendor's packet and the hospital's own requirements are fetched or replayed from recordings. Every record keeps a hash, a retrieval date and a licence. A record is never overwritten: a newer fetch is a new record.
            </p>
          </li>
          <li>
            <h3>Link records, and say how sure</h3>
            <p>
              Two records are tied together only by what they share. A shared FDA submission number does not mean the same software release, so link kinds are kept apart. When the evidence does not separate two readings, the link is left ambiguous.
            </p>
          </li>
          <li>
            <h3>Quote, then check the quote twice</h3>
            <p>
              Every number comes with the passage it was read from. Two separate checks run: the passage exists in the stored record, and the passage actually says what is claimed. A quote that exists but says something else fails.
            </p>
          </li>
          <li>
            <h3>Compare the claim with the evidence, by rule</h3>
            <p>
              A fixed set of rules compares the intended use with what the evidence establishes, one dimension at a time. A model never chooses a label. A study cannot widen what a regulator authorized, and a regulator's record cannot overwrite a measured result.
            </p>
          </li>
          <li>
            <h3>Leave judgement to people</h3>
            <p>
              Where a call needs clinical or domain knowledge, the finding says so and stops. Unknown is never read as false and never as covered.
            </p>
          </li>
        </ol>
      </Section>

      <Section id="sponsors" title="The three sponsor technologies, and what each changes">
        <ul className="plain-list" data-testid="sponsor-tech">
          <li>
            <strong>Zetaris</strong> joins the hospital's database, the vendor packet files and the registry snapshots in one statement. Stopping it loses the sources reached through
            it and lowers the answers that needed them (the "federation engine stops" drill). It also hides columns from a reviewer who is not assigned to a case. See{" "}
            <Link to="/cases">a case's evidence matrix</Link> and <Link to="/sources">the source console</Link>.
          </li>
          <li>
            <strong>Meterless</strong> supplies four engines. The World Model reconstructs what was known on a date and marks exactly the findings that depended on a changed fact
            as out of date (the timeline and the "registry record changes" drill). Scout Intent screens requests and document text for instructions and signs what an export may
            contain (the Guard screen). H-MEM keeps confirmed links, accepted source mappings and precedents between runs. Markovian reads long documents.
          </li>
          <li>
            <strong>NVIDIA Nemotron</strong> proposes: a plan, a column mapping for a new source, a second reading of an ambiguous passage, an objection and the report prose. A
            proposal becomes a fact only after a deterministic check or a reviewer accepts it, so with the model off the labels do not move (the "model route fails" drill). The
            investigation screen shows which model answered each step and whether the reply was recorded.
          </li>
        </ul>
        <p className="muted">
          What removing the engines changes is measured in <code className="mono">tests/engines/ABLATIONS.md</code> on constructed sessions, and the arms without the compiler or
          the identity layer are in <code className="mono">evals/RESULTS.md</code>. In a sample run the Zetaris and Nemotron replies are recordings of the real services, labelled as such; the Meterless engines run locally from the vendored reference code, not as recordings.
        </p>
      </Section>

      <Section id="words" title="The words used on every screen">
        <h3 className="subhead">The five answers</h3>
        <ul className="legend-list">
          {(Object.keys(LABEL_META) as Label[]).map((l) => (
            <li key={l}>
              <LabelBadge label={l} showGloss />
            </li>
          ))}
        </ul>
        <h3 className="subhead">How one dimension compares</h3>
        <dl className="legend">
          {(Object.keys(RELATION_META) as Relation[]).map((r) => (
            <div key={r}>
              <dt>
                <RelationBadge relation={r} />
              </dt>
              <dd>{RELATION_META[r].gloss}</dd>
            </div>
          ))}
        </dl>
        <h3 className="subhead">How a source is doing</h3>
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
        <h3 className="subhead">How records are linked</h3>
        <dl className="legend">
          {(Object.keys(LINK_STATE_META) as LinkState[]).map((s) => (
            <div key={s}>
              <dt>
                <LinkStateBadge state={s} />
              </dt>
              <dd>{LINK_STATE_META[s].gloss}</dd>
            </div>
          ))}
        </dl>
        <ul className="plain-list">
          {Object.values(LINK_TYPE_NAME).map((t) => (
            <li key={t.words}>
              <strong>{t.words}.</strong> {t.gloss}
            </li>
          ))}
        </ul>
      </Section>

      <Section id="measured" title="What has been measured">
        {results.status === "loading" && !results.data && <Loading label="Loading results" rows={4} />}
        {results.status === "error" && !results.data && <ErrorState error={results.error} onRetry={results.reload} title="The results file could not be read" />}
        {results.data && (results.data.rows.length === 0 ? <EmptyState title="No results published" icon="file">No result files have been published yet. Nothing is claimed.</EmptyState> : <Results file={results.data} />)}
        <Notice tone="warn" title="Read these with their limits">
          Every label in the evaluation sets was assigned by the builder, not by independent reviewers, so these are builder-adjudicated results. A rate of zero in a sample is not a rate of zero in the world; the interval shows what the sample cannot rule out. Rows marked "to be measured" have no result yet and no figure is shown for them.
        </Notice>
      </Section>

      <Section id="limits" title="Known limits">
        <ul className="limits">
          <li>Sakaime describes how far cited evidence reaches. It does not certify a product, rule on regulatory standing, or replace clinical judgement.</li>
          <li>The vendor claims, the hospital requirements and the review database are constructed for the demonstration and labelled so. No contradiction shown is a finding about a real vendor.</li>
          <li>Three devices are worked as cases (EyeArt, Lunit INSIGHT CXR Triage and Transpara). For EyeArt the chain from the regulator's summary to the trial to the paper is established at identifier level; that the paper's software build equals the authorized build is read from the paper's own text and is not independently checked.</li>
          <li>The FDA list of AI-enabled devices is a pinned snapshot. FDA blocks scripted download, so the live list is not fetched by default and is shown as out of date.</li>
          <li>In a sample run, source responses and model replies are recorded. They are real responses from a stated date, shown with a "recorded" badge, not live calls.</li>
          <li>Whether a local model can run the vendor-confidential lane usefully on small hardware has not been verified.</li>
          <li>No patient data is read, stored or sent. The guard sets aside any patient identifier it finds.</li>
          <li>Accessibility: automated checks run in the test suite on every screen. No review with a screen-reader user has been done.</li>
        </ul>
      </Section>

      <Section id="sources" title="Sources and licences">
        {sources.status === "loading" && !sources.data && <Loading label="Loading sources" rows={3} />}
        {sources.status === "error" && !sources.data && <ErrorState error={sources.error} onRetry={sources.reload} />}
        {sources.data && (
          <ul className="plain-list" data-testid="licences">
            {sources.data.map((s) => (
              <li key={s.source.id}>
                <strong>{s.source.descriptor}</strong>: <span>{s.source.license}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="muted">
          Fonts: Outfit and JetBrains Mono, SIL Open Font License 1.1. The source code is Apache-2.0.
        </p>
      </Section>
    </>
  );
}
