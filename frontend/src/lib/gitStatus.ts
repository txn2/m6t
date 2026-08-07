import type { FileStatus, Status } from "./git";
import {
  ADDED,
  AVAILABLE,
  COPIED,
  DELETED,
  MODIFIED,
  NOT_A_REPOSITORY,
  NO_GIT,
  RENAMED,
  UNTRACKED,
} from "./git";
import { conflictedFiles } from "./gitOps";
import type { TreeEntry, TreeRow } from "./tree";
import { ROOT, baseName, parentPath } from "./tree";

/**
 * Turning a git status into what the workbench draws (DESIGN.md §5): the
 * marker and the tint on every tree row, the rows the changed-only mode
 * renders, and the status bar's line.
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
    files.set(pathOf(file), fileBadge(file));
    markAncestors(dirs, pathOf(file), file.conflicted);
    // A rename's source is gone from where it used to be, so its old
    // directory has a change in it too — otherwise moving a file out of a
    // collapsed directory leaves that directory looking untouched.
    if (file.origPath !== "") {
      markAncestors(dirs, file.origPath, file.conflicted);
    }
  }

  return { files, dirs };
}

/**
 * The path a status record names, as the tree spells it.
 *
 * `git status` collapses a directory whose every file is untracked into one
 * record for the directory, with a trailing slash: `? build/`, not one record
 * per file inside it. The slash is git saying "the whole directory", not part
 * of the name — and the tree's row for that directory is `build`, so a badge
 * filed under `build/` would be a badge on nothing.
 */
function pathOf(file: FileStatus): string {
  return file.path.endsWith("/") ? file.path.slice(0, -1) : file.path;
}

/** Whether a status record is one of those whole-directory entries. */
function isDirEntry(file: FileStatus): boolean {
  return file.path.endsWith("/");
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

/**
 * The colour a row's name is drawn in (#40).
 *
 * Colour is the primary signal in the tree the way it is in JetBrains' —
 * green for what git has never seen, blue for what has moved away from HEAD,
 * red for what stops a merge — and the letter badge stays beside it as the
 * signal that survives a colour-blind palette and a screen reader. A tone is
 * a name rather than a colour: `style.css` owns which token each one draws
 * in, in both themes.
 */
export type Tone = "added" | "modified" | "deleted" | "conflicted" | "contains";

/**
 * Which tone each badge takes.
 *
 * Untracked shares the added tone deliberately: to a user reading the tree,
 * `?` and `A` are the same fact — this file is new — and the difference
 * between them is whether someone has run `git add`, which the badge already
 * says. Renames and copies share the modified tone for the same reason: the
 * path has changed relative to HEAD.
 */
const BADGE_TONES: Readonly<Record<string, Tone>> = {
  A: "added",
  "?": "added",
  M: "modified",
  R: "modified",
  C: "modified",
  D: "deleted",
  U: "conflicted",
  "•": "contains",
};

/** The tone a badge draws in, or null when there is no badge to draw. */
export function badgeTone(badge: string | null): Tone | null {
  return badge === null ? null : BADGE_TONES[badge] ?? null;
}

/**
 * The rows the changed-only mode renders (#40): every path git reports, under
 * the ancestor directories that hold them.
 *
 * Built from the status rather than filtered out of the loaded tree, which is
 * what makes the mode answer the question it is for. A deleted file is not on
 * disk and so is in no directory listing; a change three directories deep is
 * invisible until each of those directories has been expanded and fetched.
 * Both appear here the moment git reports them, with every ancestor already
 * in place — there is nothing to expand, so nothing to auto-expand.
 *
 * Dotfiles are not filtered. The tree's hidden toggle answers "what is in
 * here", and hiding a changed `.github/workflows/ci.yml` from the mode built
 * to list changes would be answering a different question than the one asked.
 *
 * A rename contributes its destination only. Its source is gone, and a second
 * struck-through row for the same file would read as two changes where git
 * reported one — the `R` badge and its tooltip are where the move is said.
 *
 * A wholly untracked directory is one row for the directory, because that is
 * how git reports it (see `pathOf`) — expanding it in the full tree is how to
 * see what is inside.
 */
export function changedRows(status: Status): TreeRow[] {
  const children = new Map<string, TreeEntry[]>();
  const placed = new Set<string>();
  // Ancestors first, all of them, so that a path git reports which is also
  // some other path's parent — a submodule — is one directory row carrying
  // git's own badge, rather than a file row with orphaned descendants.
  for (const file of status.files) {
    for (const dir of ancestorsOf(pathOf(file))) {
      place(children, placed, { name: baseName(dir), isDir: true, path: dir });
    }
  }
  for (const file of status.files) {
    const path = pathOf(file);
    place(children, placed, { name: baseName(path), isDir: isDirEntry(file), path });
  }
  return flatten(children, ROOT, 0);
}

/** Every directory above a path, innermost first. */
function ancestorsOf(path: string): string[] {
  const dirs: string[] = [];
  for (let dir = parentPath(path); dir !== ROOT; dir = parentPath(dir)) {
    dirs.push(dir);
  }
  return dirs;
}

/** Files an entry under its parent, unless that path is already filed. */
function place(
  children: Map<string, TreeEntry[]>,
  placed: Set<string>,
  entry: TreeEntry,
): void {
  if (placed.has(entry.path)) {
    return;
  }
  placed.add(entry.path);
  const siblings = children.get(parentPath(entry.path));
  if (siblings === undefined) {
    children.set(parentPath(entry.path), [entry]);
  } else {
    siblings.push(entry);
  }
}

/** One directory's entries and everything under them, depth-first. */
function flatten(children: Map<string, TreeEntry[]>, dir: string, depth: number): TreeRow[] {
  const rows: TreeRow[] = [];
  for (const entry of [...(children.get(dir) ?? [])].sort(byTreeOrder)) {
    rows.push({ ...entry, depth });
    if (entry.isDir) {
      rows.push(...flatten(children, entry.path, depth + 1));
    }
  }
  return rows;
}

/** Directories before files, then case-insensitively by name — the order
 * `internal/watch.sortEntries` lists a real directory in, so switching modes
 * does not reshuffle the paths that appear in both. */
function byTreeOrder(a: TreeEntry, b: TreeEntry): number {
  if (a.isDir !== b.isDir) {
    return a.isDir ? -1 : 1;
  }
  const [x, y] = [a.name.toLowerCase(), b.name.toLowerCase()];
  if (x < y) {
    return -1;
  }
  return x > y ? 1 : 0;
}

/**
 * Whether git is tracking a path, which is what decides that the blame toggle
 * exists for it (#52).
 *
 * It needs no call of its own. porcelain v2 emits a record for a path that
 * differs and nothing for one that does not, so a path git did not mention is
 * a tracked, unmodified path — and the only records that mean "not tracked"
 * are the untracked ones. The two unavailable states are false for the reason
 * they exist: with no git, or outside a repository, there is nothing to ask.
 */
export function isTracked(status: Status, path: string): boolean {
  if (status.availability !== AVAILABLE) {
    return false;
  }
  const entry = status.files.find((file) => file.path === path);
  return entry === undefined || entry.worktree !== UNTRACKED;
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
 *
 * Conflicts get the tail of the line and the instruction that goes with them
 * (#40). v1 ships no merge tool (DESIGN.md §7) and the terminal below is a
 * real shell in this repository, so the honest thing to show is where to go.
 * It is here rather than beside the conflicted rows because a conflict stops
 * a pull and a branch switch whether or not the tree is showing that file —
 * and this line is on screen either way.
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

  const line = `${parts.join(" ")} · ${changesLabel(changedCount(status))}`;
  const conflicts = conflictedFiles(status).length;
  if (conflicts === 0) {
    return line;
  }
  return `${line} · ${String(conflicts)} conflicted — resolve in the terminal`;
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
