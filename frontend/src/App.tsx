import { useEffect, useState } from "react";
import { type BuildStatus, detachedBuild, loadBuild } from "./lib/build";

const initialStatus: BuildStatus = { info: detachedBuild, attached: false };

export interface AppProps {
  /** Injectable for tests and harnesses; defaults to the Wails binding. */
  load?: typeof loadBuild;
}

/**
 * Placeholder shell (issue #1). The project workbench described in DESIGN.md §5
 * lands in later issues; what ships here is the window itself plus proof the
 * Wails bridge is wired end to end.
 */
export default function App({ load = loadBuild }: AppProps) {
  const [status, setStatus] = useState<BuildStatus>(initialStatus);

  useEffect(() => {
    let current = true;
    void load().then((next) => {
      if (current) {
        setStatus(next);
      }
    });
    return () => {
      current = false;
    };
  }, [load]);

  return (
    <main className="shell">
      <h1 className="shell__title">m6t</h1>
      <p className="shell__subtitle">
        Kubernetes manifest workbench — scaffold
      </p>
      <dl className="shell__build">
        <dt>version</dt>
        <dd data-testid="build-version">{status.info.version}</dd>
        <dt>commit</dt>
        <dd data-testid="build-commit">{status.info.commit}</dd>
        <dt>built</dt>
        <dd data-testid="build-date">{status.info.date}</dd>
      </dl>
      <p className="shell__bridge" data-testid="bridge-status">
        {status.attached
          ? "connected to the Wails backend"
          : "detached — no Wails runtime"}
      </p>
    </main>
  );
}
