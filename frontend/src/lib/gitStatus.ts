import type { FileStatus, Status } from "./git";
import {
  ADDED,
  COPIED,
  DELETED,
  MODIFIED,
  NOT_A_REPOSITORY,
  NO_GIT,
  RENAMED,
  UNTRACKED,
} from "./git";
import { parentPath } from "./tree";

/**
 * Turning a git status into what the workbench draws (DESIGN.md §5): a badge
 * per tree row, the changes panel's two groups, and the status bar's line.
 *
 * Everything here is pure — `useGitStatus` owns the fetching, this owns the
 * shape of what it fetched — the same split `lib/tree.ts` and `useFileTree`
 * already use for the file tree.
 */

/** The marker drawn on a file row. One character, because it sits in a tree
 * row next to a name that needs the space more. */
export type Badge = "M" | "A" | "D" | "R" | "C" | "U" | "?";

/** The marker drawn on a directory row. */
export type DirBadge = "•" | "U";

const FILE_BADGES: Readonly<Record<string, Badge>> = {
  [MODIFIED]: "M",
  [ADDED]: "A",
  [DELETED]: "D",
  [RENAMED]: "R",
  [COPIED]: "C",
  [UNTRACKED]: "?",
};

/** Every badge the tree knows about, keyed by root-relative path. */
export interface Badges {
  readonly files: ReadonlyMap<string, Badge>;
  readonly dirs: ReadonlyMap<string, DirBadge>;
}

/**
 * The badge for one file, from its own status.
 *
 * The worktree side wins over the index side when both are set. A file that
 * is staged and then edited again is shown as what it is on disk, because the
 * tree row shows the file on disk; the changes panel is where the same path
 * appears under both groups and the distinction is legible.
 */
export function fileBadge(file: FileStatus): Badge {
  if (file.conflicted) {
    return "U";
  }
  return FILE_BADGES[file.worktree] ?? FILE_BADGES[file.staged] ?? "M";
}

/**
 * Every badge for a status, with the directory rollup the issue asks for.
 *
 * A directory gets `•` rather than a letter borrowed from a descendant.
 * Nothing about the directory itself is modified or added, so a letter there
 * would be a claim about the wrong thing — and picking which descendant's
 * letter to show would mean inventing a severity ranking over git's states
 * that git does not have. The one distinction worth escalating is a conflict:
 * an unmerged file inside a collapsed directory is the case where "there is
 * something in here" is not enough to act on.
 *
 * A path can be in both maps at once — a submodule is a directory on disk and
 * a single entry to git — so lookups go through `badgeAt`, which prefers the
 * file badge git actually reported.
 */
export function badgesFor(status: Status): Badges {
  const files = new Map<string, Badge>();
  const dirs = new Map<string, DirBadge>();

  for (const file of status.files) {
    files.set(file.path, fileBadge(file));
    markAncestors(dirs, file.path, file.conflicted);
    // A rename's source is gone from where it used to be, so its old
    // directory has a change in it too — otherwise moving a file out of a
    // collapsed directory leaves that directory looking untouched.
    if (file.origPath !== "") {
      markAncestors(dirs, file.origPath, file.conflicted);
    }
  }

  return { files, dirs };
}

/** Marks every directory above path as containing a change, escalating to a
 * conflict marker when one is. */
function markAncestors(
  dirs: Map<string, DirBadge>,
  path: string,
  conflicted: boolean,
): void {
  let dir = parentPath(path);
  while (dir !== "") {
    if (conflicted || dirs.get(dir) !== "U") {
      dirs.set(dir, conflicted ? "U" : "•");
    }
    dir = parentPath(dir);
  }
}

/** The badge for one tree row, or null when it has none. */
export function badgeAt(badges: Badges, path: string, isDir: boolean): string | null {
  return badges.files.get(path) ?? (isDir ? badges.dirs.get(path) ?? null : null);
}

const BADGE_TITLES: Readonly<Record<string, string>> = {
  M: "modified",
  A: "added",
  D: "deleted",
  R: "renamed",
  C: "copied",
  U: "conflicted",
  "?": "untracked",
  "•": "contains changes",
};

/** What a badge means, in words. A single letter in a tree row is not
 * self-explanatory, and this is what a row's tooltip and its accessible name
 * are built from. */
export function badgeTitle(badge: string): string {
  return BADGE_TITLES[badge] ?? badge;
}

/** The changes panel's two groups (DESIGN.md §7). */
export interface ChangeGroups {
  readonly staged: readonly FileStatus[];
  readonly unstaged: readonly FileStatus[];
}

/**
 * Splits a status into staged and unstaged.
 *
 * A path can appear in both, and that is the point of showing two groups
 * rather than one list: staging a file and then editing it again is a state
 * git tracks and a single row could not express. Conflicts group with
 * unstaged — an unmerged path is work still to do, and it has no staged half
 * to show.
 */
export function groupChanges(status: Status): ChangeGroups {
  return {
    staged: status.files.filter((f) => !f.conflicted && f.staged !== ""),
    unstaged: status.files.filter((f) => f.conflicted || f.worktree !== ""),
  };
}

/** How many paths the status bar reports as changed. */
export function changedCount(status: Status): number {
  return status.files.length;
}

/**
 * The status bar's git line (DESIGN.md §5, `⎇ main ↑1 ↓0 · 3 changed`).
 *
 * Ahead/behind counts are omitted when the branch tracks nothing: git reports
 * no counts without an upstream, so printing `↑0 ↓0` there would be inventing
 * a comparison rather than reporting one.
 */
export function branchSummary(status: Status): string {
  if (status.availability === NO_GIT) {
    return "git was not found on your PATH";
  }
  if (status.availability === NOT_A_REPOSITORY) {
    return "not a git repository";
  }

  const parts = [`⎇ ${branchLabel(status)}`];
  if (status.branch.upstream !== "") {
    parts.push(`↑${String(status.branch.ahead)} ↓${String(status.branch.behind)}`);
  }
  return `${parts.join(" ")} · ${changesLabel(changedCount(status))}`;
}

/** What the branch is called, for a status bar that has to say something even
 * when HEAD does not name a branch. */
function branchLabel(status: Status): string {
  if (status.branch.detached) {
    return "detached HEAD";
  }
  if (status.branch.name === "") {
    return "no branch";
  }
  // A repository with no commits still names the branch its first commit will
  // create, and saying so is the difference between "nothing here yet" and
  // "something is wrong".
  return status.branch.unborn ? `${status.branch.name} (no commits yet)` : status.branch.name;
}

function changesLabel(count: number): string {
  if (count === 0) {
    return "no changes";
  }
  return count === 1 ? "1 changed" : `${String(count)} changed`;
}
