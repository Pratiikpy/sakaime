import { Link } from "react-router-dom";
import type { CaseDetail, Finding } from "../api/types";
import { findingTypes } from "../lib/format";
import { DIMENSION_NAME, FINDING_TYPES } from "../lib/vocab";
import { Icon } from "./Icon";
import { RelationBadge } from "./badges";

export function FindingTypeTags({ c, finding }: { c: CaseDetail; finding: Finding }) {
  const types = findingTypes(finding, c.dimensions[finding.id] ?? [], c.anchors);
  return (
    <ul className="type-tags" aria-label="What kind of finding this is">
      {types.map((t) => (
        <li key={t} className="type-tag" title={FINDING_TYPES[t].gloss} data-finding-type={t}>
          {FINDING_TYPES[t].words}
        </li>
      ))}
    </ul>
  );
}

/** The smallest set of disagreeing dimensions, claimed and established side by side. */
export function Counterexample({ finding }: { finding: Finding }) {
  if (finding.mismatches.length === 0) {
    return <p className="muted">No mismatch: every dimension the claim needs is covered.</p>;
  }
  return (
    <ul className="counterexample" data-testid="counterexample">
      {finding.mismatches.map((m) => (
        <li key={m.dimension} className="counterexample__row">
          <div className="counterexample__dim">
            <strong>{DIMENSION_NAME[m.dimension]}</strong>
            <RelationBadge relation={m.relation} />
          </div>
          <dl className="sidebyside">
            <div>
              <dt>The claim says</dt>
              <dd>{m.claimed ?? "Not stated"}</dd>
            </div>
            <div>
              <dt>The evidence establishes</dt>
              <dd>{m.established ?? "Not stated"}</dd>
            </div>
          </dl>
        </li>
      ))}
    </ul>
  );
}

export function XrayLink({ caseId, findingId, children }: { caseId: string; findingId: string; children: React.ReactNode }) {
  return (
    <Link className="btn btn-secondary" to={`/cases/${encodeURIComponent(caseId)}/claims/${encodeURIComponent(findingId)}`}>
      {children} <Icon name="arrow" size={16} />
    </Link>
  );
}
