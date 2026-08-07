import { useCallback, useEffect, useRef, useState } from "react";
import type { SocketFactory } from "./events";
import { openEventsSocket } from "./events";
import type { Git, Status } from "./git";
import { emptyStatus, wailsGit } from "./git";
import type { Endpoint } from "./stream";

/** The reading half of the git seam — the only call this hook makes. */
type GitReader = Pick<Git, "status">;

/**
 * The status a project has before anything has been read for it. One shared
 * value rather than a fresh object per render: `FileTree` recomputes every
 * row's badge when this changes identity, and a project with no reading yet
 * has nothing to recompute.
 */
const noStatus: Status = emptyStatus();

/**
 * Every project's git status, kept current (DESIGN.md §7).
 *
 * One status per project, keyed by root, the same shape `useFileTree` holds
 * its trees in and for the same reason (#59): only one project's badges are on
 * screen, but throwing the other projects' away meant the badges blanked and
 * came back on every switch. What is retained is shown immediately on return,
 * and a fresh read is already in flight behind it.
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
  /** Drops a project's retained status, named by its root path — the same
   * key, and the same reason, as `FileTreeController.closeProject`. */
  readonly closeProject: (root: string) => void;
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
  const [statuses, setStatuses] = useState<Readonly<Record<string, Status>>>({});
  // Not per project, unlike the statuses. A failure is a sentence about the
  // read that just happened, and showing the last project's on arrival at this
  // one would be attributing one repository's problem to another.
  const [error, setError] = useState<string | null>(null);

  const status = (root === null ? undefined : statuses[root]) ?? noStatus;

  // The project a result would belong to. It is a ref, not the `root` prop,
  // because a read that started before a project switch resolves after it,
  // and the check that discards it has to see the root as it is *now*.
  const target = useRef(root);

  // The projects this hook is still holding a status for: every one that has
  // been on screen, less the ones removed from the registry since.
  //
  // A read is a subprocess, and a project removed while one was running would
  // otherwise have its entry written back a moment after `closeProject` dropped
  // it — an entry for a project the registry no longer has, for the life of the
  // app. `useFileTree` keeps the same set for the same reason.
  const held = useRef(new Set<string>());

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
          if (held.current.has(reading)) {
            apply(reading, result, setStatuses, setError, target.current === reading);
          }
        } while (stale.current);
      } finally {
        inFlight.current = false;
      }
    })();
  }, []);

  // A project's own last-known badges are what it comes back to, so nothing is
  // cleared here but the error — the read started below is what replaces them.
  // A project being seen for the first time has no entry, and `noStatus` is
  // what it shows until that read lands.
  useEffect(() => {
    target.current = root;
    setError(null);
    if (root !== null) {
      held.current.add(root);
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

  const closeProject = useCallback((closing: string) => {
    held.current.delete(closing);
    setStatuses((current) => {
      if (!(closing in current)) {
        return current;
      }
      const { [closing]: _dropped, ...rest } = current;
      return rest;
    });
  }, []);

  return { status, error, refresh: read, closeProject };
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

/**
 * Publishes a read's outcome against the project it was read for.
 *
 * A success clears a previous failure; a failure leaves that project's last
 * good status alone, because stale badges are more useful than none while the
 * reason is shown in the status bar.
 *
 * A status is recorded whether or not the project is still the one on screen —
 * it describes the repository it was read from, and that repository's entry is
 * where it belongs. `showing` gates only the error, which is a sentence in the
 * status bar about the project the user is looking at.
 */
function apply(
  root: string,
  result: ReadResult,
  setStatuses: (update: (current: Readonly<Record<string, Status>>) => Record<string, Status>) => void,
  setError: (error: string | null) => void,
  showing: boolean,
): void {
  if (result.status !== null) {
    const read = result.status;
    setStatuses((current) => ({ ...current, [root]: read }));
  }
  if (!showing) {
    return;
  }
  setError(result.status !== null ? null : result.error);
}

/** Renders a rejected binding call as a sentence the status bar can show. */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the git backend is not reachable";
}
