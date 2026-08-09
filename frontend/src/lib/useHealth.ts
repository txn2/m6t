import { useCallback, useEffect, useRef, useState } from "react";
import type { SocketFactory } from "./events";
import { openEventsSocket } from "./events";
import type { Health, HealthSnapshot } from "./health";
import { NO_HEALTH, wailsHealth } from "./health";
import type { Endpoint } from "./stream";

/** What the panel's health section reads. */
export interface HealthController {
  /** The last snapshot the backend answered with. It covers the whole binding;
   * `file` is what narrows it to the rows the panel draws. */
  readonly snapshot: HealthSnapshot;
  /** The open manifest the section is about, or null when none is open. */
  readonly file: string | null;
  /** A failure of the CALL, not of the cluster. A cluster that cannot be
   * reached is a phase on the snapshot; this is the bridge itself failing. */
  readonly error: string | null;
  /** Asks again now, for the button the failing states offer. */
  readonly refresh: () => void;
}

/** Which selection the health section is describing. */
export interface HealthSelection {
  /** The active project's registry name, or null when there is none. */
  readonly project: string | null;
  /**
   * The project's worktree path, which is what a `health` event names. It is
   * carried alongside the name because the two keys are not interchangeable:
   * the frontend addresses the backend by project name, and the backend
   * addresses a checkout by path (see App.KubeHealth).
   */
  readonly root: string | null;
  /**
   * The open manifest, repository-relative, or null when no file is open.
   *
   * It is the FILE and not the folder the binding sections use. The health
   * section answers about what is on screen, and at the granularity of a folder
   * that answer is a list of every object in the tree — which in any real
   * repository is a list whose interesting row is off the bottom of the pane.
   *
   * The binding is still resolved at this path, and resolves identically to its
   * folder's: a scope covers whole segments, so `prod/app.yaml` lands on the
   * `prod` override exactly as `prod` does.
   */
  readonly file: string | null;
}

/**
 * The live health of whatever the panel's selection resolves to (#12,
 * DESIGN.md §5).
 *
 * Nothing is retained across selections, unlike `useGitStatus`, and the
 * difference is where the state lives. A git status is a subprocess and its
 * result is the frontend's only copy, so throwing it away on a project switch
 * meant re-running git to redraw badges that had not changed. A health snapshot
 * is a map read against a session the backend is already keeping current, so
 * asking again is immediate and what comes back is the truth rather than a
 * remembered version of it. Retaining here would only create the opportunity to
 * show one cluster's verdicts while another's name is on screen.
 *
 * Asking is also what starts the watch, which is why the first effect below
 * does not need a companion "stop": sessions are backend-owned and outlive the
 * component (DESIGN.md §3.2), and reaping the ones nobody is looking at is #68.
 *
 * What is asked for is the whole binding the open file belongs to, not the file.
 * The backend keeps one session per cluster and namespace, so moving between two
 * files in the same tree is a re-read of a map rather than a fresh list against
 * the API server — and the narrowing to one file happens in the panel, where
 * changing it costs nothing.
 */
export function useHealth(
  selection: HealthSelection,
  endpoint: Endpoint | null,
  health: Health = wailsHealth,
  /** Injectable for tests; defaults to opening a real WebSocket. */
  socketFactory?: SocketFactory,
): HealthController {
  const { project, root, file } = selection;
  // No file, nothing to answer about — and nothing to connect for. A project
  // whose panel is showing the empty state below starts no watch at all, which
  // is the cheapest this section can be when nobody is using it.
  const asking = file === null ? null : project;

  const [snapshot, setSnapshot] = useState<HealthSnapshot>(NO_HEALTH);
  const [error, setError] = useState<string | null>(null);

  // What a result would belong to. A ref rather than the props, because a read
  // that started before the selection moved resolves after it, and the check
  // that discards it has to see the selection as it is now.
  //
  // It is written in the effect below rather than during render: a render that
  // React discards must not be able to leave this pointing at a selection that
  // was never shown.
  const target = useRef({ project: asking, rel: file ?? "" });

  // One read in flight and one queued behind it, a trailing edge. The events
  // that drive this arrive rate-limited from the backend but a rollout still
  // produces a steady stream, and a read per event would put one bridge call
  // per API-server observation onto the UI thread.
  const inFlight = useRef(false);
  const stale = useRef(false);

  // The seam behind a ref so `read` never changes identity — see the same ref
  // in useGitStatus for why a hook must not depend on its caller memoizing an
  // argument.
  const seam = useRef(health);
  useEffect(() => {
    seam.current = health;
  }, [health]);

  const read = useCallback(() => {
    if (inFlight.current) {
      stale.current = true;
      return;
    }
    inFlight.current = true;
    void (async () => {
      try {
        do {
          stale.current = false;
          const asked = target.current;
          if (asked.project === null) {
            break;
          }
          await ask(seam.current, asked, target, setSnapshot, setError);
        } while (stale.current);
      } finally {
        inFlight.current = false;
      }
    })();
  }, []);

  useEffect(() => {
    target.current = { project: asking, rel: file ?? "" };
    setSnapshot(NO_HEALTH);
    setError(null);
    if (asking !== null) {
      read();
    }
  }, [asking, file, read]);

  // /events: the backend says a project's health may be stale and this asks
  // again (PROTOCOL.md §5). The message carries no health of its own.
  useEffect(() => {
    if (root === null || endpoint === null) {
      return;
    }
    const socket = openEventsSocket(
      endpoint,
      {
        onHealth: (changed) => {
          if (changed === root) {
            read();
          }
        },
      },
      socketFactory,
    );
    return () => {
      socket.close();
    };
  }, [root, endpoint, read, socketFactory]);

  return { snapshot, file, error, refresh: read };
}

/**
 * Performs one read and publishes it, if the selection has not moved under it.
 *
 * A stale answer is dropped rather than shown and corrected. Every other kind
 * of stale data in this app is cosmetic; this one would put one cluster's
 * object states under another cluster's name, which is the reading DESIGN.md §5
 * makes the panel's whole reason for existing.
 */
async function ask(
  health: Health,
  asked: { project: string | null; rel: string },
  target: { current: { project: string | null; rel: string } },
  setSnapshot: (snapshot: HealthSnapshot) => void,
  setError: (error: string | null) => void,
): Promise<void> {
  if (asked.project === null) {
    return;
  }
  try {
    const answer = await health.snapshot(asked.project, asked.rel);
    if (current(target, asked)) {
      setSnapshot(answer);
      setError(null);
    }
  } catch (failure: unknown) {
    if (current(target, asked)) {
      setError(describe(failure));
    }
  }
}

function current(
  target: { current: { project: string | null; rel: string } },
  asked: { project: string | null; rel: string },
): boolean {
  return target.current.project === asked.project && target.current.rel === asked.rel;
}

/** Renders a rejected binding call as a sentence the panel can show. */
function describe(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the health backend is not reachable";
}
