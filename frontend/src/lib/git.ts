import {
  GitBranches,
  GitCheckout,
  GitCommit,
  GitPull,
  GitPush,
  GitRemotes,
  GitStage,
  GitStatus,
  GitUnstage,
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
 */
export interface Git {
  status: (root: string) => Promise<Status>;
  stage: (root: string, paths: string[]) => Promise<void>;
  unstage: (root: string, paths: string[]) => Promise<void>;
  commit: (root: string, message: string) => Promise<void>;
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
  stage: (root, paths) => GitStage(root, paths),
  unstage: (root, paths) => GitUnstage(root, paths),
  commit: (root, message) => GitCommit(root, message),
  pull: (root) => GitPull(root),
  push: (root, remote, setUpstream) => GitPush(root, remote, setUpstream),
  checkout: (root, branch) => GitCheckout(root, branch),
  branches: (root) => GitBranches(root),
  remotes: (root) => GitRemotes(root),
};

/** A status for a project nothing has been read for yet: available-shaped and
 * empty, so every consumer renders it without a null check. */
export function emptyStatus(): Status {
  return {
    availability: AVAILABLE,
    branch: { name: "", upstream: "", ahead: 0, behind: 0, detached: false, unborn: false },
    files: [],
  };
}
