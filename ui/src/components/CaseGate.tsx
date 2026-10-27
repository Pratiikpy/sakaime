import type { ReactNode } from "react";
import { useCase } from "../api/hooks";
import type { CaseDetail } from "../api/types";
import { ErrorState, Loading } from "./feedback";
import { LabelBadge, ProvenanceBadge } from "./badges";
import { PageHeader } from "./ui";

/** Loads one case and renders the screen only when the data is there. Loading and error states are designed, not blank. */
export function CaseGate({ id, children, screen }: { id: string; screen: string; children: (c: CaseDetail, reload: () => void) => ReactNode }) {
  const res = useCase(id);
  if (res.status === "loading" && !res.data) {
    return (
      <>
        <PageHeader eyebrow={screen} title="Loading case" />
        <Loading label="Loading the case" rows={4} />
      </>
    );
  }
  if (res.status === "error" && !res.data) {
    return (
      <>
        <PageHeader eyebrow={screen} title="Case unavailable" />
        <ErrorState error={res.error} onRetry={res.reload} />
      </>
    );
  }
  return <>{children(res.data as CaseDetail, res.reload)}</>;
}

export function CaseHeader({ c, screen, lead, actions }: { c: CaseDetail; screen: string; lead?: ReactNode; actions?: ReactNode }) {
  return (
    <PageHeader
      eyebrow={screen}
      title={c.summary.title}
      badges={
        <>
          {c.summary.headlineLabel && <LabelBadge label={c.summary.headlineLabel} />}
          {c.summary.claimConstructed && <ProvenanceBadge kind="constructed" text="Constructed claim" />}
        </>
      }
      lead={lead}
      actions={actions}
    />
  );
}
