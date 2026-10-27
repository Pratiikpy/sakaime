import type { CaseDetail, Finding, Label } from "../api/types";
import { openDimensions } from "../lib/explain";
import { plural } from "../lib/format";
import { DIMENSION_NAME } from "../lib/vocab";
import { RelationBadge } from "./badges";
import { Clamp } from "./ui";

function lead(label: Label, open: string[], lost: boolean): string {
  const names = open.length > 0 ? open.join(", ") : "part of the use";
  const tail = lost ? " Some sources did not answer, which also lowers the answer; it never raises it." : "";
  switch (label) {
    case "SUPPORTED_FOR_SCOPE":
      return "The evidence read covers every part of this use.";
    case "SUPPORTED_ONLY_FOR_NARROWER_SCOPE":
      return `The evidence covers a narrower use than the one asked about. It falls short on ${names}.${tail}`;
    case "CONTRADICTED_BY_SPECIFIED_EVIDENCE":
      return `Named evidence limits or disagrees with this use on ${names}.${tail}`;
    case "REQUIRES_DOMAIN_REVIEW":
      return `The rules cannot settle ${names}; a clinical or domain reviewer has to judge it. The rules do not guess.${tail}`;
    case "INSUFFICIENT_EVIDENCE":
      return `Nothing can be said either way yet: the evidence read does not settle ${names}. A gap is never read as covered, and never as contradicted.${tail}`;
  }
}

/**
 * Why the answer is what it is, and what would change it. The same words appear on the landing page, the case and the lab, so a
 * reviewer who sees "not enough evidence" is always told which parts of the use are open and what to ask for.
 */
/** The one-sentence reason for a finding's label, for places that show a summary before the detail. */
export const whyLead = (c: CaseDetail, f: Finding): string =>
  lead(f.label, openDimensions(c, f).map((d) => DIMENSION_NAME[d.dimension].toLowerCase()), f.degraded.length > 0);

export function Why({ c, f, maxDims = 4, maxAsks = 3, heading = true, showLead = true }: { c: CaseDetail; f: Finding; maxDims?: number; maxAsks?: number; heading?: boolean; showLead?: boolean }) {
  const open = openDimensions(c, f);
  const shownDims = open.slice(0, maxDims);
  const asks = f.requiredEvidence.slice(0, maxAsks);
  return (
    <div className="why" data-testid="why">
      {showLead && <p className="why__lead">{whyLead(c, f)}</p>}
      {shownDims.length > 0 && (
        <ul className="why__list" aria-label="Parts of the use the evidence does not cover">
          {shownDims.map((d) => (
            <li key={d.dimension} data-why-dimension={d.dimension}>
              <span className="why__dim">
                <strong>{DIMENSION_NAME[d.dimension]}</strong> <RelationBadge relation={d.relation} />
              </span>
              <span className="why__reason">
                <Clamp text={d.reason} lines={2} />
              </span>
            </li>
          ))}
          {open.length > shownDims.length && <li className="muted">and {plural(open.length - shownDims.length, "more part")}, on the claim X-ray.</li>}
        </ul>
      )}
      {asks.length > 0 && (
        <div className="why__settle" data-testid="settle">
          {heading && <h3 className="subhead">What would settle it</h3>}
          <ul className="plain-list">
            {asks.map((r, i) => (
              <li key={`${r.dimension}-${i}`}>
                <strong>{DIMENSION_NAME[r.dimension]}:</strong> <Clamp text={r.request} lines={2} />
              </li>
            ))}
            {f.requiredEvidence.length > asks.length && <li className="muted">and {f.requiredEvidence.length - asks.length} more, in the missing-evidence list on the case.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
