import { useCallback, useEffect, useRef, useState } from "react";
import type { SocketFactory } from "./events";
import { openEventsSocket } from "./events";
import type { Git, Status } from "./git";
import { emptyStatus, wailsGit } from "./git";
import type { Endpoint } from "./stream";

/** The reading half of the git seam — the only call this hook makes. */
type GitReader = Pick<Git, "status">;

/**
 * One project's git status, kept current (DESIGN.md §7).
 *
 * Scoped to the active project, the same way `useFileTree` is: only one
 * project's badges are ever on screen, so a project switch is a clean reset
 * rather than a filter over shared state.
 */
export interface GitStatusController {
  readonly status: Status;
  /** A failure that is a real failure — git ran and something went wrong.
   * The two degraded states (no git, not a repository) are not errors and
   * arrive on `status` instead. */
  readonly error: string | null;
  /**
   * Asks for the status again now.
   *
   * The `/events` notification would arrive on its own after any write, so
   * this is not what makes the UI correct — it is what makes it prompt. A
   * user who clicks "stage" watches the row move; waiting out the watcher's
   * coalescing window first reads as the click not having registered.
   *
   * It carries the same one-in-flight, one-queued discipline as an event-
   * driven read, so calling it alongside one costs no extra subprocess.
   */
  readonly refresh: () => void;
}

export function useGitStatus(
  root: string | null,
  endpoint: Endpoint | null,
  // Narrowed to the one call this hook makes. The full seam also carries the
  // mutations, and taking it here would say this hook could write — which is
  // the distinction `useGitOps` exists to keep.
  git: GitReader = wailsGit,
  /** Injectable for tests; defaults to opening a real WebSocket. */
  socketFactory?: SocketFactory,
): GitStatusController {
  const [status, setStatus] = useState<Status>(emptyStatus);
  const [error, setError] = useState<string | null>(null);

  // The project a result would belong to. It is a ref, not the `root` prop,
  // because a read that started before a project switch resolves after it,
  // and the check that discards it has to see the root as it is *now*.
  const target = useRef(root);

  // A status read is one subprocess, and the events that trigger it arrive in
  // coalesced batches from a watcher that does not wait for anyone. Without
  // these two, a branch switch would stack one `git status` per batch, each
  // slower than the last as they compete for the same repository. Instead:
  // one read in flight, and one re-read queued behind it — a trailing edge,
  // so the answer that lands is for the latest state of the tree and not for
  // whichever of five racing reads happened to finish last.
  const inFlight = useRef(false);
  const stale = useRef(false);

  // The seam, behind a ref so `read` never changes identity.
  //
  // This is not a micro-optimization. If `read` depended on `git`, a caller
  // passing an inline object — the ordinary way to write a test, and an easy
  // slip in a component — would rebuild it every render, re-run the effect
  // below, reset the status to a fresh object, and re-render: a loop that
  // ends in an out-of-memory crash rather than a visible bug. A hook whose
  // correctness depends on its caller memoizing an argument is a hook that
  // will eventually be called wrong.
  const seam = useRef(git);
  useEffect(() => {
    seam.current = git;
  }, [git]);

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
          const reading = target.current;
          if (reading === null) {
            break;
          }
          const result = await readStatus(seam.current, reading);
          // Dropped when the project changed while this was in flight: the
          // loop goes round again for the new one, because the switch queued
          // a re-read.
          if (target.current === reading) {
            apply(result, setStatus, setError);
          }
        } while (stale.current);
      } finally {
        inFlight.current = false;
      }
    })();
  }, []);

  // A new project's badges must not be the previous project's while its first
  // read is in flight, so the visible status resets before anything is asked
  // for.
  useEffect(() => {
    target.current = root;
    setStatus(emptyStatus());
    setError(null);
    if (root !== null) {
      read();
    }
  }, [root, read]);

  // /events: the backend says a project's status may be stale and this asks
  // again (PROTOCOL.md §5). The message carries no status of its own.
  useEffect(() => {
    if (root === null || endpoint === null) {
      return;
    }
    const socket = openEventsSocket(
      endpoint,
      {
        onGit: (changedRoot) => {
          if (changedRoot === root) {
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

  return { status, error, refresh: read };
}

/** One read's outcome: exactly one of the two is set. */
interface ReadResult {
  readonly status: Status | null;
  readonly error: string | null;
}

/** Reads one status, turning a rejection into a message rather than a throw
 * — including the synchronous throw the generated binding produces when there
 * is no Wails runtime behind it. */
async function readStatus(git: GitReader, root: string): Promise<ReadResult> {
  try {
    return { status: await git.status(root), error: null };
  } catch (failure: unknown) {
    return { status: null, error: describeError(failure) };
  }
}

/** Publishes a read's outcome. A success clears a previous failure; a failure
 * leaves the last good status on screen, because stale badges are more useful
 * than none while the reason is shown in the status bar. */
function apply(
  result: ReadResult,
  setStatus: (status: Status) => void,
  setError: (error: string | null) => void,
): void {
  if (result.status !== null) {
    setStatus(result.status);
    setError(null);
    return;
  }
  setError(result.error);
}

/** Renders a rejected binding call as a sentence the status bar can show. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the git backend is not reachable";
}
