import { api, type ApiError } from "../api/client";
import { useResource } from "../api/hooks";
import type { UslResponse } from "../api/types";
import { ProvenanceBadge } from "../components/badges";
import { EmptyState, ErrorState, Loading, Notice } from "../components/feedback";
import { Icon } from "../components/Icon";
import { CopyButton, Disclosure, Section, Stat } from "../components/ui";
import { formatDateTime, formatMs, plural, sentence, shortHash } from "../lib/format";
import type { IconName } from "../lib/vocab";

type Rule = UslResponse["dqRules"][number];
type Table = UslResponse["tables"][number];
type Definition = UslResponse["definitions"][number];
type Verdict = Rule["verdict"];

/**
 * What each verdict means on this screen. A failed rule is a result about the data and the engine answered; a rule that could
 * not be judged had no rows to judge. Neither is an outage: an engine that cannot be asked gives no verdict at all and the
 * whole panel says so (see UslUnavailable).
 */
const VERDICT: Record<Verdict, { words: string; icon: IconName; tone: "good" | "bad" | "warn"; gloss: string }> = {
  PASSED: { words: "Passed", icon: "check", tone: "good", gloss: "The engine ran the rule over the rows and none failed it." },
  FAILED: { words: "Failed", icon: "cross", tone: "bad", gloss: "The engine ran the rule and some rows failed it. This is a result about the data, not a fault in the engine." },
  UNVERIFIABLE: { words: "Could not be judged", icon: "gap", tone: "warn", gloss: "The engine answered, but there were no rows to judge the rule on. That is not a pass." },
};

const KIND_WORDS: Record<Definition["kind"], string> = { setting: "Care setting", purpose: "Intended purpose", metric: "Performance metric", population: "Population word" };

const RULE_KIND_WORDS: Record<Rule["kind"], string> = {
  completeness: "Completeness",
  record_completeness: "Record completeness",
  range: "Range",
  identifier: "Identifier",
  vocabulary: "Vocabulary",
  definition: "Definition",
};

function VerdictPill({ verdict }: { verdict: Verdict }) {
  const v = VERDICT[verdict];
  return (
    <span className={`status-pill tone-${v.tone}`} data-verdict={verdict} title={v.gloss}>
      <Icon name={v.icon} size={13} />
      <span>{v.words}</span>
      <span className="sr-only"> ({verdict})</span>
    </span>
  );
}

function Count({ n }: { n: number | null }) {
  return n === null ? <span className="cell-sub">not counted</span> : <span className="mono">{n.toLocaleString("en-GB")}</span>;
}

// ---------------------------------------------------------------- completeness

function Completeness({ data }: { data: UslResponse }) {
  const c = data.completeness;
  const total = c.collections.length;
  const tone = c.verdict === "PASSED" ? "good" : c.verdict === "FAILED" ? "bad" : "warn";
  const title =
    c.verdict === "PASSED"
      ? `All ${plural(total, "landed collection")} ${total === 1 ? "is" : "are"} complete`
      : c.verdict === "FAILED"
        ? `${c.blocked.length} of ${total} landed collections are not complete`
        : "Completeness could not be judged";
  return (
    <Section level={3} title="Completeness gate" id="usl-completeness">
      <div data-testid="usl-completeness" data-verdict={c.verdict}>
        <Notice tone={tone} title={title}>
          {c.verdict === "PASSED" && <>The engine's rule found every landed collection whole: its expected size known, all of it present, and the connector not stopped early. Their records may feed evidence.</>}
          {c.verdict === "FAILED" && (
            <>
              A collection that is short, cut off by its connector or of unknown size feeds nothing downstream: its records are not used as evidence, and a finding that needed them is unresolved, not negative. Blocked:{" "}
              {c.blocked.map((b, i) => (
                <span key={b}>
                  {i > 0 && ", "}
                  <code className="mono">{b}</code>
                </span>
              ))}
              .
            </>
          )}
          {c.verdict === "UNVERIFIABLE" && <>The engine answered with nothing to judge, so no collection is treated as complete. This is not a pass.</>}{" "}
          {c.codeCheckAgrees ? "The engine's rule and the independent code check gave the same failures." : "The engine's rule and the code check disagree; nothing is treated as complete until they agree."}
        </Notice>
        {total === 0 ? (
          <EmptyState title="No landed collections are listed" icon="database">
            The manifest is empty, so there is nothing to judge. Completeness is not claimed.
          </EmptyState>
        ) : (
          <div className="table-wrap table-wrap-scroll" role="region" aria-label="Landed collections, scrolls sideways" tabIndex={0}>
            <table className="data-table responsive" data-testid="usl-collections">
              <caption className="sr-only">Landed collections: how many records were expected, how many arrived, and whether each may feed evidence</caption>
              <thead>
                <tr>
                  <th scope="col">Collection</th>
                  <th scope="col" className="num">
                    Expected
                  </th>
                  <th scope="col" className="num">
                    Arrived
                  </th>
                  <th scope="col">May feed evidence</th>
                </tr>
              </thead>
              <tbody>
                {c.collections.map((x) => (
                  <tr key={x.collectionId} data-collection={x.collectionId} data-status={x.status}>
                    <th scope="row" data-label="Collection">
                      <code className="mono usl-name">{x.collectionId}</code>
                      {x.sourceId && <div className="cell-sub">from {x.sourceId}</div>}
                    </th>
                    <td data-label="Expected" className="num">
                      <Count n={x.expectedTotal} />
                    </td>
                    <td data-label="Arrived" className="num">
                      <Count n={x.retrievedTotal} />
                    </td>
                    <td data-label="May feed evidence">
                      {x.status === "COMPLETE" ? (
                        <span className="status-pill tone-good">
                          <Icon name="check" size={13} />
                          <span>Complete</span>
                        </span>
                      ) : (
                        <span className={`status-pill tone-${x.status === "TRUNCATED" ? "bad" : "warn"}`}>
                          <Icon name={x.status === "TRUNCATED" ? "cross" : "gap"} size={13} />
                          <span>{x.status === "TRUNCATED" ? "Cut short" : "Size unknown"}</span>
                        </span>
                      )}
                      {x.reason && <div className="cell-sub">{x.reason}</div>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Section>
  );
}

// ---------------------------------------------------------------- tables

function Tables({ tables }: { tables: Table[] }) {
  return (
    <Section level={3} title="Tables" id="usl-tables" aside={<span className="muted">{plural(tables.length, "table")}</span>}>
      {tables.length === 0 ? (
        <EmptyState title="The layer has no tables" icon="database">
          The layer was reached and holds no table, so a question cannot be asked of it. This is an empty layer, not an outage.
        </EmptyState>
      ) : (
        <div className="table-wrap table-wrap-scroll" role="region" aria-label="Layer tables, scrolls sideways" tabIndex={0}>
          <table className="data-table responsive" data-testid="usl-tables">
            <caption className="sr-only">Tables of the semantic layer, what each answers, how many rows it holds and which silo tables it reads</caption>
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">What it answers</th>
                <th scope="col" className="num">
                  Rows
                </th>
                <th scope="col">Reads</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((t) => (
                <tr key={t.name} data-table={t.name}>
                  <th scope="row" data-label="Table">
                    <code className="mono usl-name">{t.name}</code>
                    {!t.activated && <div className="cell-sub">Not activated: it cannot be read yet</div>}
                    {t.primaryKey && <div className="cell-sub">Key: {t.primaryKey}</div>}
                  </th>
                  <td data-label="What it answers">
                    <div>{t.description}</div>
                    <Disclosure summary={`${plural(t.columns.length, "column")}`} className="disclosure-small">
                      <ul className="usl-columns">
                        {t.columns.map((col) => (
                          <li key={col.name}>
                            <code className="mono">{col.name}</code> <span className="muted">{col.type}</span>
                            <div className="cell-sub">{col.description}</div>
                          </li>
                        ))}
                      </ul>
                    </Disclosure>
                  </td>
                  <td data-label="Rows" className="num">
                    <Count n={t.rows} />
                  </td>
                  <td data-label="Reads">
                    {t.sources.length === 0 ? (
                      <span className="cell-sub">Computed inside the layer</span>
                    ) : (
                      <ul className="plain-list">
                        {t.sources.map((s) => (
                          <li key={s}>
                            <code className="mono usl-name">{s}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- definitions

function unitWords(d: Definition): string {
  if (d.kind !== "metric") return "";
  const range = d.valueMin !== null && d.valueMax !== null ? `${d.valueMin} to ${d.valueMax}` : "";
  return [d.unit ?? "no unit", range].filter(Boolean).join(", ") + (d.prevalenceDependent ? "; depends on how common the condition was" : "");
}

function Definitions({ items, unresolved }: { items: Definition[]; unresolved: UslResponse["unresolved"] }) {
  return (
    <Section level={3} title="Definitions the compiler uses" id="usl-definitions" aside={<span className="muted">{plural(items.length, "term")}</span>}>
      <p className="muted">
        The layer publishes the same words the applicability compiler compares, so a second reader sees the meaning the compiler used: where a care setting sits inside broader ones, what a metric is and its range. The word “adult” is defined with no number on purpose; the compiler
        compares the age limits a source states and never turns the word into an age.
      </p>
      {unresolved.length > 0 && (
        <Notice tone="warn" title="Words the case names that the layer does not define">
          {unresolved.map((u) => `${u.term} (${u.kind})`).join(", ")}. The compiler does not guess where they sit.
        </Notice>
      )}
      {items.length === 0 ? (
        <EmptyState title="The layer defines no terms" icon="info">
          The layer was reached and its definition table is empty, so the words in a claim cannot be read against it.
        </EmptyState>
      ) : (
        <div className="table-wrap table-wrap-scroll" role="region" aria-label="Defined terms, scrolls sideways" tabIndex={0}>
          <table className="data-table responsive" data-testid="usl-definitions">
            <caption className="sr-only">Terms the semantic layer defines: kind, where the term sits, its meaning and, for a metric, its unit and range</caption>
            <thead>
              <tr>
                <th scope="col">Term</th>
                <th scope="col">Kind</th>
                <th scope="col">Where it sits</th>
                <th scope="col">Meaning</th>
              </tr>
            </thead>
            <tbody>
              {items.map((d) => (
                <tr key={`${d.kind}:${d.term}`} data-kind={d.kind} data-term={d.term}>
                  <th scope="row" data-label="Term">
                    <div className="cell-title">{d.label}</div>
                    <div className="cell-sub mono usl-name">{d.isAlias ? `${d.term} reads as ${d.canonical}` : d.canonical}</div>
                  </th>
                  <td data-label="Kind">{KIND_WORDS[d.kind]}</td>
                  <td data-label="Where it sits">
                    {d.ancestry.length > 1 ? d.ancestry.join(" › ") : <span className="cell-sub">{d.kind === "metric" ? "Not on a hierarchy" : d.ancestry.length === 1 ? "Broadest term of its hierarchy" : "No broader term"}</span>}
                  </td>
                  <td data-label="Meaning">
                    <div>{sentence(d.definition)}</div>
                    {unitWords(d) && <div className="cell-sub">{unitWords(d)}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- data-quality rules

function Rules({ rules }: { rules: Rule[] }) {
  const failed = rules.filter((r) => r.verdict === "FAILED").length;
  const unjudged = rules.filter((r) => r.verdict === "UNVERIFIABLE").length;
  return (
    <Section
      level={3}
      title="Data-quality rules"
      id="usl-rules"
      aside={
        rules.length > 0 ? (
          <span className="muted" data-testid="usl-rules-summary">
            {rules.length - failed - unjudged} passed, {failed} failed{unjudged > 0 ? `, ${unjudged} could not be judged` : ""}
          </span>
        ) : undefined
      }
    >
      <p className="muted">
        Each rule is run by the engine over a layer table and answers with counts and a query id, the engine's own witness. A failed rule is a result about the data and is shown as one; an engine that could not be asked gives no verdict, and this panel would say
        that instead.
      </p>
      {rules.length === 0 ? (
        <EmptyState title="No data-quality rules are registered" icon="shield">
          Without a rule the engine judges nothing about these tables, so the panel shows no verdict rather than a pass.
        </EmptyState>
      ) : (
        <div className="table-wrap table-wrap-scroll" role="region" aria-label="Data-quality rules, scrolls sideways" tabIndex={0}>
          <table className="data-table responsive" data-testid="usl-rules">
            <caption className="sr-only">Data-quality rules: the table each covers, the verdict, rows checked, rows that failed and the engine's query id</caption>
            <thead>
              <tr>
                <th scope="col">Rule</th>
                <th scope="col">Verdict</th>
                <th scope="col" className="num">
                  Rows checked
                </th>
                <th scope="col" className="num">
                  Failures
                </th>
                <th scope="col">Query id</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.rule} data-rule={r.rule} data-verdict={r.verdict}>
                  <th scope="row" data-label="Rule">
                    <code className="mono usl-name">{r.rule}</code>
                    <div className="cell-sub">
                      {RULE_KIND_WORDS[r.kind]} rule on <code className="mono">{r.table}</code>
                    </div>
                    <div className="cell-sub">{r.description}</div>
                    <Disclosure summary="What a failure means" className="disclosure-small">
                      <p>{r.consequence}</p>
                      <p className="cell-sub">
                        Rule: <code className="mono">{r.expression}</code>
                      </p>
                    </Disclosure>
                  </th>
                  <td data-label="Verdict">
                    <VerdictPill verdict={r.verdict} />
                    {r.verdict === "FAILED" && (
                      <div className="cell-sub">
                        {r.failures.toLocaleString("en-GB")} of {r.rowsChecked.toLocaleString("en-GB")} rows failed
                      </div>
                    )}
                    {r.verdict === "UNVERIFIABLE" && <div className="cell-sub">No rows to judge</div>}
                  </td>
                  <td data-label="Rows checked" className="num">
                    {r.rowsChecked.toLocaleString("en-GB")}
                  </td>
                  <td data-label="Failures" className="num" data-failures={r.failures}>
                    {r.failures.toLocaleString("en-GB")}
                  </td>
                  <td data-label="Query id">
                    <div className="cell-hash">
                      <code className="mono" title={r.queryId}>
                        {shortHash(r.queryId, 8)}
                      </code>
                      <CopyButton text={r.queryId} what="query id" label="Copy" />
                    </div>
                    <div className="cell-sub">{formatMs(r.elapsedMs)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Section>
  );
}

// ---------------------------------------------------------------- the panel

function Facts({ data }: { data: UslResponse }) {
  return (
    <dl className="kv usl-facts" data-testid="usl-provenance">
      <div>
        <dt>Layer</dt>
        <dd>
          <code className="mono" data-testid="usl-layer-name">
            {data.layer.name}
          </code>{" "}
          <span className="muted">in {data.layer.namespace}</span>
        </dd>
      </div>
      <div>
        <dt>Path</dt>
        <dd>
          <div className="cell-hash">
            <code className="mono">{data.layer.path}</code>
            <CopyButton text={data.layer.path} what="layer path" label="Copy" />
          </div>
        </dd>
      </div>
      <div>
        <dt>Structure hash</dt>
        <dd>
          <div className="cell-hash">
            <code className="mono" title={data.layer.structureHash}>
              {shortHash(data.layer.structureHash, 16)}
            </code>
            <CopyButton text={data.layer.structureHash} what="structure hash" label="Copy" />
          </div>
        </dd>
      </div>
      <div>
        <dt>Read as</dt>
        <dd data-testid="usl-reader">
          <code className="mono">{data.readerIdentity}</code>
          <div className="cell-sub">A read-only identity: it can run queries, RUN DQ and LOAD USL, and is refused COMPILE USL, ACTIVATE USL TABLE and REGISTER DQ.</div>
        </dd>
      </div>
      <div>
        <dt>{data.servedFrom === "live" ? "Read at" : "Recorded at"}</dt>
        <dd>
          <span data-testid="usl-recorded-at">{formatDateTime(data.recordedAt)}</span>
          <div className="cell-sub">
            {data.servedFrom === "live"
              ? "Read from the running engine for this page."
              : "Replayed from a recording of the engine's own answers. No live call was made for this page, and the figures are those of the recording."}
          </div>
        </dd>
      </div>
    </dl>
  );
}

function Statements({ data }: { data: UslResponse }) {
  return (
    <Disclosure summary={`How this was read: ${plural(data.statements.length, "statement")}`}>
      {data.statements.length === 0 ? (
        <p className="muted">The reading sent no statement of its own.</p>
      ) : (
        <ol className="usl-statements" data-testid="usl-statements">
          {data.statements.map((s) => (
            <li key={s.queryId}>
              <code className="mono usl-statement">{s.statement}</code>
              <div className="cell-sub">
                {plural(s.rows, "row")} · {formatMs(s.elapsedMs)} · {s.servedFrom} · query <span className="mono">{shortHash(s.queryId, 8)}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
    </Disclosure>
  );
}

/** The engine could not be asked. No tables, no rules and no verdict are shown, and none is implied. */
function UslUnavailable({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div data-testid="usl-unavailable">
      <ErrorState error={error} onRetry={onRetry} title={error.failure === "UNAVAILABLE" ? "The semantic layer could not be read" : undefined} />
      {error.failure === "UNAVAILABLE" && (
        <Notice tone="warn" title="Nothing here is a verdict">
          No table was listed and no rule was judged. This is not a layer with no tables, and not a rule that passed. Evidence that depends on these tables is unresolved until the layer can be read.
        </Notice>
      )}
    </div>
  );
}

export function SemanticLayer() {
  const usl = useResource("usl", (s) => api.usl(undefined, s));
  const data = usl.data;
  const rules = data?.dqRules ?? [];
  const passed = rules.filter((r) => r.verdict === "PASSED").length;
  return (
    <Section
      id="usl"
      title="Unified Semantic Layer"
      aside={
        data ? (
          <span className="badge-row" data-testid="usl-served">
            <ProvenanceBadge kind={data.servedFrom === "live" ? "live" : "cassette"} />
          </span>
        ) : undefined
      }
    >
      <div data-testid="usl-panel" data-state={usl.status === "error" && !data ? "unavailable" : data ? "ready" : "loading"}>
        <p className="muted usl-lead">
          One layer of named tables over the hospital database, the registry snapshots and the vendor packets, written in the reviewer's words. It carries the definitions the compiler uses and the rules the engine runs over the data before anything is read as
          evidence.
        </p>
        {usl.status === "loading" && !data && <Loading label="Reading the semantic layer" rows={4} />}
        {usl.status === "error" && !data && <UslUnavailable error={usl.error} onRetry={usl.reload} />}
        {usl.status === "error" && data && (
          <Notice tone="warn" title="Showing the last reading we had">
            {usl.error.message}
          </Notice>
        )}
        {data && (
          <div className="usl-body">
            <div className="stat-row">
              <Stat value={data.tables.length} label={data.tables.length === 1 ? "table" : "tables"} hint={`${data.tables.reduce((n, t) => n + t.columns.length, 0)} columns, each described`} />
              <Stat value={data.definitions.length} label="terms defined" hint="Settings, purposes, metrics" />
              <Stat value={rules.length === 0 ? "none" : `${passed} of ${rules.length}`} label="rules passed" hint={rules.length === 0 ? "No rule is registered" : "Run by the engine"} />
              <Stat value={data.completeness.verdict === "PASSED" ? "Whole" : data.completeness.verdict === "FAILED" ? "Gaps" : "Unjudged"} label="landed collections" hint="Completeness gate" />
            </div>
            <Facts data={data} />
            <Completeness data={data} />
            <Tables tables={data.tables} />
            <Definitions items={data.definitions} unresolved={data.unresolved} />
            <Rules rules={rules} />
            <Statements data={data} />
          </div>
        )}
      </div>
    </Section>
  );
}
