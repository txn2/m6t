import type { RunEntry } from "../lib/pipeline";
import { actionVerb, runSummary, runTime, succeeded } from "../lib/pipeline";

export interface RunLogProps {
  /** The active project's runs this session, newest first. */
  readonly entries: readonly RunEntry[];
}

/**
 * What this project's pipeline has done this session (issue #11).
 *
 * It is per project and in memory, and it goes when the window does. That is
 * the v1 scope and not a shortcut around one: an audit trail is a file with a
 * format, a retention rule and a promise about what is in it, and the issue
 * puts that in v2. A log that persisted without those decisions would be a
 * record people started to rely on before anyone had decided what it meant.
 *
 * A run with nothing to show does not appear. Every row here is an invocation
 * that reached — or was refused before reaching — a cluster, which is what makes
 * the panel worth glancing at: it answers "what have I already done to prod
 * today", and a list padded with previews would not.
 */
export function RunLog({ entries }: RunLogProps) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section className="panel__section runlog" aria-label="Cluster runs">
      <h3 className="panel__section-title">Cluster runs</h3>
      <ul className="runlog__list">
        {entries.map((entry) => (
          <li key={entry.id} className="runlog__row" data-ok={succeeded(entry) ? "true" : "false"}>
            <p className="runlog__line">
              <span className="runlog__time">{runTime(entry.at)}</span>
              <span className="runlog__action">{actionVerb(entry.action)}</span>
              {/* The path is the long part and the one that gets truncated, so
                  it carries its own title: a row narrowed to the sidebar's
                  minimum still says which file it was on hover. */}
              <span className="runlog__target" title={entry.target}>
                {entry.target}
              </span>
            </p>
            <p className="runlog__line runlog__detail">
              <span className="runlog__where">
                {entry.context}
                {entry.namespace === "" ? "" : ` / ${entry.namespace}`}
              </span>
              <span className="runlog__outcome">{runSummary(entry)}</span>
            </p>
            {/* DESIGN.md §1: everything m6t does is something the user could
                have typed. A row with no argv is one that never got as far as
                building one, and it says so above rather than showing an empty
                disclosure here. */}
            {entry.argv.length > 0 && (
              <details className="panel__argv">
                <summary>command</summary>
                <pre>{entry.argv.join(" ")}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
