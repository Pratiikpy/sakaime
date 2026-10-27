import { Link } from "react-router-dom";
import type { CaseDetail, LinkState } from "../api/types";
import { ASSERTION_NAME, LINK_STATE_META, LINK_TYPE_NAME } from "../lib/vocab";
import { formatDate, joinWords, plural, sentence } from "../lib/format";
import { headlineFinding } from "../lib/explain";
import { Icon } from "./Icon";

interface Row {
  label: string;
  kinds: Set<string>;
  passages: number;
  retrieved: string;
}

/** One row per source document the answer quotes, counted from the anchors the service sent. Nothing here is typed in. */
function rowsOf(c: CaseDetail): Row[] {
  const by = new Map<string, Row>();
  for (const a of c.anchors) {
    const key = `${a.sourceId}|${a.sourceLabel}`;
    const row = by.get(key);
    if (row) {
      row.passages += 1;
      row.kinds.add(ASSERTION_NAME[a.assertionType] ?? a.assertionType);
      if (a.retrievedAt < row.retrieved) row.retrieved = a.retrievedAt;
    } else {
      by.set(key, { label: a.sourceLabel, kinds: new Set([ASSERTION_NAME[a.assertionType] ?? a.assertionType]), passages: 1, retrieved: a.retrievedAt });
    }
  }
  return [...by.values()].sort((x, y) => y.passages - x.passages || x.label.localeCompare(y.label));
}

const STATE_ORDER: LinkState[] = ["CONFIRMED", "CANDIDATE", "AMBIGUOUS", "REJECTED"];

/**
 * Where an answer came from and how the records behind it were joined: the part of the product that works across separate
 * systems, shown where the answer is, not only deep on the claim X-ray. Every figure is counted from the case the service sent.
 */
export function SourceTrail({ c, compact = false }: { c: CaseDetail; compact?: boolean }) {
  const rows = rowsOf(c);
  const shown = compact ? rows.slice(0, 4) : rows.slice(0, 8);
  const base = `/cases/${encodeURIComponent(c.summary.id)}`;
  const counts = STATE_ORDER.map((s) => ({ s, n: c.links.filter((l) => l.state === s).length })).filter((x) => x.n > 0);
  const types = [...new Set(c.links.map((l) => l.type))];
  // Columns the federated join computes itself are not a system the data was read from.
  const silos = c.matrix ? [...new Set(c.matrix.columns.map((col) => col.sourceLabel))].filter((l) => !/^computed/i.test(l)) : [];
  const head = headlineFinding(c);
  const lost = head?.degraded ?? [];
  if (rows.length === 0 && c.links.length === 0) return null;

  return (
    <div className={`trail${compact ? " trail-compact" : ""}`} data-testid="source-trail">
      <div className="trail__col">
        <h3 className="subhead">Read from {plural(rows.length, "source document")}</h3>
        <ul className="trail__list">
          {shown.map((r) => (
            <li key={r.label}>
              <span className="trail__name">{r.label}</span>
              <span className="trail__meta">
                {sentence(joinWords([...r.kinds].map((k) => k.toLowerCase())))}: {plural(r.passages, "quoted passage")}, retrieved {formatDate(r.retrieved)}
              </span>
            </li>
          ))}
          {rows.length > shown.length && <li className="muted">and {plural(rows.length - shown.length, "more source document")}</li>}
        </ul>
        {silos.length > 0 && (
          <p className="muted trail__note">
            Joined in one federated query across {plural(silos.length, "separate system")}: {joinWords(silos)}.
          </p>
        )}
      </div>
      <div className="trail__col">
        <h3 className="subhead">Joined by what the records share</h3>
        {c.links.length === 0 ? (
          <p className="muted">No record in one source could be tied to a record in another, so each source stands alone here.</p>
        ) : (
          <>
            <ul className="trail__states">
              {counts.map(({ s, n }) => (
                <li key={s} className={`trail__state trail__state-${LINK_STATE_META[s].tone}`}>
                  <Icon name={LINK_STATE_META[s].icon} size={14} /> <strong>{n}</strong> {LINK_STATE_META[s].words.toLowerCase()}
                </li>
              ))}
            </ul>
            {!compact && (
              <p className="muted trail__note">
                {sentence(joinWords(types.map((t) => LINK_TYPE_NAME[t].words.toLowerCase())))}. A candidate or ambiguous link is shown and never used as fact: a shared submission number does not make two software versions the same.
              </p>
            )}
          </>
        )}
        <p className="trail__note">
          {lost.length > 0 ? (
            <>
              <strong>{plural(lost.length, "source")} did not answer</strong> in this run, and the answer was lowered because of it.
            </>
          ) : (
            <>No source was lost while computing this answer.</>
          )}{" "}
          <Link to={`${base}/drills`}>See what happens when one does</Link>.
        </p>
        <p className="trail__note">
          <Link to={`${base}/claims`}>Read each fact next to its source on the claim X-ray</Link>.
        </p>
      </div>
    </div>
  );
}
