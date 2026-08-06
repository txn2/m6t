import type { FileStatus, Status } from "./git";
import { AVAILABLE, UNTRACKED } from "./git";

/**
 * The rules the git controls follow (DESIGN.md §7), as functions over a
 * status.
 *
 * Everything here is pure: `useGitOps` owns calling the backend, this owns
 * deciding what may be called. The split is the one `gitStatus.ts` already
 * uses, and it is what lets "a dirty worktree blocks a branch switch" be a
 * test over a value instead of a test that renders a dropdown.
 */

/** A commit message, as the two fields the editor shows. */
export interface CommitDraft {
  readonly subject: string;
  readonly body: string;
}

export const EMPTY_DRAFT: CommitDraft = { subject: "", body: "" };

/**
 * Joins a draft into the message git receives: subject, a blank line, body —
 * the convention every git tool reads a commit by.
 *
 * A draft with no body produces just the subject rather than a subject with
 * two trailing newlines, so `git log --format=%b` on it is empty instead of
 * whitespace.
 */
export function commitMessage(draft: CommitDraft): string {
  const subject = draft.subject.trim();
  const body = draft.body.trim();
  return body === "" ? subject : `${subject}\n\n${body}`;
}

/** Whether a draft has enough in it to be a commit message. The body alone is
 * not enough: a commit whose subject line is blank shows up as an empty row in
 * every log. */
export function hasMessage(draft: CommitDraft): boolean {
  return draft.subject.trim() !== "";
}

/**
 * The paths one row's action has to act on.
 *
 * A rename is one row and two paths, and sending only the one the row is named
 * after leaves the other half of the rename behind. Unstaging `new.yaml` alone
 * after a `git mv` leaves `old.yaml` **staged as a deletion** — a change the
 * user did not ask for, sitting in the index, that a later commit would carry
 * out. Staging has the mirror problem: the new name arrives without the old
 * one's removal.
 *
 * A copy's source is unchanged in the index, so including it is a no-op rather
 * than a special case worth branching on.
 */
export function pathsOf(file: FileStatus): string[] {
  return file.origPath === "" ? [file.path] : [file.path, file.origPath];
}

/** Every path a group's action has to act on, deduplicated: a rename's source
 * can also be another row's path. */
export function pathsOfAll(files: readonly FileStatus[]): string[] {
  return [...new Set(files.flatMap(pathsOf))];
}

/** The paths staged for commit. */
export function stagedPaths(status: Status): readonly string[] {
  return status.files.filter((f) => !f.conflicted && f.staged !== "").map((f) => f.path);
}

/** Every unmerged path. These get their own group and their own instruction:
 * v1 has no in-app merge tool, and resolution happens in the terminal. */
export function conflictedFiles(status: Status): readonly FileStatus[] {
  return status.files.filter((f) => f.conflicted);
}

/**
 * Why the commit button is disabled, or null when it is not.
 *
 * A reason rather than a boolean because a disabled control with no
 * explanation is the thing users file bugs about. The order is the order a
 * user hits them: a conflict outranks an empty index, because committing a
 * half-merged tree is the mistake worth naming first.
 */
export function commitBlockedReason(status: Status, draft: CommitDraft): string | null {
  if (conflictedFiles(status).length > 0) {
    return "Resolve the conflicted files before committing.";
  }
  if (stagedPaths(status).length === 0) {
    return "Stage something to commit.";
  }
  if (!hasMessage(draft)) {
    return "A commit needs a subject line.";
  }
  return null;
}

/**
 * Whether the worktree has changes a branch switch could disturb.
 *
 * Untracked files do not count. git carries them across a checkout untouched,
 * and treating them as dirt would block a switch for a build directory the
 * user never asked git about — which, in a repository being used to hold
 * manifests, is most of them.
 */
export function isDirty(status: Status): boolean {
  return status.files.some(
    (f) => f.conflicted || f.staged !== "" || (f.worktree !== "" && f.worktree !== UNTRACKED),
  );
}

/**
 * Why the branch switcher is disabled, or null when it is not.
 *
 * The dirty check is m6t's, made before git runs, so the message names what to
 * do about it. git would refuse a checkout that overwrote a change on its own,
 * but only for the files that collide — a switch that silently carried half
 * the user's edits onto another branch is the case this closes.
 */
export function checkoutBlockedReason(status: Status): string | null {
  if (status.availability !== AVAILABLE) {
    return null;
  }
  if (status.branch.unborn) {
    return "This repository has no commits yet.";
  }
  if (isDirty(status)) {
    return "Commit or stash your changes before switching branches.";
  }
  return null;
}

/** Whether the current branch has no upstream, which is what makes a push
 * need `--set-upstream` and a remote to point at. */
export function needsUpstream(status: Status): boolean {
  return (
    status.availability === AVAILABLE &&
    !status.branch.detached &&
    !status.branch.unborn &&
    status.branch.name !== "" &&
    status.branch.upstream === ""
  );
}

/**
 * Why pushing is impossible, or null when it is not.
 *
 * "Nothing to push" is deliberately absent. A branch that reports zero commits
 * ahead can still have something to publish — a tag, a force-update after a
 * rebase, a counter that is stale because the last fetch was minutes ago — and
 * a button disabled on a stale number is worse than one that runs and reports
 * "Everything up-to-date".
 */
export function pushBlockedReason(status: Status): string | null {
  if (status.availability !== AVAILABLE) {
    return null;
  }
  if (status.branch.unborn) {
    return "There are no commits to push yet.";
  }
  if (status.branch.detached) {
    return "HEAD is detached — check out a branch to push.";
  }
  // The status a project starts on is available-shaped and empty, so every
  // check above passes on it and Push would be live for the length of one
  // status read. A branch with no name is not a branch to push; it is a
  // repository nothing has been read for yet.
  if (status.branch.name === "") {
    return "Reading the repository…";
  }
  return null;
}

/** Why pulling is impossible, or null when it is not. */
export function pullBlockedReason(status: Status): string | null {
  if (status.availability !== AVAILABLE) {
    return null;
  }
  if (status.branch.detached) {
    return "HEAD is detached — check out a branch to pull.";
  }
  if (status.branch.upstream === "") {
    return "This branch tracks nothing to pull from.";
  }
  return null;
}

/**
 * The remote a first push should default to.
 *
 * "origin" when it exists, because that is what a clone creates and what a
 * user means by "push it"; otherwise whichever single remote is configured;
 * otherwise nothing, and the prompt says so rather than inventing a name that
 * would fail at the network.
 */
export function defaultRemote(remotes: readonly string[]): string {
  if (remotes.includes("origin")) {
    return "origin";
  }
  return remotes.length === 1 ? (remotes[0] ?? "") : "";
}
