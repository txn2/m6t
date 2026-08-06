import { useCallback, useEffect, useRef, useState } from "react";
import type { Git } from "./git";
import { wailsGit } from "./git";

/**
 * The mutating git loop (DESIGN.md §7), as one controller the git controls
 * share.
 *
 * `useGitStatus` reads; this writes. They are separate hooks because their
 * failure modes are: a read that fails leaves the last good badges on screen
 * and a sentence in the status bar, while a write that fails has to stop the
 * user and show git's own words. Folding them together would mean one `error`
 * for two things a user has to respond to differently.
 *
 * Every operation refreshes the status when it finishes — including when it
 * fails. A failed pull is the case that makes this necessary rather than
 * cosmetic: it exits non-zero *and* leaves conflicted files behind, so the
 * panel that has to show them is only correct if a failure refreshes too.
 *
 * The three operations that write the index — stage, unstage, commit — are
 * not here (#39). They belong to the agent in the terminal, which runs the
 * user's own git; two writers of one index, only one of which the agent can
 * see, is a disagreement waiting to happen.
 */
export interface GitOpsController {
  /** An operation is in flight. Every control disables on it: git serializes
   * on the index anyway, and a second click would buy a lock error rather
   * than a second operation. */
  readonly busy: boolean;
  /** The last operation's failure, verbatim from git, or null. */
  readonly error: string | null;
  /** Local branches, for the switcher. Empty until the first read lands. */
  readonly branches: readonly string[];
  /** Configured remotes, for the first-push prompt. */
  readonly remotes: readonly string[];
  readonly dismissError: () => void;
  readonly pull: () => void;
  readonly push: (remote: string, setUpstream: boolean) => void;
  readonly checkout: (branch: string) => void;
}

export function useGitOps(
  root: string | null,
  /** Called after every operation, successful or not, to re-read the status
   * the operation may have changed. */
  onChanged: () => void,
  git: Git = wailsGit,
): GitOpsController {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [branches, setBranches] = useState<readonly string[]>([]);
  const [remotes, setRemotes] = useState<readonly string[]>([]);

  // The seam and the change callback behind refs, so the operations below
  // never change identity. `useGitStatus` documents why this matters: a
  // caller passing an inline object — the ordinary way to write a test —
  // would otherwise rebuild every callback each render and re-run any effect
  // depending on one.
  const seam = useRef(git);
  const changed = useRef(onChanged);
  useEffect(() => {
    seam.current = git;
    changed.current = onChanged;
  }, [git, onChanged]);

  // The project a result belongs to, for the same reason useGitStatus keeps
  // one: an operation started before a project switch resolves after it.
  const target = useRef(root);

  const listRefs = useCallback(() => {
    const reading = target.current;
    if (reading === null) {
      return;
    }
    void (async () => {
      const [nextBranches, nextRemotes] = await Promise.all([
        readList(() => seam.current.branches(reading)),
        readList(() => seam.current.remotes(reading)),
      ]);
      if (target.current === reading) {
        setBranches(nextBranches);
        setRemotes(nextRemotes);
      }
    })();
  }, []);

  useEffect(() => {
    target.current = root;
    setError(null);
    setBranches([]);
    setRemotes([]);
    listRefs();
  }, [root, listRefs]);

  /**
   * Runs one operation, leaving its outcome in `error`.
   *
   * Nothing is returned. The three operations left all report the same way —
   * git's own message in `error`, the new state through the status re-read
   * below — so a success flag would be a second channel for what `error`
   * already says, and no caller has anything to do with it.
   *
   * The busy flag is not a lock. Two operations cannot overlap through the UI
   * because everything disables on it, and if they somehow did, git's own
   * index.lock is what actually arbitrates — a flag in this process could
   * never do that anyway, since the user's terminal writes to the same
   * repository.
   */
  const run = useCallback(
    async (operation: (root: string) => Promise<void>): Promise<void> => {
      const reading = target.current;
      if (reading === null) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        await operation(reading);
      } catch (failure: unknown) {
        // Dropped when the project changed underneath: the message would name
        // a repository that is no longer on screen.
        if (target.current === reading) {
          setError(describeError(failure));
        }
      } finally {
        // Unconditional, unlike the error above. `busy` belongs to the
        // controller, not to the project: gating it on the project still
        // being the one the operation started in would leave every control
        // in the app disabled forever after a project switch during a slow
        // push. The two refreshes read `target.current` themselves, so they
        // are already asking about whichever project is on screen now — and
        // both run after a failure too, because a failed pull leaves
        // conflicts behind and a failed checkout may still have moved refs.
        setBusy(false);
        changed.current();
        listRefs();
      }
    },
    [listRefs],
  );

  const pull = useCallback(() => {
    void run((at) => seam.current.pull(at));
  }, [run]);

  const push = useCallback(
    (remote: string, setUpstream: boolean) => {
      void run((at) => seam.current.push(at, remote, setUpstream));
    },
    [run],
  );

  const checkout = useCallback(
    (branch: string) => {
      void run((at) => seam.current.checkout(at, branch));
    },
    [run],
  );

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  return {
    busy,
    error,
    branches,
    remotes,
    dismissError,
    pull,
    push,
    checkout,
  };
}

/**
 * Reads one list, answering with an empty one on failure.
 *
 * These two calls decorate controls; they are not the operation. A repository
 * with no git installed, or one whose `git remote` failed, should leave the
 * dropdown empty and the panel usable — not put an error over the changes list
 * that the user cannot act on and did not ask for.
 */
async function readList(read: () => Promise<string[]>): Promise<readonly string[]> {
  try {
    return await read();
  } catch {
    return [];
  }
}

/** Renders a rejected binding call as the sentence the panel shows. git's own
 * stderr is already inside it — the backend put it there and nothing on this
 * side edits it (DESIGN.md §7). */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "the git backend is not reachable";
}
