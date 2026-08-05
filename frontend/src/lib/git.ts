import { GitStatus } from "../../wailsjs/go/app/App";

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
 * There is one operation, and it is a read. The backend never pushes a status
 * — the `/events` channel only says a project's status may be stale
 * (PROTOCOL.md §5) — so "ask again" is the whole protocol from this side.
 */
export interface Git {
  status: (root: string) => Promise<Status>;
}

/** The git seam backed by the generated Wails bindings. */
export const wailsGit: Git = {
  status: (root) => GitStatus(root),
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
