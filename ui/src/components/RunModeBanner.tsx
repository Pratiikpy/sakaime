import { api } from "../api/client";
import { useResource } from "../api/hooks";
import type { RunMode } from "../api/types";
import { Icon } from "./Icon";
import type { IconName } from "../lib/vocab";

interface Chip {
  id: string;
  icon: IconName;
  words: string;
  title: string;
  tone: "neutral" | "good" | "warn" | "bad";
}

function chipsFor(mode: RunMode): Chip[] {
  const chips: Chip[] = [];
  chips.push(
    mode.sample
      ? { id: "run", icon: "recorded", words: "Sample run", title: "Recorded real responses are replayed. Nothing is live unless a chip below says so.", tone: "neutral" }
      : { id: "run", icon: "bolt", words: "Live run", title: "Sources and models are called live where a chip below says so.", tone: "good" },
  );
  const fed: Record<RunMode["federation"], Chip> = {
    live: { id: "fed", icon: "bolt", words: "Federation: live Zetaris", title: "Queries run on a live Zetaris engine.", tone: "good" },
    cassette: { id: "fed", icon: "recorded", words: "Federation: recorded replies", title: "Queries are answered from recorded Zetaris responses, not a live call.", tone: "neutral" },
    fallback: { id: "fed", icon: "warn", words: "Federation: local fallback", title: "Queries run on a local DuckDB copy of the same files. Zetaris is not in use.", tone: "warn" },
    off: { id: "fed", icon: "unplugged", words: "Federation: off", title: "No federated query can run. Sources behind it are treated as lost.", tone: "bad" },
  };
  chips.push(fed[mode.federation]);
  const model: Record<RunMode["model"], Chip> = {
    nightshift: { id: "model", icon: "bolt", words: "Model: Nemotron via Nightshift", title: "Model replies are live and carry compute receipts.", tone: "good" },
    nvidia: { id: "model", icon: "bolt", words: "Model: Nemotron via NVIDIA", title: "Model replies are live. They carry no Nightshift receipt and are labelled unreceipted.", tone: "good" },
    recorded: { id: "model", icon: "recorded", words: "Model: recorded replies", title: "Model replies are replayed from recordings, not produced now.", tone: "neutral" },
    off: { id: "model", icon: "unplugged", words: "Model: off", title: "No model is called. Labels come from rules and do not depend on one.", tone: "warn" },
  };
  chips.push(model[mode.model]);
  chips.push(
    mode.sources === "live"
      ? { id: "src", icon: "bolt", words: "Sources: live", title: "Records are fetched from the public sources now.", tone: "good" }
      : { id: "src", icon: "recorded", words: "Sources: recorded", title: "Records are served from recorded, hashed responses with a retrieval date.", tone: "neutral" },
  );
  if (!mode.zetarisReachable && mode.federation !== "off") {
    chips.push({ id: "zr", icon: "unplugged", words: "Zetaris unreachable", title: "The Zetaris engine did not answer its last probe.", tone: "warn" });
  }
  if (!mode.nightshiftReachable && mode.model === "nightshift") {
    chips.push({ id: "nr", icon: "unplugged", words: "Nightshift unreachable", title: "The Nightshift route did not answer its last probe.", tone: "bad" });
  }
  // In a sample run the notes explain what is replayed; they are not faults, so they sit behind a disclosure instead of as warnings.
  if (!mode.sample) mode.degradedNotes.forEach((note, i) => chips.push({ id: `d${i}`, icon: "warn", words: `Degraded: ${note}`, title: note, tone: "warn" }));
  return chips;
}

/** Always on screen. It says how each layer is being served so nothing recorded can pass as live. */
export function RunModeBanner() {
  const health = useResource("health", (s) => api.health(s));
  return (
    <section className="runmode" aria-label="Run mode" data-testid="run-mode">
      <div className="runmode__inner">
        <span className="runmode__title">Run mode</span>
        <ul className="runmode__chips">
          {health.status === "loading" && <li className="chip chip-neutral">Checking the service…</li>}
          {health.status === "error" && (
            <li className="chip chip-bad" title={health.error.message}>
              <Icon name="unplugged" size={14} />
              <span>Service not reachable</span>
            </li>
          )}
          {health.data && chipsFor(health.data.mode).map((c) => (
            <li key={c.id} className={`chip chip-${c.tone}`} title={c.title} data-chip={c.id}>
              <Icon name={c.icon} size={14} />
              <span>{c.words}</span>
            </li>
          ))}
        </ul>
        {health.data?.mode.sample && (
          <details className="runmode__notes" data-testid="run-mode-notes">
            <summary>Sample mode: every reading on these screens is replayed from recordings. Nothing is fetched live. What that means</summary>
            <ul>
              {health.data.mode.degradedNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          </details>
        )}
        {health.data && (
          <span className="runmode__meta mono" title="Application and rule-registry versions">
            v{health.data.version} · rules {health.data.ruleVersion.split("+")[0]}
          </span>
        )}
      </div>
    </section>
  );
}
