import { Link } from "react-router-dom";
import { api } from "../api/client";
import { useResource } from "../api/hooks";
import type { CaseDetail, CaseSummary } from "../api/types";
import { LabelBadge, ProvenanceBadge } from "../components/badges";
import { Icon } from "../components/Icon";
import { ErrorState, Loading } from "../components/feedback";
import { SourceTrail } from "../components/SourceTrail";
import { Why } from "../components/Why";
import { Redaction, useDocTitle } from "../components/ui";
import { headlineFinding } from "../lib/explain";
import { DIMENSION_NAME, LABEL_META } from "../lib/vocab";
import { formatDate, plural } from "../lib/format";

function featured(cases: CaseSummary[]): CaseSummary | undefined {
  // A case where the evidence stops short shows the idea better than a clean one, so prefer it.
  return cases.find((c) => c.headlineLabel && c.headlineLabel !== "SUPPORTED_FOR_SCOPE") ?? cases[0];
}

function LiveStrip() {
  const cases = useResource("cases", (s) => api.cases(s));
  const pick = cases.data ? featured(cases.data) : undefined;
  const detail = useResource<CaseDetail>(pick ? `case:${pick.id}` : null, (s) => api.caseDetail(pick!.id, s));

  if (cases.status === "error") return <ErrorState error={cases.error} onRetry={cases.reload} />;
  if (cases.status === "loading" && !cases.data) return <Loading label="Loading the live case" rows={3} />;
  if (!pick) {
    return (
      <div className="strip strip-empty">
        <p>No case is loaded yet. Cases appear here once the service has one to show.</p>
      </div>
    );
  }
  const finding = detail.data ? headlineFinding(detail.data) : undefined;
  const dims = finding ? (detail.data?.dimensions[finding.id] ?? []) : [];
  const open = dims.filter((d) => d.relation !== "CONTAINED");
  return (
    <div className="strip" data-testid="live-strip">
      <div className="strip__head">
        <p className="eyebrow">From the case file</p>
        <div className="badge-row">
          {pick.headlineLabel && <LabelBadge label={pick.headlineLabel} />}
          {pick.claimConstructed && <ProvenanceBadge kind="constructed" text="Constructed claim" />}
        </div>
      </div>
      <h3 className="strip__title">{pick.title}</h3>
      {detail.data && (
        <blockquote className="strip__quote">
          <p>{detail.data.claimText}</p>
        </blockquote>
      )}
      <dl className="strip__facts">
        <div>
          <dt>Product</dt>
          <dd>{pick.productLabel}</dd>
        </div>
        <div>
          <dt>Open questions</dt>
          <dd>{pick.openQuestions}</dd>
        </div>
        <div>
          <dt>Parts of the use not covered</dt>
          <dd>{finding ? (open.length > 0 ? open.map((d) => DIMENSION_NAME[d.dimension].toLowerCase()).join(", ") : "none") : "loading"}</dd>
        </div>
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(pick.updatedAt)}</dd>
        </div>
      </dl>
      {detail.data && finding && (
        <div className="strip__why">
          <h4 className="strip__why-title">Why this answer, and what would change it</h4>
          <Why c={detail.data} f={finding} maxDims={3} maxAsks={2} heading={false} />
        </div>
      )}
      {detail.data && (
        <div className="strip__why">
          <h4 className="strip__why-title">Where it came from</h4>
          <SourceTrail c={detail.data} compact />
        </div>
      )}
      <div className="strip__actions">
        {finding ? (
          <Link className="btn btn-primary" to={`/cases/${encodeURIComponent(pick.id)}/claims/${encodeURIComponent(finding.id)}`}>
            Open the claim X-ray <Icon name="arrow" size={16} />
          </Link>
        ) : (
          <Link className="btn btn-primary" to={`/cases/${encodeURIComponent(pick.id)}`}>
            Open the case <Icon name="arrow" size={16} />
          </Link>
        )}
        <Link className="btn btn-secondary" to="/cases">
          All {plural(cases.data?.length ?? 0, "case")}
        </Link>
      </div>
    </div>
  );
}

const EXPERIENCES = [
  {
    verb: "Discover",
    who: "Analysts and technical reviewers",
    text: "See every source the system can reach, whether it is answering, and what it returned. Add a new source and watch it get mapped, checked and registered, or declined with the reason.",
    links: [
      { to: "/sources", label: "Source console" },
    ],
    icon: "database" as const,
  },
  {
    verb: "Investigate",
    who: "The evidence workstation",
    text: "Open a claim next to the exact page and quote that bears on it. Change the version, the patients, the setting or the date and watch the answer recompute. No model is called.",
    links: [
      { to: "/cases", label: "Pick a case" },
    ],
    icon: "file" as const,
  },
  {
    verb: "Decide",
    who: "The committee's output",
    text: "Work through what is unresolved, copy a specific request to send to the vendor, record accept, narrow, request or escalate, and export a signed dossier that anyone can check.",
    links: [
      { to: "/cases", label: "Review desk" },
    ],
    icon: "shield" as const,
  },
];

export function Landing() {
  useDocTitle("Know where the evidence stops");
  return (
    <>
      <section className="hero" aria-labelledby="page-title">
        <p className="eyebrow">Applicability-aware evidence intelligence</p>
        <h1 className="hero__title" id="page-title" tabIndex={-1}>
          A claim can be true and still be wrong for you.
        </h1>
        <div className="hero__line" aria-hidden="true">
          <Redaction width={220} />
          <span className="hero__gap" />
          <span className="hero__rest" />
        </div>
        <p className="hero__lead">
          Sakaime checks whether the evidence behind a vendor's claim covers the exact use you have in mind: the product version, the patients, the care
          setting, the purpose and the date. Where the evidence stops, it says so, and it shows the page.
        </p>
        <p className="hero__lead">
          The evidence for one claim sits in places that share no identifier: the regulator's decision summary, the trial registry, the journal paper, the vendor's
          packet and the hospital's own requirements. Sakaime finds and joins them, says how sure each join is, and keeps the source of every fact.
        </p>
        <p className="hero__tag">Know where the evidence stops.</p>
      </section>

      <section className="block" aria-labelledby="strip-h">
        <h2 id="strip-h" className="block__title">
          A worked case
        </h2>
        <LiveStrip />
      </section>

      <section className="block" aria-labelledby="who-h">
        <h2 id="who-h" className="block__title">
          Who it is for
        </h2>
        <div className="two-col">
          <p>
            A hospital reviewer is asked to decide whether an AI product is supported for use in their own setting. The vendor packet quotes a study. The
            regulator's record says something narrower. The trial registry names a different release. Sakaime reads all of them against the use the reviewer
            actually has in mind and shows the gap.
          </p>
          <p>
            It is built for clinical informatics, procurement and AI-governance reviewers who must be able to defend what they relied on, and for the analysts who keep the
            sources working.
          </p>
        </div>
      </section>

      <section className="block" aria-labelledby="exp-h">
        <h2 id="exp-h" className="block__title">
          Three ways in
        </h2>
        <ul className="exp-grid">
          {EXPERIENCES.map((e) => (
            <li key={e.verb} className="exp-card">
              <Icon name={e.icon} size={22} />
              <h3>{e.verb}</h3>
              <p className="exp-card__who">{e.who}</p>
              <p>{e.text}</p>
              <ul className="exp-card__links">
                {e.links.map((l) => (
                  <li key={l.to}>
                    <Link to={l.to}>
                      {l.label} <Icon name="arrow" size={14} />
                    </Link>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      </section>

      <section className="block" aria-labelledby="five-h">
        <h2 id="five-h" className="block__title">
          Five answers, and nothing more
        </h2>
        <p className="block__lead">Every finding carries exactly one of these. There is no score and no pass mark.</p>
        <ul className="label-list">
          {(Object.keys(LABEL_META) as (keyof typeof LABEL_META)[]).map((l) => (
            <li key={l}>
              <LabelBadge label={l} showGloss />
            </li>
          ))}
        </ul>
      </section>

      <section className="block block-limits" aria-labelledby="limits-h">
        <h2 id="limits-h" className="block__title">
          What Sakaime does not say
        </h2>
        <ul className="limits">
          <li>It does not certify a product, rule on regulatory standing, or replace clinical judgement.</li>
          <li>Unknown is never read as false and never read as covered. A missing source lowers the answer; it never raises it.</li>
          <li>The vendor claims in the demonstration are constructed and labelled so. None is a statement about a real vendor.</li>
          <li>The regulator, registry and literature records are real, recorded on a stated date, and shown with the page they came from.</li>
          <li>No patient data enters the system.</li>
        </ul>
        <p>
          <Link to="/about">Read the methods, the measured results and the known limits</Link>.
        </p>
      </section>
    </>
  );
}
