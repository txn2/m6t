import {
  GitBlame,
  GitBranches,
  GitCheckout,
  GitPull,
  GitPush,
  GitRemotes,
  GitStatus,
} from "../../wailsjs/go/app/App";

/**
 * The frontend's view of `internal/git`'s status types.
 *
 * These are declared here rather than aliased from `wailsjs/go/models` — the
 * convention `tree.ts`'s `Entry` and `files.ts`'s `FileContent` follow —
 * because the generated `git.Status` is a class with a method on it, so no
 * object literal is assignable to it. That would push every test fixture and
 * every empty value through the generator's untyped `createFrom`, which takes
 * `any` and would let a wrong shape through silently.
 *
 * The check the alias would have given is kept instead by `wailsGit` below:
 * assigning the generated binding to `Git` fails to compile if the Go structs
 * stop matching these declarations.
 */
export interface Branch {
  readonly name: string;
  readonly upstream: string;
  readonly ahead: number;
  readonly behind: number;
  readonly detached: boolean;
  readonly unborn: boolean;
}

export interface FileStatus {
  readonly path: string;
  /** How the index differs from HEAD; `""` when it does not. */
  readonly staged: string;
  /** How the working tree differs from the index; `""` when it does not. */
  readonly worktree: string;
  readonly conflicted: boolean;
  /** Where a renamed or copied path came from; `""` otherwise. */
  readonly origPath: string;
}

export interface Status {
  readonly availability: string;
  readonly branch: Branch;
  readonly files: readonly FileStatus[];
}

/** One commit a file's lines are attributed to (#52), matching
 * `internal/git.BlameCommit`. */
export interface BlameCommit {
  readonly sha: string;
  readonly author: string;
  /** When the author wrote it, in Unix seconds; 0 when git reported no
   * readable time. */
  readonly authorTime: number;
  /** The commit's subject line. */
  readonly summary: string;
  /** git's all-zero SHA: work in the working tree and in no commit. Such a
   * commit has no author or date worth showing. */
  readonly uncommitted: boolean;
}

/**
 * One file's per-line attribution, in the shape git's porcelain format states
 * it: each commit once, and a line-by-line reference into them.
 *
 * `lines` holds one index into `commits` per line of the file, line 1 first.
 * An index outside `commits` means the blame did not cover that line — see
 * `commitAt` in `blame.ts`, which is the only thing that should read this.
 */
export interface Blame {
  readonly commits: readonly BlameCommit[];
  readonly lines: readonly number[];
}

/**
 * Why a project has no readable git state, matching
 * `internal/git.Availability`.
 *
 * These are constants rather than a union type because Wails erases Go's
 * named string types to `string` in the generated models: a union here would
 * make the binding unassignable to `Git` and cost the compile-time check that
 * is the whole reason the interfaces above are hand-written.
 */
export const AVAILABLE = "ok";
export const NO_GIT = "no-git";
export const NOT_A_REPOSITORY = "not-a-repository";

/** Per-path change kinds, matching `internal/git.State`. */
export const MODIFIED = "modified";
export const ADDED = "added";
export const DELETED = "deleted";
export const RENAMED = "renamed";
export const COPIED = "copied";
export const UNTRACKED = "untracked";

/**
 * The git service's Wails-binding seam (DESIGN.md §7), the same shape
 * `lib/directory.ts`'s `Directory` already takes: an interface a component or
 * hook can be tested against without a Wails runtime.
 *
 * Only `status` and the two list calls answer with anything. The mutations
 * resolve with nothing on success and reject with git's own message on
 * failure, because the backend does not return a status from an operation:
 * the write changes `.git`, the watcher publishes a `git` event for it
 * (PROTOCOL.md §5), and the status is read back through `status`. One source
 * for what the repository looks like, not two that can disagree.
 *
 * Staging and committing are absent, and the absence is the decision (#39):
 * what records work in m6t is the agent in the terminal below, running the
 * user's own git in the user's own worktree. A seam method for it would be a
 * second writer of the index that the agent cannot see.
 */
export interface Git {
  status: (root: string) => Promise<Status>;
  /** One file's per-line attribution (#52). `path` is root-relative and
   * slash-separated; a path git will not blame rejects with git's own words
   * rather than resolving to an empty blame. */
  blame: (root: string, path: string) => Promise<Blame>;
  pull: (root: string) => Promise<void>;
  /** `remote` takes effect only when `setUpstream` is true; otherwise the
   * repository's own push configuration decides where the branch goes. */
  push: (root: string, remote: string, setUpstream: boolean) => Promise<void>;
  checkout: (root: string, branch: string) => Promise<void>;
  branches: (root: string) => Promise<string[]>;
  remotes: (root: string) => Promise<string[]>;
}

/** The git seam backed by the generated Wails bindings. */
export const wailsGit: Git = {
  status: (root) => GitStatus(root),
  blame: (root, path) => GitBlame(root, path),
  pull: (root) => GitPull(root),
  push: (root, remote, setUpstream) => GitPush(root, remote, setUpstream),
  checkout: (root, branch) => GitCheckout(root, branch),
  branches: (root) => GitBranches(root),
  remotes: (root) => GitRemotes(root),
};

/** A blame with nothing in it — a file of no lines. Every consumer already
 * handles a line the blame does not cover, so this needs no special case. */
export function emptyBlame(): Blame {
  return { commits: [], lines: [] };
}

/** A status for a project nothing has been read for yet: available-shaped and
 * empty, so every consumer renders it without a null check. */
export function emptyStatus(): Status {
  return {
    availability: AVAILABLE,
    branch: { name: "", upstream: "", ahead: 0, behind: 0, detached: false, unborn: false },
    files: [],
  };
}
