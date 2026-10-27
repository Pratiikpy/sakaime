import type { Label, Link, Relation, SourceHealth } from "../api/types";
import { HEALTH_META, LABEL_META, LINK_STATE_META, RELATION_META } from "../lib/vocab";
import { Icon } from "./Icon";

/** Words and an icon always travel together: colour is never the only carrier of meaning. */
export function LabelBadge({ label, size = "md", showGloss = false }: { label: Label; size?: "sm" | "md" | "lg"; showGloss?: boolean }) {
  const m = LABEL_META[label];
  return (
    <span className={`label-badge tone-${m.tone} size-${size}`} data-label={label} title={`${label}: ${m.gloss}`}>
      <Icon name={m.icon} size={size === "lg" ? 22 : 16} />
      <span className="label-badge__text">
        <span className="label-badge__words">{m.words}</span>
        {showGloss && <span className="label-badge__gloss">{m.gloss}</span>}
      </span>
      <span className="sr-only"> (label {label})</span>
    </span>
  );
}

export function RelationBadge({ relation, withGloss = false }: { relation: Relation; withGloss?: boolean }) {
  const m = RELATION_META[relation];
  return (
    <span className={`relation-badge tone-${m.tone}`} data-relation={relation} title={`${relation}: ${m.gloss}`}>
      <Icon name={m.icon} size={14} />
      <span>{m.words}</span>
      {withGloss && <span className="relation-badge__gloss">{m.gloss}</span>}
      <span className="sr-only"> ({relation})</span>
    </span>
  );
}

export function HealthBadge({ health }: { health: SourceHealth }) {
  const m = HEALTH_META[health];
  return (
    <span className={`health-badge tone-${m.tone}`} data-health={health} title={`${health}: ${m.gloss}`}>
      <Icon name={m.icon} size={14} />
      <span>{m.words}</span>
      <span className="sr-only"> ({health})</span>
    </span>
  );
}

/**
 * A source no case has read. Its health field is "OK" only because nothing has failed; nothing has answered either, so it is
 * never drawn as answering. It has its own word, icon and test hook (data-health="NOT_READ").
 */
export function NotReadBadge() {
  return (
    <span className="health-badge tone-neutral" data-health="NOT_READ" title="Not read yet: no case investigated so far has read this source. No failure has been seen for it, and no answer either, so it is not shown as answering.">
      <Icon name="gap" size={14} />
      <span>Not read yet</span>
    </span>
  );
}

export function LinkStateBadge({ state }: { state: Link["state"] }) {
  const m = LINK_STATE_META[state];
  return (
    <span className={`relation-badge tone-${m.tone}`} data-link-state={state} title={`${state}: ${m.gloss}`}>
      <Icon name={m.icon} size={14} />
      <span>{m.words}</span>
      <span className="sr-only"> ({state})</span>
    </span>
  );
}

type Provenance = "constructed" | "recorded" | "live" | "cassette" | "fallback" | "demo" | "pinned";

const PROVENANCE: Record<Provenance, { words: string; gloss: string; icon: "constructed" | "recorded" | "bolt" | "warn" | "shield" | "lock" }> = {
  constructed: { words: "Constructed", gloss: "Written for this test. It is not a statement by any vendor and says nothing about any vendor.", icon: "constructed" },
  recorded: { words: "Recorded", gloss: "Replayed from a recorded real response. It was not produced by a live call in this run.", icon: "recorded" },
  live: { words: "Live", gloss: "Produced by a live call in this run.", icon: "bolt" },
  cassette: { words: "Recorded query", gloss: "Served from a recorded federation response (cassette). It is not a live Zetaris call.", icon: "recorded" },
  fallback: { words: "Local fallback", gloss: "Served by a local DuckDB copy of the same files. A degraded path, not live Zetaris.", icon: "warn" },
  demo: { words: "Demo key", gloss: "Signed with a demonstration key. It does not identify a signer.", icon: "lock" },
  pinned: { words: "Pinned key", gloss: "Signed with a key whose identity was fixed in advance.", icon: "shield" },
};

export function ProvenanceBadge({ kind, text }: { kind: Provenance; text?: string }) {
  const m = PROVENANCE[kind];
  return (
    <span className={`prov-badge prov-${kind}`} data-provenance={kind} title={m.gloss}>
      <Icon name={m.icon} size={13} />
      <span>{text ?? m.words}</span>
    </span>
  );
}

export function ServedBadge({ servedFrom }: { servedFrom: "live" | "cassette" | "fallback" }) {
  return <ProvenanceBadge kind={servedFrom} />;
}
